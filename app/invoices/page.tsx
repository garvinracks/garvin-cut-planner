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

function orderTotal(order: Order, shippingOverride: number | null) {
  const lineTotal = order.order_lines.reduce((s, l) => s + (l.unit_price ?? 0) * l.qty, 0)
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

  // PO import state
  const [parsing, setParsing]     = useState(false)
  const [parsedPO, setParsedPO]   = useState<ParsedPO | null>(null)
  const [importing, setImporting] = useState(false)

  // Create invoice modal state
  const [creating, setCreating]      = useState<Order | null>(null)
  const [shippingInput, setShipping] = useState('')
  const [saving, setSaving]          = useState(false)

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

  // ── PO Import ──────────────────────────────────────────────────────────────

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.pdf')) { showMsg('Please select a PDF file.'); return }

    setParsing(true)
    setParsedPO(null)
    const form = new FormData()
    form.append('pdf', file)

    const res = await fetch('/api/t5/parse-po', { method: 'POST', body: form })
    const data = await res.json()
    setParsing(false)

    if (!res.ok || data.error) { showMsg(data.error ?? 'Failed to parse PDF.'); return }
    setParsedPO(data as ParsedPO)
    // Reset file input so the same file can be re-selected if needed
    if (fileInput.current) fileInput.current.value = ''
  }

  async function confirmImport() {
    if (!parsedPO) return
    setImporting(true)

    const res = await fetch('/api/t5/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsedPO),
    })
    const data = await res.json()
    setImporting(false)

    if (!res.ok || data.error) { showMsg(data.error ?? 'Failed to create order.'); return }
    setParsedPO(null)
    showMsg(`✓ PO ${parsedPO.poNumber} created in ShipStation. It will appear in Orders after the next sync.`, 'success')
    await load()
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
    const today = new Date().toISOString().split('T')[0]
    const due   = addDays(today, 30)
    const sc    = shippingInput.trim() !== '' ? parseFloat(shippingInput) : order.shipping_cost
    const { data, error } = await supabase.from('turn5_invoices').insert({
      order_id:      order.id,
      issue_date:    today,
      due_date:      due,
      shipping_cost: sc,
      status:        'draft',
    }).select().single()
    setSaving(false)
    if (error || !data) { showMsg('Error creating invoice: ' + error?.message); return }
    setCreating(null); setShipping('')
    await load()
    window.open(`/invoices/${data.id}`, '_blank')
  }

  async function markSent(invoiceId: string) {
    await supabase.from('turn5_invoices').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', invoiceId)
    await load()
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
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <button
            className="btn btn-primary"
            disabled={parsing}
            onClick={() => fileInput.current?.click()}
          >
            {parsing ? '⏳ Parsing PDF…' : '📄 Upload T5 PO PDF'}
          </button>
        </div>
      </section>

      {loading ? (
        <div style={{ color: 'var(--muted)', padding: 32, textAlign: 'center' }}>Loading…</div>
      ) : (
        <>
          {/* ── Active Orders ──────────────────────────────────────────────── */}
          {openOrders.length > 0 && (
            <section className="card" style={{ marginBottom: 24 }}>
              <div className="card-header">
                <h2 className="card-title">Active Orders</h2>
                <div className="card-subtitle">
                  {awaitingCount > 0 && <span>{awaitingCount} awaiting shipment</span>}
                  {awaitingCount > 0 && shippedCount > 0 && <span style={{ margin: '0 6px', opacity: 0.4 }}>·</span>}
                  {shippedCount > 0 && <span style={{ color: 'var(--success)' }}>{shippedCount} shipped</span>}
                </div>
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
                    {openOrders.map((order) => {
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
                                onClick={() => { setCreating(order); setShipping(order.shipping_cost != null ? String(order.shipping_cost) : '') }}>
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
                                <button className="btn btn-primary"
                                  style={{ fontSize: '0.75rem', background: 'var(--success)', borderColor: 'var(--success)' }}
                                  onClick={() => void markSent(inv.id)}>✓ Sent</button>
                              )}
                              <button className="btn btn-secondary"
                                style={{ fontSize: '0.75rem', color: 'var(--danger)' }}
                                onClick={() => void cancelOrder(order)}>✕ Cancel</button>
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
              <div className="card-header">
                <h2 className="card-title">Invoice History</h2>
                <div className="card-subtitle">{invoiced.length} invoice{invoiced.length !== 1 ? 's' : ''}</div>
              </div>
              <div className="card-body" style={{ padding: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
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

      {/* ── Parsed PO Preview Modal ──────────────────────────────────────────── */}
      {parsedPO && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: 'var(--panel)', borderRadius: 12, padding: 28, width: '100%', maxWidth: 520, border: '1px solid var(--border)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ fontWeight: 800, fontSize: '1.05rem', marginBottom: 6 }}>PO #{parsedPO.poNumber} — Confirm Details</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 20 }}>Review the extracted data before creating the ShipStation order.</div>

            {/* Ship To */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 8 }}>Ship To</div>
              <div style={{ background: 'var(--panel-2)', borderRadius: 8, padding: '10px 14px', fontSize: '0.85rem', lineHeight: 1.7 }}>
                <div style={{ fontWeight: 700 }}>{parsedPO.shipTo.name}</div>
                <div>{parsedPO.shipTo.street1}</div>
                {parsedPO.shipTo.street2 && <div>{parsedPO.shipTo.street2}</div>}
                <div>{parsedPO.shipTo.city}, {parsedPO.shipTo.state} {parsedPO.shipTo.zip}</div>
                {parsedPO.shipTo.phone && <div style={{ color: 'var(--muted)' }}>📞 {parsedPO.shipTo.phone}</div>}
              </div>
            </div>

            {/* Line items */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 8 }}>Items</div>
              {parsedPO.items.map((item, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '0.88rem' }}>
                  <div>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{item.sku}</span>
                    <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: '0.8rem' }}>{item.description}</span>
                  </div>
                  <span style={{ fontWeight: 600, whiteSpace: 'nowrap', marginLeft: 12 }}>× {item.qty} @ {fmt(item.unitPrice)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'flex-end', fontWeight: 700, paddingTop: 8 }}>
                Total: {fmt(parsedPO.items.reduce((s, i) => s + i.unitPrice * i.qty, 0))}
              </div>
            </div>

            {/* Warnings */}
            {(!parsedPO.shipTo.name || !parsedPO.shipTo.city) && (
              <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '8px 12px', fontSize: '0.8rem', color: 'var(--danger)', marginBottom: 16 }}>
                ⚠ Address looks incomplete — double-check before confirming.
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={importing} onClick={() => void confirmImport()}>
                {importing ? '⏳ Creating…' : '✓ Create ShipStation Order'}
              </button>
              <button className="btn btn-secondary" onClick={() => setParsedPO(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Invoice Modal ─────────────────────────────────────────────── */}
      {creating && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: 'var(--panel)', borderRadius: 12, padding: 28, width: '100%', maxWidth: 440, border: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 800, fontSize: '1.05rem', marginBottom: 18 }}>Create Invoice — PO #{creating.order_number}</div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Line Items</div>
              {creating.order_lines.map((l) => (
                <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '0.88rem' }}>
                  <span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.ss_sku ?? '—'}</span>
                    <span style={{ color: 'var(--muted)', marginLeft: 8 }}>× {l.qty}</span>
                    {(l.skus?.[0]?.description ?? l.description) && (
                      <div style={{ color: 'var(--text-2)', fontSize: '0.78rem', marginTop: 2 }}>{l.skus?.[0]?.description ?? l.description}</div>
                    )}
                  </span>
                  <span style={{ fontWeight: 600, whiteSpace: 'nowrap', marginLeft: 12 }}>{fmt((l.unit_price ?? 0) * l.qty)}</span>
                </div>
              ))}
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
              <span>{fmt(orderTotal(creating, shippingInput.trim() !== '' ? parseFloat(shippingInput) : creating.shipping_cost))}</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={saving} onClick={() => void createInvoice(creating)}>
                {saving ? 'Creating…' : '📄 Create & Open Invoice'}
              </button>
              <button className="btn btn-secondary" onClick={() => { setCreating(null); setShipping('') }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
