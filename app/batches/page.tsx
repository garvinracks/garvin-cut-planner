'use client'

/*
 * SQL migration — run before using sub-assembly weld tracking:
 * ALTER TABLE sub_assemblies ADD COLUMN IF NOT EXISTS requires_weld boolean DEFAULT false;
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import DxfPartPreview from '@/components/DxfPartPreview'

const SUB_IMAGE_BUCKET = 'subassembly-images'

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
  dxf_file: string | null
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
type SubAssembly = { id: string; name: string; requires_weld: boolean; image_file: string | null }

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

// batch_part_completions: tracks individual part+stage checkoffs per batch
// key format: "id:stageKey" — works for both part IDs and sub-assembly IDs
type CompletionSet = Set<string>

type View = 'list' | 'create' | 'detail' | 'traveler'

// ── Stage config ──────────────────────────────────────────────────────────────

const STAGES = [
  { key: 'stage_laser',      stageKey: 'laser',      partKey: 'requires_laser',      label: 'Laser' },
  { key: 'stage_sheet_bend', stageKey: 'sheet_bend', partKey: 'requires_sheet_bend', label: 'Sheet Bend' },
  { key: 'stage_tube_bend',  stageKey: 'tube_bend',  partKey: 'requires_tube_bend',  label: 'Tube Bend' },
  { key: 'stage_saw',        stageKey: 'saw',        partKey: 'requires_saw',        label: 'Saw' },
  { key: 'stage_drill',      stageKey: 'drill',      partKey: 'requires_drill',      label: 'Drill Press' },
  { key: 'stage_weld',       stageKey: 'weld',       partKey: 'requires_weld',       label: 'Weld' },
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
  planned:     { label: 'Planned',          bg: 'rgba(100,116,139,0.18)', color: '#94a3b8' },
  in_progress: { label: 'In Progress',      bg: 'rgba(234,179,8,0.18)',   color: '#facc15' },
  at_powder:   { label: 'At Powder Coater', bg: 'rgba(167,139,250,0.2)',  color: '#a78bfa' },
  complete:    { label: 'Complete',          bg: 'rgba(34,197,94,0.18)',   color: '#4ade80' },
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BatchesPage() {
  const supabase = useMemo(() => createBrowserClient(), [])
  const router   = useRouter()

  const [view, setView]               = useState<View>('list')
  const [batches, setBatches]         = useState<BuildBatch[]>([])
  const [lines, setLines]             = useState<BuildBatchLine[]>([])
  const [skus, setSkus]               = useState<SKU[]>([])
  const [parts, setParts]             = useState<Part[]>([])
  const [skuParts, setSkuParts]       = useState<SkuPart[]>([])
  const [skuSubs, setSkuSubs]         = useState<SkuSubAssembly[]>([])
  const [subParts, setSubParts]       = useState<SubAssemblyPart[]>([])
  const [subAssemblies, setSubAssemblies] = useState<SubAssembly[]>([])
  const [materials, setMaterials]     = useState<MaterialRecord[]>([])
  const [priceLogs, setPriceLogs]     = useState<PriceLog[]>([])

  const [loading, setLoading]         = useState(true)
  const [message, setMessage]         = useState('')
  const [activeBatch, setActiveBatch] = useState<BuildBatch | null>(null)

  // Per-part/sub-assembly completions for the active batch: Set<"id:stageKey">
  const [completions, setCompletions] = useState<CompletionSet>(new Set())
  const [loadingCompletions, setLoadingCompletions] = useState(false)

  // Create form
  const [createName, setCreateName]   = useState('')
  const [createNotes, setCreateNotes] = useState('')
  const [createRows, setCreateRows]   = useState([{ skuId: '', qty: '1', skuLookup: '' }])
  const [createDropdown, setCreateDropdown] = useState<number | null>(null)
  const [saving, setSaving]           = useState(false)
  const [sendingToPowder, setSendingToPowder] = useState(false)

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
      { data: saData },
      { data: matData },
      { data: plData },
    ] = await Promise.all([
      supabase.from('build_batches').select('*').order('created_at', { ascending: false }),
      supabase.from('build_batch_lines').select('*'),
      supabase.from('skus').select('id, description').order('id'),
      supabase.from('parts').select('id, part_number, description, part_type, material, tube_od, tube_wall, cut_length, weight_lbs, dxf_file, requires_laser, requires_sheet_bend, requires_tube_bend, requires_saw, requires_drill, requires_weld'),
      supabase.from('sku_parts').select('sku_id, part_id, qty'),
      supabase.from('sku_sub_assemblies').select('sku_id, sub_assembly_id, qty'),
      supabase.from('sub_assembly_parts').select('sub_assembly_id, part_id, qty'),
      supabase.from('sub_assemblies').select('id, name, requires_weld, image_file'),
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
    setSubAssemblies((saData ?? []) as SubAssembly[])
    setMaterials((matData ?? []) as MaterialRecord[])
    setPriceLogs((plData ?? []) as PriceLog[])
    setLoading(false)
  }

  async function loadCompletions(batchId: string) {
    setLoadingCompletions(true)
    const { data } = await supabase
      .from('batch_part_completions')
      .select('part_id, stage_key')
      .eq('batch_id', batchId)
    const s: CompletionSet = new Set((data ?? []).map((r: any) => `${r.part_id}:${r.stage_key}`))
    setCompletions(s)
    setLoadingCompletions(false)
  }

  useEffect(() => {
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

  useEffect(() => {
    if (activeBatch) void loadCompletions(activeBatch.id)
  }, [activeBatch?.id])

  // ── Part helpers ──────────────────────────────────────────────────────────────

  function getSkuPartEntries(skuId: string): Array<{ partId: string; qty: number; subAssemblyId: string | null }> {
    const result: Array<{ partId: string; qty: number; subAssemblyId: string | null }> = []
    for (const sp of skuParts.filter((s) => s.sku_id === skuId))
      result.push({ partId: sp.part_id, qty: sp.qty, subAssemblyId: null })
    for (const ss of skuSubs.filter((s) => s.sku_id === skuId))
      for (const sap of subParts.filter((s) => s.sub_assembly_id === ss.sub_assembly_id))
        result.push({ partId: sap.part_id, qty: sap.qty * ss.qty, subAssemblyId: ss.sub_assembly_id })
    return result
  }

  function buildWorkItems(batchLines: BuildBatchLine[]) {
    const map = new Map<string, { part: Part; totalQty: number; subAssemblyId: string | null }>()
    for (const line of batchLines) {
      const entries = getSkuPartEntries(line.sku_id)
      for (const { partId, qty, subAssemblyId } of entries) {
        const part = parts.find((p) => p.id === partId)
        if (!part) continue
        const existing = map.get(partId)
        if (existing) {
          existing.totalQty += qty * line.qty
        } else {
          map.set(partId, { part, totalQty: qty * line.qty, subAssemblyId })
        }
      }
    }
    return map
  }

  function calcMatCost(skuId: string, batchQty: number): number {
    const entries = getSkuPartEntries(skuId)
    let total = 0
    for (const { partId, qty: partQty } of entries) {
      const part = parts.find((p) => p.id === partId)
      if (!part) continue
      const mat = materials.find((m) =>
        m.material_type === part.part_type &&
        (part.part_type === 'tube'
          ? m.tube_od === part.tube_od && m.tube_wall === part.tube_wall
          : m.thickness === part.material)
      )
      if (!mat) continue
      const log = priceLogs.find((pl) => pl.material_id === mat.id)
      if (!log) continue

      if (part.part_type === 'tube') {
        // Length-based: fraction of a full bar × price per bar
        if (!part.cut_length || !mat.stock_length_in) continue
        total += (part.cut_length / mat.stock_length_in) * log.price * partQty
      } else {
        // Sheet: weight-based with scrap rate
        if (!part.weight_lbs || !mat.unit_weight_lbs) continue
        const scrap = mat.scrap_rate ?? 0
        total += part.weight_lbs * (log.price / mat.unit_weight_lbs) * (1 + scrap) * partQty
      }
    }
    return total * batchQty
  }

  // ── Completion actions ────────────────────────────────────────────────────────

  async function syncBatchStageFlags(
    batch: BuildBatch,
    newCompletions: CompletionSet,
    workItems: Map<string, { part: Part; totalQty: number; subAssemblyId: string | null }>,
    subAssemblyGroupsForBatch: Map<string, { subAssembly: SubAssembly; items: Array<{ part: Part; totalQty: number }> }>
  ) {
    const updates: Partial<BuildBatch> = {}
    for (const stage of STAGES) {
      const partsNeedingStage = Array.from(workItems.values()).filter((w) => w.part[stage.partKey as keyof Part])

      if (stage.stageKey === 'weld') {
        // For weld, also count sub-assembly weld ops
        const saWeldNeeded = Array.from(subAssemblyGroupsForBatch.values()).filter(
          ({ subAssembly }) => subAssembly.requires_weld
        )
        const allPartsDone =
          partsNeedingStage.length === 0 ||
          partsNeedingStage.every((w) => newCompletions.has(`${w.part.id}:weld`))
        const allSaDone =
          saWeldNeeded.length === 0 ||
          saWeldNeeded.every(({ subAssembly }) => newCompletions.has(`${subAssembly.id}:weld`))

        if (partsNeedingStage.length === 0 && saWeldNeeded.length === 0) continue
        updates[stage.key as keyof BuildBatch] = (allPartsDone && allSaDone) as any
      } else {
        if (partsNeedingStage.length === 0) continue
        const allDone = partsNeedingStage.every((w) => newCompletions.has(`${w.part.id}:${stage.stageKey}`))
        updates[stage.key as keyof BuildBatch] = allDone as any
      }
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from('build_batches').update(updates).eq('id', batch.id)
      setBatches((prev) => prev.map((b) => b.id === batch.id ? { ...b, ...updates } : b))
      setActiveBatch((prev) => prev ? { ...prev, ...updates } : prev)
    }
  }

  async function handleToggle(
    batchId: string,
    itemId: string,
    stageKey: string,
    checked: boolean,
    workItems: Map<string, { part: Part; totalQty: number; subAssemblyId: string | null }>,
    subAssemblyGroupsForBatch: Map<string, { subAssembly: SubAssembly; items: Array<{ part: Part; totalQty: number }> }>
  ) {
    const key = `${itemId}:${stageKey}`
    const newCompletions = new Set(completions)
    checked ? newCompletions.add(key) : newCompletions.delete(key)
    setCompletions(newCompletions)
    if (checked) {
      await supabase.from('batch_part_completions').upsert(
        { batch_id: batchId, part_id: itemId, stage_key: stageKey },
        { onConflict: 'batch_id,part_id,stage_key' }
      )
    } else {
      await supabase.from('batch_part_completions').delete()
        .eq('batch_id', batchId).eq('part_id', itemId).eq('stage_key', stageKey)
    }
    if (activeBatch) await syncBatchStageFlags(activeBatch, newCompletions, workItems, subAssemblyGroupsForBatch)
  }

  async function handleBulkToggle(
    batchId: string,
    items: Array<{ id: string; stageKey: string }>,
    checked: boolean,
    workItems: Map<string, { part: Part; totalQty: number; subAssemblyId: string | null }>,
    subAssemblyGroupsForBatch: Map<string, { subAssembly: SubAssembly; items: Array<{ part: Part; totalQty: number }> }>
  ) {
    const newCompletions = new Set(completions)
    if (checked) {
      for (const item of items) newCompletions.add(`${item.id}:${item.stageKey}`)
      await supabase.from('batch_part_completions').upsert(
        items.map((item) => ({ batch_id: batchId, part_id: item.id, stage_key: item.stageKey })),
        { onConflict: 'batch_id,part_id,stage_key' }
      )
    } else {
      for (const item of items) newCompletions.delete(`${item.id}:${item.stageKey}`)
      // Delete each unchecked item
      for (const item of items) {
        await supabase.from('batch_part_completions').delete()
          .eq('batch_id', batchId).eq('part_id', item.id).eq('stage_key', item.stageKey)
      }
    }
    setCompletions(newCompletions)
    if (activeBatch) await syncBatchStageFlags(activeBatch, newCompletions, workItems, subAssemblyGroupsForBatch)
  }

  // ── Batch actions ─────────────────────────────────────────────────────────────

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
    const updates: any = { status }
    if (status === 'complete') updates.completed_at = new Date().toISOString()
    await supabase.from('build_batches').update(updates).eq('id', batch.id)
    const updated = { ...batch, ...updates }
    setBatches((prev) => prev.map((b) => b.id === batch.id ? updated : b))
    setActiveBatch(updated)
  }

  async function sendToPowder(batch: BuildBatch) {
    setSendingToPowder(true)
    setMessage('')
    const { error } = await supabase.from('build_batches').update({ status: 'at_powder' }).eq('id', batch.id)
    if (error) {
      setMessage(`Failed to send to powder: ${error.message}`)
      setSendingToPowder(false)
      return
    }
    const updated = { ...batch, status: 'at_powder' as BatchStatus }
    setBatches((prev) => prev.map((b) => b.id === batch.id ? updated : b))
    setActiveBatch(updated)
    // Hard navigate so the powder page always reloads fresh
    window.location.href = '/powder'
  }

  async function markCompleteWithCost(batch: BuildBatch) {
    const batchLines = lines.filter((l) => l.batch_id === batch.id)
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
    const deductions: Record<string, number> = {}
    for (const line of batchLines) {
      for (const { partId, qty: partQty } of getSkuPartEntries(line.sku_id).filter((e) => e.subAssemblyId === null || true)) {
        const part = parts.find((p) => p.id === partId)
        if (!part || part.part_type !== 'tube' || !part.cut_length) continue
        const mat = materials.find((m) => m.material_type === 'tube' && m.tube_od === part.tube_od && m.tube_wall === part.tube_wall)
        if (!mat?.stock_length_in) continue
        const bars = Math.ceil((part.cut_length * partQty * line.qty) / mat.stock_length_in)
        deductions[mat.id] = (deductions[mat.id] ?? 0) + bars
      }
    }
    for (const [matId, bars] of Object.entries(deductions)) {
      const mat = materials.find((m) => m.id === matId)
      await supabase.from('materials').update({ qty_on_hand: Math.max(0, (mat?.qty_on_hand ?? 0) - bars) }).eq('id', matId)
    }
    const summary = Object.entries(deductions).map(([id, bars]) => {
      const mat = materials.find((m) => m.id === id)
      return `${mat?.tube_od ?? id}: −${bars} bars`
    }).join(', ')
    setMessage(summary || 'No tube materials to deduct.')
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
    const workItems  = buildWorkItems(batchLines)
    const totalParts = Array.from(workItems.values()).reduce((s, w) => s + w.totalQty, 0)

    // Sub-assemblies present in this batch
    const batchSubAssemblyIds = new Set<string>()
    for (const line of batchLines) {
      for (const ss of skuSubs.filter((s) => s.sku_id === line.sku_id)) {
        batchSubAssemblyIds.add(ss.sub_assembly_id)
      }
    }
    const batchSubAssemblies = subAssemblies.filter((sa) => batchSubAssemblyIds.has(sa.id))

    return (
      <div className="section-stack">
        <style>{`@media print { .no-print { display: none !important } }`}</style>
        <div className="no-print" style={{ display: 'flex', gap: 10, padding: '8px 0' }}>
          <button className="btn btn-secondary" onClick={() => setView('detail')}>← Back</button>
          <button className="btn btn-primary" onClick={() => window.print()}>🖨 Print</button>
        </div>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: '20px 28px' }}>
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Production Traveler</div>
            <h1 style={{ margin: '4px 0', fontSize: '1.5rem', fontWeight: 800 }}>{activeBatch.name}</h1>
            <div style={{ color: 'var(--text-2)', fontSize: '0.85rem' }}>
              {fmtDate(activeBatch.created_at)} · {batchLines.length} SKU{batchLines.length !== 1 ? 's' : ''} · {totalParts} total parts
            </div>
          </div>
          {STAGES.map(({ stageKey, partKey, label }) => {
            const stageParts = Array.from(workItems.values()).filter((w) => w.part[partKey as keyof Part])

            // For weld stage, also include sub-assemblies with requires_weld
            const saWeldRows = stageKey === 'weld'
              ? batchSubAssemblies.filter((sa) => sa.requires_weld).map((sa) => {
                  // Total qty of this sub-assembly in the batch
                  let totalQty = 0
                  for (const line of batchLines) {
                    const saEntry = skuSubs.find((s) => s.sku_id === line.sku_id && s.sub_assembly_id === sa.id)
                    if (saEntry) totalQty += saEntry.qty * line.qty
                  }
                  return { sa, totalQty }
                })
              : []

            if (stageParts.length === 0 && saWeldRows.length === 0) return null
            return (
              <div key={stageKey} style={{ marginBottom: 28, pageBreakInside: 'avoid' }}>
                <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: 8, padding: '6px 12px', background: 'var(--panel-2)', borderLeft: '4px solid var(--accent)', borderRadius: '0 6px 6px 0' }}>
                  {label}
                </div>
                <table className="table">
                  <thead><tr><th style={{ width: 170 }}>Part</th><th style={{ textAlign: 'center', width: 50 }}>Qty</th><th style={{ textAlign: 'center', width: 36 }}>☐</th></tr></thead>
                  <tbody>
                    {stageParts.map(({ part, totalQty }) => (
                      <tr key={part.id}>
                        <td style={{ padding: '8px 10px', verticalAlign: 'top' }}>
                          <DxfPartPreview dxfFile={part.dxf_file} partNumber={part.part_number} size="small" isTube={part.part_type === 'tube'} tubeFallback={false} />
                          <div style={{ fontSize: '0.7rem', fontFamily: 'monospace', fontWeight: 700, color: '#555', marginTop: 4 }}>{part.part_number}</div>
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, verticalAlign: 'middle' }}>{totalQty}</td>
                        <td style={{ textAlign: 'center', fontSize: '1.1rem', verticalAlign: 'middle' }}>☐</td>
                      </tr>
                    ))}
                    {saWeldRows.map(({ sa, totalQty }) => (
                      <tr key={`sa-${sa.id}`} style={{ background: 'rgba(167,139,250,0.06)' }}>
                        <td style={{ padding: '8px 10px', fontWeight: 700, color: '#a78bfa', verticalAlign: 'middle' }}>Weld {sa.name}</td>
                        <td style={{ textAlign: 'center', fontWeight: 700, verticalAlign: 'middle' }}>{totalQty}</td>
                        <td style={{ textAlign: 'center', fontSize: '1.1rem', verticalAlign: 'middle' }}>☐</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)', color: 'var(--muted)', fontSize: '0.8rem' }}>
            Powder coat performed by outside vendor after all stages above are complete.
          </div>
        </div>
      </div>
    )
  }

  // ── DETAIL VIEW ───────────────────────────────────────────────────────────────
  if (view === 'detail' && activeBatch) {
    const batchLines     = lines.filter((l) => l.batch_id === activeBatch.id)
    const workItems      = buildWorkItems(batchLines)
    const hasSnapshots   = batchLines.some((l) => l.mat_cost_snapshot != null)
    const totalMatCost   = batchLines.reduce((s, l) => s + (l.mat_cost_snapshot ?? 0), 0)
    const ss             = STATUS_STYLE[activeBatch.status]

    // Group work items by sub-assembly for the checklist
    const subAssemblyGroups = new Map<string, { subAssembly: SubAssembly; items: Array<{ part: Part; totalQty: number }> }>()
    const directItems: Array<{ part: Part; totalQty: number }> = []
    for (const { part, totalQty, subAssemblyId } of workItems.values()) {
      if (subAssemblyId) {
        const sa = subAssemblies.find((s) => s.id === subAssemblyId)
        if (sa) {
          if (!subAssemblyGroups.has(subAssemblyId)) subAssemblyGroups.set(subAssemblyId, { subAssembly: sa, items: [] })
          subAssemblyGroups.get(subAssemblyId)!.items.push({ part, totalQty })
        }
      } else {
        directItems.push({ part, totalQty })
      }
    }

    // Progress calculation from actual completions
    // allWorkOps includes both part ops and sub-assembly weld ops
    const allWorkOps: Array<{ id: string; stageKey: string }> = []
    for (const { part } of workItems.values()) {
      for (const stage of STAGES) {
        if (part[stage.partKey as keyof Part]) allWorkOps.push({ id: part.id, stageKey: stage.stageKey })
      }
    }
    // Add sub-assembly weld ops
    for (const [saId, { subAssembly }] of subAssemblyGroups.entries()) {
      if (subAssembly.requires_weld) {
        allWorkOps.push({ id: saId, stageKey: 'weld' })
      }
    }
    const totalOps    = allWorkOps.length
    const doneOps     = allWorkOps.filter((op) => completions.has(`${op.id}:${op.stageKey}`)).length
    const pct         = totalOps > 0 ? Math.round((doneOps / totalOps) * 100) : 0
    const allDone     = totalOps > 0 && doneOps === totalOps

    // Which stages are actually required by any part/SA in this batch?
    const activeStages = STAGES.filter(({ stageKey, partKey }) => {
      if (stageKey === 'weld') {
        return Array.from(workItems.values()).some((w) => w.part.requires_weld) ||
               Array.from(subAssemblyGroups.values()).some(({ subAssembly }) => subAssembly.requires_weld)
      }
      return Array.from(workItems.values()).some((w) => !!w.part[partKey as keyof Part])
    })

    return (
      <div className="section-stack">
        <div className="page-header no-print">
          <div>
            <div className="kicker">Garvin Internal Tool</div>
            <h1 className="page-title">{activeBatch.name}</h1>
            <div className="page-subtitle">Build batch detail</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => { setActiveBatch(null); setView('list') }}>← All Batches</button>
            <button className="btn btn-secondary" onClick={() => setView('traveler')}>🖨 Traveler</button>
          </div>
        </div>

        {message && <div className="message">{message}</div>}

        {/* Status card */}
        <section className="card">
          <div className="card-body">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <span style={{ background: ss.bg, color: ss.color, borderRadius: 20, padding: '4px 14px', fontWeight: 700, fontSize: '0.82rem' }}>{ss.label}</span>
              <span style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>Created {fmtDate(activeBatch.created_at)}</span>
              {activeBatch.completed_at && <span style={{ color: 'var(--success)', fontSize: '0.82rem' }}>Completed {fmtDate(activeBatch.completed_at)}</span>}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {activeBatch.status === 'planned' && (
                  <button className="btn btn-primary" onClick={() => updateStatus(activeBatch, 'in_progress')}>▶ Start Build</button>
                )}
                {activeBatch.status === 'in_progress' && (
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: '0.8rem', background: 'rgba(167,139,250,0.15)', borderColor: 'rgba(167,139,250,0.4)', color: '#a78bfa', opacity: sendingToPowder ? 0.6 : 1 }}
                    onClick={() => void sendToPowder(activeBatch)}
                    disabled={sendingToPowder}
                    title="Mark this batch as sent to powder coater"
                  >
                    {sendingToPowder ? '⏳ Sending…' : '🎨 Send to Powder'}
                  </button>
                )}
                {activeBatch.status === 'at_powder' && (
                  <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => markCompleteWithCost(activeBatch)}>Mark Complete Manually</button>
                )}
                {(activeBatch.status === 'at_powder' || activeBatch.status === 'complete') && (
                  <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => deductMaterials(activeBatch)}>Deduct Materials</button>
                )}
              </div>
            </div>
            {activeBatch.notes && <div style={{ marginTop: 10, color: 'var(--text-2)', fontSize: '0.85rem' }}>{activeBatch.notes}</div>}
          </div>
        </section>

        {/* at_powder banner */}
        {activeBatch.status === 'at_powder' && (
          <div style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.35)', borderRadius: 8, padding: '14px 20px', color: '#a78bfa', fontWeight: 600 }}>
            🎨 At Powder Coater — parts are out for finishing.{' '}
            <button onClick={() => router.push('/powder')} style={{ background: 'none', border: 'none', color: '#a78bfa', textDecoration: 'underline', cursor: 'pointer', fontWeight: 700, padding: 0 }}>
              Manage on Powder page →
            </button>
          </div>
        )}

        {/* Manufacturing checklist (in_progress only) */}
        {activeBatch.status === 'in_progress' && (
          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Manufacturing Progress</h2>
                <div className="card-subtitle">{doneOps} of {totalOps} operations complete</div>
              </div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: allDone ? 'var(--success)' : 'var(--accent)' }}>{pct}%</div>
            </div>
            <div className="card-body">
              {loadingCompletions ? (
                <div className="empty">Loading checklist…</div>
              ) : totalOps === 0 ? (
                <div className="empty">No stage requirements found — make sure parts have stage flags set on the Parts page.</div>
              ) : (
                <>
                  {/* Progress bar */}
                  <div style={{ height: 12, background: 'var(--panel-2)', borderRadius: 6, marginBottom: 24, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: allDone ? 'var(--success)' : 'var(--accent)', borderRadius: 6, transition: 'width 0.25s' }} />
                  </div>

                  {/* Part-first manufacturing checklist table */}
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                      <colgroup>
                        <col style={{ width: 170 }} />
                        <col style={{ width: 44 }} />
                        {activeStages.map((s) => <col key={s.stageKey} style={{ width: 84 }} />)}
                      </colgroup>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: '8px 10px', background: 'var(--panel-2)', borderBottom: '2px solid var(--border)', fontSize: '0.72rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Part</th>
                          <th style={{ textAlign: 'center', padding: '8px 4px', background: 'var(--panel-2)', borderBottom: '2px solid var(--border)', fontSize: '0.72rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Qty</th>
                          {activeStages.map(({ stageKey, label }) => {
                            const allStageItems: Array<{ id: string; stageKey: string }> = []
                            const stg = STAGES.find((s) => s.stageKey === stageKey)!
                            for (const w of workItems.values()) {
                              if (w.part[stg.partKey as keyof Part]) allStageItems.push({ id: w.part.id, stageKey })
                            }
                            if (stageKey === 'weld') {
                              for (const [saId, { subAssembly }] of subAssemblyGroups.entries()) {
                                if (subAssembly.requires_weld) allStageItems.push({ id: saId, stageKey: 'weld' })
                              }
                            }
                            const allDoneForStage = allStageItems.length > 0 && allStageItems.every((i) => completions.has(`${i.id}:${i.stageKey}`))
                            const anyDoneForStage = allStageItems.some((i) => completions.has(`${i.id}:${i.stageKey}`))
                            return (
                              <th key={stageKey} style={{ textAlign: 'center', padding: '6px 4px', background: 'var(--panel-2)', borderBottom: '2px solid var(--border)', borderLeft: '1px solid var(--border)' }}>
                                <div style={{ fontSize: '0.72rem', color: allDoneForStage ? 'var(--success)' : 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, whiteSpace: 'nowrap' }}>
                                  {allDoneForStage ? '✓ ' : ''}{label}
                                </div>
                                <div style={{ display: 'flex', gap: 3, justifyContent: 'center' }}>
                                  {!allDoneForStage && (
                                    <button type="button" className="btn btn-secondary" style={{ fontSize: '0.6rem', padding: '1px 5px', height: 18, lineHeight: 1 }}
                                      onClick={() => void handleBulkToggle(activeBatch.id, allStageItems, true, workItems, subAssemblyGroups)}>
                                      ✓ All
                                    </button>
                                  )}
                                  {anyDoneForStage && (
                                    <button type="button" className="btn btn-secondary" style={{ fontSize: '0.6rem', padding: '1px 5px', height: 18, lineHeight: 1 }}
                                      onClick={() => void handleBulkToggle(activeBatch.id, allStageItems, false, workItems, subAssemblyGroups)}>
                                      ✕
                                    </button>
                                  )}
                                </div>
                              </th>
                            )
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {/* ── Sub-assembly groups ── */}
                        {Array.from(subAssemblyGroups.entries()).map(([saId, { subAssembly, items }]) => (
                          <>
                            {/* SA header row */}
                            <tr key={`sa-hdr-${saId}`}>
                              <td colSpan={2 + activeStages.length} style={{ padding: '7px 12px', background: 'rgba(167,139,250,0.09)', borderTop: '2px solid rgba(167,139,250,0.22)', borderBottom: '1px solid var(--border)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  {subAssembly.image_file && (
                                    <img
                                      src={supabase.storage.from(SUB_IMAGE_BUCKET).getPublicUrl(subAssembly.image_file).data.publicUrl}
                                      alt={subAssembly.name}
                                      style={{ width: 38, height: 38, objectFit: 'cover', borderRadius: 4, border: '1px solid rgba(167,139,250,0.3)', flexShrink: 0 }}
                                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                    />
                                  )}
                                  <div>
                                    <div style={{ fontSize: '0.65rem', color: '#a78bfa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Sub-Assembly</div>
                                    <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{subAssembly.name}</div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                            {/* Part rows */}
                            {items.map(({ part, totalQty }) => {
                              const rowAllDone = activeStages.every((s) => !part[s.partKey as keyof Part] || completions.has(`${part.id}:${s.stageKey}`))
                              return (
                                <tr key={`part-${part.id}`} style={{ borderBottom: '1px solid var(--border)', background: rowAllDone ? 'rgba(34,197,94,0.04)' : 'transparent' }}>
                                  <td style={{ padding: '8px 10px', verticalAlign: 'top' }}>
                                    <DxfPartPreview dxfFile={part.dxf_file} partNumber={part.part_number} size="small" isTube={part.part_type === 'tube'} tubeFallback={false} />
                                    <div style={{ fontSize: '0.68rem', fontFamily: 'monospace', fontWeight: 700, color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{part.part_number}</div>
                                  </td>
                                  <td style={{ textAlign: 'center', fontWeight: 700, fontSize: '0.88rem', verticalAlign: 'middle', color: 'var(--muted)' }}>×{totalQty}</td>
                                  {activeStages.map(({ stageKey, partKey }) => {
                                    if (!part[partKey as keyof Part]) return <td key={stageKey} style={{ borderLeft: '1px solid var(--border)', background: 'rgba(0,0,0,0.03)' }} />
                                    const done = completions.has(`${part.id}:${stageKey}`)
                                    const blocked = stageKey === 'weld' && STAGES.some((s) => {
                                      if (s.stageKey === 'weld') return false
                                      if (!part[s.partKey as keyof Part]) return false
                                      return !completions.has(`${part.id}:${s.stageKey}`)
                                    })
                                    return (
                                      <td key={stageKey} style={{ textAlign: 'center', verticalAlign: 'middle', borderLeft: '1px solid var(--border)', background: done ? 'rgba(34,197,94,0.1)' : 'transparent', padding: '4px' }}>
                                        <input type="checkbox" checked={done} disabled={blocked}
                                          onChange={(e) => handleToggle(activeBatch.id, part.id, stageKey, e.target.checked, workItems, subAssemblyGroups)}
                                          title={blocked ? '⚠ Complete prior stages first' : undefined}
                                          style={{ width: 18, height: 18, cursor: blocked ? 'not-allowed' : 'pointer', accentColor: 'var(--accent)', opacity: blocked ? 0.35 : 1 }} />
                                        {blocked && <div style={{ fontSize: '0.6rem', color: 'var(--warning)', marginTop: 2 }}>⚠</div>}
                                      </td>
                                    )
                                  })}
                                </tr>
                              )
                            })}
                            {/* SA weld row */}
                            {subAssembly.requires_weld && (() => {
                              const done = completions.has(`${saId}:weld`)
                              const blocked = items.some((i) => STAGES.some((s) => {
                                if (s.stageKey === 'weld') return false
                                if (!i.part[s.partKey as keyof Part]) return false
                                return !completions.has(`${i.part.id}:${s.stageKey}`)
                              }))
                              return (
                                <tr key={`sa-weld-${saId}`} style={{ borderBottom: '2px solid rgba(167,139,250,0.22)', background: done ? 'rgba(34,197,94,0.06)' : 'rgba(167,139,250,0.05)' }}>
                                  <td colSpan={2} style={{ padding: '8px 12px', verticalAlign: 'middle' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span style={{ fontSize: '0.65rem', color: '#a78bfa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>SA Weld</span>
                                      <span style={{ fontWeight: 700, fontSize: '0.88rem', color: done ? 'var(--muted)' : '#a78bfa', textDecoration: done ? 'line-through' : 'none' }}>Weld {subAssembly.name}</span>
                                      {blocked && <span style={{ fontSize: '0.7rem', color: 'var(--warning)' }}>⚠ parts incomplete</span>}
                                    </div>
                                  </td>
                                  {activeStages.map(({ stageKey }) => {
                                    if (stageKey !== 'weld') return <td key={stageKey} style={{ borderLeft: '1px solid var(--border)', background: 'rgba(0,0,0,0.03)' }} />
                                    return (
                                      <td key={stageKey} style={{ textAlign: 'center', verticalAlign: 'middle', borderLeft: '1px solid var(--border)', background: done ? 'rgba(34,197,94,0.1)' : 'transparent', padding: '4px' }}>
                                        <input type="checkbox" checked={done} disabled={blocked}
                                          onChange={(e) => handleToggle(activeBatch.id, saId, 'weld', e.target.checked, workItems, subAssemblyGroups)}
                                          style={{ width: 18, height: 18, cursor: blocked ? 'not-allowed' : 'pointer', accentColor: '#a78bfa', opacity: blocked ? 0.35 : 1 }} />
                                      </td>
                                    )
                                  })}
                                </tr>
                              )
                            })()}
                          </>
                        ))}

                        {/* ── Direct parts ── */}
                        {directItems.length > 0 && (
                          <>
                            <tr>
                              <td colSpan={2 + activeStages.length} style={{ padding: '6px 12px', background: 'var(--panel-2)', borderTop: '2px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
                                <span style={{ fontSize: '0.65rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Direct Parts</span>
                              </td>
                            </tr>
                            {directItems.map(({ part, totalQty }) => {
                              const rowAllDone = activeStages.every((s) => !part[s.partKey as keyof Part] || completions.has(`${part.id}:${s.stageKey}`))
                              return (
                                <tr key={`direct-${part.id}`} style={{ borderBottom: '1px solid var(--border)', background: rowAllDone ? 'rgba(34,197,94,0.04)' : 'transparent' }}>
                                  <td style={{ padding: '8px 10px', verticalAlign: 'top' }}>
                                    <DxfPartPreview dxfFile={part.dxf_file} partNumber={part.part_number} size="small" isTube={part.part_type === 'tube'} tubeFallback={false} />
                                    <div style={{ fontSize: '0.68rem', fontFamily: 'monospace', fontWeight: 700, color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{part.part_number}</div>
                                  </td>
                                  <td style={{ textAlign: 'center', fontWeight: 700, fontSize: '0.88rem', verticalAlign: 'middle', color: 'var(--muted)' }}>×{totalQty}</td>
                                  {activeStages.map(({ stageKey, partKey }) => {
                                    if (!part[partKey as keyof Part]) return <td key={stageKey} style={{ borderLeft: '1px solid var(--border)', background: 'rgba(0,0,0,0.03)' }} />
                                    const done = completions.has(`${part.id}:${stageKey}`)
                                    const blocked = stageKey === 'weld' && STAGES.some((s) => {
                                      if (s.stageKey === 'weld') return false
                                      if (!part[s.partKey as keyof Part]) return false
                                      return !completions.has(`${part.id}:${s.stageKey}`)
                                    })
                                    return (
                                      <td key={stageKey} style={{ textAlign: 'center', verticalAlign: 'middle', borderLeft: '1px solid var(--border)', background: done ? 'rgba(34,197,94,0.1)' : 'transparent', padding: '4px' }}>
                                        <input type="checkbox" checked={done} disabled={blocked}
                                          onChange={(e) => handleToggle(activeBatch.id, part.id, stageKey, e.target.checked, workItems, subAssemblyGroups)}
                                          title={blocked ? '⚠ Complete prior stages first' : undefined}
                                          style={{ width: 18, height: 18, cursor: blocked ? 'not-allowed' : 'pointer', accentColor: 'var(--accent)', opacity: blocked ? 0.35 : 1 }} />
                                        {blocked && <div style={{ fontSize: '0.6rem', color: 'var(--warning)', marginTop: 2 }}>⚠</div>}
                                      </td>
                                    )
                                  })}
                                </tr>
                              )
                            })}
                          </>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* All done banner */}
                  {allDone && (
                    <div style={{ marginTop: 16, padding: '14px 18px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 8 }}>
                      <div style={{ color: 'var(--success)', fontWeight: 700, marginBottom: 10 }}>✓ All manufacturing operations complete!</div>
                      <button className="btn btn-primary" style={{ background: '#a78bfa', borderColor: '#a78bfa' }} onClick={() => sendToPowder(activeBatch)}>
                        🎨 Send to Powder Coater →
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        )}

        {/* SKU lines */}
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
                    <th>SKU</th><th>Description</th><th style={{ textAlign: 'center' }}>Qty</th>
                    {hasSnapshots && <th style={{ textAlign: 'right' }}>Mat Cost / Unit</th>}
                    {hasSnapshots && <th style={{ textAlign: 'right' }}>Total Mat Cost</th>}
                  </tr>
                </thead>
                <tbody>
                  {batchLines.map((line) => {
                    const sku = skus.find((s) => s.id === line.sku_id)
                    const cpu = line.mat_cost_snapshot != null ? line.mat_cost_snapshot / line.qty : null
                    return (
                      <tr key={line.id}>
                        <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{line.sku_id}</td>
                        <td>{sku?.description ?? '—'}</td>
                        <td style={{ textAlign: 'center', fontWeight: 700 }}>{line.qty}</td>
                        {hasSnapshots && <td style={{ textAlign: 'right' }}>{fmtCost(cpu)}</td>}
                        {hasSnapshots && <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtCost(line.mat_cost_snapshot)}</td>}
                      </tr>
                    )
                  })}
                </tbody>
                {hasSnapshots && (
                  <tfoot>
                    <tr>
                      <td colSpan={3} style={{ fontWeight: 700, color: 'var(--muted)' }}>Total</td>
                      <td /><td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{fmtCost(totalMatCost)}</td>
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
                      <input className="field" placeholder="SKU ID or search…"
                        value={row.skuLookup || row.skuId}
                        onChange={(e) => { updateCreateRow(idx, 'skuLookup', e.target.value); updateCreateRow(idx, 'skuId', e.target.value); setCreateDropdown(idx) }}
                        onFocus={() => setCreateDropdown(idx)}
                        onBlur={() => setTimeout(() => setCreateDropdown(null), 150)} />
                      {suggestions.length > 0 && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.3)', maxHeight: 220, overflowY: 'auto' }}>
                          {suggestions.map((s) => (
                            <div key={s.id} style={{ padding: '7px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: '0.84rem' }}
                              onMouseDown={() => { updateCreateRow(idx, 'skuId', s.id); updateCreateRow(idx, 'skuLookup', s.id); setCreateDropdown(null) }}>
                              <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>{s.id}</span>
                              <span style={{ color: 'var(--text-2)', marginLeft: 8 }}>{s.description}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <input className="field" type="number" min="1" step="1" value={row.qty} onChange={(e) => updateCreateRow(idx, 'qty', e.target.value)} style={{ width: 80 }} placeholder="Qty" />
                    <button className="btn btn-secondary" style={{ height: 36, padding: '0 10px', flexShrink: 0 }} onClick={() => setCreateRows((prev) => prev.filter((_, i) => i !== idx))}>✕</button>
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
            <div className="empty">No batches yet. Click "New Batch" to get started.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Name</th><th>Status</th><th>SKUs</th><th>Created</th><th>Completed</th></tr>
                </thead>
                <tbody>
                  {batches.map((batch) => {
                    const ss = STATUS_STYLE[batch.status]
                    const skuCount = lines.filter((l) => l.batch_id === batch.id).length
                    return (
                      <tr key={batch.id} style={{ cursor: 'pointer' }} onClick={() => { setActiveBatch(batch); setView('detail') }}>
                        <td style={{ fontWeight: 700 }}>{batch.name}</td>
                        <td><span style={{ background: ss.bg, color: ss.color, borderRadius: 20, padding: '2px 10px', fontSize: '0.76rem', fontWeight: 700 }}>{ss.label}</span></td>
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
