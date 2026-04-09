'use client'

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import DxfPartPreview from '@/components/DxfPartPreview'
import PartPickerModal from '@/components/PartPickerModal'

type SKU = {
  id: string
  description: string
  category: string | null
  notes: string | null
  active: boolean
}

const SUB_IMAGE_BUCKET = 'subassembly-images'

type SubAssembly = {
  id: string
  name: string
  notes?: string | null
  image_file?: string | null
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
  cut_length: number | null
  dxf_file: string | null
  notes?: string | null
}

type MaterialRow = {
  id: string
  name: string
  material_type: 'tube' | 'sheet'
  material: string | null
  thickness: string | null
  tube_od: string | null
  tube_wall: string | null
}

type SkuSubAssemblyRow = {
  id: string
  qty: number
  sub_assembly_id: string
  sub_assembly_name: string
  image_file: string | null
}

type SkuPartRow = {
  id: string
  qty: number
  part_id: string
  part_number: string
  part_description: string
}

type SubAssemblyPartRow = {
  id: string
  qty: number
  part_id: string
  part_number: string
  part_description: string
}

type ExplodedPreviewRow = {
  part_id: string
  part_number: string
  description: string
  qty: number
}

type JoinedSubassemblyRow = {
  id: string | number
  qty: number | string
  sub_assembly_id: string | number
  sub_assembly?: { name?: string | null; image_file?: string | null } | null
}

type JoinedSkuPartRow = {
  id: string | number
  qty: number | string
  part_id: string | number
  part?: { part_number?: string | null; description?: string | null } | null
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

const emptySkuForm = {
  id: '',
  description: '',
  category: 'Racks',
  notes: '',
}

const emptyPartForm = {
  id: '',
  part_number: '',
  description: '',
  part_type: 'sheet' as 'tube' | 'sheet',
  material_id: '',
  cut_length: '',
  dxf_file: '',
  notes: '',
}

const emptySubassemblyForm = {
  id: '',
  name: '',
  notes: '',
}

export default function SkusPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [skus, setSkus] = useState<SKU[]>([])
  const [subassemblies, setSubassemblies] = useState<SubAssembly[]>([])
  const [parts, setParts] = useState<Part[]>([])
  const [materials, setMaterials] = useState<MaterialRow[]>([])
  const [selectedSkuId, setSelectedSkuId] = useState('')

  const [selectedSkuSubassemblies, setSelectedSkuSubassemblies] = useState<SkuSubAssemblyRow[]>([])
  const [selectedSkuParts, setSelectedSkuParts] = useState<SkuPartRow[]>([])
  const [subassemblyPartMap, setSubassemblyPartMap] = useState<Record<string, SubAssemblyPartRow[]>>({})
  const [expandedSubassemblyId, setExpandedSubassemblyId] = useState('')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(emptySkuForm)

  const [subassemblyIdToAdd, setSubassemblyIdToAdd] = useState('')
  const [subassemblyQtyToAdd, setSubassemblyQtyToAdd] = useState('1')
  const [partIdToAdd, setPartIdToAdd] = useState('')
  const [partQtyToAdd, setPartQtyToAdd] = useState('1')
  const [relationMessage, setRelationMessage] = useState('')
  const [addingRelation, setAddingRelation] = useState(false)
  const [duplicateBusyId, setDuplicateBusyId] = useState('')

  const [showNewPartForm, setShowNewPartForm] = useState(false)
  const [showNewSubassemblyForm, setShowNewSubassemblyForm] = useState(false)
  const [newPartAutoAttachMode, setNewPartAutoAttachMode] = useState<'sku' | 'subassembly'>('sku')
  const [newPartTargetSubassemblyId, setNewPartTargetSubassemblyId] = useState('')
  const [newPartQty, setNewPartQty] = useState('1')
  const [newSubassemblyQty, setNewSubassemblyQty] = useState('1')
  const [newPartForm, setNewPartForm] = useState(emptyPartForm)
  const [newSubassemblyForm, setNewSubassemblyForm] = useState(emptySubassemblyForm)
  const [builderMessage, setBuilderMessage] = useState('')
  const [builderSaving, setBuilderSaving] = useState(false)

  const [partLookup, setPartLookup] = useState('')
  const [subassemblyLookup, setSubassemblyLookup] = useState('')
  const [subassemblyPartLookup, setSubassemblyPartLookup] = useState<Record<string, string>>({})
  const [subassemblyDraftPartId, setSubassemblyDraftPartId] = useState<Record<string, string>>({})
  const [subassemblyDraftQty, setSubassemblyDraftQty] = useState<Record<string, string>>({})

  // 'sku' = adding a loose part to the SKU; a sub_assembly_id string = adding inside that subassembly
  const [partPickerOpenFor, setPartPickerOpenFor] = useState<'sku' | string | null>(null)

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

    if (!selectedSkuId && rows.length > 0) {
      setSelectedSkuId(rows[0].id)
    }
  }

  async function loadSubassemblies() {
    const { data, error } = await supabase
      .from('sub_assemblies')
      .select('id, name, notes')
      .order('id', { ascending: true })

    if (!error) {
      setSubassemblies((data ?? []) as SubAssembly[])
    }
  }

  async function loadParts() {
    const { data, error } = await supabase
      .from('parts')
      .select('id, part_number, description, part_type, material, thickness, tube_od, tube_wall, cut_length, dxf_file, notes')
      .order('part_number', { ascending: true })

    if (!error) {
      setParts((data ?? []) as Part[])
    }
  }

  async function loadMaterials() {
    const { data, error } = await supabase
      .from('materials')
      .select('id, name, material_type, material, thickness, tube_od, tube_wall')
      .order('name', { ascending: true })

    if (!error) {
      setMaterials((data ?? []) as MaterialRow[])
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
          description
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
            image_file
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
            description
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
      }))
      setSelectedSkuSubassemblies(mappedSubRows)
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
      }))
      setSelectedSkuParts(mappedPartRows)
    }
  }

  async function initialLoad() {
    setLoading(true)
    setMessage('')
    await Promise.all([loadSkus(), loadSubassemblies(), loadParts(), loadMaterials()])
    setLoading(false)
  }

  useEffect(() => {
    void initialLoad()
  }, [])

  useEffect(() => {
    if (selectedSkuId) {
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

  function updateField(name: keyof typeof emptySkuForm, value: string) {
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  function updateNewPartField(name: keyof typeof emptyPartForm, value: string) {
    setNewPartForm((prev) => {
      const next = { ...prev, [name]: value }
      if (name === 'part_type') next.material_id = ''
      return next
    })
  }

  function updateNewSubassemblyField(name: keyof typeof emptySubassemblyForm, value: string) {
    setNewSubassemblyForm((prev) => ({ ...prev, [name]: value }))
  }

  function startNew() {
    setEditingId(null)
    setForm(emptySkuForm)
    setMessage('')
  }

  function startEdit(sku: SKU) {
    setEditingId(sku.id)
    setSelectedSkuId(sku.id)
    setForm({
      id: sku.id,
      description: sku.description,
      category: (CATEGORY_OPTIONS.includes((sku.category || '') as SkuCategory) ? sku.category : 'Racks') || 'Racks',
      notes: sku.notes || '',
    })
    setMessage('')
  }

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

  function openNewPartForSku() {
    setShowNewPartForm(true)
    setNewPartAutoAttachMode('sku')
    setNewPartTargetSubassemblyId('')
    setNewPartQty('1')
    setBuilderMessage('')
  }

  function openNewPartForSubassembly(subassemblyId: string) {
    setShowNewPartForm(true)
    setExpandedSubassemblyId(subassemblyId)
    setNewPartAutoAttachMode('subassembly')
    setNewPartTargetSubassemblyId(subassemblyId)
    setNewPartQty(subassemblyDraftQty[subassemblyId] || '1')
    setBuilderMessage('')
  }

  function openNewSubassemblyBuilder() {
    setShowNewSubassemblyForm(true)
    setNewSubassemblyQty('1')
    setBuilderMessage('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMessage('')

    const payload = {
      id: form.id.trim(),
      description: form.description.trim(),
      category: form.category.trim() || 'Racks',
      notes: form.notes.trim() || null,
      active: true,
    }

    if (!payload.id || !payload.description) {
      setMessage('SKU and Description are required.')
      setSaving(false)
      return
    }

    const query = editingId
      ? supabase.from('skus').update(payload).eq('id', editingId)
      : supabase.from('skus').insert(payload)

    const { error } = await query

    if (error) {
      setMessage(`${editingId ? 'Update' : 'Save'} failed: ${error.message}`)
    } else {
      setMessage(editingId ? 'SKU updated.' : 'SKU saved.')
      startNew()
      await loadSkus()
      setSelectedSkuId(payload.id)
    }

    setSaving(false)
  }

  async function handleDeleteSku() {
    if (!editingId) return
    const ok = window.confirm(`Delete SKU ${editingId}?`)
    if (!ok) return

    const { error } = await supabase.from('skus').delete().eq('id', editingId)

    if (error) {
      setMessage(`Delete failed: ${error.message}`)
    } else {
      setMessage('SKU deleted.')
      setSelectedSkuId('')
      startNew()
      await loadSkus()
    }
  }

  async function upsertSkuSubassembly(skuId: string, subassemblyId: string, qty: number) {
    const existing = selectedSkuSubassemblies.find((row) => row.sub_assembly_id === subassemblyId)

    if (existing) {
      return supabase
        .from('sku_sub_assemblies')
        .update({ qty: Number(existing.qty) + qty })
        .eq('id', existing.id)
    }

    return supabase.from('sku_sub_assemblies').insert({
      sku_id: skuId,
      sub_assembly_id: subassemblyId,
      qty,
    })
  }

  async function upsertSkuPart(skuId: string, partId: string, qty: number) {
    const existing = selectedSkuParts.find((row) => row.part_id === partId)

    if (existing) {
      return supabase
        .from('sku_parts')
        .update({ qty: Number(existing.qty) + qty })
        .eq('id', existing.id)
    }

    return supabase.from('sku_parts').insert({
      sku_id: skuId,
      part_id: partId,
      qty,
    })
  }

  async function upsertSubassemblyPart(subassemblyId: string, partId: string, qty: number) {
    const existing = (subassemblyPartMap[subassemblyId] ?? []).find((row) => row.part_id === partId)

    if (existing) {
      return supabase
        .from('sub_assembly_parts')
        .update({ qty: Number(existing.qty) + qty })
        .eq('id', existing.id)
    }

    return supabase.from('sub_assembly_parts').insert({
      sub_assembly_id: subassemblyId,
      part_id: partId,
      qty,
    })
  }

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

  async function handleUpdateSkuSubassemblyQty(rowId: string, qty: number) {
    if (!qty || qty <= 0) {
      setRelationMessage('Qty must be greater than 0.')
      return
    }

    const { error } = await supabase.from('sku_sub_assemblies').update({ qty }).eq('id', rowId)
    if (error) {
      setRelationMessage(`Update qty failed: ${error.message}`)
    } else if (selectedSkuId) {
      setRelationMessage('Subassembly qty updated.')
      await loadSelectedSkuRelations(selectedSkuId)
    }
  }

  async function handleUpdateSkuPartQty(rowId: string, qty: number) {
    if (!qty || qty <= 0) {
      setRelationMessage('Qty must be greater than 0.')
      return
    }

    const { error } = await supabase.from('sku_parts').update({ qty }).eq('id', rowId)
    if (error) {
      setRelationMessage(`Update qty failed: ${error.message}`)
    } else if (selectedSkuId) {
      setRelationMessage('Part qty updated.')
      await loadSelectedSkuRelations(selectedSkuId)
    }
  }

  async function handleUpdateSubassemblyPartQty(subassemblyId: string, rowId: string, qty: number) {
    if (!qty || qty <= 0) {
      setRelationMessage('Qty must be greater than 0.')
      return
    }

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

  async function handleCreatePartInline() {
    setBuilderSaving(true)
    setBuilderMessage('')

    const selectedMaterial = materials.find((material) => material.id === newPartForm.material_id)

    if (!selectedMaterial) {
      setBuilderMessage('Choose a material from the library.')
      setBuilderSaving(false)
      return
    }

    const payload = {
      id: newPartForm.id.trim(),
      part_number: newPartForm.part_number.trim(),
      description: newPartForm.description.trim(),
      part_type: newPartForm.part_type,
      material: selectedMaterial.material || null,
      thickness: newPartForm.part_type === 'sheet' ? selectedMaterial.thickness || null : null,
      tube_od: newPartForm.part_type === 'tube' ? selectedMaterial.tube_od || null : null,
      tube_wall: newPartForm.part_type === 'tube' ? selectedMaterial.tube_wall || null : null,
      cut_length:
        newPartForm.part_type === 'tube' && newPartForm.cut_length.trim() !== ''
          ? Number(newPartForm.cut_length)
          : null,
      dxf_file: newPartForm.part_type === 'sheet' ? newPartForm.dxf_file.trim() || null : null,
      notes: newPartForm.notes.trim() || null,
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

    const attachQty = Number(newPartQty || '1')
    if (!attachQty || attachQty <= 0) {
      setBuilderMessage('Part created. Set a valid attach qty to auto-add it.')
      setBuilderSaving(false)
      return
    }

    if (newPartAutoAttachMode === 'sku') {
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
      setPartIdToAdd(payload.id)
      setPartLookup(payload.part_number)
      setBuilderMessage('Part created and added to the SKU BOM.')
    } else {
      const targetSubassemblyId = newPartTargetSubassemblyId
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
      setSubassemblyDraftPartId((prev) => ({ ...prev, [targetSubassemblyId]: payload.id }))
      setSubassemblyPartLookup((prev) => ({ ...prev, [targetSubassemblyId]: payload.part_number }))
      setBuilderMessage('Part created and added inside the subassembly.')
    }

    setNewPartForm(emptyPartForm)
    setNewPartQty('1')
    setShowNewPartForm(false)
    setBuilderSaving(false)
  }

  async function handleCreateSubassemblyInline() {
    setBuilderSaving(true)
    setBuilderMessage('')

    const payload = {
      id: newSubassemblyForm.id.trim(),
      name: newSubassemblyForm.name.trim(),
      notes: newSubassemblyForm.notes.trim() || null,
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

    const qty = Number(newSubassemblyQty || '1')
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
    setSubassemblyIdToAdd(payload.id)
    setSubassemblyLookup(payload.id)
    setShowNewSubassemblyForm(false)
    setNewSubassemblyForm(emptySubassemblyForm)
    setNewSubassemblyQty('1')
    setBuilderMessage('Subassembly created and added to the SKU BOM.')
    setBuilderSaving(false)
  }

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
        `Duplicate failed while reading BOM: ${
          sourceSkuSubassembliesError?.message || sourceSkuPartsError?.message
        }`
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

  const filteredSkus = skus.filter((sku) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return `${sku.id} ${sku.description} ${sku.category || ''} ${sku.notes || ''}`
      .toLowerCase()
      .includes(q)
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
          })
        }
      }
    }

    return Array.from(totals.values()).sort((a, b) =>
      a.part_number.localeCompare(b.part_number, undefined, { numeric: true })
    )
  }, [selectedSkuParts, selectedSkuSubassemblies, subassemblyPartMap])

  const selectedSku = skus.find((sku) => sku.id === selectedSkuId) || null
  const selectedMaterials = materials.filter((material) => material.material_type === newPartForm.part_type)

  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">SKUs</h1>
          <div className="page-subtitle">
            Search, select, and build full SKU BOMs from one page.
          </div>
        </div>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">SKU Setup</h2>
          <div className="card-subtitle">
            Create or edit the parent SKU.
          </div>
        </div>

        <div className="card-body">
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
              <div>
                <label className="label">SKU</label>
                <input
                  className="field"
                  value={form.id}
                  onChange={(e) => updateField('id', e.target.value)}
                  placeholder="44307"
                  disabled={!!editingId}
                />
              </div>

              <div>
                <label className="label">Description</label>
                <input
                  className="field"
                  value={form.description}
                  onChange={(e) => updateField('description', e.target.value)}
                  placeholder="Rock Rail Step"
                />
              </div>

              <div>
                <label className="label">Category</label>
                <select
                  className="select"
                  value={form.category}
                  onChange={(e) => updateField('category', e.target.value)}
                >
                  {CATEGORY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <label className="label">Notes</label>
                <textarea
                  className="textarea"
                  value={form.notes}
                  onChange={(e) => updateField('notes', e.target.value)}
                  rows={4}
                  placeholder="Optional notes"
                />
              </div>
            </div>

            <div className="btn-row" style={{ marginTop: 18 }}>
              <button type="submit" disabled={saving} className="btn btn-primary">
                {saving ? 'Saving...' : editingId ? 'Update SKU' : 'Save SKU'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={startNew}>
                New
              </button>
              {editingId && (
                <button type="button" className="btn btn-danger" onClick={handleDeleteSku}>
                  Delete
                </button>
              )}
            </div>

            {message && <div className="message">{message}</div>}
          </form>
        </div>
      </section>

      <section className="card">
        <div
          className="card-header"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
        >
          <div>
            <h2 className="card-title">All SKUs</h2>
            <div className="card-subtitle">
              Search and select a SKU to build or edit.
            </div>
          </div>

          <div style={{ minWidth: 260, flex: '0 0 320px', position: 'relative' }}>
            <span
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--muted)',
                pointerEvents: 'none',
              }}
            >
              🔍
            </span>
            <input
              className="field"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SKU or description"
              style={{ paddingLeft: 36 }}
            />
          </div>
        </div>

        <div className="card-body">
          {loading ? (
            <div className="empty">Loading...</div>
          ) : filteredSkus.length === 0 ? (
            <div className="empty">No matching SKUs.</div>
          ) : (
            <div className="section-stack" style={{ gap: 18 }}>
              {Object.entries(groupedFilteredSkus).map(([category, categorySkus]) => {
                if (categorySkus.length === 0) return null
                const style = getCategoryStyle(category)

                return (
                  <div
                    key={category}
                    style={{
                      border: `1px solid ${style.border}`,
                      borderRadius: 16,
                      background: style.bg,
                      padding: 14,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 12,
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 800,
                          fontSize: '1rem',
                          color: style.text,
                          letterSpacing: '0.02em',
                        }}
                      >
                        {category}
                      </div>
                      <div
                        style={{
                          background: style.pill,
                          color: style.text,
                          border: `1px solid ${style.border}`,
                          borderRadius: 999,
                          padding: '4px 10px',
                          fontSize: '0.8rem',
                          fontWeight: 700,
                        }}
                      >
                        {categorySkus.length}
                      </div>
                    </div>

                    <div className="section-stack" style={{ gap: 10 }}>
                      {categorySkus.map((sku) => (
                        <div key={sku.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10 }}>
                          <button
                            type="button"
                            onClick={() => startEdit(sku)}
                            className={`sidebar-link ${selectedSkuId === sku.id ? 'active' : ''}`}
                            style={{
                              width: '100%',
                              textAlign: 'left',
                              background: selectedSkuId === sku.id ? style.pill : 'var(--panel-2)',
                              borderColor: selectedSkuId === sku.id ? style.border : 'var(--border)',
                              color: selectedSkuId === sku.id ? style.text : 'var(--text)',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                              <div style={{ fontWeight: 700 }}>{sku.id}</div>
                              <div
                                style={{
                                  fontSize: '0.75rem',
                                  fontWeight: 700,
                                  color: style.text,
                                  background: style.pill,
                                  border: `1px solid ${style.border}`,
                                  borderRadius: 999,
                                  padding: '2px 8px',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {sku.category || 'Uncategorized'}
                              </div>
                            </div>
                            <div
                              style={{
                                fontSize: '0.9rem',
                                color: selectedSkuId === sku.id ? style.text : 'var(--muted)',
                              }}
                            >
                              {sku.description}
                            </div>
                          </button>

                          <button
                            className="btn btn-secondary"
                            onClick={() => void duplicateSkuWithBom(sku)}
                            disabled={duplicateBusyId === sku.id}
                          >
                            {duplicateBusyId === sku.id ? 'Duplicating...' : 'Duplicate'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Selected SKU Builder</h2>
          <div className="card-subtitle">
            Full-width BOM builder with clearer hierarchy.
          </div>
        </div>

        <div className="card-body">
          {!selectedSkuId ? (
            <div className="empty">Select a SKU.</div>
          ) : (
            <>
              <div style={{ marginBottom: 18 }}>
                <div className="kicker">Selected</div>
                <div className="group-title" style={{ marginBottom: 0 }}>{selectedSkuId}</div>
                {selectedSku && (
                  <>
                    <div style={{ color: 'var(--muted)' }}>{selectedSku.description}</div>
                    <div style={{ marginTop: 8 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '4px 10px',
                          borderRadius: 999,
                          fontSize: '0.8rem',
                          fontWeight: 700,
                          background: getCategoryStyle(selectedSku.category).pill,
                          border: `1px solid ${getCategoryStyle(selectedSku.category).border}`,
                          color: getCategoryStyle(selectedSku.category).text,
                        }}
                      >
                        {selectedSku.category || 'Uncategorized'}
                      </span>
                    </div>
                  </>
                )}
              </div>

              <div className="btn-row" style={{ marginBottom: 18 }}>
                <button type="button" className="btn btn-secondary" onClick={openNewPartForSku}>
                  New Part + Add to SKU
                </button>
                <button type="button" className="btn btn-secondary" onClick={openNewSubassemblyBuilder}>
                  New Subassembly + Add to SKU
                </button>
              </div>

              {showNewPartForm && (
                <section className="card" style={{ boxShadow: 'none', marginBottom: 18 }}>
                  <div className="card-header">
                    <h3 className="card-title">
                      {newPartAutoAttachMode === 'sku'
                        ? 'Create New Part for SKU'
                        : 'Create New Part for Subassembly'}
                    </h3>
                  </div>
                  <div className="card-body">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                      <div>
                        <label className="label">Part ID</label>
                        <input
                          className="field"
                          value={newPartForm.id}
                          onChange={(e) => updateNewPartField('id', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="label">Part Number</label>
                        <input
                          className="field"
                          value={newPartForm.part_number}
                          onChange={(e) => updateNewPartField('part_number', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="label">Description</label>
                        <input
                          className="field"
                          value={newPartForm.description}
                          onChange={(e) => updateNewPartField('description', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="label">Type</label>
                        <select
                          className="select"
                          value={newPartForm.part_type}
                          onChange={(e) => updateNewPartField('part_type', e.target.value)}
                        >
                          <option value="sheet">Sheet</option>
                          <option value="tube">Tube</option>
                        </select>
                      </div>
                      <div>
                        <label className="label">Material</label>
                        <select
                          className="select"
                          value={newPartForm.material_id}
                          onChange={(e) => updateNewPartField('material_id', e.target.value)}
                        >
                          <option value="">Select material</option>
                          {selectedMaterials.map((material) => (
                            <option key={material.id} value={material.id}>
                              {material.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="label">Auto-add Qty</label>
                        <input className="field" value={newPartQty} onChange={(e) => setNewPartQty(e.target.value)} />
                      </div>
                      {newPartForm.part_type === 'tube' ? (
                        <div>
                          <label className="label">Cut Length</label>
                          <input
                            className="field"
                            value={newPartForm.cut_length}
                            onChange={(e) => updateNewPartField('cut_length', e.target.value)}
                          />
                        </div>
                      ) : (
                        <div>
                          <label className="label">DXF File</label>
                          <input
                            className="field"
                            value={newPartForm.dxf_file}
                            onChange={(e) => updateNewPartField('dxf_file', e.target.value)}
                          />
                        </div>
                      )}
                      {newPartAutoAttachMode === 'subassembly' && (
                        <div>
                          <label className="label">Target Subassembly</label>
                          <input
                            className="field"
                            list="selected-subassembly-list"
                            value={newPartTargetSubassemblyId}
                            onChange={(e) => setNewPartTargetSubassemblyId(e.target.value)}
                            placeholder="Type subassembly ID"
                          />
                          <datalist id="selected-subassembly-list">
                            {selectedSkuSubassemblies.map((row) => (
                              <option key={row.sub_assembly_id} value={row.sub_assembly_id}>
                                {row.sub_assembly_name}
                              </option>
                            ))}
                          </datalist>
                        </div>
                      )}
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label className="label">Notes</label>
                        <textarea
                          className="textarea"
                          rows={3}
                          value={newPartForm.notes}
                          onChange={(e) => updateNewPartField('notes', e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="btn-row" style={{ marginTop: 18 }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={builderSaving}
                        onClick={() => void handleCreatePartInline()}
                      >
                        {builderSaving ? 'Saving...' : 'Create Part'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setShowNewPartForm(false)}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {showNewSubassemblyForm && (
                <section className="card" style={{ boxShadow: 'none', marginBottom: 18 }}>
                  <div className="card-header">
                    <h3 className="card-title">Create New Subassembly for SKU</h3>
                  </div>
                  <div className="card-body">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                      <div>
                        <label className="label">Subassembly ID</label>
                        <input
                          className="field"
                          value={newSubassemblyForm.id}
                          onChange={(e) => updateNewSubassemblyField('id', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="label">Name</label>
                        <input
                          className="field"
                          value={newSubassemblyForm.name}
                          onChange={(e) => updateNewSubassemblyField('name', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="label">Auto-add Qty</label>
                        <input
                          className="field"
                          value={newSubassemblyQty}
                          onChange={(e) => setNewSubassemblyQty(e.target.value)}
                        />
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label className="label">Notes</label>
                        <textarea
                          className="textarea"
                          rows={3}
                          value={newSubassemblyForm.notes}
                          onChange={(e) => updateNewSubassemblyField('notes', e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="btn-row" style={{ marginTop: 18 }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={builderSaving}
                        onClick={() => void handleCreateSubassemblyInline()}
                      >
                        {builderSaving ? 'Saving...' : 'Create Subassembly'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setShowNewSubassemblyForm(false)}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {builderMessage && <div className="message" style={{ marginBottom: 18 }}>{builderMessage}</div>}

              <div className="section-stack" style={{ gap: 18 }}>
                <section className="card" style={{ boxShadow: 'none' }}>
                  <div className="card-header">
                    <h3 className="card-title">Direct Parts</h3>
                    <div className="card-subtitle">Type the part number instead of scrolling a long list.</div>
                  </div>
                  <div className="card-body">
                    <form onSubmit={handleAddPart}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(280px, 1fr) 140px auto',
                          gap: '14px',
                          alignItems: 'end',
                        }}
                      >
                        <div>
                          <label className="label">Part</label>
                          <div style={{ display: 'flex', gap: 8 }}>
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
                            />
                            <datalist id="parts-list">
                              {parts.map((part) => (
                                <option key={part.id} value={part.part_number}>
                                  {part.description}
                                </option>
                              ))}
                            </datalist>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ whiteSpace: 'nowrap' }}
                              onClick={() => setPartPickerOpenFor('sku')}
                            >
                              Browse
                            </button>
                          </div>
                        </div>

                        <div>
                          <label className="label">Qty</label>
                          <input
                            className="field"
                            value={partQtyToAdd}
                            onChange={(e) => setPartQtyToAdd(e.target.value)}
                            placeholder="1"
                          />
                        </div>

                        <button type="button" className="btn btn-secondary" onClick={openNewPartForSku}>
                          New Part
                        </button>
                      </div>

                      <div className="btn-row" style={{ marginTop: 18 }}>
                        <button type="submit" disabled={addingRelation} className="btn btn-primary">
                          Add Part
                        </button>
                      </div>
                    </form>

                    <div style={{ marginTop: 18 }}>
                      {selectedSkuParts.length === 0 ? (
                        <div className="empty">No direct parts attached yet.</div>
                      ) : (
                        <div className="table-wrap">
                          <table className="table">
                            <thead>
                              <tr>
                                <th style={{ width: 120 }}>Preview</th>
                                <th>Part</th>
                                <th>Qty</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedSkuParts.map((row) => {
                                const fullPart = parts.find((part) => part.id === row.part_id)

                                return (
                                  <tr key={row.id}>
                                    <td>
                                      <DxfPartPreview
                                        dxfFile={fullPart?.dxf_file || null}
                                        partNumber={row.part_number}
                                        size="tiny"
                                        isTube={fullPart?.part_type === 'tube'}
                                        tubeFallback={false}
                                      />
                                    </td>
                                    <td>
                                      <div style={{ fontWeight: 700 }}>{row.part_number}</div>
                                      {row.part_description && (
                                        <div style={{ color: 'var(--muted)', fontSize: '0.88rem' }}>
                                          {row.part_description}
                                        </div>
                                      )}
                                    </td>
                                    <td>
                                      <input
                                        className="field-sm"
                                        defaultValue={row.qty}
                                        onBlur={(e) => void handleUpdateSkuPartQty(row.id, Number(e.target.value))}
                                      />
                                    </td>
                                    <td>
                                      <button
                                        type="button"
                                        className="btn btn-danger"
                                        onClick={() => void handleDeleteSkuPart(row.id)}
                                      >
                                        Remove
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
                  </div>
                </section>

                <section className="card" style={{ boxShadow: 'none' }}>
                  <div className="card-header">
                    <h3 className="card-title">Subassemblies</h3>
                    <div className="card-subtitle">
                      Parent subassemblies with indented child parts underneath.
                    </div>
                  </div>
                  <div className="card-body">
                    <form onSubmit={handleAddSubassembly}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(280px, 1fr) 140px auto',
                          gap: '14px',
                          alignItems: 'end',
                        }}
                      >
                        <div>
                          <label className="label">Subassembly</label>
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
                            placeholder="Type subassembly ID or name"
                          />
                          <datalist id="subassembly-list">
                            {subassemblies.map((sa) => (
                              <option key={sa.id} value={sa.id}>
                                {sa.name}
                              </option>
                            ))}
                          </datalist>
                        </div>

                        <div>
                          <label className="label">Qty</label>
                          <input
                            className="field"
                            value={subassemblyQtyToAdd}
                            onChange={(e) => setSubassemblyQtyToAdd(e.target.value)}
                            placeholder="1"
                          />
                        </div>

                        <button type="button" className="btn btn-secondary" onClick={openNewSubassemblyBuilder}>
                          New Subassembly
                        </button>
                      </div>

                      <div className="btn-row" style={{ marginTop: 18 }}>
                        <button type="submit" disabled={addingRelation} className="btn btn-primary">
                          Add Subassembly
                        </button>
                      </div>
                    </form>

                    <div style={{ marginTop: 18 }}>
                      {selectedSkuSubassemblies.length === 0 ? (
                        <div className="empty">No subassemblies attached yet.</div>
                      ) : (
                        <div className="section-stack" style={{ gap: 14 }}>
                          {selectedSkuSubassemblies.map((row) => {
                            const isExpanded = expandedSubassemblyId === row.sub_assembly_id
                            const subRows = subassemblyPartMap[row.sub_assembly_id] ?? []

                            return (
                              <div
                                key={row.id}
                                style={{
                                  border: '1px solid var(--border)',
                                  borderRadius: 14,
                                  background: 'rgba(255,255,255,0.02)',
                                  padding: 14,
                                }}
                              >
                                <div
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'auto minmax(180px, 1fr) 110px auto auto',
                                    gap: 12,
                                    alignItems: 'center',
                                  }}
                                >
                                  {/* Thumbnail */}
                                  {row.image_file ? (
                                    <img
                                      src={supabase.storage.from(SUB_IMAGE_BUCKET).getPublicUrl(row.image_file).data.publicUrl}
                                      alt={row.sub_assembly_name}
                                      style={{
                                        width: 64,
                                        height: 64,
                                        objectFit: 'cover',
                                        borderRadius: 8,
                                        border: '1px solid var(--border)',
                                        flexShrink: 0,
                                      }}
                                    />
                                  ) : (
                                    <div style={{
                                      width: 64,
                                      height: 64,
                                      borderRadius: 8,
                                      border: '1px solid var(--border)',
                                      background: 'var(--panel)',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '1.4rem',
                                      flexShrink: 0,
                                    }}>
                                      🔩
                                    </div>
                                  )}

                                  <div>
                                    <div style={{ fontWeight: 800 }}>{row.sub_assembly_id}</div>
                                    <div style={{ color: 'var(--muted)' }}>{row.sub_assembly_name || 'No name'}</div>
                                  </div>

                                  <div>
                                    <label className="label">Qty</label>
                                    <input
                                      className="field"
                                      defaultValue={row.qty}
                                      onBlur={(e) => void handleUpdateSkuSubassemblyQty(row.id, Number(e.target.value))}
                                    />
                                  </div>

                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => {
                                      setExpandedSubassemblyId(isExpanded ? '' : row.sub_assembly_id)
                                      if (!subassemblyPartMap[row.sub_assembly_id]) {
                                        void loadSubassemblyParts(row.sub_assembly_id)
                                      }
                                    }}
                                  >
                                    {isExpanded ? 'Hide Parts' : 'Edit Parts'}
                                  </button>

                                  <button
                                    type="button"
                                    className="btn btn-danger"
                                    onClick={() => void handleDeleteSkuSubassembly(row.id)}
                                  >
                                    Remove
                                  </button>
                                </div>

                                {isExpanded && (
                                  <div
                                    style={{
                                      marginTop: 18,
                                      marginLeft: 18,
                                      paddingLeft: 18,
                                      borderLeft: '3px solid rgba(255,255,255,0.12)',
                                    }}
                                  >
                                    <div
                                      style={{
                                        background: 'rgba(255,255,255,0.03)',
                                        border: '1px solid var(--border)',
                                        borderRadius: 12,
                                        padding: 14,
                                      }}
                                    >
                                      <div
                                        style={{
                                          display: 'grid',
                                          gridTemplateColumns: 'minmax(260px, 1fr) 120px auto',
                                          gap: 10,
                                          alignItems: 'end',
                                          marginBottom: 14,
                                        }}
                                      >
                                        <div>
                                          <label className="label">Add Part Inside Subassembly</label>
                                          <div style={{ display: 'flex', gap: 8 }}>
                                            <input
                                              className="field"
                                              list={`subassembly-parts-list-${row.sub_assembly_id}`}
                                              value={subassemblyPartLookup[row.sub_assembly_id] || ''}
                                              onChange={(e) => {
                                                const value = e.target.value
                                                setSubassemblyPartLookup((prev) => ({
                                                  ...prev,
                                                  [row.sub_assembly_id]: value,
                                                }))
                                                const match = findPartByLookup(value)
                                                setSubassemblyDraftPartId((prev) => ({
                                                  ...prev,
                                                  [row.sub_assembly_id]: match?.id || '',
                                                }))
                                              }}
                                              placeholder="Type part number or description"
                                            />
                                            <datalist id={`subassembly-parts-list-${row.sub_assembly_id}`}>
                                              {parts.map((part) => (
                                                <option key={part.id} value={part.part_number}>
                                                  {part.description}
                                                </option>
                                              ))}
                                            </datalist>
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              style={{ whiteSpace: 'nowrap' }}
                                              onClick={() => setPartPickerOpenFor(row.sub_assembly_id)}
                                            >
                                              Browse
                                            </button>
                                          </div>
                                        </div>

                                        <div>
                                          <label className="label">Qty</label>
                                          <input
                                            className="field"
                                            value={subassemblyDraftQty[row.sub_assembly_id] || '1'}
                                            onChange={(e) =>
                                              setSubassemblyDraftQty((prev) => ({
                                                ...prev,
                                                [row.sub_assembly_id]: e.target.value,
                                              }))
                                            }
                                          />
                                        </div>

                                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                                          <button
                                            type="button"
                                            className="btn btn-secondary"
                                            onClick={() => openNewPartForSubassembly(row.sub_assembly_id)}
                                          >
                                            New Part
                                          </button>
                                          <button
                                            type="button"
                                            className="btn btn-primary"
                                            onClick={() => void handleAddPartToAttachedSubassembly(row.sub_assembly_id)}
                                          >
                                            Add
                                          </button>
                                        </div>
                                      </div>

                                      {subRows.length === 0 ? (
                                        <div className="empty">No parts inside this subassembly yet.</div>
                                      ) : (
                                        <div className="table-wrap">
                                          <table className="table">
                                            <thead>
                                              <tr>
                                                <th style={{ width: 120 }}>Preview</th>
                                                <th>Part</th>
                                                <th>Qty per Subassembly</th>
                                                <th></th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {subRows.map((subRow) => {
                                                const fullPart = parts.find((part) => part.id === subRow.part_id)

                                                return (
                                                  <tr key={subRow.id}>
                                                    <td>
                                                      <DxfPartPreview
                                                        dxfFile={fullPart?.dxf_file || null}
                                                        partNumber={subRow.part_number}
                                                        size="tiny"
                                                        isTube={fullPart?.part_type === 'tube'}
                                                        tubeFallback={false}
                                                      />
                                                    </td>
                                                    <td>
                                                      <div style={{ fontWeight: 700 }}>{subRow.part_number}</div>
                                                      {subRow.part_description && (
                                                        <div style={{ color: 'var(--muted)', fontSize: '0.88rem' }}>
                                                          {subRow.part_description}
                                                        </div>
                                                      )}
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
                                                      />
                                                    </td>
                                                    <td>
                                                      <button
                                                        type="button"
                                                        className="btn btn-danger"
                                                        onClick={() =>
                                                          void handleDeleteSubassemblyPart(
                                                            row.sub_assembly_id,
                                                            subRow.id
                                                          )
                                                        }
                                                      >
                                                        Remove
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
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                {relationMessage && <div className="message">{relationMessage}</div>}
              </div>
            </>
          )}
        </div>
      </section>

      {selectedSkuId && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Exploded Preview</h2>
            <div className="card-subtitle">Fully exploded total parts for the selected SKU.</div>
          </div>

          <div className="card-body">
            {fullExplosion.length === 0 ? (
              <div className="empty">No exploded parts yet.</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 120 }}>Preview</th>
                      <th>Part #</th>
                      <th>Description</th>
                      <th>Total Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fullExplosion.map((row) => {
                      const fullPart = parts.find((part) => part.id === row.part_id)

                      return (
                        <tr key={row.part_id}>
                          <td>
                            <DxfPartPreview
                              dxfFile={fullPart?.dxf_file || null}
                              partNumber={row.part_number}
                              size="tiny"
                              isTube={fullPart?.part_type === 'tube'}
                              tubeFallback={false}
                            />
                          </td>
                          <td>{row.part_number}</td>
                          <td>{row.description}</td>
                          <td>{row.qty}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {partPickerOpenFor !== null && (
        <PartPickerModal
          parts={parts}
          onClose={() => setPartPickerOpenFor(null)}
          onSelect={(part) => {
            if (partPickerOpenFor === 'sku') {
              setPartLookup(part.part_number)
              setPartIdToAdd(part.id)
            } else {
              // partPickerOpenFor is a sub_assembly_id
              setSubassemblyPartLookup((prev) => ({
                ...prev,
                [partPickerOpenFor]: part.part_number,
              }))
              setSubassemblyDraftPartId((prev) => ({
                ...prev,
                [partPickerOpenFor]: part.id,
              }))
            }
            setPartPickerOpenFor(null)
          }}
        />
      )}
    </div>
  )
}