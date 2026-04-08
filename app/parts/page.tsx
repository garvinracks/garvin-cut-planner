'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import DxfPartPreview from '@/components/DxfPartPreview'

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
  notes: string | null
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

const DXF_BUCKET = 'dxf-files'

const emptyForm = {
  id: '',
  part_number: '',
  description: '',
  part_type: 'sheet',
  material_id: '',
  cut_length: '',
  dxf_file: '',
  notes: '',
}

export default function PartsPage() {
  const supabase = useMemo(() => createBrowserClient(), [])
  const [parts, setParts] = useState<Part[]>([])
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

  useEffect(() => {
    void initialLoad()
  }, [])

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
    setForm({
      id: part.id,
      part_number: part.part_number,
      description: part.description,
      part_type: part.part_type,
      material_id: findMatchingMaterialId(part),
      cut_length: part.cut_length == null ? '' : String(part.cut_length),
      dxf_file: part.dxf_file || '',
      notes: part.notes || '',
    })
    setMessage('')
  }

  function duplicatePart(part: Part) {
    setEditingId(null)
    setSelectedDxfFile(null)
    setForm({
      id: `${part.id}-COPY`,
      part_number: `${part.part_number}-COPY`,
      description: part.description,
      part_type: part.part_type,
      material_id: findMatchingMaterialId(part),
      cut_length: part.cut_length == null ? '' : String(part.cut_length),
      dxf_file: part.dxf_file || '',
      notes: part.notes || '',
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
        cut_length:
          form.part_type === 'tube' && form.cut_length.trim() !== ''
            ? Number(form.cut_length)
            : null,
        dxf_file: form.part_type === 'sheet' ? uploadedDxfFileName : null,
        notes: form.notes.trim() || null,
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
          <div>
            <div className="group-title" style={{ marginBottom: 12 }}>
              Sheet Parts
            </div>

            {loading ? (
              <div className="empty">Loading...</div>
            ) : sheetParts.length === 0 ? (
              <div className="empty">No matching sheet parts.</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 180 }}>Preview</th>
                      <th>Part #</th>
                      <th>Description</th>
                      <th>Thickness</th>
                      <th>Material</th>
                      <th>DXF</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheetParts.map((part) => (
                      <tr
                        key={part.id}
                        style={{ background: editingId === part.id ? 'var(--accent-soft)' : 'transparent' }}
                      >
                        <td style={{ paddingTop: 12, paddingBottom: 12 }}>
                          <button
                            type="button"
                            onClick={() => setPreviewPart(part)}
                            style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}
                          >
                            <DxfPartPreview
                              dxfFile={part.dxf_file}
                              partNumber={part.part_number}
                              size="small"
                            />
                          </button>
                        </td>
                        <td onClick={() => startEdit(part)} style={{ cursor: 'pointer', fontWeight: 700 }}>
                          {part.part_number}
                        </td>
                        <td onClick={() => startEdit(part)} style={{ cursor: 'pointer' }}>
                          {part.description}
                        </td>
                        <td onClick={() => startEdit(part)} style={{ cursor: 'pointer' }}>
                          {part.thickness || ''}
                        </td>
                        <td onClick={() => startEdit(part)} style={{ cursor: 'pointer' }}>
                          {part.material || ''}
                        </td>
                        <td
                          onClick={() => startEdit(part)}
                          style={{
                            cursor: 'pointer',
                            color: 'var(--muted)',
                            fontSize: '0.88rem',
                            maxWidth: 180,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {part.dxf_file || ''}
                        </td>
                        <td>
                          <button type="button" className="btn btn-secondary" onClick={() => duplicatePart(part)}>
                            Duplicate
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <div className="group-title" style={{ marginBottom: 12 }}>
              Tube Parts
            </div>

            {loading ? (
              <div className="empty">Loading...</div>
            ) : tubeParts.length === 0 ? (
              <div className="empty">No matching tube parts.</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Part #</th>
                      <th>Description</th>
                      <th>OD</th>
                      <th>Wall</th>
                      <th>Cut Length</th>
                      <th>Material</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tubeParts.map((part) => (
                      <tr
                        key={part.id}
                        style={{ background: editingId === part.id ? 'var(--accent-soft)' : 'transparent' }}
                      >
                        <td onClick={() => startEdit(part)} style={{ cursor: 'pointer', fontWeight: 700 }}>
                          {part.part_number}
                        </td>
                        <td onClick={() => startEdit(part)} style={{ cursor: 'pointer' }}>
                          {part.description}
                        </td>
                        <td onClick={() => startEdit(part)} style={{ cursor: 'pointer' }}>
                          {part.tube_od || ''}
                        </td>
                        <td onClick={() => startEdit(part)} style={{ cursor: 'pointer' }}>
                          {part.tube_wall || ''}
                        </td>
                        <td onClick={() => startEdit(part)} style={{ cursor: 'pointer' }}>
                          {part.cut_length ?? ''}
                        </td>
                        <td onClick={() => startEdit(part)} style={{ cursor: 'pointer' }}>
                          {part.material || ''}
                        </td>
                        <td>
                          <button type="button" className="btn btn-secondary" onClick={() => duplicatePart(part)}>
                            Duplicate
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
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