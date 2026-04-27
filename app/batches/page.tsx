'use client'

/*
 * SQL migration — run before using sub-assembly weld tracking:
 * ALTER TABLE sub_assemblies ADD COLUMN IF NOT EXISTS requires_weld boolean DEFAULT false;
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import DxfPartPreview from '@/components/DxfPartPreview'
import { downloadXlsx, xlsxToBuffer } from '@/lib/xlsx'
import JSZip from 'jszip'
import SkuPickerModal, { type PickableSKU } from '@/components/SkuPickerModal'

const SUB_IMAGE_BUCKET = 'subassembly-images'

// ── Types ─────────────────────────────────────────────────────────────────────

type BatchStatus = 'draft' | 'planned' | 'in_progress' | 'at_powder' | 'complete'

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

type SKU = { id: string; description: string; category: string | null; active: boolean }

type Part = {
  id: string
  part_number: string
  description: string
  part_type: 'tube' | 'sheet'
  material: string | null
  thickness: string | null
  tube_od: string | null
  tube_wall: string | null
  tube_shape: string | null
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
  name: string | null
  material_type: string
  tube_od: string | null
  tube_wall: string | null
  thickness: string | null
  unit_weight_lbs: number | null
  stock_length_in: number | null
  scrap_rate: number | null
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
  draft:       { label: 'Draft',            bg: 'rgba(59,130,246,0.15)',  color: '#60a5fa' },
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
  const [batchCompletionCounts, setBatchCompletionCounts] = useState<Record<string, number>>({})
  const [batchTotalOps, setBatchTotalOps] = useState<Record<string, number>>({})
  const [batchViewTab, setBatchViewTab] = useState<'progress' | 'cutlist'>('progress')

  // Per-part/sub-assembly completions for the active batch: Set<"id:stageKey">
  const [completions, setCompletions] = useState<CompletionSet>(new Set())
  const [loadingCompletions, setLoadingCompletions] = useState(false)
  const [saveError, setSaveError] = useState<string>('')
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set())

  // Fulfills These Orders
  const [batchOrders, setBatchOrders] = useState<Array<{id:string; order_number:string; customer_name:string|null; notes:string|null; order_date:string|null}>>([])
  const [showBatchOrders, setShowBatchOrders] = useState(false)

  // Create form
  const [createName, setCreateName]   = useState('')
  const [createNotes, setCreateNotes] = useState('')
  const [createRows, setCreateRows]   = useState([{ skuId: '', qty: '1', skuLookup: '' }])
  const [createDropdown, setCreateDropdown] = useState<number | null>(null)
  const [skuPickerOpen, setSkuPickerOpen]   = useState(false)
  const [orderCounts, setOrderCounts]       = useState<Record<string, number>>({})

  const [saving, setSaving]           = useState(false)
  const [sendingToPowder, setSendingToPowder] = useState(false)

  // CypCut DXF folder — persisted in localStorage so user only sets it once
  const [cypCutFolder, setCypCutFolder] = useState<string>('')
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? (localStorage.getItem('cypcut_dxf_folder') ?? '') : ''
    setCypCutFolder(saved)
  }, [])

  // Draft editing: lineId → qty string (for editing lines on a draft batch)
  const [draftLineEdits, setDraftLineEdits] = useState<Record<string, string>>({})

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
      supabase.from('skus').select('id, description, category, active').order('id'),
      supabase.from('parts').select('id, part_number, description, part_type, material, thickness, tube_od, tube_wall, tube_shape, cut_length, weight_lbs, dxf_file, requires_laser, requires_sheet_bend, requires_tube_bend, requires_saw, requires_drill, requires_weld'),
      supabase.from('sku_parts').select('sku_id, part_id, qty'),
      supabase.from('sku_sub_assemblies').select('sku_id, sub_assembly_id, qty'),
      supabase.from('sub_assembly_parts').select('sub_assembly_id, part_id, qty'),
      supabase.from('sub_assemblies').select('id, name, requires_weld, image_file'),
      supabase.from('materials').select('id, name, material_type, tube_od, tube_wall, thickness, unit_weight_lbs, stock_length_in, scrap_rate, qty_on_hand'),
      supabase.from('material_price_logs').select('material_id, price').order('date_purchased', { ascending: false }),
    ])
    const loadedBatches = (batchData ?? []) as BuildBatch[]
    setBatches(loadedBatches)
    setLines((lineData ?? []) as BuildBatchLine[])
    setSkus((skuData ?? []) as SKU[])
    setParts((partData ?? []) as Part[])
    setSkuParts((spData ?? []) as SkuPart[])
    setSkuSubs((ssData ?? []) as SkuSubAssembly[])
    setSubParts((sapData ?? []) as SubAssemblyPart[])
    setSubAssemblies((saData ?? []) as SubAssembly[])
    setMaterials((matData ?? []) as MaterialRecord[])
    setPriceLogs((plData ?? []) as PriceLog[])

    // Load completion counts for the batch list progress column
    const { data: allComps } = await supabase.from('batch_part_completions').select('batch_id')
    const counts: Record<string, number> = {}
    for (const c of (allComps ?? [])) {
      counts[(c as any).batch_id] = (counts[(c as any).batch_id] ?? 0) + 1
    }
    setBatchCompletionCounts(counts)

    // Compute total expected operations per batch for the progress bar
    const totalOps: Record<string, number> = {}
    for (const batch of loadedBatches) {
      const bLines = (lineData ?? []) as Array<{batch_id: string; sku_id: string; qty: number; id: string}>
      const batchBLines = bLines.filter((l: any) => l.batch_id === batch.id)
      const uniqueOps = new Set<string>()
      for (const line of batchBLines) {
        // Direct parts
        const directParts = (spData ?? []) as Array<{sku_id: string; part_id: string; qty: number}>
        for (const sp of directParts.filter((s: any) => s.sku_id === line.sku_id)) {
          const part = (partData ?? []).find((p: any) => p.id === sp.part_id)
          if (!part) continue
          for (const stage of STAGES) {
            if ((part as any)[stage.partKey]) uniqueOps.add(`${sp.part_id}:${stage.stageKey}`)
          }
        }
        // SA parts
        const skuSubsList = (ssData ?? []) as Array<{sku_id: string; sub_assembly_id: string; qty: number}>
        const subPartsList = (sapData ?? []) as Array<{sub_assembly_id: string; part_id: string; qty: number}>
        const subAssembliesList = (saData ?? []) as Array<{id: string; name: string; requires_weld: boolean}>
        for (const ss of skuSubsList.filter((s: any) => s.sku_id === line.sku_id)) {
          for (const sap of subPartsList.filter((s: any) => s.sub_assembly_id === ss.sub_assembly_id)) {
            const part = (partData ?? []).find((p: any) => p.id === sap.part_id)
            if (!part) continue
            for (const stage of STAGES) {
              if (stage.stageKey === 'weld') continue  // SA weld tracked at SA level
              if ((part as any)[stage.partKey]) uniqueOps.add(`${sap.part_id}:${stage.stageKey}`)
            }
          }
          const sa = subAssembliesList.find((s: any) => s.id === ss.sub_assembly_id)
          if (sa?.requires_weld) uniqueOps.add(`${ss.sub_assembly_id}:weld`)
        }
      }
      totalOps[batch.id] = uniqueOps.size
    }
    setBatchTotalOps(totalOps)

    // Load open order counts per SKU for the picker modal
    const { data: olData } = await supabase
      .from('order_lines')
      .select('sku_id, order:order_id(status)')
      .not('sku_id', 'is', null)
    const skuOrderCounts: Record<string, number> = {}
    for (const row of (olData ?? []) as any[]) {
      if (row.order?.status !== 'open') continue
      skuOrderCounts[row.sku_id] = (skuOrderCounts[row.sku_id] ?? 0) + 1
    }
    setOrderCounts(skuOrderCounts)

    // Auto-open a batch if sessionStorage has a pending open request
    try {
      const openBatchId = sessionStorage.getItem('garvin:open_batch')
      if (openBatchId) {
        sessionStorage.removeItem('garvin:open_batch')
        const target = loadedBatches.find((b) => b.id === openBatchId)
        if (target) { setActiveBatch(target); setView('detail') }
      }
    } catch { /* ignore */ }

    setLoading(false)
  }

  async function loadCompletions(batchId: string) {
    setLoadingCompletions(true)
    const { data } = await supabase
      .from('batch_part_completions')
      .select('part_id, stage_key')
      .eq('batch_id', batchId)
    if (data === null) {
      setSaveError('⚠️ The batch_part_completions table is missing. Run the SQL migration in your Supabase dashboard to enable progress saving.')
    }
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
    if (!activeBatch) return
    void loadCompletions(activeBatch.id)
    // Load orders fulfilled by this batch
    setBatchOrders([])
    setShowBatchOrders(false)
    const batchSkuSet = new Set(lines.filter((l) => l.batch_id === activeBatch.id).map((l) => l.sku_id))
    if (batchSkuSet.size > 0) {
      void (async () => {
        // Step 1: find orders that have at least one matching SKU
        const { data: matchingLines } = await supabase
          .from('order_lines')
          .select('order_id, sku_id')
          .in('sku_id', Array.from(batchSkuSet))
        if (!matchingLines?.length) return

        const candidateIds = [...new Set((matchingLines as any[]).map((l) => l.order_id))]

        // Step 2: get ALL lines for those orders to check full coverage
        const { data: allLines } = await supabase
          .from('order_lines')
          .select('order_id, sku_id')
          .in('order_id', candidateIds)

        // Step 3: only include orders where EVERY line SKU is in this batch
        const fullyCovedIds = candidateIds.filter((orderId) => {
          const orderLines = (allLines ?? []).filter((l: any) => l.order_id === orderId)
          return orderLines.length > 0 && orderLines.every((l: any) => batchSkuSet.has(l.sku_id))
        })

        if (!fullyCovedIds.length) return

        const { data: ordersData } = await supabase
          .from('orders')
          .select('id, order_number, customer_name, notes, order_date')
          .in('id', fullyCovedIds)
          .eq('status', 'open')
        setBatchOrders((ordersData ?? []) as any)
      })()
    }
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
        // Key by partId:subAssemblyId so the same part in different SAs
        // gets its own row with the correct per-SA quantity
        const key = subAssemblyId ? `${partId}:${subAssemblyId}` : partId
        const existing = map.get(key)
        if (existing) {
          existing.totalQty += qty * line.qty
        } else {
          map.set(key, { part, totalQty: qty * line.qty, subAssemblyId })
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
          : m.id === part.material ||
            (m.name != null && m.name === part.material) ||
            m.thickness === part.material)
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
    // Optimistic update
    const prevCompletions = new Set(completions)
    const newCompletions = new Set(completions)
    checked ? newCompletions.add(key) : newCompletions.delete(key)
    setCompletions(newCompletions)
    setSavingKeys((prev) => { const next = new Set(prev); next.add(key); return next })
    setSaveError('')

    // Always delete first (avoids duplicate-key issues regardless of DB constraints)
    await supabase.from('batch_part_completions').delete()
      .eq('batch_id', batchId).eq('part_id', itemId).eq('stage_key', stageKey)

    if (checked) {
      const { error } = await supabase.from('batch_part_completions')
        .insert({ batch_id: batchId, part_id: itemId, stage_key: stageKey })
      if (error) {
        // Revert optimistic update
        setCompletions(prevCompletions)
        setSaveError(`Save failed: ${error.message}. Your progress was not stored — please try again.`)
        setSavingKeys((prev) => { const next = new Set(prev); next.delete(key); return next })
        return
      }
    }

    setSavingKeys((prev) => { const next = new Set(prev); next.delete(key); return next })
    if (checked && activeBatch?.status === 'planned') {
      await updateStatus(activeBatch, 'in_progress')
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
    const prevCompletions = new Set(completions)
    const newCompletions = new Set(completions)
    const bulkKeys = items.map((i) => `${i.id}:${i.stageKey}`)
    if (checked) for (const k of bulkKeys) newCompletions.add(k)
    else for (const k of bulkKeys) newCompletions.delete(k)
    setCompletions(newCompletions)
    setSavingKeys((prev) => { const next = new Set(prev); for (const k of bulkKeys) next.add(k); return next })
    setSaveError('')

    // Delete all first, then re-insert if checking
    for (const item of items) {
      await supabase.from('batch_part_completions').delete()
        .eq('batch_id', batchId).eq('part_id', item.id).eq('stage_key', item.stageKey)
    }
    if (checked) {
      const { error } = await supabase.from('batch_part_completions')
        .insert(items.map((item) => ({ batch_id: batchId, part_id: item.id, stage_key: item.stageKey })))
      if (error) {
        setCompletions(prevCompletions)
        setSaveError(`Save failed: ${error.message}. Please try again.`)
        setSavingKeys((prev) => { const next = new Set(prev); for (const k of bulkKeys) next.delete(k); return next })
        return
      }
    }

    setSavingKeys((prev) => { const next = new Set(prev); for (const k of bulkKeys) next.delete(k); return next })
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

  async function saveDraft() {
    if (!createName.trim()) { setMessage('Name is required.'); return }
    const filledRows = createRows.filter((r) => r.skuId.trim() && r.qty.trim())
    if (!filledRows.length) { setMessage('Add at least one SKU.'); return }
    setSaving(true); setMessage('')
    const { data: batch, error } = await supabase
      .from('build_batches')
      .insert({ name: createName.trim(), notes: createNotes.trim() || null, status: 'draft' })
      .select('*').single()
    if (error || !batch) { setMessage('Save failed: ' + (error?.message ?? 'unknown')); setSaving(false); return }
    await supabase.from('build_batch_lines').insert(
      filledRows.map((r) => ({ batch_id: batch.id, sku_id: r.skuId.trim(), qty: parseInt(r.qty) || 1 }))
    )
    setCreateName(''); setCreateNotes(''); setCreateRows([{ skuId: '', qty: '1', skuLookup: '' }])
    await loadAll()
    const fresh = (await supabase.from('build_batches').select('*').eq('id', batch.id).single()).data
    setActiveBatch(fresh as BuildBatch)
    setDraftLineEdits({})
    setView('detail')
    setSaving(false)
  }

  async function confirmDraft(batch: BuildBatch, editedLines: Record<string, string>) {
    setSaving(true); setMessage('')
    // Save any edited qtys first
    const updates = Object.entries(editedLines)
    for (const [lineId, qtyStr] of updates) {
      const qty = parseInt(qtyStr) || 1
      await supabase.from('build_batch_lines').update({ qty }).eq('id', lineId)
    }
    await supabase.from('build_batches').update({ status: 'planned' }).eq('id', batch.id)
    await loadAll()
    const fresh = (await supabase.from('build_batches').select('*').eq('id', batch.id).single()).data
    setActiveBatch(fresh as BuildBatch)
    setDraftLineEdits({})
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
    // Use .select() so we can verify the row was actually updated
    const { data: updated, error } = await supabase
      .from('build_batches')
      .update({ status: 'at_powder' })
      .eq('id', batch.id)
      .select('*')
      .single()
    if (error || !updated) {
      setMessage(`Failed to send to powder: ${error?.message ?? 'No row returned — check Supabase RLS policies.'}`)
      setSendingToPowder(false)
      return
    }
    setBatches((prev) => prev.map((b) => b.id === batch.id ? updated as BuildBatch : b))
    setActiveBatch(updated as BuildBatch)
    // Hard navigate with cache-bust so the powder page always reloads fresh data
    window.location.href = '/powder?from=batch&t=' + Date.now()
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

  // ── Cut List helpers ──────────────────────────────────────────────────────────

  interface CutListCut {
    partId: string
    partNumber: string
    description: string | null
    cutLengthIn: number | null
    qty: number
    requiresBend: boolean
    saLabel: string | null
    done: boolean
  }

  interface CutListGroup {
    materialId: string
    materialName: string
    stockLengthIn: number | null
    tubeOd: string | null
    tubeWall: string | null
    tubeShape: string | null
    cuts: CutListCut[]
  }

  interface SheetCutListGroup {
    materialId: string
    materialName: string
    thickness: string | null
    parts: Array<{
      partId: string
      partNumber: string
      description: string | null
      dxfFile: string | null
      qty: number
      done: boolean
    }>
  }

  // ── Tube nesting: first-fit-decreasing bin-packing ───────────────────────────
  type NestSegment = { cut: CutListCut; start: number; len: number }
  type NestBar    = { segments: NestSegment[]; used: number }

  function nestTubeCuts(cuts: CutListCut[], stockLen: number, kerf = 0.125): NestBar[] {
    const pieces: { cut: CutListCut; len: number }[] = []
    for (const cut of cuts) {
      if (!cut.cutLengthIn) continue
      for (let i = 0; i < cut.qty; i++) pieces.push({ cut, len: cut.cutLengthIn })
    }
    pieces.sort((a, b) => b.len - a.len)

    const bars: NestBar[] = []
    for (const piece of pieces) {
      let placed = false
      for (const bar of bars) {
        if (piece.len <= stockLen - bar.used + 0.001) {
          bar.segments.push({ cut: piece.cut, start: bar.used, len: piece.len })
          bar.used += piece.len + kerf
          placed = true
          break
        }
      }
      if (!placed) {
        bars.push({ segments: [{ cut: piece.cut, start: 0, len: piece.len }], used: piece.len + kerf })
      }
    }
    return bars
  }

  const NEST_COLORS = ['#3b82f6','#8b5cf6','#ec4899','#f97316','#14b8a6','#a3e635','#f59e0b','#06b6d4','#e11d48','#84cc16']

  function buildCutList(
    wItems: Map<string, { part: Part; totalQty: number; subAssemblyId: string | null }>,
    comps: CompletionSet,
    saGroups: Map<string, { subAssembly: SubAssembly; items: Array<{ part: Part; totalQty: number }> }>
  ): { tubeGroups: CutListGroup[]; sheetGroups: SheetCutListGroup[] } {
    // --- Tube groups ---
    const tubeGroupMap = new Map<string, CutListGroup>()

    for (const { part, totalQty, subAssemblyId } of wItems.values()) {
      if (part.part_type !== 'tube') continue

      // Find matching material by tube_od + tube_wall
      const mat = materials.find(
        (m) => m.material_type === 'tube' && m.tube_od === part.tube_od && m.tube_wall === part.tube_wall
      )
      const matId = mat?.id ?? `__no_mat__${part.tube_od ?? '?'}x${part.tube_wall ?? '?'}`
      const matName = mat
        ? `${part.tube_od ?? '?'} × ${part.tube_wall ?? '?'} wall`
        : `${part.tube_od ?? 'Unknown'} × ${part.tube_wall ?? '?'} (no material record)`

      if (!tubeGroupMap.has(matId)) {
        tubeGroupMap.set(matId, {
          materialId: matId,
          materialName: matName,
          stockLengthIn: mat?.stock_length_in ?? null,
          tubeOd: part.tube_od ?? null,
          tubeWall: part.tube_wall ?? null,
          tubeShape: null,
          cuts: [],
        })
      }

      const saLabel = subAssemblyId
        ? (saGroups.get(subAssemblyId)?.subAssembly.name ?? null)
        : null

      tubeGroupMap.get(matId)!.cuts.push({
        partId: part.id,
        partNumber: part.part_number,
        description: part.description,
        cutLengthIn: part.cut_length ?? null,
        qty: totalQty,
        requiresBend: part.requires_tube_bend,
        saLabel,
        done: comps.has(`${part.id}:saw`),
      })
    }

    // Sort cuts within each group: longest first
    for (const grp of tubeGroupMap.values()) {
      grp.cuts.sort((a, b) => (b.cutLengthIn ?? 0) - (a.cutLengthIn ?? 0))
    }

    // Sort groups by tube OD (parse numeric value)
    const tubeGroups = Array.from(tubeGroupMap.values()).sort((a, b) => {
      const aOd = parseFloat(a.tubeOd ?? '0') || 0
      const bOd = parseFloat(b.tubeOd ?? '0') || 0
      return aOd - bOd
    })

    // --- Sheet groups (grouped by material + thickness) ---
    const sheetGroupMap = new Map<string, SheetCutListGroup>()
    for (const { part, totalQty } of wItems.values()) {
      if (part.part_type !== 'sheet') continue
      // Match by ID first, then by name, then by thickness (legacy)
      const mat = materials.find(
        (m) => m.material_type === 'sheet' && (
          m.id === part.material ||
          (m.name != null && m.name === part.material) ||
          m.thickness === part.material
        )
      )
      const displayName = mat?.name ?? part.material ?? 'Sheet'
      const groupKey = `${part.material ?? '__none__'}::${mat?.id ?? '__none__'}`
      const matName = mat
        ? (mat.thickness ? `${displayName} — ${mat.thickness}"` : displayName)
        : `${part.material ?? 'Sheet'} (no material record)`
      const thickness = mat?.thickness ?? null

      if (!sheetGroupMap.has(groupKey)) {
        sheetGroupMap.set(groupKey, { materialId: groupKey, materialName: matName, thickness, parts: [] })
      }
      sheetGroupMap.get(groupKey)!.parts.push({
        partId: part.id,
        partNumber: part.part_number,
        description: part.description,
        dxfFile: part.dxf_file,
        qty: totalQty,
        done: comps.has(`${part.id}:laser`) || comps.has(`${part.id}:sheet_bend`),
      })
    }
    const sheetGroups = Array.from(sheetGroupMap.values())

    return { tubeGroups, sheetGroups }
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

  // ── Print cut list ────────────────────────────────────────────────────────────

  function printCutList(
    tubeGroups: CutListGroup[],
    sheetGroups: SheetCutListGroup[]
  ) {
    const batchName = activeBatch?.name ?? 'Batch'
    let html = `<!DOCTYPE html><html><head><title>Cut List \u2014 ${batchName}</title>
<style>
  body { font-family: sans-serif; padding: 24px; color: #111; }
  h1 { margin: 0 0 4px; font-size: 1.4rem; }
  .subtitle { color: #666; font-size: 0.85rem; margin-bottom: 24px; }
  .material-group { margin-bottom: 28px; page-break-inside: avoid; }
  .material-header { background: #f0f0f0; padding: 8px 12px; border-left: 4px solid #333; margin-bottom: 8px; }
  .material-name { font-weight: bold; font-size: 1rem; }
  .material-stats { font-size: 0.8rem; color: #555; margin-top: 2px; }
  .section-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #888; font-weight: 700; padding: 4px 0 2px; border-bottom: 1px solid #ccc; margin: 10px 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 6px 8px; border-bottom: 2px solid #333; font-size: 0.78rem; text-transform: uppercase; }
  td { padding: 5px 8px; border-bottom: 1px solid #ddd; font-size: 0.85rem; }
  .mono { font-family: monospace; font-weight: bold; }
  .bend-badge { background: #e0e0e0; border-radius: 3px; padding: 1px 5px; font-size: 0.72rem; }
  .totals-row td { background: #f8f8f8; font-weight: bold; border-top: 2px solid #333; }
  .done-row td { color: #888; text-decoration: line-through; }
  .sa-label { font-size: 0.72rem; color: #888; }
  @media print { body { padding: 12px; } }
</style></head><body>
<h1>Cut List \u2014 ${batchName}</h1>
<div class="subtitle">Printed ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}</div>`

    for (const grp of tubeGroups) {
      const totalIn = grp.cuts.reduce((s, c) => s + (c.cutLengthIn ?? 0) * c.qty, 0)
      const stockNeeded = grp.stockLengthIn
        ? Math.ceil(totalIn / grp.stockLengthIn)
        : null
      const scrapIn = stockNeeded && grp.stockLengthIn
        ? stockNeeded * grp.stockLengthIn - totalIn
        : null
      const totalPcs = grp.cuts.reduce((s, c) => s + c.qty, 0)

      html += `<div class="material-group">
<div class="material-header">
  <div class="material-name">${grp.tubeOd ?? '?'} Tube \xd7 ${grp.tubeWall ?? '?'} wall</div>
  <div class="material-stats">Stock: ${grp.stockLengthIn ? grp.stockLengthIn + '"' : 'unknown'} &nbsp;|&nbsp; ${totalPcs} pieces &nbsp;|&nbsp; ${totalIn.toFixed(1)}" total</div>
</div>
<div class="section-label">Cuts</div>
<table>
<thead><tr><th style="width:90px">Part #</th><th>Description</th><th style="width:40px;text-align:center">Qty</th><th style="width:60px;text-align:right">Length</th><th style="width:60px;text-align:right">Total</th><th style="width:50px"></th></tr></thead>
<tbody>`
      for (const c of grp.cuts) {
        const rowClass = c.done ? ' class="done-row"' : ''
        const desc = (c.description ?? '').length > 42 ? (c.description ?? '').slice(0, 42) + '\u2026' : (c.description ?? '\u2014')
        html += `<tr${rowClass}>
  <td class="mono">${c.partNumber}</td>
  <td>${desc}${c.saLabel ? `<br><span class="sa-label">${c.saLabel}</span>` : ''}</td>
  <td style="text-align:center">${c.qty}&times;</td>
  <td style="text-align:right">${c.cutLengthIn != null ? c.cutLengthIn + '"' : '\u2014'}</td>
  <td style="text-align:right">${c.cutLengthIn != null ? (c.cutLengthIn * c.qty) + '"' : '\u2014'}</td>
  <td>${c.requiresBend ? '<span class="bend-badge">BEND</span>' : ''}</td>
</tr>`
      }
      html += `</tbody>
<tfoot><tr class="totals-row">
  <td colspan="2">Total</td>
  <td style="text-align:center">${totalPcs} pcs</td>
  <td style="text-align:right" colspan="2">${totalIn.toFixed(1)}"</td>
  <td></td>
</tr></tfoot>
</table>`
      if (stockNeeded != null) {
        html += `<div style="font-size:0.8rem;color:#555;margin-top:6px;padding:4px 0;">
  Stock required: ${stockNeeded} \xd7 ${grp.stockLengthIn}" = ${(stockNeeded * (grp.stockLengthIn!)).toFixed(0)}" available &rarr; ${scrapIn?.toFixed(1)}" scrap
</div>`
      }

      // Bends sub-section
      const bendParts = grp.cuts.filter((c) => c.requiresBend)
      if (bendParts.length > 0) {
        html += `<div class="section-label">Bends</div>
<table>
<thead><tr><th style="width:90px">Part #</th><th>Description</th><th style="width:40px;text-align:center">Qty</th><th style="width:60px;text-align:right">Length</th></tr></thead>
<tbody>`
        for (const c of bendParts) {
          const desc = (c.description ?? '').length > 42 ? (c.description ?? '').slice(0, 42) + '\u2026' : (c.description ?? '\u2014')
          html += `<tr><td class="mono">${c.partNumber}</td><td>${desc}</td><td style="text-align:center">${c.qty}&times;</td><td style="text-align:right">${c.cutLengthIn != null ? c.cutLengthIn + '"' : '\u2014'}</td></tr>`
        }
        html += `</tbody></table>`
      }

      html += `</div>`
    }

    for (const sg of sheetGroups) {
      const totalPieces = sg.parts.reduce((s, p) => s + p.qty, 0)
      html += `<div class="material-group">
<div class="material-header">
  <div class="material-name">${sg.materialName}</div>
  <div class="material-stats">${totalPieces} pieces needed</div>
</div>
<table>
<thead><tr><th style="width:90px">Part #</th><th>Description</th><th style="width:100px;text-align:center">Pieces Needed</th></tr></thead>
<tbody>`
      for (const p of sg.parts) {
        const rowClass = p.done ? ' class="done-row"' : ''
        const desc = (p.description ?? '').length > 42 ? (p.description ?? '').slice(0, 42) + '\u2026' : (p.description ?? '\u2014')
        html += `<tr${rowClass}>
  <td class="mono">${p.partNumber}</td>
  <td>${desc}</td>
  <td style="text-align:center">${p.qty} pieces needed</td>
</tr>`
      }
      html += `</tbody></table></div>`
    }

    html += `<script>window.onload=function(){window.print()}<\/script></body></html>`
    const w = window.open('', '_blank')
    if (w) { w.document.write(html); w.document.close() }
  }

  async function exportBatchCypCut(wItems: Map<string, { part: Part; totalQty: number; subAssemblyId: string | null }>) {
    // Deduplicate by part.id — same part may appear across multiple SAs
    const partTotals = new Map<string, { part: Part; totalQty: number }>()
    for (const [, wi] of wItems) {
      if (wi.part.part_type !== 'sheet') continue
      const existing = partTotals.get(wi.part.id)
      if (existing) {
        existing.totalQty += wi.totalQty
      } else {
        partTotals.set(wi.part.id, { part: wi.part, totalQty: wi.totalQty })
      }
    }
    if (partTotals.size === 0) { alert('No sheet parts in this batch.'); return }

    const supabase = createBrowserClient()
    const zip = new JSZip()
    const batchName = activeBatch?.name ?? 'batch'

    // Build XLSX rows — FilePath uses the configured folder so CypCut can find files
    const folder = cypCutFolder.trim().replace(/[/\\]+$/, '')  // strip trailing slashes
    const rows = Array.from(partTotals.values()).map(({ part, totalQty }) => {
      const bare = part.dxf_file ?? ''
      const filePath = folder ? `${folder}\\${bare}` : bare
      return {
        PartName: [part.thickness, part.material ? `[${part.material}]` : null, part.part_number].filter(Boolean).join(' '),
        Amount: Math.ceil(totalQty * 1.05),
        FilePath: filePath,
      }
    })

    // Add XLSX to ZIP
    const xlsxBytes = xlsxToBuffer('PartsDefinition', rows)
    zip.file(`cypcut-${batchName}.xlsx`, xlsxBytes)

    // Fetch each DXF from Supabase storage and add to ZIP
    const fetchPromises = Array.from(partTotals.values())
      .filter(({ part }) => !!part.dxf_file)
      .map(async ({ part }) => {
        const filename = part.dxf_file!
        const { data: { publicUrl } } = supabase.storage.from('dxf-files').getPublicUrl(filename)
        try {
          const res = await fetch(publicUrl)
          if (!res.ok) throw new Error(`${res.status}`)
          const buf = await res.arrayBuffer()
          zip.file(filename, buf)
        } catch (err) {
          console.warn(`[CypCut] Could not fetch DXF for ${filename}:`, err)
        }
      })

    await Promise.all(fetchPromises)

    const zipBlob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(zipBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cypcut-${batchName}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  function exportBatchTubeXlsx(wItems: Map<string, { part: Part; totalQty: number; subAssemblyId: string | null }>) {
    const tubeParts = Array.from(wItems.entries())
      .filter(([, wi]) => wi.part.part_type === 'tube')
    if (tubeParts.length === 0) { alert('No tube parts in this batch.'); return }
    downloadXlsx(
      `tube-cut-list-${activeBatch?.name ?? 'batch'}.xlsx`,
      'TubeCutList',
      tubeParts.map(([, wi]) => ({
        material:     wi.part.material,
        tube_od:      wi.part.tube_od,
        tube_wall:    wi.part.tube_wall,
        part_number:  wi.part.part_number,
        description:  wi.part.description,
        qty:          wi.totalQty,
        cut_length_in: wi.part.cut_length,
        total_length_in: wi.part.cut_length ? wi.part.cut_length * wi.totalQty : null,
      }))
    )
  }

  // ── Create view cost estimate (must be before any early returns) ─────────────
  const createCostPreview = useMemo(() => {
    return createRows
      .filter((r) => r.skuId.trim() && Number(r.qty) > 0)
      .map((r) => {
        const sku  = skus.find((s) => s.id === r.skuId)
        const qty  = Number(r.qty)
        const cost = calcMatCost(r.skuId, qty)
        return { skuId: r.skuId, description: sku?.description ?? r.skuId, qty, cost }
      })
  }, [createRows, parts, skuParts, skuSubs, subParts, materials, priceLogs])

  const createTotalCost = createCostPreview.reduce((s, r) => s + r.cost, 0)

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
                          <DxfPartPreview dxfFile={part.dxf_file} partNumber={part.part_number} size="small"
                            isTube={part.part_type === 'tube'} tubeFallback={true}
                            tubeOd={part.tube_od} tubeWall={part.tube_wall} cutLength={part.cut_length} tubeShape={part.tube_shape === 'square' || part.tube_od?.toLowerCase().includes('x') ? 'square' : 'round'} />
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
    // allWorkOps includes both part ops and sub-assembly weld ops.
    // Parts inside a sub-assembly don't get a per-part weld op — weld is
    // tracked at the SA level only (via the SA Weld checkbox).
    const saPartIds = new Set(Array.from(subAssemblyGroups.values()).flatMap(({ items }) => items.map(({ part }) => part.id)))
    const allWorkOps: Array<{ id: string; stageKey: string }> = []
    for (const { part } of workItems.values()) {
      for (const stage of STAGES) {
        if (stage.stageKey === 'weld' && saPartIds.has(part.id)) continue
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

    // ── Cut List data ────────────────────────────────────────────────────────────
    const { tubeGroups, sheetGroups } = buildCutList(workItems, completions, subAssemblyGroups)

    // ── Next Up banner ───────────────────────────────────────────────────────────
    let nextUpText = ''
    let nextUpIcon = ''
    let nextUpColor = 'var(--warning)'
    let nextUpBg = 'rgba(234,179,8,0.1)'
    let nextUpBorder = 'rgba(234,179,8,0.3)'

    if (activeBatch.status === 'in_progress') {
      const tubeParts = Array.from(workItems.values()).filter((w) => w.part.part_type === 'tube')
      const unsawedTubeParts = tubeParts.filter((w) => w.part.requires_saw && !completions.has(`${w.part.id}:saw`))
      const unbentTubeParts = tubeParts.filter((w) => w.part.requires_tube_bend && !completions.has(`${w.part.id}:tube_bend`))
      const sheetParts = Array.from(workItems.values()).filter((w) => w.part.part_type === 'sheet')
      const laserPending = sheetParts.filter((w) => w.part.requires_laser && !completions.has(`${w.part.id}:laser`))
      const sheetBendPending = sheetParts.filter((w) =>
        w.part.requires_sheet_bend &&
        (!w.part.requires_laser || completions.has(`${w.part.id}:laser`)) &&
        !completions.has(`${w.part.id}:sheet_bend`)
      )
      const unprocessedSheetParts = sheetParts.filter((w) =>
        (w.part.requires_laser && !completions.has(`${w.part.id}:laser`)) ||
        (w.part.requires_sheet_bend && !completions.has(`${w.part.id}:sheet_bend`))
      )
      const saWeldPending = Array.from(subAssemblyGroups.values()).filter(
        ({ subAssembly }) => subAssembly.requires_weld && !completions.has(`${subAssembly.id}:weld`)
      )
      const finalWeldPending = Array.from(workItems.values()).filter(
        // Exclude SA parts — their weld is tracked at the sub-assembly level
        (w) => !saPartIds.has(w.part.id) && w.part.requires_weld && !completions.has(`${w.part.id}:weld`)
      )

      if (unsawedTubeParts.length > 0) {
        const matCount = new Set(unsawedTubeParts.map((w) => `${w.part.tube_od}x${w.part.tube_wall}`)).size
        nextUpIcon = '✂\ufe0f'
        nextUpText = `Cut ${unsawedTubeParts.length} tube part${unsawedTubeParts.length !== 1 ? 's' : ''} across ${matCount} material${matCount !== 1 ? 's' : ''}`
      } else if (unbentTubeParts.length > 0) {
        nextUpIcon = '\ud83d\udd04'
        nextUpText = `Bend ${unbentTubeParts.length} tube part${unbentTubeParts.length !== 1 ? 's' : ''}`
      } else if (laserPending.length > 0) {
        nextUpIcon = '\ud83d\udd35'
        nextUpText = `Laser-cut ${laserPending.length} sheet part${laserPending.length !== 1 ? 's' : ''}`
      } else if (sheetBendPending.length > 0) {
        nextUpIcon = '\ud83d\udd27'
        nextUpText = `Bend ${sheetBendPending.length} sheet part${sheetBendPending.length !== 1 ? 's' : ''}`
      } else if (unprocessedSheetParts.length > 0) {
        nextUpIcon = '\ud83d\udccc'
        nextUpText = `Process ${unprocessedSheetParts.length} sheet part${unprocessedSheetParts.length !== 1 ? 's' : ''}`
      } else if (saWeldPending.length > 0) {
        nextUpIcon = '\ud83d\udd25'
        nextUpText = `Weld ${saWeldPending.length} sub-assembl${saWeldPending.length !== 1 ? 'ies' : 'y'}`
      } else if (finalWeldPending.length > 0) {
        nextUpIcon = '\ud83d\udd25'
        nextUpText = `Final weld (${finalWeldPending.length} part${finalWeldPending.length !== 1 ? 's' : ''})`
      } else if (totalOps > 0) {
        nextUpIcon = '\u2705'
        nextUpText = 'All parts complete \u2014 ready to send to powder'
        nextUpColor = 'var(--success)'
        nextUpBg = 'rgba(34,197,94,0.1)'
        nextUpBorder = 'rgba(34,197,94,0.3)'
      }
    }

    return (
      <div className="section-stack">
        <style>{`
          @media (max-width: 640px) {
            .mfg-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
            .mfg-table { min-width: 600px; }
            .batch-detail-header { flex-direction: column !important; align-items: flex-start !important; }
            .batch-action-bar { flex-wrap: wrap !important; gap: 8px !important; }
          }
        `}</style>
        <div className="page-header no-print batch-detail-header">
          <div>
            <div className="kicker">Garvin Internal Tool</div>
            <h1 className="page-title">{activeBatch.name}</h1>
            <div className="page-subtitle">Build batch detail</div>
          </div>
          <div className="batch-action-bar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
              <div className="batch-action-bar" style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {activeBatch.status === 'draft' && (
                  <button className="btn btn-primary" disabled={saving} onClick={() => confirmDraft(activeBatch, draftLineEdits)}>
                    {saving ? 'Saving…' : '✓ Confirm Batch'}
                  </button>
                )}
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

        {/* ── Draft editing card ────────────────────────────────────────────── */}
        {activeBatch.status === 'draft' && (
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Review &amp; Confirm Quantities</h2>
              <div className="card-subtitle">Edit quantities if needed, then click "Confirm Batch" to mark as Planned and start building.</div>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>SKU</th><th>Description</th><th style={{ textAlign: 'center', width: 100 }}>Qty</th></tr></thead>
                  <tbody>
                    {batchLines.map((line) => {
                      const sku = skus.find((s) => s.id === line.sku_id)
                      const qtyVal = draftLineEdits[line.id] ?? String(line.qty)
                      return (
                        <tr key={line.id}>
                          <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{line.sku_id}</td>
                          <td style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>{sku?.description ?? '—'}</td>
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="number" min="1" step="1"
                              className="field"
                              style={{ width: 80, textAlign: 'center', padding: '4px 8px' }}
                              value={qtyVal}
                              onChange={(e) => setDraftLineEdits((prev) => ({ ...prev, [line.id]: e.target.value }))}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* Next Up banner */}
        {activeBatch.status === 'in_progress' && nextUpText && (
          <div style={{ background: nextUpBg, border: `1px solid ${nextUpBorder}`, borderRadius: 8, padding: '10px 16px', color: nextUpColor, fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: '1.1rem' }}>{nextUpIcon}</span>
            <span>Next Up: {nextUpText}</span>
          </div>
        )}

        {/* at_powder banner */}
        {activeBatch.status === 'at_powder' && (
          <div style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.35)', borderRadius: 8, padding: '14px 20px', color: '#a78bfa', fontWeight: 600 }}>
            🎨 At Powder Coater — parts are out for finishing.{' '}
            <button onClick={() => router.push('/powder')} style={{ background: 'none', border: 'none', color: '#a78bfa', textDecoration: 'underline', cursor: 'pointer', fontWeight: 700, padding: 0 }}>
              Manage on Powder page →
            </button>
          </div>
        )}

        {/* Fulfills These Orders */}
        {batchOrders.length > 0 && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ background: 'var(--panel-2)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
              onClick={() => setShowBatchOrders((v) => !v)}>
              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>📦 Fulfills {batchOrders.length} Open Order{batchOrders.length !== 1 ? 's' : ''}</span>
              <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{showBatchOrders ? '▲ hide' : '▼ show'}</span>
            </div>
            {showBatchOrders && (
              <div style={{ padding: '8px 16px 12px' }}>
                {batchOrders.map((order) => (
                  <div key={order.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>#{order.order_number}</span>
                    <span style={{ color: 'var(--text-2)', fontSize: '0.85rem' }}>{order.customer_name ?? '—'}</span>
                    {order.notes && (
                      <span style={{ background: 'rgba(234,179,8,0.15)', color: 'var(--warning)', borderRadius: 6, padding: '1px 8px', fontSize: '0.78rem' }}>
                        📝 {order.notes}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Save error banner */}
        {saveError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, color: 'var(--danger)', fontSize: '0.85rem' }}>
            <span>⚠️ {saveError}</span>
            <button style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontWeight: 700 }} onClick={() => setSaveError('')}>✕</button>
          </div>
        )}

        {/* Manufacturing checklist (in_progress only) */}
        {activeBatch.status === 'in_progress' && (
          <section className="card">
            <div className="card-header" style={{ flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h2 className="card-title">Manufacturing</h2>
                <div className="card-subtitle">{doneOps} of {totalOps} operations complete</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto', flexWrap: 'wrap' }}>
                {/* View toggle tabs */}
                <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <button
                    type="button"
                    onClick={() => setBatchViewTab('progress')}
                    style={{
                      padding: '5px 14px',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      border: 'none',
                      borderRight: '1px solid var(--border)',
                      cursor: 'pointer',
                      background: batchViewTab === 'progress' ? 'var(--accent)' : 'var(--panel-2)',
                      color: batchViewTab === 'progress' ? '#fff' : 'var(--text-2)',
                    }}
                  >
                    &#x1F4CB; Progress
                  </button>
                  <button
                    type="button"
                    onClick={() => setBatchViewTab('cutlist')}
                    style={{
                      padding: '5px 14px',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      border: 'none',
                      cursor: 'pointer',
                      background: batchViewTab === 'cutlist' ? 'var(--accent)' : 'var(--panel-2)',
                      color: batchViewTab === 'cutlist' ? '#fff' : 'var(--text-2)',
                    }}
                  >
                    &#x1F52A; Cut List
                  </button>
                </div>
                <div style={{ fontSize: '1.4rem', fontWeight: 800, color: allDone ? 'var(--success)' : 'var(--accent)' }}>{pct}%</div>
              </div>
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

                  {batchViewTab === 'cutlist' ? (
                    /* ── Cut List View ────────────────────────────────────────── */
                    <div>
                      {/* Cut list action buttons */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 10px' }}>
                          <span style={{ fontSize: '0.72rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>Extract&nbsp;to:</span>
                          <input
                            className="field"
                            style={{ width: 220, fontSize: '0.78rem', padding: '3px 8px', fontFamily: 'monospace' }}
                            value={cypCutFolder}
                            onChange={(e) => {
                              setCypCutFolder(e.target.value)
                              localStorage.setItem('cypcut_dxf_folder', e.target.value)
                            }}
                            placeholder="C:\CypCut\DXF"
                            title="Folder where you extract the ZIP — CypCut will look here for DXF files"
                          />
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: '0.82rem' }}
                          onClick={() => exportBatchCypCut(workItems)}
                        >
                          &#x1F4E6; Export CypCut Bundle
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: '0.82rem' }}
                          onClick={() => printCutList(tubeGroups, sheetGroups)}
                        >
                          &#x1F5A8; Print Cut List
                        </button>
                      </div>

                      {tubeGroups.length === 0 && sheetGroups.length === 0 && (
                        <div className="empty">No parts with material info found in this batch.</div>
                      )}

                      {/* Tube material groups */}
                      {tubeGroups.map((grp) => {
                        const totalIn = grp.cuts.reduce((s, c) => s + (c.cutLengthIn ?? 0) * c.qty, 0)
                        const totalPcs = grp.cuts.reduce((s, c) => s + c.qty, 0)
                        const stockNeeded = grp.stockLengthIn && grp.stockLengthIn > 0
                          ? Math.ceil(totalIn / grp.stockLengthIn)
                          : null
                        const scrapIn = stockNeeded && grp.stockLengthIn
                          ? stockNeeded * grp.stockLengthIn - totalIn
                          : null
                        const bendParts = grp.cuts.filter((c) => c.requiresBend)
                        return (
                          <div key={grp.materialId} style={{ marginBottom: 28, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                            {/* Material header */}
                            <div style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border)', padding: '10px 16px', borderLeft: '4px solid var(--accent)' }}>
                              <div style={{ fontWeight: 800, fontSize: '1rem' }}>
                                {grp.tubeOd ?? '?'} Tube &times; {grp.tubeWall ?? '?'} wall
                              </div>
                              <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 2, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                                <span>Stock: {grp.stockLengthIn ? grp.stockLengthIn + '"' : 'unknown'}</span>
                                <span>{totalPcs} pieces</span>
                                <span>{totalIn.toFixed(1)}" total</span>
                                {stockNeeded != null && (
                                  <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
                                    {stockNeeded} stock length{stockNeeded !== 1 ? 's' : ''} needed
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Cuts sub-section */}
                            <div style={{ padding: '0 0 4px' }}>
                              <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--muted)', padding: '8px 16px 4px', borderBottom: '1px solid var(--border)' }}>
                                Cuts
                              </div>
                              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                  <tr style={{ background: 'var(--panel-2)' }}>
                                    <th style={{ textAlign: 'left', padding: '6px 16px', fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', width: 20 }}></th>
                                    <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', width: 90 }}>Part #</th>
                                    <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Description</th>
                                    <th style={{ textAlign: 'center', padding: '6px 8px', fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', width: 44 }}>Qty</th>
                                    <th style={{ textAlign: 'right', padding: '6px 8px', fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', width: 64 }}>Length</th>
                                    <th style={{ textAlign: 'right', padding: '6px 8px', fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', width: 64 }}>Total</th>
                                    <th style={{ padding: '6px 16px 6px 8px', width: 60 }}></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {grp.cuts.map((cut) => (
                                    <tr
                                      key={cut.partId}
                                      style={{
                                        borderTop: '1px solid var(--border)',
                                        background: cut.done ? 'rgba(34,197,94,0.06)' : 'transparent',
                                        opacity: cut.done ? 0.6 : 1,
                                      }}
                                    >
                                      <td style={{ padding: '8px 8px 8px 16px', fontSize: '1rem', textAlign: 'center', verticalAlign: 'middle' }}>
                                        {cut.done ? '☑' : '☐'}
                                      </td>
                                      <td style={{ padding: '8px', fontFamily: 'monospace', fontWeight: 700, fontSize: '0.82rem', verticalAlign: 'middle', color: 'var(--text-1)' }}>
                                        {cut.partNumber}
                                      </td>
                                      <td style={{ padding: '8px', fontSize: '0.85rem', verticalAlign: 'middle' }}>
                                        <div style={{ textDecoration: cut.done ? 'line-through' : 'none', color: cut.done ? 'var(--muted)' : 'var(--text-1)' }}>
                                          {cut.description
                                            ? cut.description.length > 42
                                              ? cut.description.slice(0, 42) + '\u2026'
                                              : cut.description
                                            : '\u2014'}
                                        </div>
                                        {cut.saLabel && (
                                          <div style={{ fontSize: '0.72rem', color: '#a78bfa', marginTop: 1 }}>{cut.saLabel}</div>
                                        )}
                                      </td>
                                      <td style={{ padding: '8px', textAlign: 'center', fontWeight: 700, fontSize: '0.88rem', verticalAlign: 'middle' }}>
                                        {cut.qty}&times;
                                      </td>
                                      <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'monospace', fontSize: '0.88rem', verticalAlign: 'middle' }}>
                                        {cut.cutLengthIn != null ? cut.cutLengthIn + '"' : '\u2014'}
                                      </td>
                                      <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'monospace', fontSize: '0.88rem', verticalAlign: 'middle', color: 'var(--muted)' }}>
                                        {cut.cutLengthIn != null ? (cut.cutLengthIn * cut.qty) + '"' : '\u2014'}
                                      </td>
                                      <td style={{ padding: '8px 16px 8px 8px', verticalAlign: 'middle' }}>
                                        {cut.requiresBend && (
                                          <span style={{ background: 'rgba(234,179,8,0.18)', color: '#facc15', borderRadius: 4, padding: '1px 6px', fontSize: '0.7rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
                                            &#x1F504; BEND
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--panel-2)' }}>
                                    <td colSpan={3} style={{ padding: '7px 8px 7px 16px', fontWeight: 700, fontSize: '0.82rem', color: 'var(--muted)' }}>
                                      Total: {totalPcs} pieces
                                    </td>
                                    <td style={{ textAlign: 'center', fontWeight: 700, fontSize: '0.82rem', padding: '7px 8px' }}>{totalPcs}&times;</td>
                                    <td colSpan={2} style={{ textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', fontSize: '0.88rem', padding: '7px 8px' }}>{totalIn.toFixed(1)}"</td>
                                    <td style={{ padding: '7px 16px 7px 8px' }}></td>
                                  </tr>
                                </tfoot>
                              </table>

                              {/* Stock math */}
                              {stockNeeded != null && grp.stockLengthIn && (
                                <div style={{ padding: '8px 16px 10px', fontSize: '0.8rem', color: 'var(--muted)', borderTop: '1px solid var(--border)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                                  <span>
                                    {stockNeeded} &times; {grp.stockLengthIn}" = {(stockNeeded * grp.stockLengthIn).toFixed(0)}" available
                                  </span>
                                  <span style={{ color: 'var(--warning)' }}>
                                    {scrapIn != null && scrapIn > 0 ? `${scrapIn.toFixed(1)}" scrap` : 'No scrap'}
                                  </span>
                                  <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                                    {(totalIn / grp.stockLengthIn).toFixed(2)} stock lengths used
                                  </span>
                                </div>
                              )}

                              {/* ── Tube nesting diagram ─────────────────────── */}
                              {grp.stockLengthIn && grp.stockLengthIn > 0 && (() => {
                                const bars = nestTubeCuts(grp.cuts, grp.stockLengthIn)
                                if (bars.length === 0) return null
                                const partIds = [...new Set(grp.cuts.map((c) => c.partId))]
                                const colorMap: Record<string, string> = {}
                                partIds.forEach((id, i) => { colorMap[id] = NEST_COLORS[i % NEST_COLORS.length] })
                                return (
                                  <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px 14px' }}>
                                    <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--muted)', marginBottom: 10 }}>
                                      Stock Layout &mdash; {bars.length} bar{bars.length !== 1 ? 's' : ''}
                                    </div>

                                    {bars.map((bar, barIdx) => {
                                      const scrapLen = Math.max(0, grp.stockLengthIn! - (bar.used - 0.125))
                                      const scrapPct = (scrapLen / grp.stockLengthIn!) * 100
                                      return (
                                        <div key={barIdx} style={{ marginBottom: 8 }}>
                                          <div style={{ fontSize: '0.66rem', color: 'var(--muted)', marginBottom: 3, fontFamily: 'monospace' }}>
                                            Bar {barIdx + 1} / {grp.stockLengthIn}"
                                          </div>
                                          <div style={{ display: 'flex', height: 34, borderRadius: 5, overflow: 'hidden', border: '1px solid var(--border)' }}>
                                            {bar.segments.map((seg, si) => {
                                              const pct = (seg.len / grp.stockLengthIn!) * 100
                                              const color = colorMap[seg.cut.partId]
                                              return (
                                                <div
                                                  key={si}
                                                  title={`${seg.cut.partNumber} — ${seg.len}"`}
                                                  style={{
                                                    width: `${pct}%`,
                                                    minWidth: 2,
                                                    background: color,
                                                    borderRight: '2px solid rgba(0,0,0,0.25)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    overflow: 'hidden',
                                                    flexShrink: 0,
                                                  }}
                                                >
                                                  {pct > 7 && (
                                                    <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.5)', whiteSpace: 'nowrap', overflow: 'hidden', padding: '0 3px', maxWidth: '100%' }}>
                                                      {pct > 16 ? `${seg.cut.partNumber} · ${seg.len}"` : `${seg.len}"`}
                                                    </span>
                                                  )}
                                                </div>
                                              )
                                            })}
                                            {scrapPct > 0.3 && (
                                              <div style={{ flex: 1, background: 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderLeft: scrapPct > 1 ? '1px dashed rgba(255,255,255,0.12)' : 'none' }}>
                                                {scrapPct > 6 && (
                                                  <span style={{ fontSize: '0.6rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                                                    {scrapLen.toFixed(2)}" scrap
                                                  </span>
                                                )}
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      )
                                    })}

                                    {/* Legend */}
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 16px', marginTop: 12 }}>
                                      {grp.cuts.map((cut) => (
                                        <div key={cut.partId} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                          <div style={{ width: 10, height: 10, borderRadius: 2, background: colorMap[cut.partId], flexShrink: 0 }} />
                                          <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'var(--text-2)' }}>
                                            {cut.partNumber}{cut.cutLengthIn != null ? ` ${cut.cutLengthIn}"` : ''} &times;{cut.qty}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )
                              })()}
                            </div>

                            {/* Bends sub-section */}
                            {bendParts.length > 0 && (
                              <div style={{ borderTop: '2px solid var(--border)' }}>
                                <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#facc15', padding: '8px 16px 4px', background: 'rgba(234,179,8,0.06)', borderBottom: '1px solid var(--border)' }}>
                                  &#x1F504; Bends
                                </div>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                  <tbody>
                                    {bendParts.map((cut) => (
                                      <tr key={`bend-${cut.partId}`} style={{ borderTop: '1px solid var(--border)' }}>
                                        <td style={{ padding: '7px 8px 7px 16px', fontFamily: 'monospace', fontWeight: 700, fontSize: '0.82rem', width: 100 }}>{cut.partNumber}</td>
                                        <td style={{ padding: '7px 8px', fontSize: '0.85rem', color: 'var(--text-2)' }}>
                                          {cut.description
                                            ? cut.description.length > 42 ? cut.description.slice(0, 42) + '\u2026' : cut.description
                                            : '\u2014'}
                                        </td>
                                        <td style={{ padding: '7px 8px', textAlign: 'center', fontWeight: 700, width: 44 }}>{cut.qty}&times;</td>
                                        <td style={{ padding: '7px 16px 7px 8px', textAlign: 'right', fontFamily: 'monospace', width: 64 }}>
                                          {cut.cutLengthIn != null ? cut.cutLengthIn + '"' : '\u2014'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )
                      })}

                      {/* Sheet parts groups — card grid with DXF previews */}
                      {sheetGroups.length > 0 && sheetGroups.map((sg) => (
                        <div key={sg.materialId} style={{ marginBottom: 28, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                          <div style={{ background: 'var(--panel-2)', borderBottom: '1px solid var(--border)', padding: '10px 16px', borderLeft: '4px solid #60a5fa' }}>
                            <div style={{ fontWeight: 800, fontSize: '1rem' }}>{sg.materialName}</div>
                            <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 2 }}>
                              {sg.parts.reduce((s, p) => s + p.qty, 0)} pieces needed · {sg.parts.length} part{sg.parts.length !== 1 ? 's' : ''}
                            </div>
                          </div>
                          <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
                            {sg.parts.map((p) => (
                              <div key={p.partId} style={{
                                border: `1px solid ${p.done ? 'rgba(34,197,94,0.35)' : 'var(--border)'}`,
                                borderRadius: 8,
                                background: p.done ? 'rgba(34,197,94,0.06)' : 'var(--panel)',
                                overflow: 'hidden',
                                opacity: p.done ? 0.7 : 1,
                              }}>
                                {/* DXF preview */}
                                <div style={{ height: 130, background: 'rgba(0,0,0,0.15)' }}>
                                  <DxfPartPreview
                                    dxfFile={p.dxfFile}
                                    partNumber={p.partNumber}
                                    size="fill"
                                    isTube={false}
                                    tubeFallback={false}
                                  />
                                </div>
                                {/* Info */}
                                <div style={{ padding: '8px 10px' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 4 }}>
                                    <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.78rem', color: 'var(--accent)' }}>{p.partNumber}</span>
                                    <span style={{ fontWeight: 800, fontSize: '0.88rem', color: p.done ? 'var(--success)' : 'var(--text-1)', whiteSpace: 'nowrap' }}>
                                      {p.done ? '✓' : `×${p.qty}`}
                                    </span>
                                  </div>
                                  {p.description && (
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-2)', marginTop: 3, lineHeight: 1.3 }}>
                                      {p.description.length > 38 ? p.description.slice(0, 38) + '…' : p.description}
                                    </div>
                                  )}
                                  {p.done && (
                                    <div style={{ fontSize: '0.68rem', color: 'var(--success)', marginTop: 4, fontWeight: 700 }}>✓ Done</div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                  /* ── Progress Table View ──────────────────────────────────── */
                  <>
                  {/* Part-first manufacturing checklist table */}
                  <div className="mfg-table-wrap" style={{ overflowX: 'auto' }}>
                    <table className="mfg-table" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
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
                              // For weld, skip SA parts — their weld is the SA-level op below
                              if (stageKey === 'weld' && saPartIds.has(w.part.id)) continue
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
                                  {subAssembly.image_file ? (
                                    <img
                                      src={supabase.storage.from(SUB_IMAGE_BUCKET).getPublicUrl(subAssembly.image_file).data.publicUrl}
                                      alt={subAssembly.name}
                                      style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(167,139,250,0.3)', flexShrink: 0 }}
                                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                    />
                                  ) : (
                                    <div style={{ width: 48, height: 48, borderRadius: 6, border: '1px dashed rgba(167,139,250,0.3)', background: 'rgba(167,139,250,0.07)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.3rem', color: 'rgba(167,139,250,0.4)' }}>
                                      🔧
                                    </div>
                                  )}
                                  <div>
                                    <div style={{ fontSize: '0.65rem', color: '#a78bfa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Sub-Assembly</div>
                                    <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{subAssembly.name}</div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                            {/* Part rows — weld column is merged across all rows via rowspan on first part */}
                            {(() => {
                              const saWeldDone = completions.has(`${saId}:weld`)
                              const saWeldBlocked = items.some((i) => STAGES.some((s) => {
                                if (s.stageKey === 'weld') return false
                                if (!i.part[s.partKey as keyof Part]) return false
                                return !completions.has(`${i.part.id}:${s.stageKey}`)
                              }))
                              const weldRowSpan = subAssembly.requires_weld ? items.length : undefined

                              return items.map(({ part, totalQty }, partIndex) => {
                                const rowAllDone = activeStages.every((s) => {
                                  if (s.stageKey === 'weld') return true
                                  return !part[s.partKey as keyof Part] || completions.has(`${part.id}:${s.stageKey}`)
                                })
                                return (
                                  <tr key={`part-${part.id}`} style={{ borderBottom: '1px solid var(--border)', background: rowAllDone ? 'rgba(34,197,94,0.04)' : 'transparent' }}>
                                    <td style={{ padding: '8px 10px', verticalAlign: 'top' }}>
                                      <DxfPartPreview dxfFile={part.dxf_file} partNumber={part.part_number} size="small"
                                        isTube={part.part_type === 'tube'} tubeFallback={true}
                                        tubeOd={part.tube_od} tubeWall={part.tube_wall} cutLength={part.cut_length} tubeShape={part.tube_shape === 'square' || part.tube_od?.toLowerCase().includes('x') ? 'square' : 'round'} />
                                      <div style={{ fontSize: '0.68rem', fontFamily: 'monospace', fontWeight: 700, color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{part.part_number}</div>
                                      {part.description && <div style={{ fontSize: '0.62rem', color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{part.description}</div>}
                                    </td>
                                    <td style={{ textAlign: 'center', fontWeight: 700, fontSize: '0.88rem', verticalAlign: 'middle', color: 'var(--muted)' }}>×{totalQty}</td>
                                    {activeStages.map(({ stageKey, partKey }) => {
                                      // Weld: merged cell on first row only; subsequent rows skip it
                                      if (stageKey === 'weld') {
                                        if (!subAssembly.requires_weld) {
                                          return <td key={stageKey} style={{ borderLeft: '1px solid var(--border)', background: 'rgba(0,0,0,0.03)' }} />
                                        }
                                        if (partIndex > 0) return null  // covered by rowspan
                                        return (
                                          <td key={stageKey} rowSpan={weldRowSpan}
                                            style={{ textAlign: 'center', verticalAlign: 'middle', borderLeft: '1px solid var(--border)', borderBottom: '2px solid rgba(167,139,250,0.22)', background: saWeldDone ? 'rgba(34,197,94,0.1)' : 'rgba(167,139,250,0.05)', padding: 8 }}>
                                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                                              <div style={{ fontSize: '0.62rem', color: '#a78bfa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Weld SA</div>
                                              {savingKeys.has(`${saId}:weld`) ? (
                                                <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>⏳</span>
                                              ) : (
                                                <input type="checkbox" checked={saWeldDone} disabled={saWeldBlocked}
                                                  onChange={(e) => handleToggle(activeBatch.id, saId, 'weld', e.target.checked, workItems, subAssemblyGroups)}
                                                  title={saWeldBlocked ? '⚠ Complete prior stages first' : undefined}
                                                  style={{ width: 20, height: 20, cursor: saWeldBlocked ? 'not-allowed' : 'pointer', accentColor: '#a78bfa', opacity: saWeldBlocked ? 0.35 : 1 }} />
                                              )}
                                              {saWeldBlocked && <div style={{ fontSize: '0.6rem', color: 'var(--warning)' }}>⚠</div>}
                                            </div>
                                          </td>
                                        )
                                      }
                                      if (!part[partKey as keyof Part]) return <td key={stageKey} style={{ borderLeft: '1px solid var(--border)', background: 'rgba(0,0,0,0.03)' }} />
                                      const done = completions.has(`${part.id}:${stageKey}`)
                                      const stageIdx = STAGES.findIndex((s) => s.stageKey === stageKey)
                                      const blocked = stageIdx > 0 && STAGES.slice(0, stageIdx).some((s) => {
                                        if (!part[s.partKey as keyof Part]) return false
                                        return !completions.has(`${part.id}:${s.stageKey}`)
                                      })
                                      return (
                                        <td key={stageKey} style={{ textAlign: 'center', verticalAlign: 'middle', borderLeft: '1px solid var(--border)', background: done ? 'rgba(34,197,94,0.1)' : 'transparent', padding: '4px' }}>
                                          {savingKeys.has(`${part.id}:${stageKey}`) ? (
                                            <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>⏳</span>
                                          ) : (
                                            <>
                                              <input type="checkbox" checked={done} disabled={blocked}
                                                onChange={(e) => handleToggle(activeBatch.id, part.id, stageKey, e.target.checked, workItems, subAssemblyGroups)}
                                                title={blocked ? '⚠ Complete prior stages first' : undefined}
                                                style={{ width: 18, height: 18, cursor: blocked ? 'not-allowed' : 'pointer', accentColor: 'var(--accent)', opacity: blocked ? 0.35 : 1 }} />
                                              {blocked && <div style={{ fontSize: '0.6rem', color: 'var(--warning)', marginTop: 2 }}>⚠</div>}
                                            </>
                                          )}
                                        </td>
                                      )
                                    })}
                                  </tr>
                                )
                              })
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
                                    <DxfPartPreview dxfFile={part.dxf_file} partNumber={part.part_number} size="small"
                                      isTube={part.part_type === 'tube'} tubeFallback={true}
                                      tubeOd={part.tube_od} tubeWall={part.tube_wall} cutLength={part.cut_length} tubeShape={part.tube_shape === 'square' || part.tube_od?.toLowerCase().includes('x') ? 'square' : 'round'} />
                                    <div style={{ fontSize: '0.68rem', fontFamily: 'monospace', fontWeight: 700, color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{part.part_number}</div>
                                    {part.description && <div style={{ fontSize: '0.62rem', color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{part.description}</div>}
                                  </td>
                                  <td style={{ textAlign: 'center', fontWeight: 700, fontSize: '0.88rem', verticalAlign: 'middle', color: 'var(--muted)' }}>×{totalQty}</td>
                                  {activeStages.map(({ stageKey, partKey }) => {
                                    if (!part[partKey as keyof Part]) return <td key={stageKey} style={{ borderLeft: '1px solid var(--border)', background: 'rgba(0,0,0,0.03)' }} />
                                    const done = completions.has(`${part.id}:${stageKey}`)
                                    const stageIdx = STAGES.findIndex((s) => s.stageKey === stageKey)
                                    const blocked = stageIdx > 0 && STAGES.slice(0, stageIdx).some((s) => {
                                      if (!part[s.partKey as keyof Part]) return false
                                      return !completions.has(`${part.id}:${s.stageKey}`)
                                    })
                                    return (
                                      <td key={stageKey} style={{ textAlign: 'center', verticalAlign: 'middle', borderLeft: '1px solid var(--border)', background: done ? 'rgba(34,197,94,0.1)' : 'transparent', padding: '4px' }}>
                                        {savingKeys.has(`${part.id}:${stageKey}`) ? (
                                          <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>⏳</span>
                                        ) : (
                                          <>
                                        <input type="checkbox" checked={done} disabled={blocked}
                                          onChange={(e) => handleToggle(activeBatch.id, part.id, stageKey, e.target.checked, workItems, subAssemblyGroups)}
                                          title={blocked ? '⚠ Complete prior stages first' : undefined}
                                          style={{ width: 18, height: 18, cursor: blocked ? 'not-allowed' : 'pointer', accentColor: 'var(--accent)', opacity: blocked ? 0.35 : 1 }} />
                                        {blocked && <div style={{ fontSize: '0.6rem', color: 'var(--warning)', marginTop: 2 }}>⚠</div>}
                                          </>
                                        )}
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
              <button className="btn btn-secondary" onClick={() => setSkuPickerOpen(true)}>Browse SKUs</button>
              <button className="btn btn-secondary" disabled={saving} onClick={saveDraft} title="Save quantities to confirm later">{saving ? 'Saving…' : '💾 Save Draft'}</button>
              <button className="btn btn-primary" disabled={saving} onClick={createBatch}>{saving ? 'Saving…' : 'Create Batch'}</button>
            </div>
          </div>
        </section>

        {/* ── SKU Picker Modal ────────────────────────────────────────────── */}
        {skuPickerOpen && (
          <SkuPickerModal
            skus={skus}
            orderCounts={orderCounts}
            onClose={() => setSkuPickerOpen(false)}
            onSelect={(picked) => {
              setCreateRows((prev) => {
                let result = [...prev]
                for (const sku of picked) {
                  const emptyIdx = result.findIndex((r) => !r.skuId.trim())
                  if (emptyIdx !== -1) {
                    result[emptyIdx] = { skuId: sku.id, qty: '1', skuLookup: sku.id }
                  } else {
                    result = [...result, { skuId: sku.id, qty: '1', skuLookup: sku.id }]
                  }
                }
                return result
              })
            }}
          />
        )}

        {/* ── Estimated Material Cost ─────────────────────────────────────── */}
        {createCostPreview.length > 0 && (
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Estimated Material Cost</h2>
              <div className="card-subtitle">Based on latest logged material prices — does not include labour, powder coat, or hardware</div>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'center' }}>Qty</th>
                      <th style={{ textAlign: 'right' }}>Est. Material Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {createCostPreview.map((row) => (
                      <tr key={row.skuId}>
                        <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{row.skuId}</td>
                        <td style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>{row.description}</td>
                        <td style={{ textAlign: 'center' }}>{row.qty}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {row.cost > 0 ? fmtCost(row.cost) : <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>no price data</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {createCostPreview.length > 1 && (
                    <tfoot>
                      <tr>
                        <td colSpan={3} style={{ fontWeight: 700, textAlign: 'right', color: 'var(--muted)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Total</td>
                        <td style={{ textAlign: 'right', fontWeight: 800, fontSize: '1rem', color: 'var(--accent)' }}>{fmtCost(createTotalCost)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </section>
        )}
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
                  <tr><th>Name</th><th>Status</th><th>SKUs</th><th>Progress</th><th>Created</th><th>Completed</th></tr>
                </thead>
                <tbody>
                  {batches.map((batch) => {
                    const ss = STATUS_STYLE[batch.status]
                    const skuCount = lines.filter((l) => l.batch_id === batch.id).length
                    const done = batchCompletionCounts[batch.id] ?? 0
                    const total = batchTotalOps[batch.id] ?? 0
                    const pct = total > 0 ? Math.round((done / total) * 100) : (batch.status === 'complete' ? 100 : 0)
                    return (
                      <tr key={batch.id} style={{ cursor: 'pointer' }} onClick={() => { setActiveBatch(batch); setView('detail') }}>
                        <td style={{ fontWeight: 700 }}>{batch.name}</td>
                        <td><span style={{ background: ss.bg, color: ss.color, borderRadius: 20, padding: '2px 10px', fontSize: '0.76rem', fontWeight: 700 }}>{ss.label}</span></td>
                        <td>{skuCount}</td>
                        <td style={{ minWidth: 120 }}>
                          {batch.status === 'complete' ? (
                            <span style={{ color: 'var(--success)', fontSize: '0.8rem', fontWeight: 700 }}>✓ Done</span>
                          ) : batch.status === 'at_powder' ? (
                            <span style={{ color: '#a78bfa', fontSize: '0.8rem', fontWeight: 700 }}>🎨 At Powder</span>
                          ) : batch.status === 'draft' ? (
                            <span style={{ color: '#60a5fa', fontSize: '0.8rem' }}>Pending confirmation</span>
                          ) : batch.status === 'planned' ? (
                            <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>Not started</span>
                          ) : (
                            <div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                                <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{done}/{total} ops</span>
                                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: pct === 100 ? 'var(--success)' : 'var(--accent)' }}>{pct}%</span>
                              </div>
                              <div style={{ height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--success)' : 'var(--accent)', borderRadius: 3, transition: 'width 0.3s ease' }} />
                              </div>
                            </div>
                          )}
                        </td>
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
