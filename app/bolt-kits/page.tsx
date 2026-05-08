'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type SKU = { id: string; description: string; bolt_kit_cost: number | null }

type KitNeed = { sku_id: string; description: string; qty: number }

type OrderLine = {
  sku_id: string
  qty: string
  unit_cost: string
  // derived
  skuDesc?: string
  trueCost?: number
}

type SavedOrder = {
  id: string
  order_date: string
  supplier: string
  shipping_cost: number
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function BoltKitsPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [skus, setSkus]       = useState<SKU[]>([])
  const [orders, setOrders]   = useState<SavedOrder[]>([])
  const [needs, setNeeds]     = useState<KitNeed[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied]   = useState(false)
  const [saving, setSaving]   = useState(false)
  const [message, setMessage] = useState('')
  const [msgOk, setMsgOk]     = useState(true)

  // New order form
  const [orderDate, setOrderDate]       = useState(() => new Date().toISOString().split('T')[0])
  const [supplier, setSupplier]         = useState('Ababa')
  const [shippingCost, setShippingCost] = useState('')
  const [notes, setNotes]               = useState('')
  const [lines, setLines]               = useState<OrderLine[]>([{ sku_id: '', qty: '1', unit_cost: '' }])

  function showMsg(text: string, ok = true) {
    setMessage(text); setMsgOk(ok)
    setTimeout(() => setMessage(''), 5000)
  }

  async function load() {
    const [{ data: skuData }, { data: ordData }, { data: openLines }] = await Promise.all([
      supabase.from('skus').select('id, description, bolt_kit_cost').eq('active', true).order('id'),
      supabase
        .from('bolt_kit_orders')
        .select('id, order_date, supplier, shipping_cost, notes, created_at, bolt_kit_order_lines(id, sku_id, qty, unit_cost, true_cost, skus(description))')
        .order('order_date', { ascending: false }),
      // Active build batches with their lines → tally kit needs
      supabase
        .from('build_batches')
        .select('id, status, build_batch_lines(sku_id, qty)')
        .in('status', ['draft', 'planned', 'in_progress']),
    ])
    const skuMap = new Map<string, string>((skuData ?? []).map((s: any) => [s.id, s.description]))
    setSkus((skuData ?? []) as SKU[])
    setOrders((ordData ?? []) as unknown as SavedOrder[])

    // Flatten lines from all active batches and aggregate qty by SKU
    const needMap = new Map<string, KitNeed>()
    for (const batch of (openLines ?? []) as any[]) {
      for (const line of (batch.build_batch_lines ?? [])) {
        if (!line.sku_id) continue
        const existing = needMap.get(line.sku_id)
        const desc = skuMap.get(line.sku_id) ?? line.sku_id
        if (existing) { existing.qty += line.qty }
        else { needMap.set(line.sku_id, { sku_id: line.sku_id, description: desc, qty: line.qty }) }
      }
    }
    setNeeds([...needMap.values()].sort((a, b) => a.sku_id.localeCompare(b.sku_id)))

    setLoading(false)
  }

  useEffect(() => { void load() }, [])

  // ── Derived ───────────────────────────────────────────────────────────────

  const validLines = lines.filter((l) => l.sku_id && l.qty && l.unit_cost)

  const totalQty  = validLines.reduce((s, l) => s + (parseInt(l.qty) || 0), 0)
  const shippingN = parseFloat(shippingCost) || 0
  const shipPerUnit = totalQty > 0 ? shippingN / totalQty : 0

  const previewLines = validLines.map((l) => ({
    ...l,
    skuDesc: skus.find((s) => s.id === l.sku_id)?.description ?? l.sku_id,
    trueCost: (parseFloat(l.unit_cost) || 0) + shipPerUnit,
  }))

  const orderTotal = validLines.reduce((s, l) => s + (parseFloat(l.unit_cost) || 0) * (parseInt(l.qty) || 0), 0) + shippingN

  // ── Actions ───────────────────────────────────────────────────────────────

  function addLine() {
    setLines((prev) => [...prev, { sku_id: '', qty: '1', unit_cost: '' }])
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx))
  }

  function updateLine(idx: number, field: keyof OrderLine, value: string) {
    setLines((prev) => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l))
  }

  async function saveOrder() {
    if (validLines.length === 0) { showMsg('Add at least one SKU line.', false); return }
    setSaving(true)

    // Insert order
    const { data: ord, error: ordErr } = await supabase
      .from('bolt_kit_orders')
      .insert({ order_date: orderDate, supplier, shipping_cost: shippingN, notes: notes || null })
      .select('id')
      .single()

    if (ordErr || !ord) { showMsg('Error saving order: ' + ordErr?.message, false); setSaving(false); return }

    // Insert lines
    const linePayload = previewLines.map((l) => ({
      order_id:  ord.id,
      sku_id:    l.sku_id,
      qty:       parseInt(l.qty),
      unit_cost: parseFloat(l.unit_cost),
      true_cost: l.trueCost,
    }))
    const { error: lineErr } = await supabase.from('bolt_kit_order_lines').insert(linePayload)
    if (lineErr) { showMsg('Error saving lines: ' + lineErr.message, false); setSaving(false); return }

    // Auto-update bolt_kit_cost on each SKU
    let updated = 0
    for (const l of previewLines) {
      const { error } = await supabase
        .from('skus')
        .update({ bolt_kit_cost: l.trueCost })
        .eq('id', l.sku_id)
      if (!error) updated++
    }

    setSaving(false)
    showMsg(`✓ Order saved. Updated bolt kit cost on ${updated} SKU${updated !== 1 ? 's' : ''}.`, true)

    // Reset form
    setLines([{ sku_id: '', qty: '1', unit_cost: '' }])
    setShippingCost('')
    setNotes('')
    await load()
  }

  async function deleteOrder(id: string) {
    if (!confirm('Delete this order? SKU costs will not be reverted.')) return
    await supabase.from('bolt_kit_orders').delete().eq('id', id)
    await load()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="container" style={{ paddingTop: 32, paddingBottom: 64 }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>Bolt Kit Orders</h1>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 4 }}>
          Log Ababa orders — shipping is prorated per kit and SKU costs update automatically.
        </p>
      </div>

      {/* ── Kits Needed ── */}
      {!loading && needs.length > 0 && (
        <section className="card" style={{ marginBottom: 24 }}>
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h2 className="card-title">Kits Needed</h2>
              <div className="card-subtitle">From active build batches (draft / planned / in progress)</div>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '0.82rem' }}
              onClick={() => {
                const text = needs.map((n) => `${n.sku_id} × ${n.qty}  — ${n.description}`).join('\n')
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2500)
                })
              }}
            >
              {copied ? '✓ Copied!' : '📋 Copy List'}
            </button>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'center' }}>Qty Needed</th>
                </tr>
              </thead>
              <tbody>
                {needs.map((n) => (
                  <tr key={n.sku_id}>
                    <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{n.sku_id}</td>
                    <td style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>{n.description}</td>
                    <td style={{ textAlign: 'center', fontWeight: 700, fontSize: '1rem' }}>{n.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {message && (
        <div style={{
          background: msgOk ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          border: `1px solid ${msgOk ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
          color: msgOk ? 'var(--success)' : 'var(--danger)',
          borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: '0.85rem',
        }}>
          {message}
        </div>
      )}

      {/* ── New Order Form ── */}
      <section className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <h2 className="card-title">Log New Order</h2>
        </div>
        <div className="card-body">

          {/* Header fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 2fr', gap: 12, marginBottom: 20 }}>
            <div>
              <label className="label">Order Date</label>
              <input className="field" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
            </div>
            <div>
              <label className="label">Supplier</label>
              <input className="field" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </div>
            <div>
              <label className="label">Shipping Cost ($)</label>
              <input
                className="field" type="number" step="0.01" min="0"
                value={shippingCost}
                onChange={(e) => setShippingCost(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="label">Notes</label>
              <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
            </div>
          </div>

          {/* Line items */}
          <table className="table" style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th>SKU</th>
                <th style={{ textAlign: 'center', width: 90 }}>Qty</th>
                <th style={{ textAlign: 'right', width: 130 }}>Kit Price ($)</th>
                <th style={{ textAlign: 'right', width: 140 }}>+ Ship/unit</th>
                <th style={{ textAlign: 'right', width: 130 }}>True Cost</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => {
                const unitC = parseFloat(line.unit_cost) || 0
                const truC  = unitC + shipPerUnit
                return (
                  <tr key={idx}>
                    <td>
                      <select
                        className="select"
                        value={line.sku_id}
                        onChange={(e) => updateLine(idx, 'sku_id', e.target.value)}
                        style={{ fontSize: '0.83rem' }}
                      >
                        <option value="">— select SKU —</option>
                        {skus.map((s) => (
                          <option key={s.id} value={s.id}>{s.id} — {s.description}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="field" type="number" min="1" step="1"
                        value={line.qty}
                        onChange={(e) => updateLine(idx, 'qty', e.target.value)}
                        style={{ textAlign: 'center' }}
                      />
                    </td>
                    <td>
                      <input
                        className="field" type="number" step="0.01" min="0"
                        value={line.unit_cost}
                        onChange={(e) => updateLine(idx, 'unit_cost', e.target.value)}
                        placeholder="0.00"
                        style={{ textAlign: 'right' }}
                      />
                    </td>
                    <td style={{ textAlign: 'right', fontSize: '0.8rem', color: 'var(--muted)' }}>
                      {shipPerUnit > 0 ? `+$${shipPerUnit.toFixed(3)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: line.unit_cost ? 'var(--success)' : 'var(--muted)' }}>
                      {line.unit_cost ? `$${truC.toFixed(2)}` : '—'}
                    </td>
                    <td>
                      <button
                        type="button"
                        style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: '1rem' }}
                        onClick={() => removeLine(idx)}
                      >✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button type="button" className="btn btn-secondary" style={{ fontSize: '0.82rem' }} onClick={addLine}>
              + Add SKU
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              {validLines.length > 0 && (
                <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                  {totalQty} kits &nbsp;·&nbsp; Order total: <strong style={{ color: 'var(--text)' }}>${orderTotal.toFixed(2)}</strong>
                </div>
              )}
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving || validLines.length === 0}
                onClick={() => void saveOrder()}
              >
                {saving ? 'Saving…' : '✓ Save Order & Update SKU Costs'}
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
              const totalKits = ord.bolt_kit_order_lines.reduce((s, l) => s + l.qty, 0)
              const lineTotal = ord.bolt_kit_order_lines.reduce((s, l) => s + l.unit_cost * l.qty, 0)
              return (
                <div key={ord.id} style={{ borderBottom: '1px solid var(--border)', padding: '14px 20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{ord.supplier}</span>
                      <span style={{ color: 'var(--muted)', fontSize: '0.82rem', marginLeft: 12 }}>{fmtDate(ord.order_date)}</span>
                      <span style={{ color: 'var(--muted)', fontSize: '0.82rem', marginLeft: 12 }}>{totalKits} kits · {fmt(lineTotal + ord.shipping_cost)} total</span>
                      {ord.shipping_cost > 0 && (
                        <span style={{ color: 'var(--muted)', fontSize: '0.82rem', marginLeft: 12 }}>({fmt(ord.shipping_cost)} shipping)</span>
                      )}
                      {ord.notes && <span style={{ color: 'var(--muted)', fontSize: '0.8rem', marginLeft: 12, fontStyle: 'italic' }}>{ord.notes}</span>}
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ fontSize: '0.75rem', color: 'var(--danger)' }}
                      onClick={() => void deleteOrder(ord.id)}
                    >✕ Delete</button>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {ord.bolt_kit_order_lines.map((l) => (
                      <div key={l.id} style={{
                        background: 'var(--panel-2)', borderRadius: 6, padding: '4px 10px',
                        fontSize: '0.78rem', border: '1px solid var(--border)',
                      }}>
                        <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.sku_id}</span>
                        <span style={{ color: 'var(--muted)', marginLeft: 6 }}>×{l.qty}</span>
                        <span style={{ marginLeft: 6 }}>${l.unit_cost.toFixed(2)}/kit</span>
                        {l.true_cost != null && l.true_cost !== l.unit_cost && (
                          <span style={{ marginLeft: 4, color: 'var(--success)' }}>→ ${l.true_cost.toFixed(2)} true</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {!loading && orders.length === 0 && (
        <div className="card">
          <div className="card-body empty">No bolt kit orders yet. Log your first order above.</div>
        </div>
      )}
    </main>
  )
}
