'use client'

// SQL migrations required before this page will return full data:
// ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at timestamptz;
// ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cost numeric DEFAULT 0;
// ALTER TABLE skus ADD COLUMN IF NOT EXISTS bolt_kit_cost numeric DEFAULT 0;
// ALTER TABLE skus ADD COLUMN IF NOT EXISTS packaging_cost numeric DEFAULT 0;
// ALTER TABLE skus ADD COLUMN IF NOT EXISTS labor_cost_per_unit numeric DEFAULT 0;

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ──────────────────────────────────────────────────────────────────────

type OrderLine = {
  id: string
  order_id: string
  sku_id: string | null
  ss_sku: string
  description: string | null
  qty: number
  unit_price: number | null
}

type Order = {
  id: string
  order_number: string
  channel: string
  customer_name: string | null
  order_date: string | null
  shipped_at: string | null
  shipping_cost: number | null
  status: string
  notes: string | null
  order_lines: OrderLine[]
}

type SKU = {
  id: string
  description: string
  bolt_kit_cost: number | null
  packaging_cost: number | null
  labor_cost_per_unit: number | null
}

type BuildBatchLine = {
  batch_id: string
  sku_id: string
  qty: number
  mat_cost_snapshot: number | null
}

type BuildBatch = {
  id: string
  name: string
  status: string
  completed_at: string | null
  powder_batch_id: string | null
}

type PowderBatch = {
  id: string
  batch_name: string
  total_cost: number
  status: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtMonthYear(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

function fmtMonthKey(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function fmtMonthLabel(key: string) {
  const [y, m] = key.split('-')
  const d = new Date(Number(y), Number(m) - 1, 1)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

function fmtCurrency(n: number | null) {
  if (n == null) return '—'
  return '$' + n.toFixed(2)
}

function fmtPct(n: number | null) {
  if (n == null) return '—'
  return n.toFixed(1) + '%'
}

// ── Per-order cost calculation ─────────────────────────────────────────────────

type CostBreakdown = {
  revenue: number | null
  shipping: number | null
  matCost: number | null       // may be partial
  boltKit: number | null
  packaging: number | null
  labor: number | null
  totalCOGS: number | null
  grossMargin: number | null
  marginPct: number | null
  matEstimated: boolean
}

type LineCost = {
  line: OrderLine
  sku: SKU | null
  revenue: number | null
  matCost: number | null
  matEstimated: boolean
  powderRunName: string | null
  boltKit: number | null
  packaging: number | null
  labor: number | null
  lineCOGS: number | null
  lineMargin: number | null
}

function calcLineCosts(
  line: OrderLine,
  skuMap: Map<string, SKU>,
  batchLines: BuildBatchLine[],
  batches: BuildBatch[],
  powderMap: Map<string, PowderBatch>,
): LineCost {
  const sku = line.sku_id ? (skuMap.get(line.sku_id) ?? null) : null
  const revenue = line.unit_price != null ? line.unit_price * line.qty : null

  // Mat cost: find the latest completed batch line for this sku
  let matCost: number | null = null
  let matEstimated = false
  let powderRunName: string | null = null

  if (line.sku_id) {
    // Filter batch lines for this sku_id that have a snapshot
    const relevantBatchLines = batchLines.filter(
      (bl) => bl.sku_id === line.sku_id && bl.mat_cost_snapshot != null
    )

    // Get completed batches sorted by completed_at descending
    const completedBatches = batches
      .filter((b) => b.status === 'complete' && b.completed_at != null)
      .sort((a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime())

    // Find most recent completed batch that has a batch line for this sku
    for (const batch of completedBatches) {
      const bl = relevantBatchLines.find((l) => l.batch_id === batch.id)
      if (bl && bl.mat_cost_snapshot != null && bl.qty > 0) {
        const costPerUnit = bl.mat_cost_snapshot / bl.qty
        matCost = costPerUnit * line.qty
        matEstimated = true // snapshot-based, considered an estimate

        if (batch.powder_batch_id) {
          const pb = powderMap.get(batch.powder_batch_id)
          if (pb) powderRunName = pb.batch_name
        }
        break
      }
    }
  }

  const boltKit = sku?.bolt_kit_cost != null ? sku.bolt_kit_cost * line.qty : null
  const packaging = sku?.packaging_cost != null ? sku.packaging_cost * line.qty : null
  const labor = sku?.labor_cost_per_unit != null ? sku.labor_cost_per_unit * line.qty : null

  // Line COGS excludes shipping (shipping is at order level)
  const hasCOGS = matCost != null || boltKit != null || packaging != null || labor != null
  const lineCOGS = hasCOGS
    ? (matCost ?? 0) + (boltKit ?? 0) + (packaging ?? 0) + (labor ?? 0)
    : null

  const lineMargin = revenue != null && lineCOGS != null ? revenue - lineCOGS : null

  return { line, sku, revenue, matCost, matEstimated, powderRunName, boltKit, packaging, labor, lineCOGS, lineMargin }
}

function calcOrderCosts(
  order: Order,
  skuMap: Map<string, SKU>,
  batchLines: BuildBatchLine[],
  batches: BuildBatch[],
  powderMap: Map<string, PowderBatch>,
): CostBreakdown {
  const lineCosts = order.order_lines.map((l) =>
    calcLineCosts(l, skuMap, batchLines, batches, powderMap)
  )

  const revenue = lineCosts.some((lc) => lc.revenue != null)
    ? lineCosts.reduce((s, lc) => s + (lc.revenue ?? 0), 0)
    : null

  const shipping = order.shipping_cost

  const matCost = lineCosts.some((lc) => lc.matCost != null)
    ? lineCosts.reduce((s, lc) => s + (lc.matCost ?? 0), 0)
    : null

  const matEstimated = lineCosts.some((lc) => lc.matEstimated)

  const boltKit = lineCosts.some((lc) => lc.boltKit != null)
    ? lineCosts.reduce((s, lc) => s + (lc.boltKit ?? 0), 0)
    : null

  const packaging = lineCosts.some((lc) => lc.packaging != null)
    ? lineCosts.reduce((s, lc) => s + (lc.packaging ?? 0), 0)
    : null

  const labor = lineCosts.some((lc) => lc.labor != null)
    ? lineCosts.reduce((s, lc) => s + (lc.labor ?? 0), 0)
    : null

  const hasCOGS =
    matCost != null || shipping != null || boltKit != null || packaging != null || labor != null

  const totalCOGS = hasCOGS
    ? (matCost ?? 0) + (shipping ?? 0) + (boltKit ?? 0) + (packaging ?? 0) + (labor ?? 0)
    : null

  const grossMargin = revenue != null && totalCOGS != null ? revenue - totalCOGS : null
  const marginPct = grossMargin != null && revenue != null && revenue !== 0
    ? (grossMargin / revenue) * 100
    : null

  return { revenue, shipping, matCost, matEstimated, boltKit, packaging, labor, totalCOGS, grossMargin, marginPct }
}

// ── SKU performance aggregation ────────────────────────────────────────────────

type SkuPerf = {
  skuId: string
  description: string
  unitsSold: number
  revenue: number | null
  matCostTotal: number | null
  boltKitTotal: number | null
  packagingTotal: number | null
  laborTotal: number | null
  estCOGSTotal: number | null
  estMarginTotal: number | null
}

function aggregateSkuPerformance(
  orders: Order[],
  skuMap: Map<string, SKU>,
  batchLines: BuildBatchLine[],
  batches: BuildBatch[],
  powderMap: Map<string, PowderBatch>,
): SkuPerf[] {
  const map = new Map<string, SkuPerf>()

  for (const order of orders) {
    for (const line of order.order_lines) {
      if (!line.sku_id) continue
      const lc = calcLineCosts(line, skuMap, batchLines, batches, powderMap)
      const sku = skuMap.get(line.sku_id)
      const desc = sku?.description ?? line.description ?? line.ss_sku ?? line.sku_id

      if (!map.has(line.sku_id)) {
        map.set(line.sku_id, {
          skuId: line.sku_id,
          description: desc,
          unitsSold: 0,
          revenue: null,
          matCostTotal: null,
          boltKitTotal: null,
          packagingTotal: null,
          laborTotal: null,
          estCOGSTotal: null,
          estMarginTotal: null,
        })
      }

      const perf = map.get(line.sku_id)!
      perf.unitsSold += line.qty
      if (lc.revenue != null) perf.revenue = (perf.revenue ?? 0) + lc.revenue
      if (lc.matCost != null) perf.matCostTotal = (perf.matCostTotal ?? 0) + lc.matCost
      if (lc.boltKit != null) perf.boltKitTotal = (perf.boltKitTotal ?? 0) + lc.boltKit
      if (lc.packaging != null) perf.packagingTotal = (perf.packagingTotal ?? 0) + lc.packaging
      if (lc.labor != null) perf.laborTotal = (perf.laborTotal ?? 0) + lc.labor

      const lineCOGS = (lc.matCost ?? 0) + (lc.boltKit ?? 0) + (lc.packaging ?? 0) + (lc.labor ?? 0)
      if (lc.matCost != null || lc.boltKit != null || lc.packaging != null || lc.labor != null) {
        perf.estCOGSTotal = (perf.estCOGSTotal ?? 0) + lineCOGS
      }
      if (lc.lineMargin != null) perf.estMarginTotal = (perf.estMarginTotal ?? 0) + lc.lineMargin
    }
  }

  return Array.from(map.values()).sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
}

// ── Monthly trend ──────────────────────────────────────────────────────────────

type MonthTrend = {
  key: string
  label: string
  orders: number
  revenue: number | null
  estCOGS: number | null
  estMargin: number | null
}

function buildMonthTrend(
  orders: Order[],
  skuMap: Map<string, SKU>,
  batchLines: BuildBatchLine[],
  batches: BuildBatch[],
  powderMap: Map<string, PowderBatch>,
): MonthTrend[] {
  const map = new Map<string, MonthTrend>()

  for (const order of orders) {
    const dateStr = order.shipped_at ?? order.order_date
    if (!dateStr) continue
    const key = fmtMonthKey(dateStr)
    const label = fmtMonthLabel(key)

    if (!map.has(key)) {
      map.set(key, { key, label, orders: 0, revenue: null, estCOGS: null, estMargin: null })
    }

    const trend = map.get(key)!
    trend.orders += 1

    const costs = calcOrderCosts(order, skuMap, batchLines, batches, powderMap)
    if (costs.revenue != null) trend.revenue = (trend.revenue ?? 0) + costs.revenue
    if (costs.totalCOGS != null) trend.estCOGS = (trend.estCOGS ?? 0) + costs.totalCOGS
    if (costs.grossMargin != null) trend.estMargin = (trend.estMargin ?? 0) + costs.grossMargin
  }

  return Array.from(map.values())
    .sort((a, b) => b.key.localeCompare(a.key))
    .slice(0, 6)
}

// ── Derived month options for filter ──────────────────────────────────────────

function getMonthOptions(orders: Order[]): { key: string; label: string }[] {
  const keys = new Set<string>()
  for (const o of orders) {
    const d = o.shipped_at ?? o.order_date
    if (d) keys.add(fmtMonthKey(d))
  }
  return Array.from(keys)
    .sort((a, b) => b.localeCompare(a))
    .map((k) => ({ key: k, label: fmtMonthLabel(k) }))
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function OrderHistoryPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [orders, setOrders]           = useState<Order[]>([])
  const [skus, setSkus]               = useState<SKU[]>([])
  const [batchLines, setBatchLines]   = useState<BuildBatchLine[]>([])
  const [batches, setBatches]         = useState<BuildBatch[]>([])
  const [powderBatches, setPowderBatches] = useState<PowderBatch[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)

  // Filters
  const [monthFilter, setMonthFilter] = useState<string>('all')
  const [channelFilter, setChannelFilter] = useState<string>('all')
  const [search, setSearch]           = useState('')

  // Expanded rows
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  // ── Data loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)

      try {
        const [ordersRes, skusRes, batchLinesRes, batchesRes, powderRes] = await Promise.all([
          supabase
            .from('orders')
            .select('id, order_number, channel, customer_name, order_date, shipped_at, shipping_cost, status, notes, order_lines(id, order_id, sku_id, ss_sku, description, qty, unit_price)')
            .eq('status', 'shipped')
            .order('shipped_at', { ascending: false }),
          supabase
            .from('skus')
            .select('id, description, bolt_kit_cost, packaging_cost, labor_cost_per_unit'),
          supabase
            .from('build_batch_lines')
            .select('batch_id, sku_id, qty, mat_cost_snapshot'),
          supabase
            .from('build_batches')
            .select('id, name, status, completed_at, powder_batch_id'),
          supabase
            .from('powder_batches')
            .select('id, batch_name, total_cost, status'),
        ])

        if (ordersRes.error) throw new Error(ordersRes.error.message)
        if (skusRes.error) throw new Error(skusRes.error.message)
        if (batchLinesRes.error) throw new Error(batchLinesRes.error.message)
        if (batchesRes.error) throw new Error(batchesRes.error.message)
        if (powderRes.error) throw new Error(powderRes.error.message)

        setOrders((ordersRes.data ?? []) as Order[])
        setSkus(skusRes.data ?? [])
        setBatchLines(batchLinesRes.data ?? [])
        setBatches(batchesRes.data ?? [])
        setPowderBatches(powderRes.data ?? [])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load data')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [supabase])

  // ── Derived maps ────────────────────────────────────────────────────────────

  const skuMap = useMemo(() => {
    const m = new Map<string, SKU>()
    for (const s of skus) m.set(s.id, s)
    return m
  }, [skus])

  const powderMap = useMemo(() => {
    const m = new Map<string, PowderBatch>()
    for (const p of powderBatches) m.set(p.id, p)
    return m
  }, [powderBatches])

  // ── Filter options ──────────────────────────────────────────────────────────

  const monthOptions = useMemo(() => getMonthOptions(orders), [orders])

  const channels = useMemo(() => {
    const s = new Set<string>()
    for (const o of orders) if (o.channel) s.add(o.channel)
    return Array.from(s).sort()
  }, [orders])

  // ── Filtered orders ─────────────────────────────────────────────────────────

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (channelFilter !== 'all' && o.channel !== channelFilter) return false

      if (monthFilter !== 'all') {
        const d = o.shipped_at ?? o.order_date
        if (!d || fmtMonthKey(d) !== monthFilter) return false
      }

      if (search.trim()) {
        const q = search.toLowerCase()
        const matchNum = o.order_number.toLowerCase().includes(q)
        const matchCust = o.customer_name?.toLowerCase().includes(q) ?? false
        if (!matchNum && !matchCust) return false
      }

      return true
    })
  }, [orders, channelFilter, monthFilter, search])

  // ── Order costs (memoized) ──────────────────────────────────────────────────

  const orderCostsMap = useMemo(() => {
    const m = new Map<string, CostBreakdown>()
    for (const o of filteredOrders) {
      m.set(o.id, calcOrderCosts(o, skuMap, batchLines, batches, powderMap))
    }
    return m
  }, [filteredOrders, skuMap, batchLines, batches, powderMap])

  // ── Summary stats ───────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    let totalRevenue = 0
    let totalShipping = 0
    let hasRevenue = false
    let hasShipping = false

    for (const costs of orderCostsMap.values()) {
      if (costs.revenue != null) { totalRevenue += costs.revenue; hasRevenue = true }
      if (costs.shipping != null) { totalShipping += costs.shipping; hasShipping = true }
    }

    const orderCount = filteredOrders.length
    const avgOrderValue = hasRevenue && orderCount > 0 ? totalRevenue / orderCount : null

    return {
      totalRevenue: hasRevenue ? totalRevenue : null,
      orderCount,
      avgOrderValue,
      totalShipping: hasShipping ? totalShipping : null,
    }
  }, [filteredOrders, orderCostsMap])

  // ── Totals footer ───────────────────────────────────────────────────────────

  const totals = useMemo(() => {
    let revenue = 0, shipping = 0, matCost = 0, boltKit = 0, packaging = 0, labor = 0, totalCOGS = 0, grossMargin = 0
    let hasRevenue = false, hasShipping = false, hasMat = false, hasBolt = false, hasPkg = false, hasLabor = false
    let hasCOGS = false, hasMargin = false

    for (const c of orderCostsMap.values()) {
      if (c.revenue != null) { revenue += c.revenue; hasRevenue = true }
      if (c.shipping != null) { shipping += c.shipping; hasShipping = true }
      if (c.matCost != null) { matCost += c.matCost; hasMat = true }
      if (c.boltKit != null) { boltKit += c.boltKit; hasBolt = true }
      if (c.packaging != null) { packaging += c.packaging; hasPkg = true }
      if (c.labor != null) { labor += c.labor; hasLabor = true }
      if (c.totalCOGS != null) { totalCOGS += c.totalCOGS; hasCOGS = true }
      if (c.grossMargin != null) { grossMargin += c.grossMargin; hasMargin = true }
    }

    const marginPct = hasRevenue && hasMargin && revenue !== 0 ? (grossMargin / revenue) * 100 : null

    return {
      revenue: hasRevenue ? revenue : null,
      shipping: hasShipping ? shipping : null,
      matCost: hasMat ? matCost : null,
      boltKit: hasBolt ? boltKit : null,
      packaging: hasPkg ? packaging : null,
      labor: hasLabor ? labor : null,
      totalCOGS: hasCOGS ? totalCOGS : null,
      grossMargin: hasMargin ? grossMargin : null,
      marginPct,
    }
  }, [orderCostsMap])

  // ── SKU performance ─────────────────────────────────────────────────────────

  const skuPerf = useMemo(
    () => aggregateSkuPerformance(filteredOrders, skuMap, batchLines, batches, powderMap),
    [filteredOrders, skuMap, batchLines, batches, powderMap]
  )

  // ── Monthly trend ───────────────────────────────────────────────────────────

  // Always based on all orders (not filtered) for trend context
  const monthTrend = useMemo(
    () => buildMonthTrend(orders, skuMap, batchLines, batches, powderMap),
    [orders, skuMap, batchLines, batches, powderMap]
  )

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function marginStyle(pct: number | null): React.CSSProperties {
    if (pct == null) return {}
    return { color: pct >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }
  }

  function skuLabel(line: OrderLine): string {
    const sku = line.sku_id ? skuMap.get(line.sku_id) : null
    return sku?.description ?? line.description ?? line.ss_sku
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="section-stack" style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>

      {/* Page header */}
      <div className="page-header">
        <div>
          <div className="kicker">Finance</div>
          <h1 className="page-title">Order History</h1>
          <p className="page-subtitle">
            Shipped orders with cost breakdown — material, powder coat, bolt kits, packaging, and labor.
          </p>
        </div>
      </div>

      {loading && (
        <div className="message">Loading order history…</div>
      )}

      {error && (
        <div className="message" style={{ color: 'var(--danger)' }}>Error: {error}</div>
      )}

      {!loading && !error && (
        <>
          {/* ── Summary stat cards ─────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            <StatCard label="Total Revenue" value={fmtCurrency(stats.totalRevenue)} />
            <StatCard label="Orders Shipped" value={String(stats.orderCount)} />
            <StatCard label="Avg Order Value" value={fmtCurrency(stats.avgOrderValue)} />
            <StatCard label="Total Shipping Cost" value={fmtCurrency(stats.totalShipping)} />
          </div>

          {/* ── Filter bar ─────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field">
              <label className="label">Month</label>
              <div className="select">
                <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)}>
                  <option value="all">All Time</option>
                  {monthOptions.map((opt) => (
                    <option key={opt.key} value={opt.key}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <label className="label">Channel</label>
              <div className="select">
                <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
                  <option value="all">All Channels</option>
                  {channels.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <label className="label">Search</label>
              <input
                type="text"
                placeholder="Order # or customer name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  background: 'var(--panel)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '6px 10px',
                  color: 'var(--text)',
                  fontSize: 14,
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          {/* ── Orders table ───────────────────────────────────────────────── */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Shipped Orders</span>
              <span className="card-subtitle">{filteredOrders.length} order{filteredOrders.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {filteredOrders.length === 0 ? (
                <div className="empty">No shipped orders match your filters.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Order #</th>
                        <th>Customer</th>
                        <th>Channel</th>
                        <th>Shipped</th>
                        <th>SKUs</th>
                        <th style={{ textAlign: 'right' }}>Revenue</th>
                        <th style={{ textAlign: 'right' }}>Shipping</th>
                        <th style={{ textAlign: 'right' }}>Mat Cost</th>
                        <th style={{ textAlign: 'right' }}>Bolt Kit</th>
                        <th style={{ textAlign: 'right' }}>Packaging</th>
                        <th style={{ textAlign: 'right' }}>Labor</th>
                        <th style={{ textAlign: 'right' }}>Total COGS</th>
                        <th style={{ textAlign: 'right' }}>Gross Margin</th>
                        <th style={{ textAlign: 'right' }}>Margin %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOrders.map((order) => {
                        const costs = orderCostsMap.get(order.id)!
                        const isExpanded = expandedRows.has(order.id)
                        const skuList = order.order_lines
                          .map((l) => skuLabel(l))
                          .filter(Boolean)
                          .join(', ')

                        return (
                          <>
                            <tr
                              key={order.id}
                              onClick={() => toggleRow(order.id)}
                              style={{ cursor: 'pointer' }}
                            >
                              <td style={{ fontWeight: 600, color: 'var(--accent)' }}>
                                {isExpanded ? '▾' : '▸'} {order.order_number}
                              </td>
                              <td>{order.customer_name ?? '—'}</td>
                              <td>
                                <span style={{
                                  fontSize: 11,
                                  padding: '2px 7px',
                                  borderRadius: 10,
                                  background: 'var(--panel-2)',
                                  color: 'var(--text-2)',
                                  whiteSpace: 'nowrap',
                                }}>
                                  {order.channel}
                                </span>
                              </td>
                              <td style={{ whiteSpace: 'nowrap', color: 'var(--text-2)' }}>
                                {fmtDate(order.shipped_at)}
                              </td>
                              <td style={{ color: 'var(--text-2)', fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {skuList || '—'}
                              </td>
                              <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtCurrency(costs.revenue)}</td>
                              <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(costs.shipping)}</td>
                              <td style={{ textAlign: 'right', color: 'var(--text-2)', fontStyle: costs.matEstimated ? 'italic' : undefined }}>
                                {fmtCurrency(costs.matCost)}
                              </td>
                              <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(costs.boltKit)}</td>
                              <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(costs.packaging)}</td>
                              <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(costs.labor)}</td>
                              <td style={{ textAlign: 'right' }}>{fmtCurrency(costs.totalCOGS)}</td>
                              <td style={{ textAlign: 'right', ...marginStyle(costs.grossMargin) }}>{fmtCurrency(costs.grossMargin)}</td>
                              <td style={{ textAlign: 'right', ...marginStyle(costs.marginPct) }}>{fmtPct(costs.marginPct)}</td>
                            </tr>

                            {isExpanded && (
                              <tr key={order.id + '-expanded'} style={{ background: 'var(--panel-2)' }}>
                                <td colSpan={14} style={{ padding: '0 16px 16px 32px' }}>
                                  <LineBreakdown
                                    order={order}
                                    skuMap={skuMap}
                                    batchLines={batchLines}
                                    batches={batches}
                                    powderMap={powderMap}
                                  />
                                </td>
                              </tr>
                            )}
                          </>
                        )
                      })}
                    </tbody>

                    {/* Totals footer */}
                    <tfoot>
                      <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                        <td colSpan={5} style={{ color: 'var(--text-2)' }}>Totals ({filteredOrders.length} orders)</td>
                        <td style={{ textAlign: 'right' }}>{fmtCurrency(totals.revenue)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtCurrency(totals.shipping)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtCurrency(totals.matCost)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtCurrency(totals.boltKit)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtCurrency(totals.packaging)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtCurrency(totals.labor)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtCurrency(totals.totalCOGS)}</td>
                        <td style={{ textAlign: 'right', ...marginStyle(totals.grossMargin) }}>{fmtCurrency(totals.grossMargin)}</td>
                        <td style={{ textAlign: 'right', ...marginStyle(totals.marginPct) }}>{fmtPct(totals.marginPct)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* ── SKU Performance ────────────────────────────────────────────── */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">SKU Performance</span>
              <span className="card-subtitle">Aggregated across filtered orders</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {skuPerf.length === 0 ? (
                <div className="empty">No SKU data for the current filters.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>Description</th>
                        <th style={{ textAlign: 'right' }}>Units Sold</th>
                        <th style={{ textAlign: 'right' }}>Revenue</th>
                        <th style={{ textAlign: 'right' }}>Mat/Unit</th>
                        <th style={{ textAlign: 'right' }}>Bolt Kit/Unit</th>
                        <th style={{ textAlign: 'right' }}>Packaging/Unit</th>
                        <th style={{ textAlign: 'right' }}>Labor/Unit</th>
                        <th style={{ textAlign: 'right' }}>Est. COGS/Unit</th>
                        <th style={{ textAlign: 'right' }}>Est. Margin/Unit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {skuPerf.map((p) => {
                        const matPU = p.matCostTotal != null && p.unitsSold > 0 ? p.matCostTotal / p.unitsSold : null
                        const boltPU = p.boltKitTotal != null && p.unitsSold > 0 ? p.boltKitTotal / p.unitsSold : null
                        const pkgPU = p.packagingTotal != null && p.unitsSold > 0 ? p.packagingTotal / p.unitsSold : null
                        const laborPU = p.laborTotal != null && p.unitsSold > 0 ? p.laborTotal / p.unitsSold : null
                        const cogsPU = p.estCOGSTotal != null && p.unitsSold > 0 ? p.estCOGSTotal / p.unitsSold : null
                        const marginPU = p.estMarginTotal != null && p.unitsSold > 0 ? p.estMarginTotal / p.unitsSold : null

                        return (
                          <tr key={p.skuId}>
                            <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.skuId}</td>
                            <td>{p.description}</td>
                            <td style={{ textAlign: 'right' }}>{p.unitsSold}</td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtCurrency(p.revenue)}</td>
                            <td style={{ textAlign: 'right', color: 'var(--text-2)', fontStyle: 'italic' }}>{fmtCurrency(matPU)}</td>
                            <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(boltPU)}</td>
                            <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(pkgPU)}</td>
                            <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(laborPU)}</td>
                            <td style={{ textAlign: 'right' }}>{fmtCurrency(cogsPU)}</td>
                            <td style={{ textAlign: 'right', ...marginStyle(marginPU) }}>{fmtCurrency(marginPU)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* ── Monthly trend ───────────────────────────────────────────────── */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Monthly Trend</span>
              <span className="card-subtitle">Last 6 months — all orders</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {monthTrend.length === 0 ? (
                <div className="empty">No monthly data available yet.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th style={{ textAlign: 'right' }}>Orders</th>
                        <th style={{ textAlign: 'right' }}>Revenue</th>
                        <th style={{ textAlign: 'right' }}>Est. COGS</th>
                        <th style={{ textAlign: 'right' }}>Est. Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthTrend.map((t) => (
                        <tr key={t.key}>
                          <td style={{ fontWeight: 600 }}>{t.label}</td>
                          <td style={{ textAlign: 'right' }}>{t.orders}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtCurrency(t.revenue)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(t.estCOGS)}</td>
                          <td style={{ textAlign: 'right', ...marginStyle(t.estMargin) }}>{fmtCurrency(t.estMargin)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div style={{ padding: '10px 16px', color: 'var(--muted)', fontSize: 12, borderTop: '1px solid var(--border)' }}>
              Mat cost is estimated from the most recent completed build batch snapshot per SKU.
              Powder coat cost is not split per SKU — see individual Powder Run records for details.
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Stat card sub-component ────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="card-body" style={{ padding: '20px 24px' }}>
        <div className="kicker" style={{ marginBottom: 8 }}>{label}</div>
        <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text)' }}>{value}</div>
      </div>
    </div>
  )
}

// ── Line breakdown sub-component ───────────────────────────────────────────────

function LineBreakdown({
  order,
  skuMap,
  batchLines,
  batches,
  powderMap,
}: {
  order: Order
  skuMap: Map<string, SKU>
  batchLines: BuildBatchLine[]
  batches: BuildBatch[]
  powderMap: Map<string, PowderBatch>
}) {
  function fmtCurrency(n: number | null) {
    if (n == null) return '—'
    return '$' + n.toFixed(2)
  }

  function fmtPct(n: number | null) {
    if (n == null) return '—'
    return n.toFixed(1) + '%'
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Line Items
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <th style={{ textAlign: 'left', paddingBottom: 4, fontWeight: 500 }}>SKU / Description</th>
            <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 500 }}>Qty</th>
            <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 500 }}>Unit Price</th>
            <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 500 }}>Revenue</th>
            <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 500 }}>Mat Cost</th>
            <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 500 }}>Powder Run</th>
            <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 500 }}>Bolt Kit</th>
            <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 500 }}>Packaging</th>
            <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 500 }}>Labor</th>
            <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 500 }}>Line COGS</th>
            <th style={{ textAlign: 'right', paddingBottom: 4, fontWeight: 500 }}>Line Margin</th>
          </tr>
        </thead>
        <tbody>
          {order.order_lines.map((line) => {
            const lc = calcLineCosts(line, skuMap, batchLines, batches, powderMap)
            const lineMarginPct = lc.lineMargin != null && lc.revenue != null && lc.revenue !== 0
              ? (lc.lineMargin / lc.revenue) * 100
              : null

            return (
              <tr key={line.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 0', color: 'var(--text)' }}>
                  <div style={{ fontWeight: 500 }}>{lc.sku?.description ?? line.description ?? line.ss_sku}</div>
                  {line.sku_id && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{line.sku_id}</div>
                  )}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{line.qty}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(line.unit_price)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtCurrency(lc.revenue)}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)', fontStyle: lc.matEstimated ? 'italic' : undefined }}>
                  {fmtCurrency(lc.matCost)}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--accent)', fontSize: 12 }}>
                  {lc.powderRunName ?? '—'}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(lc.boltKit)}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(lc.packaging)}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{fmtCurrency(lc.labor)}</td>
                <td style={{ textAlign: 'right' }}>{fmtCurrency(lc.lineCOGS)}</td>
                <td style={{ textAlign: 'right', color: lineMarginPct != null ? (lineMarginPct >= 0 ? 'var(--success)' : 'var(--danger)') : undefined, fontWeight: 600 }}>
                  {fmtCurrency(lc.lineMargin)}
                  {lineMarginPct != null && (
                    <span style={{ fontSize: 11, marginLeft: 4, opacity: 0.8 }}>({fmtPct(lineMarginPct)})</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
