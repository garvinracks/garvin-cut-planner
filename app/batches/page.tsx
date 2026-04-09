'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type BuildBatch = {
  id: string
  name: string
  status: 'planned' | 'in_progress' | 'complete'
  notes: string | null
  created_at: string
  completed_at: string | null
}

type BuildBatchLine = {
  id: string
  batch_id: string
  sku_id: string
  qty: number
  mat_cost_snapshot: number | null
}

type SKU = {
  id: string
  description: string
  category: string | null
}

type Part = {
  id: string
  part_number: string
  description: string
  part_type: 'tube' | 'sheet'
  material: string | null
  tube_od: number | null
  tube_wall: number | null
  cut_length: number | null
  weight_lbs: number | null
  requires_laser: boolean
  requires_sheet_bend: boolean
  requires_tube_bend: boolean
  requires_saw: boolean
  requires_drill: boolean
  requires_weld: boolean
  requires_powder: boolean
}

type SkuPart = {
  sku_id: string
  part_id: string
  qty: number
}

type SubAssembly = {
  id: string
  name: string
}

type SkuSubAssembly = {
  sku_id: string
  sub_assembly_id: string
  qty: number
}

type SubAssemblyPart = {
  sub_assembly_id: string
  part_id: string
  qty: number
}

type Material = {
  id: string
  name: string
  material_type: string
  material: string | null
  tube_od: number | null
  tube_wall: number | null
  unit_weight_lbs: number | null
  stock_length_in: number | null
  scrap_rate: number | null
  qty_on_hand: number | null
}

type MaterialPriceLog = {
  id: string
  material_id: string
  price: number
  date_purchased: string
}

type BatchImportRow = {
  skuId: string
  qty: number
  skuLookup?: string
}

type SkuRow = {
  skuId: string
  qty: number
  search: string
  results: SKU[]
}

type View = 'list' | 'create' | 'detail' | 'traveler'

type Stage = {
  key: keyof Part
  label: string
}

const STAGES: Stage[] = [
  { key: 'requires_laser',      label: 'Laser Cut' },
  { key: 'requires_sheet_bend', label: 'Sheet Bend' },
  { key: 'requires_tube_bend',  label: 'Tube Bend' },
  { key: 'requires_saw',        label: 'Saw' },
  { key: 'requires_drill',      label: 'Drill Press' },
  { key: 'requires_weld',       label: 'Weld' },
  { key: 'requires_powder',     label: 'Powder Coat' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatCurrency(n: number | null) {
  if (n == null) return '—'
  return '$' + n.toFixed(2)
}

const STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  planned:     { bg: 'rgba(148,163,184,0.18)', text: 'var(--muted)',   label: 'Planned' },
  in_progress: { bg: 'rgba(234,179,8,0.18)',   text: 'var(--warning)', label: 'In Progress' },
  complete:    { bg: 'rgba(34,197,94,0.18)',    text: 'var(--success)', label: 'Complete' },
}

function StatusChip({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.planned
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: 99,
      fontSize: 12,
      fontWeight: 600,
      background: s.bg,
      color: s.text,
    }}>
      {s.label}
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BatchesPage() {
  const supabase = useMemo(() => createBrowserClient(), [])
  const router   = useRouter()

  // Core data
  const [batches, setBatches]         = useState<BuildBatch[]>([])
  const [skus, setSkus]               = useState<SKU[]>([])
  const [parts, setParts]             = useState<Part[]>([])
  const [skuParts, setSkuParts]       = useState<SkuPart[]>([])
  const [skuSubAssemblies, setSkuSubAssemblies] = useState<SkuSubAssembly[]>([])
  const [subAssemblyParts, setSubAssemblyParts] = useState<SubAssemblyPart[]>([])
  const [materials, setMaterials]     = useState<Material[]>([])
  const [priceLogs, setPriceLogs]     = useState<MaterialPriceLog[]>([])
  const [loading, setLoading]         = useState(true)

  // View state
  const [view, setView]               = useState<View>('list')
  const [selectedBatch, setSelectedBatch] = useState<BuildBatch | null>(null)
  const [batchLines, setBatchLines]   = useState<BuildBatchLine[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)

  // Create form
  const [createName, setCreateName]   = useState('')
  const [createNotes, setCreateNotes] = useState('')
  const [skuRows, setSkuRows]         = useState<SkuRow[]>([{ skuId: '', qty: 1, search: '', results: [] }])
  const [saving, setSaving]           = useState(false)
  const [createError, setCreateError] = useState('')

  // Detail actions
  const [transitioning, setTransitioning] = useState(false)
  const [deducting, setDeducting]         = useState(false)
  const [deductSummary, setDeductSummary] = useState<string[]>([])
  const [actionMessage, setActionMessage] = useState('')

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    const [
      { data: batchData },
      { data: skuData },
    ] = await Promise.all([
      supabase.from('build_batches').select('*').order('created_at', { ascending: false }),
      supabase.from('skus').select('id, description, category').order('id'),
    ])
    setBatches((batchData as BuildBatch[]) ?? [])
    setSkus((skuData as SKU[]) ?? [])
    setLoading(false)
  }

  async function loadDetailData() {
    const [
      { data: partsData },
      { data: spData },
      { data: ssaData },
      { data: sapData },
      { data: matData },
      { data: plData },
    ] = await Promise.all([
      supabase.from('parts').select('*'),
      supabase.from('sku_parts').select('*'),
      supabase.from('sku_sub_assemblies').select('*'),
      supabase.from('sub_assembly_parts').select('*'),
      supabase.from('materials').select('*'),
      supabase.from('material_price_logs').select('*').order('date_purchased', { ascending: false }),
    ])
    setParts((partsData as Part[]) ?? [])
    setSkuParts((spData as SkuPart[]) ?? [])
    setSkuSubAssemblies((ssaData as SkuSubAssembly[]) ?? [])
    setSubAssemblyParts((sapData as SubAssemblyPart[]) ?? [])
    setMaterials((matData as Material[]) ?? [])
    setPriceLogs((plData as MaterialPriceLog[]) ?? [])
  }

  // ── Session import ────────────────────────────────────────────────────────

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('garvin:batch_import')
      if (!raw) return
      const imported = JSON.parse(raw) as BatchImportRow[]
      sessionStorage.removeItem('garvin:batch_import')
      if (Array.isArray(imported) && imported.length > 0) {
        setSkuRows(imported.map((r) => ({
          skuId: r.skuId ?? '',
          qty: r.qty ?? 1,
          search: r.skuLookup ?? r.skuId ?? '',
          results: [],
        })))
        setView('create')
      }
    } catch {
      // ignore
    }
  }, [])

  // ── SKU search ────────────────────────────────────────────────────────────

  function searchSkus(query: string): SKU[] {
    if (!query) return []
    const q = query.toLowerCase()
    return skus.filter(
      (s) => s.id.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)
    ).slice(0, 10)
  }

  function updateSkuRow(idx: number, patch: Partial<SkuRow>) {
    setSkuRows((prev) => prev.map((r, i) => {
      if (i !== idx) return r
      const next = { ...r, ...patch }
      if ('search' in patch) {
        next.results = searchSkus(patch.search ?? '')
      }
      return next
    }))
  }

  function selectSkuInRow(idx: number, sku: SKU) {
    setSkuRows((prev) => prev.map((r, i) =>
      i === idx ? { ...r, skuId: sku.id, search: sku.id + ' — ' + sku.description, results: [] } : r
    ))
  }

  function addSkuRow() {
    setSkuRows((prev) => [...prev, { skuId: '', qty: 1, search: '', results: [] }])
  }

  function removeSkuRow(idx: number) {
    setSkuRows((prev) => prev.filter((_, i) => i !== idx))
  }

  // ── Create batch ──────────────────────────────────────────────────────────

  async function saveBatch() {
    setCreateError('')
    if (!createName.trim()) { setCreateError('Batch name is required.'); return }
    const validRows = skuRows.filter((r) => r.skuId)
    if (validRows.length === 0) { setCreateError('Add at least one SKU.'); return }

    setSaving(true)
    const { data: batch, error: batchErr } = await supabase
      .from('build_batches')
      .insert({ name: createName.trim(), status: 'planned', notes: createNotes.trim() || null })
      .select()
      .single()

    if (batchErr || !batch) {
      setCreateError('Failed to create batch: ' + (batchErr?.message ?? 'unknown error'))
      setSaving(false)
      return
    }

    const lines = validRows.map((r) => ({ batch_id: batch.id, sku_id: r.skuId, qty: r.qty }))
    const { error: lineErr } = await supabase.from('build_batch_lines').insert(lines)

    if (lineErr) {
      setCreateError('Batch created but failed to save lines: ' + lineErr.message)
      setSaving(false)
      return
    }

    setSaving(false)
    setCreateName('')
    setCreateNotes('')
    setSkuRows([{ skuId: '', qty: 1, search: '', results: [] }])
    await load()
    await openBatch(batch as BuildBatch)
  }

  // ── Open detail ───────────────────────────────────────────────────────────

  async function openBatch(batch: BuildBatch) {
    setSelectedBatch(batch)
    setLoadingDetail(true)
    setActionMessage('')
    setDeductSummary([])
    setView('detail')

    const [{ data: lines }] = await Promise.all([
      supabase.from('build_batch_lines').select('*').eq('batch_id', batch.id),
    ])
    setBatchLines((lines as BuildBatchLine[]) ?? [])
    setLoadingDetail(false)
  }

  // ── Get all parts for a SKU (direct + via sub-assemblies), with qty multiplier ──

  function getExpandedParts(skuId: string): { part: Part; qty: number }[] {
    const result: Map<string, { part: Part; qty: number }> = new Map()

    const addPart = (partId: string, qty: number) => {
      const part = parts.find((p) => p.id === partId)
      if (!part) return
      const existing = result.get(partId)
      if (existing) existing.qty += qty
      else result.set(partId, { part, qty })
    }

    // Direct sku_parts
    for (const sp of skuParts.filter((sp) => sp.sku_id === skuId)) {
      addPart(sp.part_id, sp.qty)
    }

    // Sub-assemblies
    for (const ssa of skuSubAssemblies.filter((ssa) => ssa.sku_id === skuId)) {
      for (const sap of subAssemblyParts.filter((sap) => sap.sub_assembly_id === ssa.sub_assembly_id)) {
        addPart(sap.part_id, sap.qty * ssa.qty)
      }
    }

    return Array.from(result.values())
  }

  // ── Material cost calculation ─────────────────────────────────────────────

  function getLatestPrice(materialId: string): number | null {
    const logs = priceLogs.filter((l) => l.material_id === materialId)
    if (logs.length === 0) return null
    return logs[0].price // already sorted desc by date
  }

  function calcSkuMatCost(skuId: string): number | null {
    const expanded = getExpandedParts(skuId)
    let total = 0
    let hasAny = false

    for (const { part, qty } of expanded) {
      if (!part.weight_lbs) continue
      // find material by matching on material field (part.material references material name or id)
      const mat = materials.find(
        (m) => m.id === part.material || m.name === part.material
      )
      if (!mat || !mat.unit_weight_lbs) continue
      const latestPrice = getLatestPrice(mat.id)
      if (latestPrice == null) continue
      const costPerLb = latestPrice / mat.unit_weight_lbs
      total += part.weight_lbs * costPerLb * qty
      hasAny = true
    }

    return hasAny ? total : null
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  async function startBuild() {
    if (!selectedBatch) return
    setTransitioning(true)
    const { error } = await supabase
      .from('build_batches')
      .update({ status: 'in_progress' })
      .eq('id', selectedBatch.id)
    if (error) { setActionMessage('Error: ' + error.message); setTransitioning(false); return }
    const updated = { ...selectedBatch, status: 'in_progress' as const }
    setSelectedBatch(updated)
    setBatches((prev) => prev.map((b) => b.id === updated.id ? updated : b))
    setTransitioning(false)
    setActionMessage('Build started.')
  }

  async function markComplete() {
    if (!selectedBatch) return
    setTransitioning(true)
    setActionMessage('Calculating material costs…')

    // Load detail data if not already loaded
    if (parts.length === 0) await loadDetailData()

    const updates: { id: string; mat_cost_snapshot: number | null }[] = []

    for (const line of batchLines) {
      const cost = calcSkuMatCost(line.sku_id)
      const totalCost = cost != null ? cost * line.qty : null
      updates.push({ id: line.id, mat_cost_snapshot: totalCost })
    }

    // Update each line
    for (const u of updates) {
      await supabase
        .from('build_batch_lines')
        .update({ mat_cost_snapshot: u.mat_cost_snapshot })
        .eq('id', u.id)
    }

    const completedAt = new Date().toISOString()
    const { error } = await supabase
      .from('build_batches')
      .update({ status: 'complete', completed_at: completedAt })
      .eq('id', selectedBatch.id)

    if (error) { setActionMessage('Error: ' + error.message); setTransitioning(false); return }

    const updated = { ...selectedBatch, status: 'complete' as const, completed_at: completedAt }
    setSelectedBatch(updated)
    setBatches((prev) => prev.map((b) => b.id === updated.id ? updated : b))

    // Refresh lines
    const { data: freshLines } = await supabase
      .from('build_batch_lines')
      .select('*')
      .eq('batch_id', selectedBatch.id)
    setBatchLines((freshLines as BuildBatchLine[]) ?? [])

    setTransitioning(false)
    setActionMessage('Batch marked complete. Material costs recorded.')
  }

  // ── Material deduction ────────────────────────────────────────────────────

  async function deductMaterials() {
    if (!selectedBatch) return
    if (parts.length === 0) await loadDetailData()

    setDeducting(true)
    setActionMessage('')

    const summary: string[] = []
    const matUpdates: Map<string, number> = new Map()

    for (const line of batchLines) {
      const expanded = getExpandedParts(line.sku_id)
      for (const { part, qty: qtyPerSku } of expanded) {
        if (part.part_type !== 'tube') continue
        if (!part.cut_length || !part.tube_od || !part.tube_wall) continue

        const totalLengthIn = part.cut_length * qtyPerSku * line.qty
        const mat = materials.find(
          (m) =>
            m.material_type === 'tube' &&
            m.tube_od === part.tube_od &&
            m.tube_wall === part.tube_wall
        )
        if (!mat || !mat.stock_length_in) continue

        const barsUsed = Math.ceil(totalLengthIn / mat.stock_length_in)
        matUpdates.set(mat.id, (matUpdates.get(mat.id) ?? 0) + barsUsed)
      }
    }

    for (const [matId, barsUsed] of matUpdates) {
      const mat = materials.find((m) => m.id === matId)
      if (!mat) continue
      const newQty = (mat.qty_on_hand ?? 0) - barsUsed
      const { error } = await supabase
        .from('materials')
        .update({ qty_on_hand: newQty })
        .eq('id', matId)
      if (!error) {
        setMaterials((prev) => prev.map((m) => m.id === matId ? { ...m, qty_on_hand: newQty } : m))
        summary.push(`${mat.name}: −${barsUsed} bar${barsUsed !== 1 ? 's' : ''} (now ${newQty})`)
      } else {
        summary.push(`${mat.name}: ERROR — ${error.message}`)
      }
    }

    if (summary.length === 0) {
      summary.push('No tube materials found to deduct.')
    }
    summary.push('Note: Sheet material deduction is not automated (no area data).')

    setDeductSummary(summary)
    setDeducting(false)
    setActionMessage('')
  }

  // ── Traveler ──────────────────────────────────────────────────────────────

  async function openTraveler() {
    if (parts.length === 0) {
      setActionMessage('Loading traveler data…')
      await loadDetailData()
      setActionMessage('')
    }
    setView('traveler')
  }

  function getTravelerStages(): { stage: Stage; rows: { part: Part; totalQty: number }[] }[] {
    // Aggregate part totals across all batch lines
    const totals: Map<string, { part: Part; totalQty: number }> = new Map()

    for (const line of batchLines) {
      const expanded = getExpandedParts(line.sku_id)
      for (const { part, qty } of expanded) {
        const existing = totals.get(part.id)
        if (existing) existing.totalQty += qty * line.qty
        else totals.set(part.id, { part, totalQty: qty * line.qty })
      }
    }

    const allParts = Array.from(totals.values())

    return STAGES.map((stage) => ({
      stage,
      rows: allParts
        .filter((r) => r.part[stage.key] === true)
        .sort((a, b) => (a.part.part_number ?? '').localeCompare(b.part.part_number ?? '')),
    })).filter((s) => s.rows.length > 0)
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  function renderList() {
    return (
      <div className="section-stack">
        <div className="page-header no-print">
          <div>
            <div className="kicker">Production</div>
            <h1 className="page-title">Build Batches</h1>
            <p className="page-subtitle">Track build runs, generate production travelers, and record material costs.</p>
          </div>
          <div className="btn-row">
            <button
              className="btn btn-primary"
              onClick={() => { setView('create') }}
            >
              + New Batch
            </button>
          </div>
        </div>

        <section className="card no-print">
          <div className="card-header">
            <span className="card-title">All Batches</span>
          </div>
          <div className="card-body">
            {loading ? (
              <p className="message">Loading…</p>
            ) : batches.length === 0 ? (
              <p className="empty">No batches yet. Create your first batch to get started.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Batch Name</th>
                      <th>Status</th>
                      <th>SKUs</th>
                      <th>Created</th>
                      <th>Completed</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr
                        key={b.id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => { void openBatch(b) }}
                      >
                        <td style={{ fontWeight: 600 }}>{b.name}</td>
                        <td><StatusChip status={b.status} /></td>
                        <td style={{ color: 'var(--text-2)' }}>—</td>
                        <td style={{ color: 'var(--text-2)' }}>{formatDate(b.created_at)}</td>
                        <td style={{ color: 'var(--text-2)' }}>{formatDate(b.completed_at)}</td>
                        <td>
                          <button
                            className="btn btn-secondary"
                            style={{ fontSize: 12, padding: '3px 12px' }}
                            onClick={(e) => { e.stopPropagation(); void openBatch(b) }}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    )
  }

  function renderCreate() {
    return (
      <div className="section-stack no-print">
        <div className="page-header">
          <div>
            <div className="kicker">Production</div>
            <h1 className="page-title">New Build Batch</h1>
          </div>
          <div className="btn-row">
            <button className="btn btn-secondary" onClick={() => setView('list')}>
              ← Back
            </button>
          </div>
        </div>

        <section className="card">
          <div className="card-header">
            <span className="card-title">Batch Details</span>
          </div>
          <div className="card-body">
            <div className="grid-2">
              <div className="field">
                <label className="label">Batch Name *</label>
                <input
                  className="select"
                  style={{ width: '100%' }}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="e.g. Week 14 Build Run"
                />
              </div>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label className="label">Notes</label>
              <textarea
                className="select"
                style={{ width: '100%', minHeight: 72, resize: 'vertical' }}
                value={createNotes}
                onChange={(e) => setCreateNotes(e.target.value)}
                placeholder="Optional notes…"
              />
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <span className="card-title">SKUs</span>
            <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 12px' }} onClick={addSkuRow}>
              + Add Row
            </button>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {skuRows.map((row, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', position: 'relative' }}>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <input
                      className="select"
                      style={{ width: '100%' }}
                      value={row.search}
                      placeholder="Search SKU ID or description…"
                      onChange={(e) => updateSkuRow(idx, { search: e.target.value, skuId: '' })}
                    />
                    {row.results.length > 0 && (
                      <div style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        right: 0,
                        zIndex: 50,
                        background: 'var(--panel)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                        maxHeight: 220,
                        overflowY: 'auto',
                      }}>
                        {row.results.map((sku) => (
                          <div
                            key={sku.id}
                            style={{
                              padding: '8px 12px',
                              cursor: 'pointer',
                              borderBottom: '1px solid var(--border)',
                              fontSize: 13,
                            }}
                            onMouseDown={() => selectSkuInRow(idx, sku)}
                          >
                            <strong>{sku.id}</strong>
                            <span style={{ color: 'var(--text-2)', marginLeft: 8 }}>{sku.description}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <input
                    type="number"
                    className="select"
                    style={{ width: 80 }}
                    min={1}
                    value={row.qty}
                    onChange={(e) => updateSkuRow(idx, { qty: Math.max(1, parseInt(e.target.value) || 1) })}
                  />
                  <button
                    className="btn btn-secondary"
                    style={{ color: 'var(--danger)', padding: '6px 12px' }}
                    onClick={() => removeSkuRow(idx)}
                    disabled={skuRows.length === 1}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            {createError && (
              <div className="warning-box" style={{ marginTop: 12 }}>
                {createError}
              </div>
            )}

            <div className="btn-row" style={{ marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => setView('list')}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={saving} onClick={() => { void saveBatch() }}>
                {saving ? 'Saving…' : 'Save Batch'}
              </button>
            </div>
          </div>
        </section>
      </div>
    )
  }

  function renderDetail() {
    if (!selectedBatch) return null
    const sku = (skuId: string) => skus.find((s) => s.id === skuId)
    const totalMatCost = batchLines.reduce((sum, l) => sum + (l.mat_cost_snapshot ?? 0), 0)
    const anyMatCost = batchLines.some((l) => l.mat_cost_snapshot != null)

    return (
      <div className="section-stack no-print">
        <div className="page-header">
          <div>
            <div className="kicker">Build Batch</div>
            <h1 className="page-title">{selectedBatch.name}</h1>
            <p className="page-subtitle">
              Created {formatDate(selectedBatch.created_at)}
              {selectedBatch.completed_at ? ` · Completed ${formatDate(selectedBatch.completed_at)}` : ''}
            </p>
          </div>
          <div className="btn-row">
            <button className="btn btn-secondary" onClick={() => setView('list')}>
              ← All Batches
            </button>
            <button className="btn btn-secondary" onClick={() => { void openTraveler() }}>
              View Traveler
            </button>
          </div>
        </div>

        {/* Status + notes */}
        <section className="card">
          <div className="card-header">
            <span className="card-title">Status</span>
            <StatusChip status={selectedBatch.status} />
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <div>
                <div className="label">Status</div>
                <div><StatusChip status={selectedBatch.status} /></div>
              </div>
              {selectedBatch.completed_at && (
                <div>
                  <div className="label">Completed</div>
                  <div style={{ color: 'var(--success)' }}>{formatDate(selectedBatch.completed_at)}</div>
                </div>
              )}
              {selectedBatch.notes && (
                <div>
                  <div className="label">Notes</div>
                  <div style={{ color: 'var(--text-2)', maxWidth: 480 }}>{selectedBatch.notes}</div>
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="btn-row" style={{ marginTop: 16 }}>
              {selectedBatch.status === 'planned' && (
                <button
                  className="btn btn-primary"
                  disabled={transitioning}
                  onClick={() => { void startBuild() }}
                >
                  {transitioning ? 'Starting…' : '▶ Start Build'}
                </button>
              )}
              {selectedBatch.status === 'in_progress' && (
                <button
                  className="btn btn-primary"
                  disabled={transitioning}
                  style={{ background: 'var(--success)' }}
                  onClick={() => { void markComplete() }}
                >
                  {transitioning ? 'Completing…' : '✓ Mark Complete'}
                </button>
              )}
              {selectedBatch.status === 'complete' && (
                <button
                  className="btn btn-secondary"
                  disabled={deducting}
                  onClick={() => { void deductMaterials() }}
                >
                  {deducting ? 'Deducting…' : '⊖ Deduct Materials'}
                </button>
              )}
            </div>

            {actionMessage && (
              <p className="message" style={{ marginTop: 8 }}>{actionMessage}</p>
            )}

            {deductSummary.length > 0 && (
              <div style={{
                marginTop: 12,
                padding: '12px 16px',
                background: 'var(--panel-2)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}>
                <div className="label" style={{ marginBottom: 6 }}>Deduction Summary</div>
                {deductSummary.map((line, i) => (
                  <div key={i} style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>{line}</div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* SKU lines table */}
        <section className="card">
          <div className="card-header">
            <span className="card-title">SKU Lines</span>
            {anyMatCost && (
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
                Total mat cost: <strong style={{ color: 'var(--text)' }}>{formatCurrency(totalMatCost)}</strong>
              </span>
            )}
          </div>
          <div className="card-body">
            {loadingDetail ? (
              <p className="message">Loading lines…</p>
            ) : batchLines.length === 0 ? (
              <p className="empty">No lines in this batch.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>SKU ID</th>
                      <th>Description</th>
                      <th>Qty</th>
                      {anyMatCost && <th>Mat Cost / Unit</th>}
                      {anyMatCost && <th>Total Mat Cost</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {batchLines.map((line) => {
                      const s = sku(line.sku_id)
                      const perUnit = line.mat_cost_snapshot != null ? line.mat_cost_snapshot / line.qty : null
                      return (
                        <tr key={line.id}>
                          <td style={{ fontWeight: 600 }}>{line.sku_id}</td>
                          <td style={{ color: 'var(--text-2)' }}>{s?.description ?? '—'}</td>
                          <td>{line.qty}</td>
                          {anyMatCost && <td>{formatCurrency(perUnit)}</td>}
                          {anyMatCost && <td>{formatCurrency(line.mat_cost_snapshot)}</td>}
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

  function renderTraveler() {
    if (!selectedBatch) return null
    const stages = getTravelerStages()
    const totalParts = stages.reduce((sum, s) => sum + s.rows.reduce((q, r) => q + r.totalQty, 0), 0)

    return (
      <>
        {/* Screen nav bar */}
        <div className="no-print" style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 20px',
          background: 'var(--panel)',
          borderBottom: '1px solid var(--border)',
          marginBottom: 24,
        }}>
          <button className="btn btn-secondary" onClick={() => setView('detail')}>
            ← Back to Batch
          </button>
          <span style={{ color: 'var(--text-2)', fontSize: 14 }}>
            Production Traveler — <strong style={{ color: 'var(--text)' }}>{selectedBatch.name}</strong>
          </span>
          <div style={{ marginLeft: 'auto' }}>
            <button className="btn btn-primary" onClick={() => window.print()}>
              🖨 Print Traveler
            </button>
          </div>
        </div>

        {/* Traveler content (prints) */}
        <div className="print-block" style={{ maxWidth: 900, margin: '0 auto', padding: '0 20px 40px' }}>
          {/* Print header */}
          <div style={{ marginBottom: 24, paddingBottom: 16, borderBottom: '2px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--muted)', marginBottom: 4 }}>
                  Production Traveler
                </div>
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>{selectedBatch.name}</h1>
              </div>
              <div style={{ textAlign: 'right', color: 'var(--text-2)', fontSize: 13 }}>
                <div>{formatDate(new Date().toISOString())}</div>
                <div style={{ marginTop: 4 }}>
                  <StatusChip status={selectedBatch.status} />
                </div>
              </div>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 24, fontSize: 13, color: 'var(--text-2)' }}>
              {batchLines.map((line) => {
                const s = skus.find((sk) => sk.id === line.sku_id)
                return (
                  <span key={line.id}>
                    <strong style={{ color: 'var(--text)' }}>{line.sku_id}</strong> × {line.qty}
                    {s ? ` — ${s.description}` : ''}
                  </span>
                )
              })}
            </div>
          </div>

          {stages.length === 0 ? (
            <p className="empty">No part stage data available. Ensure parts are loaded and have stage flags set.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
              {stages.map(({ stage, rows }) => (
                <div key={stage.key as string} style={{ pageBreakInside: 'avoid' }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    marginBottom: 10,
                  }}>
                    <span style={{
                      fontWeight: 700,
                      fontSize: 15,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      color: 'var(--accent-text)',
                    }}>
                      {stage.label}
                    </span>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {rows.length} part{rows.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <table className="table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Part #</th>
                        <th>Description</th>
                        <th style={{ textAlign: 'right' }}>Qty</th>
                        <th style={{ textAlign: 'center', width: 80 }}>Complete</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ part, totalQty }) => (
                        <tr key={part.id}>
                          <td style={{ fontWeight: 600 }}>{part.part_number}</td>
                          <td style={{ color: 'var(--text-2)' }}>{part.description}</td>
                          <td style={{ textAlign: 'right' }}>{totalQty}</td>
                          <td style={{ textAlign: 'center' }}>
                            <span style={{
                              display: 'inline-block',
                              width: 18,
                              height: 18,
                              border: '1.5px solid var(--border)',
                              borderRadius: 3,
                            }} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {/* Footer */}
          <div style={{
            marginTop: 40,
            paddingTop: 16,
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 12,
            color: 'var(--muted)',
          }}>
            <span>Total parts across all stages: <strong>{totalParts}</strong></span>
            <span>Printed {new Date().toLocaleString()}</span>
          </div>
        </div>

        {/* Print styles injected inline */}
        <style>{`
          @media print {
            .no-print { display: none !important; }
            .print-block { display: block !important; }
            body { background: #fff !important; color: #000 !important; }
          }
          @media screen {
            .print-block { display: block; }
          }
        `}</style>
      </>
    )
  }

  // ── Root render ───────────────────────────────────────────────────────────

  if (view === 'traveler') return renderTraveler()
  if (view === 'create')   return renderCreate()
  if (view === 'detail')   return renderDetail()
  return renderList()
}
