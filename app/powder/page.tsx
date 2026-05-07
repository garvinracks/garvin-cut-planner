'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import DxfPartPreview from '@/components/DxfPartPreview'

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
  id: string
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
  total_weight_lbs: number | null
  cost_per_lb: number | null
  notes: string | null
  status: 'at_coater' | 'complete'
  created_at: string
}

type SkuPart = { sku_id: string; part_id: string; qty: number }
type SkuSubAssembly = { sku_id: string; sub_assembly_id: string; qty: number }
type SubAssemblyPart = { sub_assembly_id: string; part_id: string; qty: number }
type Part = {
  id: string
  part_number: string
  description: string | null
  weight_lbs: number | null
  part_type: 'tube' | 'sheet'
  dxf_file: string | null
  cut_length: number | null
  tube_od: string | null
  tube_wall: string | null
}
type Material = {
  id: string
  material_type: 'tube' | 'sheet'
  tube_od: string | null
  tube_wall: string | null
  unit_weight_lbs: number | null
  stock_length_in: number | null
}

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
  const [materials, setMaterials]       = useState<Material[]>([])

  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [saving, setSaving]   = useState(false)

  // "Record return" flow
  const [returnMode, setReturnMode]         = useState(false)
  const [returnSelected, setReturnSelected] = useState<Set<string>>(new Set())
  const [returnCost, setReturnCost]         = useState('')
  const [returnNotes, setReturnNotes]       = useState('')

  // "Group into Run" flow
  const [groupMode, setGroupMode]           = useState(false)
  const [groupSelected, setGroupSelected]   = useState<Set<string>>(new Set())
  const [groupName, setGroupName]           = useState('')

  // Per-run inline return form: key = powder_batch.id
  const [runReturnOpen, setRunReturnOpen]   = useState<string | null>(null)
  const [runReturnCost, setRunReturnCost]   = useState('')
  const [runReturnNotes, setRunReturnNotes] = useState('')

  // History expand
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Inline weight-fix panel: batchId → open/closed
  const [weightFixOpen, setWeightFixOpen] = useState<string | null>(null)
  // Edited weight values: partId → string
  const [weightEdits, setWeightEdits] = useState<Record<string, string>>({})
  const [savingWeights, setSavingWeights] = useState(false)

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
      { data: matData },
    ] = await Promise.all([
      supabase.from('build_batches')
        .select('*')
        .in('status', ['at_powder', 'complete'])
        .order('created_at', { ascending: false }),
      supabase.from('build_batch_lines').select('id, batch_id, sku_id, qty'),
      supabase.from('powder_batches').select('*').order('created_at', { ascending: false }),
      supabase.from('sku_parts').select('sku_id, part_id, qty'),
      supabase.from('sku_sub_assemblies').select('sku_id, sub_assembly_id, qty'),
      supabase.from('sub_assembly_parts').select('sub_assembly_id, part_id, qty'),
      supabase.from('parts').select('id, part_number, description, weight_lbs, part_type, dxf_file, cut_length, tube_od, tube_wall'),
      supabase.from('materials').select('id, material_type, tube_od, tube_wall, unit_weight_lbs, stock_length_in'),
    ])
    setBuildBatches((bbData ?? []) as BuildBatch[])
    setBatchLines((blData ?? []) as BuildBatchLine[])
    setPowderBatches((pbData ?? []) as PowderBatch[])
    setSkuParts((spData ?? []) as SkuPart[])
    setSkuSubs((ssData ?? []) as SkuSubAssembly[])
    setSubParts((sapData ?? []) as SubAssemblyPart[])
    setParts((partData ?? []) as Part[])
    setMaterials((matData ?? []) as Material[])
    setLoading(false)
  }

  useEffect(() => { void loadAll() }, [])

  // ── Weight calculation ────────────────────────────────────────────────────────

  // Weight (lbs) of one part instance, accounting for type:
  // • tube  → (cut_length / stock_length_in) × unit_weight_lbs
  // • sheet → weight_lbs (manually entered)
  function partWeight(part: Part): number {
    if (part.part_type === 'tube') {
      if (!part.cut_length) return 0
      const mat = materials.find(
        (m) => m.material_type === 'tube' && m.tube_od === part.tube_od && m.tube_wall === part.tube_wall
      )
      if (!mat?.stock_length_in || !mat?.unit_weight_lbs) return 0
      return (part.cut_length / mat.stock_length_in) * mat.unit_weight_lbs
    }
    return part.weight_lbs ?? 0
  }

  // Weight of one unit of a SKU (all parts + sub-assembly parts)
  function calcSkuWeight(skuId: string): number {
    let total = 0
    for (const sp of skuParts.filter((s) => s.sku_id === skuId)) {
      const part = parts.find((p) => p.id === sp.part_id)
      if (part) total += partWeight(part) * sp.qty
    }
    for (const ss of skuSubs.filter((s) => s.sku_id === skuId)) {
      for (const sap of subParts.filter((s) => s.sub_assembly_id === ss.sub_assembly_id)) {
        const part = parts.find((p) => p.id === sap.part_id)
        if (part) total += partWeight(part) * sap.qty * ss.qty
      }
    }
    return total
  }

  function calcBatchWeight(batchId: string): number {
    return batchLines
      .filter((l) => l.batch_id === batchId)
      .reduce((s, l) => s + calcSkuWeight(l.sku_id) * l.qty, 0)
  }

  // Sheet parts with a DXF file but no weight_lbs (deduped by part id).
  // Tubes are excluded — their weight is auto-calculated from stock material.
  // Parts without a DXF are hardware/bought parts — not powder coated, no weight needed.
  function needsWeight(part: Part): boolean {
    return part.part_type === 'sheet' && !!part.dxf_file && (part.weight_lbs === null || part.weight_lbs === undefined)
  }

  function getMissingWeightParts(batchId: string): Part[] {
    const seen = new Set<string>()
    const missing: Part[] = []
    for (const line of batchLines.filter((l) => l.batch_id === batchId)) {
      for (const sp of skuParts.filter((s) => s.sku_id === line.sku_id)) {
        if (!seen.has(sp.part_id)) {
          seen.add(sp.part_id)
          const part = parts.find((p) => p.id === sp.part_id)
          if (part && needsWeight(part)) missing.push(part)
        }
      }
      for (const ss of skuSubs.filter((s) => s.sku_id === line.sku_id)) {
        for (const sap of subParts.filter((s) => s.sub_assembly_id === ss.sub_assembly_id)) {
          if (!seen.has(sap.part_id)) {
            seen.add(sap.part_id)
            const part = parts.find((p) => p.id === sap.part_id)
            if (part && needsWeight(part)) missing.push(part)
          }
        }
      }
    }
    return missing
  }

  async function saveWeightEdits() {
    const entries = Object.entries(weightEdits).filter(([, v]) => v.trim() !== '' && !isNaN(parseFloat(v)))
    if (!entries.length) return
    setSavingWeights(true)
    for (const [partId, val] of entries) {
      // Input is in oz — convert to lbs before saving
      await supabase.from('parts').update({ weight_lbs: parseFloat(val) / 16 }).eq('id', partId)
    }
    setWeightEdits({})
    setWeightFixOpen(null)
    await loadAll()
    setSavingWeights(false)
    setMessage(`✓ Weights saved for ${entries.length} part${entries.length !== 1 ? 's' : ''}.`)
  }

  // ── Derived ───────────────────────────────────────────────────────────────────

  // Build batches currently at the powder coater (no powder run assigned yet)
  const atCoaterBatches = buildBatches.filter(
    (b) => b.status === 'at_powder' && !b.powder_batch_id
  )

  // Active powder runs (at_coater status)
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

    const totalInvoice  = parseFloat(returnCost)
    const totalWeight   = returnWeight  // already computed via calcBatchWeight
    const costPerLb     = totalWeight > 0 ? totalInvoice / totalWeight : 0

    // Create a completed powder_batch record (acts as a cost receipt)
    const { data: pb, error } = await supabase
      .from('powder_batches')
      .insert({
        batch_name:       runName,
        returned_date:    todayStr,
        total_cost:       totalInvoice,
        total_weight_lbs: totalWeight,
        cost_per_lb:      costPerLb,
        notes:            returnNotes.trim() || null,
        status:           'complete',
      })
      .select('id')
      .single()

    if (error || !pb) {
      setMessage('Save failed: ' + (error?.message ?? 'unknown'))
      setSaving(false)
      return
    }

    // Link selected build batches → this run and mark them complete
    const selectedIds = Array.from(returnSelected)
    await supabase
      .from('build_batches')
      .update({ powder_batch_id: pb.id, status: 'complete', completed_at: todayIso })
      .in('id', selectedIds)

    // Collect all lines across selected batches
    const selectedLines = batchLines.filter((l) => selectedIds.includes(l.batch_id))

    // Split powder cost proportionally by weight and store per line
    for (const line of selectedLines) {
      const lineWeight     = calcSkuWeight(line.sku_id) * line.qty
      const linePowderCost = totalWeight > 0 ? (lineWeight / totalWeight) * totalInvoice : 0
      await supabase
        .from('build_batch_lines')
        .update({ powder_cost_snapshot: linePowderCost })
        .eq('id', line.id)
    }

    // ── Add finished SKUs to inventory ────────────────────────────────────────
    // Aggregate qty completed by SKU across all selected batches
    const skuQtyFinished: Record<string, number> = {}
    for (const line of selectedLines) {
      skuQtyFinished[line.sku_id] = (skuQtyFinished[line.sku_id] ?? 0) + line.qty
    }

    // Fetch current on-hand for affected SKUs then upsert with incremented value
    const skuIds = Object.keys(skuQtyFinished)
    if (skuIds.length > 0) {
      const { data: currentInv } = await supabase
        .from('sku_inventory')
        .select('sku_id, qty_on_hand')
        .in('sku_id', skuIds)

      const invMap: Record<string, number> = {}
      for (const row of (currentInv ?? []) as { sku_id: string; qty_on_hand: number }[]) {
        invMap[row.sku_id] = row.qty_on_hand
      }

      await supabase.from('sku_inventory').upsert(
        skuIds.map((skuId) => ({
          sku_id:       skuId,
          qty_on_hand:  (invMap[skuId] ?? 0) + skuQtyFinished[skuId],
          updated_at:   todayIso,
        })),
        { onConflict: 'sku_id' }
      )
    }

    const count = returnSelected.size
    setReturnMode(false)
    setReturnSelected(new Set())
    setReturnCost('')
    setReturnNotes('')
    await loadAll()
    setSaving(false)
    setMessage(
      `✓ ${count} batch${count !== 1 ? 'es' : ''} marked complete — inventory updated, powder coat recorded at ${fmtCost(costPerLb)}/lb.`
    )
    // Set flag for orders page to show auto-allocate flash message
    sessionStorage.setItem('garvin:auto_allocate', 'true')
  }

  // ── Toggle batch selection ────────────────────────────────────────────────────

  function toggleBatch(id: string) {
    if (groupMode) {
      setGroupSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
    } else {
      setReturnSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
    }
  }

  // ── Create group (Group into Run) ─────────────────────────────────────────────

  async function createGroup() {
    if (groupSelected.size < 1) { setMessage('Select at least one batch.'); return }
    setSaving(true); setMessage('')
    const name = groupName.trim() ||
      `Powder Run — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    const today = new Date().toISOString().split('T')[0]
    const { data: pb, error } = await supabase
      .from('powder_batches')
      .insert({ batch_name: name, sent_date: today, status: 'at_coater', total_cost: 0 })
      .select('id').single()
    if (error || !pb) { setMessage('Save failed: ' + (error?.message ?? 'unknown')); setSaving(false); return }
    await supabase.from('build_batches').update({ powder_batch_id: pb.id }).in('id', Array.from(groupSelected))
    setGroupMode(false); setGroupSelected(new Set()); setGroupName('')
    await loadAll(); setSaving(false)
    setMessage(`✓ ${groupSelected.size} batch${groupSelected.size !== 1 ? 'es' : ''} grouped into "${name}"`)
  }

  // ── Record return for a pre-existing at_coater powder run ─────────────────────

  async function recordRunReturn(pb: PowderBatch) {
    if (!runReturnCost || isNaN(parseFloat(runReturnCost))) {
      setMessage('Enter the total invoice cost.'); return
    }
    setSaving(true); setMessage('')
    const today    = new Date()
    const todayStr = today.toISOString().split('T')[0]
    const todayIso = today.toISOString()
    const totalInvoice = parseFloat(runReturnCost)
    const linked = buildBatches.filter((b) => b.powder_batch_id === pb.id)
    const totalWeight = linked.reduce((s, b) => s + calcBatchWeight(b.id), 0)
    const costPerLb   = totalWeight > 0 ? totalInvoice / totalWeight : 0

    // Update the powder_batch record
    await supabase.from('powder_batches').update({
      returned_date: todayStr, total_cost: totalInvoice,
      total_weight_lbs: totalWeight, cost_per_lb: costPerLb,
      notes: runReturnNotes.trim() || null, status: 'complete',
    }).eq('id', pb.id)

    // Mark build batches complete
    const linkedIds = linked.map((b) => b.id)
    await supabase.from('build_batches')
      .update({ status: 'complete', completed_at: todayIso })
      .in('id', linkedIds)

    // Split powder cost by weight per line
    const selectedLines = batchLines.filter((l) => linkedIds.includes(l.batch_id))
    for (const line of selectedLines) {
      const lineWeight     = calcSkuWeight(line.sku_id) * line.qty
      const linePowderCost = totalWeight > 0 ? (lineWeight / totalWeight) * totalInvoice : 0
      await supabase.from('build_batch_lines').update({ powder_cost_snapshot: linePowderCost }).eq('id', line.id)
    }

    // Add finished SKUs to inventory
    const skuQtyFinished: Record<string, number> = {}
    for (const line of selectedLines) {
      skuQtyFinished[line.sku_id] = (skuQtyFinished[line.sku_id] ?? 0) + line.qty
    }
    const skuIds = Object.keys(skuQtyFinished)
    if (skuIds.length > 0) {
      const { data: currentInv } = await supabase.from('sku_inventory').select('sku_id, qty_on_hand').in('sku_id', skuIds)
      const invMap: Record<string, number> = {}
      for (const row of (currentInv ?? []) as { sku_id: string; qty_on_hand: number }[]) invMap[row.sku_id] = row.qty_on_hand
      await supabase.from('sku_inventory').upsert(
        skuIds.map((skuId) => ({ sku_id: skuId, qty_on_hand: (invMap[skuId] ?? 0) + skuQtyFinished[skuId], updated_at: todayIso })),
        { onConflict: 'sku_id' }
      )
    }

    setRunReturnOpen(null); setRunReturnCost(''); setRunReturnNotes('')
    await loadAll(); setSaving(false)
    setMessage(`✓ Run "${pb.batch_name}" complete — inventory updated, powder cost recorded at ${fmtCost(costPerLb)}/lb.`)
    sessionStorage.setItem('garvin:auto_allocate', 'true')
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div
            className="message"
            style={{ flex: 1, color: message.startsWith('✓') ? 'var(--success)' : message.includes('failed') ? 'var(--danger)' : undefined }}
          >
            {message}
          </div>
          {message.startsWith('✓') && (
            <button className="btn btn-primary" style={{ height: 32, fontSize: '0.82rem', whiteSpace: 'nowrap' }}
              onClick={() => { window.location.href = '/orders' }}>
              📦 View Orders →
            </button>
          )}
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
          {atCoaterBatches.length > 0 && !returnMode && !groupMode && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary"
                onClick={() => { setGroupMode(true); setGroupSelected(new Set(atCoaterBatches.map((b) => b.id))) }}
              >
                📦 Group into Run
              </button>
              <button
                className="btn btn-primary"
                style={{ background: 'var(--success)', borderColor: 'var(--success)' }}
                onClick={() => { setReturnMode(true); setReturnSelected(new Set(atCoaterBatches.map((b) => b.id))) }}
              >
                ✓ Record Parts Returned
              </button>
            </div>
          )}
          {(returnMode || groupMode) && (
            <button className="btn btn-secondary" onClick={() => { setReturnMode(false); setReturnSelected(new Set()); setGroupMode(false); setGroupSelected(new Set()) }}>
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
                  const selected  = returnMode ? returnSelected.has(batch.id) : groupSelected.has(batch.id)

                  const missingParts = getMissingWeightParts(batch.id)
                  const isFixOpen = weightFixOpen === batch.id
                  return (
                    <div key={batch.id} style={{ borderRadius: 8, border: `1px solid ${missingParts.length > 0 ? 'rgba(239,68,68,0.4)' : selected ? 'var(--accent-border)' : 'var(--border)'}`, overflow: 'hidden' }}>
                      {/* Main row */}
                      <div
                        onClick={() => (returnMode || groupMode) && toggleBatch(batch.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 14,
                          padding: '12px 16px',
                          background: selected ? 'var(--accent-soft)' : missingParts.length > 0 ? 'rgba(239,68,68,0.05)' : 'var(--panel-2)',
                          cursor: (returnMode || groupMode) ? 'pointer' : 'default',
                          transition: 'background 0.12s',
                          userSelect: 'none',
                        }}
                      >
                        {/* Checkbox (only shown in return or group mode) */}
                        {(returnMode || groupMode) && (
                          <input
                            type="checkbox"
                            checked={returnMode ? returnSelected.has(batch.id) : groupSelected.has(batch.id)}
                            onChange={() => {}}
                            style={{ width: 17, height: 17, accentColor: 'var(--accent)', flexShrink: 0, pointerEvents: 'none' }}
                          />
                        )}

                        {/* Icon */}
                        <div style={{ width: 38, height: 38, borderRadius: 8, flexShrink: 0, background: 'rgba(167,139,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem' }}>
                          🎨
                        </div>

                        {/* Info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>{batch.name}</div>
                          <div style={{ fontSize: '0.76rem', color: 'var(--muted)', marginTop: 2 }}>
                            {lineCount} SKU{lineCount !== 1 ? 's' : ''} · sent {daysAgo(batch.created_at)}
                          </div>
                        </div>

                        {/* Weight or warning */}
                        {missingParts.length > 0 ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setWeightFixOpen(isFixOpen ? null : batch.id); setWeightEdits({}) }}
                            style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', color: 'var(--danger)', borderRadius: 8, padding: '5px 12px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}
                          >
                            ⚠ {missingParts.length} part{missingParts.length !== 1 ? 's' : ''} missing weight
                            <span style={{ opacity: 0.6, fontSize: '0.7rem' }}>{isFixOpen ? '▲' : '▼ fix'}</span>
                          </button>
                        ) : (
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
                        )}
                      </div>

                      {/* Weight fix panel */}
                      {isFixOpen && (
                        <div style={{ borderTop: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.04)', padding: '12px 16px' }}>
                          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--danger)', marginBottom: 10 }}>
                            Enter weight (lbs) for each part — required for accurate powder coat cost calculation
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {missingParts.map((part) => (
                              <div key={part.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <DxfPartPreview dxfFile={part.dxf_file} partNumber={part.part_number} size="small" />
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-1)' }}>{part.part_number}</div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{part.description ?? '—'}</div>
                                </div>
                                <div style={{ flex: 1 }} />
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  placeholder="oz"
                                  className="field"
                                  style={{ width: 72, textAlign: 'right', padding: '4px 8px', fontSize: '0.82rem' }}
                                  value={weightEdits[part.id] ?? ''}
                                  onChange={(e) => setWeightEdits((prev) => ({ ...prev, [part.id]: e.target.value }))}
                                />
                                <span style={{ fontSize: '0.78rem', color: 'var(--muted)', flexShrink: 0 }}>oz</span>
                              </div>
                            ))}
                          </div>
                          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                            <button
                              className="btn btn-primary"
                              disabled={savingWeights || !Object.values(weightEdits).some((v) => v.trim() !== '')}
                              onClick={() => void saveWeightEdits()}
                            >
                              {savingWeights ? '⏳ Saving…' : '💾 Save Weights'}
                            </button>
                            <button className="btn btn-secondary" onClick={() => { setWeightFixOpen(null); setWeightEdits({}) }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
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

              {/* ── Inline group form ───────────────────────────────────────── */}
              {groupMode && (
                <div style={{ marginTop: 16, padding: 20, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 14, fontSize: '0.9rem' }}>Group Batches into a Powder Run</div>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <label className="label">Run Name (optional)</label>
                      <input
                        className="field"
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                        placeholder={`Powder Run — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
                        autoFocus
                      />
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)', paddingBottom: 8 }}>
                      {groupSelected.size} batch{groupSelected.size !== 1 ? 'es' : ''} selected
                    </div>
                  </div>
                  <div className="btn-row">
                    <button className="btn btn-primary" disabled={saving || groupSelected.size === 0} onClick={() => void createGroup()}>
                      {saving ? 'Saving…' : `📦 Create Run with ${groupSelected.size} Batch${groupSelected.size !== 1 ? 'es' : ''}`}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ── Active Runs ───────────────────────────────────────────────────────── */}
      {legacyRuns.length > 0 && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Active Runs</h2>
            <div className="card-subtitle">
              {legacyRuns.length} run{legacyRuns.length !== 1 ? 's' : ''} at the coater
            </div>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {legacyRuns.map((pb) => {
                const linked      = buildBatches.filter((b) => b.powder_batch_id === pb.id)
                const totalWeight = linked.reduce((s, b) => s + calcBatchWeight(b.id), 0)
                const isOpen      = runReturnOpen === pb.id
                const estCpl      = runReturnCost && totalWeight > 0 ? parseFloat(runReturnCost) / totalWeight : null
                // Collect all missing-weight parts across linked batches (deduped)
                const runMissingMap = new Map<string, Part>()
                for (const b of linked) {
                  for (const p of getMissingWeightParts(b.id)) runMissingMap.set(p.id, p)
                }
                const runMissingParts = Array.from(runMissingMap.values())
                const isWeightFixOpen = weightFixOpen === pb.id
                return (
                  <div key={pb.id} style={{ border: `1px solid ${runMissingParts.length > 0 ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`, borderRadius: 8, overflow: 'hidden' }}>
                    {/* Run header */}
                    <div style={{ padding: '12px 16px', background: runMissingParts.length > 0 ? 'rgba(239,68,68,0.05)' : 'var(--panel-2)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                      <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(167,139,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem', flexShrink: 0 }}>🎨</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>{pb.batch_name}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 2 }}>
                          {linked.length} build batch{linked.length !== 1 ? 'es' : ''}
                          {pb.sent_date ? ` · sent ${fmtDate(pb.sent_date)}` : ''}
                          {totalWeight > 0 ? ` · ${fmtWeight(totalWeight)}` : ''}
                        </div>
                      </div>
                      {runMissingParts.length > 0 && (
                        <button
                          type="button"
                          onClick={() => { setWeightFixOpen(isWeightFixOpen ? null : pb.id); setWeightEdits({}) }}
                          style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', color: 'var(--danger)', borderRadius: 8, padding: '5px 12px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}
                        >
                          ⚠ {runMissingParts.length} part{runMissingParts.length !== 1 ? 's' : ''} missing weight
                          <span style={{ opacity: 0.6, fontSize: '0.7rem' }}>{isWeightFixOpen ? '▲' : '▼ fix'}</span>
                        </button>
                      )}
                      {!isOpen && (
                        <button
                          className="btn btn-primary"
                          style={{ background: 'var(--success)', borderColor: 'var(--success)', fontSize: '0.82rem' }}
                          onClick={() => { setRunReturnOpen(pb.id); setRunReturnCost(''); setRunReturnNotes('') }}
                        >
                          ✓ Record Return
                        </button>
                      )}
                      {isOpen && (
                        <button className="btn btn-secondary" style={{ fontSize: '0.82rem' }} onClick={() => setRunReturnOpen(null)}>
                          ✕ Cancel
                        </button>
                      )}
                    </div>

                    {/* Weight fix panel for run */}
                    {isWeightFixOpen && (
                      <div style={{ borderTop: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.04)', padding: '12px 16px' }}>
                        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--danger)', marginBottom: 10 }}>
                          Enter weight (lbs) for each part — required for accurate powder coat cost calculation
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {runMissingParts.map((part) => (
                            <div key={part.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <DxfPartPreview dxfFile={part.dxf_file} partNumber={part.part_number} size="small" />
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-1)' }}>{part.part_number}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{part.description ?? '—'}</div>
                              </div>
                              <div style={{ flex: 1 }} />
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="oz"
                                className="field"
                                style={{ width: 72, textAlign: 'right', padding: '4px 8px', fontSize: '0.82rem' }}
                                value={weightEdits[part.id] ?? ''}
                                onChange={(e) => setWeightEdits((prev) => ({ ...prev, [part.id]: e.target.value }))}
                              />
                              <span style={{ fontSize: '0.78rem', color: 'var(--muted)', flexShrink: 0 }}>oz</span>
                            </div>
                          ))}
                        </div>
                        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                          <button
                            className="btn btn-primary"
                            disabled={savingWeights || !Object.values(weightEdits).some((v) => v.trim() !== '')}
                            onClick={() => void saveWeightEdits()}
                          >
                            {savingWeights ? '⏳ Saving…' : '💾 Save Weights'}
                          </button>
                          <button className="btn btn-secondary" onClick={() => { setWeightFixOpen(null); setWeightEdits({}) }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Linked build batch chips */}
                    <div style={{ padding: '8px 16px', display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', background: 'rgba(167,139,250,0.04)' }}>
                      {linked.map((b) => (
                        <span key={b.id} style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', borderRadius: 12, padding: '2px 10px', fontSize: '0.75rem', fontWeight: 600 }}>
                          {b.name}
                        </span>
                      ))}
                      {linked.length === 0 && <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>No build batches linked</span>}
                    </div>

                    {/* Inline return form */}
                    {isOpen && (
                      <div style={{ padding: 20 }}>
                        <div style={{ fontWeight: 700, marginBottom: 14, fontSize: '0.9rem' }}>Record Return — {pb.batch_name}</div>
                        <div style={{ display: 'flex', gap: 20, marginBottom: 16, flexWrap: 'wrap' }}>
                          {[
                            { label: 'Batches', value: String(linked.length) },
                            { label: 'Total weight', value: fmtWeight(totalWeight) },
                            ...(estCpl != null ? [{ label: 'Est. cost / lb', value: fmtCost(estCpl) }] : []),
                          ].map(({ label, value }) => (
                            <div key={label}>
                              <div style={{ fontSize: '0.67rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.09em' }}>{label}</div>
                              <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>{value}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                          <div>
                            <label className="label">Powder Coat Invoice Total ($) *</label>
                            <input className="field" type="number" step="0.01" min="0" value={runReturnCost} onChange={(e) => setRunReturnCost(e.target.value)} placeholder="0.00" autoFocus />
                          </div>
                          <div>
                            <label className="label">Notes (optional)</label>
                            <input className="field" value={runReturnNotes} onChange={(e) => setRunReturnNotes(e.target.value)} placeholder="Invoice #, coater, etc." />
                          </div>
                        </div>
                        <div className="btn-row">
                          <button
                            className="btn btn-primary"
                            style={{ background: 'var(--success)', borderColor: 'var(--success)' }}
                            disabled={saving || !runReturnCost}
                            onClick={() => void recordRunReturn(pb)}
                          >
                            {saving ? 'Saving…' : `✓ Confirm Return & Mark ${linked.length} Batch${linked.length !== 1 ? 'es' : ''} Complete`}
                          </button>
                          <span style={{ fontSize: '0.78rem', color: 'var(--muted)', alignSelf: 'center' }}>
                            Cost split proportionally by part weight
                          </span>
                        </div>
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
