'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import DxfPartPreview from '@/components/DxfPartPreview'
import PartPickerModal from '@/components/PartPickerModal'

const IMAGE_BUCKET = 'subassembly-images'

type SubAssembly = {
  id: string
  name: string
  notes: string | null
  image_file: string | null
  requires_weld: boolean
}

type Part = {
  id: string
  part_number: string
  description: string
  part_type: 'tube' | 'sheet'
  dxf_file: string | null
  material: string | null
  thickness: string | null
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
}

const emptySubassemblyForm = {
  id: '',
  name: '',
  notes: '',
  requires_weld: true,
}

export default function SubassembliesPage() {
  const supabase = useMemo(() => createBrowserClient(), [])
  const formTopRef = useRef<HTMLElement>(null)

  const [items, setItems] = useState<SubAssembly[]>([])
  const [parts, setParts] = useState<Part[]>([])
  const [selectedSubassemblyId, setSelectedSubassemblyId] = useState('')
  const [selectedSubassemblyParts, setSelectedSubassemblyParts] = useState<SubAssemblyPartRow[]>([])

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(emptySubassemblyForm)

  // Image upload
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imageMessage, setImageMessage] = useState('')
  const [bucketOk, setBucketOk] = useState<boolean | null>(null) // null = not checked yet

  const [partIdToAdd, setPartIdToAdd] = useState('')
  const [partLabelToAdd, setPartLabelToAdd] = useState('')
  const [qtyToAdd, setQtyToAdd] = useState('1')
  const [addingPart, setAddingPart] = useState(false)
  const [partMessage, setPartMessage] = useState('')
  const [partPickerOpen, setPartPickerOpen] = useState(false)

  // Check that the storage bucket exists by attempting a list
  async function checkBucket() {
    const { error } = await supabase.storage.from(IMAGE_BUCKET).list('', { limit: 1 })
    setBucketOk(!error)
  }

  async function loadSubassemblies() {
    // Use select('*') so the query succeeds even if image_file column hasn't
    // been added yet via migration. We normalise the result below.
    const { data, error } = await supabase
      .from('sub_assemblies')
      .select('*')
      .order('name', { ascending: true })

    if (error) {
      setMessage(`Load failed: ${error.message}`)
      setItems([])
      return
    }

    const rows: SubAssembly[] = ((data ?? []) as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      notes: r.notes ?? null,
      image_file: r.image_file ?? null,
      requires_weld: r.requires_weld ?? false,
    }))
    setItems(rows)

    if (!selectedSubassemblyId && rows.length > 0) {
      setSelectedSubassemblyId(rows[0].id)
    }
  }

  async function loadParts() {
    const { data, error } = await supabase
      .from('parts')
      .select('id, part_number, description, part_type, dxf_file, material, thickness, tube_od, tube_wall, tube_shape, cut_length')
      .order('part_number', { ascending: true })

    if (error) {
      setMessage(`Parts load failed: ${error.message}`)
      setParts([])
      return
    }

    setParts((data ?? []) as Part[])
  }

  async function loadSelectedSubassemblyParts(subassemblyId: string) {
    if (!subassemblyId) {
      setSelectedSubassemblyParts([])
      return
    }

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
      setPartMessage(`Subassembly parts load failed: ${error.message}`)
      setSelectedSubassemblyParts([])
      return
    }

    const rows: SubAssemblyPartRow[] = ((data ?? []) as any[]).map((row) => ({
      id: row.id,
      qty: Number(row.qty),
      part_id: row.part_id,
      part_number: row.part?.part_number ?? row.part_id,
      part_description: row.part?.description ?? '',
    }))

    setSelectedSubassemblyParts(rows)
  }

  async function initialLoad() {
    setLoading(true)
    setMessage('')
    await Promise.all([loadSubassemblies(), loadParts(), checkBucket()])
    setLoading(false)
  }

  useEffect(() => {
    initialLoad()
  }, [])

  // Auto-select subassembly from ?id= query param after data loads
  useEffect(() => {
    if (loading || items.length === 0) return
    try {
      const params = new URLSearchParams(window.location.search)
      const idParam = params.get('id')
      if (!idParam) return
      const match = items.find((s) => s.id === idParam)
      if (match) {
        setSelectedSubassemblyId(match.id)
        setTimeout(() => {
          document.getElementById(`sub-row-${match.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 100)
      }
    } catch {
      // ignore
    }
  }, [loading, items])

  useEffect(() => {
    if (selectedSubassemblyId) {
      loadSelectedSubassemblyParts(selectedSubassemblyId)
    }
  }, [selectedSubassemblyId])

  function updateField(name: string, value: string) {
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  function getImageUrl(imageFile: string | null) {
    if (!imageFile) return null
    return supabase.storage.from(IMAGE_BUCKET).getPublicUrl(imageFile).data.publicUrl
  }

  async function handleUploadImage(file: File) {
    if (!editingId) return
    setUploadingImage(true)
    setImageMessage('')
    const ext = file.name.split('.').pop()
    const filename = `${editingId}-${Date.now()}.${ext}`

    const { error: uploadError } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(filename, file, { upsert: true })

    if (uploadError) {
      const isRls = uploadError.message.toLowerCase().includes('security policy') ||
                    uploadError.message.toLowerCase().includes('row-level') ||
                    uploadError.message.toLowerCase().includes('rls') ||
                    (uploadError as any).statusCode === '403'
      if (isRls) {
        setImageMessage(
          `Upload blocked by storage policy. Run this SQL in your Supabase SQL Editor:\n\n` +
          `CREATE POLICY "allow_public_subassembly_images"\n` +
          `ON storage.objects FOR ALL TO public\n` +
          `USING (bucket_id = 'subassembly-images')\n` +
          `WITH CHECK (bucket_id = 'subassembly-images');`
        )
      } else {
        setImageMessage(`Upload failed: ${uploadError.message}`)
      }
      setUploadingImage(false)
      return
    }

    const { error: updateError } = await supabase
      .from('sub_assemblies')
      .update({ image_file: filename })
      .eq('id', editingId)

    if (updateError) {
      // File is in storage but DB record not updated — likely missing column
      setImageMessage(
        `File uploaded to storage but database update failed: ${updateError.message}. ` +
        `Run this in Supabase SQL editor: ALTER TABLE sub_assemblies ADD COLUMN IF NOT EXISTS image_file text;`
      )
    } else {
      setImageMessage('Photo saved.')
      setSelectedImageFile(null)
      await loadSubassemblies()
    }
    setUploadingImage(false)
  }

  async function handleRemoveImage() {
    if (!editingId) return
    const item = items.find((i) => i.id === editingId)
    if (item?.image_file) {
      await supabase.storage.from(IMAGE_BUCKET).remove([item.image_file])
    }
    await supabase.from('sub_assemblies').update({ image_file: null }).eq('id', editingId)
    setImageMessage('Image removed.')
    await loadSubassemblies()
  }

  function startNew() {
    setEditingId(null)
    setForm(emptySubassemblyForm)
    setMessage('')
    setSelectedImageFile(null)
    setImageMessage('')
  }

  function startEdit(item: SubAssembly) {
    setEditingId(item.id)
    setSelectedSubassemblyId(item.id)
    setForm({
      id: item.id,
      name: item.name,
      notes: item.notes || '',
      requires_weld: item.requires_weld,
    })
    setMessage('')
    // scrollIntoView is reliable on iOS Safari; window.scrollTo is not
    setTimeout(() => formTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function duplicateSubassembly(item: SubAssembly) {
    setEditingId(null)
    setForm({
      id: `${item.id}-COPY`,
      name: `${item.name} Copy`,
      notes: item.notes || '',
      requires_weld: item.requires_weld,
    })
    setMessage('Duplicated into form. Save it, then add/edit parts as needed.')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMessage('')

    const newId = form.id.trim()
    const payload = {
      id: newId,
      name: form.name.trim(),
      notes: form.notes.trim() || null,
      requires_weld: form.requires_weld,
    }

    if (!payload.id || !payload.name) {
      setMessage('ID and Name are required.')
      setSaving(false)
      return
    }

    // ── ID rename: insert new + re-point FK refs + delete old ─────────────────
    if (editingId && editingId !== newId) {
      const currentItem = items.find((i) => i.id === editingId)
      const { error: insertErr } = await supabase.from('sub_assemblies').insert({
        ...payload,
        image_file: currentItem?.image_file ?? null,
      })
      if (insertErr) {
        setMessage(`Rename failed: ${insertErr.message}`)
        setSaving(false)
        return
      }
      await Promise.all([
        supabase.from('sub_assembly_parts').update({ sub_assembly_id: newId }).eq('sub_assembly_id', editingId),
        supabase.from('sku_sub_assemblies').update({ sub_assembly_id: newId }).eq('sub_assembly_id', editingId),
      ])
      await supabase.from('sub_assemblies').delete().eq('id', editingId)
      setMessage(`Renamed ${editingId} → ${newId}.`)
      setEditingId(newId)
      setSelectedSubassemblyId(newId)
      await loadSubassemblies()
      setSaving(false)
      return
    }

    // ── Normal save / update ───────────────────────────────────────────────────
    const query = editingId
      ? supabase.from('sub_assemblies').update(payload).eq('id', editingId)
      : supabase.from('sub_assemblies').insert(payload)

    const { error } = await query

    if (error) {
      setMessage(`${editingId ? 'Update' : 'Save'} failed: ${error.message}`)
    } else {
      setMessage(editingId ? 'Subassembly updated.' : 'Subassembly saved.')
      startNew()
      await loadSubassemblies()
      setSelectedSubassemblyId(payload.id)
    }

    setSaving(false)
  }

  async function handleDeleteSubassembly() {
    if (!editingId) return
    const ok = window.confirm(`Delete subassembly ${editingId}?`)
    if (!ok) return

    const { error } = await supabase.from('sub_assemblies').delete().eq('id', editingId)

    if (error) {
      setMessage(`Delete failed: ${error.message}`)
    } else {
      setMessage('Subassembly deleted.')
      setSelectedSubassemblyId('')
      startNew()
      await loadSubassemblies()
    }
  }

  async function handleAddPartToSubassembly(e: React.FormEvent) {
    e.preventDefault()
    setAddingPart(true)
    setPartMessage('')

    if (!selectedSubassemblyId) {
      setPartMessage('Select a subassembly first.')
      setAddingPart(false)
      return
    }

    if (!partIdToAdd) {
      setPartMessage('Choose a part.')
      setAddingPart(false)
      return
    }

    const qty = Number(qtyToAdd)
    if (!qty || qty <= 0) {
      setPartMessage('Qty must be greater than 0.')
      setAddingPart(false)
      return
    }

    const { error } = await supabase.from('sub_assembly_parts').insert({
      sub_assembly_id: selectedSubassemblyId,
      part_id: partIdToAdd,
      qty,
    })

    if (error) {
      setPartMessage(`Add part failed: ${error.message}`)
    } else {
      setPartMessage('Part added.')
      setPartIdToAdd('')
      setQtyToAdd('1')
      await loadSelectedSubassemblyParts(selectedSubassemblyId)
    }

    setAddingPart(false)
  }

  async function handleUpdateSubassemblyPartQty(rowId: string, qty: number) {
    if (!qty || qty <= 0) {
      setPartMessage('Qty must be greater than 0.')
      return
    }

    const { error } = await supabase.from('sub_assembly_parts').update({ qty }).eq('id', rowId)
    if (error) {
      setPartMessage(`Update qty failed: ${error.message}`)
    } else if (selectedSubassemblyId) {
      setPartMessage('Qty updated.')
      await loadSelectedSubassemblyParts(selectedSubassemblyId)
    }
  }

  async function handleDeleteSubassemblyPart(rowId: string) {
    const { error } = await supabase.from('sub_assembly_parts').delete().eq('id', rowId)
    if (error) {
      setPartMessage(`Delete part failed: ${error.message}`)
    } else if (selectedSubassemblyId) {
      setPartMessage('Part removed.')
      await loadSelectedSubassemblyParts(selectedSubassemblyId)
    }
  }

  const filteredItems = items.filter((item) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return `${item.id} ${item.name} ${item.notes || ''}`.toLowerCase().includes(q)
  })

  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Subassemblies</h1>
          <div className="page-subtitle">
            Build reusable grouped part sets that can be attached to SKUs.
          </div>
        </div>
      </div>

      {/* ── Storage setup warning ── */}
      {bucketOk === false && (
        <div className="warning-box" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--danger)' }}>
            ⚠️ Storage bucket not found — photos cannot be uploaded yet
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: '0.84rem', lineHeight: 1.6 }}>
            To fix this, do both of the following in your Supabase dashboard:
          </div>
          <ol style={{ margin: '0 0 0 20px', color: 'var(--text-2)', fontSize: '0.84rem', lineHeight: 2 }}>
            <li>
              Go to <strong>Storage</strong> → click <strong>New bucket</strong> → name it exactly{' '}
              <code style={{ background: 'rgba(0,0,0,0.2)', padding: '2px 6px', borderRadius: 4 }}>subassembly-images</code>
              {' '}→ enable <strong>Public bucket</strong> → Save.
            </li>
            <li>
              Go to <strong>SQL Editor</strong> → run these two statements:
              <pre style={{ background: 'rgba(0,0,0,0.25)', padding: '8px 10px', borderRadius: 6, marginTop: 6, fontSize: '0.78rem', lineHeight: 1.7, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
{`ALTER TABLE sub_assemblies ADD COLUMN IF NOT EXISTS image_file text;

CREATE POLICY "allow_public_subassembly_images"
ON storage.objects FOR ALL TO public
USING (bucket_id = 'subassembly-images')
WITH CHECK (bucket_id = 'subassembly-images');`}
              </pre>
            </li>
          </ol>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ alignSelf: 'flex-start', marginTop: 4 }}
            onClick={() => void checkBucket()}
          >
            Re-check setup
          </button>
        </div>
      )}

      <section className="card" ref={formTopRef}>
        <div className="card-header">
          <h2 className="card-title">{editingId ? `Edit Subassembly: ${editingId}` : 'Add Subassembly'}</h2>
          <div className="card-subtitle">
            Create and update reusable assemblies like side assemblies, brackets, or welded sets.
          </div>
        </div>

        <div className="card-body">
          <form onSubmit={handleSubmit}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '14px',
              }}
            >
              <div>
                <label className="label">ID {editingId && editingId !== form.id.trim() && (
                  <span style={{ color: 'var(--warning)', fontSize: '0.7rem', textTransform: 'none', letterSpacing: 0 }}>
                    {' '}— will rename from {editingId}
                  </span>
                )}</label>
                <input
                  className="field"
                  value={form.id}
                  onChange={(e) => updateField('id', e.target.value)}
                  placeholder="44307-SIDE"
                />
              </div>

              <div>
                <label className="label">Name</label>
                <input
                  className="field"
                  value={form.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder="44307 Side Assembly"
                />
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

              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={form.requires_weld}
                    onChange={(e) => setForm((prev) => ({ ...prev, requires_weld: e.target.checked }))}
                    style={{ width: 18, height: 18, accentColor: 'var(--accent)', cursor: 'pointer' }}
                  />
                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Requires Welding</span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>
                    — shows a weld checkbox in the batch progress table after all parts are cut/bent
                  </span>
                </label>
              </div>
            </div>

            <div className="btn-row" style={{ marginTop: 18 }}>
              <button
                type="submit"
                disabled={saving}
                className="btn btn-primary"
              >
                {saving ? 'Saving...' : editingId ? 'Update Subassembly' : 'Save Subassembly'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={startNew}>
                New
              </button>
              {editingId && (
                <button type="button" className="btn btn-danger" onClick={handleDeleteSubassembly}>
                  Delete
                </button>
              )}
            </div>

            {message && <div className="message">{message}</div>}
          </form>

          {/* Image upload — shown only when editing */}
          {editingId && (() => {
            const currentItem = items.find((i) => i.id === editingId)
            const imgUrl = getImageUrl(currentItem?.image_file ?? null)
            return (
              <div style={{ borderTop: '1px solid var(--border)', padding: '18px 20px' }}>
                <div className="group-title" style={{ marginBottom: 12 }}>Assembly Photo</div>
                <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  {imgUrl ? (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imgUrl}
                        alt={editingId}
                        style={{ width: 180, height: 130, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', display: 'block' }}
                      />
                      <button
                        type="button"
                        onClick={handleRemoveImage}
                        style={{
                          position: 'absolute', top: 6, right: 6,
                          background: 'rgba(0,0,0,0.7)', border: 'none', borderRadius: '50%',
                          width: 24, height: 24, cursor: 'pointer', color: '#fff', fontSize: '0.75rem',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >✕</button>
                    </div>
                  ) : (
                    <div style={{
                      width: 180, height: 130, borderRadius: 8, border: '1px dashed var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--muted)', fontSize: '0.8rem', flexShrink: 0,
                    }}>
                      No photo yet
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <label className="label">Upload Photo</label>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      style={{ display: 'block', marginBottom: 10, fontSize: '0.85rem', color: 'var(--muted)' }}
                      onChange={(e) => setSelectedImageFile(e.target.files?.[0] ?? null)}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={!selectedImageFile || uploadingImage}
                      onClick={() => selectedImageFile && handleUploadImage(selectedImageFile)}
                    >
                      {uploadingImage ? 'Uploading…' : 'Upload Photo'}
                    </button>
                    {imageMessage && (
                      <div
                        className={imageMessage.toLowerCase().includes('fail') || imageMessage.toLowerCase().includes('blocked') || imageMessage.toLowerCase().includes('error') ? 'warning-box' : 'message'}
                        style={{ marginTop: 8, fontSize: '0.78rem', whiteSpace: 'pre-wrap', fontFamily: 'monospace', lineHeight: 1.7 }}
                      >
                        {imageMessage}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h2 className="card-title">All Subassemblies</h2>
              <div className="card-subtitle">
                Click one to select it. Duplicate to create a variant quickly.
              </div>
            </div>
            <div style={{ minWidth: 220, flex: '0 0 260px', position: 'relative' }}>
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
                placeholder="Search ID or name..."
                style={{ paddingLeft: 36 }}
              />
            </div>
          </div>

          <div className="card-body">
            {loading ? (
              <div className="empty">Loading…</div>
            ) : filteredItems.length === 0 ? (
              <div className="empty">No matching subassemblies.</div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
                gap: 10,
                alignItems: 'start',
              }}>
                {filteredItems.map((item) => {
                  const imgUrl   = getImageUrl(item.image_file)
                  const isActive = selectedSubassemblyId === item.id
                  return (
                    <div
                      key={item.id}
                      id={`sub-row-${item.id}`}
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
                      {/* ── Photo ── */}
                      <div
                        style={{ height: 100, flexShrink: 0, cursor: 'pointer', position: 'relative' }}
                        onClick={() => startEdit(item)}
                      >
                        {imgUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={imgUrl}
                            alt={item.id}
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                        ) : (
                          <div style={{
                            width: '100%', height: '100%', background: 'var(--panel)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '2rem', color: 'var(--border-2)',
                            borderBottom: '1px solid var(--border)',
                          }}>
                            🔩
                          </div>
                        )}
                      </div>

                      {/* ── Info ── */}
                      <div
                        style={{ padding: '9px 11px 6px', flex: 1, cursor: 'pointer' }}
                        onClick={() => startEdit(item)}
                      >
                        <div style={{ fontWeight: 700, fontSize: '0.84rem', color: isActive ? 'var(--accent-text)' : 'var(--text)', lineHeight: 1.2 }}>
                          {item.id}
                        </div>
                        <div style={{ fontSize: '0.74rem', color: 'var(--muted)', marginTop: 3, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {item.name}
                        </div>
                        {item.requires_weld && (
                          <div style={{ marginTop: 5 }}>
                            <span style={{ fontSize: '0.65rem', fontWeight: 700, background: 'rgba(234,179,8,0.15)', color: '#facc15', borderRadius: 4, padding: '1px 6px' }}>
                              🔥 WELD
                            </span>
                          </div>
                        )}
                      </div>

                      {/* ── Actions ── */}
                      <div style={{ padding: '4px 8px 8px', display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ flex: 1, fontSize: '0.74rem', height: 28 }}
                          onClick={() => startEdit(item)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: '0.74rem', height: 28, padding: '0 9px' }}
                          onClick={(e) => { e.stopPropagation(); duplicateSubassembly(item) }}
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
        </section>

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Selected Subassembly Parts</h2>
            <div className="card-subtitle">
              Add parts and quantities to the currently selected subassembly.
            </div>
          </div>

          <div className="card-body">
            {!selectedSubassemblyId ? (
              <div className="empty">Select a subassembly.</div>
            ) : (
              <>
                <div style={{ marginBottom: 18 }}>
                  <div className="kicker">Selected</div>
                  <div className="group-title" style={{ marginBottom: 0 }}>{selectedSubassemblyId}</div>
                </div>

                <form onSubmit={handleAddPartToSubassembly} className="card" style={{ boxShadow: 'none' }}>
                  <div className="card-body">
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 140px',
                        gap: '14px',
                      }}
                    >
                      <div>
                        <label className="label">Part</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          {partIdToAdd ? (
                            <div
                              style={{
                                flex: 1,
                                background: 'var(--accent-soft)',
                                border: '1px solid var(--accent-border)',
                                borderRadius: 6,
                                padding: '7px 12px',
                                fontSize: '0.88rem',
                                color: 'var(--text)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 8,
                              }}
                            >
                              <span style={{ fontWeight: 600 }}>{partLabelToAdd}</span>
                              <button
                                type="button"
                                onClick={() => { setPartIdToAdd(''); setPartLabelToAdd('') }}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  color: 'var(--muted)',
                                  cursor: 'pointer',
                                  padding: 0,
                                  fontSize: '0.9rem',
                                  lineHeight: 1,
                                }}
                              >
                                ✕
                              </button>
                            </div>
                          ) : (
                            <div
                              style={{
                                flex: 1,
                                background: 'var(--panel-2)',
                                border: '1px solid var(--border)',
                                borderRadius: 6,
                                padding: '7px 12px',
                                fontSize: '0.85rem',
                                color: 'var(--muted)',
                              }}
                            >
                              No part selected
                            </div>
                          )}
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ whiteSpace: 'nowrap' }}
                            onClick={() => setPartPickerOpen(true)}
                          >
                            Browse Parts
                          </button>
                        </div>
                      </div>

                      <div>
                        <label className="label">Qty</label>
                        <input
                          className="field"
                          value={qtyToAdd}
                          onChange={(e) => setQtyToAdd(e.target.value)}
                          placeholder="1"
                        />
                      </div>
                    </div>

                    <div className="btn-row" style={{ marginTop: 18 }}>
                      <button
                        type="submit"
                        disabled={addingPart}
                        className="btn btn-primary"
                      >
                        {addingPart ? 'Adding...' : 'Add Part'}
                      </button>
                    </div>

                    {partMessage && <div className="message">{partMessage}</div>}
                  </div>
                </form>

                <div style={{ marginTop: 18 }}>
                  {selectedSubassemblyParts.length === 0 ? (
                    <div className="empty">No parts attached yet.</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th style={{ width: 120 }}>Preview</th>
                            <th>Part #</th>
                            <th>Description</th>
                            <th>Qty</th>
                            <th></th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedSubassemblyParts.map((row) => {
                            const fullPart = parts.find((part) => part.id === row.part_id)

                            return (
                              <tr key={row.id}>
                                <td>
                                  <DxfPartPreview
                                    dxfFile={fullPart?.dxf_file || null}
                                    partNumber={row.part_number}
                                    size="tiny"
                                    isTube={fullPart?.part_type === 'tube'}
                                    tubeFallback={true}
                                    tubeOd={fullPart?.tube_od ?? undefined}
                                    tubeWall={fullPart?.tube_wall ?? undefined}
                                    cutLength={fullPart?.cut_length ?? undefined}
                                    tubeShape="round"
                                  />
                                </td>
                                <td>{row.part_number}</td>
                                <td>{row.part_description}</td>
                                <td>
                                  <input
                                    className="field-sm"
                                    defaultValue={row.qty}
                                    onBlur={(e) => handleUpdateSubassemblyPartQty(row.id, Number(e.target.value))}
                                  />
                                </td>
                                <td>
                                  <button className="btn btn-secondary" onClick={() => handleUpdateSubassemblyPartQty(row.id, row.qty)}>
                                    Save
                                  </button>
                                </td>
                                <td>
                                  <button className="btn btn-danger" onClick={() => handleDeleteSubassemblyPart(row.id)}>
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
              </>
            )}
          </div>
        </section>
      </div>

      {partPickerOpen && (
        <PartPickerModal
          parts={parts}
          onClose={() => setPartPickerOpen(false)}
          onSelect={(part) => {
            setPartIdToAdd(part.id)
            setPartLabelToAdd(`${part.part_number} — ${part.description}`)
            setPartPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}
