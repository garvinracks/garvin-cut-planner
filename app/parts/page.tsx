'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import DxfPartPreview from '@/components/DxfPartPreview'

// Manufacturing stage keys and display labels
// NOTE: Powder coat is NOT listed here — it's outsourced and applies to every part,
// so it's tracked at the batch level (Powder page), not per-part.
export const STAGE_KEYS = [
  'requires_laser',
  'requires_sheet_bend',
  'requires_tube_bend',
  'requires_saw',
  'requires_drill',
  'requires_weld',
] as const
export type StageKey = typeof STAGE_KEYS[number]

export const STAGE_LABELS: Record<StageKey, string> = {
  requires_laser:      'Laser',
  requires_sheet_bend: 'Sheet Bend',
  requires_tube_bend:  'Tube Bend',
  requires_saw:        'Saw',
  requires_drill:      'Drill Press',
  requires_weld:       'Weld',
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
  notes: string | null
  weight_lbs: number | null
  requires_laser:      boolean
  requires_sheet_bend: boolean
  requires_tube_bend:  boolean
  requires_saw:        boolean
  requires_drill:      boolean
  requires_weld:       boolean
  requires_powder:     boolean
}

type MaterialRow = {
  id: string
  name: string
  material_type: 'tube' | 'sheet'
  material: string | null
  thickness: string | null
  tube_od: string | null
  tube_wall: string | null
  tube_shape: string | null
}

const DXF_BUCKET = 'dxf-files'

type PartOperation = {
  id: string
  part_id: string
  step: number
  operation: string
  notes: string | null
}

const OPERATION_OPTIONS = [
  'Laser Cut',
  'Plasma Cut',
  'Bend',
  'Roll',
  'Punch',
  'Drill',
  'Tap',
  'MIG Weld',
  'TIG Weld',
  'Grind / Deburr',
  'Paint',
  'Powder Coat',
  'Hardware',
  'Assembly',
]

const emptyOpForm = { operation: 'Laser Cut', notes: '' }

type PartRevision = {
  id: string
  part_id: string
  changed_at: string
  changed_fields: string
  old_values: string
  new_values: string
}

type UsageRef = {
  type: 'sku' | 'subassembly'
  id: string
  name: string
  qty: number
}

type CsvImportRow = {
  id: string
  part_number: string
  description: string
  part_type: 'tube' | 'sheet'
  material: string
  thickness: string
  tube_od: string
  tube_wall: string
  cut_length: string
  notes: string
  errors: string[]
}

// ── CSV helpers (no extra deps) ───────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
      else inQ = !inQ
    } else if (ch === ',' && !inQ) {
      fields.push(cur.trim()); cur = ''
    } else {
      cur += ch
    }
  }
  fields.push(cur.trim())
  return fields
}

function parseCsvText(text: string): CsvImportRow[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'))
  const col = (row: string[], name: string) => {
    const i = headers.indexOf(name)
    return i >= 0 ? (row[i] ?? '').trim() : ''
  }

  return lines.slice(1).map((line) => {
    const row = parseCsvLine(line)
    const partType = col(row, 'part_type').toLowerCase()
    const errors: string[] = []

    const id = col(row, 'id') || col(row, 'part_number')
    const part_number = col(row, 'part_number')
    const description = col(row, 'description')

    if (!id) errors.push('id or part_number required')
    if (!part_number) errors.push('part_number required')
    if (!description) errors.push('description required')
    if (partType !== 'tube' && partType !== 'sheet') errors.push('part_type must be "tube" or "sheet"')

    const cut_length = col(row, 'cut_length')
    if (cut_length && isNaN(Number(cut_length))) errors.push('cut_length must be a number')

    return {
      id,
      part_number,
      description,
      part_type: (partType === 'tube' ? 'tube' : 'sheet') as 'tube' | 'sheet',
      material: col(row, 'material'),
      thickness: col(row, 'thickness'),
      tube_od: col(row, 'tube_od'),
      tube_wall: col(row, 'tube_wall'),
      cut_length,
      notes: col(row, 'notes'),
      errors,
    }
  })
}

const CSV_TEMPLATE = [
  'id,part_number,description,part_type,material,thickness,tube_od,tube_wall,tube_shape,cut_length,notes',
  '20000-L1,20000-L1,Wind Deflector Left,sheet,HRPO,3/16,,,,',
  '20000-T1,20000-T1,Main Frame Rail,tube,DOM,,,1.25,.120,48,',
].join('\n')

const emptyForm = {
  id: '',
  part_number: '',
  description: '',
  part_type: 'sheet',
  material_id: '',
  cut_length: '',
  weight_lbs: '',
  dxf_file: '',
  notes: '',
  requires_laser:      false,
  requires_sheet_bend: false,
  requires_tube_bend:  false,
  requires_saw:        false,
  requires_drill:      false,
  requires_weld:       false,
  requires_powder:     false,
}

export default function PartsPage() {
  const supabase = useMemo(() => createBrowserClient(), [])
  const [parts, setParts] = useState<Part[]>([])
  const [weightUnit, setWeightUnit] = useState<'lbs' | 'oz'>('lbs')
  const [materials, setMaterials] = useState<MaterialRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [selectedDxfFile, setSelectedDxfFile] = useState<File | null>(null)
  const [previewPart, setPreviewPart] = useState<Part | null>(null)

  // Operation routing
  const [operations, setOperations] = useState<PartOperation[]>([])
  const [opForm, setOpForm] = useState(emptyOpForm)
  const [savingOp, setSavingOp] = useState(false)
  const [opMessage, setOpMessage] = useState('')
  const [loadingOps, setLoadingOps] = useState(false)

  // Usage map
  const [usageRefs, setUsageRefs] = useState<UsageRef[]>([])
  const [loadingUsage, setLoadingUsage] = useState(false)

  // Revision log
  const [revisions, setRevisions] = useState<PartRevision[]>([])
  const [loadingRevisions, setLoadingRevisions] = useState(false)

  // CSV import
  const [importOpen, setImportOpen] = useState(false)
  const [csvRows, setCsvRows] = useState<CsvImportRow[]>([])
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState('')

  async function loadParts() {
    const { data, error } = await supabase
      .from('parts')
      .select('*')
      .order('part_number', { ascending: true })

    if (error) {
      setMessage(`Parts load failed: ${error.message}`)
      setParts([])
    } else {
      setParts((data as Part[]) || [])
    }
  }

  async function loadMaterials() {
    const { data, error } = await supabase
      .from('materials')
      .select('id, name, material_type, material, thickness, tube_od, tube_wall')
      .order('name', { ascending: true })

    if (error) {
      setMessage(`Materials load failed: ${error.message}`)
      setMaterials([])
    } else {
      setMaterials((data as MaterialRow[]) || [])
    }
  }

  async function initialLoad() {
    setLoading(true)
    setMessage('')
    await Promise.all([loadParts(), loadMaterials()])
    setLoading(false)
  }

  function handleCsvFile(file: File) {
    setImportMessage('')
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const rows = parseCsvText(text)
      setCsvRows(rows)
      if (rows.length === 0) setImportMessage('No data rows found in CSV.')
    }
    reader.readAsText(file)
  }

  async function handleImport() {
    const valid = csvRows.filter((r) => r.errors.length === 0)
    if (valid.length === 0) {
      setImportMessage('No valid rows to import.')
      return
    }
    setImporting(true)
    setImportMessage('')

    const payload = valid.map((r) => ({
      id: r.id,
      part_number: r.part_number,
      description: r.description,
      part_type: r.part_type,
      material: r.material || null,
      thickness: r.thickness || null,
      tube_od: r.tube_od || null,
      tube_wall: r.tube_wall || null,
      cut_length: r.cut_length ? Number(r.cut_length) : null,
      notes: r.notes || null,
    }))

    const { error } = await supabase
      .from('parts')
      .upsert(payload, { onConflict: 'id' })

    if (error) {
      setImportMessage(`Import failed: ${error.message}`)
    } else {
      setImportMessage(`✓ ${valid.length} part${valid.length !== 1 ? 's' : ''} imported successfully.`)
      setCsvRows([])
      await loadParts()
    }

    setImporting(false)
  }

  function downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'parts-import-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  useEffect(() => {
    void initialLoad()
  }, [])

  // Auto-select part from ?id= query param after data loads
  useEffect(() => {
    if (loading || parts.length === 0) return
    try {
      const params = new URLSearchParams(window.location.search)
      const idParam = params.get('id')
      if (!idParam) return
      const match = parts.find((p) => p.id === idParam)
      if (match) {
        startEdit(match)
        setTimeout(() => {
          document.getElementById(`part-row-${match.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 100)
      }
    } catch {
      // ignore
    }
  }, [loading, parts])

  function updateField(name: string, value: string) {
    setForm((prev) => {
      const next = { ...prev, [name]: value }
      if (name === 'part_type') {
        next.material_id = ''
        if (value === 'tube') {
          next.dxf_file = ''
          setSelectedDxfFile(null)
        }
      }
      return next
    })
  }

  function startNew() {
    setEditingId(null)
    setForm(emptyForm)
    setSelectedDxfFile(null)
    setMessage('')
    setOperations([])
    setOpMessage('')
    setUsageRefs([])
    setRevisions([])
  }

  function findMatchingMaterialId(part: Part) {
    const match = materials.find((material) => {
      if (material.material_type !== part.part_type) return false

      if (part.part_type === 'sheet') {
        return (
          (material.material || '') === (part.material || '') &&
          (material.thickness || '') === (part.thickness || '')
        )
      }

      return (
        (material.material || '') === (part.material || '') &&
        (material.tube_od || '') === (part.tube_od || '') &&
        (material.tube_wall || '') === (part.tube_wall || '')
      )
    })

    return match?.id || ''
  }

  function startEdit(part: Part) {
    setEditingId(part.id)
    setSelectedDxfFile(null)
    setWeightUnit('lbs')
    setForm({
      id: part.id,
      part_number: part.part_number,
      description: part.description,
      part_type: part.part_type,
      material_id: findMatchingMaterialId(part),
      cut_length: part.cut_length == null ? '' : String(part.cut_length),
      weight_lbs: part.weight_lbs == null ? '' : String(part.weight_lbs),
      dxf_file: part.dxf_file || '',
      notes: part.notes || '',
      requires_laser:      part.requires_laser,
      requires_sheet_bend: part.requires_sheet_bend,
      requires_tube_bend:  part.requires_tube_bend,
      requires_saw:        part.requires_saw,
      requires_drill:      part.requires_drill,
      requires_weld:       part.requires_weld,
      requires_powder:     part.requires_powder,
    })
    setMessage('')
    setOpMessage('')
    void loadOperations(part.id)
    void loadUsage(part.id)
    void loadRevisions(part.id)
  }

  function duplicatePart(part: Part) {
    setEditingId(null)
    setSelectedDxfFile(null)
    setWeightUnit('lbs')
    setForm({
      id: `${part.id}-COPY`,
      part_number: `${part.part_number}-COPY`,
      description: part.description,
      part_type: part.part_type,
      material_id: findMatchingMaterialId(part),
      cut_length: part.cut_length == null ? '' : String(part.cut_length),
      weight_lbs: part.weight_lbs == null ? '' : String(part.weight_lbs),
      dxf_file: part.dxf_file || '',
      notes: part.notes || '',
      requires_laser:      part.requires_laser,
      requires_sheet_bend: part.requires_sheet_bend,
      requires_tube_bend:  part.requires_tube_bend,
      requires_saw:        part.requires_saw,
      requires_drill:      part.requires_drill,
      requires_weld:       part.requires_weld,
      requires_powder:     part.requires_powder,
    })
    setMessage('Duplicated into form. Change the part number and save.')
  }

  async function uploadSelectedDxfIfNeeded() {
    if (form.part_type !== 'sheet') return form.dxf_file.trim() || null
    if (!selectedDxfFile) return form.dxf_file.trim() || null

    const fileName = selectedDxfFile.name.trim()
    if (!fileName.toLowerCase().endsWith('.dxf')) {
      throw new Error('Only .dxf files are allowed.')
    }

    setUploading(true)

    const { error } = await supabase.storage
      .from(DXF_BUCKET)
      .upload(fileName, selectedDxfFile, { upsert: true })

    setUploading(false)

    if (error) {
      throw new Error(error.message)
    }

    return fileName
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMessage('')

    const selectedMaterial = materials.find((material) => material.id === form.material_id)

    if (!selectedMaterial) {
      setMessage('Choose a material from the library.')
      setSaving(false)
      return
    }

    try {
      const uploadedDxfFileName = await uploadSelectedDxfIfNeeded()

      const payload = {
        id: form.id.trim(),
        part_number: form.part_number.trim(),
        description: form.description.trim(),
        part_type: form.part_type as 'tube' | 'sheet',
        material: selectedMaterial.material || null,
        thickness: form.part_type === 'sheet' ? selectedMaterial.thickness || null : null,
        tube_od: form.part_type === 'tube' ? selectedMaterial.tube_od || null : null,
        tube_wall: form.part_type === 'tube' ? selectedMaterial.tube_wall || null : null,
        tube_shape: form.part_type === 'tube'
          ? (selectedMaterial.tube_shape ?? (selectedMaterial.tube_od?.toLowerCase().includes('x') ? 'square' : 'round'))
          : 'round',
        cut_length:
          form.part_type === 'tube' && form.cut_length.trim() !== ''
            ? Number(form.cut_length)
            : null,
        weight_lbs: form.weight_lbs.trim() !== '' ? Number(form.weight_lbs) : null,
        dxf_file: form.part_type === 'sheet' ? uploadedDxfFileName : null,
        notes: form.notes.trim() || null,
        requires_laser:      form.requires_laser,
        requires_sheet_bend: form.requires_sheet_bend,
        requires_tube_bend:  form.requires_tube_bend,
        requires_saw:        form.requires_saw,
        requires_drill:      form.requires_drill,
        requires_weld:       form.requires_weld,
        requires_powder:     form.requires_powder,
      }

      if (!payload.id || !payload.part_number || !payload.description) {
        setMessage('ID, Part Number, and Description are required.')
        setSaving(false)
        return
      }

      if (
        payload.part_type === 'tube' &&
        payload.cut_length !== null &&
        Number.isNaN(payload.cut_length)
      ) {
        setMessage('Cut Length must be a valid number.')
        setSaving(false)
        return
      }

      if (editingId) {
        const oldPart = parts.find((p) => p.id === editingId)
        if (oldPart) await logRevision(editingId, oldPart, payload)
      }

      const query = editingId
        ? supabase.from('parts').update(payload).eq('id', editingId)
        : supabase.from('parts').insert(payload)

      const { error } = await query

      if (error) {
        setMessage(`${editingId ? 'Update' : 'Save'} failed: ${error.message}`)
      } else {
        setMessage(editingId ? 'Part updated.' : 'Part saved.')
        startNew()
        await loadParts()
      }
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }

    setSaving(false)
    setUploading(false)
  }

  async function handleDelete() {
    if (!editingId) return
    const ok = window.confirm(`Delete part ${editingId}?`)
    if (!ok) return

    const { error } = await supabase.from('parts').delete().eq('id', editingId)

    if (error) {
      setMessage(`Delete failed: ${error.message}`)
    } else {
      setMessage('Part deleted.')
      startNew()
      await loadParts()
    }
  }

  async function loadOperations(partId: string) {
    setLoadingOps(true)
    const { data, error } = await supabase
      .from('part_operations')
      .select('*')
      .eq('part_id', partId)
      .order('step', { ascending: true })
    if (!error) setOperations((data ?? []) as PartOperation[])
    setLoadingOps(false)
  }

  async function handleAddOperation(e: React.FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setSavingOp(true)
    setOpMessage('')
    const nextStep = operations.length > 0 ? Math.max(...operations.map((o) => o.step)) + 1 : 1
    const { error } = await supabase.from('part_operations').insert({
      part_id: editingId,
      step: nextStep,
      operation: opForm.operation,
      notes: opForm.notes.trim() || null,
    })
    if (error) {
      setOpMessage(`Failed: ${error.message}`)
    } else {
      setOpForm(emptyOpForm)
      await loadOperations(editingId)
    }
    setSavingOp(false)
  }

  async function handleDeleteOperation(id: string) {
    if (!editingId) return
    await supabase.from('part_operations').delete().eq('id', id)
    await loadOperations(editingId)
    // Re-number steps sequentially
    const updated = operations.filter((o) => o.id !== id)
    for (let i = 0; i < updated.length; i++) {
      await supabase.from('part_operations').update({ step: i + 1 }).eq('id', updated[i].id)
    }
    await loadOperations(editingId)
  }

  async function handleMoveOperation(id: string, direction: 'up' | 'down') {
    if (!editingId) return
    const idx = operations.findIndex((o) => o.id === id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= operations.length) return
    const a = operations[idx]
    const b = operations[swapIdx]
    await supabase.from('part_operations').update({ step: b.step }).eq('id', a.id)
    await supabase.from('part_operations').update({ step: a.step }).eq('id', b.id)
    await loadOperations(editingId)
  }

  async function loadUsage(partId: string) {
    setLoadingUsage(true)
    const [{ data: skuPartData }, { data: subPartData }] = await Promise.all([
      supabase
        .from('sku_parts')
        .select('qty, sku:skus(id, description)')
        .eq('part_id', partId),
      supabase
        .from('sub_assembly_parts')
        .select('qty, sub_assembly:sub_assemblies(id, name)')
        .eq('part_id', partId),
    ])
    const refs: UsageRef[] = []
    for (const row of (skuPartData ?? []) as any[]) {
      if (row.sku) refs.push({ type: 'sku', id: row.sku.id, name: row.sku.description || row.sku.id, qty: row.qty })
    }
    for (const row of (subPartData ?? []) as any[]) {
      if (row.sub_assembly) refs.push({ type: 'subassembly', id: row.sub_assembly.id, name: row.sub_assembly.name, qty: row.qty })
    }
    setUsageRefs(refs)
    setLoadingUsage(false)
  }

  async function loadRevisions(partId: string) {
    setLoadingRevisions(true)
    const { data } = await supabase
      .from('part_revisions')
      .select('*')
      .eq('part_id', partId)
      .order('changed_at', { ascending: false })
    setRevisions((data ?? []) as PartRevision[])
    setLoadingRevisions(false)
  }

  async function logRevision(partId: string, oldPart: Part, newValues: Record<string, unknown>) {
    const changed: string[] = []
    const oldVals: Record<string, unknown> = {}
    const newVals: Record<string, unknown> = {}
    const fields: (keyof Part)[] = ['part_number', 'description', 'part_type', 'material', 'thickness', 'tube_od', 'tube_wall', 'cut_length', 'dxf_file', 'notes']
    for (const f of fields) {
      if (String(oldPart[f] ?? '') !== String(newValues[f] ?? '')) {
        changed.push(f)
        oldVals[f] = oldPart[f]
        newVals[f] = newValues[f]
      }
    }
    if (changed.length === 0) return
    await supabase.from('part_revisions').insert({
      part_id: partId,
      changed_fields: changed.join(', '),
      old_values: JSON.stringify(oldVals),
      new_values: JSON.stringify(newVals),
    })
  }

  const filteredParts = parts.filter((part) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return [
      part.id,
      part.part_number,
      part.description,
      part.part_type,
      part.material || '',
      part.thickness || '',
      part.tube_od || '',
      part.tube_wall || '',
      part.cut_length ?? '',
      part.dxf_file || '',
    ]
      .join(' ')
      .toLowerCase()
      .includes(q)
  })

  const sheetParts = filteredParts.filter((part) => part.part_type === 'sheet')
  const tubeParts = filteredParts.filter((part) => part.part_type === 'tube')

  const tubeMaterials = materials.filter((material) => material.material_type === 'tube')
  const sheetMaterials = materials.filter((material) => material.material_type === 'sheet')
  const visibleMaterials = form.part_type === 'tube' ? tubeMaterials : sheetMaterials
  const selectedMaterial = materials.find((m) => m.id === form.material_id) || null

  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Parts</h1>
          <div className="page-subtitle">
            Manage the base part library and auto-generate DXF previews from Supabase Storage.
          </div>
        </div>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">{editingId ? `Edit Part: ${editingId}` : 'Add Part'}</h2>
          <div className="card-subtitle">
            Sheet parts can upload a DXF directly to the <strong>dxf-files</strong> bucket.
          </div>
        </div>

        <div className="card-body">
          <form onSubmit={handleSubmit}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: '14px',
              }}
            >
              <div>
                <label className="label">ID</label>
                <input
                  className="field"
                  value={form.id}
                  onChange={(e) => updateField('id', e.target.value)}
                  placeholder="44307-T1"
                  disabled={!!editingId}
                />
              </div>

              <div>
                <label className="label">Part Number</label>
                <input
                  className="field"
                  value={form.part_number}
                  onChange={(e) => updateField('part_number', e.target.value)}
                  placeholder="44307-T1"
                />
              </div>

              <div>
                <label className="label">Description</label>
                <input
                  className="field"
                  value={form.description}
                  onChange={(e) => updateField('description', e.target.value)}
                  placeholder="Main Tube"
                />
              </div>

              <div>
                <label className="label">Part Type</label>
                <select
                  className="select"
                  value={form.part_type}
                  onChange={(e) => updateField('part_type', e.target.value)}
                >
                  <option value="sheet">Sheet</option>
                  <option value="tube">Tube</option>
                </select>
              </div>

              <div style={{ gridColumn: 'span 2' }}>
                <label className="label">Material Library</label>
                <select
                  className="select"
                  value={form.material_id}
                  onChange={(e) => updateField('material_id', e.target.value)}
                >
                  <option value="">Select material</option>
                  {visibleMaterials.map((material) => (
                    <option key={material.id} value={material.id}>
                      {material.name}
                    </option>
                  ))}
                </select>
              </div>

              {form.part_type === 'sheet' ? (
                <>
                  <div>
                    <label className="label">DXF Filename</label>
                    <input
                      className="field"
                      value={form.dxf_file}
                      onChange={(e) => updateField('dxf_file', e.target.value)}
                      placeholder="29964.L1.dxf"
                    />
                  </div>

                  <div style={{ gridColumn: 'span 2' }}>
                    <label className="label">Upload DXF to Supabase</label>
                    <input
                      className="field"
                      type="file"
                      accept=".dxf"
                      onChange={(e) => {
                        const file = e.target.files?.[0] || null
                        setSelectedDxfFile(file)
                        if (file) updateField('dxf_file', file.name)
                      }}
                    />
                  </div>

                  <div style={{ gridColumn: '1 / -1' }}>
                    <label className="label">DXF Preview</label>
                    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <DxfPartPreview
                        dxfFile={form.dxf_file || null}
                        partNumber={form.part_number || form.id || 'Preview'}
                        size="small"
                      />
                      <div style={{ color: 'var(--muted)', fontSize: '0.9rem', maxWidth: 420 }}>
                        Save the part after selecting a DXF file. The app stores only the filename in{' '}
                        <code>dxf_file</code> and reads the actual DXF from the <strong>{DXF_BUCKET}</strong> bucket.
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div>
                  <label className="label">Cut Length</label>
                  <input
                    className="field"
                    value={form.cut_length}
                    onChange={(e) => updateField('cut_length', e.target.value)}
                    placeholder="32.5"
                  />
                </div>
              )}

              <div>
                <label className="label">Part Weight</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    className="field"
                    type="number"
                    step={weightUnit === 'oz' ? '0.1' : '0.001'}
                    min="0"
                    value={
                      // display in oz when oz mode: stored lbs × 16
                      weightUnit === 'oz' && form.weight_lbs !== ''
                        ? String(Math.round(parseFloat(form.weight_lbs) * 16 * 100) / 100)
                        : form.weight_lbs
                    }
                    onChange={(e) => {
                      const raw = e.target.value
                      if (raw === '') { updateField('weight_lbs', ''); return }
                      const num = parseFloat(raw)
                      if (isNaN(num)) return
                      // always store as lbs
                      const lbs = weightUnit === 'oz' ? num / 16 : num
                      updateField('weight_lbs', String(Math.round(lbs * 100000) / 100000))
                    }}
                    placeholder={weightUnit === 'oz' ? '37.6' : '2.35'}
                    style={{ flex: 1 }}
                  />
                  {/* lbs / oz toggle */}
                  <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
                    {(['lbs', 'oz'] as const).map((unit) => (
                      <button
                        key={unit}
                        type="button"
                        onClick={() => setWeightUnit(unit)}
                        style={{
                          padding: '0 10px', height: 34, fontSize: '0.78rem', fontWeight: 600,
                          background: weightUnit === unit ? 'var(--accent)' : 'var(--panel-2)',
                          color:      weightUnit === unit ? '#fff' : 'var(--text-2)',
                          border: 'none', cursor: 'pointer',
                        }}
                      >
                        {unit}
                      </button>
                    ))}
                  </div>
                </div>
                {form.weight_lbs !== '' && (
                  <div style={{ fontSize: '0.74rem', color: 'var(--muted)', marginTop: 4 }}>
                    = {weightUnit === 'oz'
                        ? `${form.weight_lbs} lbs`
                        : `${Math.round(parseFloat(form.weight_lbs) * 16 * 10) / 10} oz`
                      }
                  </div>
                )}
              </div>

              {selectedMaterial && (
                <div style={{ gridColumn: '1 / -1' }} className="warning-box">
                  <strong>Selected material:</strong>{' '}
                  {selectedMaterial.name}
                  {form.part_type === 'sheet' ? (
                    <span>
                      {' '}· Thickness: {selectedMaterial.thickness || '—'} · Material: {selectedMaterial.material || '—'}
                    </span>
                  ) : (
                    <span>
                      {' '}· OD: {selectedMaterial.tube_od || '—'} · Wall: {selectedMaterial.tube_wall || '—'} · Material: {selectedMaterial.material || '—'}
                    </span>
                  )}
                </div>
              )}

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

              {/* ── Manufacturing Stages ─────────────────────────────────────── */}
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="label">Manufacturing Stages</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 6 }}>
                  {(STAGE_KEYS.filter((k) => {
                    // Hide sheet-bend for tube parts and tube-bend for sheet parts
                    if (form.part_type === 'tube' && k === 'requires_sheet_bend') return false
                    if (form.part_type === 'sheet' && k === 'requires_tube_bend') return false
                    return true
                  })).map((key) => (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-2)' }}>
                      <input
                        type="checkbox"
                        checked={form[key]}
                        onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.checked }))}
                        style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }}
                      />
                      {STAGE_LABELS[key]}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="btn-row" style={{ marginTop: 18 }}>
              <button type="submit" disabled={saving || uploading} className="btn btn-primary">
                {saving || uploading ? 'Saving...' : editingId ? 'Update Part' : 'Save Part'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={startNew}>
                New
              </button>
              {editingId && (
                <button type="button" className="btn btn-danger" onClick={handleDelete}>
                  Delete
                </button>
              )}
            </div>

            {message && <div className="message">{message}</div>}
          </form>
        </div>
      </section>

      {/* ── Operation Routing ── */}
      {editingId && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Manufacturing Route</h2>
            <div className="card-subtitle">
              Define the ordered operations this part goes through — e.g. Laser Cut → Bend → Weld.
            </div>
          </div>

          <div className="card-body">
            {/* Route flow display */}
            {operations.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 20 }}>
                {operations.map((op, i) => (
                  <div key={op.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{
                      background: 'var(--accent-soft)',
                      border: '1px solid var(--accent-border)',
                      borderRadius: 20,
                      padding: '4px 14px',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      color: '#ffd7c4',
                      whiteSpace: 'nowrap',
                    }}>
                      {op.step}. {op.operation}
                    </div>
                    {i < operations.length - 1 && (
                      <span style={{ color: 'var(--muted)', fontSize: '1rem' }}>→</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="grid-2" style={{ alignItems: 'start', gap: 24 }}>
              {/* Add operation form */}
              <form onSubmit={handleAddOperation}>
                <div className="group-title" style={{ marginBottom: 12 }}>Add Step</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label className="label">Operation</label>
                    <select
                      className="select"
                      value={opForm.operation}
                      onChange={(e) => setOpForm((p) => ({ ...p, operation: e.target.value }))}
                    >
                      {OPERATION_OPTIONS.map((op) => (
                        <option key={op} value={op}>{op}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Notes (optional)</label>
                    <input
                      className="field"
                      value={opForm.notes}
                      onChange={(e) => setOpForm((p) => ({ ...p, notes: e.target.value }))}
                      placeholder="e.g. 90° bend, 4 places"
                    />
                  </div>
                </div>
                <div className="btn-row" style={{ marginTop: 12 }}>
                  <button type="submit" disabled={savingOp} className="btn btn-primary">
                    {savingOp ? 'Adding…' : 'Add Step'}
                  </button>
                </div>
                {opMessage && <div className="message">{opMessage}</div>}
              </form>

              {/* Steps table */}
              <div>
                <div className="group-title" style={{ marginBottom: 12 }}>
                  Steps {loadingOps ? '(loading…)' : `(${operations.length})`}
                </div>
                {operations.length === 0 ? (
                  <div className="empty">No operations added yet.</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ width: 40 }}>#</th>
                          <th>Operation</th>
                          <th>Notes</th>
                          <th style={{ width: 100 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {operations.map((op, i) => (
                          <tr key={op.id}>
                            <td style={{ fontWeight: 700, color: 'var(--accent)' }}>{op.step}</td>
                            <td style={{ fontWeight: 600 }}>{op.operation}</td>
                            <td style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>{op.notes || ''}</td>
                            <td>
                              <div style={{ display: 'flex', gap: 4 }}>
                                <button
                                  className="btn btn-secondary"
                                  style={{ padding: '3px 7px', fontSize: '0.78rem' }}
                                  onClick={() => handleMoveOperation(op.id, 'up')}
                                  disabled={i === 0}
                                >↑</button>
                                <button
                                  className="btn btn-secondary"
                                  style={{ padding: '3px 7px', fontSize: '0.78rem' }}
                                  onClick={() => handleMoveOperation(op.id, 'down')}
                                  disabled={i === operations.length - 1}
                                >↓</button>
                                <button
                                  className="btn btn-danger"
                                  style={{ padding: '3px 7px', fontSize: '0.78rem' }}
                                  onClick={() => handleDeleteOperation(op.id)}
                                >✕</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Part Usage Map + Revision Log ── */}
      {editingId && (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          {/* Usage map */}
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Used In</h2>
              <div className="card-subtitle">Every SKU and subassembly that includes this part.</div>
            </div>
            <div className="card-body">
              {loadingUsage ? (
                <div className="empty">Loading…</div>
              ) : usageRefs.length === 0 ? (
                <div className="empty">Not used in any SKU or subassembly yet.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Type</th><th>ID / Name</th><th>Qty per</th></tr>
                    </thead>
                    <tbody>
                      {usageRefs.map((ref) => (
                        <tr key={`${ref.type}-${ref.id}`}>
                          <td>
                            <span style={{
                              fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase',
                              background: ref.type === 'sku' ? 'rgba(100,160,220,0.15)' : 'rgba(220,150,80,0.15)',
                              color: ref.type === 'sku' ? '#7ab4e8' : '#e0a050',
                              border: `1px solid ${ref.type === 'sku' ? 'rgba(100,160,220,0.25)' : 'rgba(220,150,80,0.25)'}`,
                              borderRadius: 4, padding: '1px 6px',
                            }}>
                              {ref.type === 'sku' ? 'SKU' : 'Sub'}
                            </span>
                          </td>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{ref.id}</div>
                            <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>{ref.name}</div>
                          </td>
                          <td style={{ fontWeight: 700, color: 'var(--accent)' }}>×{ref.qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {/* Revision log */}
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Revision Log</h2>
              <div className="card-subtitle">Every time this part was updated.</div>
            </div>
            <div className="card-body">
              {loadingRevisions ? (
                <div className="empty">Loading…</div>
              ) : revisions.length === 0 ? (
                <div className="empty">No revisions recorded yet.</div>
              ) : (
                <div className="section-stack" style={{ gap: 10 }}>
                  {revisions.map((rev) => (
                    <div key={rev.id} style={{
                      background: 'var(--panel-2)', border: '1px solid var(--border)',
                      borderRadius: 6, padding: '10px 14px',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--accent)' }}>
                          {rev.changed_fields}
                        </span>
                        <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>
                          {new Date(rev.changed_at).toLocaleString()}
                        </span>
                      </div>
                      {(() => {
                        const oldV = JSON.parse(rev.old_values || '{}')
                        const newV = JSON.parse(rev.new_values || '{}')
                        return rev.changed_fields.split(', ').map((field) => (
                          <div key={field} style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 2 }}>
                            <strong style={{ color: 'var(--text)' }}>{field}:</strong>{' '}
                            <span style={{ textDecoration: 'line-through', opacity: 0.6 }}>{String(oldV[field] ?? '—')}</span>
                            {' → '}
                            <span style={{ color: '#7ab4e8' }}>{String(newV[field] ?? '—')}</span>
                          </div>
                        ))
                      })()}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      <section className="card">
        <div
          className="card-header"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
        >
          <div>
            <h2 className="card-title">Part Library</h2>
            <div className="card-subtitle">
              Sheet and tube parts are split into separate tables.
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
              placeholder="Search part number, description, material..."
              style={{ paddingLeft: 36 }}
            />
          </div>
        </div>

        <div className="card-body section-stack" style={{ gap: 28 }}>
          {(['sheet', 'tube'] as const).map((ptype) => {
            const group = ptype === 'sheet' ? sheetParts : tubeParts
            const typeColor = ptype === 'sheet'
              ? { bg: 'rgba(100,160,220,0.15)', text: '#7ab4e8', border: 'rgba(100,160,220,0.25)' }
              : { bg: 'rgba(220,150,80,0.15)', text: '#e0a050', border: 'rgba(220,150,80,0.25)' }

            return (
              <div key={ptype}>
                <div className="group-title" style={{ marginBottom: 12 }}>
                  {ptype === 'sheet' ? 'Sheet Parts' : 'Tube Parts'}
                  {group.length > 0 && (
                    <span style={{
                      marginLeft: 8, fontSize: '0.68rem', background: 'var(--panel-2)',
                      border: '1px solid var(--border)', borderRadius: 4, padding: '1px 7px',
                      color: 'var(--muted)', fontWeight: 600, textTransform: 'none', letterSpacing: 0,
                    }}>{group.length}</span>
                  )}
                </div>
                {loading ? (
                  <div className="empty">Loading…</div>
                ) : group.length === 0 ? (
                  <div className="empty">No matching {ptype} parts.</div>
                ) : (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(195px, 1fr))',
                    gap: 10,
                    alignItems: 'start',
                  }}>
                    {group.map((part) => {
                      const isActive  = editingId === part.id
                      const isSquare  = part.tube_shape === 'square' || (part.tube_od ?? '').toLowerCase().includes('x')
                      const dims      = ptype === 'sheet'
                        ? [part.thickness, part.material].filter(Boolean).join(' · ')
                        : [part.tube_od, part.tube_wall, part.material].filter(Boolean).join(' · ')

                      return (
                        <div
                          key={part.id}
                          id={`part-row-${part.id}`}
                          style={{
                            background: isActive ? 'var(--accent-soft)' : 'var(--panel-2)',
                            border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                            borderRadius: 8,
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden',
                            transition: 'border-color 0.13s',
                          }}
                          onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)' }}
                          onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
                        >
                          {/* ── Preview ── */}
                          <div
                            style={{
                              height: 110, flexShrink: 0, background: 'var(--panel)',
                              borderBottom: '1px solid var(--border)', cursor: 'pointer',
                            }}
                            onClick={() => startEdit(part)}
                          >
                            <DxfPartPreview
                              dxfFile={part.dxf_file}
                              partNumber={part.part_number}
                              size="fill"
                              isTube={ptype === 'tube'}
                              tubeFallback={true}
                              tubeOd={part.tube_od}
                              tubeWall={part.tube_wall}
                              tubeShape={isSquare ? 'square' : 'round'}
                              cutLength={part.cut_length}
                            />
                          </div>

                          {/* ── Info ── */}
                          <div
                            style={{ padding: '9px 11px 6px', flex: 1, cursor: 'pointer' }}
                            onClick={() => startEdit(part)}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span style={{
                                fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase',
                                letterSpacing: '0.07em', background: typeColor.bg, color: typeColor.text,
                                border: `1px solid ${typeColor.border}`, borderRadius: 4,
                                padding: '2px 5px', flexShrink: 0, lineHeight: 1.4,
                              }}>
                                {ptype}
                              </span>
                              <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text)', wordBreak: 'break-word', lineHeight: 1.2 }}>
                                {part.part_number}
                              </span>
                            </div>
                            {part.description && (
                              <div style={{
                                fontSize: '0.74rem', color: 'var(--muted)', lineHeight: 1.4, marginTop: 4,
                                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                              }}>
                                {part.description}
                              </div>
                            )}
                            {dims && (
                              <div style={{ fontSize: '0.7rem', color: typeColor.text, fontWeight: 600, marginTop: 3 }}>
                                {dims}
                              </div>
                            )}
                            {ptype === 'tube' && part.cut_length != null && (
                              <div style={{ fontSize: '0.68rem', color: 'var(--muted)', marginTop: 2 }}>
                                Cut: {part.cut_length}&Prime; ({(part.cut_length / 12).toFixed(2)} ft)
                              </div>
                            )}
                            {part.weight_lbs != null && (
                              <div style={{ fontSize: '0.68rem', color: 'var(--muted)', marginTop: 1 }}>
                                {part.weight_lbs} lbs ({Math.round(part.weight_lbs * 16 * 10) / 10} oz)
                              </div>
                            )}
                            {/* Stage badges */}
                            {(() => {
                              const activeStages = STAGE_KEYS.filter((k) => part[k])
                              if (activeStages.length === 0) return null
                              return (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 5 }}>
                                  {activeStages.map((k) => (
                                    <span key={k} style={{
                                      fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.04em',
                                      background: 'var(--panel-2)', color: 'var(--accent)',
                                      border: '1px solid var(--accent)', borderRadius: 3,
                                      padding: '1px 5px', lineHeight: 1.5,
                                    }}>
                                      {STAGE_LABELS[k]}
                                    </span>
                                  ))}
                                </div>
                              )
                            })()}
                          </div>

                          {/* ── Actions ── */}
                          <div style={{ padding: '4px 8px 8px', display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ flex: 1, fontSize: '0.74rem', height: 28 }}
                              onClick={() => startEdit(part)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ fontSize: '0.74rem', height: 28, padding: '0 9px' }}
                              onClick={(e) => { e.stopPropagation(); duplicatePart(part) }}
                            >
                              Dup
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* ── CSV Bulk Import ── */}
      <section className="card">
        <div
          className="card-header"
          style={{ cursor: 'pointer' }}
          onClick={() => { setImportOpen((v) => !v); setImportMessage('') }}
        >
          <div style={{ flex: 1 }}>
            <h2 className="card-title">Import Parts from CSV</h2>
            <div className="card-subtitle">
              Bulk-create or update parts by uploading a CSV file. Existing parts with the same ID are updated.
            </div>
          </div>
          <button type="button" className="btn btn-secondary" style={{ flexShrink: 0 }}>
            {importOpen ? 'Collapse ▲' : 'Expand ▼'}
          </button>
        </div>

        {importOpen && (
          <div className="card-body">
            {/* Template + upload */}
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 18 }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <label className="label">Upload CSV file</label>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="field"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleCsvFile(f)
                  }}
                />
                <div style={{ fontSize: '0.76rem', color: 'var(--muted)', marginTop: 5 }}>
                  Required columns: <code style={{ background: 'var(--panel-2)', padding: '1px 4px', borderRadius: 3 }}>id, part_number, description, part_type</code>
                  <br />
                  Optional: <code style={{ background: 'var(--panel-2)', padding: '1px 4px', borderRadius: 3 }}>material, thickness, tube_od, tube_wall, cut_length, notes</code>
                </div>
              </div>
              <div style={{ paddingTop: 22 }}>
                <button type="button" className="btn btn-secondary" onClick={downloadTemplate}>
                  ↓ Download Template
                </button>
              </div>
            </div>

            {/* Preview table */}
            {csvRows.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                    <span style={{ color: '#27ae60', fontWeight: 700 }}>
                      {csvRows.filter((r) => r.errors.length === 0).length} valid
                    </span>
                    {csvRows.filter((r) => r.errors.length > 0).length > 0 && (
                      <span style={{ color: 'var(--danger)', fontWeight: 700, marginLeft: 10 }}>
                        {csvRows.filter((r) => r.errors.length > 0).length} with errors
                      </span>
                    )}
                    <span style={{ marginLeft: 10 }}>
                      of {csvRows.length} row{csvRows.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleImport}
                    disabled={importing || csvRows.every((r) => r.errors.length > 0)}
                  >
                    {importing ? 'Importing…' : `Import ${csvRows.filter((r) => r.errors.length === 0).length} Parts`}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => { setCsvRows([]); setImportMessage('') }}
                  >
                    Clear
                  </button>
                </div>

                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 28 }}></th>
                        <th>ID</th>
                        <th>Part #</th>
                        <th>Description</th>
                        <th>Type</th>
                        <th>Material</th>
                        <th>Thickness</th>
                        <th>OD</th>
                        <th>Wall</th>
                        <th>Cut Length</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {csvRows.map((row, i) => (
                        <tr
                          key={i}
                          style={{
                            background: row.errors.length > 0 ? 'rgba(231,76,60,0.08)' : undefined,
                          }}
                        >
                          <td style={{ textAlign: 'center' }}>
                            {row.errors.length === 0 ? (
                              <span style={{ color: '#27ae60', fontSize: '0.85rem' }}>✓</span>
                            ) : (
                              <span
                                title={row.errors.join('\n')}
                                style={{ color: 'var(--danger)', fontSize: '0.85rem', cursor: 'help' }}
                              >
                                ✕
                              </span>
                            )}
                          </td>
                          <td style={{ fontSize: '0.8rem' }}>{row.id}</td>
                          <td style={{ fontWeight: 600, fontSize: '0.82rem' }}>{row.part_number}</td>
                          <td style={{ fontSize: '0.8rem' }}>{row.description}</td>
                          <td>
                            <span style={{
                              fontSize: '0.68rem',
                              fontWeight: 700,
                              background: row.part_type === 'sheet' ? 'rgba(100,160,220,0.15)' : 'rgba(220,150,80,0.15)',
                              color: row.part_type === 'sheet' ? '#7ab4e8' : '#e0a050',
                              borderRadius: 4,
                              padding: '1px 5px',
                            }}>
                              {row.part_type}
                            </span>
                          </td>
                          <td style={{ fontSize: '0.8rem' }}>{row.material}</td>
                          <td style={{ fontSize: '0.8rem' }}>{row.thickness}</td>
                          <td style={{ fontSize: '0.8rem' }}>{row.tube_od}</td>
                          <td style={{ fontSize: '0.8rem' }}>{row.tube_wall}</td>
                          <td style={{ fontSize: '0.8rem' }}>{row.cut_length}</td>
                          <td style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{row.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Validation errors summary */}
                {csvRows.some((r) => r.errors.length > 0) && (
                  <div className="warning-box" style={{ marginTop: 12 }}>
                    <strong>Row errors (hover ✕ for details):</strong>
                    <ul className="warning-list">
                      {csvRows.flatMap((r, i) =>
                        r.errors.map((e) => (
                          <li key={`${i}-${e}`}>Row {i + 1} ({r.part_number || '?'}): {e}</li>
                        ))
                      )}
                    </ul>
                  </div>
                )}
              </>
            )}

            {importMessage && (
              <div
                className="message"
                style={{
                  marginTop: 12,
                  color: importMessage.startsWith('✓') ? '#27ae60' : undefined,
                }}
              >
                {importMessage}
              </div>
            )}
          </div>
        )}
      </section>

      {previewPart && (
        <div
          onClick={() => setPreviewPart(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.66)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(1080px, 96vw)',
              maxHeight: '92vh',
              overflow: 'auto',
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 18,
              padding: 18,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 16,
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>{previewPart.part_number}</div>
                <div style={{ color: 'var(--muted)' }}>{previewPart.description}</div>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setPreviewPart(null)}>
                Close
              </button>
            </div>

            <DxfPartPreview
              dxfFile={previewPart.dxf_file}
              partNumber={previewPart.part_number}
              size="large"
            />
          </div>
        </div>
      )}
    </div>
  )
}