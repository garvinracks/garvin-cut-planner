'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type StoreConfig = {
  storeId: number
  storeName: string
  marketplaceName: string
  channel: string   // 'shopify' | 'turn5'
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
  order_lines: OrderLine[]
}

type SKU = { id: string; description: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function isOverdue(isoDate: string | null) {
  if (!isoDate) return false
  return new Date(isoDate) < new Date()
}

const CHANNEL_LABEL: Record<string, string> = {
  shopify: 'Shopify',
  turn5: 'Turn5',
}

const CHANNEL_COLOR: Record<string, { bg: string; text: string }> = {
  shopify: { bg: 'rgba(34,197,94,0.18)', text: '#4ade80' },
  turn5:   { bg: 'rgba(245,158,11,0.18)', text: '#fbbf24' },
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  // ── Store config state ──────────────────────────────────────────────────────
  const [storeConfig, setStoreConfig] = useState<StoreConfig[]>([])
  const [ssStores, setSsStores] = useState<SSStore[]>([])
  const [setupOpen, setSetupOpen] = useState(false)
  const [loadingStores, setLoadingStores] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [configMessage, setConfigMessage] = useState('')

  // ── Orders state ─────────────────────────────────────────────────────────────
  const [orders, setOrders] = useState<Order[]>([])
  const [skus, setSkus] = useState<SKU[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [channelFilter, setChannelFilter] = useState<'all' | 'shopify' | 'turn5'>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // ── Load config from DB ──────────────────────────────────────────────────────
  async function loadConfig() {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'shipstation_stores')
      .single()

    if (data?.value) {
      setStoreConfig(data.value as StoreConfig[])
    } else {
      setSetupOpen(true)
    }
  }

  // ── Load orders from DB ──────────────────────────────────────────────────────
  async function loadOrders() {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id, order_number, channel, customer_name, order_date, ship_by_date,
        status, ss_status, synced_at,
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

  async function initialLoad() {
    setLoading(true)
    await Promise.all([loadConfig(), loadOrders(), loadSkus()])
    setLoading(false)
  }

  useEffect(() => { void initialLoad() }, [])

  // ── Load ShipStation stores for setup UI ─────────────────────────────────────
  async function loadSSStores() {
    setLoadingStores(true)
    setConfigMessage('')
    try {
      const res = await fetch('/api/shipstation/stores')
      const data = await res.json()
      if (!res.ok) { setConfigMessage(data.error ?? 'Failed to load stores.'); return }

      const stores: SSStore[] = Array.isArray(data) ? data : []
      setSsStores(stores)

      // Merge with existing config
      const existing = storeConfig.reduce<Record<number, StoreConfig>>(
        (acc, s) => { acc[s.storeId] = s; return acc }, {}
      )

      setStoreConfig(stores.map((s) => {
        const prev = existing[s.storeId]
        const isShopify = s.storeName === 'Garvin Industries, LLC' ||
          s.marketplaceName?.toLowerCase().includes('shopify')
        return {
          storeId:         s.storeId,
          storeName:       s.storeName,
          marketplaceName: s.marketplaceName ?? '',
          channel:         prev?.channel ?? (isShopify ? 'shopify' : 'turn5'),
          enabled:         prev?.enabled ?? isShopify,
        }
      }))
    } finally {
      setLoadingStores(false)
    }
  }

  async function saveConfig() {
    setSavingConfig(true)
    setConfigMessage('')
    const { error } = await supabase
      .from('app_settings')
      .upsert(
        { key: 'shipstation_stores', value: storeConfig as any, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      )
    if (error) {
      setConfigMessage(`Save failed: ${error.message}`)
    } else {
      setConfigMessage('Configuration saved.')
      setSetupOpen(false)
    }
    setSavingConfig(false)
  }

  // ── Sync orders from ShipStation ─────────────────────────────────────────────
  async function syncOrders() {
    setSyncing(true)
    setSyncMessage('')
    try {
      const res = await fetch('/api/shipstation/sync', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setSyncMessage(`Sync failed: ${data.error}`)
        return
      }
      setSyncMessage(`✓ Synced ${data.imported} orders (${data.skipped} skipped)`)
      await loadOrders()
    } finally {
      setSyncing(false)
    }
  }

  // ── Derived data ─────────────────────────────────────────────────────────────
  const filtered = orders.filter(
    (o) => channelFilter === 'all' || o.channel === channelFilter
  )
  const shopifyCount = orders.filter((o) => o.channel === 'shopify').length
  const turn5Count   = orders.filter((o) => o.channel === 'turn5').length

  const lastSynced = orders.reduce<string | null>((max, o) => {
    if (!o.synced_at) return max
    return !max || o.synced_at > max ? o.synced_at : max
  }, null)

  // Aggregate demand across all open orders
  const demandMap: Record<string, { sku_id: string; description: string; qty: number; orderCount: number }> = {}
  for (const order of orders) {
    const seen = new Set<string>()
    for (const line of order.order_lines) {
      if (!line.sku_id) continue
      if (!demandMap[line.sku_id]) {
        const sku = skus.find((s) => s.id === line.sku_id)
        demandMap[line.sku_id] = {
          sku_id:      line.sku_id,
          description: sku?.description ?? line.description ?? '',
          qty:         0,
          orderCount:  0,
        }
      }
      demandMap[line.sku_id].qty += line.qty
      if (!seen.has(line.sku_id)) {
        demandMap[line.sku_id].orderCount++
        seen.add(line.sku_id)
      }
    }
  }
  const demandRows = Object.values(demandMap).sort((a, b) => b.qty - a.qty)
  const unmatchedLines = orders.flatMap((o) => o.order_lines).filter((l) => !l.sku_id)

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Orders</h1>
          <div className="page-subtitle">
            Open orders synced from ShipStation — drives demand in the Build Planner.
          </div>
        </div>
      </div>

      {/* ── Store Setup Card ─────────────────────────────────────────────────── */}
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
          <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
            {setupOpen ? '▲ Hide' : '▼ Configure'}
          </span>
        </div>

        {setupOpen && (
          <div className="card-body">
            <p style={{ fontSize: '0.85rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.6 }}>
              Click <strong>Load Stores</strong> to fetch your ShipStation stores. Enable each Garvin store
              and assign it a channel. Non-Garvin stores should be left disabled.
            </p>

            <div className="btn-row" style={{ marginBottom: 18 }}>
              <button
                className="btn btn-secondary"
                onClick={loadSSStores}
                disabled={loadingStores}
              >
                {loadingStores ? 'Loading…' : 'Load Stores from ShipStation'}
              </button>
            </div>

            {ssStores.length > 0 && (
              <div className="table-wrap" style={{ marginBottom: 16 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Store Name</th>
                      <th>Marketplace</th>
                      <th>Channel</th>
                      <th>Enable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {storeConfig.map((s) => (
                      <tr key={s.storeId}>
                        <td style={{ fontWeight: 600 }}>{s.storeName}</td>
                        <td style={{ color: 'var(--muted)' }}>{s.marketplaceName}</td>
                        <td>
                          <select
                            className="select"
                            value={s.channel}
                            style={{ width: 110 }}
                            onChange={(e) =>
                              setStoreConfig((prev) =>
                                prev.map((x) =>
                                  x.storeId === s.storeId ? { ...x, channel: e.target.value } : x
                                )
                              )
                            }
                          >
                            <option value="shopify">Shopify</option>
                            <option value="turn5">Turn5</option>
                            <option value="other">Other</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={s.enabled}
                            style={{ width: 18, height: 18, cursor: 'pointer' }}
                            onChange={(e) =>
                              setStoreConfig((prev) =>
                                prev.map((x) =>
                                  x.storeId === s.storeId ? { ...x, enabled: e.target.checked } : x
                                )
                              )
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="btn-row">
              <button
                className="btn btn-primary"
                onClick={saveConfig}
                disabled={savingConfig || storeConfig.length === 0}
              >
                {savingConfig ? 'Saving…' : 'Save Configuration'}
              </button>
            </div>

            {configMessage && (
              <div className="message" style={{ marginTop: 10 }}>{configMessage}</div>
            )}
          </div>
        )}
      </section>

      {/* ── Sync + Stats Bar ─────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={syncOrders}
              disabled={syncing}
              style={{ minWidth: 180 }}
            >
              {syncing ? 'Syncing…' : '↻ Sync from ShipStation'}
            </button>

            {lastSynced && (
              <span style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
                Last synced: {new Date(lastSynced).toLocaleString()}
              </span>
            )}

            {/* Stats pills */}
            <div style={{ display: 'flex', gap: 10, marginLeft: 'auto', flexWrap: 'wrap' }}>
              {[
                { label: 'All Open', count: orders.length, active: channelFilter === 'all', key: 'all' as const },
                { label: 'Shopify',  count: shopifyCount,  active: channelFilter === 'shopify', key: 'shopify' as const },
                { label: 'Turn5',    count: turn5Count,    active: channelFilter === 'turn5', key: 'turn5' as const },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setChannelFilter(tab.key)}
                  style={{
                    background: tab.active ? 'var(--accent)' : 'var(--panel-2)',
                    border: `1px solid ${tab.active ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 20,
                    padding: '4px 14px',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    color: tab.active ? '#fff' : 'var(--text-2)',
                    cursor: 'pointer',
                    transition: 'all 0.13s',
                  }}
                >
                  {tab.label} <span style={{ opacity: 0.8 }}>({tab.count})</span>
                </button>
              ))}
            </div>
          </div>

          {syncMessage && (
            <div
              className={syncMessage.startsWith('✓') ? 'message' : 'warning-box'}
              style={{ marginTop: 12 }}
            >
              {syncMessage}
            </div>
          )}
        </div>
      </section>

      {/* ── Orders List ──────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Open Orders</h2>
          <div className="card-subtitle">
            {filtered.length} order{filtered.length !== 1 ? 's' : ''} — oldest first. Click a row to expand line items.
          </div>
        </div>

        <div className="card-body">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              No open orders.{' '}
              {orders.length === 0 ? 'Click "Sync from ShipStation" to import.' : 'Try a different filter.'}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Channel</th>
                    <th>Customer</th>
                    <th>Order Date</th>
                    <th>Ship By</th>
                    <th style={{ textAlign: 'center' }}>Items</th>
                    <th style={{ textAlign: 'center' }}>Unmatched</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((order) => {
                    const isExpanded = expandedId === order.id
                    const overdue    = isOverdue(order.ship_by_date)
                    const unmatched  = order.order_lines.filter((l) => !l.sku_id).length
                    const chStyle    = CHANNEL_COLOR[order.channel] ?? CHANNEL_COLOR.shopify

                    return (
                      <>
                        <tr
                          key={order.id}
                          onClick={() => setExpandedId(isExpanded ? null : order.id)}
                          style={{ cursor: 'pointer', background: isExpanded ? 'var(--accent-soft)' : 'transparent' }}
                        >
                          <td style={{ fontWeight: 700 }}>
                            {isExpanded ? '▾ ' : '▸ '}{order.order_number}
                          </td>
                          <td>
                            <span style={{
                              background: chStyle.bg,
                              color: chStyle.text,
                              borderRadius: 12,
                              padding: '2px 10px',
                              fontSize: '0.76rem',
                              fontWeight: 700,
                            }}>
                              {CHANNEL_LABEL[order.channel] ?? order.channel}
                            </span>
                          </td>
                          <td>{order.customer_name ?? '—'}</td>
                          <td>{formatDate(order.order_date)}</td>
                          <td style={{ color: overdue ? 'var(--danger)' : 'inherit', fontWeight: overdue ? 700 : 400 }}>
                            {formatDate(order.ship_by_date)}
                            {overdue && ' ⚠'}
                          </td>
                          <td style={{ textAlign: 'center' }}>{order.order_lines.length}</td>
                          <td style={{ textAlign: 'center' }}>
                            {unmatched > 0 ? (
                              <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{unmatched}</span>
                            ) : (
                              <span style={{ color: 'var(--success)' }}>✓</span>
                            )}
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr key={`${order.id}-lines`}>
                            <td colSpan={7} style={{ padding: 0, background: 'var(--panel-2)' }}>
                              <div style={{ padding: '10px 20px 14px' }}>
                                <table className="table" style={{ background: 'transparent' }}>
                                  <thead>
                                    <tr>
                                      <th>SKU</th>
                                      <th>Description</th>
                                      <th>Qty</th>
                                      <th>Unit Price</th>
                                      <th>Match</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {order.order_lines.map((line) => (
                                      <tr key={line.id}>
                                        <td style={{ fontWeight: 600, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                                          {line.ss_sku}
                                        </td>
                                        <td>{line.description ?? '—'}</td>
                                        <td style={{ fontWeight: 700 }}>{line.qty}</td>
                                        <td>{line.unit_price != null ? `$${line.unit_price.toFixed(2)}` : '—'}</td>
                                        <td>
                                          {line.sku_id ? (
                                            <span style={{ color: 'var(--success)', fontWeight: 700 }}>✓ Matched</span>
                                          ) : (
                                            <span style={{ color: 'var(--warning)', fontWeight: 700 }}>⚠ No match</span>
                                          )}
                                        </td>
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
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ── Demand Summary ───────────────────────────────────────────────────── */}
      {demandRows.length > 0 && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Open Order Demand</h2>
            <div className="card-subtitle">
              Total qty needed across all {orders.length} open orders — use this to drive the Build Planner.
            </div>
          </div>

          <div className="card-body">
            {unmatchedLines.length > 0 && (
              <div className="warning-box" style={{ marginBottom: 16, fontSize: '0.84rem' }}>
                ⚠ {unmatchedLines.length} line item{unmatchedLines.length !== 1 ? 's' : ''} did not match a SKU in
                your library:{' '}
                {[...new Set(unmatchedLines.map((l) => l.ss_sku))].join(', ')}
                . Add those SKUs to the SKUs page so they appear here.
              </div>
            )}

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Description</th>
                    <th style={{ textAlign: 'center' }}>Total Qty Needed</th>
                    <th style={{ textAlign: 'center' }}>Across # Orders</th>
                  </tr>
                </thead>
                <tbody>
                  {demandRows.map((row) => (
                    <tr key={row.sku_id}>
                      <td style={{ fontWeight: 700, fontFamily: 'monospace' }}>{row.sku_id}</td>
                      <td>{row.description}</td>
                      <td style={{ textAlign: 'center', fontWeight: 700, fontSize: '1.05rem' }}>{row.qty}</td>
                      <td style={{ textAlign: 'center', color: 'var(--muted)' }}>{row.orderCount}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2} style={{ fontWeight: 700, color: 'var(--muted)' }}>
                      {demandRows.length} SKU{demandRows.length !== 1 ? 's' : ''} needed
                    </td>
                    <td style={{ textAlign: 'center', fontWeight: 700 }}>
                      {demandRows.reduce((s, r) => s + r.qty, 0)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
