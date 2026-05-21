'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import type { ParsedPO } from '@/app/api/t5/parse-po/route'

// ── Types ─────────────────────────────────────────────────────────────────────

type OrderLine = {
  id: string
  sku_id: string | null
  ss_sku: string | null
  description: string | null
  qty: number
  unit_price: number | null
  skus: { description: string }[] | null
}

type Order = {
  id: string
  order_number: string
  order_date: string
  customer_name: string | null
  shipping_cost: number | null
  shipped_at: string | null
  shipstation_order_id: number | null
  ss_status: string | null
  status: string
  order_lines: OrderLine[]
}

type T5Invoice = {
  id: string
  order_id: string
  issue_date: string
  due_date: string
  shipping_cost: number | null
  status: 'draft' | 'sent'
  sent_at: string | null
  created_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return '$' + n.toFixed(2)
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function addDays(iso: string, days: number) {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

function orderTotal(order: Order, shippingOverride: number | null, linePricesOverride?: Record<string, string>) {
  const lineTotal = order.order_lines.reduce((s, l) => {
    const p = linePricesOverride?.[l.id]
    const price = p !== undefined && p.trim() !== '' ? parseFloat(p) || 0 : (l.unit_price ?? 0)
    return s + price * l.qty
  }, 0)
  const shipping  = shippingOverride ?? order.shipping_cost ?? 0
  return lineTotal + shipping
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const supabase  = useMemo(() => createBrowserClient(), [])
  const fileInput = useRef<HTMLInputElement>(null)

  const [orders, setOrders]     = useState<Order[]>([])
  const [invoices, setInvoices] = useState<T5Invoice[]>([])
  const [loading, setLoading]   = useState(true)
  const [message, setMessage]   = useState('')
  const [msgType, setMsgType]   = useState<'error' | 'success'>('error')

  // PO import state — supports multiple files
  const [parsedQueue, setParsedQueue]   = useState<ParsedPO[]>([])
  const [parsingCount, setParsingCount] = useState(0)   // files still being parsed
  const [importingAll, setImportingAll] = useState(false)
  const [importResults, setImportResults] = useState<{ po: string; ok: boolean; msg: string }[]>([])

  // Bulk print selection
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<string>>(new Set())

  // Hide shipped+sent orders from the active table by default
  const [showCompleted, setShowCompleted] = useState(false)

  function toggleInvoiceSelect(id: string) {
    setSelectedInvoiceIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function openPrintAll(ids?: string[]) {
    const url = ids && ids.length > 0
      ? `/invoices/print-all?ids=${ids.join(',')}`
      : '/invoices/print-all'
    window.open(url, '_blank')
  }

  // Create invoice modal state
  const [creating, setCreating]      = useState<Order | null>(null)
  const [shippingInput, setShipping] = useState('')
  const [linePrices, setLinePrices]  = useState<Record<string, string>>({})  // lineId → price string
  const [saving, setSaving]          = useState(false)
  const [bulkCreating, setBulkCreating] = useState(false)

  function showMsg(text: string, type: 'error' | 'success' = 'error') {
    setMessage(text); setMsgType(type)
    setTimeout(() => setMessage(''), 5000)
  }

  async function load() {
    setLoading(true)
    const [{ data: oData }, { data: iData }] = await Promise.all([
      supabase
        .from('orders')
        .select('id, order_number, order_date, customer_name, shipping_cost, shipped_at, shipstation_order_id, ss_status, status, order_lines(id, sku_id, ss_sku, description, qty, unit_price, skus(description))')
        .eq('channel', 'turn5')
        .order('order_date', { ascending: false }),
      supabase.from('turn5_invoices').select('*').order('created_at', { ascending: false }),
    ])
    setOrders((oData ?? []) as Order[])
    setInvoices((iData ?? []) as T5Invoice[])
    setLoading(false)
  }

  useEffect(() => { void load() }, [])

  // ── PO Import (multi-file) ─────────────────────────────────────────────────

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.name.toLowerCase().endsWith('.pdf'))
    if (files.length === 0) return
    if (fileInput.current) fileInput.current.value = ''

    setParsingCount(files.length)
    setImportResults([])
    const results: ParsedPO[] = []

    await Promise.all(files.map(async (file) => {
      const form = new FormData()
      form.append('pdf', file)
      try {
        const res  = await fetch('/api/t5/parse-po', { method: 'POST', body: form })
        const data = await res.json()
        if (res.ok && !data.error) results.push(data as ParsedPO)
        else showMsg(`${file.name}: ${data.error ?? 'parse failed'}`)
      } catch {
        showMsg(`${file.name}: network error`)
      } finally {
        setParsingCount((n) => n - 1)
      }
    }))

    // Deduplicate by PO number (in case same file uploaded twice)
    setParsedQueue((prev) => {
      const existing = new Set(prev.map((p) => p.poNumber))
      return [...prev, ...results.filter((r) => !existing.has(r.poNumber))]
    })
  }

  async function importAll() {
    if (parsedQueue.length === 0) return
    setImportingAll(true)
    const results: { po: string; ok: boolean; msg: string }[] = []

    for (const po of parsedQueue) {
      const res  = await fetch('/api/t5/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(po),
      })
      const data = await res.json()
      results.push({
        po:  po.poNumber,
        ok:  res.ok && !data.error,
        msg: res.ok && !data.error ? `PO ${po.poNumber} created` : (data.error ?? 'Failed'),
      })
    }

    setImportResults(results)
    setParsedQueue([])
    setImportingAll(false)
    await load()
  }

  function removeFromQueue(poNumber: string) {
    setParsedQueue((prev) => prev.filter((p) => p.poNumber !== poNumber))
  }

  // ── Cancel order ───────────────────────────────────────────────────────────

  async function cancelOrder(order: Order) {
    if (!confirm(`Cancel PO ${order.order_number}? This will void the order in ShipStation.`)) return
    if (!order.shipstation_order_id) { showMsg('No ShipStation order ID — cannot cancel.'); return }

    const res = await fetch('/api/t5/cancel-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssOrderId: order.shipstation_order_id }),
    })
    const data = await res.json()
    if (!res.ok || data.error) { showMsg(data.error ?? 'Failed to cancel order.'); return }
    showMsg(`✓ PO ${order.order_number} cancelled in ShipStation.`, 'success')
    await load()
  }

  // ── Invoice actions ────────────────────────────────────────────────────────

  async function createInvoice(order: Order) {
    setSaving(true)

    // Save any corrected unit prices back to order_lines
    for (const line of order.order_lines) {
      const priceStr = linePrices[line.id]
      if (priceStr !== undefined) {
        const newPrice = priceStr.trim() !== '' ? parseFloat(priceStr) : null
        if (newPrice !== line.unit_price) {
          await supabase.from('order_lines').update({ unit_price: newPrice }).eq('id', line.id)
        }
      }
    }

    const today = new Date().toISOString().split('T')[0]
    const due   = addDays(today, 30)
    const sc    = shippingInput.trim() !== '' ? parseFloat(shippingInput) : order.shipping_cost

    // Recalculate total using edited prices
    const lineTotal = order.order_lines.reduce((s, l) => {
      const p = linePrices[l.id]
      const price = p !== undefined && p.trim() !== '' ? parseFloat(p) : (l.unit_price ?? 0)
      return s + price * l.qty
    }, 0)

    const { data, error } = await supabase.from('turn5_invoices').insert({
      order_id:      order.id,
      issue_date:    today,
      due_date:      due,
      shipping_cost: sc,
      status:        'draft',
    }).select().single()
    setSaving(false)
    if (error || !data) { showMsg('Error creating invoice: ' + error?.message); return }
    setCreating(null); setShipping(''); setLinePrices({})
    await load()
    window.open(`/invoices/${data.id}`, '_blank')
  }

  async function createAllShippedInvoices() {
    const toInvoice = openOrders.filter((o) => o.status === 'shipped' && !invoiceMap.has(o.id))
    if (toInvoice.length === 0) return
    if (!confirm(`Create draft invoices for all ${toInvoice.length} shipped orders?`)) return
    setBulkCreating(true)
    const today = new Date().toISOString().split('T')[0]
    const due   = addDays(today, 30)
    let created = 0
    for (const order of toInvoice) {
      const { error } = await supabase.from('turn5_invoices').insert({
        order_id:      order.id,
        issue_date:    today,
        due_date:      due,
        shipping_cost: order.shipping_cost,
        status:        'draft',
      })
      if (!error) created++
    }
    setBulkCreating(false)
    showMsg(`✓ Created ${created} draft invoice${created !== 1 ? 's' : ''}.`, 'success')
    await load()
  }

  async function markSent(invoiceId: string) {
    const sentAt = new Date().toISOString()
    await supabase.from('turn5_invoices').update({ status: 'sent', sent_at: sentAt }).eq('id', invoiceId)
    // Update state in place — no full reload so page doesn't scroll to top
    setInvoices((prev) => prev.map((inv) => inv.id === invoiceId ? { ...inv, status: 'sent', sent_at: sentAt } : inv))
  }

  async function markAllSent(invoiceIds: string[]) {
    const sentAt = new Date().toISOString()
    await supabase.from('turn5_invoices').update({ status: 'sent', sent_at: sentAt }).in('id', invoiceIds)
    setInvoices((prev) => prev.map((inv) => invoiceIds.includes(inv.id) ? { ...inv, status: 'sent', sent_at: sentAt } : inv))
    setSelectedInvoiceIds(new Set())
  }

  async function deleteInvoice(invoiceId: string) {
    if (!confirm('Delete this invoice?')) return
    await supabase.from('turn5_invoices').delete().eq('id', invoiceId)
    await load()
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const invoiceMap = useMemo(() => {
    const m = new Map<string, T5Invoice>()
    for (const inv of invoices) m.set(inv.order_id, inv)
    return m
  }, [invoices])

  const openOrders    = orders.filter((o) => o.status !== 'cancelled')
  const uninvoiced    = openOrders.filter((o) => !invoiceMap.has(o.id))
  const invoiced      = orders.filter((o) => invoiceMap.has(o.id))
  const cancelledOrders = orders.filter((o) => o.status === 'cancelled')
  const shippedCount  = openOrders.filter((o) => o.status === 'shipped').length
  const awaitingCount = openOrders.filter((o) => o.status === 'open').length
  const selectedDraftIds = [...selectedInvoiceIds].filter((id) => invoices.find((i) => i.id === id)?.status === 'draft')

  // Orders that are fully done: shipped + invoice sent
  const completedOrders = openOrders.filter((o) => o.status === 'shipped' && invoiceMap.get(o.id)?.status === 'sent')
  const activeOrders    = openOrders.filter((o) => !(o.status === 'shipped' && invoiceMap.get(o.id)?.status === 'sent'))

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="container" style={{ paddingTop: 32, paddingBottom: 64 }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>T5 Orders &amp; Invoices</h1>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 4 }}>Import Turn5 POs, manage orders, generate invoices</p>
      </div>

      {message && (
        <div style={{
          background: msgType === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          border: `1px solid ${msgType === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
          color: msgType === 'success' ? 'var(--success)' : 'var(--danger)',
          borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: '0.85rem',
        }}>
          {message}
        </div>
      )}

      {/* ── Import T5 PO ────────────────────────────────────────────────────── */}
      <section className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <h2 className="card-title">Import T5 PO</h2>
          <div className="card-subtitle">Upload a PDF from Turn5 — creates the order in ShipStation automatically</div>
        </div>
        <div className="card-body">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              disabled={parsingCount > 0}
              onClick={() => fileInput.current?.click()}
            >
              {parsingCount > 0 ? `⏳ Parsing ${parsingCount} file${parsingCount !== 1 ? 's' : ''}…` : '📄 Upload T5 PO PDFs'}
            </button>
            <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>You can select multiple PDFs at once</span>
          </div>

          {/* Parsed PO queue */}
          {parsedQueue.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{parsedQueue.length} PO{parsedQueue.length !== 1 ? 's' : ''} ready to import</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-secondary" style={{ fontSize: '0.82rem' }} onClick={() => setParsedQueue([])}>Clear All</button>
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: '0.82rem' }}
                    disabled={importingAll}
                    onClick={() => void importAll()}
                  >
                    {importingAll ? '⏳ Importing…' : `✓ Import All ${parsedQueue.length} POs`}
                  </button>
                </div>
              </div>
              <table className="table" style={{ fontSize: '0.84rem' }}>
                <thead>
                  <tr>
                    <th>PO #</th>
                    <th>Ship To</th>
                    <th>Items</th>
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {parsedQueue.map((po) => {
                    const total = po.items.reduce((s, i) => s + i.unitPrice * i.qty, 0)
                    return (
                      <tr key={po.poNumber}>
                        <td style={{ fontWeight: 700 }}>{po.poNumber}</td>
                        <td style={{ fontSize: '0.8rem' }}>
                          <div style={{ fontWeight: 600 }}>{po.shipTo.name}</div>
                          <div style={{ color: 'var(--muted)' }}>{po.shipTo.city}, {po.shipTo.state}</div>
                        </td>
                        <td style={{ fontSize: '0.8rem' }}>
                          {po.items.map((i, idx) => (
                            <div key={idx}><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{i.sku}</span> × {i.qty}</div>
                          ))}
                        </td>
                        <td style={{ fontWeight: 700 }}>${total.toFixed(2)}</td>
                        <td>
                          <button
                            className="btn btn-secondary"
                            style={{ fontSize: '0.75rem', color: 'var(--danger)' }}
                            onClick={() => removeFromQueue(po.poNumber)}
                          >✕ Remove</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Import results */}
          {importResults.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {importResults.map((r) => (
                <div key={r.po} style={{ fontSize: '0.82rem', color: r.ok ? 'var(--success)' : 'var(--danger)', marginBottom: 3 }}>
                  {r.ok ? '✓' : '✗'} {r.msg}
                </div>
              ))}
              <button className="btn btn-secondary" style={{ fontSize: '0.78rem', marginTop: 8 }} onClick={() => setImportResults([])}>Dismiss</button>
            </div>
          )}
        </div>
      </section>

      {loading ? (
        <div style={{ color: 'var(--muted)', padding: 32, textAlign: 'center' }}>Loading…</div>
      ) : (
        <>
          {/* ── Active Orders ──────────────────────────────────────────────── */}
          {openOrders.length > 0 && (
            <section className="card" style={{ marginBottom: 24 }}>
              <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <h2 className="card-title">Active Orders</h2>
                  <div className="card-subtitle" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    {awaitingCount > 0 && <span>{awaitingCount} awaiting shipment</span>}
                    {awaitingCount > 0 && shippedCount > 0 && <span style={{ opacity: 0.4 }}>·</span>}
                    {shippedCount > 0 && <span style={{ color: 'var(--success)' }}>{shippedCount} shipped</span>}
                    {completedOrders.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowCompleted((v) => !v)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--muted)', textDecoration: 'underline', padding: 0 }}
                      >
                        {showCompleted ? `Hide ${completedOrders.length} completed` : `Show ${completedOrders.length} completed`}
                      </button>
                    )}
                  </div>
                </div>
                {openOrders.filter((o) => o.status === 'shipped' && !invoiceMap.has(o.id)).length > 0 && (
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: '0.82rem', background: 'var(--success)', borderColor: 'var(--success)' }}
                    disabled={bulkCreating}
                    onClick={() => void createAllShippedInvoices()}
                  >
                    {bulkCreating
                      ? '⏳ Creating…'
                      : `📄 Create Invoices for All Shipped (${openOrders.filter((o) => o.status === 'shipped' && !invoiceMap.has(o.id)).length})`}
                  </button>
                )}
              </div>
              <div className="card-body" style={{ padding: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>PO Number</th>
                      <th>Date</th>
                      <th>Ship To</th>
                      <th>SKUs</th>
                      <th>Status</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                      <th>Invoice</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(showCompleted ? openOrders : activeOrders).map((order) => {
                      const inv   = invoiceMap.get(order.id)
                      const total = orderTotal(order, null)
                      return (
                        <tr key={order.id} style={order.status === 'shipped' ? { background: 'rgba(34,197,94,0.04)' } : undefined}>
                          <td style={{ fontWeight: 700 }}>{order.order_number}</td>
                          <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtDate(order.order_date)}</td>
                          <td style={{ fontSize: '0.8rem', color: 'var(--text-2)' }}>{order.customer_name ?? '—'}</td>
                          <td>
                            {order.order_lines.map((l) => (
                              <div key={l.id} style={{ fontSize: '0.8rem' }}>
                                <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{l.ss_sku ?? '—'}</span>
                                <span style={{ color: 'var(--muted)', marginLeft: 4 }}>× {l.qty}</span>
                                {(l.skus?.[0]?.description ?? l.description) && (
                                  <div style={{ color: 'var(--text-2)', fontSize: '0.75rem', marginTop: 1 }}>{l.skus?.[0]?.description ?? l.description}</div>
                                )}
                              </div>
                            ))}
                          </td>
                          <td>
                            {order.status === 'shipped' ? (
                              <div>
                                <span style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success)', borderRadius: 20, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 700, whiteSpace: 'nowrap' }}>✓ Shipped</span>
                                {order.shipped_at && (
                                  <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: 2 }}>
                                    {fmtDate(order.shipped_at)}
                                  </div>
                                )}
                                {order.shipping_cost != null && (
                                  <div style={{ fontSize: '0.72rem', color: 'var(--success)', marginTop: 1 }}>
                                    Ship: ${order.shipping_cost.toFixed(2)}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8', borderRadius: 20, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 700, whiteSpace: 'nowrap' }}>Awaiting</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(total)}</td>
                          <td>
                            {inv ? (
                              inv.status === 'sent' ? (
                                <span style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success)', borderRadius: 20, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 700 }}>✓ Sent</span>
                              ) : (
                                <span style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--warning)', borderRadius: 20, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 700 }}>Draft</span>
                              )
                            ) : (
                              <button className="btn btn-secondary" style={{ fontSize: '0.75rem' }}
                                onClick={() => {
                                  setCreating(order)
                                  setShipping(order.shipping_cost != null ? String(order.shipping_cost) : '')
                                  const prices: Record<string, string> = {}
                                  order.order_lines.forEach((l) => { prices[l.id] = l.unit_price != null ? String(l.unit_price) : '' })
                                  setLinePrices(prices)
                                }}>
                                Create Invoice
                              </button>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              {inv && (
                                <a href={`/invoices/${inv.id}`} target="_blank" rel="noopener noreferrer"
                                  className="btn btn-secondary" style={{ fontSize: '0.75rem' }}>🖨 Print</a>
                              )}
                              {inv?.status === 'draft' && (
                                <>
                                  <button className="btn btn-primary"
                                    style={{ fontSize: '0.75rem', background: 'var(--success)', borderColor: 'var(--success)' }}
                                    onClick={() => void markSent(inv.id)}>✓ Sent</button>
                                  <button className="btn btn-secondary"
                                    style={{ fontSize: '0.75rem', color: 'var(--danger)' }}
                                    onClick={() => void deleteInvoice(inv.id)}
                                    title="Delete this draft invoice">✕ Invoice</button>
                                </>
                              )}
                              {order.status !== 'shipped' && (
                                <button className="btn btn-secondary"
                                  style={{ fontSize: '0.75rem', color: 'var(--danger)' }}
                                  onClick={() => void cancelOrder(order)}>✕ Cancel</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {openOrders.length === 0 && cancelledOrders.length === 0 && invoiced.length === 0 && (
            <div className="card" style={{ marginBottom: 24 }}>
              <div className="card-body empty">No Turn5 orders yet. Upload a PO PDF above to get started.</div>
            </div>
          )}

          {/* ── Cancelled Orders ───────────────────────────────────────────── */}
          {cancelledOrders.length > 0 && (
            <section className="card" style={{ marginBottom: 24 }}>
              <div className="card-header">
                <h2 className="card-title">Cancelled</h2>
                <div className="card-subtitle">{cancelledOrders.length} order{cancelledOrders.length !== 1 ? 's' : ''}</div>
              </div>
              <div className="card-body" style={{ padding: 0 }}>
                <table className="table">
                  <thead>
                    <tr><th>PO Number</th><th>Date</th><th>SKUs</th></tr>
                  </thead>
                  <tbody>
                    {cancelledOrders.map((order) => (
                      <tr key={order.id} style={{ opacity: 0.5 }}>
                        <td style={{ fontWeight: 700, textDecoration: 'line-through' }}>{order.order_number}</td>
                        <td style={{ color: 'var(--muted)' }}>{fmtDate(order.order_date)}</td>
                        <td style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                          {order.order_lines.map((l) => l.ss_sku).join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Invoice History ────────────────────────────────────────────── */}
          {invoiced.length > 0 && (
            <section className="card">
              <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <h2 className="card-title">Invoice History</h2>
                  <div className="card-subtitle">{invoiced.length} invoice{invoiced.length !== 1 ? 's' : ''}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {selectedDraftIds.length > 0 && (
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: '0.82rem', background: 'var(--success)', borderColor: 'var(--success)' }}
                      onClick={() => void markAllSent(selectedDraftIds)}
                    >
                      ✓ Mark {selectedDraftIds.length} Sent
                    </button>
                  )}
                  {selectedInvoiceIds.size > 0 && (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '0.82rem' }}
                      onClick={() => openPrintAll([...selectedInvoiceIds])}
                    >
                      🖨 Print Selected ({selectedInvoiceIds.size})
                    </button>
                  )}
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: '0.82rem' }}
                    onClick={() => openPrintAll()}
                  >
                    🖨 Print All
                  </button>
                </div>
              </div>
              <div className="card-body" style={{ padding: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          checked={selectedInvoiceIds.size === invoiced.length && invoiced.length > 0}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedInvoiceIds(new Set(invoiced.map((o) => invoiceMap.get(o.id)!.id)))
                            else setSelectedInvoiceIds(new Set())
                          }}
                        />
                      </th>
                      <th>Invoice #</th>
                      <th>Issue Date</th>
                      <th>Due Date</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoiced.map((order) => {
                      const inv   = invoiceMap.get(order.id)!
                      const total = orderTotal(order, inv.shipping_cost)
                      return (
                        <tr key={order.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedInvoiceIds.has(inv.id)}
                              onChange={() => toggleInvoiceSelect(inv.id)}
                            />
                          </td>
                          <td style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.85rem' }}>TURN INV-{order.order_number}</td>
                          <td style={{ color: 'var(--muted)' }}>{fmtDate(inv.issue_date)}</td>
                          <td style={{ color: 'var(--muted)' }}>{fmtDate(inv.due_date)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(total)}</td>
                          <td>
                            {inv.status === 'sent' ? (
                              <span style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success)', borderRadius: 20, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 700 }}>
                                ✓ Sent {inv.sent_at ? fmtDate(inv.sent_at) : ''}
                              </span>
                            ) : (
                              <span style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--warning)', borderRadius: 20, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 700 }}>Draft</span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <a href={`/invoices/${inv.id}`} target="_blank" rel="noopener noreferrer"
                                className="btn btn-secondary" style={{ fontSize: '0.78rem' }}>🖨 Print</a>
                              {inv.status === 'draft' && (
                                <button className="btn btn-primary"
                                  style={{ fontSize: '0.78rem', background: 'var(--success)', borderColor: 'var(--success)' }}
                                  onClick={() => void markSent(inv.id)}>✓ Mark Sent</button>
                              )}
                              <button className="btn btn-secondary"
                                style={{ fontSize: '0.78rem', color: 'var(--danger)' }}
                                onClick={() => void deleteInvoice(inv.id)}>✕</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {/* ── Create Invoice Modal ─────────────────────────────────────────────── */}
      {creating && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: 'var(--panel)', borderRadius: 12, padding: 28, width: '100%', maxWidth: 520, border: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 800, fontSize: '1.05rem', marginBottom: 18 }}>Create Invoice — PO #{creating.order_number}</div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Line Items</div>
              {creating.order_lines.map((l) => {
                const priceVal = linePrices[l.id] ?? (l.unit_price != null ? String(l.unit_price) : '')
                const priceNum = priceVal.trim() !== '' ? parseFloat(priceVal) || 0 : null
                const missing  = priceNum == null || priceNum === 0
                return (
                  <div key={l.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '0.88rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.ss_sku ?? '—'}</span>
                        <span style={{ color: 'var(--muted)', marginLeft: 8 }}>× {l.qty}</span>
                        {(l.skus?.[0]?.description ?? l.description) && (
                          <div style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: 1 }}>{l.skus?.[0]?.description ?? l.description}</div>
                        )}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>$/ea</span>
                        <input
                          type="number" step="0.01" min="0"
                          value={priceVal}
                          onChange={(e) => setLinePrices((prev) => ({ ...prev, [l.id]: e.target.value }))}
                          placeholder="0.00"
                          style={{
                            width: 80, textAlign: 'right', padding: '4px 8px',
                            border: `1px solid ${missing ? 'var(--warning)' : 'var(--border)'}`,
                            borderRadius: 6, background: 'var(--panel-2)',
                            color: 'var(--text)', fontSize: '0.85rem',
                          }}
                        />
                        <span style={{ width: 70, textAlign: 'right', fontWeight: 600, color: missing ? 'var(--warning)' : 'var(--text)' }}>
                          {priceNum != null ? fmt(priceNum * l.qty) : '—'}
                        </span>
                      </div>
                    </div>
                    {missing && (
                      <div style={{ fontSize: '0.72rem', color: 'var(--warning)', marginTop: 3 }}>⚠ Enter unit price</div>
                    )}
                  </div>
                )
              })}
            </div>
            <div style={{ marginBottom: 20 }}>
              <label className="label">Shipping Cost ($)</label>
              <input className="field" type="number" step="0.01" min="0" placeholder="0.00" value={shippingInput}
                onChange={(e) => setShipping(e.target.value)} autoFocus />
              {creating.shipping_cost == null && (
                <div style={{ fontSize: '0.75rem', color: 'var(--warning)', marginTop: 4 }}>⚠ No shipping cost on this order — enter it manually</div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '1rem', marginBottom: 24, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <span>Total</span>
              <span>{fmt(orderTotal(creating, shippingInput.trim() !== '' ? parseFloat(shippingInput) : creating.shipping_cost, linePrices))}</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={saving} onClick={() => void createInvoice(creating)}>
                {saving ? 'Creating…' : '📄 Create & Open Invoice'}
              </button>
              <button className="btn btn-secondary" onClick={() => { setCreating(null); setShipping(''); setLinePrices({}) }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
