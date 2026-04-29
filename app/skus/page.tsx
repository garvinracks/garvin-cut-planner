'use client'

/*
 * SQL migration — run before using sub-assembly weld tracking:
 * ALTER TABLE sub_assemblies ADD COLUMN IF NOT EXISTS requires_weld boolean DEFAULT false;
 */

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import DxfPartPreview from '@/components/DxfPartPreview'
import PartPickerModal from '@/components/PartPickerModal'
import SubAssemblyPickerModal from '@/components/SubAssemblyPickerModal'

// ── Types ─────────────────────────────────────────────────────────────────────

type SKU = {
  id: string
  description: string
  category: string | null
  notes: string | null
  active: boolean
  bolt_kit_cost: number | null
  packaging_cost: number | null
  labor_cost_per_unit: number | null
}

const SUB_IMAGE_BUCKET = 'subassembly-images'

type SubAssembly = {
  id: string
  name: string
  notes?: string | null
  image_file?: string | null
  requires_weld: boolean | null
}

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
  dxf_file: string | null
  notes?: string | null
  weight_lbs: number | null
  requires_laser: boolean
  requires_sheet_bend: boolean
  requires_tube_bend: boolean
  requires_saw: boolean
  requires_drill: boolean
  requires_weld: boolean
}

type MaterialRow = {
  id: string
  name: string
  material_type: 'tube' | 'sheet'
  material: string | null
  thickness: string | null
  tube_od: string | null
  tube_wall: string | null
  unit_weight_lbs: number | null
  stock_length_in: number | null
  scrap_rate: number | null
  qty_on_hand: number | null
}

type SkuSubAssemblyRow = {
  id: string
  qty: number
  sub_assembly_id: string
  sub_assembly_name: string
  image_file: string | null
  requires_weld: boolean | null
}

type SkuPartRow = {
  id: string
  qty: number
  part_id: string
  part_number: string
  part_description: string
  part_type: 'tube' | 'sheet' | null
  dxf_file: string | null
  weight_lbs: number | null
  material: string | null
  tube_od: string | null
  tube_wall: string | null
  tube_shape: string | null
  cut_length: number | null
}

type SubAssemblyPartRow = {
  id: string
  qty: number
  part_id: string
  part_number: string
  part_description: string
  part_type: 'tube' | 'sheet' | null
  dxf_file: string | null
  weight_lbs: number | null
  material: string | null
  tube_od: string | null
  tube_wall: string | null
  tube_shape: string | null
  cut_length: number | null
}

type ExplodedPreviewRow = {
  part_id: string
  part_number: string
  description: string
  qty: number
  part_type: 'tube' | 'sheet' | null
  dxf_file: string | null
  weight_lbs: number | null
  tube_od: string | null
  tube_wall: string | null
  tube_shape: string | null
  cut_length: number | null
}

type JoinedSubassemblyRow = {
  id: string | number
  qty: number | string
  sub_assembly_id: string | number
  sub_assembly?: { name?: string | null; image_file?: string | null; requires_weld?: boolean | null } | null
}

type JoinedSkuPartRow = {
  id: string | number
  qty: number | string
  part_id: string | number
  part?: {
    part_number?: string | null
    description?: string | null
    part_type?: string | null
    dxf_file?: string | null
    weight_lbs?: number | null
    material?: string | null
    tube_od?: string | null
    tube_wall?: string | null
    tube_shape?: string | null
    cut_length?: number | null
  } | null
}

type SourceRelationRow = {
  sub_assembly_id?: string | number | null
  part_id?: string | number | null
  qty: number | string
}

const CATEGORY_OPTIONS = ['Racks', 'Ladders', 'Accessories', 'Deflectors'] as const
type SkuCategory = (typeof CATEGORY_OPTIONS)[number]

const CATEGORY_STYLES: Record<string, { bg: string; border: string; text: string; pill: string }> = {
  Racks: {
    bg: 'rgba(37, 99, 235, 0.12)',
    border: 'rgba(37, 99, 235, 0.35)',
    text: '#bfdbfe',
    pill: 'rgba(37, 99, 235, 0.22)',
  },
  Ladders: {
    bg: 'rgba(22, 163, 74, 0.12)',
    border: 'rgba(22, 163, 74, 0.35)',
    text: '#bbf7d0',
    pill: 'rgba(22, 163, 74, 0.22)',
  },
  Accessories: {
    bg: 'rgba(168, 85, 247, 0.12)',
    border: 'rgba(168, 85, 247, 0.35)',
    text: '#e9d5ff',
    pill: 'rgba(168, 85, 247, 0.22)',
  },
  Deflectors: {
    bg: 'rgba(245, 158, 11, 0.12)',
    border: 'rgba(245, 158, 11, 0.35)',
    text: '#fde68a',
    pill: 'rgba(245, 158, 11, 0.22)',
  },
  Uncategorized: {
    bg: 'rgba(148, 163, 184, 0.12)',
    border: 'rgba(148, 163, 184, 0.35)',
    text: '#cbd5e1',
    pill: 'rgba(148, 163, 184, 0.2)',
  },
}

// Note: 'weld' is intentionally excluded — welding is tracked at the sub-assembly
// level (sub_assemblies.requires_weld), not on individual parts.
const STAGE_FIELDS = [
  { key: 'requires_laser',      label: 'Laser Cut' },
  { key: 'requires_sheet_bend', label: 'Sheet Bend' },
  { key: 'requires_tube_bend',  label: 'Tube Bend' },
  { key: 'requires_saw',        label: 'Saw' },
  { key: 'requires_drill',      label: 'Drill' },
] as const

const emptySkuForm = {
  id: '',
  description: '',
  category: 'Racks',
  notes: '',
  bolt_kit_cost: '',
  packaging_cost: '',
  labor_cost_per_unit: '',
}

const emptyPartForm = {
  id: '',
  part_number: '',
  description: '',
  part_type: 'sheet' as 'tube' | 'sheet',
  material_id: '',
  cut_length: '',
  dxf_file: '',
  weight_lbs: '',
  notes: '',
  requires_laser: false,
  requires_sheet_bend: false,
  requires_tube_bend: false,
  requires_saw: false,
  requires_drill: false,
  requires_weld: false,
}

const emptySubassemblyForm = {
  id: '',
  name: '',
  notes: '',
  requires_weld: false,
}

// ── Modal wrapper component ───────────────────────────────────────────────────

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(3px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: 28,
          width: '100%',
          maxWidth: 560,
          maxHeight: '90vh',
          overflowY: 'auto',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

// ── Page component ────────────────────────────────────────────────────────────

export default function SkusPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [skus, setSkus] = useState<SKU[]>([])
  const [subassemblies, setSubassemblies] = useState<SubAssembly[]>([])
  const [parts, setParts] = useState<Part[]>([])
  const [materials, setMaterials] = useState<MaterialRow[]>([])
  const [latestPriceByMaterialId, setLatestPriceByMaterialId] = useState<Record<string, number>>({})
  const [latestPowderCostPerLb, setLatestPowderCostPerLb]     = useState<number | null>(null)
  const [selectedSkuId, setSelectedSkuId] = useState(() =>
    typeof window !== 'undefined' ? (sessionStorage.getItem('garvin:selected_sku') ?? '') : ''
  )

  const [selectedSkuSubassemblies, setSelectedSkuSubassemblies] = useState<SkuSubAssemblyRow[]>([])
  const [selectedSkuParts, setSelectedSkuParts] = useState<SkuPartRow[]>([])
  const [subassemblyPartMap, setSubassemblyPartMap] = useState<Record<string, SubAssemblyPartRow[]>>({})
  const [expandedSubassemblyId, setExpandedSubassemblyId] = useState('')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [duplicateBusyId, setDuplicateBusyId] = useState('')
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [addingRelation, setAddingRelation] = useState(false)
  const [relationMessage, setRelationMessage] = useState('')
  const [builderMessage, setBuilderMessage] = useState('')
  const [builderSaving, setBuilderSaving] = useState(false)

  // Inline add controls (non-modal dropdowns/inputs for existing items)
  const [subassemblyIdToAdd, setSubassemblyIdToAdd] = useState('')
  const [subassemblyQtyToAdd, setSubassemblyQtyToAdd] = useState('1')
  const [subassemblyLookup, setSubassemblyLookup] = useState('')
  const [partIdToAdd, setPartIdToAdd] = useState('')
  const [partQtyToAdd, setPartQtyToAdd] = useState('1')
  const [partLookup, setPartLookup] = useState('')
  const [subassemblyPartLookup, setSubassemblyPartLookup] = useState<Record<string, string>>({})
  const [subassemblyDraftPartId, setSubassemblyDraftPartId] = useState<Record<string, string>>({})
  const [subassemblyDraftQty, setSubassemblyDraftQty] = useState<Record<string, string>>({})

  // 'sku' | sub_assembly_id — for PartPickerModal
  const [partPickerOpenFor, setPartPickerOpenFor] = useState<'sku' | string | null>(null)
  // SA picker
  const [saPickerOpen, setSaPickerOpen] = useState(false)

  // ── Modal state ───────────────────────────────────────────────────────────────

  // SKU modal
  const [skuModalOpen, setSkuModalOpen] = useState(false)
  const [skuModalIsEdit, setSkuModalIsEdit] = useState(false)
  const [skuForm, setSkuForm] = useState(emptySkuForm)

  // Part modal
  const [partModalOpen, setPartModalOpen] = useState(false)
  const [partModalIsEdit, setPartModalIsEdit] = useState(false)
  const [partModalEditId, setPartModalEditId] = useState<string | null>(null)
  const [partForm, setPartForm] = useState(emptyPartForm)
  // For create mode: attach target
  const [partAttachMode, setPartAttachMode] = useState<'sku' | 'subassembly'>('sku')
  const [partAttachSubassemblyId, setPartAttachSubassemblyId] = useState('')
  const [partAttachQty, setPartAttachQty] = useState('1')

  // Sub-assembly modal
  const [saModalOpen, setSaModalOpen] = useState(false)
  const [saModalIsEdit, setSaModalIsEdit] = useState(false)
  const [saModalEditId, setSaModalEditId] = useState<string | null>(null)
  const [saForm, setSaForm] = useState(emptySubassemblyForm)
  const [saAttachQty, setSaAttachQty] = useState('1')

  // ── Data loading ──────────────────────────────────────────────────────────────

  async function loadSkus() {
    const { data, error } = await supabase
      .from('skus')
      .select('*')
      .order('category', { ascending: true })
      .order('id', { ascending: true })

    if (error) {
      setMessage(`SKU load failed: ${error.message}`)
      setSkus([])
      return
    }

    const rows = (data ?? []) as SKU[]
    setSkus(rows)

    // Restore saved selection; fall back to first SKU only if nothing was saved
    const saved = typeof window !== 'undefined' ? sessionStorage.getItem('garvin:selected_sku') : null
    const restoredId = saved && rows.find((r) => r.id === saved) ? saved : (rows[0]?.id ?? '')
    if (restoredId) setSelectedSkuId(restoredId)
  }

  async function loadSubassemblies() {
    const { data, error } = await supabase
      .from('sub_assemblies')
      .select('id, name, notes, image_file, requires_weld')
      .order('id', { ascending: true })

    if (!error) {
      setSubassemblies((data ?? []) as SubAssembly[])
    }
  }

  async function loadParts() {
    const { data, error } = await supabase
      .from('parts')
      .select('id, part_number, description, part_type, material, thickness, tube_od, tube_wall, tube_shape, cut_length, dxf_file, notes, weight_lbs, requires_laser, requires_sheet_bend, requires_tube_bend, requires_saw, requires_drill, requires_weld')
      .order('part_number', { ascending: true })

    if (!error) {
      setParts((data ?? []) as Part[])
    }
  }

  async function loadMaterials() {
    const { data, error } = await supabase
      .from('materials')
      .select('id, name, material_type, material, thickness, tube_od, tube_wall, unit_weight_lbs, stock_length_in, scrap_rate, qty_on_hand')
      .order('name', { ascending: true })

    if (!error) {
      setMaterials((data ?? []) as MaterialRow[])
    }
  }

  async function loadPriceLogs() {
    const { data, error } = await supabase
      .from('material_price_logs')
      .select('material_id, price, date_purchased')
      .order('date_purchased', { ascending: true })

    if (!error && data) {
      const map: Record<string, number> = {}
      for (const row of data as { material_id: string; price: number; date_purchased: string }[]) {
        map[row.material_id] = row.price
      }
      setLatestPriceByMaterialId(map)
    }
  }

  async function loadSubassemblyParts(subassemblyId: string) {
    const { data, error } = await supabase
      .from('sub_assembly_parts')
      .select(`
        id,
        qty,
        part_id,
        part:parts (
          id,
          part_number,
          description,
          part_type,
          dxf_file,
          weight_lbs,
          material,
          tube_od,
          tube_wall,
          tube_shape,
          cut_length
        )
      `)
      .eq('sub_assembly_id', subassemblyId)
      .order('part_id', { ascending: true })

    if (error) {
      setRelationMessage(`Subassembly parts load failed: ${error.message}`)
      return [] as SubAssemblyPartRow[]
    }

    const rows: SubAssemblyPartRow[] = ((data ?? []) as JoinedSkuPartRow[]).map((row) => ({
      id: String(row.id),
      qty: Number(row.qty),
      part_id: String(row.part_id),
      part_number: row.part?.part_number ?? String(row.part_id),
      part_description: row.part?.description ?? '',
      part_type: (row.part?.part_type as 'tube' | 'sheet' | null) ?? null,
      dxf_file: row.part?.dxf_file ?? null,
      weight_lbs: row.part?.weight_lbs ?? null,
      material: row.part?.material ?? null,
      tube_od: row.part?.tube_od ?? null,
      tube_wall: row.part?.tube_wall ?? null,
      tube_shape: row.part?.tube_shape ?? null,
      cut_length: row.part?.cut_length ?? null,
    }))

    setSubassemblyPartMap((prev) => ({ ...prev, [subassemblyId]: rows }))
    return rows
  }

  async function loadSelectedSkuRelations(skuId: string) {
    if (!skuId) {
      setSelectedSkuSubassemblies([])
      setSelectedSkuParts([])
      setSubassemblyPartMap({})
      return
    }

    // Clear stale SA part data from the previous SKU immediately
    setSubassemblyPartMap({})

    const [{ data: subRows, error: subError }, { data: partRows, error: partError }] = await Promise.all([
      supabase
        .from('sku_sub_assemblies')
        .select(`
          id,
          qty,
          sub_assembly_id,
          sub_assembly:sub_assemblies (
            id,
            name,
            image_file,
            requires_weld
          )
        `)
        .eq('sku_id', skuId),
      supabase
        .from('sku_parts')
        .select(`
          id,
          qty,
          part_id,
          part:parts (
            id,
            part_number,
            description,
            part_type,
            dxf_file,
            weight_lbs,
            material,
            tube_od,
            tube_wall,
            tube_shape,
            cut_length
          )
        `)
        .eq('sku_id', skuId),
    ])

    if (subError) {
      setRelationMessage(`SKU subassemblies load failed: ${subError.message}`)
    } else {
      const mappedSubRows: SkuSubAssemblyRow[] = ((subRows ?? []) as JoinedSubassemblyRow[]).map((row) => ({
        id: String(row.id),
        qty: Number(row.qty),
        sub_assembly_id: String(row.sub_assembly_id),
        sub_assembly_name: row.sub_assembly?.name ?? '',
        image_file: row.sub_assembly?.image_file ?? null,
        requires_weld: row.sub_assembly?.requires_weld ?? null,
      }))
      setSelectedSkuSubassemblies(mappedSubRows)

      // Eagerly load every SA's parts so the BOM Explosion is complete without
      // needing to expand each sub-assembly manually first.
      if (mappedSubRows.length > 0) {
        await Promise.all(mappedSubRows.map((sa) => loadSubassemblyParts(sa.sub_assembly_id)))
      }
    }

    if (partError) {
      setRelationMessage(`SKU parts load failed: ${partError.message}`)
    } else {
      const mappedPartRows: SkuPartRow[] = ((partRows ?? []) as JoinedSkuPartRow[]).map((row) => ({
        id: String(row.id),
        qty: Number(row.qty),
        part_id: String(row.part_id),
        part_number: row.part?.part_number ?? String(row.part_id),
        part_description: row.part?.description ?? '',
        part_type: (row.part?.part_type as 'tube' | 'sheet' | null) ?? null,
        dxf_file: row.part?.dxf_file ?? null,
        weight_lbs: row.part?.weight_lbs ?? null,
        material: row.part?.material ?? null,
        tube_od: row.part?.tube_od ?? null,
        tube_wall: row.part?.tube_wall ?? null,
        tube_shape: row.part?.tube_shape ?? null,
        cut_length: row.part?.cut_length ?? null,
      }))
      setSelectedSkuParts(mappedPartRows)
    }
  }

  async function loadPowderRate() {
    const { data } = await supabase
      .from('powder_batches')
      .select('cost_per_lb')
      .eq('status', 'complete')
      .not('cost_per_lb', 'is', null)
      .order('returned_date', { ascending: false })
      .limit(1)
      .single()
    if (data && (data as any).cost_per_lb) {
      setLatestPowderCostPerLb((data as any).cost_per_lb as number)
    }
  }

  async function initialLoad() {
    setLoading(true)
    setMessage('')
    await Promise.all([loadSkus(), loadSubassemblies(), loadParts(), loadMaterials(), loadPriceLogs(), loadPowderRate()])
    setLoading(false)
  }

  useEffect(() => {
    void initialLoad()
  }, [])

  // Auto-select SKU from ?id= query param after data loads
  useEffect(() => {
    if (loading || skus.length === 0) return
    try {
      const params = new URLSearchParams(window.location.search)
      const idParam = params.get('id')
      if (!idParam) return
      const match = skus.find((s) => s.id === idParam)
      if (match) {
        setSelectedSkuId(match.id)
        setTimeout(() => {
          document.getElementById(`sku-row-${match.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 100)
      }
    } catch {
      // ignore
    }
  }, [loading, skus])

  useEffect(() => {
    if (selectedSkuId) {
      sessionStorage.setItem('garvin:selected_sku', selectedSkuId)
      void loadSelectedSkuRelations(selectedSkuId)
    }
  }, [selectedSkuId])

  useEffect(() => {
    if (!expandedSubassemblyId) return
    if (subassemblyPartMap[expandedSubassemblyId]) return
    void loadSubassemblyParts(expandedSubassemblyId)
  }, [expandedSubassemblyId, subassemblyPartMap])

  useEffect(() => {
    if (!selectedSkuSubassemblies.some((row) => row.sub_assembly_id === expandedSubassemblyId)) {
      setExpandedSubassemblyId(selectedSkuSubassemblies[0]?.sub_assembly_id ?? '')
    }
  }, [selectedSkuSubassemblies, expandedSubassemblyId])

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function getCategoryStyle(category: string | null | undefined) {
    return CATEGORY_STYLES[category || ''] || CATEGORY_STYLES.Uncategorized
  }

  function findPartByLookup(value: string) {
    const q = value.trim().toLowerCase()
    if (!q) return null
    return (
      parts.find(
        (part) =>
          part.id.toLowerCase() === q ||
          part.part_number.toLowerCase() === q ||
          `${part.part_number} — ${part.description}`.toLowerCase() === q ||
          part.description.toLowerCase() === q
      ) ?? null
    )
  }

  function findSubassemblyByLookup(value: string) {
    const q = value.trim().toLowerCase()
    if (!q) return null
    return (
      subassemblies.find(
        (sa) =>
          sa.id.toLowerCase() === q ||
          sa.name.toLowerCase() === q ||
          `${sa.id} — ${sa.name}`.toLowerCase() === q
      ) ?? null
    )
  }

  // ── Upsert helpers ────────────────────────────────────────────────────────────

  async function upsertSkuSubassembly(skuId: string, subassemblyId: string, qty: number) {
    const existing = selectedSkuSubassemblies.find((row) => row.sub_assembly_id === subassemblyId)
    if (existing) {
      return supabase
        .from('sku_sub_assemblies')
        .update({ qty: Number(existing.qty) + qty })
        .eq('id', existing.id)
    }
    return supabase.from('sku_sub_assemblies').insert({ sku_id: skuId, sub_assembly_id: subassemblyId, qty })
  }

  async function upsertSkuPart(skuId: string, partId: string, qty: number) {
    const existing = selectedSkuParts.find((row) => row.part_id === partId)
    if (existing) {
      return supabase
        .from('sku_parts')
        .update({ qty: Number(existing.qty) + qty })
        .eq('id', existing.id)
    }
    return supabase.from('sku_parts').insert({ sku_id: skuId, part_id: partId, qty })
  }

  async function upsertSubassemblyPart(subassemblyId: string, partId: string, qty: number) {
    const existing = (subassemblyPartMap[subassemblyId] ?? []).find((row) => row.part_id === partId)
    if (existing) {
      return supabase
        .from('sub_assembly_parts')
        .update({ qty: Number(existing.qty) + qty })
        .eq('id', existing.id)
    }
    return supabase.from('sub_assembly_parts').insert({ sub_assembly_id: subassemblyId, part_id: partId, qty })
  }

  // ── Relation actions ──────────────────────────────────────────────────────────

  async function handleAddSubassembly(e: React.FormEvent) {
    e.preventDefault()
    setAddingRelation(true)
    setRelationMessage('')

    if (!selectedSkuId) {
      setRelationMessage('Select a SKU first.')
      setAddingRelation(false)
      return
    }

    const matchedSubassembly = findSubassemblyByLookup(subassemblyLookup)
    const resolvedSubassemblyId = matchedSubassembly?.id || subassemblyIdToAdd

    if (!resolvedSubassemblyId) {
      setRelationMessage('Type or choose a valid subassembly.')
      setAddingRelation(false)
      return
    }

    const qty = Number(subassemblyQtyToAdd)
    if (!qty || qty <= 0) {
      setRelationMessage('Subassembly qty must be greater than 0.')
      setAddingRelation(false)
      return
    }

    const { error } = await upsertSkuSubassembly(selectedSkuId, resolvedSubassemblyId, qty)

    if (error) {
      setRelationMessage(`Add subassembly failed: ${error.message}`)
    } else {
      setRelationMessage('Subassembly added to SKU.')
      setExpandedSubassemblyId(resolvedSubassemblyId)
      setSubassemblyIdToAdd('')
      setSubassemblyLookup('')
      setSubassemblyQtyToAdd('1')
      await loadSelectedSkuRelations(selectedSkuId)
      await loadSubassemblyParts(resolvedSubassemblyId)
    }

    setAddingRelation(false)
  }

  async function handleAddPart(e: React.FormEvent) {
    e.preventDefault()
    setAddingRelation(true)
    setRelationMessage('')

    if (!selectedSkuId) {
      setRelationMessage('Select a SKU first.')
      setAddingRelation(false)
      return
    }

    const matchedPart = findPartByLookup(partLookup)
    const resolvedPartId = matchedPart?.id || partIdToAdd

    if (!resolvedPartId) {
      setRelationMessage('Type or choose a valid part.')
      setAddingRelation(false)
      return
    }

    const qty = Number(partQtyToAdd)
    if (!qty || qty <= 0) {
      setRelationMessage('Part qty must be greater than 0.')
      setAddingRelation(false)
      return
    }

    const { error } = await upsertSkuPart(selectedSkuId, resolvedPartId, qty)

    if (error) {
      setRelationMessage(`Add part failed: ${error.message}`)
    } else {
      setRelationMessage('Part added to SKU.')
      setPartIdToAdd('')
      setPartLookup('')
      setPartQtyToAdd('1')
      await loadSelectedSkuRelations(selectedSkuId)
    }

    setAddingRelation(false)
  }

  async function handleAddPartToAttachedSubassembly(subassemblyId: string) {
    setAddingRelation(true)
    setRelationMessage('')

    const lookupValue = subassemblyPartLookup[subassemblyId] || ''
    const matchedPart = findPartByLookup(lookupValue)
    const partId = matchedPart?.id || subassemblyDraftPartId[subassemblyId] || ''
    const qtyValue = subassemblyDraftQty[subassemblyId] || '1'
    const qty = Number(qtyValue)

    if (!partId) {
      setRelationMessage('Choose a part for the subassembly.')
      setAddingRelation(false)
      return
    }

    if (!qty || qty <= 0) {
      setRelationMessage('Subassembly part qty must be greater than 0.')
      setAddingRelation(false)
      return
    }

    const { error } = await upsertSubassemblyPart(subassemblyId, partId, qty)

    if (error) {
      setRelationMessage(`Add subassembly part failed: ${error.message}`)
    } else {
      setRelationMessage('Part added inside subassembly.')
      setSubassemblyDraftPartId((prev) => ({ ...prev, [subassemblyId]: '' }))
      setSubassemblyDraftQty((prev) => ({ ...prev, [subassemblyId]: '1' }))
      setSubassemblyPartLookup((prev) => ({ ...prev, [subassemblyId]: '' }))
      await loadSubassemblyParts(subassemblyId)
      await loadSelectedSkuRelations(selectedSkuId)
    }

    setAddingRelation(false)
  }

  /** Ctrl+click multi-select from PartPickerModal: add all selected parts to a sub-assembly (qty=1 each) */
  async function handleMultiAddPartsToSubassembly(subassemblyId: string, selectedParts: import('@/components/PartPickerModal').PickablePart[]) {
    setAddingRelation(true)
    setRelationMessage('')
    for (const part of selectedParts) {
      await upsertSubassemblyPart(subassemblyId, part.id, 1)
    }
    setRelationMessage(`${selectedParts.length} part${selectedParts.length !== 1 ? 's' : ''} added.`)
    await loadSubassemblyParts(subassemblyId)
    await loadSelectedSkuRelations(selectedSkuId)
    setAddingRelation(false)
  }

  /** Ctrl+click multi-select from PartPickerModal: add all selected parts directly to the SKU (qty=1 each) */
  async function handleMultiAddPartsToSku(selectedParts: import('@/components/PartPickerModal').PickablePart[]) {
    if (!selectedSkuId) return
    setAddingRelation(true)
    setRelationMessage('')
    for (const part of selectedParts) {
      await upsertSkuPart(selectedSkuId, part.id, 1)
    }
    setRelationMessage(`${selectedParts.length} part${selectedParts.length !== 1 ? 's' : ''} added.`)
    await loadSelectedSkuRelations(selectedSkuId)
    setAddingRelation(false)
  }

  async function handleUpdateSkuSubassemblyQty(rowId: string, qty: number) {
    if (!qty || qty <= 0) { setRelationMessage('Qty must be greater than 0.'); return }
    const { error } = await supabase.from('sku_sub_assemblies').update({ qty }).eq('id', rowId)
    if (error) {
      setRelationMessage(`Update qty failed: ${error.message}`)
    } else if (selectedSkuId) {
      setRelationMessage('Subassembly qty updated.')
      await loadSelectedSkuRelations(selectedSkuId)
    }
  }

  async function handleUpdateSkuPartQty(rowId: string, qty: number) {
    if (!qty || qty <= 0) { setRelationMessage('Qty must be greater than 0.'); return }
    const { error } = await supabase.from('sku_parts').update({ qty }).eq('id', rowId)
    if (error) {
      setRelationMessage(`Update qty failed: ${error.message}`)
    } else if (selectedSkuId) {
      setRelationMessage('Part qty updated.')
      await loadSelectedSkuRelations(selectedSkuId)
    }
  }

  async function handleUpdateSubassemblyPartQty(subassemblyId: string, rowId: string, qty: number) {
    if (!qty || qty <= 0) { setRelationMessage('Qty must be greater than 0.'); return }
    const { error } = await supabase.from('sub_assembly_parts').update({ qty }).eq('id', rowId)
    if (error) {
      setRelationMessage(`Update subassembly part qty failed: ${error.message}`)
    } else {
      setRelationMessage('Subassembly part qty updated.')
      await loadSubassemblyParts(subassemblyId)
      await loadSelectedSkuRelations(selectedSkuId)
    }
  }

  async function handleDeleteSkuSubassembly(rowId: string) {
    const { error } = await supabase.from('sku_sub_assemblies').delete().eq('id', rowId)
    if (error) {
      setRelationMessage(`Delete subassembly failed: ${error.message}`)
    } else if (selectedSkuId) {
      setRelationMessage('Subassembly removed.')
      await loadSelectedSkuRelations(selectedSkuId)
    }
  }

  async function handleDeleteSkuPart(rowId: string) {
    const { error } = await supabase.from('sku_parts').delete().eq('id', rowId)
    if (error) {
      setRelationMessage(`Delete part failed: ${error.message}`)
    } else if (selectedSkuId) {
      setRelationMessage('Part removed.')
      await loadSelectedSkuRelations(selectedSkuId)
    }
  }

  async function handleDeleteSubassemblyPart(subassemblyId: string, rowId: string) {
    const { error } = await supabase.from('sub_assembly_parts').delete().eq('id', rowId)
    if (error) {
      setRelationMessage(`Delete subassembly part failed: ${error.message}`)
    } else {
      setRelationMessage('Subassembly part removed.')
      await loadSubassemblyParts(subassemblyId)
      await loadSelectedSkuRelations(selectedSkuId)
    }
  }

  // ── SKU Modal ─────────────────────────────────────────────────────────────────

  function openSkuModalNew() {
    setSkuModalIsEdit(false)
    setSkuForm(emptySkuForm)
    setMessage('')
    setSkuModalOpen(true)
  }

  function openSkuModalEdit(sku: SKU) {
    setSkuModalIsEdit(true)
    setSkuForm({
      id: sku.id,
      description: sku.description,
      category: (CATEGORY_OPTIONS.includes((sku.category || '') as SkuCategory) ? sku.category : 'Racks') || 'Racks',
      notes: sku.notes || '',
      bolt_kit_cost: sku.bolt_kit_cost != null ? String(sku.bolt_kit_cost) : '',
      packaging_cost: sku.packaging_cost != null ? String(sku.packaging_cost) : '',
      labor_cost_per_unit: sku.labor_cost_per_unit != null ? String(sku.labor_cost_per_unit) : '',
    })
    setMessage('')
    setSkuModalOpen(true)
  }

  async function saveSkuModal() {
    setSaving(true)
    setMessage('')

    const payload = {
      id: skuForm.id.trim(),
      description: skuForm.description.trim(),
      category: skuForm.category.trim() || 'Racks',
      notes: skuForm.notes.trim() || null,
      active: true,
      bolt_kit_cost: skuForm.bolt_kit_cost.trim() ? parseFloat(skuForm.bolt_kit_cost) : null,
      packaging_cost: skuForm.packaging_cost.trim() ? parseFloat(skuForm.packaging_cost) : null,
      labor_cost_per_unit: skuForm.labor_cost_per_unit.trim() ? parseFloat(skuForm.labor_cost_per_unit) : null,
    }

    if (!payload.id || !payload.description) {
      setMessage('SKU and Description are required.')
      setSaving(false)
      return
    }

    const query = skuModalIsEdit
      ? supabase.from('skus').update(payload).eq('id', payload.id)
      : supabase.from('skus').insert(payload)

    const { error } = await query

    if (error) {
      setMessage(`${skuModalIsEdit ? 'Update' : 'Save'} failed: ${error.message}`)
    } else {
      setMessage(skuModalIsEdit ? 'SKU updated.' : 'SKU saved.')
      setSkuModalOpen(false)
      await loadSkus()
      setSelectedSkuId(payload.id)
    }

    setSaving(false)
  }

  async function handleDeleteSku() {
    const skuId = skuForm.id
    if (!skuId) return
    const ok = window.confirm(`Delete SKU ${skuId}?`)
    if (!ok) return

    const { error } = await supabase.from('skus').delete().eq('id', skuId)

    if (error) {
      setMessage(`Delete failed: ${error.message}`)
    } else {
      setMessage('SKU deleted.')
      setSelectedSkuId('')
      setSkuModalOpen(false)
      await loadSkus()
    }
  }

  // ── Part Modal ────────────────────────────────────────────────────────────────

  function openPartModalNew(defaultAttachMode: 'sku' | 'subassembly' = 'sku', defaultSubId = '') {
    setPartModalIsEdit(false)
    setPartModalEditId(null)
    setPartForm(emptyPartForm)
    setPartAttachMode(defaultAttachMode)
    setPartAttachSubassemblyId(defaultSubId)
    setPartAttachQty('1')
    setBuilderMessage('')
    setPartModalOpen(true)
  }

  function openPartModalEdit(part: Part) {
    setPartModalIsEdit(true)
    setPartModalEditId(part.id)
    setPartForm({
      id: part.id,
      part_number: part.part_number,
      description: part.description,
      part_type: part.part_type,
      material_id: '',
      cut_length: part.cut_length != null ? String(part.cut_length) : '',
      dxf_file: part.dxf_file || '',
      weight_lbs: part.weight_lbs != null ? String(part.weight_lbs) : '',
      notes: part.notes || '',
      requires_laser: part.requires_laser,
      requires_sheet_bend: part.requires_sheet_bend,
      requires_tube_bend: part.requires_tube_bend,
      requires_saw: part.requires_saw,
      requires_drill: part.requires_drill,
      requires_weld: part.requires_weld,
    })
    setBuilderMessage('')
    setPartModalOpen(true)
  }

  async function savePartModal() {
    setBuilderSaving(true)
    setBuilderMessage('')

    if (partModalIsEdit) {
      // Edit mode: update existing part
      const partId = partModalEditId
      if (!partId) {
        setBuilderMessage('No part ID found.')
        setBuilderSaving(false)
        return
      }

      const editMaterial = partForm.material_id
        ? materials.find((m) => m.id === partForm.material_id) ?? null
        : null

      // For tubes: auto-compute weight from cut_length × material; sheet: manual entry
      const editCutLength =
        partForm.part_type === 'tube' && partForm.cut_length.trim() !== ''
          ? Number(partForm.cut_length)
          : null
      const editWeight =
        partForm.part_type === 'tube'
          ? editMaterial?.unit_weight_lbs && editMaterial?.stock_length_in && editCutLength != null
            ? (editCutLength / editMaterial.stock_length_in) * editMaterial.unit_weight_lbs
            : null
          : partForm.weight_lbs.trim() !== ''
          ? Number(partForm.weight_lbs)
          : null

      const updatePayload: Record<string, unknown> = {
        part_number: partForm.part_number.trim(),
        description: partForm.description.trim(),
        part_type: partForm.part_type,
        cut_length: editCutLength,
        dxf_file: partForm.part_type === 'sheet' ? partForm.dxf_file.trim() || null : null,
        weight_lbs: editWeight,
        notes: partForm.notes.trim() || null,
        requires_laser: partForm.requires_laser,
        requires_sheet_bend: partForm.requires_sheet_bend,
        requires_tube_bend: partForm.requires_tube_bend,
        requires_saw: partForm.requires_saw,
        requires_drill: partForm.requires_drill,
        requires_weld: partForm.requires_weld,
      }

      if (!updatePayload.part_number || !updatePayload.description) {
        setBuilderMessage('Part number and description are required.')
        setBuilderSaving(false)
        return
      }

      // If a material was selected, update material fields too
      if (editMaterial) {
        updatePayload.material = editMaterial.material || null
        updatePayload.thickness = partForm.part_type === 'sheet' ? editMaterial.thickness || null : null
        updatePayload.tube_od = partForm.part_type === 'tube' ? editMaterial.tube_od || null : null
        updatePayload.tube_wall = partForm.part_type === 'tube' ? editMaterial.tube_wall || null : null
      }

      const { error } = await supabase.from('parts').update(updatePayload).eq('id', partId)

      if (error) {
        setBuilderMessage(`Update part failed: ${error.message}`)
        setBuilderSaving(false)
        return
      }

      await loadParts()
      setPartModalOpen(false)
      setBuilderSaving(false)
      return
    }

    // Create mode
    const selectedMaterial = materials.find((m) => m.id === partForm.material_id)

    if (!selectedMaterial) {
      setBuilderMessage('Choose a material from the library.')
      setBuilderSaving(false)
      return
    }

    const createCutLength =
      partForm.part_type === 'tube' && partForm.cut_length.trim() !== ''
        ? Number(partForm.cut_length)
        : null

    // Tubes: weight auto-calculated from cut_length × material density
    // Sheets: weight entered manually
    const createWeight =
      partForm.part_type === 'tube'
        ? selectedMaterial.unit_weight_lbs && selectedMaterial.stock_length_in && createCutLength != null
          ? (createCutLength / selectedMaterial.stock_length_in) * selectedMaterial.unit_weight_lbs
          : null
        : partForm.weight_lbs.trim() !== ''
        ? Number(partForm.weight_lbs)
        : null

    const payload = {
      id: partForm.id.trim(),
      part_number: partForm.part_number.trim(),
      description: partForm.description.trim(),
      part_type: partForm.part_type,
      material: selectedMaterial.material || null,
      thickness: partForm.part_type === 'sheet' ? selectedMaterial.thickness || null : null,
      tube_od: partForm.part_type === 'tube' ? selectedMaterial.tube_od || null : null,
      tube_wall: partForm.part_type === 'tube' ? selectedMaterial.tube_wall || null : null,
      cut_length: createCutLength,
      dxf_file: partForm.part_type === 'sheet' ? partForm.dxf_file.trim() || null : null,
      weight_lbs: createWeight,
      notes: partForm.notes.trim() || null,
      requires_laser: partForm.requires_laser,
      requires_sheet_bend: partForm.requires_sheet_bend,
      requires_tube_bend: partForm.requires_tube_bend,
      requires_saw: partForm.requires_saw,
      requires_drill: partForm.requires_drill,
      requires_weld: partForm.requires_weld,
    }

    if (!payload.id || !payload.part_number || !payload.description) {
      setBuilderMessage('Part ID, part number, and description are required.')
      setBuilderSaving(false)
      return
    }

    if (payload.part_type === 'tube' && payload.cut_length !== null && Number.isNaN(payload.cut_length)) {
      setBuilderMessage('Cut length must be a valid number.')
      setBuilderSaving(false)
      return
    }

    const { error } = await supabase.from('parts').insert(payload)

    if (error) {
      setBuilderMessage(`Create part failed: ${error.message}`)
      setBuilderSaving(false)
      return
    }

    await loadParts()

    const attachQty = Number(partAttachQty || '1')
    if (!attachQty || attachQty <= 0) {
      setBuilderMessage('Part created. Set a valid attach qty to auto-add it.')
      setBuilderSaving(false)
      return
    }

    if (partAttachMode === 'sku') {
      if (!selectedSkuId) {
        setBuilderMessage('Part created, but no SKU is selected to attach it.')
        setBuilderSaving(false)
        return
      }
      const attachResult = await upsertSkuPart(selectedSkuId, payload.id, attachQty)
      if (attachResult.error) {
        setBuilderMessage(`Part created, but attaching to SKU failed: ${attachResult.error.message}`)
        setBuilderSaving(false)
        return
      }
      await loadSelectedSkuRelations(selectedSkuId)
      setBuilderMessage('Part created and added to the SKU BOM.')
    } else {
      const targetSubassemblyId = partAttachSubassemblyId
      if (!targetSubassemblyId) {
        setBuilderMessage('Part created, but no subassembly target was selected.')
        setBuilderSaving(false)
        return
      }
      const attachResult = await upsertSubassemblyPart(targetSubassemblyId, payload.id, attachQty)
      if (attachResult.error) {
        setBuilderMessage(`Part created, but attaching to subassembly failed: ${attachResult.error.message}`)
        setBuilderSaving(false)
        return
      }
      await loadSubassemblyParts(targetSubassemblyId)
      await loadSelectedSkuRelations(selectedSkuId)
      setExpandedSubassemblyId(targetSubassemblyId)
      setBuilderMessage('Part created and added inside the subassembly.')
    }

    setPartModalOpen(false)
    setBuilderSaving(false)
  }

  // ── Sub-assembly Modal ────────────────────────────────────────────────────────

  function openSaModalNew() {
    setSaModalIsEdit(false)
    setSaModalEditId(null)
    setSaForm(emptySubassemblyForm)
    setSaAttachQty('1')
    setBuilderMessage('')
    setSaModalOpen(true)
  }

  function openSaModalEdit(sa: SubAssembly) {
    setSaModalIsEdit(true)
    setSaModalEditId(sa.id)
    setSaForm({
      id: sa.id,
      name: sa.name,
      notes: sa.notes || '',
      requires_weld: sa.requires_weld ?? false,
    })
    setBuilderMessage('')
    setSaModalOpen(true)
  }

  async function saveSaModal() {
    setBuilderSaving(true)
    setBuilderMessage('')

    if (saModalIsEdit) {
      const saId = saModalEditId
      if (!saId) {
        setBuilderMessage('No sub-assembly ID found.')
        setBuilderSaving(false)
        return
      }

      const updatePayload = {
        name: saForm.name.trim(),
        notes: saForm.notes.trim() || null,
        requires_weld: saForm.requires_weld,
      }

      if (!updatePayload.name) {
        setBuilderMessage('Name is required.')
        setBuilderSaving(false)
        return
      }

      const { error } = await supabase.from('sub_assemblies').update(updatePayload).eq('id', saId)

      if (error) {
        setBuilderMessage(`Update failed: ${error.message}`)
        setBuilderSaving(false)
        return
      }

      await loadSubassemblies()
      await loadSelectedSkuRelations(selectedSkuId)
      setSaModalOpen(false)
      setBuilderSaving(false)
      return
    }

    // Create mode
    const payload = {
      id: saForm.id.trim(),
      name: saForm.name.trim(),
      notes: saForm.notes.trim() || null,
      requires_weld: saForm.requires_weld,
    }

    if (!payload.id || !payload.name) {
      setBuilderMessage('Subassembly ID and name are required.')
      setBuilderSaving(false)
      return
    }

    const { error } = await supabase.from('sub_assemblies').insert(payload)

    if (error) {
      setBuilderMessage(`Create subassembly failed: ${error.message}`)
      setBuilderSaving(false)
      return
    }

    await loadSubassemblies()

    const qty = Number(saAttachQty || '1')
    if (!selectedSkuId) {
      setBuilderMessage('Subassembly created, but no SKU is selected to attach it.')
      setBuilderSaving(false)
      return
    }

    if (!qty || qty <= 0) {
      setBuilderMessage('Subassembly created. Set a valid attach qty to auto-add it.')
      setBuilderSaving(false)
      return
    }

    const attachResult = await upsertSkuSubassembly(selectedSkuId, payload.id, qty)
    if (attachResult.error) {
      setBuilderMessage(`Subassembly created, but attaching to SKU failed: ${attachResult.error.message}`)
      setBuilderSaving(false)
      return
    }

    await loadSelectedSkuRelations(selectedSkuId)
    setExpandedSubassemblyId(payload.id)
    setSaModalOpen(false)
    setBuilderMessage('Subassembly created and added to the SKU BOM.')
    setBuilderSaving(false)
  }

  // ── Duplicate SKU ─────────────────────────────────────────────────────────────

  async function duplicateSkuWithBom(sku: SKU) {
    const newSkuId = window.prompt(`New SKU ID for duplicate of ${sku.id}`, `${sku.id}-COPY`)
    if (!newSkuId) return

    const trimmedId = newSkuId.trim()
    if (!trimmedId) return

    const newDescription =
      window.prompt('New SKU description', `${sku.description} Copy`)?.trim() || `${sku.description} Copy`

    setDuplicateBusyId(sku.id)
    setMessage('')

    const skuPayload = {
      id: trimmedId,
      description: newDescription,
      category: sku.category || 'Racks',
      notes: sku.notes || null,
      active: sku.active,
    }

    const insertSkuResult = await supabase.from('skus').insert(skuPayload)
    if (insertSkuResult.error) {
      setMessage(`Duplicate failed: ${insertSkuResult.error.message}`)
      setDuplicateBusyId('')
      return
    }

    const [
      { data: sourceSkuSubassemblies, error: sourceSkuSubassembliesError },
      { data: sourceSkuParts, error: sourceSkuPartsError },
    ] = await Promise.all([
      supabase.from('sku_sub_assemblies').select('sub_assembly_id, qty').eq('sku_id', sku.id),
      supabase.from('sku_parts').select('part_id, qty').eq('sku_id', sku.id),
    ])

    if (sourceSkuSubassembliesError || sourceSkuPartsError) {
      await supabase.from('skus').delete().eq('id', trimmedId)
      setMessage(
        `Duplicate failed while reading BOM: ${sourceSkuSubassembliesError?.message || sourceSkuPartsError?.message}`
      )
      setDuplicateBusyId('')
      return
    }

    const subassemblyInserts = ((sourceSkuSubassemblies ?? []) as SourceRelationRow[]).map((row) => ({
      sku_id: trimmedId,
      sub_assembly_id: String(row.sub_assembly_id),
      qty: Number(row.qty),
    }))

    const partInserts = ((sourceSkuParts ?? []) as SourceRelationRow[]).map((row) => ({
      sku_id: trimmedId,
      part_id: String(row.part_id),
      qty: Number(row.qty),
    }))

    if (subassemblyInserts.length > 0) {
      const subInsertResult = await supabase.from('sku_sub_assemblies').insert(subassemblyInserts)
      if (subInsertResult.error) {
        await supabase.from('sku_sub_assemblies').delete().eq('sku_id', trimmedId)
        await supabase.from('sku_parts').delete().eq('sku_id', trimmedId)
        await supabase.from('skus').delete().eq('id', trimmedId)
        setMessage(`Duplicate failed while copying subassemblies: ${subInsertResult.error.message}`)
        setDuplicateBusyId('')
        return
      }
    }

    if (partInserts.length > 0) {
      const partInsertResult = await supabase.from('sku_parts').insert(partInserts)
      if (partInsertResult.error) {
        await supabase.from('sku_sub_assemblies').delete().eq('sku_id', trimmedId)
        await supabase.from('sku_parts').delete().eq('sku_id', trimmedId)
        await supabase.from('skus').delete().eq('id', trimmedId)
        setMessage(`Duplicate failed while copying direct parts: ${partInsertResult.error.message}`)
        setDuplicateBusyId('')
        return
      }
    }

    await loadSkus()
    setSelectedSkuId(trimmedId)
    setMessage(`SKU ${trimmedId} created with full BOM copied from ${sku.id}.`)
    setDuplicateBusyId('')
  }

  // ── Computed values ───────────────────────────────────────────────────────────

  const filteredSkus = skus.filter((sku) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return `${sku.id} ${sku.description} ${sku.category || ''} ${sku.notes || ''}`.toLowerCase().includes(q)
  })

  const groupedFilteredSkus = useMemo(() => {
    const groups: Record<string, SKU[]> = {
      Racks: [],
      Ladders: [],
      Accessories: [],
      Deflectors: [],
      Uncategorized: [],
    }
    for (const sku of filteredSkus) {
      const key = CATEGORY_OPTIONS.includes((sku.category || '') as SkuCategory)
        ? (sku.category as string)
        : 'Uncategorized'
      groups[key].push(sku)
    }
    return groups
  }, [filteredSkus])

  const fullExplosion = useMemo<ExplodedPreviewRow[]>(() => {
    const totals = new Map<string, ExplodedPreviewRow>()

    for (const row of selectedSkuParts) {
      const existing = totals.get(row.part_id)
      if (existing) {
        existing.qty += Number(row.qty)
      } else {
        totals.set(row.part_id, {
          part_id: row.part_id,
          part_number: row.part_number,
          description: row.part_description,
          qty: Number(row.qty),
          part_type: row.part_type,
          dxf_file: row.dxf_file,
          weight_lbs: row.weight_lbs,
          tube_od: row.tube_od,
          tube_wall: row.tube_wall,
          tube_shape: row.tube_shape,
          cut_length: row.cut_length,
        })
      }
    }

    for (const sa of selectedSkuSubassemblies) {
      const subParts = subassemblyPartMap[sa.sub_assembly_id] ?? []
      for (const subPart of subParts) {
        const multipliedQty = Number(subPart.qty) * Number(sa.qty)
        const existing = totals.get(subPart.part_id)
        if (existing) {
          existing.qty += multipliedQty
        } else {
          totals.set(subPart.part_id, {
            part_id: subPart.part_id,
            part_number: subPart.part_number,
            description: subPart.part_description,
            qty: multipliedQty,
            part_type: subPart.part_type,
            dxf_file: subPart.dxf_file,
            weight_lbs: subPart.weight_lbs,
            tube_od: subPart.tube_od,
            tube_wall: subPart.tube_wall,
            tube_shape: subPart.tube_shape,
            cut_length: subPart.cut_length,
          })
        }
      }
    }

    return Array.from(totals.values()).sort((a, b) =>
      a.part_number.localeCompare(b.part_number, undefined, { numeric: true })
    )
  }, [selectedSkuParts, selectedSkuSubassemblies, subassemblyPartMap])

  const selectedSku = skus.find((sku) => sku.id === selectedSkuId) || null

  function findMaterialForPart(part: Part): MaterialRow | null {
    return (
      materials.find((m) => {
        if (m.material_type !== part.part_type) return false
        if (part.part_type === 'sheet') {
          return m.material === part.material && m.thickness === part.thickness
        }
        return m.material === part.material && m.tube_od === part.tube_od && m.tube_wall === part.tube_wall
      }) ?? null
    )
  }

  function calcPartLineCost(partId: string, qty: number): number | null {
    const part = parts.find((p) => p.id === partId)
    if (!part) return null
    const mat = findMaterialForPart(part)
    if (!mat) return null
    const latestPrice = latestPriceByMaterialId[mat.id]
    if (!latestPrice) return null

    if (part.part_type === 'tube') {
      // Length-based: cost = qty × (cut_length / stock_length_in) × price_per_bar
      // This works regardless of how unit_weight_lbs is entered (per bar vs per foot)
      if (!part.cut_length || !mat.stock_length_in) return null
      return qty * (part.cut_length / mat.stock_length_in) * latestPrice
    }

    // Sheet: weight-based with scrap rate.
    // Divide by (1 - scrap) rather than multiply by (1 + scrap): if 16% of the sheet
    // is wasted, you need to purchase 1/0.84 = 1.190× the net weight, not 1.16×.
    if (!part.weight_lbs || !mat.unit_weight_lbs) return null
    const costPerLb = latestPrice / mat.unit_weight_lbs
    const scrap = Math.min(mat.scrap_rate ?? 0, 0.99)
    return qty * part.weight_lbs * costPerLb / (1 - scrap)
  }

  const matEstCost: number | null = (() => {
    if (!selectedSkuId) return null
    let total = 0
    let hasAny = false
    for (const row of selectedSkuParts) {
      const c = calcPartLineCost(row.part_id, row.qty)
      if (c != null) { total += c; hasAny = true }
    }
    for (const subRow of selectedSkuSubassemblies) {
      const subParts = subassemblyPartMap[subRow.sub_assembly_id] ?? []
      for (const sp of subParts) {
        const c = calcPartLineCost(sp.part_id, sp.qty * subRow.qty)
        if (c != null) { total += c; hasAny = true }
      }
    }
    return hasAny ? total : null
  })()

  // Powder coat cost estimate: SKU total weight × latest cost/lb from powder runs
  const skuTotalWeight = fullExplosion.reduce(
    (sum, r) => r.weight_lbs != null ? sum + r.weight_lbs * r.qty : sum, 0
  )
  const powderEstCost = latestPowderCostPerLb != null && skuTotalWeight > 0
    ? skuTotalWeight * latestPowderCostPerLb
    : null

  const totalUnitCost = (() => {
    if (!selectedSku) return null
    let total = matEstCost ?? 0
    if (powderEstCost) total += powderEstCost
    if (selectedSku.bolt_kit_cost) total += selectedSku.bolt_kit_cost
    if (selectedSku.packaging_cost) total += selectedSku.packaging_cost
    if (selectedSku.labor_cost_per_unit) total += selectedSku.labor_cost_per_unit
    if (!matEstCost && !powderEstCost && !selectedSku.bolt_kit_cost && !selectedSku.packaging_cost && !selectedSku.labor_cost_per_unit) return null
    return total
  })()

  const selectedMaterialsFiltered = materials.filter((m) => m.material_type === partForm.part_type)

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="section-stack">
        <div className="page-header">
          <div>
            <div className="kicker">Garvin Internal Tool</div>
            <h1 className="page-title">SKUs</h1>
            <div className="page-subtitle">Search, select, and build full SKU BOMs from one page.</div>
          </div>
        </div>

        {message && <div className="message">{message}</div>}

        {/* Two-panel layout */}
        <div
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'flex-start',
          }}
        >
          {/* ── Left Panel: SKU List ────────────────────────────────────────────── */}
          <div
            style={{
              minWidth: 280,
              maxWidth: 380,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {/* Search + New SKU */}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="field"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKUs..."
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                type="button"
                className="btn btn-primary"
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                onClick={openSkuModalNew}
              >
                ＋ New SKU
              </button>
            </div>

            {/* SKU list grouped by category */}
            <div
              className="card"
              style={{ padding: 0, overflow: 'hidden' }}
            >
              {loading ? (
                <div className="empty" style={{ padding: 20 }}>Loading...</div>
              ) : filteredSkus.length === 0 ? (
                <div className="empty" style={{ padding: 20 }}>No matching SKUs.</div>
              ) : (
                <div style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }}>
                  {Object.entries(groupedFilteredSkus).map(([category, categorySkus]) => {
                    if (categorySkus.length === 0) return null
                    const style = getCategoryStyle(category)
                    const isCollapsed = collapsedCategories.has(category)
                    return (
                      <div key={category}>
                        <button
                          type="button"
                          style={{
                            width: '100%',
                            padding: '6px 12px',
                            fontSize: '0.72rem',
                            fontWeight: 800,
                            textTransform: 'uppercase',
                            letterSpacing: '0.08em',
                            color: style.text,
                            background: style.bg,
                            border: 'none',
                            borderBottom: `1px solid ${style.border}`,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            cursor: 'pointer',
                          }}
                          onClick={() => {
                            setCollapsedCategories((prev) => {
                              const next = new Set(prev)
                              if (next.has(category)) next.delete(category)
                              else next.add(category)
                              return next
                            })
                          }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: '0.65rem', opacity: 0.8 }}>{isCollapsed ? '▸' : '▾'}</span>
                            {category}
                          </span>
                          <span
                            style={{
                              background: style.pill,
                              border: `1px solid ${style.border}`,
                              borderRadius: 999,
                              padding: '1px 7px',
                              fontSize: '0.7rem',
                            }}
                          >
                            {categorySkus.length}
                          </span>
                        </button>
                        {!isCollapsed && categorySkus.map((sku) => {
                          const isSelected = selectedSkuId === sku.id
                          return (
                            <div
                              key={sku.id}
                              id={`sku-row-${sku.id}`}
                              style={{
                                padding: '9px 12px',
                                cursor: 'pointer',
                                borderBottom: '1px solid var(--border)',
                                background: isSelected ? 'var(--accent-soft)' : 'transparent',
                                borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
                                transition: 'background 0.1s',
                              }}
                              onClick={() => setSelectedSkuId(sku.id)}
                              onMouseEnter={(e) => {
                                if (!isSelected) e.currentTarget.style.background = 'var(--panel-2)'
                              }}
                              onMouseLeave={(e) => {
                                if (!isSelected) e.currentTarget.style.background = 'transparent'
                              }}
                            >
                              <div
                                style={{
                                  fontWeight: 700,
                                  fontSize: '0.88rem',
                                  color: isSelected ? 'var(--accent-text)' : 'var(--text)',
                                }}
                              >
                                {sku.id}
                              </div>
                              <div
                                style={{
                                  fontSize: '0.78rem',
                                  color: 'var(--muted)',
                                  marginTop: 1,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {sku.description}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ── Right Panel: BOM Detail ─────────────────────────────────────────── */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {!selectedSku ? (
              <div className="card">
                <div className="card-body">
                  <div className="empty">Select a SKU to view and edit its BOM.</div>
                </div>
              </div>
            ) : (
              <div className="section-stack">
                {/* SKU header */}
                <div className="card">
                  <div className="card-body">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div>
                        <div className="group-title" style={{ marginBottom: 2 }}>{selectedSku.id}</div>
                        <div style={{ color: 'var(--text-2)', fontSize: '0.95rem', marginBottom: 6 }}>
                          {selectedSku.description}
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '3px 10px',
                              borderRadius: 999,
                              fontSize: '0.75rem',
                              fontWeight: 700,
                              background: getCategoryStyle(selectedSku.category).pill,
                              border: `1px solid ${getCategoryStyle(selectedSku.category).border}`,
                              color: getCategoryStyle(selectedSku.category).text,
                            }}
                          >
                            {selectedSku.category || 'Uncategorized'}
                          </span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: '0.82rem' }}
                          onClick={() => openSkuModalEdit(selectedSku)}
                        >
                          ✏ Edit SKU
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: '0.82rem' }}
                          onClick={() => void duplicateSkuWithBom(selectedSku)}
                          disabled={duplicateBusyId === selectedSku.id}
                        >
                          {duplicateBusyId === selectedSku.id ? 'Duplicating...' : 'Duplicate'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {(relationMessage || builderMessage) && (
                  <div className="message">{relationMessage || builderMessage}</div>
                )}

                {/* ── Sub-Assemblies Section ── */}
                <section className="card">
                  <div className="card-header">
                    <h3 className="card-title">Sub-Assemblies</h3>
                  </div>
                  <div className="card-body">
                    {/* Add existing subassembly */}
                    <form onSubmit={handleAddSubassembly}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) 100px auto auto',
                          gap: 10,
                          alignItems: 'end',
                          marginBottom: 10,
                        }}
                      >
                        <div>
                          <label className="label" style={{ fontSize: '0.78rem' }}>Add Existing Sub-assembly</label>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input
                              className="field"
                              list="subassembly-list"
                              value={subassemblyLookup}
                              onChange={(e) => {
                                const value = e.target.value
                                setSubassemblyLookup(value)
                                const match = findSubassemblyByLookup(value)
                                setSubassemblyIdToAdd(match?.id || '')
                              }}
                              placeholder="Type or browse…"
                              style={{ flex: 1 }}
                            />
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                              onClick={() => setSaPickerOpen(true)}
                            >
                              🔍 Browse
                            </button>
                          </div>
                          <datalist id="subassembly-list">
                            {subassemblies.map((sa) => (
                              <option key={sa.id} value={sa.id}>{sa.name}</option>
                            ))}
                          </datalist>
                        </div>
                        <div>
                          <label className="label" style={{ fontSize: '0.78rem' }}>Qty</label>
                          <input
                            className="field"
                            value={subassemblyQtyToAdd}
                            onChange={(e) => setSubassemblyQtyToAdd(e.target.value)}
                            placeholder="1"
                          />
                        </div>
                        <button type="submit" disabled={addingRelation} className="btn btn-primary" style={{ fontSize: '0.82rem' }}>
                          ＋ Add
                        </button>
                      </div>
                    </form>

                    <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                      <button type="button" className="btn btn-secondary" style={{ fontSize: '0.82rem' }} onClick={openSaModalNew}>
                        ＋ New Sub-assembly
                      </button>
                    </div>

                    {selectedSkuSubassemblies.length === 0 ? (
                      <div className="empty">No sub-assemblies attached yet.</div>
                    ) : (
                      <div className="section-stack" style={{ gap: 10 }}>
                        {selectedSkuSubassemblies.map((row) => {
                          const isExpanded = expandedSubassemblyId === row.sub_assembly_id
                          const subRows = subassemblyPartMap[row.sub_assembly_id] ?? []
                          const fullSa = subassemblies.find((s) => s.id === row.sub_assembly_id)

                          return (
                            <div
                              key={row.id}
                              style={{
                                border: '1px solid var(--border)',
                                borderRadius: 10,
                                background: 'rgba(255,255,255,0.02)',
                              }}
                            >
                              {/* Sub-assembly header row */}
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                  padding: '10px 14px',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <button
                                  type="button"
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    color: 'var(--muted)',
                                    padding: 0,
                                    fontSize: '1rem',
                                    lineHeight: 1,
                                  }}
                                  onClick={() => {
                                    setExpandedSubassemblyId(isExpanded ? '' : row.sub_assembly_id)
                                    if (!subassemblyPartMap[row.sub_assembly_id]) {
                                      void loadSubassemblyParts(row.sub_assembly_id)
                                    }
                                  }}
                                >
                                  {isExpanded ? '▾' : '▸'}
                                </button>

                                {/* Sub-assembly thumbnail if available */}
                                {row.image_file && (
                                  <img
                                    src={supabase.storage.from(SUB_IMAGE_BUCKET).getPublicUrl(row.image_file).data.publicUrl}
                                    alt={row.sub_assembly_name}
                                    style={{
                                      width: 40,
                                      height: 40,
                                      objectFit: 'cover',
                                      borderRadius: 6,
                                      border: '1px solid var(--border)',
                                      flexShrink: 0,
                                    }}
                                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                  />
                                )}

                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                                    {row.sub_assembly_name || row.sub_assembly_id}
                                  </div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                                    {row.sub_assembly_id}
                                  </div>
                                </div>

                                <span style={{ fontSize: '0.82rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                                  ×{row.qty}
                                </span>

                                {(row.requires_weld || fullSa?.requires_weld) && (
                                  <span
                                    style={{
                                      fontSize: '0.7rem',
                                      fontWeight: 700,
                                      background: 'rgba(245,158,11,0.15)',
                                      border: '1px solid rgba(245,158,11,0.35)',
                                      color: '#fde68a',
                                      borderRadius: 4,
                                      padding: '2px 6px',
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    🔧 requires weld
                                  </span>
                                )}

                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  style={{ fontSize: '0.75rem', padding: '4px 8px' }}
                                  onClick={() => openSaModalEdit(fullSa ?? { id: row.sub_assembly_id, name: row.sub_assembly_name, requires_weld: row.requires_weld })}
                                >
                                  ✏
                                </button>

                                <button
                                  type="button"
                                  className="btn btn-danger"
                                  style={{ fontSize: '0.75rem', padding: '4px 8px' }}
                                  onClick={() => void handleDeleteSkuSubassembly(row.id)}
                                >
                                  ✕
                                </button>
                              </div>

                              {/* Expanded: sub-assembly parts */}
                              {isExpanded && (
                                <div
                                  style={{
                                    borderTop: '1px solid var(--border)',
                                    padding: '12px 14px',
                                    background: 'rgba(255,255,255,0.02)',
                                  }}
                                >
                                  {/* Add part to sub-assembly */}
                                  <div
                                    style={{
                                      display: 'grid',
                                      gridTemplateColumns: 'minmax(0, 1fr) 80px auto auto',
                                      gap: 8,
                                      alignItems: 'end',
                                      marginBottom: 10,
                                    }}
                                  >
                                    <div>
                                      <label className="label" style={{ fontSize: '0.75rem' }}>Add Part</label>
                                      <div style={{ display: 'flex', gap: 6 }}>
                                        <input
                                          className="field"
                                          list={`subassembly-parts-list-${row.sub_assembly_id}`}
                                          value={subassemblyPartLookup[row.sub_assembly_id] || ''}
                                          onChange={(e) => {
                                            const value = e.target.value
                                            setSubassemblyPartLookup((prev) => ({ ...prev, [row.sub_assembly_id]: value }))
                                            const match = findPartByLookup(value)
                                            setSubassemblyDraftPartId((prev) => ({ ...prev, [row.sub_assembly_id]: match?.id || '' }))
                                          }}
                                          placeholder="Part number or desc"
                                          style={{ flex: 1, minWidth: 0 }}
                                        />
                                        <datalist id={`subassembly-parts-list-${row.sub_assembly_id}`}>
                                          {parts.map((part) => (
                                            <option key={part.id} value={part.part_number}>{part.description}</option>
                                          ))}
                                        </datalist>
                                        <button
                                          type="button"
                                          className="btn btn-secondary"
                                          style={{ whiteSpace: 'nowrap', fontSize: '0.75rem' }}
                                          onClick={() => setPartPickerOpenFor(row.sub_assembly_id)}
                                        >
                                          Browse
                                        </button>
                                      </div>
                                    </div>
                                    <div>
                                      <label className="label" style={{ fontSize: '0.75rem' }}>Qty</label>
                                      <input
                                        className="field"
                                        value={subassemblyDraftQty[row.sub_assembly_id] || '1'}
                                        onChange={(e) =>
                                          setSubassemblyDraftQty((prev) => ({ ...prev, [row.sub_assembly_id]: e.target.value }))
                                        }
                                      />
                                    </div>
                                    <button
                                      type="button"
                                      className="btn btn-primary"
                                      style={{ fontSize: '0.75rem' }}
                                      onClick={() => void handleAddPartToAttachedSubassembly(row.sub_assembly_id)}
                                    >
                                      ＋ Add
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-secondary"
                                      style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                                      onClick={() => openPartModalNew('subassembly', row.sub_assembly_id)}
                                    >
                                      ＋ New Part
                                    </button>
                                  </div>

                                  {subRows.length === 0 ? (
                                    <div className="empty">No parts inside this sub-assembly yet.</div>
                                  ) : (
                                    <div className="table-wrap">
                                      <table className="table">
                                        <thead>
                                          <tr>
                                            <th></th>
                                            <th>Part #</th>
                                            <th>Description</th>
                                            <th>Qty</th>
                                            <th></th>
                                            <th></th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {subRows.map((subRow) => {
                                            const fullPart = parts.find((p) => p.id === subRow.part_id)
                                            return (
                                              <tr key={subRow.id}>
                                                <td style={{ width: 36, padding: '4px 6px' }}>
                                                  <DxfPartPreview
                                                    dxfFile={subRow.dxf_file}
                                                    partNumber={subRow.part_number}
                                                    size="tiny"
                                                    isTube={subRow.part_type === 'tube'}
                                                    tubeFallback={true}
                                                    tubeOd={subRow.tube_od ?? undefined}
                                                    tubeWall={subRow.tube_wall ?? undefined}
                                                    cutLength={subRow.cut_length ?? undefined}
                                                    tubeShape={subRow.tube_shape === 'square' || (subRow.tube_od ?? '').toLowerCase().includes('x') || (subRow.material ?? '').toLowerCase().startsWith('square') ? 'square' : 'round'}
                                                  />
                                                </td>
                                                <td style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '0.83rem' }}>
                                                  {subRow.part_number}
                                                </td>
                                                <td style={{ fontSize: '0.83rem', color: 'var(--text-2)' }}>
                                                  {subRow.part_description}
                                                </td>
                                                <td>
                                                  <input
                                                    className="field-sm"
                                                    defaultValue={subRow.qty}
                                                    onBlur={(e) =>
                                                      void handleUpdateSubassemblyPartQty(
                                                        row.sub_assembly_id,
                                                        subRow.id,
                                                        Number(e.target.value)
                                                      )
                                                    }
                                                    style={{ width: 52 }}
                                                  />
                                                </td>
                                                <td>
                                                  <button
                                                    type="button"
                                                    className="btn btn-secondary"
                                                    style={{ fontSize: '0.72rem', padding: '3px 7px' }}
                                                    onClick={() => { if (fullPart) openPartModalEdit(fullPart) }}
                                                  >
                                                    ✏
                                                  </button>
                                                </td>
                                                <td>
                                                  <button
                                                    type="button"
                                                    className="btn btn-danger"
                                                    style={{ fontSize: '0.72rem', padding: '3px 7px' }}
                                                    onClick={() => void handleDeleteSubassemblyPart(row.sub_assembly_id, subRow.id)}
                                                  >
                                                    ✕
                                                  </button>
                                                </td>
                                              </tr>
                                            )
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </section>

                {/* ── Direct Parts Section ── */}
                <section className="card">
                  <div className="card-header">
                    <h3 className="card-title">Direct Parts</h3>
                  </div>
                  <div className="card-body">
                    <form onSubmit={handleAddPart}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) 80px auto auto',
                          gap: 10,
                          alignItems: 'end',
                          marginBottom: 10,
                        }}
                      >
                        <div>
                          <label className="label" style={{ fontSize: '0.78rem' }}>Add Existing Part</label>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input
                              className="field"
                              list="parts-list"
                              value={partLookup}
                              onChange={(e) => {
                                const value = e.target.value
                                setPartLookup(value)
                                const match = findPartByLookup(value)
                                setPartIdToAdd(match?.id || '')
                              }}
                              placeholder="Type part number or description"
                              style={{ flex: 1, minWidth: 0 }}
                            />
                            <datalist id="parts-list">
                              {parts.map((part) => (
                                <option key={part.id} value={part.part_number}>{part.description}</option>
                              ))}
                            </datalist>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ whiteSpace: 'nowrap', fontSize: '0.75rem' }}
                              onClick={() => setPartPickerOpenFor('sku')}
                            >
                              Browse
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className="label" style={{ fontSize: '0.78rem' }}>Qty</label>
                          <input
                            className="field"
                            value={partQtyToAdd}
                            onChange={(e) => setPartQtyToAdd(e.target.value)}
                            placeholder="1"
                          />
                        </div>
                        <button type="submit" disabled={addingRelation} className="btn btn-primary" style={{ fontSize: '0.82rem' }}>
                          ＋ Add
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: '0.82rem', whiteSpace: 'nowrap' }}
                          onClick={() => openPartModalNew('sku')}
                        >
                          ＋ New Part
                        </button>
                      </div>
                    </form>

                    {selectedSkuParts.length === 0 ? (
                      <div className="empty">No direct parts attached yet.</div>
                    ) : (
                      <div className="table-wrap">
                        <table className="table">
                          <thead>
                            <tr>
                              <th></th>
                              <th>Part #</th>
                              <th>Description</th>
                              <th>Qty</th>
                              <th></th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedSkuParts.map((row) => {
                              const fullPart = parts.find((p) => p.id === row.part_id)
                              const lineCost = calcPartLineCost(row.part_id, row.qty)

                              return (
                                <tr key={row.id}>
                                  <td style={{ width: 36, padding: '4px 6px' }}>
                                    <DxfPartPreview
                                      dxfFile={row.dxf_file}
                                      partNumber={row.part_number}
                                      size="tiny"
                                      isTube={row.part_type === 'tube'}
                                      tubeFallback={true}
                                      tubeOd={row.tube_od ?? undefined}
                                      tubeWall={row.tube_wall ?? undefined}
                                      cutLength={row.cut_length ?? undefined}
                                      tubeShape={row.tube_shape === 'square' || (row.tube_od ?? '').toLowerCase().includes('x') || (row.material ?? '').toLowerCase().startsWith('square') ? 'square' : 'round'}
                                    />
                                  </td>
                                  <td style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '0.83rem' }}>
                                    {row.part_number}
                                  </td>
                                  <td>
                                    <div style={{ fontSize: '0.83rem', color: 'var(--text-2)' }}>{row.part_description}</div>
                                    {fullPart?.weight_lbs != null && (
                                      <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{fullPart.weight_lbs} lb/ea</div>
                                    )}
                                  </td>
                                  <td>
                                    <input
                                      className="field-sm"
                                      defaultValue={row.qty}
                                      onBlur={(e) => void handleUpdateSkuPartQty(row.id, Number(e.target.value))}
                                      style={{ width: 52 }}
                                    />
                                  </td>
                                  <td>
                                    <button
                                      type="button"
                                      className="btn btn-secondary"
                                      style={{ fontSize: '0.72rem', padding: '3px 7px' }}
                                      onClick={() => { if (fullPart) openPartModalEdit(fullPart) }}
                                    >
                                      ✏
                                    </button>
                                  </td>
                                  <td>
                                    <button
                                      type="button"
                                      className="btn btn-danger"
                                      style={{ fontSize: '0.72rem', padding: '3px 7px' }}
                                      onClick={() => void handleDeleteSkuPart(row.id)}
                                    >
                                      ✕
                                    </button>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </section>

                {/* ── BOM Explosion ── */}
                {fullExplosion.length > 0 && (
                  <section className="card">
                    <div className="card-header">
                      <h3 className="card-title">BOM Explosion</h3>
                      <div className="card-subtitle">Fully exploded total parts for this SKU — includes cost summary.</div>
                    </div>
                    <div className="card-body">
                      <div className="table-wrap">
                        <table className="table">
                          <thead>
                            <tr>
                              <th></th>
                              <th>Part #</th>
                              <th>Description</th>
                              <th style={{ textAlign: 'center' }}>Total Qty</th>
                              <th style={{ textAlign: 'right' }}>Weight (lbs)</th>
                              <th style={{ textAlign: 'right' }}>Mat Cost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {fullExplosion.map((row) => {
                              const lineCost = calcPartLineCost(row.part_id, row.qty)
                              const totalWeight = row.weight_lbs != null ? row.weight_lbs * row.qty : null
                              return (
                                <tr key={row.part_id}>
                                  <td style={{ width: 36, padding: '4px 6px' }}>
                                    <DxfPartPreview
                                      dxfFile={row.dxf_file}
                                      partNumber={row.part_number}
                                      size="tiny"
                                      isTube={row.part_type === 'tube'}
                                      tubeFallback={true}
                                      tubeOd={row.tube_od ?? undefined}
                                      tubeWall={row.tube_wall ?? undefined}
                                      cutLength={row.cut_length ?? undefined}
                                      tubeShape={row.tube_shape === 'square' || (row.tube_od ?? '').toLowerCase().includes('x') || (row.material ?? '').toLowerCase().startsWith('square') ? 'square' : 'round'}
                                    />
                                  </td>
                                  <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{row.part_number}</td>
                                  <td>{row.description}</td>
                                  <td style={{ fontWeight: 700, textAlign: 'center' }}>{row.qty}</td>
                                  <td style={{ textAlign: 'right', fontSize: '0.83rem', color: 'var(--text-2)' }}>
                                    {totalWeight != null ? totalWeight.toFixed(3) : <span style={{ color: 'var(--muted)' }}>—</span>}
                                  </td>
                                  <td style={{ textAlign: 'right', fontSize: '0.83rem' }}>
                                    {lineCost != null
                                      ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>${lineCost.toFixed(2)}</span>
                                      : <span style={{ color: 'var(--muted)' }}>—</span>
                                    }
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                          {/* Totals row */}
                          <tfoot>
                            <tr style={{ borderTop: '2px solid var(--border)' }}>
                              <td colSpan={3} style={{ fontWeight: 700, fontSize: '0.83rem', paddingTop: 8 }}>
                                Material subtotal
                              </td>
                              <td />
                              <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '0.83rem', paddingTop: 8 }}>
                                {(() => {
                                  const totalW = fullExplosion.reduce((sum, r) =>
                                    r.weight_lbs != null ? sum + r.weight_lbs * r.qty : sum, 0)
                                  return totalW > 0 ? totalW.toFixed(3) : '—'
                                })()}
                              </td>
                              <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '0.83rem', paddingTop: 8, color: 'var(--success)' }}>
                                {matEstCost != null ? `$${matEstCost.toFixed(2)}` : '—'}
                              </td>
                            </tr>
                            {powderEstCost != null && (
                              <tr>
                                <td colSpan={5} style={{ fontSize: '0.8rem', color: '#a78bfa', paddingTop: 4 }}>
                                  Powder Coat
                                  <span style={{ marginLeft: 6, fontSize: '0.72rem', color: 'var(--muted)' }}>
                                    ({skuTotalWeight.toFixed(2)} lbs × ${latestPowderCostPerLb!.toFixed(2)}/lb)
                                  </span>
                                </td>
                                <td style={{ textAlign: 'right', fontSize: '0.8rem', paddingTop: 4, color: '#a78bfa' }}>
                                  ${powderEstCost.toFixed(2)}
                                </td>
                              </tr>
                            )}
                            {powderEstCost == null && latestPowderCostPerLb == null && (
                              <tr>
                                <td colSpan={6} style={{ fontSize: '0.75rem', color: 'var(--muted)', paddingTop: 4, fontStyle: 'italic' }}>
                                  Powder coat cost not yet available — record a return on the Powder Coat page to set the rate.
                                </td>
                              </tr>
                            )}
                            {selectedSku.bolt_kit_cost != null && (
                              <tr>
                                <td colSpan={5} style={{ fontSize: '0.8rem', color: 'var(--muted)', paddingTop: 4 }}>Bolt kit</td>
                                <td style={{ textAlign: 'right', fontSize: '0.8rem', paddingTop: 4 }}>
                                  ${selectedSku.bolt_kit_cost.toFixed(2)}
                                </td>
                              </tr>
                            )}
                            {selectedSku.packaging_cost != null && (
                              <tr>
                                <td colSpan={5} style={{ fontSize: '0.8rem', color: 'var(--muted)', paddingTop: 4 }}>Packaging</td>
                                <td style={{ textAlign: 'right', fontSize: '0.8rem', paddingTop: 4 }}>
                                  ${selectedSku.packaging_cost.toFixed(2)}
                                </td>
                              </tr>
                            )}
                            {selectedSku.labor_cost_per_unit != null && (
                              <tr>
                                <td colSpan={5} style={{ fontSize: '0.8rem', color: 'var(--muted)', paddingTop: 4 }}>Labor</td>
                                <td style={{ textAlign: 'right', fontSize: '0.8rem', paddingTop: 4 }}>
                                  ${selectedSku.labor_cost_per_unit.toFixed(2)}
                                </td>
                              </tr>
                            )}
                            {totalUnitCost != null && (
                              <tr style={{ borderTop: '1px solid var(--border)' }}>
                                <td colSpan={5} style={{ fontWeight: 800, fontSize: '0.88rem', paddingTop: 6 }}>
                                  Grand Total (per unit)
                                </td>
                                <td style={{ textAlign: 'right', fontWeight: 800, fontSize: '0.95rem', paddingTop: 6, color: 'var(--accent)' }}>
                                  ${totalUnitCost.toFixed(2)}
                                </td>
                              </tr>
                            )}
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  </section>
                )}


              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── SKU Modal ──────────────────────────────────────────────────────────── */}
      {skuModalOpen && (
        <Modal onClose={() => setSkuModalOpen(false)}>
          <h2 style={{ margin: '0 0 18px', fontSize: '1.15rem', fontWeight: 800 }}>
            {skuModalIsEdit ? 'Edit SKU' : '＋ New SKU'}
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <label className="label">SKU ID *</label>
              <input
                className="field"
                value={skuForm.id}
                onChange={(e) => setSkuForm((prev) => ({ ...prev, id: e.target.value }))}
                placeholder="44307"
                disabled={skuModalIsEdit}
              />
            </div>

            <div>
              <label className="label">Description *</label>
              <input
                className="field"
                value={skuForm.description}
                onChange={(e) => setSkuForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Rock Rail Step"
              />
            </div>

            <div>
              <label className="label">Category</label>
              <select
                className="select"
                value={skuForm.category}
                onChange={(e) => setSkuForm((prev) => ({ ...prev, category: e.target.value }))}
              >
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Bolt Kit Cost ($)</label>
              <input
                className="field"
                type="number"
                step="0.01"
                min="0"
                value={skuForm.bolt_kit_cost}
                onChange={(e) => setSkuForm((prev) => ({ ...prev, bolt_kit_cost: e.target.value }))}
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="label">Packaging Cost ($)</label>
              <input
                className="field"
                type="number"
                step="0.01"
                min="0"
                value={skuForm.packaging_cost}
                onChange={(e) => setSkuForm((prev) => ({ ...prev, packaging_cost: e.target.value }))}
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="label">Labor Cost ($)</label>
              <input
                className="field"
                type="number"
                step="0.01"
                min="0"
                value={skuForm.labor_cost_per_unit}
                onChange={(e) => setSkuForm((prev) => ({ ...prev, labor_cost_per_unit: e.target.value }))}
                placeholder="0.00"
              />
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label className="label">Notes</label>
              <textarea
                className="textarea"
                value={skuForm.notes}
                onChange={(e) => setSkuForm((prev) => ({ ...prev, notes: e.target.value }))}
                rows={3}
                placeholder="Optional notes"
              />
            </div>
          </div>

          {message && <div className="message" style={{ marginTop: 12 }}>{message}</div>}

          <div className="btn-row" style={{ marginTop: 18 }}>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void saveSkuModal()}>
              {saving ? 'Saving...' : 'Save SKU'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setSkuModalOpen(false)}>
              Cancel
            </button>
            {skuModalIsEdit && (
              <button type="button" className="btn btn-danger" onClick={() => void handleDeleteSku()}>
                Delete
              </button>
            )}
          </div>
        </Modal>
      )}

      {/* ── Part Modal ─────────────────────────────────────────────────────────── */}
      {partModalOpen && (
        <Modal onClose={() => setPartModalOpen(false)}>
          <h2 style={{ margin: '0 0 18px', fontSize: '1.15rem', fontWeight: 800 }}>
            {partModalIsEdit ? 'Edit Part' : '＋ New Part'}
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <label className="label">Part ID *</label>
              <input
                className="field"
                value={partForm.id}
                onChange={(e) => setPartForm((prev) => ({ ...prev, id: e.target.value }))}
                disabled={partModalIsEdit}
                placeholder="P-001"
              />
            </div>

            <div>
              <label className="label">Part Number *</label>
              <input
                className="field"
                value={partForm.part_number}
                onChange={(e) => setPartForm((prev) => ({ ...prev, part_number: e.target.value }))}
                placeholder="GRV-44307-001"
              />
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label className="label">Description *</label>
              <input
                className="field"
                value={partForm.description}
                onChange={(e) => setPartForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Main bracket"
              />
            </div>

            <div>
              <label className="label">Part Type</label>
              <select
                className="select"
                value={partForm.part_type}
                onChange={(e) =>
                  setPartForm((prev) => ({
                    ...prev,
                    part_type: e.target.value as 'tube' | 'sheet',
                    material_id: '',
                  }))
                }
              >
                <option value="sheet">Sheet</option>
                <option value="tube">Tube</option>
              </select>
            </div>

            <div>
              <label className="label">Material</label>
              <select
                className="select"
                value={partForm.material_id}
                onChange={(e) => setPartForm((prev) => ({ ...prev, material_id: e.target.value }))}
              >
                <option value="">
                  {partModalIsEdit ? '— keep current —' : 'Select material'}
                </option>
                {selectedMaterialsFiltered.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>

            {partForm.part_type === 'tube' ? (
              <div>
                <label className="label">Cut Length (in) *</label>
                <input
                  className="field"
                  type="number"
                  step="0.01"
                  value={partForm.cut_length}
                  onChange={(e) => setPartForm((prev) => ({ ...prev, cut_length: e.target.value }))}
                  placeholder="12.5"
                />
              </div>
            ) : (
              <div>
                <label className="label">DXF File</label>
                <input
                  className="field"
                  value={partForm.dxf_file}
                  onChange={(e) => setPartForm((prev) => ({ ...prev, dxf_file: e.target.value }))}
                  placeholder="part.dxf"
                />
              </div>
            )}

            {partForm.part_type === 'tube' ? (
              // Tubes: weight is derived — show a live computed preview, no manual entry
              (() => {
                const mat = materials.find((m) => m.id === partForm.material_id)
                const len = partForm.cut_length.trim() !== '' ? Number(partForm.cut_length) : null
                const computed =
                  mat?.unit_weight_lbs && mat?.stock_length_in && len != null && !isNaN(len)
                    ? (len / mat.stock_length_in) * mat.unit_weight_lbs
                    : null
                return (
                  <div>
                    <label className="label">Weight (auto-calculated)</label>
                    <div
                      style={{
                        padding: '8px 11px',
                        background: 'var(--panel)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: '0.84rem',
                        color: computed != null ? 'var(--text)' : 'var(--muted)',
                        lineHeight: 1.5,
                      }}
                    >
                      {computed != null ? (
                        <>
                          <span style={{ fontWeight: 700 }}>{computed.toFixed(3)} lbs</span>
                          <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: '0.78rem' }}>
                            ({partForm.cut_length}&Prime; ÷ {mat!.stock_length_in}&Prime; stock × {mat!.unit_weight_lbs} lbs/stick)
                          </span>
                        </>
                      ) : (
                        'Enter cut length and select material to calculate'
                      )}
                    </div>
                  </div>
                )
              })()
            ) : (
              <div>
                <label className="label">Weight (lbs)</label>
                <input
                  className="field"
                  type="number"
                  step="0.001"
                  value={partForm.weight_lbs}
                  onChange={(e) => setPartForm((prev) => ({ ...prev, weight_lbs: e.target.value }))}
                  placeholder="0.5"
                />
              </div>
            )}

            {/* Manufacturing stages */}
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="label" style={{ marginBottom: 8, display: 'block' }}>Manufacturing Stages</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {STAGE_FIELDS.map(({ key, label }) => (
                  <label
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '5px 10px',
                      border: `1px solid ${partForm[key as keyof typeof partForm] ? 'var(--accent-border)' : 'var(--border)'}`,
                      borderRadius: 6,
                      cursor: 'pointer',
                      background: partForm[key as keyof typeof partForm] ? 'var(--accent-soft)' : 'var(--panel-2)',
                      fontSize: '0.82rem',
                      userSelect: 'none',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!partForm[key as keyof typeof partForm]}
                      onChange={(e) => setPartForm((prev) => ({ ...prev, [key]: e.target.checked }))}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label className="label">Notes</label>
              <textarea
                className="textarea"
                rows={3}
                value={partForm.notes}
                onChange={(e) => setPartForm((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="Optional notes"
              />
            </div>

            {/* Create mode: attach section */}
            {!partModalIsEdit && (
              <div
                style={{
                  gridColumn: '1 / -1',
                  padding: 14,
                  background: 'var(--panel-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                <div className="label" style={{ marginBottom: 10 }}>Attach to:</div>
                <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.88rem' }}>
                    <input
                      type="radio"
                      checked={partAttachMode === 'sku'}
                      onChange={() => setPartAttachMode('sku')}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    This SKU directly
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.88rem' }}>
                    <input
                      type="radio"
                      checked={partAttachMode === 'subassembly'}
                      onChange={() => setPartAttachMode('subassembly')}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    Inside sub-assembly
                  </label>
                </div>

                {partAttachMode === 'subassembly' && (
                  <div style={{ marginBottom: 10 }}>
                    <select
                      className="select"
                      value={partAttachSubassemblyId}
                      onChange={(e) => setPartAttachSubassemblyId(e.target.value)}
                    >
                      <option value="">Select sub-assembly</option>
                      {selectedSkuSubassemblies.map((row) => (
                        <option key={row.sub_assembly_id} value={row.sub_assembly_id}>
                          {row.sub_assembly_name || row.sub_assembly_id}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label className="label" style={{ margin: 0 }}>Qty:</label>
                  <input
                    className="field"
                    style={{ width: 80 }}
                    value={partAttachQty}
                    onChange={(e) => setPartAttachQty(e.target.value)}
                    placeholder="1"
                  />
                </div>
              </div>
            )}
          </div>

          {builderMessage && <div className="message" style={{ marginTop: 12 }}>{builderMessage}</div>}

          <div className="btn-row" style={{ marginTop: 18 }}>
            <button type="button" className="btn btn-primary" disabled={builderSaving} onClick={() => void savePartModal()}>
              {builderSaving ? 'Saving...' : partModalIsEdit ? 'Save Part' : 'Create Part'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setPartModalOpen(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {/* ── Sub-Assembly Modal ─────────────────────────────────────────────────── */}
      {saModalOpen && (
        <Modal onClose={() => setSaModalOpen(false)}>
          <h2 style={{ margin: '0 0 18px', fontSize: '1.15rem', fontWeight: 800 }}>
            {saModalIsEdit ? 'Edit Sub-assembly' : '＋ New Sub-assembly'}
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <label className="label">Sub-assembly ID *</label>
              <input
                className="field"
                value={saForm.id}
                onChange={(e) => setSaForm((prev) => ({ ...prev, id: e.target.value }))}
                disabled={saModalIsEdit}
                placeholder="SA-001"
              />
            </div>

            <div>
              <label className="label">Name *</label>
              <input
                className="field"
                value={saForm.name}
                onChange={(e) => setSaForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Main Frame Assembly"
              />
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  cursor: 'pointer',
                  padding: '10px 14px',
                  border: `1px solid ${saForm.requires_weld ? 'var(--accent-border)' : 'var(--border)'}`,
                  borderRadius: 8,
                  background: saForm.requires_weld ? 'var(--accent-soft)' : 'var(--panel-2)',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={saForm.requires_weld}
                  onChange={(e) => setSaForm((prev) => ({ ...prev, requires_weld: e.target.checked }))}
                  style={{ accentColor: 'var(--accent)', marginTop: 2, flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.88rem' }}>Requires Welding</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 2 }}>
                    This sub-assembly gets welded together as a unit
                  </div>
                </div>
              </label>
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label className="label">Notes</label>
              <textarea
                className="textarea"
                rows={3}
                value={saForm.notes}
                onChange={(e) => setSaForm((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="Optional notes"
              />
            </div>

            {/* Create mode: attach qty */}
            {!saModalIsEdit && (
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10 }}>
                <label className="label" style={{ margin: 0, whiteSpace: 'nowrap' }}>Qty to attach to SKU:</label>
                <input
                  className="field"
                  style={{ width: 80 }}
                  value={saAttachQty}
                  onChange={(e) => setSaAttachQty(e.target.value)}
                  placeholder="1"
                />
              </div>
            )}
          </div>

          {builderMessage && <div className="message" style={{ marginTop: 12 }}>{builderMessage}</div>}

          <div className="btn-row" style={{ marginTop: 18 }}>
            <button type="button" className="btn btn-primary" disabled={builderSaving} onClick={() => void saveSaModal()}>
              {builderSaving ? 'Saving...' : saModalIsEdit ? 'Save Sub-assembly' : 'Create Sub-assembly'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setSaModalOpen(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {/* ── PartPickerModal ────────────────────────────────────────────────────── */}
      {partPickerOpenFor !== null && (
        <PartPickerModal
          parts={parts}
          onClose={() => setPartPickerOpenFor(null)}
          onSelect={(part) => {
            if (partPickerOpenFor === 'sku') {
              setPartLookup(part.part_number)
              setPartIdToAdd(part.id)
            } else {
              setSubassemblyPartLookup((prev) => ({ ...prev, [partPickerOpenFor]: part.part_number }))
              setSubassemblyDraftPartId((prev) => ({ ...prev, [partPickerOpenFor]: part.id }))
            }
            setPartPickerOpenFor(null)
          }}
          onSelectMultiple={(selectedParts) => {
            if (partPickerOpenFor === 'sku') {
              void handleMultiAddPartsToSku(selectedParts)
            } else if (partPickerOpenFor) {
              void handleMultiAddPartsToSubassembly(partPickerOpenFor, selectedParts)
            }
            setPartPickerOpenFor(null)
          }}
        />
      )}

      {/* ── SubAssemblyPickerModal ───────────────────────────────────────────────── */}
      {saPickerOpen && (
        <SubAssemblyPickerModal
          subassemblies={subassemblies}
          onClose={() => setSaPickerOpen(false)}
          onSelect={(sa) => {
            setSubassemblyLookup(sa.name)
            setSubassemblyIdToAdd(sa.id)
            setSaPickerOpen(false)
          }}
        />
      )}
    </>
  )
}
