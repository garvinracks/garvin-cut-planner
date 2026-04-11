'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type BuildBatch = {
  id: string
  name: string
  status: string
  created_at: string
  completed_at: string | null
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

function daysAgo(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PowderPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [buildBatches, setBuildBatches] = useState<BuildBatch[]>([])
  const [batchLines, setBatchLines]     = useState<BuildBatchLine[]>([])
  const [powderBatches, setPowderBatches] = useState<PowderBatch[]>([])
  const [skuParts, setSkuParts]         = useState<SkuPart[]>([])
  const [skuSubs, setSkuSubs]           = useState<SkuSubAssembly[]>([])
  const [subParts, setSubParts]         = useState<SubAssemblyPart[]>([])
  const [parts, setParts]               = useState<Part[]>([])

  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [saving, setSaving]   = useState(false)

  // "Record return" flow
  const [returnMode, setReturnMode]         = useState(false)
  const [returnSelected, setReturnSelected] = useState<Set<string>>(new Set())
  const [returnCost, setReturnCost]         = useState('')
  const [returnNotes, setReturnNotes]       = useState('')

  // History expand
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // ── Data loading ──────────────────────────────────────────────────────────────

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
      supabase.from('build_batches')
        .select('id, name, status, created_at, completed_at, powder_batch_id')
        .in('status', ['at_powder', 'complete'])
        .order('created_at', { ascending: false }),
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

  // Build batches currently at the powder coater (no powder run assigned yet)
  const atCoaterBatches = buildBatches.filter(
    (b) => b.status === 'at_powder' && !b.powder_batch_id
  )

  // Legacy: batches linked to an active powder run (old flow)
  const legacyRuns = powderBatches.filter((p) => p.status === 'at_coater')

  const completedRuns = powderBatches.filter((p) => p.status === 'complete')

  const returnWeight = Array.from(returnSelected).reduce(
    (s, id) => s + calcBatchWeight(id), 0
  )
  const estCostPerLb =
    returnCost && returnWeight > 0 ? parseFloat(returnCost) / returnWeight : null

  // ── Record return action ──────────────────────────────────────────────────────

  async function recordReturn() {
    if (returnSelected.size === 0) {
      setMessage('Select at least one batch.')
      return
    }
    if (!returnCost || isNaN(parseFloat(returnCost))) {
      setMessage('Enter the total invoice cost.')
      return
    }
    setSaving(true)
    setMessage('')

    const today    = new Date()
    const todayStr = today.toISOString().split('T')[0]
    const todayIso = today.toISOString()
    const runName  = `Powder Return — ${today.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })}`

    // Create a completed powder_batch record (acts as a cost receipt)
    const { data: pb, error } = await supabase
      .from('powder_batches')
      .insert({
        batch_name:    runName,
        returned_date: todayStr,
        total_cost:    parseFloat(returnCost),
        notes:         returnNotes.trim() || null,
        status:        'complete',
      })
      .select('id')
      .single()

    if (error || !pb) {
      setMessage('Save failed: ' + (error?.message ?? 'unknown'))
      setSaving(false)
      return
    }

    // Link selected build batches → this run and mark them complete
    await supabase
      .from('build_batches')
      .update({ powder_batch_id: pb.id, status: 'complete', completed_at: todayIso })
      .in('id', Array.from(returnSelected))

    const count = returnSelected.size
    setReturnMode(false)
    setReturnSelected(new Set())
    setReturnCost('')
    setReturnNotes('')
    await loadAll()
    setSaving(false)
    setMessage(
      `✓ ${count} batch${count !== 1 ? 'es' : ''} marked complete — powder coat cost recorded at ${fmtCost(parseFloat(returnCost))}.`
    )
  }

  // Legacy: mark an at_coater powder run complete (backward compat)
  async function markLegacyComplete(pb: PowderBatch) {
    const today = new Date().toISOString()
    await supabase
      .from('powder_batches')
      .update({ status: 'complete', returned_date: today.split('T')[0] })
      .eq('id', pb.id)
    await supabase
      .from('build_batches')
      .update({ status: 'complete', completed_at: today })
      .eq('powder_batch_id', pb.id)
    await loadAll()
    setMessage('Run marked complete — all linked build batches are now complete.')
  }

  // ── Toggle batch selection ────────────────────────────────────────────────────

  function toggleBatch(id: string) {
    setReturnSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) return <div className="section-stack"><div className="empty">Loading…</div></div>

  return (
    <div className="section-stack">

      {/* Page header */}
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Powder Coat</h1>
          <p className="page-subtitle">
            Batches appear here automatically when sent from the Batches page.
            When parts come back from the coater, record the invoice cost to mark them complete.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={() => void loadAll()} style={{ alignSelf: 'flex-start' }}>
          ↻ Refresh
        </button>
      </div>

      {message && (
        <div
          className="message"
          style={{ color: message.startsWith('✓') ? 'var(--success)' : message.includes('failed') ? 'var(--danger)' : undefined }}
        >
          {message}
        </div>
      )}

      {/* ── At the Coater ─────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">At the Coater</h2>
          <div className="card-subtitle">
            {atCoaterBatches.length === 0
              ? 'Nothing currently at the powder coater'
              : `${atCoaterBatches.length} batch${atCoaterBatches.length !== 1 ? 'es' : ''} waiting for return`}
          </div>

          {/* Actions */}
          {atCoaterBatches.length > 0 && !returnMode && (
            <button
              className="btn btn-primary"
              style={{ background: 'var(--success)', borderColor: 'var(--success)' }}
              onClick={() => {
                setReturnMode(true)
                // Pre-select all batches
                setReturnSelected(new Set(atCoaterBatches.map((b) => b.id)))
              }}
            >
              ✓ Record Parts Returned
            </button>
          )}
          {returnMode && (
            <button
              className="btn btn-secondary"
              onClick={() => { setReturnMode(false); setReturnSelected(new Set()) }}
            >
              ✕ Cancel
            </button>
          )}
        </div>

        <div className="card-body">
          {atCoaterBatches.length === 0 ? (
            <div className="empty">
              No build batches are currently at the powder coater.<br />
              On the <strong>Batches</strong> page, complete all manufacturing stages then click
              {' '}<strong>"Send to Powder Coater"</strong> — the batch will appear here immediately.
            </div>
          ) : (
            <>
              {/* Batch cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {atCoaterBatches.map((batch) => {
                  const weight    = calcBatchWeight(batch.id)
                  const lineCount = batchLines.filter((l) => l.batch_id === batch.id).length
                  const selected  = returnSelected.has(batch.id)

                  return (
                    <div
                      key={batch.id}
                      onClick={() => returnMode && toggleBatch(batch.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        padding: '12px 16px',
                        background: selected ? 'var(--accent-soft)' : 'var(--panel-2)',
                        border: `1px solid ${selected ? 'var(--accent-border)' : 'var(--border)'}`,
                        borderRadius: 8,
                        cursor: returnMode ? 'pointer' : 'default',
                        transition: 'background 0.12s, border-color 0.12s',
                        userSelect: 'none',
                      }}
                    >
                      {/* Checkbox (only shown in return mode) */}
                      {returnMode && (
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {}}
                          style={{
                            width: 17, height: 17,
                            accentColor: 'var(--accent)',
                            flexShrink: 0,
                            pointerEvents: 'none',
                          }}
                        />
                      )}

                      {/* Icon */}
                      <div style={{
                        width: 38, height: 38, borderRadius: 8, flexShrink: 0,
                        background: 'rgba(167,139,250,0.15)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '1.1rem',
                      }}>
                        🎨
                      </div>

                      {/* Info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>{batch.name}</div>
                        <div style={{ fontSize: '0.76rem', color: 'var(--muted)', marginTop: 2 }}>
                          {lineCount} SKU{lineCount !== 1 ? 's' : ''} · sent {daysAgo(batch.created_at)}
                        </div>
                      </div>

                      {/* Weight */}
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        {weight > 0 ? (
                          <>
                            <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>{fmtWeight(weight)}</div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>est. weight</div>
                          </>
                        ) : (
                          <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>no weight data</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* ── Inline return form ──────────────────────────────────────── */}
              {returnMode && (
                <div style={{
                  marginTop: 16,
                  padding: 20,
                  background: 'var(--panel-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 14, fontSize: '0.9rem' }}>
                    Record Parts Returned from Powder Coating
                  </div>

                  {/* Summary pills */}
                  <div style={{ display: 'flex', gap: 20, marginBottom: 18, flexWrap: 'wrap' }}>
                    {[
                      { label: 'Batches selected', value: String(returnSelected.size) },
                      { label: 'Total weight',     value: fmtWeight(returnWeight) },
                      ...(estCostPerLb != null
                        ? [{ label: 'Est. cost / lb', value: fmtCost(estCostPerLb) }]
                        : []),
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <div style={{ fontSize: '0.67rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.09em' }}>{label}</div>
                        <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>{value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Cost + notes inputs */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                    <div>
                      <label className="label">Powder Coat Invoice Total ($) *</label>
                      <input
                        className="field"
                        type="number"
                        step="0.01"
                        min="0"
                        value={returnCost}
                        onChange={(e) => setReturnCost(e.target.value)}
                        placeholder="0.00"
                        autoFocus
                      />
                    </div>
                    <div>
                      <label className="label">Notes (optional)</label>
                      <input
                        className="field"
                        value={returnNotes}
                        onChange={(e) => setReturnNotes(e.target.value)}
                        placeholder="Invoice #, coater, etc."
                      />
                    </div>
                  </div>

                  <div className="btn-row">
                    <button
                      className="btn btn-primary"
                      style={{ background: 'var(--success)', borderColor: 'var(--success)' }}
                      disabled={saving || returnSelected.size === 0 || !returnCost}
                      onClick={recordReturn}
                    >
                      {saving ? 'Saving…' : `✓ Confirm Return & Mark ${returnSelected.size} Batch${returnSelected.size !== 1 ? 'es' : ''} Complete`}
                    </button>
                    <span style={{ fontSize: '0.78rem', color: 'var(--muted)', alignSelf: 'center' }}>
                      Cost will be split proportionally by part weight across selected batches
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ── Legacy active runs (backward compat if old flow was used) ─────────── */}
      {legacyRuns.length > 0 && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Active Runs</h2>
            <div className="card-subtitle">
              {legacyRuns.length} run{legacyRuns.length !== 1 ? 's' : ''} at the coater
            </div>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {legacyRuns.map((pb) => {
                const linked      = buildBatches.filter((b) => b.powder_batch_id === pb.id)
                const totalWeight = linked.reduce((s, b) => s + calcBatchWeight(b.id), 0)
                const cpl         = totalWeight > 0 ? pb.total_cost / totalWeight : null
                const isExpanded  = expandedId === pb.id

                return (
                  <div key={pb.id} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <div
                      onClick={() => setExpandedId(isExpanded ? null : pb.id)}
                      style={{
                        padding: '12px 16px', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                        background: 'var(--panel-2)',
                      }}
                    >
                      <span style={{ fontWeight: 700, flex: 1 }}>{pb.batch_name}</span>
                      <span style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>Sent {fmtDate(pb.sent_date)}</span>
                      <span style={{ fontWeight: 600 }}>{fmtWeight(totalWeight)}</span>
                      {cpl != null && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{fmtCost(cpl)}/lb</span>}
                      <span style={{ color: 'var(--muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: 16 }}>
                        <div style={{ display: 'flex', gap: 20, marginBottom: 14, flexWrap: 'wrap' }}>
                          {[
                            { label: 'Total Cost',   value: fmtCost(pb.total_cost) },
                            { label: 'Total Weight', value: fmtWeight(totalWeight) },
                            { label: 'Cost / lb',    value: cpl != null ? fmtCost(cpl) : '—' },
                          ].map(({ label, value }) => (
                            <div key={label}>
                              <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
                              <div style={{ fontWeight: 800, fontSize: '1rem' }}>{value}</div>
                            </div>
                          ))}
                        </div>
                        <button
                          className="btn btn-primary"
                          style={{ background: 'var(--success)', borderColor: 'var(--success)' }}
                          onClick={() => markLegacyComplete(pb)}
                        >
                          ✓ Mark Complete — Parts Returned
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {/* ── History ───────────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">History</h2>
          <div className="card-subtitle">
            {completedRuns.length} completed run{completedRuns.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {completedRuns.length === 0 ? (
            <div className="empty">No completed powder runs yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Returned</th>
                    <th style={{ textAlign: 'center' }}>Batches</th>
                    <th style={{ textAlign: 'right' }}>Total Weight</th>
                    <th style={{ textAlign: 'right' }}>Cost / lb</th>
                    <th style={{ textAlign: 'right' }}>Total Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {completedRuns.map((pb) => {
                    const linked      = buildBatches.filter((b) => b.powder_batch_id === pb.id)
                    const totalWeight = linked.reduce((s, b) => s + calcBatchWeight(b.id), 0)
                    const cpl         = totalWeight > 0 ? pb.total_cost / totalWeight : null
                    return (
                      <tr key={pb.id}>
                        <td style={{ fontWeight: 600 }}>{pb.batch_name}</td>
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
