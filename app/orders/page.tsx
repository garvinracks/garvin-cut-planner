'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
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

type SKU = { id: string; description: string }
type InventoryRow = { sku_id: string; qty_on_hand: number }
type BatchLine = { batch_id: string; sku_id: string }
type ActiveBatch = { id: string; name: string; status: string }
type AllocStatus = 'ready' | 'partial' | 'build_needed' | 'unmatched'
type ViewMode = 'by_order' | 'by_sku'
type SortDir = 'asc' | 'desc'

// ── Category inference ────────────────────────────────────────────────────────

const CATEGORY_ORDER = ['Racks', 'Ladders', 'Deflectors', 'Accessories', 'Uncategorized'] as const
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

function orderCategory(order: Order, skus: SKU[]): Category {
  for (const line of order.order_lines) {
    const sku = skus.find((s) => s.id === line.sku_id)
    const cat = getCategory(sku?.description ?? line.description ?? '')
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

const ALLOC_STYLE: Record<AllocStatus, { icon: string; label: string; color: string; bg: string }> = {
  ready:       { icon: '🟢', label: 'Ready to Ship', color: 'var(--success)',  bg: 'rgba(34,197,94,0.12)' },
  partial:     { icon: '🟡', label: 'Partial',        color: 'var(--warning)', bg: 'rgba(234,179,8,0.12)'  },
  build_needed:{ icon: '🔴', label: 'Build Needed',  color: 'var(--danger)',  bg: 'rgba(239,68,68,0.12)'  },
  unmatched:   { icon: '⚪', label: 'No SKU Match',  color: 'var(--muted)',   bg: 'transparent'            },
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const supabase = useMemo(() => createBrowserClient(), [])
  const router   = useRouter()

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
  const [channelFilter, setChannelFilter] = useState<'all' | 'shopify' | 'turn5'>('all')
  const [viewMode, setViewMode]     = useState<ViewMode>('by_order')
  const [sortDir, setSortDir]       = useState<SortDir>('asc')
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
  const [shippingCost, setShippingCost]       = useState('')

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
    const { data } = await supabase.from('skus').select('id, description').order('id')
    setSkus((data ?? []) as SKU[])
  }

  async function loadInventory() {
    const { data } = await supabase.from('sku_inventory').select('sku_id, qty_on_hand')
    setInventory((data ?? []) as InventoryRow[])
  }

  async function loadBatches() {
    const [{ data: bl }, { data: ab }] = await Promise.all([
      supabase.from('build_batch_lines').select('batch_id, sku_id'),
      supabase.from('build_batches').select('id, name, status').in('status', ['planned', 'in_progress', 'at_powder']),
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
      setSyncMessage(`✓ Synced ${data.imported} orders`)
      await Promise.all([loadOrders(), loadInventory()])
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

  // ── Send to Build Planner ───────────────────────────────────────────────────

  function sendToPlanner() {
    const selected = orders.filter((o) => selectedIds.has(o.id))
    const demand: Record<string, number> = {}
    for (const order of selected) {
      for (const line of order.order_lines) {
        if (!line.sku_id) continue
        demand[line.sku_id] = (demand[line.sku_id] ?? 0) + line.qty
      }
    }
    const rows = Object.entries(demand).map(([skuId, qty]) => ({
      skuId, qty: String(qty), skuLookup: skuId,
    }))
    sessionStorage.setItem('garvin:orders_import', JSON.stringify(rows))
    router.push('/planner')
  }

  // ── Note editing ───────────────────────────────────────────────────────────

  async function saveNote(orderId: string, text: string) {
    const val = text.trim() || null
    await supabase.from('orders').update({ notes: val }).eq('id', orderId)
    setOrders((prev) => prev.map((o) => o.id === orderId ? { ...o, notes: val } : o))
  }

  // ── Mark Shipped ───────────────────────────────────────────────────────────

  async function markShipped(orderId: string) {
    const cost = shippingCost.trim() ? parseFloat(shippingCost) : null
    await supabase.from('orders').update({
      status: 'shipped',
      shipped_at: new Date().toISOString(),
      shipping_cost: cost,
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
    setShippingCost('')
    await Promise.all([loadOrders(), loadInventory()])
  }

  // ── Derived data ─────────────────────────────────────────────────────────────

  const sorted = useMemo(() =>
    [...orders].sort((a, b) => {
      const ta = new Date(a.order_date ?? 0).getTime()
      const tb = new Date(b.order_date ?? 0).getTime()
      return sortDir === 'asc' ? ta - tb : tb - ta
    }),
    [orders, sortDir]
  )

  const filtered = useMemo(() =>
    sorted.filter((o) => channelFilter === 'all' || o.channel === channelFilter),
    [sorted, channelFilter]
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

  // Group-by-SKU data
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
    planned:     { label: 'Planned',     bg: 'rgba(100,116,139,0.2)', color: '#94a3b8' },
    in_progress: { label: 'In Build',    bg: 'rgba(234,179,8,0.2)',   color: '#facc15' },
    at_powder:   { label: 'At Powder',   bg: 'rgba(167,139,250,0.2)', color: '#a78bfa' },
  }

  const STATUS_PRIORITY: Record<string, number> = { in_progress: 3, at_powder: 2, planned: 1 }

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
            <button className="btn btn-primary" style={{ height: 30, fontSize: '0.8rem' }} onClick={sendToPlanner}>
              📋 Send to Build Planner
            </button>
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
                      <div style={{ color: 'var(--text-2)', fontSize: '0.85rem', marginBottom: 16 }}>
                        Order {order?.order_number} · {order?.customer_name ?? 'Unknown'}
                      </div>
                      <label className="label">Shipping Cost ($)</label>
                      <input
                        className="field"
                        type="number"
                        step="0.01"
                        min="0"
                        value={shippingCost}
                        onChange={(e) => setShippingCost(e.target.value)}
                        placeholder="0.00"
                        autoFocus
                        style={{ marginBottom: 16 }}
                      />
                      <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 16 }}>
                        This will mark the order as shipped and deduct SKU quantities from inventory.
                      </div>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button className="btn btn-secondary" style={{ height: 32 }} onClick={() => setShippingOrderId(null)}>Cancel</button>
                        <button className="btn btn-primary" style={{ height: 32, background: 'var(--success)', borderColor: 'var(--success)' }}
                          onClick={() => markShipped(shippingOrderId)}>
                          ✓ Confirm Ship
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
                        onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')}
                      >
                        Date {sortDir === 'asc' ? '↑' : '↓'}
                      </th>
                      <th>SKU</th>
                      <th style={{ textAlign: 'center' }}>Qty</th>
                      <th>Customer</th>
                      {allocated && <th>Status</th>}
                      <th style={{ minWidth: 180 }}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      // Build rows list, optionally with category group headers
                      const rows: Array<{ type: 'group'; label: string } | { type: 'order'; order: Order }> = []
                      if (groupByCategory) {
                        const byCategory: Record<string, Order[]> = {}
                        for (const cat of CATEGORY_ORDER) byCategory[cat] = []
                        for (const order of filtered) {
                          const cat = orderCategory(order, skus)
                          byCategory[cat].push(order)
                        }
                        for (const cat of CATEGORY_ORDER) {
                          if (byCategory[cat].length === 0) continue
                          rows.push({ type: 'group', label: cat })
                          for (const order of byCategory[cat]) rows.push({ type: 'order', order })
                        }
                      } else {
                        for (const order of filtered) rows.push({ type: 'order', order })
                      }

                      const colSpan = allocated ? 8 : 7

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

                        const { order } = row
                        const isExpanded   = expandedIds.has(order.id)
                        const isSelected   = selectedIds.has(order.id)
                        const isMultiSku   = order.order_lines.length > 1
                        const days         = daysSince(order.order_date)
                        const status       = allocStatuses[order.id]
                        const alloc        = status ? ALLOC_STYLE[status] : null
                        const chStyle      = CH_STYLE[order.channel] ?? CH_STYLE.shopify
                        const totalQty     = order.order_lines.reduce((s, l) => s + l.qty, 0)
                        const orderBatchStatuses = order.order_lines
                          .filter((l) => l.sku_id && skuBatchStatus[l.sku_id])
                          .map((l) => skuBatchStatus[l.sku_id!])
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
                                  : alloc?.bg ?? 'transparent',
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

                              {/* Customer + batch status */}
                              <td style={{ color: 'var(--text-2)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <span>{order.customer_name ?? '—'}</span>
                                  {topBatch && (
                                    <span style={{
                                      background: BATCH_STATUS_STYLE[topBatch.status]?.bg,
                                      color: BATCH_STATUS_STYLE[topBatch.status]?.color,
                                      borderRadius: 20, padding: '1px 8px', fontSize: '0.72rem', fontWeight: 700, flexShrink: 0,
                                    }}>
                                      {BATCH_STATUS_STYLE[topBatch.status]?.label}
                                    </span>
                                  )}
                                </div>
                              </td>

                              {/* Alloc status + ship button */}
                              {allocated && (
                                <td>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    {alloc && (
                                      <span style={{ fontSize: '0.78rem', color: alloc.color, fontWeight: 600, whiteSpace: 'nowrap' }}>
                                        {alloc.icon} {alloc.label}
                                      </span>
                                    )}
                                    {status === 'ready' && (
                                      <button
                                        className="btn btn-primary"
                                        style={{ height: 24, fontSize: '0.72rem', padding: '0 8px', flexShrink: 0 }}
                                        onClick={(e) => { e.stopPropagation(); setShippingOrderId(order.id); setShippingCost('') }}
                                      >
                                        Ship →
                                      </button>
                                    )}
                                  </div>
                                </td>
                              )}

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
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {order.order_lines.map((line) => (
                                          <tr key={line.id}>
                                            <td style={{ fontFamily: 'monospace', fontSize: '0.83rem', fontWeight: 600 }}>
                                              {line.ss_sku}
                                            </td>
                                            <td style={{ color: 'var(--text-2)', fontSize: '0.83rem' }}>
                                              {line.description ?? skus.find((s) => s.id === line.sku_id)?.description ?? '—'}
                                            </td>
                                            <td style={{ textAlign: 'center', fontWeight: 700 }}>{line.qty}</td>
                                          </tr>
                                        ))}
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
                const totalQty = group.orders.reduce((s, r) => s + r.qty, 0)
                const inv      = inventory.find((i) => i.sku_id === group.sku_id)
                const onHand   = inv?.qty_on_hand ?? 0
                return (
                  <div key={group.sku_id} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    {/* SKU group header */}
                    <div style={{ background: 'var(--panel-2)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9rem' }}>{group.sku_id}</span>
                      <span style={{ color: 'var(--text-2)', fontSize: '0.84rem' }}>{group.description}</span>
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
                            <input type="checkbox" style={{ cursor: 'pointer' }}
                              checked={group.orders.every((r) => selectedIds.has(r.order.id))}
                              onChange={() => {
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
                          {allocated && <th>Status</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {group.orders.map(({ order, qty }) => {
                          const chStyle  = CH_STYLE[order.channel] ?? CH_STYLE.shopify
                          const status   = allocStatuses[order.id]
                          const alloc    = status ? ALLOC_STYLE[status] : null
                          const days     = daysSince(order.order_date)
                          return (
                            <tr key={order.id} style={{ background: selectedIds.has(order.id) ? 'var(--accent-soft)' : 'transparent' }}>
                              <td>
                                <input type="checkbox" style={{ cursor: 'pointer' }}
                                  checked={selectedIds.has(order.id)}
                                  onChange={() => toggleSelect(order.id)} />
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
                              {allocated && (
                                <td>
                                  {alloc && <span style={{ fontSize: '0.78rem', color: alloc.color, fontWeight: 600 }}>{alloc.icon} {alloc.label}</span>}
                                </td>
                              )}
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
    </div>
  )
}
