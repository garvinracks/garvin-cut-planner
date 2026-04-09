'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type SKU = {
  id: string
  description: string
}

type Part = {
  id: string
  weight_lbs: number | null
  requires_powder: boolean
}

type SkuPartRow = {
  sku_id: string
  part_id: string
  qty: number
}

type SkuSubAssemblyRow = {
  sku_id: string
  sub_assembly_id: string
  qty: number
}

type SubAssemblyPartRow = {
  sub_assembly_id: string
  part_id: string
  qty: number
}

type PowderBatch = {
  id: string
  batch_name: string
  batch_date: string | null
  total_cost: number
  notes: string | null
  created_at: string
}

type PowderBatchItem = {
  id: string
  powder_batch_id: string
  sku_id: string
  qty: number
  weight_lbs_each: number | null
}

type FormItem = {
  key: number
  sku_id: string
  qty: string
  weight_lbs_each: number | null
  missingWeight: boolean
  skuSearch: string
  showDropdown: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return '$' + n.toFixed(2)
}

function fmtLbs(n: number | null | undefined) {
  if (n == null) return '—'
  return n.toFixed(2) + ' lbs'
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

let keyCounter = 0
function nextKey() {
  return ++keyCounter
}

// ── SKU weight calculator ─────────────────────────────────────────────────────

function calcSkuWeight(
  skuId: string,
  skuParts: SkuPartRow[],
  skuSubs: SkuSubAssemblyRow[],
  subParts: SubAssemblyPartRow[],
  partsMap: Map<string, Part>,
): { weight: number | null; missingWeight: boolean } {
  let total = 0
  let missing = false

  // Direct parts on SKU
  for (const sp of skuParts) {
    if (sp.sku_id !== skuId) continue
    const part = partsMap.get(sp.part_id)
    if (!part || !part.requires_powder) continue
    if (part.weight_lbs == null) { missing = true; continue }
    total += part.weight_lbs * sp.qty
  }

  // Sub-assembly parts
  for (const ss of skuSubs) {
    if (ss.sku_id !== skuId) continue
    for (const sap of subParts) {
      if (sap.sub_assembly_id !== ss.sub_assembly_id) continue
      const part = partsMap.get(sap.part_id)
      if (!part || !part.requires_powder) continue
      if (part.weight_lbs == null) { missing = true; continue }
      total += part.weight_lbs * sap.qty * ss.qty
    }
  }

  return { weight: total === 0 && !missing ? null : total, missingWeight: missing }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PowderPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  // ── Data ────────────────────────────────────────────────────────────────────
  const [skus, setSkus] = useState<SKU[]>([])
  const [partsMap, setPartsMap] = useState<Map<string, Part>>(new Map())
  const [skuParts, setSkuParts] = useState<SkuPartRow[]>([])
  const [skuSubs, setSkuSubs] = useState<SkuSubAssemblyRow[]>([])
  const [subParts, setSubParts] = useState<SubAssemblyPartRow[]>([])

  const [batches, setBatches] = useState<PowderBatch[]>([])
  const [batchItems, setBatchItems] = useState<Map<string, PowderBatchItem[]>>(new Map())

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [messageOk, setMessageOk] = useState(false)

  // ── Form state ───────────────────────────────────────────────────────────────
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDate, setFormDate] = useState(todayIso())
  const [formCost, setFormCost] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formItems, setFormItems] = useState<FormItem[]>([
    { key: nextKey(), sku_id: '', qty: '1', weight_lbs_each: null, missingWeight: false, skuSearch: '', showDropdown: false },
  ])

  // ── Detail view ─────────────────────────────────────────────────────────────
  const [detailBatchId, setDetailBatchId] = useState<string | null>(null)

  // ── Load ─────────────────────────────────────────────────────────────────────
  async function load() {
    setLoading(true)

    const [
      { data: skuData },
      { data: partsData },
      { data: skuPartsData },
      { data: skuSubsData },
      { data: subPartsData },
      { data: batchData },
      { data: batchItemsData },
    ] = await Promise.all([
      supabase.from('skus').select('id, description').order('id'),
      supabase.from('parts').select('id, weight_lbs, requires_powder').eq('requires_powder', true),
      supabase.from('sku_parts').select('sku_id, part_id, qty'),
      supabase.from('sku_sub_assemblies').select('sku_id, sub_assembly_id, qty'),
      supabase.from('sub_assembly_parts').select('sub_assembly_id, part_id, qty'),
      supabase.from('powder_batches').select('*').order('batch_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('powder_batch_items').select('*'),
    ])

    setSkus((skuData ?? []) as SKU[])

    const pm = new Map<string, Part>()
    for (const p of (partsData ?? []) as Part[]) pm.set(p.id, p)
    setPartsMap(pm)

    setSkuParts((skuPartsData ?? []) as SkuPartRow[])
    setSkuSubs((skuSubsData ?? []) as SkuSubAssemblyRow[])
    setSubParts((subPartsData ?? []) as SubAssemblyPartRow[])
    setBatches((batchData ?? []) as PowderBatch[])

    const bim = new Map<string, PowderBatchItem[]>()
    for (const item of (batchItemsData ?? []) as PowderBatchItem[]) {
      const arr = bim.get(item.powder_batch_id) ?? []
      arr.push(item)
      bim.set(item.powder_batch_id, arr)
    }
    setBatchItems(bim)

    setLoading(false)
  }

  useEffect(() => { void load() }, [])

  // ── Derived batch stats ───────────────────────────────────────────────────────
  function batchStats(b: PowderBatch) {
    const items = batchItems.get(b.id) ?? []
    const totalWeight = items.reduce((s, i) => s + (i.weight_lbs_each ?? 0) * i.qty, 0)
    const costPerLb = totalWeight > 0 ? b.total_cost / totalWeight : null
    const skuCount = items.length
    return { totalWeight, costPerLb, skuCount }
  }

  // ── Form item handlers ────────────────────────────────────────────────────────
  function updateItemSku(key: number, skuId: string, skuSearch: string) {
    setFormItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item
        if (!skuId) return { ...item, sku_id: '', skuSearch, weight_lbs_each: null, missingWeight: false, showDropdown: true }
        const { weight, missingWeight } = calcSkuWeight(skuId, skuParts, skuSubs, subParts, partsMap)
        return { ...item, sku_id: skuId, skuSearch, weight_lbs_each: weight, missingWeight, showDropdown: false }
      })
    )
  }

  function updateItemQty(key: number, qty: string) {
    setFormItems((prev) => prev.map((item) => item.key === key ? { ...item, qty } : item))
  }

  function addRow() {
    setFormItems((prev) => [
      ...prev,
      { key: nextKey(), sku_id: '', qty: '1', weight_lbs_each: null, missingWeight: false, skuSearch: '', showDropdown: false },
    ])
  }

  function removeRow(key: number) {
    setFormItems((prev) => prev.filter((item) => item.key !== key))
  }

  function resetForm() {
    setFormName('')
    setFormDate(todayIso())
    setFormCost('')
    setFormNotes('')
    setFormItems([
      { key: nextKey(), sku_id: '', qty: '1', weight_lbs_each: null, missingWeight: false, skuSearch: '', showDropdown: false },
    ])
    setMessage('')
  }

  // ── Running totals for form ───────────────────────────────────────────────────
  const formTotals = useMemo(() => {
    const validItems = formItems.filter((i) => i.sku_id && parseInt(i.qty) > 0)
    const totalWeight = validItems.reduce((s, i) => s + (i.weight_lbs_each ?? 0) * (parseInt(i.qty) || 0), 0)
    const cost = parseFloat(formCost)
    const costPerLb = totalWeight > 0 && !isNaN(cost) ? cost / totalWeight : null
    return { validItems, totalWeight, costPerLb }
  }, [formItems, formCost])

  // ── Save batch ────────────────────────────────────────────────────────────────
  async function saveBatch() {
    setMessage('')
    if (!formName.trim()) { setMessage('Batch name is required.'); setMessageOk(false); return }
    const cost = parseFloat(formCost)
    if (isNaN(cost) || cost < 0) { setMessage('Total cost must be a valid number.'); setMessageOk(false); return }
    const validItems = formItems.filter((i) => i.sku_id && parseInt(i.qty) > 0)
    if (validItems.length === 0) { setMessage('Add at least one SKU to the batch.'); setMessageOk(false); return }

    setSaving(true)

    const { data: batchRow, error: batchErr } = await supabase
      .from('powder_batches')
      .insert({
        batch_name: formName.trim(),
        batch_date: formDate || null,
        total_cost: cost,
        notes: formNotes.trim() || null,
      })
      .select('id')
      .single()

    if (batchErr || !batchRow) {
      setMessage(`Failed to save batch: ${batchErr?.message ?? 'Unknown error'}`)
      setMessageOk(false)
      setSaving(false)
      return
    }

    const { error: itemsErr } = await supabase.from('powder_batch_items').insert(
      validItems.map((i) => ({
        powder_batch_id: batchRow.id,
        sku_id: i.sku_id,
        qty: parseInt(i.qty),
        weight_lbs_each: i.weight_lbs_each,
      }))
    )

    if (itemsErr) {
      setMessage(`Batch saved but items failed: ${itemsErr.message}`)
      setMessageOk(false)
    } else {
      setMessage('Batch saved successfully.')
      setMessageOk(true)
      resetForm()
      setShowForm(false)
    }

    setSaving(false)
    await load()
  }

  // ── SKU lookup for display ────────────────────────────────────────────────────
  const skuMap = useMemo(() => {
    const m = new Map<string, SKU>()
    for (const s of skus) m.set(s.id, s)
    return m
  }, [skus])

  // ── Historical summary ────────────────────────────────────────────────────────
  const historicalStats = useMemo(() => {
    if (batches.length === 0) return null

    // Average cost/lb
    const validBatches = batches.filter((b) => {
      const items = batchItems.get(b.id) ?? []
      const tw = items.reduce((s, i) => s + (i.weight_lbs_each ?? 0) * i.qty, 0)
      return tw > 0
    })
    const avgCostPerLb = validBatches.length > 0
      ? validBatches.reduce((s, b) => {
          const items = batchItems.get(b.id) ?? []
          const tw = items.reduce((ss, i) => ss + (i.weight_lbs_each ?? 0) * i.qty, 0)
          return s + b.total_cost / tw
        }, 0) / validBatches.length
      : null

    // Most expensive SKU per unit across all batches
    let maxCostPerUnit = 0
    let mostExpensiveSku: string | null = null

    for (const b of batches) {
      const items = batchItems.get(b.id) ?? []
      const totalWeight = items.reduce((s, i) => s + (i.weight_lbs_each ?? 0) * i.qty, 0)
      if (totalWeight === 0) continue
      const costPerLb = b.total_cost / totalWeight
      for (const item of items) {
        if (item.weight_lbs_each == null) continue
        const costPerUnit = costPerLb * item.weight_lbs_each
        if (costPerUnit > maxCostPerUnit) {
          maxCostPerUnit = costPerUnit
          mostExpensiveSku = item.sku_id
        }
      }
    }

    // Cost/lb over time (sorted by date asc)
    const costOverTime = [...validBatches]
      .sort((a, b) => (a.batch_date ?? a.created_at) > (b.batch_date ?? b.created_at) ? 1 : -1)
      .map((b) => {
        const items = batchItems.get(b.id) ?? []
        const tw = items.reduce((s, i) => s + (i.weight_lbs_each ?? 0) * i.qty, 0)
        return {
          id: b.id,
          name: b.batch_name,
          date: b.batch_date,
          costPerLb: b.total_cost / tw,
        }
      })

    return { avgCostPerLb, mostExpensiveSku, maxCostPerUnit, costOverTime }
  }, [batches, batchItems])

  // ── Detail batch ─────────────────────────────────────────────────────────────
  const detailBatch = detailBatchId ? batches.find((b) => b.id === detailBatchId) ?? null : null

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="section-stack">

      {/* ── Page header ─────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <div className="kicker">Production</div>
          <h1 className="page-title">Powder Coat Batches</h1>
          <div className="page-subtitle">
            Track powder coat runs, calculate cost per pound, and estimate finishing cost per SKU.
          </div>
        </div>
        <div className="btn-row">
          <button
            className="btn btn-primary"
            onClick={() => { setShowForm(!showForm); setMessage('') }}
          >
            {showForm ? '✕ Cancel' : '+ New Batch'}
          </button>
        </div>
      </div>

      {/* ── Global message ──────────────────────────────────────────────────── */}
      {message && (
        <div
          className={messageOk ? 'message' : 'warning-box'}
          style={messageOk ? { borderColor: 'var(--success)', color: 'var(--success)' } : {}}
        >
          {message}
        </div>
      )}

      {/* ── Create batch form ────────────────────────────────────────────────── */}
      {showForm && (
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">New Powder Coat Batch</h2>
              <div className="card-subtitle">Log a powder coat run and which SKUs were included.</div>
            </div>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
              {/* Batch name */}
              <div>
                <label className="label">Batch Name *</label>
                <input
                  className="field"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Batch #42 — Rack Run"
                />
              </div>
              {/* Date */}
              <div>
                <label className="label">Batch Date</label>
                <input
                  className="field"
                  type="date"
                  value={formDate}
                  onChange={(e) => setFormDate(e.target.value)}
                />
              </div>
              {/* Total cost */}
              <div>
                <label className="label">Total Cost ($) *</label>
                <input
                  className="field"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formCost}
                  onChange={(e) => setFormCost(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              {/* Notes */}
              <div>
                <label className="label">Notes</label>
                <input
                  className="field"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  placeholder="Optional notes…"
                />
              </div>
            </div>

            {/* Item rows */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <label className="label" style={{ margin: 0 }}>SKUs in Batch</label>
                <button className="btn btn-secondary" style={{ height: 28, fontSize: '0.78rem' }} onClick={addRow}>
                  + Add Row
                </button>
              </div>

              {/* Header row */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 80px 120px auto',
                gap: 8,
                marginBottom: 6,
                paddingBottom: 6,
                borderBottom: '1px solid var(--border)',
              }}>
                {['SKU', 'Qty', 'Weight/Unit', ''].map((h) => (
                  <span key={h} style={{ fontSize: '0.67rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>{h}</span>
                ))}
              </div>

              {formItems.map((item) => {
                const filteredSkus = skus.filter((s) => {
                  const q = item.skuSearch.toLowerCase()
                  return q.length > 0 && (s.id.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
                }).slice(0, 10)

                return (
                  <div key={item.key} style={{ marginBottom: 8 }}>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 80px 120px auto',
                      gap: 8,
                      alignItems: 'start',
                    }}>
                      {/* SKU picker */}
                      <div style={{ position: 'relative' }}>
                        <input
                          className="field"
                          value={item.skuSearch}
                          onChange={(e) => updateItemSku(item.key, '', e.target.value)}
                          onFocus={() => setFormItems((prev) => prev.map((i) => i.key === item.key ? { ...i, showDropdown: true } : i))}
                          onBlur={() => setTimeout(() => setFormItems((prev) => prev.map((i) => i.key === item.key ? { ...i, showDropdown: false } : i)), 150)}
                          placeholder="Search SKU…"
                          style={{ fontSize: '0.82rem' }}
                        />
                        {item.showDropdown && filteredSkus.length > 0 && (
                          <div style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            right: 0,
                            zIndex: 50,
                            background: 'var(--panel)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            marginTop: 2,
                            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                            maxHeight: 220,
                            overflowY: 'auto',
                          }}>
                            {filteredSkus.map((s) => (
                              <button
                                key={s.id}
                                onMouseDown={() => updateItemSku(item.key, s.id, `${s.id} — ${s.description}`)}
                                style={{
                                  display: 'block',
                                  width: '100%',
                                  textAlign: 'left',
                                  background: 'transparent',
                                  border: 'none',
                                  borderBottom: '1px solid var(--border)',
                                  padding: '9px 12px',
                                  cursor: 'pointer',
                                  color: 'var(--text)',
                                  fontSize: '0.82rem',
                                  fontFamily: 'inherit',
                                }}
                              >
                                <span style={{ fontWeight: 700, color: 'var(--accent)', marginRight: 8, fontFamily: 'monospace' }}>{s.id}</span>
                                {s.description}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Qty */}
                      <input
                        className="field"
                        type="number"
                        min="1"
                        value={item.qty}
                        onChange={(e) => updateItemQty(item.key, e.target.value)}
                        style={{ fontSize: '0.82rem' }}
                      />

                      {/* Weight */}
                      <div style={{
                        height: 33,
                        display: 'flex',
                        alignItems: 'center',
                        fontSize: '0.82rem',
                        color: item.sku_id ? 'var(--text)' : 'var(--muted)',
                        fontWeight: item.sku_id ? 600 : 400,
                      }}>
                        {item.sku_id ? fmtLbs(item.weight_lbs_each) : '—'}
                      </div>

                      {/* Remove */}
                      <button
                        className="btn btn-secondary"
                        style={{ height: 33, width: 33, padding: 0, color: 'var(--danger)', borderColor: 'transparent', flexShrink: 0 }}
                        onClick={() => removeRow(item.key)}
                        title="Remove row"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Missing weight warning */}
                    {item.missingWeight && (
                      <div style={{ marginTop: 4, fontSize: '0.76rem', color: 'var(--warning)' }}>
                        ⚠ Some parts missing weight data
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Running totals */}
            {formTotals.validItems.length > 0 && (
              <div style={{
                background: 'var(--panel-2)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '14px 18px',
                marginBottom: 20,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: 16,
              }}>
                <div>
                  <div style={{ fontSize: '0.67rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 3 }}>SKUs in Batch</div>
                  <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--text)' }}>{formTotals.validItems.length}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.67rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 3 }}>Total Weight</div>
                  <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--text)' }}>{fmtLbs(formTotals.totalWeight)}</div>
                </div>
                {formTotals.costPerLb != null && (
                  <div>
                    <div style={{ fontSize: '0.67rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 3 }}>Est. Cost/lb</div>
                    <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--accent)' }}>{fmt$(formTotals.costPerLb)}</div>
                  </div>
                )}
              </div>
            )}

            {/* Per-SKU cost breakdown in form */}
            {formTotals.costPerLb != null && formTotals.validItems.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: '0.67rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 8 }}>Cost Breakdown</div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>Qty</th>
                        <th>Weight/Unit</th>
                        <th>Cost/Unit</th>
                        <th>Total Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {formTotals.validItems.map((item) => {
                        const costPerUnit = formTotals.costPerLb! * (item.weight_lbs_each ?? 0)
                        const qty = parseInt(item.qty) || 0
                        const sku = skuMap.get(item.sku_id)
                        return (
                          <tr key={item.key}>
                            <td style={{ fontFamily: 'monospace', fontSize: '0.82rem', fontWeight: 700, color: 'var(--text)' }}>
                              {item.sku_id}
                              {sku && <span style={{ fontWeight: 400, color: 'var(--text-2)', fontFamily: 'inherit', marginLeft: 8 }}>{sku.description}</span>}
                            </td>
                            <td>{qty}</td>
                            <td>{fmtLbs(item.weight_lbs_each)}</td>
                            <td style={{ color: 'var(--accent)' }}>{item.weight_lbs_each != null ? fmt$(costPerUnit) : '—'}</td>
                            <td style={{ color: 'var(--accent)', fontWeight: 700 }}>{item.weight_lbs_each != null ? fmt$(costPerUnit * qty) : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="btn-row">
              <button
                className="btn btn-primary"
                onClick={saveBatch}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save Batch'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => { resetForm(); setShowForm(false) }}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ── Batch list ───────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">All Batches</h2>
            <div className="card-subtitle">Click a batch to view details.</div>
          </div>
        </div>

        {loading ? (
          <div className="empty">Loading…</div>
        ) : batches.length === 0 ? (
          <div className="empty">
            No powder coat batches yet.<br />
            <span style={{ fontSize: '0.78rem' }}>Click "New Batch" to log your first run.</span>
          </div>
        ) : (
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Batch Name</th>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>Total Cost</th>
                  <th style={{ textAlign: 'right' }}>Total Weight</th>
                  <th style={{ textAlign: 'right' }}>Cost/lb</th>
                  <th style={{ textAlign: 'center' }}>SKUs</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => {
                  const { totalWeight, costPerLb, skuCount } = batchStats(b)
                  const isDetail = detailBatchId === b.id
                  return (
                    <tr
                      key={b.id}
                      style={{ cursor: 'pointer', background: isDetail ? 'var(--accent-soft)' : 'transparent' }}
                      onClick={() => setDetailBatchId(isDetail ? null : b.id)}
                    >
                      <td style={{ fontWeight: 700, color: 'var(--text)' }}>
                        {isDetail && <span style={{ color: 'var(--accent)', marginRight: 6 }}>▶</span>}
                        {b.batch_name}
                      </td>
                      <td>{fmtDate(b.batch_date)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text)', fontWeight: 600 }}>{fmt$(b.total_cost)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtLbs(totalWeight)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--accent)', fontWeight: 700 }}>
                        {costPerLb != null ? fmt$(costPerLb) : '—'}
                      </td>
                      <td style={{ textAlign: 'center' }}>{skuCount}</td>
                      <td style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{fmtDate(b.created_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Batch detail ─────────────────────────────────────────────────────── */}
      {detailBatch && (() => {
        const items = batchItems.get(detailBatch.id) ?? []
        const totalWeight = items.reduce((s, i) => s + (i.weight_lbs_each ?? 0) * i.qty, 0)
        const costPerLb = totalWeight > 0 ? detailBatch.total_cost / totalWeight : null

        return (
          <section className="card">
            <div className="card-header" style={{ justifyContent: 'space-between' }}>
              <div>
                <h2 className="card-title">{detailBatch.batch_name}</h2>
                <div className="card-subtitle">
                  {fmtDate(detailBatch.batch_date)}
                  {detailBatch.notes && <span style={{ marginLeft: 12 }}>{detailBatch.notes}</span>}
                </div>
              </div>
              <button
                className="btn btn-secondary"
                style={{ height: 28, fontSize: '0.78rem', flexShrink: 0 }}
                onClick={() => setDetailBatchId(null)}
              >
                ✕ Close
              </button>
            </div>

            <div className="card-body">
              {/* Batch stats */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: 14,
                marginBottom: 24,
              }}>
                {[
                  { label: 'Total Cost', value: fmt$(detailBatch.total_cost), color: 'var(--text)' },
                  { label: 'Total Weight', value: fmtLbs(totalWeight), color: 'var(--text)' },
                  { label: 'Cost / lb', value: costPerLb != null ? fmt$(costPerLb) : '—', color: 'var(--accent)' },
                  { label: 'SKU Lines', value: String(items.length), color: 'var(--text)' },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    style={{
                      background: 'var(--panel-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '14px 16px',
                    }}
                  >
                    <div style={{ fontSize: '0.67rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 4 }}>
                      {stat.label}
                    </div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 800, color: stat.color }}>
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>

              {/* Items table */}
              {items.length === 0 ? (
                <div className="empty">No items in this batch.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>Description</th>
                        <th style={{ textAlign: 'center' }}>Qty</th>
                        <th style={{ textAlign: 'right' }}>Weight/Unit</th>
                        <th style={{ textAlign: 'right' }}>Total Weight</th>
                        <th style={{ textAlign: 'right' }}>Cost/Unit</th>
                        <th style={{ textAlign: 'right' }}>Total Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => {
                        const sku = skuMap.get(item.sku_id)
                        const itemWeight = (item.weight_lbs_each ?? 0) * item.qty
                        const costPerUnit = costPerLb != null && item.weight_lbs_each != null
                          ? costPerLb * item.weight_lbs_each
                          : null
                        const totalItemCost = costPerUnit != null ? costPerUnit * item.qty : null

                        return (
                          <tr key={item.id}>
                            <td style={{ fontFamily: 'monospace', fontSize: '0.82rem', fontWeight: 700, color: 'var(--text)' }}>
                              {item.sku_id}
                            </td>
                            <td style={{ color: 'var(--text-2)' }}>{sku?.description ?? '—'}</td>
                            <td style={{ textAlign: 'center', fontWeight: 600 }}>{item.qty}</td>
                            <td style={{ textAlign: 'right' }}>{fmtLbs(item.weight_lbs_each)}</td>
                            <td style={{ textAlign: 'right' }}>{fmtLbs(itemWeight)}</td>
                            <td style={{ textAlign: 'right', color: 'var(--accent)' }}>
                              {costPerUnit != null ? fmt$(costPerUnit) : '—'}
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--accent)' }}>
                              {totalItemCost != null ? fmt$(totalItemCost) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'right', color: 'var(--muted)', fontSize: '0.78rem' }}>Totals</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtLbs(totalWeight)}</td>
                        <td></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--accent)' }}>{fmt$(detailBatch.total_cost)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </section>
        )
      })()}

      {/* ── Historical summary ────────────────────────────────────────────────── */}
      {historicalStats && (
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Historical Summary</h2>
              <div className="card-subtitle">Trends and averages across all batches.</div>
            </div>
          </div>
          <div className="card-body">
            {/* Summary stats */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 24 }}>
              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 20px' }}>
                <div style={{ fontSize: '0.67rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 4 }}>
                  Avg Cost / lb
                </div>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--accent)' }}>
                  {historicalStats.avgCostPerLb != null ? fmt$(historicalStats.avgCostPerLb) : '—'}
                </div>
                <div style={{ fontSize: '0.76rem', color: 'var(--muted)', marginTop: 4 }}>across {batches.length} batch{batches.length !== 1 ? 'es' : ''}</div>
              </div>
              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 20px' }}>
                <div style={{ fontSize: '0.67rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 4 }}>
                  Most Expensive SKU to Powder
                </div>
                {historicalStats.mostExpensiveSku ? (
                  <>
                    <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text)', fontFamily: 'monospace' }}>
                      {historicalStats.mostExpensiveSku}
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-2)', marginTop: 2 }}>
                      {skuMap.get(historicalStats.mostExpensiveSku)?.description ?? ''}
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'var(--accent)', fontWeight: 700, marginTop: 4 }}>
                      {fmt$(historicalStats.maxCostPerUnit)} / unit
                    </div>
                  </>
                ) : (
                  <div style={{ color: 'var(--muted)' }}>—</div>
                )}
              </div>
            </div>

            {/* Cost/lb over time */}
            {historicalStats.costOverTime.length > 0 && (
              <>
                <div style={{ fontSize: '0.67rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 10 }}>
                  Cost / lb Over Time
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Batch</th>
                        <th>Date</th>
                        <th style={{ textAlign: 'right' }}>Cost / lb</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicalStats.costOverTime.map((row) => (
                        <tr key={row.id}>
                          <td style={{ fontWeight: 600, color: 'var(--text)' }}>{row.name}</td>
                          <td>{fmtDate(row.date)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--accent)', fontWeight: 700 }}>
                            {fmt$(row.costPerLb)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </section>
      )}

    </div>
  )
}
