'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type BatchStatus = 'planned' | 'in_progress' | 'at_powder' | 'complete'

type BuildBatch = {
  id: string
  name: string
  status: BatchStatus
  notes: string | null
  created_at: string
  completed_at: string | null
  stage_laser: boolean
  stage_sheet_bend: boolean
  stage_tube_bend: boolean
  stage_saw: boolean
  stage_drill: boolean
  stage_weld: boolean
  powder_batch_id: string | null
}

type BuildBatchLine = {
  id: string
  batch_id: string
  sku_id: string
  qty: number
  mat_cost_snapshot: number | null
}

type SKU = { id: string; description: string }

type Part = {
  id: string
  part_number: string
  description: string
  part_type: 'tube' | 'sheet'
  material: string | null
  tube_od: string | null
  tube_wall: string | null
  cut_length: number | null
  weight_lbs: number | null
  requires_laser: boolean
  requires_sheet_bend: boolean
  requires_tube_bend: boolean
  requires_saw: boolean
  requires_drill: boolean
  requires_weld: boolean
}

type SkuPart = { sku_id: string; part_id: string; qty: number }
type SkuSubAssembly = { sku_id: string; sub_assembly_id: string; qty: number }
type SubAssemblyPart = { sub_assembly_id: string; part_id: string; qty: number }

type MaterialRecord = {
  id: string
  material_type: string
  tube_od: string | null
  tube_wall: string | null
  thickness: string | null
  unit_weight_lbs: number | null
  stock_length_in: number | null
  qty_on_hand: number | null
}

type PriceLog = { material_id: string; price: number }

type View = 'list' | 'create' | 'detail' | 'traveler'

// ── Stage config ──────────────────────────────────────────────────────────────

const STAGES = [
  { key: 'stage_laser',      partKey: 'requires_laser',      label: 'Laser' },
  { key: 'stage_sheet_bend', partKey: 'requires_sheet_bend', label: 'Sheet Bend' },
  { key: 'stage_tube_bend',  partKey: 'requires_tube_bend',  label: 'Tube Bend' },
  { key: 'stage_saw',        partKey: 'requires_saw',        label: 'Saw' },
  { key: 'stage_drill',      partKey: 'requires_drill',      label: 'Drill Press' },
  { key: 'stage_weld',       partKey: 'requires_weld',       label: 'Weld' },
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtCost(n: number | null) {
  if (n == null) return '—'
  return '$' + n.toFixed(2)
}

const STATUS_STYLE: Record<BatchStatus, { label: string; bg: string; color: string }> = {
  planned:     { label: 'Planned',         bg: 'rgba(100,116,139,0.18)', color: '#94a3b8' },
  in_progress: { label: 'In Progress',     bg: 'rgba(234,179,8,0.18)',   color: '#facc15' },
  at_powder:   { label: 'At Powder Coater', bg: 'rgba(167,139,250,0.2)', color: '#a78bfa' },
  complete:    { label: 'Complete',         bg: 'rgba(34,197,94,0.18)',  color: '#4ade80' },
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BatchesPage() {
  const supabase = useMemo(() => createBrowserClient(), [])
  const router   = useRouter()

  const [view, setView]             = useState<View>('list')
  const [batches, setBatches]       = useState<BuildBatch[]>([])
  const [lines, setLines]           = useState<BuildBatchLine[]>([])
  const [skus, setSkus]             = useState<SKU[]>([])
  const [parts, setParts]           = useState<Part[]>([])
  const [skuParts, setSkuParts]     = useState<SkuPart[]>([])
  const [skuSubs, setSkuSubs]       = useState<SkuSubAssembly[]>([])
  const [subParts, setSubParts]     = useState<SubAssemblyPart[]>([])
  const [materials, setMaterials]   = useState<MaterialRecord[]>([])
  const [priceLogs, setPriceLogs]   = useState<PriceLog[]>([])

  const [loading, setLoading]       = useState(true)
  const [message, setMessage]       = useState('')
  const [activeBatch, setActiveBatch] = useState<BuildBatch | null>(null)

  // Create form
  const [createName, setCreateName]   = useState('')
  const [createNotes, setCreateNotes] = useState('')
  const [createRows, setCreateRows]   = useState([{ skuId: '', qty: '1', skuLookup: '' }])
  const [createDropdown, setCreateDropdown] = useState<number | null>(null)
  const [saving, setSaving]           = useState(false)

  // ── Load ─────────────────────────────────────────────────────────────────────

  async function loadAll() {
    setLoading(true)
    const [
      { data: batchData },
      { data: lineData },
      { data: skuData },
      { data: partData },
      { data: spData },
      { data: ssData },
      { data: sapData },
      { data: matData },
      { data: plData },
    ] = await Promise.all([
      supabase.from('build_batches').select('*').order('created_at', { ascending: false }),
      supabase.from('build_batch_lines').select('*'),
      supabase.from('skus').select('id, description').order('id'),
      supabase.from('parts').select('id, part_number, description, part_type, material, tube_od, tube_wall, cut_length, weight_lbs, requires_laser, requires_sheet_bend, requires_tube_bend, requires_saw, requires_drill, requires_weld'),
      supabase.from('sku_parts').select('sku_id, part_id, qty'),
      supabase.from('sku_sub_assemblies').select('sku_id, sub_assembly_id, qty'),
      supabase.from('sub_assembly_parts').select('sub_assembly_id, part_id, qty'),
      supabase.from('materials').select('id, material_type, tube_od, tube_wall, thickness, unit_weight_lbs, stock_length_in, qty_on_hand'),
      supabase.from('material_price_logs').select('material_id, price').order('date_purchased', { ascending: false }),
    ])
    setBatches((batchData ?? []) as BuildBatch[])
    setLines((lineData ?? []) as BuildBatchLine[])
    setSkus((skuData ?? []) as SKU[])
    setParts((partData ?? []) as Part[])
    setSkuParts((spData ?? []) as SkuPart[])
    setSkuSubs((ssData ?? []) as SkuSubAssembly[])
    setSubParts((sapData ?? []) as SubAssemblyPart[])
    setMaterials((matData ?? []) as MaterialRecord[])
    setPriceLogs((plData ?? []) as PriceLog[])
    setLoading(false)
  }

  useEffect(() => {
    // Check for sessionStorage import from planner
    try {
      const raw = sessionStorage.getItem('garvin:batch_import')
      if (raw) {
        sessionStorage.removeItem('garvin:batch_import')
        const imported = JSON.parse(raw) as Array<{ skuId: string; qty: string; skuLookup: string }>
        if (imported?.length) {
          setCreateRows(imported.map((r) => ({ skuId: r.skuId, qty: r.qty, skuLookup: r.skuLookup })))
          setView('create')
        }
      }
    } catch { /* ignore */ }
    void loadAll()
  }, [])

  // ── Derived helpers ───────────────────────────────────────────────────────────

  // Get all part IDs (and their qtys) for a given SKU
  function getSkuPartEntries(skuId: string): Array<{ partId: string; qty: number }> {
    const result: Array<{ partId: string; qty: number }> = []
    for (const sp of skuParts) {
      if (sp.sku_id === skuId) result.push({ partId: sp.part_id, qty: sp.qty })
    }
    for (const ss of skuSubs) {
      if (ss.sku_id !== skuId) continue
      for (const sap of subParts) {
        if (sap.sub_assembly_id !== ss.sub_assembly_id) continue
        result.push({ partId: sap.part_id, qty: sap.qty * ss.qty })
      }
    }
    return result
  }

  // Determine which stages are required for a set of batch lines
  function getRequiredStages(batchLines: BuildBatchLine[]) {
    const required = new Set<string>()
    for (const line of batchLines) {
      const entries = getSkuPartEntries(line.sku_id)
      for (const { partId } of entries) {
        const part = parts.find((p) => p.id === partId)
        if (!part) continue
        if (part.requires_laser)      required.add('stage_laser')
        if (part.requires_sheet_bend) required.add('stage_sheet_bend')
        if (part.requires_tube_bend)  required.add('stage_tube_bend')
        if (part.requires_saw)        required.add('stage_saw')
        if (part.requires_drill)      required.add('stage_drill')
        if (part.requires_weld)       required.add('stage_weld')
      }
    }
    return required
  }

  // Calculate material cost for a single SKU × qty
  function calcMatCost(skuId: string, batchQty: number): number {
    const entries = getSkuPartEntries(skuId)
    let total = 0
    for (const { partId, qty: partQty } of entries) {
      const part = parts.find((p) => p.id === partId)
      if (!part?.weight_lbs) continue
      const mat = materials.find((m) =>
        m.material_type === part.part_type &&
        (part.part_type === 'tube'
          ? m.tube_od === part.tube_od && m.tube_wall === part.tube_wall
          : m.thickness === part.material)
      )
      if (!mat?.unit_weight_lbs) continue
      const log = priceLogs.find((pl) => pl.material_id === mat.id)
      if (!log) continue
      const costPerLb = log.price / mat.unit_weight_lbs
      total += part.weight_lbs * costPerLb * partQty
    }
    return total * batchQty
  }

  // ── Actions ───────────────────────────────────────────────────────────────────

  async function createBatch() {
    if (!createName.trim()) { setMessage('Name is required.'); return }
    const filledRows = createRows.filter((r) => r.skuId.trim() && r.qty.trim())
    if (!filledRows.length) { setMessage('Add at least one SKU.'); return }
    setSaving(true); setMessage('')
    const { data: batch, error } = await supabase
      .from('build_batches')
      .insert({ name: createName.trim(), notes: createNotes.trim() || null, status: 'planned' })
      .select('*').single()
    if (error || !batch) { setMessage('Save failed: ' + (error?.message ?? 'unknown')); setSaving(false); return }
    await supabase.from('build_batch_lines').insert(
      filledRows.map((r) => ({ batch_id: batch.id, sku_id: r.skuId.trim(), qty: parseInt(r.qty) || 1 }))
    )
    setCreateName(''); setCreateNotes(''); setCreateRows([{ skuId: '', qty: '1', skuLookup: '' }])
    await loadAll()
    const fresh = (await supabase.from('build_batches').select('*').eq('id', batch.id).single()).data
    setActiveBatch(fresh as BuildBatch)
    setView('detail')
    setSaving(false)
  }

  async function updateStatus(batch: BuildBatch, status: BatchStatus) {
    const updates: Partial<BuildBatch> & { completed_at?: string } = { status }
    if (status === 'complete') updates.completed_at = new Date().toISOString()
    await supabase.from('build_batches').update(updates).eq('id', batch.id)
    const updated = { ...batch, ...updates }
    setBatches((prev) => prev.map((b) => b.id === batch.id ? updated as BuildBatch : b))
    setActiveBatch(updated as BuildBatch)
  }

  async function toggleStage(batch: BuildBatch, stageKey: string, value: boolean) {
    await supabase.from('build_batches').update({ [stageKey]: value }).eq('id', batch.id)
    const updated = { ...batch, [stageKey]: value }
    setBatches((prev) => prev.map((b) => b.id === batch.id ? updated as BuildBatch : b))
    setActiveBatch(updated as BuildBatch)
  }

  async function sendToPowder(batch: BuildBatch) {
    await supabase.from('build_batches').update({ status: 'at_powder' }).eq('id', batch.id)
    router.push('/powder')
  }

  async function markCompleteWithCost(batch: BuildBatch) {
    const batchLines = lines.filter((l) => l.batch_id === batch.id)
    // Snapshot mat cost per line
    for (const line of batchLines) {
      const cost = calcMatCost(line.sku_id, line.qty)
      await supabase.from('build_batch_lines').update({ mat_cost_snapshot: cost }).eq('id', line.id)
    }
    await supabase.from('build_batches').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', batch.id)
    await loadAll()
    const fresh = (await supabase.from('build_batches').select('*').eq('id', batch.id).single()).data
    setActiveBatch(fresh as BuildBatch)
  }

  async function deductMaterials(batch: BuildBatch) {
    const batchLines = lines.filter((l) => l.batch_id === batch.id)
    const deductions: Record<string, number> = {} // materialId → bars deducted

    for (const line of batchLines) {
      const entries = getSkuPartEntries(line.sku_id)
      for (const { partId, qty: partQty } of entries) {
        const part = parts.find((p) => p.id === partId)
        if (!part || part.part_type !== 'tube' || !part.cut_length) continue
        const mat = materials.find((m) =>
          m.material_type === 'tube' && m.tube_od === part.tube_od && m.tube_wall === part.tube_wall
        )
        if (!mat?.stock_length_in) continue
        const totalLength = part.cut_length * partQty * line.qty
        const barsNeeded = Math.ceil(totalLength / mat.stock_length_in)
        deductions[mat.id] = (deductions[mat.id] ?? 0) + barsNeeded
      }
    }

    for (const [matId, bars] of Object.entries(deductions)) {
      const mat = materials.find((m) => m.id === matId)
      const current = mat?.qty_on_hand ?? 0
      await supabase.from('materials').update({ qty_on_hand: Math.max(0, current - bars) }).eq('id', matId)
    }

    const summary = Object.entries(deductions)
      .map(([id, bars]) => `${materials.find((m) => m.id === id)?.tube_od ?? id}: −${bars} bars`)
      .join(', ')
    setMessage(summary ? `Deducted: ${summary}` : 'No tube materials to deduct.')
    await loadAll()
  }

  // ── SKU autocomplete ──────────────────────────────────────────────────────────

  function skuSuggestions(query: string) {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return skus.filter((s) => s.id.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)).slice(0, 10)
  }

  function updateCreateRow(idx: number, field: 'skuId' | 'qty' | 'skuLookup', val: string) {
    setCreateRows((prev) => prev.map((r, i) => i === idx ? { ...r, [field]: val } : r))
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) return <div className="section-stack"><div className="empty">Loading…</div></div>

  // ── TRAVELER VIEW ─────────────────────────────────────────────────────────────
  if (view === 'traveler' && activeBatch) {
    const batchLines = lines.filter((l) => l.batch_id === activeBatch.id)

    // Build part qty map: partId → total qty across all SKU lines
    const partQtyMap: Record<string, { part: Part; totalQty: number }> = {}
    for (const line of batchLines) {
      const entries = getSkuPartEntries(line.sku_id)
      for (const { partId, qty } of entries) {
        const part = parts.find((p) => p.id === partId)
        if (!part) continue
        if (!partQtyMap[partId]) partQtyMap[partId] = { part, totalQty: 0 }
        partQtyMap[partId].totalQty += qty * line.qty
      }
    }
    const allParts = Object.values(partQtyMap)
    const totalParts = allParts.reduce((s, p) => s + p.totalQty, 0)

    return (
      <div className="section-stack">
        <style>{`@media print { .no-print { display: none !important } }`}</style>

        <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0' }}>
          <button className="btn btn-secondary" onClick={() => setView('detail')}>← Back to Batch</button>
          <button className="btn btn-primary" onClick={() => window.print()}>🖨 Print Traveler</button>
        </div>

        <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: '20px 28px' }}>
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Production Traveler</div>
            <h1 style={{ margin: '4px 0', fontSize: '1.5rem', fontWeight: 800 }}>{activeBatch.name}</h1>
            <div style={{ color: 'var(--text-2)', fontSize: '0.85rem' }}>
              Created {fmtDate(activeBatch.created_at)} · {batchLines.length} SKU{batchLines.length !== 1 ? 's' : ''} · {totalParts} total parts
            </div>
          </div>

          {STAGES.map(({ key: stageKey, partKey, label }) => {
            const stageParts = allParts.filter(({ part }) => part[partKey as keyof Part])
            if (stageParts.length === 0) return null
            return (
              <div key={stageKey} style={{ marginBottom: 28, pageBreakInside: 'avoid' }}>
                <div style={{
                  fontWeight: 800, fontSize: '1rem', marginBottom: 8,
                  padding: '6px 12px', background: 'var(--panel-2)',
                  borderLeft: '4px solid var(--accent)', borderRadius: '0 6px 6px 0',
                }}>
                  {label}
                </div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Part #</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'center' }}>Qty</th>
                      <th style={{ textAlign: 'center' }}>☐</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stageParts.map(({ part, totalQty }) => (
                      <tr key={part.id}>
                        <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{part.part_number}</td>
                        <td>{part.description}</td>
                        <td style={{ textAlign: 'center', fontWeight: 700 }}>{totalQty}</td>
                        <td style={{ textAlign: 'center', fontSize: '1.1rem' }}>☐</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}

          <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)', color: 'var(--muted)', fontSize: '0.8rem' }}>
            Powder coat is performed by outside vendor after all stages above are complete.
          </div>
        </div>
      </div>
    )
  }

  // ── DETAIL VIEW ───────────────────────────────────────────────────────────────
  if (view === 'detail' && activeBatch) {
    const batchLines   = lines.filter((l) => l.batch_id === activeBatch.id)
    const requiredStages = getRequiredStages(batchLines)
    const doneStages   = STAGES.filter((s) => requiredStages.has(s.key) && activeBatch[s.key as keyof BuildBatch])
    const totalRequired = requiredStages.size
    const totalDone    = doneStages.length
    const allDone      = totalRequired > 0 && totalDone === totalRequired
    const pct          = totalRequired > 0 ? Math.round((totalDone / totalRequired) * 100) : 0
    const ss           = STATUS_STYLE[activeBatch.status]
    const totalMatCost = batchLines.reduce((s, l) => s + (l.mat_cost_snapshot ?? 0), 0)
    const hasSnapshots = batchLines.some((l) => l.mat_cost_snapshot != null)

    return (
      <div className="section-stack">
        <div className="page-header no-print">
          <div>
            <div className="kicker">Garvin Internal Tool</div>
            <h1 className="page-title">{activeBatch.name}</h1>
            <div className="page-subtitle">Build batch detail</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => { setActiveBatch(null); setView('list') }}>← All Batches</button>
            <button className="btn btn-secondary" onClick={() => setView('traveler')}>🖨 View Traveler</button>
          </div>
        </div>

        {message && (
          <div className="message" style={{ marginBottom: 0 }}>{message}</div>
        )}

        {/* Status + actions card */}
        <section className="card">
          <div className="card-body">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <span style={{ background: ss.bg, color: ss.color, borderRadius: 20, padding: '4px 14px', fontWeight: 700, fontSize: '0.82rem' }}>
                {ss.label}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>Created {fmtDate(activeBatch.created_at)}</span>
              {activeBatch.completed_at && (
                <span style={{ color: 'var(--success)', fontSize: '0.82rem' }}>Completed {fmtDate(activeBatch.completed_at)}</span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {activeBatch.status === 'planned' && (
                  <button className="btn btn-primary" onClick={() => updateStatus(activeBatch, 'in_progress')}>
                    ▶ Start Build
                  </button>
                )}
                {activeBatch.status === 'at_powder' && (
                  <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => markCompleteWithCost(activeBatch)}>
                    Mark Complete Manually
                  </button>
                )}
                {(activeBatch.status === 'at_powder' || activeBatch.status === 'complete') && (
                  <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => deductMaterials(activeBatch)}>
                    Deduct Materials
                  </button>
                )}
              </div>
            </div>
            {activeBatch.notes && (
              <div style={{ marginTop: 10, color: 'var(--text-2)', fontSize: '0.85rem' }}>{activeBatch.notes}</div>
            )}
          </div>
        </section>

        {/* at_powder banner */}
        {activeBatch.status === 'at_powder' && (
          <div style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.35)', borderRadius: 8, padding: '14px 20px', color: '#a78bfa', fontWeight: 600 }}>
            🎨 At Powder Coater — waiting for parts to return. Go to the{' '}
            <button onClick={() => router.push('/powder')} style={{ background: 'none', border: 'none', color: '#a78bfa', textDecoration: 'underline', cursor: 'pointer', fontWeight: 700, padding: 0 }}>
              Powder Coat page
            </button>{' '}to manage this run.
          </div>
        )}

        {/* Stage progress (in_progress only) */}
        {activeBatch.status === 'in_progress' && totalRequired > 0 && (
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Manufacturing Progress</h2>
              <div className="card-subtitle">{totalDone} of {totalRequired} stages complete</div>
            </div>
            <div className="card-body">
              {/* Progress bar */}
              <div style={{ height: 10, background: 'var(--panel-2)', borderRadius: 6, marginBottom: 18, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: allDone ? 'var(--success)' : 'var(--accent)', borderRadius: 6, transition: 'width 0.3s' }} />
              </div>

              {/* Stage checkboxes */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {STAGES.filter((s) => requiredStages.has(s.key)).map((stage) => {
                  const done = !!activeBatch[stage.key as keyof BuildBatch]
                  return (
                    <label key={stage.key} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={done}
                        onChange={(e) => toggleStage(activeBatch, stage.key, e.target.checked)}
                        style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--accent)' }}
                      />
                      <span style={{
                        fontSize: '0.9rem', fontWeight: 600,
                        color: done ? 'var(--success)' : 'var(--text)',
                        textDecoration: done ? 'line-through' : 'none',
                      }}>
                        {stage.label}
                      </span>
                      {done && <span style={{ fontSize: '0.78rem', color: 'var(--success)' }}>✓</span>}
                    </label>
                  )
                })}
              </div>

              {allDone && (
                <div style={{ marginTop: 20, padding: '14px 18px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 8 }}>
                  <div style={{ color: 'var(--success)', fontWeight: 700, marginBottom: 10 }}>
                    ✓ All manufacturing stages complete!
                  </div>
                  <button
                    className="btn btn-primary"
                    style={{ background: '#a78bfa', borderColor: '#a78bfa' }}
                    onClick={() => sendToPowder(activeBatch)}
                  >
                    🎨 Send to Powder Coater →
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {/* SKU lines table */}
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">SKU Lines</h2>
            <div className="card-subtitle">{batchLines.length} SKU{batchLines.length !== 1 ? 's' : ''}</div>
          </div>
          <div className="card-body">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Description</th>
                    <th style={{ textAlign: 'center' }}>Qty</th>
                    {hasSnapshots && <th style={{ textAlign: 'right' }}>Mat Cost / Unit</th>}
                    {hasSnapshots && <th style={{ textAlign: 'right' }}>Total Mat Cost</th>}
                  </tr>
                </thead>
                <tbody>
                  {batchLines.map((line) => {
                    const sku = skus.find((s) => s.id === line.sku_id)
                    const costPerUnit = line.mat_cost_snapshot != null ? line.mat_cost_snapshot / line.qty : null
                    return (
                      <tr key={line.id}>
                        <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{line.sku_id}</td>
                        <td>{sku?.description ?? '—'}</td>
                        <td style={{ textAlign: 'center', fontWeight: 700 }}>{line.qty}</td>
                        {hasSnapshots && <td style={{ textAlign: 'right' }}>{fmtCost(costPerUnit)}</td>}
                        {hasSnapshots && <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtCost(line.mat_cost_snapshot)}</td>}
                      </tr>
                    )
                  })}
                </tbody>
                {hasSnapshots && (
                  <tfoot>
                    <tr>
                      <td colSpan={3} style={{ fontWeight: 700, color: 'var(--muted)' }}>Total</td>
                      <td />
                      <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{fmtCost(totalMatCost)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </section>
      </div>
    )
  }

  // ── CREATE VIEW ───────────────────────────────────────────────────────────────
  if (view === 'create') {
    return (
      <div className="section-stack">
        <div className="page-header">
          <div>
            <div className="kicker">Garvin Internal Tool</div>
            <h1 className="page-title">New Build Batch</h1>
          </div>
          <button className="btn btn-secondary" onClick={() => setView('list')}>← Cancel</button>
        </div>

        {message && <div className="warning-box">{message}</div>}

        <section className="card">
          <div className="card-header"><h2 className="card-title">Batch Details</h2></div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="label">Batch Name *</label>
                <input className="field" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="e.g. Week 15 Run" />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="label">Notes</label>
                <textarea className="field" rows={2} value={createNotes} onChange={(e) => setCreateNotes(e.target.value)} placeholder="Optional" style={{ resize: 'vertical' }} />
              </div>
            </div>

            <label className="label" style={{ marginBottom: 8, display: 'block' }}>SKUs to Build</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              {createRows.map((row, idx) => {
                const suggestions = createDropdown === idx ? skuSuggestions(row.skuLookup || row.skuId) : []
                return (
                  <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', position: 'relative' }}>
                    <div style={{ flex: 1, position: 'relative' }}>
                      <input
                        className="field"
                        placeholder="SKU ID or search…"
                        value={row.skuLookup || row.skuId}
                        onChange={(e) => { updateCreateRow(idx, 'skuLookup', e.target.value); updateCreateRow(idx, 'skuId', e.target.value); setCreateDropdown(idx) }}
                        onFocus={() => setCreateDropdown(idx)}
                        onBlur={() => setTimeout(() => setCreateDropdown(null), 150)}
                      />
                      {suggestions.length > 0 && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.3)', maxHeight: 220, overflowY: 'auto' }}>
                          {suggestions.map((s) => (
                            <div key={s.id}
                              style={{ padding: '7px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: '0.84rem' }}
                              onMouseDown={() => { updateCreateRow(idx, 'skuId', s.id); updateCreateRow(idx, 'skuLookup', s.id); setCreateDropdown(null) }}
                            >
                              <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>{s.id}</span>
                              <span style={{ color: 'var(--text-2)', marginLeft: 8 }}>{s.description}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <input
                      className="field"
                      type="number"
                      min="1"
                      step="1"
                      value={row.qty}
                      onChange={(e) => updateCreateRow(idx, 'qty', e.target.value)}
                      style={{ width: 80 }}
                      placeholder="Qty"
                    />
                    <button className="btn btn-secondary" style={{ height: 36, padding: '0 10px', flexShrink: 0 }}
                      onClick={() => setCreateRows((prev) => prev.filter((_, i) => i !== idx))}>✕</button>
                  </div>
                )
              })}
            </div>

            <div className="btn-row">
              <button className="btn btn-secondary" onClick={() => setCreateRows((prev) => [...prev, { skuId: '', qty: '1', skuLookup: '' }])}>+ Add Row</button>
              <button className="btn btn-primary" disabled={saving} onClick={createBatch}>{saving ? 'Saving…' : 'Create Batch'}</button>
            </div>
          </div>
        </section>
      </div>
    )
  }

  // ── LIST VIEW ─────────────────────────────────────────────────────────────────
  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Build Batches</h1>
          <div className="page-subtitle">Track build runs from planning through manufacturing and powder coat.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setView('create')}>+ New Batch</button>
      </div>

      <section className="card">
        <div className="card-body">
          {batches.length === 0 ? (
            <div className="empty">No batches yet. Click "New Batch" to create your first build run.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>SKUs</th>
                    <th>Created</th>
                    <th>Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((batch) => {
                    const ss   = STATUS_STYLE[batch.status]
                    const skuCount = lines.filter((l) => l.batch_id === batch.id).length
                    return (
                      <tr key={batch.id} style={{ cursor: 'pointer' }}
                        onClick={() => { setActiveBatch(batch); setView('detail') }}>
                        <td style={{ fontWeight: 700 }}>{batch.name}</td>
                        <td>
                          <span style={{ background: ss.bg, color: ss.color, borderRadius: 20, padding: '2px 10px', fontSize: '0.76rem', fontWeight: 700 }}>
                            {ss.label}
                          </span>
                        </td>
                        <td>{skuCount}</td>
                        <td>{fmtDate(batch.created_at)}</td>
                        <td>{fmtDate(batch.completed_at)}</td>
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
