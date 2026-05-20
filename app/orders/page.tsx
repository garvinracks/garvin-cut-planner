'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type StoreConfig = {
  storeId: number
  storeName: string
  marketplaceName: string
  channel: string
  enabled: boolean
}

type SSStore = {
  storeId: number
  storeName: string
  marketplaceName: string
}

type OrderLine = {
  id: string
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
  ship_by_date: string | null
  status: string
  ss_status: string | null
  synced_at: string | null
  notes: string | null
  shipped_at: string | null
  shipping_cost: number | null
  order_lines: OrderLine[]
}

type SKU = { id: string; description: string; setup_complete: boolean; category: string | null }
type InventoryRow = { sku_id: string; qty_on_hand: number }
type BatchLine = { batch_id: string; sku_id: string }
type ActiveBatch = { id: string; name: string; status: string }
type AllocStatus = 'ready' | 'partial' | 'build_needed' | 'unmatched'
type ViewMode = 'by_order' | 'by_sku'
type SortDir = 'asc' | 'desc'

// ── History-specific types ────────────────────────────────────────────────────

type HistorySKU = {
  id: string
  description: string
  bolt_kit_cost: number | null
  packaging_cost: number | null
  labor_cost_per_unit: number | null
  setup_complete: boolean
}

type HistoryBatchLine = {
  batch_id: string
  sku_id: string
  qty: number
  mat_cost_snapshot: number | null
}

type HistoryBatch = {
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

type CostBreakdown = {
  revenue: number | null
  shipping: number | null
  matCost: number | null
  matEstimated: boolean
  boltKit: number | null
  packaging: number | null
  labor: number | null
  totalCOGS: number | null
  grossMargin: number | null
  marginPct: number | null
}

type LineCost = {
  line: OrderLine
  sku: HistorySKU | null
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

type MonthTrend = {
  key: string
  label: string
  orders: number
  revenue: number | null
  estCOGS: number | null
  estMargin: number | null
}

// ── Category inference ────────────────────────────────────────────────────────

const CATEGORY_ORDER = ['Racks', 'Ladders', 'Deflectors', 'Accessories', 'Parts', 'Uncategorized'] as const
type Category = typeof CATEGORY_ORDER[number]

function getCategory(description: string): Category {
  const d = (description ?? '').toLowerCase()
  if (d.includes('rack')) return 'Racks'
  if (d.includes('ladder')) return 'Ladders'
  if (d.includes('deflect')) return 'Deflectors'
  if (d.includes('basket') || d.includes('mount') || d.includes('bracket') ||
      d.includes('accessory') || d.includes('accessories') || d.includes('light') ||
      d.includes('clamp') || d.includes('tie') || d.includes('cargo')) return 'Accessories'
  return 'Uncategorized'
}

function lineCategory(line: OrderLine, skus: SKU[]): Category {
  const sku = skus.find((s) => s.id === line.sku_id)
  if (sku?.category && (CATEGORY_ORDER as readonly string[]).includes(sku.category)) return sku.category as Category
  return getCategory(sku?.description ?? line.description ?? '')
}

function orderCategory(order: Order, skus: SKU[]): Category {
  for (const line of order.order_lines) {
    const cat = lineCategory(line, skus)
    if (cat !== 'Uncategorized') return cat
  }
  return 'Uncategorized'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  return Math.floor(diff / 86_400_000)
}

const CH_STYLE: Record<string, { bg: string; text: string }> = {
  shopify: { bg: 'rgba(34,197,94,0.18)',  text: '#4ade80' },
  turn5:   { bg: 'rgba(245,158,11,0.18)', text: '#fbbf24' },
}

// ── History helper functions ──────────────────────────────────────────────────

function histFmtMonthKey(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function histFmtMonthLabel(key: string) {
  const [y, m] = key.split('-')
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

function histFmtCurrency(n: number | null) {
  if (n == null) return '—'
  return '$' + n.toFixed(2)
}

function histFmtPct(n: number | null) {
  if (n == null) return '—'
  return n.toFixed(1) + '%'
}

function calcLineCosts(
  line: OrderLine,
  skuMap: Map<string, HistorySKU>,
  batchLines: HistoryBatchLine[],
  batches: HistoryBatch[],
  powderMap: Map<string, PowderBatch>,
): LineCost {
  const sku = line.sku_id ? (skuMap.get(line.sku_id) ?? null) : null
  const revenue = line.unit_price != null ? line.unit_price * line.qty : null

  let matCost: number | null = null
  let matEstimated = false
  let powderRunName: string | null = null

  if (line.sku_id) {
    const relevantBatchLines = batchLines.filter(
      (bl) => bl.sku_id === line.sku_id && bl.mat_cost_snapshot != null
    )
    const completedBatches = batches
      .filter((b) => b.status === 'complete' && b.completed_at != null)
      .sort((a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime())

    for (const batch of completedBatches) {
      const bl = relevantBatchLines.find((l) => l.batch_id === batch.id)
      if (bl && bl.mat_cost_snapshot != null && bl.qty > 0) {
        matCost = (bl.mat_cost_snapshot / bl.qty) * line.qty
        matEstimated = true
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
  const hasCOGS = matCost != null || boltKit != null || packaging != null || labor != null
  const lineCOGS = hasCOGS ? (matCost ?? 0) + (boltKit ?? 0) + (packaging ?? 0) + (labor ?? 0) : null
  const lineMargin = revenue != null && lineCOGS != null ? revenue - lineCOGS : null

  return { line, sku, revenue, matCost, matEstimated, powderRunName, boltKit, packaging, labor, lineCOGS, lineMargin }
}

function calcOrderCosts(
  order: Order,
  skuMap: Map<string, HistorySKU>,
  batchLines: HistoryBatchLine[],
  batches: HistoryBatch[],
  powderMap: Map<string, PowderBatch>,
): CostBreakdown {
  const lineCosts = order.order_lines.map((l) => calcLineCosts(l, skuMap, batchLines, batches, powderMap))

  const revenue = lineCosts.some((lc) => lc.revenue != null)
    ? lineCosts.reduce((s, lc) => s + (lc.revenue ?? 0), 0) : null
  const shipping = order.shipping_cost
  const matCost = lineCosts.some((lc) => lc.matCost != null)
    ? lineCosts.reduce((s, lc) => s + (lc.matCost ?? 0), 0) : null
  const matEstimated = lineCosts.some((lc) => lc.matEstimated)
  const boltKit = lineCosts.some((lc) => lc.boltKit != null)
    ? lineCosts.reduce((s, lc) => s + (lc.boltKit ?? 0), 0) : null
  const packaging = lineCosts.some((lc) => lc.packaging != null)
    ? lineCosts.reduce((s, lc) => s + (lc.packaging ?? 0), 0) : null
  const labor = lineCosts.some((lc) => lc.labor != null)
    ? lineCosts.reduce((s, lc) => s + (lc.labor ?? 0), 0) : null
  const hasCOGS = matCost != null || shipping != null || boltKit != null || packaging != null || labor != null
  const totalCOGS = hasCOGS
    ? (matCost ?? 0) + (shipping ?? 0) + (boltKit ?? 0) + (packaging ?? 0) + (labor ?? 0) : null
  const grossMargin = revenue != null && totalCOGS != null ? revenue - totalCOGS : null
  const marginPct = grossMargin != null && revenue != null && revenue !== 0
    ? (grossMargin / revenue) * 100 : null

  return { revenue, shipping, matCost, matEstimated, boltKit, packaging, labor, totalCOGS, grossMargin, marginPct }
}

function aggregateSkuPerf(
  orders: Order[],
  skuMap: Map<string, HistorySKU>,
  batchLines: HistoryBatchLine[],
  batches: HistoryBatch[],
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
        map.set(line.sku_id, { skuId: line.sku_id, description: desc, unitsSold: 0,
          revenue: null, matCostTotal: null, boltKitTotal: null, packagingTotal: null,
          laborTotal: null, estCOGSTotal: null, estMarginTotal: null })
      }
      const perf = map.get(line.sku_id)!
      perf.unitsSold += line.qty
      if (lc.revenue != null) perf.revenue = (perf.revenue ?? 0) + lc.revenue
      if (lc.matCost != null) perf.matCostTotal = (perf.matCostTotal ?? 0) + lc.matCost
      if (lc.boltKit != null) perf.boltKitTotal = (perf.boltKitTotal ?? 0) + lc.boltKit
      if (lc.packaging != null) perf.packagingTotal = (perf.packagingTotal ?? 0) + lc.packaging
      if (lc.labor != null) perf.laborTotal = (perf.laborTotal ?? 0) + lc.labor
      const lineCOGS = (lc.matCost ?? 0) + (lc.boltKit ?? 0) + (lc.packaging ?? 0) + (lc.labor ?? 0)
      if (lc.matCost != null || lc.boltKit != null || lc.packaging != null || lc.labor != null)
        perf.estCOGSTotal = (perf.estCOGSTotal ?? 0) + lineCOGS
      if (lc.lineMargin != null) perf.estMarginTotal = (perf.estMarginTotal ?? 0) + lc.lineMargin
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
}

function buildMonthTrend(
  orders: Order[],
  skuMap: Map<string, HistorySKU>,
  batchLines: HistoryBatchLine[],
  batches: HistoryBatch[],
  powderMap: Map<string, PowderBatch>,
): MonthTrend[] {
  const map = new Map<string, MonthTrend>()
  for (const order of orders) {
    const dateStr = order.shipped_at ?? order.order_date
    if (!dateStr) continue
    const key = histFmtMonthKey(dateStr)
    const label = histFmtMonthLabel(key)
    if (!map.has(key)) map.set(key, { key, label, orders: 0, revenue: null, estCOGS: null, estMargin: null })
    const trend = map.get(key)!
    trend.orders += 1
    const costs = calcOrderCosts(order, skuMap, batchLines, batches, powderMap)
    if (costs.revenue != null) trend.revenue = (trend.revenue ?? 0) + costs.revenue
    if (costs.totalCOGS != null) trend.estCOGS = (trend.estCOGS ?? 0) + costs.totalCOGS
    if (costs.grossMargin != null) trend.estMargin = (trend.estMargin ?? 0) + costs.grossMargin
  }
  return Array.from(map.values()).sort((a, b) => b.key.localeCompare(a.key)).slice(0, 6)
}

// ─────────────────────────────────────────────────────────────────────────────

const ALLOC_STYLE: Record<AllocStatus, { icon: string; label: string; color: string; bg: string }> = {
  ready:       { icon: '🟢', label: 'Ready to Ship', color: 'var(--success)',  bg: 'rgba(34,197,94,0.12)' },
  partial:     { icon: '🟡', label: 'Partial',        color: 'var(--warning)', bg: 'rgba(234,179,8,0.12)'  },
  build_needed:{ icon: '🔴', label: 'Build Needed',  color: 'var(--danger)',  bg: 'rgba(239,68,68,0.12)'  },
  unmatched:   { icon: '⚪', label: 'No SKU Match',  color: 'var(--muted)',   bg: 'transparent'            },
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  // Store config
  const [storeConfig, setStoreConfig] = useState<StoreConfig[]>([])
  const [ssStores, setSsStores]       = useState<SSStore[]>([])
  const [setupOpen, setSetupOpen]     = useState(false)
  const [loadingStores, setLoadingStores] = useState(false)
  const [savingConfig, setSavingConfig]   = useState(false)
  const [configMessage, setConfigMessage] = useState('')

  // Orders + supporting data
  const [orders, setOrders]     = useState<Order[]>([])
  const [skus, setSkus]         = useState<SKU[]>([])
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [syncing, setSyncing]   = useState(false)
  const [syncMessage, setSyncMessage] = useState('')

  // Table controls
  const [channelFilter, setChannelFilter] = useState<'all' | 'shopify' | 'turn5' | 'ready'>('all')
  const [viewMode, setViewMode]     = useState<ViewMode>('by_order')
  const [sortDir, setSortDir]       = useState<SortDir>('asc')
  const [sortField, setSortField]   = useState<'date' | 'status'>('date')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Allocation
  const [allocStatuses, setAllocStatuses] = useState<Record<string, AllocStatus>>({})
  const [allocated, setAllocated]         = useState(false)

  // Category grouping
  const [groupByCategory, setGroupByCategory] = useState(false)

  // Batch status tracking
  const [batchLines, setBatchLines] = useState<BatchLine[]>([])
  const [activeBatches, setActiveBatches] = useState<ActiveBatch[]>([])

  // Ship modal
  const [shippingOrderId, setShippingOrderId] = useState<string | null>(null)

  // Combine & Ship modal
  const [combineOpen, setCombineOpen]         = useState(false)
  const [combinePrimary, setCombinePrimary]   = useState<string>('')   // order id to keep
  const [combineShipping, setCombineShipping] = useState('')
  const [combineSaving, setCombineSaving]     = useState(false)

  // Auto-allocate flash message (triggered from powder page)
  const [autoMessage, setAutoMessage] = useState('')

  // Order history (lazy-loaded when section is opened)
  const [histOpen, setHistOpen]               = useState(false)
  const [histLoaded, setHistLoaded]           = useState(false)
  const [histLoading, setHistLoading]         = useState(false)
  const [histError, setHistError]             = useState<string | null>(null)
  const [histOrders, setHistOrders]           = useState<Order[]>([])
  const [histSkus, setHistSkus]               = useState<HistorySKU[]>([])
  const [histBatchLines, setHistBatchLines]   = useState<HistoryBatchLine[]>([])
  const [histBatches, setHistBatches]         = useState<HistoryBatch[]>([])
  const [histPowderBatches, setHistPowderBatches] = useState<PowderBatch[]>([])
  const [histMonthFilter, setHistMonthFilter] = useState('all')
  const [histChannelFilter, setHistChannelFilter] = useState('all')
  const [histSearch, setHistSearch]           = useState('')
  const [histExpandedRows, setHistExpandedRows] = useState<Set<string>>(new Set())
  const [histEditId, setHistEditId]             = useState<string | null>(null)
  const [histEditCost, setHistEditCost]         = useState('')
  const [histEditDate, setHistEditDate]         = useState('')

  // ── Data loading ────────────────────────────────────────────────────────────

  async function loadConfig() {
    const { data } = await supabase
      .from('app_settings').select('value').eq('key', 'shipstation_stores').single()
    if (data?.value) setStoreConfig(data.value as StoreConfig[])
    else setSetupOpen(true)
  }

  async function loadOrders() {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id, order_number, channel, customer_name, order_date, ship_by_date,
        status, ss_status, synced_at, notes,
        order_lines(id, sku_id, ss_sku, description, qty, unit_price)
      `)
      .eq('status', 'open')
      .order('order_date', { ascending: true })
    if (!error) setOrders((data ?? []) as Order[])
  }

  async function loadSkus() {
    const { data } = await supabase.from('skus').select('id, description, setup_complete, category').order('id')
    setSkus((data ?? []) as SKU[])
  }

  async function loadInventory() {
    const { data } = await supabase.from('sku_inventory').select('sku_id, qty_on_hand')
    setInventory((data ?? []) as InventoryRow[])
  }

  async function loadBatches() {
    const [{ data: bl }, { data: ab }] = await Promise.all([
      supabase.from('build_batch_lines').select('batch_id, sku_id'),
      supabase.from('build_batches').select('id, name, status').in('status', ['draft', 'planned', 'in_progress', 'at_powder']),
    ])
    setBatchLines((bl ?? []) as BatchLine[])
    setActiveBatches((ab ?? []) as ActiveBatch[])
  }

  async function initialLoad() {
    setLoading(true)
    await Promise.all([loadConfig(), loadOrders(), loadSkus(), loadInventory(), loadBatches()])
    setLoading(false)
  }
  useEffect(() => { void initialLoad() }, [])

  // Show auto-allocate flash when arriving from powder page
  useEffect(() => {
    if (!loading && sessionStorage.getItem('garvin:auto_allocate') === 'true') {
      sessionStorage.removeItem('garvin:auto_allocate')
      const msg = 'Inventory updated from powder return — checking what\'s ready to ship...'
      setAutoMessage(msg)
      setTimeout(() => setAutoMessage(''), 5000)
    }
  }, [loading])

  useEffect(() => {
    const channel = supabase
      .channel('orders-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        void loadOrders()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sku_inventory' }, () => {
        void loadInventory()
      })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [])

  // Auto-run allocation once data is loaded so ready-to-ship status
  // is always current without needing to click "Allocate Stock"
  useEffect(() => {
    if (!loading && orders.length > 0) runAllocation()
  }, [loading])

  // ── ShipStation store setup ─────────────────────────────────────────────────

  async function loadSSStores() {
    setLoadingStores(true)
    setConfigMessage('')
    try {
      const res  = await fetch('/api/shipstation/stores')
      const data = await res.json()
      if (!res.ok) { setConfigMessage(data.error ?? 'Failed to load stores.'); return }
      const stores: SSStore[] = Array.isArray(data) ? data : []
      setSsStores(stores)
      const existing = storeConfig.reduce<Record<number, StoreConfig>>(
        (acc, s) => { acc[s.storeId] = s; return acc }, {}
      )
      setStoreConfig(stores.map((s) => {
        const prev      = existing[s.storeId]
        const isShopify = s.storeName === 'Garvin Industries, LLC' ||
          s.marketplaceName?.toLowerCase().includes('shopify')
        return {
          storeId: s.storeId, storeName: s.storeName,
          marketplaceName: s.marketplaceName ?? '',
          channel: prev?.channel ?? (isShopify ? 'shopify' : 'turn5'),
          enabled: prev?.enabled ?? isShopify,
        }
      }))
    } finally { setLoadingStores(false) }
  }

  async function saveConfig() {
    setSavingConfig(true)
    setConfigMessage('')
    const { error } = await supabase.from('app_settings').upsert(
      { key: 'shipstation_stores', value: storeConfig as any, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
    if (error) setConfigMessage(`Save failed: ${error.message}`)
    else { setConfigMessage('Configuration saved.'); setSetupOpen(false) }
    setSavingConfig(false)
  }

  // ── Sync ────────────────────────────────────────────────────────────────────

  async function syncOrders() {
    setSyncing(true)
    setSyncMessage('')
    setAllocated(false)
    setAllocStatuses({})
    try {
      const res  = await fetch('/api/shipstation/sync', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { setSyncMessage(`Sync failed: ${data.error}`); return }
      const parts = [`✓ ${data.imported} open`]
      if (data.shipped   > 0) parts.push(`${data.shipped} shipped`)
      if (data.cancelled > 0) parts.push(`${data.cancelled} cancelled`)
      if (data.backfilled > 0) parts.push(`${data.backfilled} backfilled`)
      setSyncMessage(parts.join(' · '))
      const reloads: Promise<void>[] = [loadOrders(), loadInventory()]
      if (histLoaded) reloads.push(loadHistory())
      await Promise.all(reloads)
    } finally { setSyncing(false) }
  }

  // ── Allocation (Ship Now logic) ─────────────────────────────────────────────

  function runAllocation() {
    // Clone on-hand stock
    const stock: Record<string, number> = {}
    for (const inv of inventory) stock[inv.sku_id] = inv.qty_on_hand

    // Process oldest-first
    const sorted = [...orders].sort(
      (a, b) => new Date(a.order_date ?? 0).getTime() - new Date(b.order_date ?? 0).getTime()
    )

    const statuses: Record<string, AllocStatus> = {}

    for (const order of sorted) {
      const matchedLines = order.order_lines.filter((l) => l.sku_id)
      if (matchedLines.length === 0) { statuses[order.id] = 'unmatched'; continue }

      let readyCount = 0
      for (const line of matchedLines) {
        const avail = stock[line.sku_id!] ?? 0
        if (avail >= line.qty) readyCount++
      }

      if (readyCount === matchedLines.length) {
        statuses[order.id] = 'ready'
        // Deduct allocated stock so later orders can't use it
        for (const line of matchedLines) {
          stock[line.sku_id!] = (stock[line.sku_id!] ?? 0) - line.qty
        }
      } else if (readyCount > 0) {
        statuses[order.id] = 'partial'
      } else {
        statuses[order.id] = 'build_needed'
      }
    }

    setAllocStatuses(statuses)
    setAllocated(true)
  }

  // ── Selection helpers ───────────────────────────────────────────────────────

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (selectedIds.size === filtered.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(filtered.map((o) => o.id)))
  }

  // Auto-select all orders that share SKUs with the oldest unallocated order
  function autoBatch() {
    const oldest = [...orders]
      .filter((o) => allocStatuses[o.id] !== 'ready')
      .sort((a, b) => new Date(a.order_date ?? 0).getTime() - new Date(b.order_date ?? 0).getTime())[0]
    if (!oldest) return

    const batchSkus = new Set(
      oldest.order_lines.filter((l) => l.sku_id).map((l) => l.sku_id!)
    )
    const batch = orders.filter((o) =>
      o.order_lines.some((l) => l.sku_id && batchSkus.has(l.sku_id))
    )
    setSelectedIds(new Set(batch.map((o) => o.id)))
  }

  // ── Create Batch from selected orders ──────────────────────────────────────

  function sendToBatch() {
    const selected = orders.filter((o) => selectedIds.has(o.id))

    // Build the set of SKUs already present in any active batch (draft → at_powder)
    const activeBatchIds = new Set(activeBatches.map((b) => b.id))
    const skusInActiveBatches = new Set(
      batchLines
        .filter((bl) => activeBatchIds.has(bl.batch_id))
        .map((bl) => bl.sku_id)
    )

    const demand: Record<string, number> = {}
    const skipped = new Set<string>()

    for (const order of selected) {
      for (const line of order.order_lines) {
        if (!line.sku_id) continue
        if (skusInActiveBatches.has(line.sku_id)) {
          skipped.add(line.sku_id)
          continue
        }
        demand[line.sku_id] = (demand[line.sku_id] ?? 0) + line.qty
      }
    }

    if (Object.keys(demand).length === 0) {
      alert('All SKUs from the selected orders are already in an active build batch — nothing to add.')
      return
    }

    if (skipped.size > 0) {
      const skippedList = Array.from(skipped).join(', ')
      const ok = window.confirm(
        `${skipped.size} SKU${skipped.size !== 1 ? 's' : ''} already exist in an active build batch and will be skipped:\n\n${skippedList}\n\nContinue with the remaining ${Object.keys(demand).length} SKU${Object.keys(demand).length !== 1 ? 's' : ''}?`
      )
      if (!ok) return
    }

    const rows = Object.entries(demand).map(([skuId, qty]) => ({
      skuId, qty: String(qty), skuLookup: skuId,
    }))
    sessionStorage.setItem('garvin:batch_import', JSON.stringify(rows))
    window.location.href = '/batches'
  }

  // ── Packing slip ───────────────────────────────────────────────────────────

  function printPackingSlip(orderId: string) {
    const order = orders.find((o) => o.id === orderId)
    if (!order) return
    const lines = order.order_lines
      .map((l) => {
        const desc = l.description ?? skus.find((s) => s.id === l.sku_id)?.description ?? l.ss_sku
        return `<tr><td style="padding:8px;border-bottom:1px solid #eee">${l.ss_sku}</td><td style="padding:8px;border-bottom:1px solid #eee">${desc}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${l.qty}</td></tr>`
      })
      .join('')
    const html = `<!DOCTYPE html><html><head><title>Packing Slip #${order.order_number}</title>
  <style>body{font-family:sans-serif;padding:32px;color:#111}h1{margin:0 0 4px}p{margin:4px 0;color:#555}table{width:100%;border-collapse:collapse;margin-top:24px}th{text-align:left;padding:8px;border-bottom:2px solid #333;font-size:0.85rem;text-transform:uppercase;letter-spacing:.05em}@media print{body{padding:16px}}</style>
  </head><body>
  <h1>Packing Slip</h1>
  <p>Order #${order.order_number}</p>
  <p>${order.customer_name ?? ''}</p>
  <p>Date: ${new Date().toLocaleDateString()}</p>
  <table><thead><tr><th>SKU</th><th>Description</th><th>Qty</th></tr></thead><tbody>${lines}</tbody></table>
  <p style="margin-top:32px;font-size:0.85rem;color:#999">Garvin Industries — Thank you for your order</p>
  <script>window.onload=function(){window.print()}<\/script>
  </body></html>`
    const w = window.open('', '_blank')
    if (w) { w.document.write(html); w.document.close() }
  }

  // ── Note editing ───────────────────────────────────────────────────────────

  async function saveNote(orderId: string, text: string) {
    const val = text.trim() || null
    await supabase.from('orders').update({ notes: val }).eq('id', orderId)
    setOrders((prev) => prev.map((o) => o.id === orderId ? { ...o, notes: val } : o))
  }

  // ── Mark Shipped ───────────────────────────────────────────────────────────

  async function markShipped(orderId: string) {
    await supabase.from('orders').update({
      status: 'shipped',
      shipped_at: new Date().toISOString(),
    }).eq('id', orderId)
    // Deduct from sku_inventory for each matched line
    const order = orders.find((o) => o.id === orderId)
    if (order) {
      for (const line of order.order_lines) {
        if (!line.sku_id) continue
        const inv = inventory.find((i) => i.sku_id === line.sku_id)
        const current = inv?.qty_on_hand ?? 0
        await supabase.from('sku_inventory').update({ qty_on_hand: Math.max(0, current - line.qty) }).eq('sku_id', line.sku_id)
      }
    }
    setShippingOrderId(null)
    await Promise.all([loadOrders(), loadInventory()])
  }

  async function combineAndShip() {
    const [idA, idB] = [...selectedIds]
    const primary   = orders.find((o) => o.id === combinePrimary)!
    const secondary = orders.find((o) => o.id === (combinePrimary === idA ? idB : idA))!
    if (!primary || !secondary) return
    setCombineSaving(true)

    // Move secondary's lines to primary
    await supabase.from('order_lines').update({ order_id: primary.id }).eq('order_id', secondary.id)

    // Cancel secondary with a note
    await supabase.from('orders').update({
      status: 'cancelled',
      notes: `Combined into PO ${primary.order_number}`,
    }).eq('id', secondary.id)

    // Ship primary with combined shipping cost
    const shippingN = parseFloat(combineShipping) || 0
    await supabase.from('orders').update({
      status: 'shipped',
      shipped_at: new Date().toISOString(),
      shipping_cost: shippingN > 0 ? shippingN : null,
    }).eq('id', primary.id)

    // Deduct inventory for ALL lines (both orders combined)
    const allLines = [...primary.order_lines, ...secondary.order_lines]
    for (const line of allLines) {
      if (!line.sku_id) continue
      const inv = inventory.find((i) => i.sku_id === line.sku_id)
      const current = inv?.qty_on_hand ?? 0
      await supabase.from('sku_inventory').update({ qty_on_hand: Math.max(0, current - line.qty) }).eq('sku_id', line.sku_id)
    }

    setCombineOpen(false)
    setCombinePrimary('')
    setCombineShipping('')
    setCombineSaving(false)
    setSelectedIds(new Set())
    await Promise.all([loadOrders(), loadInventory()])
  }

  async function saveHistShipping(orderId: string) {
    const cost = histEditCost.trim() !== '' ? parseFloat(histEditCost) : null
    const date = histEditDate ? new Date(histEditDate + 'T12:00:00').toISOString() : null
    const update: Record<string, unknown> = {}
    if (cost !== null) update.shipping_cost = cost
    if (date) update.shipped_at = date
    await supabase.from('orders').update(update).eq('id', orderId)
    setHistEditId(null)
    setHistEditCost('')
    setHistEditDate('')
    await loadHistory()
  }

  // ── History loading ─────────────────────────────────────────────────────────

  async function loadHistory() {
    setHistLoading(true)
    setHistError(null)
    try {
      const [ordersRes, skusRes, batchLinesRes, batchesRes, powderRes] = await Promise.all([
        supabase
          .from('orders')
          .select('id, order_number, channel, customer_name, order_date, shipped_at, shipping_cost, status, notes, order_lines(id, sku_id, ss_sku, description, qty, unit_price)')
          .eq('status', 'shipped')
          .order('shipped_at', { ascending: false }),
        supabase.from('skus').select('id, description, bolt_kit_cost, packaging_cost, labor_cost_per_unit, setup_complete'),
        supabase.from('build_batch_lines').select('batch_id, sku_id, qty, mat_cost_snapshot'),
        supabase.from('build_batches').select('id, name, status, completed_at, powder_batch_id'),
        supabase.from('powder_batches').select('id, batch_name, total_cost, status'),
      ])
      if (ordersRes.error) throw new Error(ordersRes.error.message)
      if (skusRes.error) throw new Error(skusRes.error.message)
      setHistOrders((ordersRes.data ?? []) as Order[])
      setHistSkus((skusRes.data ?? []) as HistorySKU[])
      setHistBatchLines((batchLinesRes.data ?? []) as HistoryBatchLine[])
      setHistBatches((batchesRes.data ?? []) as HistoryBatch[])
      setHistPowderBatches((powderRes.data ?? []) as PowderBatch[])
      setHistLoaded(true)
    } catch (e) {
      setHistError(e instanceof Error ? e.message : 'Failed to load history')
    } finally {
      setHistLoading(false)
    }
  }

  function toggleHistory() {
    setHistOpen((v) => {
      if (!v && !histLoaded) void loadHistory()
      return !v
    })
  }

  // ── Derived data ─────────────────────────────────────────────────────────────

  // Date-sorted base (used as tiebreaker for status sort too)
  const dateSorted = useMemo(() =>
    [...orders].sort((a, b) => {
      const ta = new Date(a.order_date ?? 0).getTime()
      const tb = new Date(b.order_date ?? 0).getTime()
      return sortDir === 'asc' ? ta - tb : tb - ta
    }),
    [orders, sortDir]
  )

  const lastSynced = orders.reduce<string | null>((max, o) => {
    if (!o.synced_at) return max
    return !max || o.synced_at > max ? o.synced_at : max
  }, null)

  const shopifyCount = orders.filter((o) => o.channel === 'shopify').length
  const turn5Count   = orders.filter((o) => o.channel === 'turn5').length

  // Demand aggregation across all open orders
  const demandMap: Record<string, { sku_id: string; description: string; qty: number; orderCount: number }> = {}
  for (const order of orders) {
    const seen = new Set<string>()
    for (const line of order.order_lines) {
      if (!line.sku_id) continue
      if (!demandMap[line.sku_id]) {
        const sku = skus.find((s) => s.id === line.sku_id)
        demandMap[line.sku_id] = { sku_id: line.sku_id, description: sku?.description ?? line.description ?? '', qty: 0, orderCount: 0 }
      }
      demandMap[line.sku_id].qty += line.qty
      if (!seen.has(line.sku_id)) { demandMap[line.sku_id].orderCount++; seen.add(line.sku_id) }
    }
  }
  const demandRows = Object.values(demandMap).sort((a, b) => b.qty - a.qty)

  const readyCount     = Object.values(allocStatuses).filter((s) => s === 'ready').length
  const buildCount     = Object.values(allocStatuses).filter((s) => s === 'build_needed').length

  // Map sku_id → most relevant active batch status
  const skuBatchStatus = useMemo(() => {
    const map: Record<string, { batchName: string; status: string; batchId: string }> = {}
    const STATUS_PRIORITY: Record<string, number> = { in_progress: 3, at_powder: 2, planned: 1 }
    for (const line of batchLines) {
      const batch = activeBatches.find((b) => b.id === line.batch_id)
      if (!batch) continue
      const existing = map[line.sku_id]
      const priority = STATUS_PRIORITY[batch.status] ?? 0
      const existingPriority = existing ? (STATUS_PRIORITY[existing.status] ?? 0) : -1
      if (priority > existingPriority) {
        map[line.sku_id] = { batchName: batch.name, status: batch.status, batchId: batch.id }
      }
    }
    return map
  }, [batchLines, activeBatches])

  const BATCH_STATUS_STYLE: Record<string, { label: string; bg: string; color: string }> = {
    draft:       { label: 'Draft Batch', bg: 'rgba(100,116,139,0.2)', color: '#94a3b8' },
    planned:     { label: 'Planned',     bg: 'rgba(100,116,139,0.2)', color: '#94a3b8' },
    in_progress: { label: 'In Build',    bg: 'rgba(234,179,8,0.2)',   color: '#facc15' },
    at_powder:   { label: 'At Powder',   bg: 'rgba(167,139,250,0.2)', color: '#a78bfa' },
  }

  const STATUS_PRIORITY: Record<string, number> = { in_progress: 3, at_powder: 2, planned: 1 }

  // Status column sort: higher = more actionable / further along
  const STATUS_SORT_PRIORITY: Record<string, number> = {
    ready: 6, at_powder: 5, in_progress: 4, planned: 3, partial: 2, build_needed: 1, unmatched: 0,
  }

  function getStatusSortKey(order: Order): number {
    const alloc = allocStatuses[order.id]
    if (alloc === 'ready') return STATUS_SORT_PRIORITY.ready
    const prodStatuses = order.order_lines
      .filter((l) => l.sku_id && skuBatchStatus[l.sku_id])
      .map((l) => skuBatchStatus[l.sku_id!].status)
    if (prodStatuses.includes('at_powder'))   return STATUS_SORT_PRIORITY.at_powder
    if (prodStatuses.includes('in_progress')) return STATUS_SORT_PRIORITY.in_progress
    if (prodStatuses.includes('planned'))     return STATUS_SORT_PRIORITY.planned
    if (alloc === 'partial')      return STATUS_SORT_PRIORITY.partial
    if (alloc === 'build_needed') return STATUS_SORT_PRIORITY.build_needed
    return STATUS_SORT_PRIORITY.unmatched
  }

  const sorted = useMemo(() => {
    if (sortField !== 'status') return dateSorted
    return [...dateSorted].sort((a, b) => {
      const diff = getStatusSortKey(b) - getStatusSortKey(a)
      return sortDir === 'asc' ? -diff : diff
    })
  }, [dateSorted, sortField, sortDir, allocStatuses, skuBatchStatus])

  const filtered = useMemo(() => {
    if (channelFilter === 'ready') return sorted.filter((o) => allocStatuses[o.id] === 'ready')
    return sorted.filter((o) => channelFilter === 'all' || o.channel === channelFilter)
  }, [sorted, channelFilter, allocStatuses])

  // Group-by-SKU data (depends on filtered)
  const skuGroups: Record<string, { sku_id: string; description: string; orders: Array<{ order: Order; qty: number }> }> = {}
  for (const order of filtered) {
    for (const line of order.order_lines) {
      if (!line.sku_id) continue
      if (!skuGroups[line.sku_id]) {
        const sku = skus.find((s) => s.id === line.sku_id)
        skuGroups[line.sku_id] = { sku_id: line.sku_id, description: sku?.description ?? '', orders: [] }
      }
      skuGroups[line.sku_id].orders.push({ order, qty: line.qty })
    }
  }
  const skuGroupList = Object.values(skuGroups).sort((a, b) => {
    const qa = a.orders.reduce((s, r) => s + r.qty, 0)
    const qb = b.orders.reduce((s, r) => s + r.qty, 0)
    return qb - qa
  })

  // ── History derived ──────────────────────────────────────────────────────────

  const histSkuMap = useMemo(() => {
    const m = new Map<string, HistorySKU>()
    for (const s of histSkus) m.set(s.id, s)
    return m
  }, [histSkus])

  const histPowderMap = useMemo(() => {
    const m = new Map<string, PowderBatch>()
    for (const p of histPowderBatches) m.set(p.id, p)
    return m
  }, [histPowderBatches])

  const histMonthOptions = useMemo(() => {
    const keys = new Set<string>()
    for (const o of histOrders) {
      const d = o.shipped_at ?? o.order_date
      if (d) keys.add(histFmtMonthKey(d))
    }
    return Array.from(keys).sort((a, b) => b.localeCompare(a))
      .map((k) => ({ key: k, label: histFmtMonthLabel(k) }))
  }, [histOrders])

  const histChannels = useMemo(() => {
    const s = new Set<string>()
    for (const o of histOrders) if (o.channel) s.add(o.channel)
    return Array.from(s).sort()
  }, [histOrders])

  const histFiltered = useMemo(() => {
    return histOrders.filter((o) => {
      if (histChannelFilter !== 'all' && o.channel !== histChannelFilter) return false
      if (histMonthFilter !== 'all') {
        const d = o.shipped_at ?? o.order_date
        if (!d || histFmtMonthKey(d) !== histMonthFilter) return false
      }
      if (histSearch.trim()) {
        const q = histSearch.toLowerCase()
        if (!o.order_number.toLowerCase().includes(q) && !(o.customer_name?.toLowerCase().includes(q) ?? false))
          return false
      }
      return true
    })
  }, [histOrders, histChannelFilter, histMonthFilter, histSearch])

  const histCostsMap = useMemo(() => {
    const m = new Map<string, CostBreakdown>()
    for (const o of histFiltered)
      m.set(o.id, calcOrderCosts(o, histSkuMap, histBatchLines, histBatches, histPowderMap))
    return m
  }, [histFiltered, histSkuMap, histBatchLines, histBatches, histPowderMap])

  const histStats = useMemo(() => {
    let totalRevenue = 0, hasRevenue = false
    let totalShipping = 0, hasShipping = false
    for (const c of histCostsMap.values()) {
      if (c.revenue != null) { totalRevenue += c.revenue; hasRevenue = true }
      if (c.shipping != null) { totalShipping += c.shipping; hasShipping = true }
    }
    const orderCount = histFiltered.length
    return {
      totalRevenue: hasRevenue ? totalRevenue : null,
      orderCount,
      avgOrderValue: hasRevenue && orderCount > 0 ? totalRevenue / orderCount : null,
      totalShipping: hasShipping ? totalShipping : null,
    }
  }, [histFiltered, histCostsMap])

  const histTotals = useMemo(() => {
    let revenue = 0, shipping = 0, matCost = 0, boltKit = 0, packaging = 0, labor = 0, totalCOGS = 0, grossMargin = 0
    let hasRevenue = false, hasShipping = false, hasMat = false, hasBolt = false, hasPkg = false, hasLabor = false, hasCOGS = false, hasMargin = false
    for (const c of histCostsMap.values()) {
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
  }, [histCostsMap])

  const histSkuPerf = useMemo(
    () => aggregateSkuPerf(histFiltered, histSkuMap, histBatchLines, histBatches, histPowderMap),
    [histFiltered, histSkuMap, histBatchLines, histBatches, histPowderMap]
  )

  const histMonthTrend = useMemo(
    () => buildMonthTrend(histOrders, histSkuMap, histBatchLines, histBatches, histPowderMap),
    [histOrders, histSkuMap, histBatchLines, histBatches, histPowderMap]
  )

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Orders</h1>
          <div className="page-subtitle">
            Open orders from ShipStation. Allocate stock, batch by SKU, and send directly to the Build Planner.
          </div>
        </div>
      </div>

      {/* ── Auto-allocate flash message ──────────────────────────────────────── */}
      {autoMessage && (
        <div style={{
          padding: '12px 20px',
          background: 'rgba(34,197,94,0.12)',
          border: '1px solid rgba(34,197,94,0.35)',
          borderRadius: 10,
          fontSize: '0.9rem',
          color: 'var(--success)',
          fontWeight: 600,
        }}>
          {autoMessage}
        </div>
      )}

      {/* ── Ready to Ship banner ─────────────────────────────────────────────── */}
      {allocated && readyCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
          padding: '14px 20px',
          background: 'rgba(34,197,94,0.12)',
          border: '1px solid rgba(34,197,94,0.35)',
          borderRadius: 10,
        }}>
          <div style={{ fontSize: '1.6rem' }}>📦</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: '1.05rem', color: 'var(--success)' }}>
              {readyCount} order{readyCount !== 1 ? 's' : ''} ready to ship
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-2)', marginTop: 2 }}>
              All items are in stock. Look for the 🟢 label on each order below.
            </div>
          </div>
          {buildCount > 0 && (
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--danger)' }}>
                {buildCount} need a build
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>insufficient inventory</div>
            </div>
          )}
        </div>
      )}

      {/* ── Sync + filter bar ────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={syncOrders} disabled={syncing} style={{ minWidth: 190 }}>
              {syncing ? 'Syncing…' : '↻ Sync from ShipStation'}
            </button>

            <button
              className="btn btn-secondary"
              onClick={runAllocation}
              title="Allocate current inventory to orders oldest-first and show what can ship now"
            >
              🚢 Allocate Stock
            </button>

            {lastSynced && (
              <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                Last synced: {new Date(lastSynced).toLocaleString()}
              </span>
            )}

            {allocated && (
              <span style={{ fontSize: '0.82rem', color: 'var(--muted)', marginLeft: 4 }}>
                <span style={{ color: 'var(--success)' }}>🟢 {readyCount} ready</span>
                {' · '}
                <span style={{ color: 'var(--danger)' }}>🔴 {buildCount} need build</span>
              </span>
            )}

            {/* Channel filter pills */}
            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
              {([
                { key: 'all',     label: 'All Open',  count: orders.length },
                { key: 'shopify', label: 'Shopify',   count: shopifyCount },
                { key: 'turn5',   label: 'Turn5',     count: turn5Count },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setChannelFilter(tab.key)}
                  style={{
                    background: channelFilter === tab.key ? 'var(--accent)' : 'var(--panel-2)',
                    border: `1px solid ${channelFilter === tab.key ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 20, padding: '4px 14px',
                    fontSize: '0.82rem', fontWeight: 600,
                    color: channelFilter === tab.key ? '#fff' : 'var(--text-2)',
                    cursor: 'pointer',
                  }}
                >
                  {tab.label} ({tab.count})
                </button>
              ))}
              {allocated && (
                <button
                  onClick={() => setChannelFilter(channelFilter === 'ready' ? 'all' : 'ready')}
                  style={{
                    background: channelFilter === 'ready' ? 'var(--success)' : 'var(--panel-2)',
                    border: `1px solid ${channelFilter === 'ready' ? 'var(--success)' : 'var(--border)'}`,
                    borderRadius: 20, padding: '4px 14px',
                    fontSize: '0.82rem', fontWeight: 600,
                    color: channelFilter === 'ready' ? '#fff' : 'var(--text-2)',
                    cursor: 'pointer',
                  }}
                >
                  🟢 Ready ({readyCount})
                </button>
              )}
            </div>
          </div>

          {syncMessage && (
            <div className={syncMessage.startsWith('✓') ? 'message' : 'warning-box'} style={{ marginTop: 10 }}>
              {syncMessage}
            </div>
          )}
        </div>
      </section>

      {/* ── Orders table ─────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 className="card-title">Open Orders</h2>
            <div className="card-subtitle">
              {filtered.length} order{filtered.length !== 1 ? 's' : ''}
              {selectedIds.size > 0 && ` · ${selectedIds.size} selected`}
            </div>
          </div>

          {/* View toggle + group toggle */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['by_order', 'by_sku'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={viewMode === mode ? 'btn btn-primary' : 'btn btn-secondary'}
                style={{ fontSize: '0.78rem', padding: '4px 12px', height: 30 }}
              >
                {mode === 'by_order' ? 'By Order' : 'By SKU'}
              </button>
            ))}
            {viewMode === 'by_order' && (
              <button
                onClick={() => setGroupByCategory((v) => !v)}
                className={groupByCategory ? 'btn btn-primary' : 'btn btn-secondary'}
                style={{ fontSize: '0.78rem', padding: '4px 12px', height: 30 }}
              >
                🏷 Group by Category
              </button>
            )}
          </div>
        </div>

        {/* Action bar (shown when items selected) */}
        {selectedIds.size > 0 && (
          <div style={{ padding: '10px 20px', background: 'var(--accent-soft)', borderBottom: '1px solid var(--accent-border)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--accent-text)' }}>
              {selectedIds.size} order{selectedIds.size !== 1 ? 's' : ''} selected
            </span>
            <button className="btn btn-primary" style={{ height: 30, fontSize: '0.8rem' }} onClick={sendToBatch}>
              ⚡ Create Batch →
            </button>
            {selectedIds.size === 2 && (() => {
              const [idA, idB] = [...selectedIds]
              const a = orders.find((o) => o.id === idA)
              const b = orders.find((o) => o.id === idB)
              if (!a || !b) return null
              return (
                <button className="btn btn-primary"
                  style={{ height: 30, fontSize: '0.8rem', background: 'var(--success)', borderColor: 'var(--success)' }}
                  onClick={() => { setCombineOpen(true); setCombinePrimary(idA) }}>
                  🔗 Combine & Ship (PO {a.order_number} + {b.order_number})
                </button>
              )
            })()}
            <button className="btn btn-secondary" style={{ height: 30, fontSize: '0.8rem' }} onClick={() => setSelectedIds(new Set())}>
              Clear Selection
            </button>
          </div>
        )}

        <div className="card-body">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              {orders.length === 0
                ? 'No open orders yet. Click "Sync from ShipStation" to import.'
                : 'No orders match this filter.'}
            </div>
          ) : viewMode === 'by_order' ? (
            <>
              {/* Auto-batch helper */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-secondary" style={{ height: 28, fontSize: '0.78rem' }} onClick={autoBatch}>
                  ⚡ Auto-Batch (oldest order + shared SKUs)
                </button>
                <span style={{ fontSize: '0.76rem', color: 'var(--muted)' }}>
                  Selects all orders that share SKUs with the oldest open order — fastest way to plan a build run.
                </span>
              </div>

              {/* ── Ship modal ─────────────────────────────────────────────── */}
              {shippingOrderId && (() => {
                const order = orders.find((o) => o.id === shippingOrderId)
                return (
                  <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}
                    onClick={() => setShippingOrderId(null)}>
                    <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24, width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
                      onClick={(e) => e.stopPropagation()}>
                      <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: 4 }}>Mark as Shipped</div>
                      <div style={{ color: 'var(--text-2)', fontSize: '0.85rem', marginBottom: 12 }}>
                        Order {order?.order_number} · {order?.customer_name ?? 'Unknown'}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 20 }}>
                        This will mark the order as shipped and deduct SKU quantities from inventory. Shipping cost will be pulled from ShipStation on next sync.
                      </div>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button className="btn btn-secondary" style={{ height: 32 }} onClick={() => setShippingOrderId(null)}>Cancel</button>
                        <button className="btn btn-secondary" style={{ height: 32 }} onClick={() => printPackingSlip(shippingOrderId)}>
                          🖨 Print Slip
                        </button>
                        <button className="btn btn-primary" style={{ height: 32, background: 'var(--success)', borderColor: 'var(--success)' }}
                          onClick={() => markShipped(shippingOrderId)}>
                          ✓ Confirm Ship
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* ── Combine & Ship modal ───────────────────────────────────── */}
              {combineOpen && (() => {
                const [idA, idB] = [...selectedIds]
                const orderA = orders.find((o) => o.id === idA)!
                const orderB = orders.find((o) => o.id === idB)!
                const primary   = combinePrimary === idA ? orderA : orderB
                const secondary = combinePrimary === idA ? orderB : orderA
                const allLines  = [...(primary?.order_lines ?? []), ...(secondary?.order_lines ?? [])]
                return (
                  <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}
                    onClick={() => setCombineOpen(false)}>
                    <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 24, width: 480, maxWidth: '95vw', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
                      onClick={(e) => e.stopPropagation()}>
                      <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: 4 }}>Combine & Ship</div>
                      <div style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: 16 }}>
                        These two orders will be merged into one shipment. The secondary order will be cancelled.
                      </div>

                      {/* Pick primary PO */}
                      <div style={{ marginBottom: 16 }}>
                        <label className="label">Keep this PO number (primary)</label>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {[orderA, orderB].map((o) => (
                            <button key={o.id} type="button"
                              className={`btn ${combinePrimary === o.id ? 'btn-primary' : 'btn-secondary'}`}
                              style={{ flex: 1, fontSize: '0.85rem' }}
                              onClick={() => setCombinePrimary(o.id)}>
                              PO {o.order_number}
                              <span style={{ display: 'block', fontSize: '0.72rem', opacity: 0.8 }}>{o.customer_name ?? ''}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Combined line items preview */}
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Combined Line Items</div>
                        {allLines.map((l) => (
                          <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.83rem', padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                            <span>
                              <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.ss_sku ?? l.sku_id ?? '—'}</span>
                              <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: '0.75rem' }}>{l.description ?? ''}</span>
                            </span>
                            <span style={{ color: 'var(--muted)' }}>× {l.qty}</span>
                          </div>
                        ))}
                      </div>

                      {/* Shipping cost */}
                      <div style={{ marginBottom: 20 }}>
                        <label className="label">Combined Shipping Cost ($)</label>
                        <input className="field" type="number" step="0.01" min="0" placeholder="0.00"
                          value={combineShipping} onChange={(e) => setCombineShipping(e.target.value)} autoFocus />
                        <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 4 }}>
                          Leave blank — shipping cost will sync from ShipStation automatically.
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button className="btn btn-secondary" onClick={() => setCombineOpen(false)}>Cancel</button>
                        <button className="btn btn-primary"
                          style={{ background: 'var(--success)', borderColor: 'var(--success)' }}
                          disabled={combineSaving}
                          onClick={() => void combineAndShip()}>
                          {combineSaving ? 'Combining…' : `✓ Combine into PO ${primary?.order_number} & Ship`}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })()}

              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          checked={selectedIds.size === filtered.length && filtered.length > 0}
                          onChange={toggleAll}
                          style={{ cursor: 'pointer' }}
                        />
                      </th>
                      <th style={{ whiteSpace: 'nowrap' }}>
                        {/* Expand-all toggle for multi-SKU orders */}
                        {(() => {
                          const multiSkuOrders = filtered.filter((o) => o.order_lines.length > 1)
                          const allExpanded = multiSkuOrders.length > 0 && multiSkuOrders.every((o) => expandedIds.has(o.id))
                          if (multiSkuOrders.length === 0) return 'Order #'
                          return (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <button
                                type="button"
                                onClick={() => {
                                  if (allExpanded) {
                                    setExpandedIds(new Set())
                                  } else {
                                    setExpandedIds(new Set(multiSkuOrders.map((o) => o.id)))
                                  }
                                }}
                                title={allExpanded ? 'Collapse all' : 'Expand all multi-SKU orders'}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', fontSize: '1rem', color: 'var(--accent)', lineHeight: 1 }}
                              >
                                {allExpanded ? '▼' : '▶'}
                              </button>
                              Order #
                            </span>
                          )
                        })()}
                      </th>
                      <th
                        style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                        onClick={() => {
                          if (sortField === 'date') setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
                          else { setSortField('date'); setSortDir('asc') }
                        }}
                      >
                        Date {sortField === 'date' ? (sortDir === 'asc' ? '↑' : '↓') : <span style={{ color: 'var(--muted)', opacity: 0.4 }}>↕</span>}
                      </th>
                      <th>SKU</th>
                      <th style={{ textAlign: 'center' }}>Qty</th>
                      <th>Customer</th>
                      <th
                        style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                        onClick={() => {
                          if (sortField === 'status') setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
                          else { setSortField('status'); setSortDir('desc') }
                        }}
                      >
                        Status {sortField === 'status' ? (sortDir === 'desc' ? '↑' : '↓') : <span style={{ color: 'var(--muted)', opacity: 0.4 }}>↕</span>}
                      </th>
                      <th style={{ minWidth: 180 }}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      // Build rows list, optionally with category group headers
                      const rows: Array<
                        | { type: 'group'; label: string }
                        | { type: 'order'; order: Order }
                        | { type: 'line'; order: Order; line: OrderLine }
                      > = []
                      if (groupByCategory) {
                        // Explode all order lines into per-SKU rows, grouped by SKU category
                        const byCategory: Record<string, Array<{ order: Order; line: OrderLine }>> = {}
                        for (const cat of CATEGORY_ORDER) byCategory[cat] = []
                        for (const order of filtered) {
                          for (const line of order.order_lines) {
                            const cat = lineCategory(line, skus)
                            byCategory[cat].push({ order, line })
                          }
                        }
                        for (const cat of CATEGORY_ORDER) {
                          if (byCategory[cat].length === 0) continue
                          rows.push({ type: 'group', label: cat })
                          for (const item of byCategory[cat]) rows.push({ type: 'line', order: item.order, line: item.line })
                        }
                      } else {
                        for (const order of filtered) rows.push({ type: 'order', order })
                      }

                      const colSpan = 8

                      return rows.map((row, idx) => {
                        if (row.type === 'group') {
                          return (
                            <tr key={`group-${row.label}`}>
                              <td colSpan={colSpan} style={{
                                background: 'var(--panel-2)', color: 'var(--accent)',
                                fontWeight: 800, fontSize: '0.78rem', letterSpacing: '0.1em',
                                textTransform: 'uppercase', padding: '6px 14px',
                                borderTop: idx > 0 ? '2px solid var(--border)' : undefined,
                              }}>
                                {row.label}
                              </td>
                            </tr>
                          )
                        }

                        // ── Per-SKU line row (group-by-category exploded view) ──
                        if (row.type === 'line') {
                          const { order, line } = row
                          const chStyle     = CH_STYLE[order.channel] ?? CH_STYLE.shopify
                          const days        = daysSince(order.order_date)
                          const lineBatch   = line.sku_id ? skuBatchStatus[line.sku_id] : null
                          const lineOnHand  = line.sku_id ? (inventory.find((i) => i.sku_id === line.sku_id)?.qty_on_hand ?? 0) : 0
                          const notSetup    = line.sku_id ? !skus.find((s) => s.id === line.sku_id)?.setup_complete : false
                          return (
                            <tr key={`${order.id}-${line.id}`}>
                              <td />
                              <td>
                                <span style={{ fontWeight: 700, marginRight: 6 }}>{order.order_number}</span>
                                <span style={{ background: chStyle.bg, color: chStyle.text, borderRadius: 12, padding: '1px 7px', fontSize: '0.7rem', fontWeight: 700 }}>
                                  {order.channel === 'shopify' ? 'Shopify' : 'Turn5'}
                                </span>
                              </td>
                              <td style={{ whiteSpace: 'nowrap', fontSize: '0.83rem' }}>
                                {formatDate(order.order_date)}
                                {days !== null && (
                                  <span style={{ marginLeft: 6, fontSize: '0.72rem', color: days > 14 ? 'var(--danger)' : days > 7 ? 'var(--warning)' : 'var(--muted)', fontWeight: days > 7 ? 700 : 400 }}>
                                    {days}d
                                  </span>
                                )}
                              </td>
                              <td style={{ fontFamily: 'monospace', fontSize: '0.83rem', fontWeight: 600 }}>{line.ss_sku}</td>
                              <td style={{ textAlign: 'center', fontWeight: 700 }}>{line.qty}</td>
                              <td style={{ color: 'var(--text-2)' }}>{order.customer_name ?? '—'}</td>
                              <td>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                                  {lineBatch ? (
                                    <span style={{ background: BATCH_STATUS_STYLE[lineBatch.status]?.bg, color: BATCH_STATUS_STYLE[lineBatch.status]?.color, borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700 }}>
                                      {BATCH_STATUS_STYLE[lineBatch.status]?.label}
                                    </span>
                                  ) : lineOnHand >= line.qty ? (
                                    <span style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success)', borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700 }}>✓ In Stock</span>
                                  ) : !line.sku_id ? (
                                    <span style={{ color: 'var(--muted)', fontSize: '0.72rem', fontStyle: 'italic' }}>No SKU Match</span>
                                  ) : (
                                    <span style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger)', borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700 }}>🔴 Build Needed</span>
                                  )}
                                  {notSetup && (
                                    <span style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger)', borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700 }}>⚠ Setup Incomplete</span>
                                  )}
                                </div>
                              </td>
                              <td />
                            </tr>
                          )
                        }

                        const { order } = row
                        const isExpanded   = expandedIds.has(order.id)
                        const isSelected   = selectedIds.has(order.id)
                        const isMultiSku   = order.order_lines.length > 1
                        const days         = daysSince(order.order_date)
                        const status       = allocStatuses[order.id]
                        const alloc        = status ? ALLOC_STYLE[status] : null
                        const chStyle      = CH_STYLE[order.channel] ?? CH_STYLE.shopify
                        const totalQty     = order.order_lines.reduce((s, l) => s + l.qty, 0)
                        const linesWithSku    = order.order_lines.filter((l) => l.sku_id)
                        const linesNotSetup   = linesWithSku.filter((l) => !skus.find((s) => s.id === l.sku_id)?.setup_complete)
                        const linesInBatch    = linesWithSku.filter((l) => l.sku_id && skuBatchStatus[l.sku_id])
                        // A line is "covered" if it's in a batch OR has enough stock on hand
                        const linesCovered    = linesWithSku.filter((l) => {
                          if (!l.sku_id) return false
                          if (skuBatchStatus[l.sku_id]) return true
                          const onHand = inventory.find((i) => i.sku_id === l.sku_id)?.qty_on_hand ?? 0
                          return onHand >= l.qty
                        })
                        // Only flag as "needs build" if NOT in a batch AND stock is insufficient
                        const unbatchedLines  = linesWithSku.filter((l) => {
                          if (!l.sku_id || skuBatchStatus[l.sku_id]) return false
                          const onHand = inventory.find((i) => i.sku_id === l.sku_id)?.qty_on_hand ?? 0
                          return onHand < l.qty
                        })
                        const allBatched      = linesWithSku.length > 0 && linesCovered.length === linesWithSku.length
                        const someBatched     = linesInBatch.length > 0 && !allBatched
                        const orderBatchStatuses = linesInBatch.map((l) => skuBatchStatus[l.sku_id!])
                        const topBatch = orderBatchStatuses.sort((a, b) =>
                          (STATUS_PRIORITY[b.status] ?? 0) - (STATUS_PRIORITY[a.status] ?? 0)
                        )[0]

                        return (
                          <>
                            <tr
                              key={order.id}
                              style={{
                                background: isSelected
                                  ? 'var(--accent-soft)'
                                  : status === 'ready' ? (alloc?.bg ?? 'transparent') : 'transparent',
                              }}
                            >
                              {/* Checkbox */}
                              <td onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSelect(order.id)}
                                  style={{ cursor: 'pointer' }}
                                />
                              </td>

                              {/* Order # — expand arrow + channel badge */}
                              <td
                                style={{ fontWeight: 700, whiteSpace: 'nowrap' }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                  {isMultiSku && (
                                    <span
                                      style={{ fontSize: '1.1rem', cursor: 'pointer', flexShrink: 0, color: 'var(--accent)', lineHeight: 1 }}
                                      onClick={() => setExpandedIds((prev) => {
                                        const next = new Set(prev)
                                        next.has(order.id) ? next.delete(order.id) : next.add(order.id)
                                        return next
                                      })}
                                    >
                                      {isExpanded ? '▼' : '▶'}
                                    </span>
                                  )}
                                  <span>{order.order_number}</span>
                                  <span style={{ background: chStyle.bg, color: chStyle.text, borderRadius: 10, padding: '1px 7px', fontSize: '0.68rem', fontWeight: 700, flexShrink: 0 }}>
                                    {order.channel === 'shopify' ? 'S' : 'T5'}
                                  </span>
                                </div>
                              </td>

                              {/* Date */}
                              <td style={{ whiteSpace: 'nowrap' }}>
                                <span>{formatDate(order.order_date)}</span>
                                {days !== null && (
                                  <span style={{
                                    marginLeft: 6, fontSize: '0.72rem',
                                    color: days > 14 ? 'var(--danger)' : days > 7 ? 'var(--warning)' : 'var(--muted)',
                                    fontWeight: days > 7 ? 700 : 400,
                                  }}>
                                    {days}d
                                  </span>
                                )}
                              </td>

                              {/* SKU */}
                              <td style={{ fontFamily: 'monospace', fontSize: '0.84rem' }}>
                                {isMultiSku ? (
                                  <span
                                    style={{ color: 'var(--muted)', cursor: 'pointer' }}
                                    onClick={() => setExpandedIds((prev) => {
                                      const next = new Set(prev)
                                      next.has(order.id) ? next.delete(order.id) : next.add(order.id)
                                      return next
                                    })}
                                  >
                                    {order.order_lines.length} SKUs {isExpanded ? '▼' : '▶'}
                                  </span>
                                ) : (
                                  order.order_lines[0]?.ss_sku ?? '—'
                                )}
                              </td>

                              {/* Qty */}
                              <td style={{ textAlign: 'center', fontWeight: 700 }}>{totalQty}</td>

                              {/* Customer */}
                              <td style={{ color: 'var(--text-2)' }}>
                                {order.customer_name ?? '—'}
                              </td>

                              {/* Status — production + alloc */}
                              <td>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                                  {/* Production status */}
                                  {isMultiSku && linesWithSku.length > 0 && (() => {
                                    /* Multi-SKU: show a pill per distinct status */
                                    const groups: Record<string, number> = {}
                                    for (const line of linesWithSku) {
                                      const bs = skuBatchStatus[line.sku_id!]
                                      let key: string
                                      if (bs) { key = bs.status }
                                      else {
                                        const oh = inventory.find((i) => i.sku_id === line.sku_id)?.qty_on_hand ?? 0
                                        key = oh >= line.qty ? 'in_stock' : 'needs_build'
                                      }
                                      groups[key] = (groups[key] ?? 0) + 1
                                    }
                                    const ORDER = ['at_powder', 'in_progress', 'planned', 'draft', 'in_stock', 'needs_build']
                                    const total = linesWithSku.length
                                    return ORDER.filter((s) => groups[s]).map((s) => {
                                      const cnt = groups[s]
                                      const sty = s === 'in_stock'
                                        ? { bg: 'rgba(34,197,94,0.15)', color: 'var(--success)' }
                                        : s === 'needs_build'
                                        ? { bg: 'rgba(239,68,68,0.12)', color: 'var(--danger)' }
                                        : BATCH_STATUS_STYLE[s] ?? { bg: 'rgba(100,116,139,0.2)', color: '#94a3b8' }
                                      const lbl = s === 'in_stock' ? 'In Stock'
                                        : s === 'needs_build' ? 'Needs Build'
                                        : BATCH_STATUS_STYLE[s]?.label ?? s
                                      return (
                                        <span key={s} style={{ background: sty.bg, color: sty.color, borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
                                          {cnt}/{total} {lbl}
                                        </span>
                                      )
                                    })
                                  })()}
                                  {!isMultiSku && topBatch && (
                                    /* Single-SKU order — top batch badge, clickable */
                                    <span
                                      title={topBatch.batchName}
                                      style={{
                                        background: BATCH_STATUS_STYLE[topBatch.status]?.bg,
                                        color: BATCH_STATUS_STYLE[topBatch.status]?.color,
                                        borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700,
                                        cursor: 'pointer',
                                      }}
                                      onClick={() => {
                                        sessionStorage.setItem('garvin:open_batch', topBatch.batchId)
                                        window.location.href = '/batches'
                                      }}
                                    >
                                      {BATCH_STATUS_STYLE[topBatch.status]?.label}
                                    </span>
                                  )}
                                  {/* Allocation status */}
                                  {allocated && alloc && status === 'ready' && (
                                    /* "Ready / In Stock" — always worth showing + Ship button */
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <span style={{ fontSize: '0.78rem', color: alloc.color, fontWeight: 600, whiteSpace: 'nowrap' }}>
                                        {alloc.icon} {alloc.label}
                                      </span>
                                      <button
                                        className="btn btn-primary"
                                        style={{ height: 24, fontSize: '0.72rem', padding: '0 8px', flexShrink: 0 }}
                                        onClick={(e) => { e.stopPropagation(); setShippingOrderId(order.id) }}
                                      >
                                        Ship →
                                      </button>
                                    </div>
                                  )}
                                  {allocated && alloc && status !== 'ready' && !topBatch && (
                                    /* "Build Needed" / "Partial" — only show when nothing is in a batch yet */
                                    <span style={{
                                      background: 'rgba(239,68,68,0.12)', color: 'var(--danger)',
                                      borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 600,
                                    }}>
                                      {alloc.icon} {alloc.label}
                                    </span>
                                  )}
                                  {linesNotSetup.length > 0 && (
                                    <span style={{
                                      background: 'rgba(239,68,68,0.12)', color: 'var(--danger)',
                                      borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700,
                                    }}
                                      title={linesNotSetup.map((l) => l.ss_sku).join(', ') + ' — setup incomplete'}
                                    >
                                      ⚠ Setup Incomplete
                                    </span>
                                  )}
                                </div>
                              </td>

                              {/* Inline notes */}
                              <td onClick={(e) => e.stopPropagation()}>
                                <input
                                  key={order.id}
                                  className="field"
                                  defaultValue={order.notes ?? ''}
                                  placeholder="Add note…"
                                  style={{ height: 28, fontSize: '0.78rem', padding: '0 8px', minWidth: 160 }}
                                  onBlur={(e) => {
                                    if (e.target.value !== (order.notes ?? '')) {
                                      void saveNote(order.id, e.target.value)
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                  }}
                                />
                              </td>
                            </tr>

                            {/* Expanded multi-SKU lines */}
                            {isMultiSku && isExpanded && (
                              <tr key={`${order.id}-exp`}>
                                <td colSpan={colSpan} style={{ padding: 0, background: 'var(--panel-2)' }}>
                                  <div style={{ padding: '6px 20px 10px 52px' }}>
                                    <table className="table" style={{ background: 'transparent' }}>
                                      <thead>
                                        <tr>
                                          <th>SKU</th>
                                          <th>Description</th>
                                          <th style={{ textAlign: 'center' }}>Qty</th>
                                          <th>Status</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {order.order_lines.map((line) => {
                                          const lineSkuBatch = line.sku_id ? skuBatchStatus[line.sku_id] : null
                                          const lineOnHand   = line.sku_id ? (inventory.find((i) => i.sku_id === line.sku_id)?.qty_on_hand ?? 0) : 0
                                          return (
                                            <tr key={line.id}>
                                              <td style={{ fontFamily: 'monospace', fontSize: '0.83rem', fontWeight: 600 }}>
                                                {line.ss_sku}
                                              </td>
                                              <td style={{ color: 'var(--text-2)', fontSize: '0.83rem' }}>
                                                {line.description ?? skus.find((s) => s.id === line.sku_id)?.description ?? '—'}
                                              </td>
                                              <td style={{ textAlign: 'center', fontWeight: 700 }}>{line.qty}</td>
                                              <td>
                                                {lineSkuBatch ? (
                                                  <span style={{
                                                    background: BATCH_STATUS_STYLE[lineSkuBatch.status]?.bg,
                                                    color: BATCH_STATUS_STYLE[lineSkuBatch.status]?.color,
                                                    borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700,
                                                  }}>
                                                    {BATCH_STATUS_STYLE[lineSkuBatch.status]?.label}
                                                  </span>
                                                ) : lineOnHand >= line.qty ? (
                                                  <span style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success)', borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700 }}>
                                                    ✓ In Stock ({lineOnHand})
                                                  </span>
                                                ) : lineOnHand > 0 ? (
                                                  <span style={{ background: 'rgba(234,179,8,0.15)', color: 'var(--warning)', borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700 }}>
                                                    {lineOnHand}/{line.qty} on hand
                                                  </span>
                                                ) : !line.sku_id ? (
                                                  <span style={{ color: 'var(--muted)', fontSize: '0.72rem', fontStyle: 'italic' }}>No SKU Match</span>
                                                ) : (
                                                  <span style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger)', borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700 }}>
                                                    🔴 Build Needed
                                                  </span>
                                                )}
                                                {line.sku_id && !skus.find((s) => s.id === line.sku_id)?.setup_complete && (
                                                  <span style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger)', borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700, marginLeft: 4 }}>
                                                    ⚠ Setup Incomplete
                                                  </span>
                                                )}
                                              </td>
                                            </tr>
                                          )
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        )
                      })
                    })()}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            /* ── By SKU view ─────────────────────────────────────────────────── */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {skuGroupList.map((group) => {
                const totalQty   = group.orders.reduce((s, r) => s + r.qty, 0)
                const inv        = inventory.find((i) => i.sku_id === group.sku_id)
                const onHand     = inv?.qty_on_hand ?? 0
                const groupBatch = skuBatchStatus[group.sku_id] ?? null
                const isLocked   = groupBatch !== null
                return (
                  <div key={group.sku_id} style={{ border: `1px solid ${isLocked ? 'rgba(100,116,139,0.3)' : 'var(--border)'}`, borderRadius: 8, overflow: 'hidden', opacity: isLocked ? 0.65 : 1 }}>
                    {/* SKU group header */}
                    <div style={{ background: 'var(--panel-2)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9rem' }}>{group.sku_id}</span>
                      <span style={{ color: 'var(--text-2)', fontSize: '0.84rem' }}>{group.description}</span>
                      {isLocked && (
                        <span style={{
                          background: BATCH_STATUS_STYLE[groupBatch.status]?.bg ?? 'rgba(100,116,139,0.2)',
                          color: BATCH_STATUS_STYLE[groupBatch.status]?.color ?? '#94a3b8',
                          borderRadius: 20, padding: '2px 10px', fontSize: '0.74rem', fontWeight: 700,
                        }}>
                          🔒 {BATCH_STATUS_STYLE[groupBatch.status]?.label ?? groupBatch.status} · {groupBatch.batchName}
                        </span>
                      )}
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, fontSize: '0.8rem' }}>
                        <span><strong style={{ color: 'var(--danger)' }}>{totalQty}</strong> <span style={{ color: 'var(--muted)' }}>needed</span></span>
                        <span><strong style={{ color: onHand > 0 ? 'var(--success)' : 'var(--muted)' }}>{onHand}</strong> <span style={{ color: 'var(--muted)' }}>on hand</span></span>
                        <span style={{ color: (totalQty - onHand) > 0 ? 'var(--warning)' : 'var(--success)', fontWeight: 700 }}>
                          {Math.max(0, totalQty - onHand)} to build
                        </span>
                      </div>
                    </div>

                    {/* Orders needing this SKU */}
                    <table className="table" style={{ margin: 0 }}>
                      <thead>
                        <tr>
                          <th style={{ width: 32 }}>
                            <input type="checkbox" style={{ cursor: isLocked ? 'not-allowed' : 'pointer' }}
                              disabled={isLocked}
                              checked={!isLocked && group.orders.every((r) => selectedIds.has(r.order.id))}
                              onChange={() => {
                                if (isLocked) return
                                const allSelected = group.orders.every((r) => selectedIds.has(r.order.id))
                                setSelectedIds((prev) => {
                                  const next = new Set(prev)
                                  group.orders.forEach((r) => allSelected ? next.delete(r.order.id) : next.add(r.order.id))
                                  return next
                                })
                              }}
                            />
                          </th>
                          <th>Order #</th>
                          <th>Channel</th>
                          <th>Customer</th>
                          <th>Order Date</th>
                          <th style={{ textAlign: 'center' }}>Qty</th>
                          <th>Status</th>
                          <th>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.orders.map(({ order, qty }) => {
                          const chStyle      = CH_STYLE[order.channel] ?? CH_STYLE.shopify
                          const allocStatus  = allocStatuses[order.id]
                          const alloc        = allocStatus ? ALLOC_STYLE[allocStatus] : null
                          const days         = daysSince(order.order_date)
                          // For By-SKU view, the group is already filtered to a single SKU
                          const lineSkuBatch = skuBatchStatus[group.sku_id] ?? null
                          return (
                            <tr key={order.id} style={{ background: !isLocked && selectedIds.has(order.id) ? 'var(--accent-soft)' : 'transparent' }}>
                              <td>
                                <input type="checkbox" style={{ cursor: isLocked ? 'not-allowed' : 'pointer' }}
                                  disabled={isLocked}
                                  checked={!isLocked && selectedIds.has(order.id)}
                                  onChange={() => { if (!isLocked) toggleSelect(order.id) }} />
                              </td>
                              <td style={{ fontWeight: 700 }}>{order.order_number}</td>
                              <td>
                                <span style={{ background: chStyle.bg, color: chStyle.text, borderRadius: 12, padding: '2px 9px', fontSize: '0.74rem', fontWeight: 700 }}>
                                  {order.channel === 'shopify' ? 'Shopify' : 'Turn5'}
                                </span>
                              </td>
                              <td style={{ color: 'var(--text-2)' }}>{order.customer_name ?? '—'}</td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                {formatDate(order.order_date)}
                                {days !== null && (
                                  <span style={{ marginLeft: 6, fontSize: '0.72rem', color: days > 14 ? 'var(--danger)' : days > 7 ? 'var(--warning)' : 'var(--muted)', fontWeight: days > 7 ? 700 : 400 }}>
                                    {days}d
                                  </span>
                                )}
                              </td>
                              <td style={{ textAlign: 'center', fontWeight: 700 }}>{qty}</td>
                              <td>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
                                  {lineSkuBatch && (
                                    <span style={{
                                      background: BATCH_STATUS_STYLE[lineSkuBatch.status]?.bg,
                                      color: BATCH_STATUS_STYLE[lineSkuBatch.status]?.color,
                                      borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700,
                                    }}>
                                      {BATCH_STATUS_STYLE[lineSkuBatch.status]?.label}
                                    </span>
                                  )}
                                  {allocated && alloc && !lineSkuBatch && (
                                    <span style={{ fontSize: '0.78rem', color: alloc.color, fontWeight: 600 }}>
                                      {alloc.icon} {alloc.label}
                                    </span>
                                  )}
                                  {group.sku_id && !skus.find((s) => s.id === group.sku_id)?.setup_complete && (
                                    <span style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger)', borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700 }}>
                                      ⚠ Setup Incomplete
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td style={{ maxWidth: 220, fontSize: '0.78rem', color: 'var(--warning)', fontStyle: order.notes ? 'normal' : undefined }}>
                                {order.notes ?? ''}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>

      {/* ── Demand Summary ───────────────────────────────────────────────────── */}
      {demandRows.length > 0 && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Total Demand</h2>
            <div className="card-subtitle">
              Aggregated across all {orders.length} open orders.
            </div>
          </div>
          <div className="card-body">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Description</th>
                    <th style={{ textAlign: 'center' }}>Total Qty</th>
                    <th style={{ textAlign: 'center' }}>Orders</th>
                    <th style={{ textAlign: 'center' }}>On Hand</th>
                    <th style={{ textAlign: 'center' }}>To Build</th>
                  </tr>
                </thead>
                <tbody>
                  {demandRows.map((row) => {
                    const onHand  = inventory.find((i) => i.sku_id === row.sku_id)?.qty_on_hand ?? 0
                    const toBuild = Math.max(0, row.qty - onHand)
                    return (
                      <tr key={row.sku_id}>
                        <td style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '0.85rem' }}>{row.sku_id}</td>
                        <td>{row.description}</td>
                        <td style={{ textAlign: 'center', fontWeight: 700 }}>{row.qty}</td>
                        <td style={{ textAlign: 'center', color: 'var(--muted)' }}>{row.orderCount}</td>
                        <td style={{ textAlign: 'center', color: onHand > 0 ? 'var(--success)' : 'var(--muted)', fontWeight: onHand > 0 ? 700 : 400 }}>{onHand}</td>
                        <td style={{ textAlign: 'center' }}>
                          {toBuild > 0
                            ? <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{toBuild}</span>
                            : <span style={{ color: 'var(--success)' }}>✓</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2} style={{ fontWeight: 700, color: 'var(--muted)' }}>{demandRows.length} SKUs</td>
                    <td style={{ textAlign: 'center', fontWeight: 700 }}>{demandRows.reduce((s, r) => s + r.qty, 0)}</td>
                    <td />
                    <td />
                    <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--danger)' }}>
                      {demandRows.reduce((s, r) => s + Math.max(0, r.qty - (inventory.find((i) => i.sku_id === r.sku_id)?.qty_on_hand ?? 0)), 0)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── Store Setup (moved to bottom) ────────────────────────────────────── */}
      <section className="card">
        <div
          className="card-header"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          onClick={() => setSetupOpen((v) => !v)}
        >
          <div>
            <h2 className="card-title">ShipStation Store Setup</h2>
            <div className="card-subtitle">
              {storeConfig.filter((s) => s.enabled).length > 0
                ? `${storeConfig.filter((s) => s.enabled).length} store(s) enabled — click to reconfigure`
                : 'Not configured yet — click to set up'}
            </div>
          </div>
          <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{setupOpen ? '▲ Hide' : '▼ Configure'}</span>
        </div>

        {setupOpen && (
          <div className="card-body">
            <div className="btn-row" style={{ marginBottom: 14 }}>
              <button className="btn btn-secondary" onClick={loadSSStores} disabled={loadingStores}>
                {loadingStores ? 'Loading…' : 'Load Stores from ShipStation'}
              </button>
            </div>

            {ssStores.length > 0 && (
              <div className="table-wrap" style={{ marginBottom: 14 }}>
                <table className="table">
                  <thead>
                    <tr><th>Store Name</th><th>Marketplace</th><th>Channel</th><th>Enable</th></tr>
                  </thead>
                  <tbody>
                    {storeConfig.map((s) => (
                      <tr key={s.storeId}>
                        <td style={{ fontWeight: 600 }}>{s.storeName}</td>
                        <td style={{ color: 'var(--muted)' }}>{s.marketplaceName}</td>
                        <td>
                          <select className="select" value={s.channel} style={{ width: 110 }}
                            onChange={(e) => setStoreConfig((prev) => prev.map((x) => x.storeId === s.storeId ? { ...x, channel: e.target.value } : x))}>
                            <option value="shopify">Shopify</option>
                            <option value="turn5">Turn5</option>
                            <option value="other">Other</option>
                          </select>
                        </td>
                        <td>
                          <input type="checkbox" checked={s.enabled} style={{ width: 18, height: 18, cursor: 'pointer' }}
                            onChange={(e) => setStoreConfig((prev) => prev.map((x) => x.storeId === s.storeId ? { ...x, enabled: e.target.checked } : x))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="btn-row">
              <button className="btn btn-primary" onClick={saveConfig} disabled={savingConfig || storeConfig.length === 0}>
                {savingConfig ? 'Saving…' : 'Save Configuration'}
              </button>
            </div>
            {configMessage && <div className="message" style={{ marginTop: 10 }}>{configMessage}</div>}
          </div>
        )}
      </section>

      {/* ── Order History ─────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h2 className="card-title">Order History</h2>
            <div className="card-subtitle">Shipped orders — revenue, COGS, and margin breakdown.</div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={toggleHistory}>
            {histOpen ? 'Collapse' : 'Expand'}
          </button>
        </div>

        {histOpen && (
          <div className="card-body">
            {histLoading && <div className="empty">Loading history…</div>}
            {histError && <div className="message" style={{ color: 'var(--danger)' }}>Error: {histError}</div>}

            {!histLoading && !histError && histLoaded && (
              <>
                {/* Summary stat cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
                  {[
                    { label: 'Orders Shipped',      value: String(histStats.orderCount) },
                    { label: 'Total Revenue',        value: histFmtCurrency(histStats.totalRevenue) },
                    { label: 'Total Shipping Cost',  value: histFmtCurrency(histStats.totalShipping) },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ background: 'var(--panel-2)', borderRadius: 10, padding: '16px 20px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 8 }}>{label}</div>
                      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Filters */}
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 20 }}>
                  <div>
                    <label className="label">Month</label>
                    <select className="field" value={histMonthFilter} onChange={(e) => setHistMonthFilter(e.target.value)}>
                      <option value="all">All Time</option>
                      {histMonthOptions.map((opt) => (
                        <option key={opt.key} value={opt.key}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Channel</label>
                    <select className="field" value={histChannelFilter} onChange={(e) => setHistChannelFilter(e.target.value)}>
                      <option value="all">All Channels</option>
                      {histChannels.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <label className="label">Search</label>
                    <input
                      className="field"
                      placeholder="Order # or customer name…"
                      value={histSearch}
                      onChange={(e) => setHistSearch(e.target.value)}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>

                {/* Orders table */}
                <div style={{ marginBottom: 28 }}>
                  <div style={{ fontWeight: 700, marginBottom: 10 }}>
                    Shipped Orders <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: '0.85rem' }}>({histFiltered.length})</span>
                  </div>
                  {histFiltered.length === 0 ? (
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
                          </tr>
                        </thead>
                        <tbody>
                          {histFiltered.map((order) => {
                            const costs = histCostsMap.get(order.id)!
                            const isExpanded = histExpandedRows.has(order.id)
                            const skuList = order.order_lines
                              .map((l) => {
                                const sku = l.sku_id ? histSkuMap.get(l.sku_id) : null
                                return sku?.description ?? l.description ?? l.ss_sku
                              })
                              .filter(Boolean).join(', ')
                            const marginStyle = (n: number | null): React.CSSProperties =>
                              n == null ? {} : { color: n >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }
                            return (
                              <>
                                <tr
                                  key={order.id}
                                  onClick={() => setHistExpandedRows((prev) => {
                                    const next = new Set(prev); next.has(order.id) ? next.delete(order.id) : next.add(order.id); return next
                                  })}
                                  style={{ cursor: 'pointer' }}
                                >
                                  <td style={{ fontWeight: 600, color: 'var(--accent)' }}>
                                    {isExpanded ? '▾' : '▸'} {order.order_number}
                                  </td>
                                  <td>{order.customer_name ?? '—'}</td>
                                  <td>
                                    <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 10, background: 'var(--panel-2)', color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                                      {order.channel}
                                    </span>
                                  </td>
                                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text-2)' }}>
                                    {formatDate(order.shipped_at)}
                                  </td>
                                  <td style={{ color: 'var(--text-2)', fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {skuList || '—'}
                                  </td>
                                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{histFmtCurrency(costs.revenue)}</td>
                                  <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{histFmtCurrency(costs.shipping)}</td>
                                </tr>
                                {isExpanded && (
                                  <tr key={order.id + '-exp'} style={{ background: 'var(--panel-2)' }}>
                                    <td colSpan={7} style={{ padding: '12px 16px 16px 32px' }}>
                                      {/* ── Edit shipping cost / date ── */}
                                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginBottom: 16, padding: '10px 14px', background: 'var(--panel)', borderRadius: 8, border: '1px solid var(--border)' }}>
                                        <div>
                                          <div style={{ fontSize: '0.72rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Shipping Cost</div>
                                          {histEditId === order.id ? (
                                            <input className="field" type="number" step="0.01" min="0" placeholder="0.00"
                                              value={histEditCost} onChange={(e) => setHistEditCost(e.target.value)}
                                              style={{ width: 110 }} autoFocus />
                                          ) : (
                                            <div style={{ fontWeight: 600 }}>{order.shipping_cost != null ? `$${order.shipping_cost.toFixed(2)}` : <span style={{ color: 'var(--muted)' }}>—</span>}</div>
                                          )}
                                        </div>
                                        <div>
                                          <div style={{ fontSize: '0.72rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Shipped Date</div>
                                          {histEditId === order.id ? (
                                            <input className="field" type="date"
                                              value={histEditDate} onChange={(e) => setHistEditDate(e.target.value)}
                                              style={{ width: 150 }} />
                                          ) : (
                                            <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>{order.shipped_at ? formatDate(order.shipped_at) : <span style={{ color: 'var(--warning)' }}>Not set</span>}</div>
                                          )}
                                        </div>
                                        <div style={{ display: 'flex', gap: 6 }}>
                                          {histEditId === order.id ? (
                                            <>
                                              <button className="btn btn-primary" style={{ fontSize: '0.78rem' }} onClick={() => void saveHistShipping(order.id)}>Save</button>
                                              <button className="btn btn-secondary" style={{ fontSize: '0.78rem' }} onClick={() => { setHistEditId(null); setHistEditCost(''); setHistEditDate('') }}>Cancel</button>
                                            </>
                                          ) : (
                                            <button className="btn btn-secondary" style={{ fontSize: '0.78rem' }}
                                              onClick={(e) => { e.stopPropagation(); setHistEditId(order.id); setHistEditCost(order.shipping_cost != null ? String(order.shipping_cost) : ''); setHistEditDate(order.shipped_at ? order.shipped_at.split('T')[0] : '') }}>
                                              ✏ Edit
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' }}>
                                        <thead>
                                          <tr style={{ color: 'var(--muted)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                            <th style={{ textAlign: 'left', padding: '4px 8px 6px 0', fontWeight: 600 }}>SKU</th>
                                            <th style={{ textAlign: 'left', padding: '4px 8px 6px', fontWeight: 600 }}>Description</th>
                                            <th style={{ textAlign: 'right', padding: '4px 0 6px 8px', fontWeight: 600 }}>Qty</th>
                                            <th style={{ textAlign: 'right', padding: '4px 0 6px 8px', fontWeight: 600 }}>Unit Price</th>
                                            <th style={{ textAlign: 'right', padding: '4px 0 6px 8px', fontWeight: 600 }}>Amount</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {order.order_lines.map((l) => {
                                            const sku = l.sku_id ? histSkuMap.get(l.sku_id) : null
                                            return (
                                              <tr key={l.id} style={{ borderTop: '1px solid var(--border)' }}>
                                                <td style={{ padding: '7px 8px 7px 0', fontFamily: 'monospace', fontWeight: 600 }}>{l.ss_sku ?? '—'}</td>
                                                <td style={{ padding: '7px 8px', color: 'var(--text-2)' }}>{sku?.description ?? l.description ?? '—'}</td>
                                                <td style={{ textAlign: 'right', padding: '7px 0 7px 8px' }}>{l.qty}</td>
                                                <td style={{ textAlign: 'right', padding: '7px 0 7px 8px' }}>{histFmtCurrency(l.unit_price)}</td>
                                                <td style={{ textAlign: 'right', padding: '7px 0 7px 8px', fontWeight: 600 }}>{histFmtCurrency((l.unit_price ?? 0) * l.qty)}</td>
                                              </tr>
                                            )
                                          })}
                                        </tbody>
                                      </table>
                                    </td>
                                  </tr>
                                )}
                              </>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                            <td colSpan={5} style={{ color: 'var(--text-2)' }}>Totals ({histFiltered.length} orders)</td>
                            <td style={{ textAlign: 'right' }}>{histFmtCurrency(histTotals.revenue)}</td>
                            <td style={{ textAlign: 'right' }}>{histFmtCurrency(histTotals.shipping)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>

                {/* SKU Performance */}
                <div style={{ marginBottom: 28 }}>
                  <div style={{ fontWeight: 700, marginBottom: 10 }}>SKU Performance <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: '0.85rem' }}>— aggregated across filtered orders</span></div>
                  {histSkuPerf.length === 0 ? (
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
                          {histSkuPerf.map((p) => {
                            const matPU = p.matCostTotal != null && p.unitsSold > 0 ? p.matCostTotal / p.unitsSold : null
                            const boltPU = p.boltKitTotal != null && p.unitsSold > 0 ? p.boltKitTotal / p.unitsSold : null
                            const pkgPU = p.packagingTotal != null && p.unitsSold > 0 ? p.packagingTotal / p.unitsSold : null
                            const laborPU = p.laborTotal != null && p.unitsSold > 0 ? p.laborTotal / p.unitsSold : null
                            const cogsPU = p.estCOGSTotal != null && p.unitsSold > 0 ? p.estCOGSTotal / p.unitsSold : null
                            const marginPU = p.estMarginTotal != null && p.unitsSold > 0 ? p.estMarginTotal / p.unitsSold : null
                            const mStyle = (n: number | null): React.CSSProperties => n == null ? {} : { color: n >= 0 ? 'var(--success)' : 'var(--danger)' }
                            return (
                              <tr key={p.skuId}>
                                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.skuId}</td>
                                <td>{p.description}</td>
                                <td style={{ textAlign: 'right' }}>{p.unitsSold}</td>
                                <td style={{ textAlign: 'right', fontWeight: 600 }}>{histFmtCurrency(p.revenue)}</td>
                                <td style={{ textAlign: 'right', color: 'var(--text-2)', fontStyle: 'italic' }}>{histFmtCurrency(matPU)}</td>
                                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{histFmtCurrency(boltPU)}</td>
                                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{histFmtCurrency(pkgPU)}</td>
                                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{histFmtCurrency(laborPU)}</td>
                                <td style={{ textAlign: 'right' }}>{histFmtCurrency(cogsPU)}</td>
                                <td style={{ textAlign: 'right', ...mStyle(marginPU) }}>{histFmtCurrency(marginPU)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Monthly Trend */}
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 10 }}>Monthly Trend <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: '0.85rem' }}>— last 6 months, all orders</span></div>
                  {histMonthTrend.length === 0 ? (
                    <div className="empty">No monthly data available yet.</div>
                  ) : (
                    <>
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
                            {histMonthTrend.map((t) => {
                              const mStyle = (n: number | null): React.CSSProperties => n == null ? {} : { color: n >= 0 ? 'var(--success)' : 'var(--danger)' }
                              return (
                                <tr key={t.key}>
                                  <td style={{ fontWeight: 600 }}>{t.label}</td>
                                  <td style={{ textAlign: 'right' }}>{t.orders}</td>
                                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{histFmtCurrency(t.revenue)}</td>
                                  <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{histFmtCurrency(t.estCOGS)}</td>
                                  <td style={{ textAlign: 'right', ...mStyle(t.estMargin) }}>{histFmtCurrency(t.estMargin)}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 8 }}>
                        Mat cost is estimated from the most recent completed build batch snapshot per SKU.
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

// ── Line breakdown sub-component ──────────────────────────────────────────────

function HistLineBreakdown({
  order,
  skuMap,
  batchLines,
  batches,
  powderMap,
}: {
  order: Order
  skuMap: Map<string, HistorySKU>
  batchLines: HistoryBatchLine[]
  batches: HistoryBatch[]
  powderMap: Map<string, PowderBatch>
}) {
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
              ? (lc.lineMargin / lc.revenue) * 100 : null
            return (
              <tr key={line.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 0', color: 'var(--text)' }}>
                  <div style={{ fontWeight: 500 }}>{lc.sku?.description ?? line.description ?? line.ss_sku}</div>
                  {line.sku_id && <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{line.sku_id}</div>}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{line.qty}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{histFmtCurrency(line.unit_price)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{histFmtCurrency(lc.revenue)}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)', fontStyle: lc.matEstimated ? 'italic' : undefined }}>{histFmtCurrency(lc.matCost)}</td>
                <td style={{ textAlign: 'right', color: 'var(--accent)', fontSize: 12 }}>{lc.powderRunName ?? '—'}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{histFmtCurrency(lc.boltKit)}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{histFmtCurrency(lc.packaging)}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-2)' }}>{histFmtCurrency(lc.labor)}</td>
                <td style={{ textAlign: 'right' }}>{histFmtCurrency(lc.lineCOGS)}</td>
                <td style={{ textAlign: 'right', color: lineMarginPct != null ? (lineMarginPct >= 0 ? 'var(--success)' : 'var(--danger)') : undefined, fontWeight: 600 }}>
                  {histFmtCurrency(lc.lineMargin)}
                  {lineMarginPct != null && <span style={{ fontSize: 11, marginLeft: 4, opacity: 0.8 }}>({histFmtPct(lineMarginPct)})</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
