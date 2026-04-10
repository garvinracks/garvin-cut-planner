'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type BuildBatch = {
  id: string
  name: string
  status: string
  created_at: string
  powder_batch_id: string | null
}

type BuildBatchLine = {
  batch_id: string
  sku_id: string
  qty: number
}

type PowderBatch = {
  id: string
  batch_name: string
  sent_date: string | null
  returned_date: string | null
  total_cost: number
  notes: string | null
  status: 'at_coater' | 'complete'
  created_at: string
}

type SkuPart = { sku_id: string; part_id: string; qty: number }
type SkuSubAssembly = { sku_id: string; sub_assembly_id: string; qty: number }
type SubAssemblyPart = { sub_assembly_id: string; part_id: string; qty: number }
type Part = { id: string; weight_lbs: number | null }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtCost(n: number) { return '$' + n.toFixed(2) }
function fmtWeight(n: number) { return n.toFixed(1) + ' lbs' }

// ── Component ─────────────────────────────────────────────────────────────────

export default function PowderPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [buildBatches, setBuildBatches]   = useState<BuildBatch[]>([])
  const [batchLines, setBatchLines]       = useState<BuildBatchLine[]>([])
  const [powderBatches, setPowderBatches] = useState<PowderBatch[]>([])
  const [skuParts, setSkuParts]           = useState<SkuPart[]>([])
  const [skuSubs, setSkuSubs]             = useState<SkuSubAssembly[]>([])
  const [subParts, setSubParts]           = useState<SubAssemblyPart[]>([])
  const [parts, setParts]                 = useState<Part[]>([])

  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [saving, setSaving]   = useState(false)

  // Create form
  const [createOpen, setCreateOpen]             = useState(false)
  const [formName, setFormName]                 = useState('')
  const [formDate, setFormDate]                 = useState(new Date().toISOString().split('T')[0])
  const [formCost, setFormCost]                 = useState('')
  const [formNotes, setFormNotes]               = useState('')
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(new Set())

  // Detail expand
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // ── Load ─────────────────────────────────────────────────────────────────────

  async function loadAll() {
    setLoading(true)
    const [
      { data: bbData },
      { data: blData },
      { data: pbData },
      { data: spData },
      { data: ssData },
      { data: sapData },
      { data: partData },
    ] = await Promise.all([
      supabase.from('build_batches').select('id, name, status, created_at, powder_batch_id').in('status', ['at_powder', 'complete']),
      supabase.from('build_batch_lines').select('batch_id, sku_id, qty'),
      supabase.from('powder_batches').select('*').order('created_at', { ascending: false }),
      supabase.from('sku_parts').select('sku_id, part_id, qty'),
      supabase.from('sku_sub_assemblies').select('sku_id, sub_assembly_id, qty'),
      supabase.from('sub_assembly_parts').select('sub_assembly_id, part_id, qty'),
      supabase.from('parts').select('id, weight_lbs'),
    ])
    setBuildBatches((bbData ?? []) as BuildBatch[])
    setBatchLines((blData ?? []) as BuildBatchLine[])
    setPowderBatches((pbData ?? []) as PowderBatch[])
    setSkuParts((spData ?? []) as SkuPart[])
    setSkuSubs((ssData ?? []) as SkuSubAssembly[])
    setSubParts((sapData ?? []) as SubAssemblyPart[])
    setParts((partData ?? []) as Part[])
    setLoading(false)
  }

  useEffect(() => { void loadAll() }, [])

  useEffect(() => {
    if (createOpen) {
      setSelectedBatchIds(new Set(
        buildBatches.filter((b) => b.status === 'at_powder' && !b.powder_batch_id).map((b) => b.id)
      ))
    }
  }, [createOpen])

  // ── Weight calculation ────────────────────────────────────────────────────────

  function calcBatchWeight(batchId: string): number {
    let total = 0
    for (const line of batchLines.filter((l) => l.batch_id === batchId)) {
      for (const sp of skuParts.filter((s) => s.sku_id === line.sku_id)) {
        const part = parts.find((p) => p.id === sp.part_id)
        total += (part?.weight_lbs ?? 0) * sp.qty * line.qty
      }
      for (const ss of skuSubs.filter((s) => s.sku_id === line.sku_id)) {
        for (const sap of subParts.filter((s) => s.sub_assembly_id === ss.sub_assembly_id)) {
          const part = parts.find((p) => p.id === sap.part_id)
          total += (part?.weight_lbs ?? 0) * sap.qty * ss.qty * line.qty
        }
      }
    }
    return total
  }

  // ── Derived ───────────────────────────────────────────────────────────────────

  const pendingBatches        = buildBatches.filter((b) => b.status === 'at_powder' && !b.powder_batch_id)
  const activePowderBatches   = powderBatches.filter((p) => p.status === 'at_coater')
  const completedPowderBatches = powderBatches.filter((p) => p.status === 'complete')

  const selectedWeight = Array.from(selectedBatchIds).reduce((s, id) => s + calcBatchWeight(id), 0)
  const estCostPerLb   = formCost && selectedWeight > 0 ? parseFloat(formCost) / selectedWeight : null

  // ── Actions ───────────────────────────────────────────────────────────────────

  async function createRun() {
    if (!formName.trim())                      { setMessage('Run name is required.'); return }
    if (!formCost || isNaN(parseFloat(formCost))) { setMessage('Total cost is required.'); return }
    if (selectedBatchIds.size === 0)           { setMessage('Select at least one build batch.'); return }
    setSaving(true); setMessage('')

    const { data: pb, error } = await supabase
      .from('powder_batches')
      .insert({ batch_name: formName.trim(), sent_date: formDate || null, total_cost: parseFloat(formCost), notes: formNotes.trim() || null, status: 'at_coater' })
      .select('*').single()

    if (error || !pb) { setMessage('Save failed: ' + (error?.message ?? 'unknown')); setSaving(false); return }

    await supabase.from('build_batches').update({ powder_batch_id: pb.id }).in('id', Array.from(selectedBatchIds))

    setFormName(''); setFormDate(new Date().toISOString().split('T')[0]); setFormCost(''); setFormNotes('')
    setCreateOpen(false)
    await loadAll()
    setSaving(false)
    setMessage('Powder run created.')
  }

  async function markRunComplete(pb: PowderBatch) {
    const today = new Date().toISOString()
    await supabase.from('powder_batches').update({ status: 'complete', returned_date: today.split('T')[0] }).eq('id', pb.id)
    await supabase.from('build_batches').update({ status: 'complete', completed_at: today }).eq('powder_batch_id', pb.id)
    await loadAll()
    setMessage('Run marked complete — all linked build batches are now complete.')
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) return <div className="section-stack"><div className="empty">Loading…</div></div>

  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Powder Coat</h1>
          <div className="page-subtitle">
            Track powder coat runs sent to the coater, calculate cost per pound, and mark batches complete when parts return.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setCreateOpen((v) => !v)}>
          {createOpen ? '✕ Cancel' : '+ Create Powder Run'}
        </button>
      </div>

      {message && <div className="message">{message}</div>}

      {/* ── Create run form ───────────────────────────────────────────────────── */}
      {createOpen && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">New Powder Run</h2>
            <div className="card-subtitle">Group build batches into a single trip to the coater</div>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
              <div>
                <label className="label">Run Name *</label>
                <input className="field" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Run #7 — April 2026" />
              </div>
              <div>
                <label className="label">Sent Date</label>
                <input className="field" type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} />
              </div>
              <div>
                <label className="label">Total Invoice Cost ($) *</label>
                <input className="field" type="number" step="0.01" min="0" value={formCost} onChange={(e) => setFormCost(e.target.value)} placeholder="0.00" />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="label">Notes</label>
                <textarea className="field" rows={2} value={formNotes} onChange={(e) => setFormNotes(e.target.value)} placeholder="Optional" style={{ resize: 'vertical' }} />
              </div>
            </div>

            <label className="label" style={{ marginBottom: 10, display: 'block' }}>Build Batches to Include</label>
            {pendingBatches.length === 0 ? (
              <div className="empty" style={{ marginBottom: 16 }}>
                No build batches are waiting at the powder coater. When manufacturing stages are complete on a batch, click "Send to Powder Coater" on the Batches page.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {pendingBatches.map((batch) => {
                  const weight    = calcBatchWeight(batch.id)
                  const lineCount = batchLines.filter((l) => l.batch_id === batch.id).length
                  const checked   = selectedBatchIds.has(batch.id)
                  return (
                    <label key={batch.id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '8px 12px', background: checked ? 'var(--accent-soft)' : 'var(--panel-2)', borderRadius: 6, border: `1px solid ${checked ? 'var(--accent-border)' : 'var(--border)'}` }}>
                      <input type="checkbox" checked={checked}
                        onChange={(e) => setSelectedBatchIds((prev) => { const n = new Set(prev); e.target.checked ? n.add(batch.id) : n.delete(batch.id); return n })}
                        style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)', flexShrink: 0 }} />
                      <span style={{ fontWeight: 700, flex: 1 }}>{batch.name}</span>
                      <span style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>{lineCount} SKU{lineCount !== 1 ? 's' : ''}</span>
                      <span style={{ color: 'var(--text-2)', fontSize: '0.82rem', fontWeight: 600 }}>{fmtWeight(weight)}</span>
                    </label>
                  )
                })}
              </div>
            )}

            {/* Running totals */}
            <div style={{ display: 'flex', gap: 24, padding: '12px 16px', background: 'var(--panel-2)', borderRadius: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total Weight</div>
                <div style={{ fontWeight: 800, fontSize: '1.05rem' }}>{fmtWeight(selectedWeight)}</div>
              </div>
              {estCostPerLb != null && (
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Est. Cost / lb</div>
                  <div style={{ fontWeight: 800, fontSize: '1.05rem', color: 'var(--accent)' }}>{fmtCost(estCostPerLb)}</div>
                </div>
              )}
              {formCost && (
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total Cost</div>
                  <div style={{ fontWeight: 800, fontSize: '1.05rem' }}>{fmtCost(parseFloat(formCost) || 0)}</div>
                </div>
              )}
            </div>

            <div className="btn-row">
              <button className="btn btn-primary" disabled={saving} onClick={createRun}>
                {saving ? 'Saving…' : 'Create Run'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ── Active runs at coater ─────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Active Runs</h2>
          <div className="card-subtitle">
            {activePowderBatches.length > 0
              ? `${activePowderBatches.length} run${activePowderBatches.length !== 1 ? 's' : ''} at the coater`
              : 'Nothing currently at the coater'}
          </div>
        </div>
        <div className="card-body">
          {/* Unassigned batches waiting */}
          {pendingBatches.length > 0 && (
            <div style={{ marginBottom: 20, padding: '12px 16px', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 8 }}>
              <div style={{ fontWeight: 700, color: '#a78bfa', marginBottom: 8 }}>
                🎨 {pendingBatches.length} batch{pendingBatches.length !== 1 ? 'es' : ''} ready to be grouped into a run
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {pendingBatches.map((b) => (
                  <span key={b.id} style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', borderRadius: 20, padding: '2px 10px', fontSize: '0.8rem', fontWeight: 600 }}>
                    {b.name}
                  </span>
                ))}
              </div>
              <button className="btn btn-primary" style={{ background: '#a78bfa', borderColor: '#a78bfa' }} onClick={() => setCreateOpen(true)}>
                + Group into Powder Run
              </button>
            </div>
          )}

          {activePowderBatches.length === 0 && pendingBatches.length === 0 ? (
            <div className="empty">
              No build batches are currently at the powder coater. When all manufacturing stages are complete on a build batch, click "Send to Powder Coater" on the Batches page.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {activePowderBatches.map((pb) => {
                const linked      = buildBatches.filter((b) => b.powder_batch_id === pb.id)
                const totalWeight = linked.reduce((s, b) => s + calcBatchWeight(b.id), 0)
                const cpl         = totalWeight > 0 ? pb.total_cost / totalWeight : null
                const isExpanded  = expandedId === pb.id

                return (
                  <div key={pb.id} style={{ border: '1px solid rgba(167,139,250,0.4)', borderRadius: 8, overflow: 'hidden' }}>
                    <div
                      style={{ background: 'rgba(167,139,250,0.1)', padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}
                      onClick={() => setExpandedId(isExpanded ? null : pb.id)}
                    >
                      <span style={{ fontWeight: 700, fontSize: '0.95rem', flex: 1 }}>{pb.batch_name}</span>
                      <span style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>Sent {fmtDate(pb.sent_date)}</span>
                      <span style={{ fontWeight: 600 }}>{fmtWeight(totalWeight)}</span>
                      {cpl != null && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{fmtCost(cpl)}/lb</span>}
                      <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{isExpanded ? '▲' : '▼'}</span>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: '16px' }}>
                        {pb.notes && <div style={{ color: 'var(--text-2)', fontSize: '0.85rem', marginBottom: 14 }}>{pb.notes}</div>}

                        <div style={{ display: 'flex', gap: 20, marginBottom: 16, flexWrap: 'wrap' }}>
                          {[
                            { label: 'Total Cost',   value: fmtCost(pb.total_cost) },
                            { label: 'Total Weight', value: fmtWeight(totalWeight) },
                            { label: 'Cost / lb',    value: cpl != null ? fmtCost(cpl) : '—' },
                            { label: 'Batches',      value: String(linked.length) },
                          ].map(({ label, value }) => (
                            <div key={label}>
                              <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
                              <div style={{ fontWeight: 800, fontSize: '1rem' }}>{value}</div>
                            </div>
                          ))}
                        </div>

                        <div className="table-wrap" style={{ marginBottom: 16 }}>
                          <table className="table">
                            <thead>
                              <tr>
                                <th>Build Batch</th>
                                <th style={{ textAlign: 'center' }}>SKUs</th>
                                <th style={{ textAlign: 'right' }}>Weight</th>
                                <th style={{ textAlign: 'right' }}>Cost Share</th>
                              </tr>
                            </thead>
                            <tbody>
                              {linked.map((batch) => {
                                const w            = calcBatchWeight(batch.id)
                                const contribution = totalWeight > 0 ? (w / totalWeight) * pb.total_cost : 0
                                const lineCount    = batchLines.filter((l) => l.batch_id === batch.id).length
                                return (
                                  <tr key={batch.id}>
                                    <td style={{ fontWeight: 600 }}>{batch.name}</td>
                                    <td style={{ textAlign: 'center' }}>{lineCount}</td>
                                    <td style={{ textAlign: 'right' }}>{fmtWeight(w)}</td>
                                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtCost(contribution)}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                            <tfoot>
                              <tr>
                                <td colSpan={2} style={{ fontWeight: 700, color: 'var(--muted)' }}>Total</td>
                                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtWeight(totalWeight)}</td>
                                <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{fmtCost(pb.total_cost)}</td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>

                        <button
                          className="btn btn-primary"
                          style={{ background: 'var(--success)', borderColor: 'var(--success)' }}
                          onClick={() => markRunComplete(pb)}
                        >
                          ✓ Mark Complete — Parts Returned
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>

      {/* ── History ───────────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">History</h2>
          <div className="card-subtitle">{completedPowderBatches.length} completed run{completedPowderBatches.length !== 1 ? 's' : ''}</div>
        </div>
        <div className="card-body">
          {completedPowderBatches.length === 0 ? (
            <div className="empty">No completed powder runs yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Run Name</th>
                    <th>Sent</th>
                    <th>Returned</th>
                    <th style={{ textAlign: 'center' }}>Batches</th>
                    <th style={{ textAlign: 'right' }}>Total Weight</th>
                    <th style={{ textAlign: 'right' }}>Cost / lb</th>
                    <th style={{ textAlign: 'right' }}>Total Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {completedPowderBatches.map((pb) => {
                    const linked      = buildBatches.filter((b) => b.powder_batch_id === pb.id)
                    const totalWeight = linked.reduce((s, b) => s + calcBatchWeight(b.id), 0)
                    const cpl         = totalWeight > 0 ? pb.total_cost / totalWeight : null
                    return (
                      <tr key={pb.id}>
                        <td style={{ fontWeight: 600 }}>{pb.batch_name}</td>
                        <td>{fmtDate(pb.sent_date)}</td>
                        <td style={{ color: 'var(--success)' }}>{fmtDate(pb.returned_date)}</td>
                        <td style={{ textAlign: 'center' }}>{linked.length}</td>
                        <td style={{ textAlign: 'right' }}>{fmtWeight(totalWeight)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--accent)' }}>
                          {cpl != null ? fmtCost(cpl) : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtCost(pb.total_cost)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
