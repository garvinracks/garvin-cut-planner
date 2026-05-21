'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type SKU = { id: string; description: string; bolt_kit_cost: number | null }

type BatchNeed = {
  batch_id: string
  batch_name: string
  status: string
  lines: { sku_id: string; qty: number }[]
}

type OrderLine = { sku_id: string; qty: string }

type SavedOrder = {
  id: string
  order_date: string
  supplier: string
  shipping_cost: number | null
  notes: string | null
  created_at: string
  bolt_kit_order_lines: {
    id: string
    sku_id: string
    qty: number
    unit_cost: number
    true_cost: number | null
    skus: { description: string } | null
  }[]
}

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return '$' + n.toFixed(2)
}
function fmtDate(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function isPending(ord: SavedOrder) {
  return ord.bolt_kit_order_lines.every((l) => !l.unit_cost || l.unit_cost === 0)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BoltKitsPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [skus, setSkus]               = useState<SKU[]>([])
  const [orders, setOrders]           = useState<SavedOrder[]>([])
  const [batches, setBatches]         = useState<BatchNeed[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading]         = useState(true)
  const [copied, setCopied]           = useState(false)
  const [saving, setSaving]           = useState(false)
  const [message, setMessage]         = useState('')
  const [msgOk, setMsgOk]             = useState(true)

  // Step 1 form — just SKU + qty
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().split('T')[0])
  const [supplier, setSupplier]   = useState('Ababa')
  const [notes, setNotes]         = useState('')
  const [lines, setLines]         = useState<OrderLine[]>([{ sku_id: '', qty: '1' }])

  // Step 2 — enter invoice on a saved order
  const [invoicingId, setInvoicingId]       = useState<string | null>(null)
  const [invoiceLineCosts, setInvoiceLineCosts] = useState<Record<string, string>>({})  // lineId → price
  const [invoiceShipping, setInvoiceShipping]   = useState('')

  function showMsg(text: string, ok = true) {
    setMessage(text); setMsgOk(ok)
    setTimeout(() => setMessage(''), 5000)
  }

  async function load() {
    const [{ data: skuData }, { data: ordData }, { data: batchData }] = await Promise.all([
      supabase.from('skus').select('id, description, bolt_kit_cost').eq('active', true).order('id'),
      supabase
        .from('bolt_kit_orders')
        .select('id, order_date, supplier, shipping_cost, notes, created_at, bolt_kit_order_lines(id, sku_id, qty, unit_cost, true_cost, skus(description))')
        .order('order_date', { ascending: false }),
      supabase
        .from('build_batches')
        .select('id, name, status, build_batch_lines(sku_id, qty)')
        .not('status', 'eq', 'complete')
        .order('created_at', { ascending: false }),
    ])
    setSkus((skuData ?? []) as SKU[])
    setOrders((ordData ?? []) as unknown as SavedOrder[])
    setBatches((batchData ?? []).map((b: any) => ({
      batch_id:   b.id,
      batch_name: b.name ?? b.id,
      status:     b.status,
      lines:      (b.build_batch_lines ?? []).filter((l: any) => l.sku_id).map((l: any) => ({ sku_id: l.sku_id, qty: l.qty })),
    })))
    setLoading(false)
  }

  useEffect(() => { void load() }, [])

  // ── Actions ───────────────────────────────────────────────────────────────

  function prefillFromSelected() {
    const merged = new Map<string, number>()
    for (const b of batches.filter((b) => selectedIds.has(b.batch_id))) {
      for (const l of b.lines) merged.set(l.sku_id, (merged.get(l.sku_id) ?? 0) + l.qty)
    }
    setLines([...merged.entries()].map(([sku_id, qty]) => ({ sku_id, qty: String(qty) })))
  }

  function addLine() { setLines((p) => [...p, { sku_id: '', qty: '1' }]) }
  function removeLine(i: number) { setLines((p) => p.filter((_, j) => j !== i)) }
  function updateLine(i: number, field: keyof OrderLine, val: string) {
    setLines((p) => p.map((l, j) => j === i ? { ...l, [field]: val } : l))
  }

  // Step 1: save order with no prices yet
  async function saveOrder() {
    const valid = lines.filter((l) => l.sku_id && l.qty)
    if (valid.length === 0) { showMsg('Add at least one SKU.', false); return }
    setSaving(true)

    const { data: ord, error: ordErr } = await supabase
      .from('bolt_kit_orders')
      .insert({ order_date: orderDate, supplier, shipping_cost: 0, notes: notes || null })
      .select('id').single()

    if (ordErr || !ord) { showMsg('Error saving order: ' + ordErr?.message, false); setSaving(false); return }

    const { error: lineErr } = await supabase.from('bolt_kit_order_lines').insert(
      valid.map((l) => ({ order_id: ord.id, sku_id: l.sku_id, qty: parseInt(l.qty) || 1, unit_cost: 0, true_cost: null }))
    )
    if (lineErr) { showMsg('Error saving lines: ' + lineErr.message, false); setSaving(false); return }

    setSaving(false)
    showMsg('✓ Order saved. Enter the invoice when it arrives.', true)
    setLines([{ sku_id: '', qty: '1' }])
    setNotes('')
    setSelectedIds(new Set())
    await load()
  }

  // Step 2: enter invoice — update prices + shipping, recalculate true costs
  async function saveInvoice(ord: SavedOrder) {
    setSaving(true)
    const shippingN = parseFloat(invoiceShipping) || 0
    const totalQty  = ord.bolt_kit_order_lines.reduce((s, l) => s + l.qty, 0)
    const shipPerUnit = totalQty > 0 ? shippingN / totalQty : 0

    // Update each line with unit_cost + true_cost
    let skuCostUpdates = 0
    for (const line of ord.bolt_kit_order_lines) {
      const unitCost = parseFloat(invoiceLineCosts[line.id] ?? '0') || 0
      const trueCost = unitCost + shipPerUnit
      await supabase.from('bolt_kit_order_lines').update({ unit_cost: unitCost, true_cost: trueCost }).eq('id', line.id)
      const { error } = await supabase.from('skus').update({ bolt_kit_cost: trueCost }).eq('id', line.sku_id)
      if (!error) skuCostUpdates++
    }

    // Update order with shipping
    await supabase.from('bolt_kit_orders').update({ shipping_cost: shippingN }).eq('id', ord.id)

    setSaving(false)
    setInvoicingId(null)
    setInvoiceLineCosts({})
    setInvoiceShipping('')
    showMsg(`✓ Invoice saved. Updated costs on ${skuCostUpdates} SKU${skuCostUpdates !== 1 ? 's' : ''}.`, true)
    await load()
  }

  async function deleteOrder(id: string) {
    if (!confirm('Delete this order? SKU costs will not be reverted.')) return
    await supabase.from('bolt_kit_orders').delete().eq('id', id)
    await load()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const skuMap = useMemo(() => new Map(skus.map((s) => [s.id, s.description])), [skus])
  const skuIdLines = lines.filter((l) => l.sku_id && l.qty)
  const totalQtyForm = skuIdLines.reduce((s, l) => s + (parseInt(l.qty) || 0), 0)

  return (
    <main className="container" style={{ paddingTop: 32, paddingBottom: 64 }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>Bolt Kit Orders</h1>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 4 }}>
          Log what you ordered → enter the invoice when it arrives → SKU costs update automatically.
        </p>
      </div>

      {/* ── Kits Needed by Batch ── */}
      {!loading && batches.length > 0 && (
        <section className="card" style={{ marginBottom: 24 }}>
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h2 className="card-title">Kits Needed by Batch</h2>
              <div className="card-subtitle">Select batches to pre-fill the order form below</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {selectedIds.size > 0 && (
                <button type="button" className="btn btn-secondary" style={{ fontSize: '0.82rem' }}
                  onClick={() => {
                    const merged = new Map<string, { qty: number; desc: string }>()
                    for (const b of batches.filter((b) => selectedIds.has(b.batch_id))) {
                      for (const l of b.lines) {
                        const e = merged.get(l.sku_id)
                        const desc = skuMap.get(l.sku_id) ?? l.sku_id
                        if (e) { e.qty += l.qty } else { merged.set(l.sku_id, { qty: l.qty, desc }) }
                      }
                    }
                    const text = [...merged.entries()].map(([id, { qty, desc }]) => `${id} × ${qty}  — ${desc}`).join('\n')
                    void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500) })
                  }}
                >{copied ? '✓ Copied!' : '📋 Copy List'}</button>
              )}
              {selectedIds.size > 0 && (
                <button type="button" className="btn btn-primary" style={{ fontSize: '0.82rem' }} onClick={prefillFromSelected}>
                  ↓ Pre-fill Order ({selectedIds.size} batch{selectedIds.size !== 1 ? 'es' : ''})
                </button>
              )}
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {batches.map((b) => {
              const checked = selectedIds.has(b.batch_id)
              const isPowder = b.status === 'at_powder'
              const statusColor = isPowder ? 'var(--warning)' : b.status === 'in_progress' ? 'var(--success)' : 'var(--muted)'
              return (
                <div key={b.batch_id} style={{ borderBottom: '1px solid var(--border)', padding: '12px 20px', background: checked ? 'rgba(99,102,241,0.06)' : undefined, display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <input type="checkbox" checked={checked} disabled={isPowder}
                    onChange={(e) => setSelectedIds((prev) => { const n = new Set(prev); e.target.checked ? n.add(b.batch_id) : n.delete(b.batch_id); return n })}
                    style={{ marginTop: 3, cursor: isPowder ? 'not-allowed' : 'pointer' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{b.batch_name}</span>
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: statusColor, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{b.status.replace(/_/g, ' ')}</span>
                      {isPowder && <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>(already ordered)</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {b.lines.map((l) => (
                        <span key={l.sku_id} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 10px', fontSize: '0.78rem' }}>
                          <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.sku_id}</span>
                          <span style={{ color: 'var(--muted)', marginLeft: 5 }}>× {l.qty}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {message && (
        <div style={{ background: msgOk ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${msgOk ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, color: msgOk ? 'var(--success)' : 'var(--danger)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: '0.85rem' }}>
          {message}
        </div>
      )}

      {/* ── Step 1: Log New Order ── */}
      <section className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <h2 className="card-title">Step 1 — Log Order</h2>
          <div className="card-subtitle">Just record what you ordered. Enter prices when the invoice arrives.</div>
        </div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 12, marginBottom: 20 }}>
            <div>
              <label className="label">Order Date</label>
              <input className="field" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
            </div>
            <div>
              <label className="label">Supplier</label>
              <input className="field" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </div>
            <div>
              <label className="label">Notes</label>
              <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
            </div>
          </div>

          <table className="table" style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th>SKU</th>
                <th style={{ textAlign: 'center', width: 100 }}>Qty Ordered</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => (
                <tr key={idx}>
                  <td>
                    <select className="select" value={line.sku_id} onChange={(e) => updateLine(idx, 'sku_id', e.target.value)} style={{ fontSize: '0.83rem' }}>
                      <option value="">— select SKU —</option>
                      {skus.map((s) => <option key={s.id} value={s.id}>{s.id} — {s.description}</option>)}
                    </select>
                  </td>
                  <td>
                    <input className="field" type="number" min="1" step="1" value={line.qty} onChange={(e) => updateLine(idx, 'qty', e.target.value)} style={{ textAlign: 'center' }} />
                  </td>
                  <td>
                    <button type="button" style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: '1rem' }} onClick={() => removeLine(idx)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button type="button" className="btn btn-secondary" style={{ fontSize: '0.82rem' }} onClick={addLine}>+ Add SKU</button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {skuIdLines.length > 0 && (
                <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{totalQtyForm} kits</span>
              )}
              <button type="button" className="btn btn-primary" disabled={saving || skuIdLines.length === 0} onClick={() => void saveOrder()}>
                {saving ? 'Saving…' : '✓ Save Order'}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Order History ── */}
      {!loading && orders.length > 0 && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Order History</h2>
            <div className="card-subtitle">{orders.length} order{orders.length !== 1 ? 's' : ''}</div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {orders.map((ord) => {
              const pending    = isPending(ord)
              const isEditing  = invoicingId === ord.id
              const totalKits  = ord.bolt_kit_order_lines.reduce((s, l) => s + l.qty, 0)
              const lineTotal  = ord.bolt_kit_order_lines.reduce((s, l) => s + l.unit_cost * l.qty, 0)
              const shipN      = parseFloat(invoiceShipping) || 0
              const shipPerUnit = isEditing && totalKits > 0 ? shipN / totalKits : 0

              return (
                <div key={ord.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  {/* Order header row */}
                  <div style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{ord.supplier}</span>
                      <span style={{ color: 'var(--muted)', fontSize: '0.82rem', marginLeft: 12 }}>{fmtDate(ord.order_date)}</span>
                      <span style={{ color: 'var(--muted)', fontSize: '0.82rem', marginLeft: 12 }}>{totalKits} kits</span>
                      {!pending && <span style={{ color: 'var(--muted)', fontSize: '0.82rem', marginLeft: 8 }}>· {fmt(lineTotal + (ord.shipping_cost ?? 0))} total</span>}
                      {ord.notes && <span style={{ color: 'var(--muted)', fontSize: '0.8rem', marginLeft: 12, fontStyle: 'italic' }}>{ord.notes}</span>}
                      {pending && (
                        <span style={{ marginLeft: 12, background: 'rgba(245,158,11,0.15)', color: 'var(--warning)', borderRadius: 20, padding: '2px 10px', fontSize: '0.72rem', fontWeight: 700 }}>
                          ⏳ Awaiting Invoice
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {pending && !isEditing && (
                        <button type="button" className="btn btn-primary" style={{ fontSize: '0.75rem' }}
                          onClick={() => {
                            setInvoicingId(ord.id)
                            const costs: Record<string, string> = {}
                            ord.bolt_kit_order_lines.forEach((l) => { costs[l.id] = '' })
                            setInvoiceLineCosts(costs)
                            setInvoiceShipping('')
                          }}>
                          📄 Enter Invoice
                        </button>
                      )}
                      {isEditing && (
                        <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem' }} onClick={() => setInvoicingId(null)}>
                          Cancel
                        </button>
                      )}
                      <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', color: 'var(--danger)' }} onClick={() => void deleteOrder(ord.id)}>
                        ✕ Delete
                      </button>
                    </div>
                  </div>

                  {/* SKU chips */}
                  <div style={{ padding: '0 20px 12px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {ord.bolt_kit_order_lines.map((l) => (
                      <div key={l.id} style={{ background: 'var(--panel-2)', borderRadius: 6, padding: '4px 10px', fontSize: '0.78rem', border: '1px solid var(--border)' }}>
                        <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.sku_id}</span>
                        <span style={{ color: 'var(--muted)', marginLeft: 6 }}>×{l.qty}</span>
                        {!pending && <span style={{ marginLeft: 6 }}>{fmt(l.unit_cost)}/kit</span>}
                        {l.true_cost != null && l.true_cost !== l.unit_cost && (
                          <span style={{ marginLeft: 4, color: 'var(--success)' }}>→ {fmt(l.true_cost)} true</span>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Step 2: Enter Invoice inline form */}
                  {isEditing && (
                    <div style={{ margin: '0 20px 16px', background: 'var(--panel-2)', borderRadius: 10, padding: '16px 18px', border: '1px solid var(--border)' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.88rem', marginBottom: 14 }}>Step 2 — Enter Invoice from {ord.supplier}</div>

                      <table className="table" style={{ marginBottom: 14 }}>
                        <thead>
                          <tr>
                            <th>SKU</th>
                            <th style={{ textAlign: 'center' }}>Qty</th>
                            <th style={{ textAlign: 'right', width: 130 }}>Kit Price ($/ea)</th>
                            <th style={{ textAlign: 'right', width: 130 }}>+ Ship/unit</th>
                            <th style={{ textAlign: 'right', width: 110 }}>True Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ord.bolt_kit_order_lines.map((l) => {
                            const unitC = parseFloat(invoiceLineCosts[l.id] ?? '') || 0
                            const trueC = unitC + shipPerUnit
                            return (
                              <tr key={l.id}>
                                <td>
                                  <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.sku_id}</span>
                                  <span style={{ color: 'var(--muted)', fontSize: '0.78rem', marginLeft: 8 }}>{skuMap.get(l.sku_id) ?? ''}</span>
                                </td>
                                <td style={{ textAlign: 'center' }}>{l.qty}</td>
                                <td>
                                  <input
                                    className="field" type="number" step="0.01" min="0"
                                    value={invoiceLineCosts[l.id] ?? ''}
                                    onChange={(e) => setInvoiceLineCosts((p) => ({ ...p, [l.id]: e.target.value }))}
                                    placeholder="0.00"
                                    style={{ textAlign: 'right' }}
                                  />
                                </td>
                                <td style={{ textAlign: 'right', fontSize: '0.8rem', color: 'var(--muted)' }}>
                                  {shipPerUnit > 0 ? `+$${shipPerUnit.toFixed(3)}` : '—'}
                                </td>
                                <td style={{ textAlign: 'right', fontWeight: 700, color: unitC > 0 ? 'var(--success)' : 'var(--muted)' }}>
                                  {unitC > 0 ? `$${trueC.toFixed(2)}` : '—'}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <label className="label" style={{ margin: 0 }}>Total Shipping ($)</label>
                          <input
                            className="field" type="number" step="0.01" min="0"
                            value={invoiceShipping}
                            onChange={(e) => setInvoiceShipping(e.target.value)}
                            placeholder="0.00"
                            style={{ width: 110 }}
                          />
                          {shipPerUnit > 0 && (
                            <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>= ${shipPerUnit.toFixed(3)}/kit prorated</span>
                          )}
                        </div>
                        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void saveInvoice(ord)}>
                          {saving ? 'Saving…' : '✓ Save Invoice & Update SKU Costs'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {!loading && orders.length === 0 && (
        <div className="card">
          <div className="card-body empty">No bolt kit orders yet. Select batches above and log your first order.</div>
        </div>
      )}
    </main>
  )
}
