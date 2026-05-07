'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type OrderLine = {
  id: string
  sku_id: string | null
  ss_sku: string | null
  description: string | null
  qty: number
  unit_price: number | null
}

type Order = {
  id: string
  order_number: string
  order_date: string
  customer_name: string | null
  shipping_cost: number | null
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
  const shipping = shippingOverride ?? order.shipping_cost ?? 0
  return lineTotal + shipping
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [orders, setOrders]     = useState<Order[]>([])
  const [invoices, setInvoices] = useState<T5Invoice[]>([])
  const [loading, setLoading]   = useState(true)
  const [message, setMessage]   = useState('')

  // Create invoice modal state
  const [creating, setCreating]     = useState<Order | null>(null)
  const [shippingInput, setShipping] = useState('')
  const [saving, setSaving]         = useState(false)

  async function load() {
    setLoading(true)
    const [{ data: oData }, { data: iData }] = await Promise.all([
      supabase
        .from('orders')
        .select('id, order_number, order_date, customer_name, shipping_cost, order_lines(id, sku_id, ss_sku, description, qty, unit_price)')
        .eq('channel', 'turn5')
        .order('order_date', { ascending: false }),
      supabase
        .from('turn5_invoices')
        .select('*')
        .order('created_at', { ascending: false }),
    ])
    setOrders((oData ?? []) as Order[])
    setInvoices((iData ?? []) as T5Invoice[])
    setLoading(false)
  }

  useEffect(() => { void load() }, [])

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
    if (error || !data) { setMessage('Error creating invoice: ' + error?.message); return }
    setCreating(null)
    setShipping('')
    await load()
    // Navigate to print view
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

  const invoiceMap = useMemo(() => {
    const m = new Map<string, T5Invoice>()
    for (const inv of invoices) m.set(inv.order_id, inv)
    return m
  }, [invoices])

  const uninvoiced = orders.filter((o) => !invoiceMap.has(o.id))
  const invoiced   = orders.filter((o) => invoiceMap.has(o.id))

  return (
    <main className="container" style={{ paddingTop: 32, paddingBottom: 64 }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>T5 Invoices</h1>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 4 }}>Generate and track invoices for Turn5 orders</p>
      </div>

      {message && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--danger)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: '0.85rem' }}>
          {message}
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--muted)', padding: 32, textAlign: 'center' }}>Loading…</div>
      ) : (
        <>
          {/* ── Needs Invoice ─────────────────────────────────────────── */}
          {uninvoiced.length > 0 && (
            <section className="card" style={{ marginBottom: 24 }}>
              <div className="card-header">
                <h2 className="card-title">Needs Invoice</h2>
                <div className="card-subtitle">{uninvoiced.length} order{uninvoiced.length !== 1 ? 's' : ''}</div>
              </div>
              <div className="card-body" style={{ padding: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>PO Number</th>
                      <th>Date</th>
                      <th>SKUs</th>
                      <th style={{ textAlign: 'right' }}>Subtotal</th>
                      <th style={{ textAlign: 'right' }}>Shipping</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {uninvoiced.map((order) => {
                      const lineTotal = order.order_lines.reduce((s, l) => s + (l.unit_price ?? 0) * l.qty, 0)
                      const total = orderTotal(order, null)
                      return (
                        <tr key={order.id}>
                          <td style={{ fontWeight: 700 }}>{order.order_number}</td>
                          <td style={{ color: 'var(--muted)' }}>{fmtDate(order.order_date)}</td>
                          <td>
                            {order.order_lines.map((l) => (
                              <div key={l.id} style={{ fontSize: '0.8rem' }}>
                                <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{l.ss_sku ?? l.description ?? '—'}</span>
                                <span style={{ color: 'var(--muted)', marginLeft: 4 }}>× {l.qty}</span>
                              </div>
                            ))}
                          </td>
                          <td style={{ textAlign: 'right' }}>{fmt(lineTotal)}</td>
                          <td style={{ textAlign: 'right', color: order.shipping_cost ? undefined : 'var(--warning)' }}>
                            {order.shipping_cost != null ? fmt(order.shipping_cost) : '⚠ missing'}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(total)}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className="btn btn-primary"
                              style={{ fontSize: '0.8rem' }}
                              onClick={() => { setCreating(order); setShipping(order.shipping_cost != null ? String(order.shipping_cost) : '') }}
                            >
                              Create Invoice
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {uninvoiced.length === 0 && invoiced.length === 0 && (
            <div className="card">
              <div className="card-body empty">No Turn5 orders found. Orders synced from ShipStation with channel "turn5" will appear here.</div>
            </div>
          )}

          {/* ── Invoiced ──────────────────────────────────────────────── */}
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
                      <th>PO Number</th>
                      <th>Issue Date</th>
                      <th>Due Date</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoiced.map((order) => {
                      const inv = invoiceMap.get(order.id)!
                      const total = orderTotal(order, inv.shipping_cost)
                      return (
                        <tr key={order.id}>
                          <td style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.85rem' }}>
                            TURN INV-{order.order_number}
                          </td>
                          <td style={{ color: 'var(--muted)' }}>{order.order_number}</td>
                          <td style={{ color: 'var(--muted)' }}>{fmtDate(inv.issue_date)}</td>
                          <td style={{ color: 'var(--muted)' }}>{fmtDate(inv.due_date)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(total)}</td>
                          <td>
                            {inv.status === 'sent' ? (
                              <span style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success)', borderRadius: 20, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 700 }}>
                                ✓ Sent {inv.sent_at ? fmtDate(inv.sent_at) : ''}
                              </span>
                            ) : (
                              <span style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--warning)', borderRadius: 20, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 700 }}>
                                Draft
                              </span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <a
                                href={`/invoices/${inv.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn btn-secondary"
                                style={{ fontSize: '0.78rem' }}
                              >
                                🖨 Print
                              </a>
                              {inv.status === 'draft' && (
                                <button
                                  className="btn btn-primary"
                                  style={{ fontSize: '0.78rem', background: 'var(--success)', borderColor: 'var(--success)' }}
                                  onClick={() => void markSent(inv.id)}
                                >
                                  ✓ Mark Sent
                                </button>
                              )}
                              <button
                                className="btn btn-secondary"
                                style={{ fontSize: '0.78rem', color: 'var(--danger)' }}
                                onClick={() => void deleteInvoice(inv.id)}
                              >
                                ✕
                              </button>
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

      {/* ── Create Invoice Modal ───────────────────────────────────────── */}
      {creating && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: 'var(--panel-1)', borderRadius: 12, padding: 28, width: '100%', maxWidth: 440, border: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 800, fontSize: '1.05rem', marginBottom: 18 }}>
              Create Invoice — PO #{creating.order_number}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Line Items</div>
              {creating.order_lines.map((l) => (
                <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '0.88rem' }}>
                  <span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.ss_sku ?? '—'}</span>
                    <span style={{ color: 'var(--muted)', marginLeft: 8 }}>× {l.qty}</span>
                  </span>
                  <span style={{ fontWeight: 600 }}>{fmt((l.unit_price ?? 0) * l.qty)}</span>
                </div>
              ))}
            </div>

            <div style={{ marginBottom: 20 }}>
              <label className="label">Shipping Cost ($)</label>
              <input
                className="field"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={shippingInput}
                onChange={(e) => setShipping(e.target.value)}
                autoFocus
              />
              {creating.shipping_cost == null && (
                <div style={{ fontSize: '0.75rem', color: 'var(--warning)', marginTop: 4 }}>
                  ⚠ No shipping cost on this order — enter it manually
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '1rem', marginBottom: 24, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <span>Total</span>
              <span>{fmt(orderTotal(creating, shippingInput.trim() !== '' ? parseFloat(shippingInput) : creating.shipping_cost))}</span>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={saving}
                onClick={() => void createInvoice(creating)}
              >
                {saving ? 'Creating…' : '📄 Create & Open Invoice'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => { setCreating(null); setShipping('') }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
