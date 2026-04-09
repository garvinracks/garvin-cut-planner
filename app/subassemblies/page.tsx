'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import DxfPartPreview from '@/components/DxfPartPreview'
import PartPickerModal from '@/components/PartPickerModal'

type SubAssembly = {
  id: string
  name: string
  notes: string | null
}

type Part = {
  id: string
  part_number: string
  description: string
  part_type: 'tube' | 'sheet'
  dxf_file: string | null
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
}

export default function SubassembliesPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

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

  const [partIdToAdd, setPartIdToAdd] = useState('')
  const [partLabelToAdd, setPartLabelToAdd] = useState('')
  const [qtyToAdd, setQtyToAdd] = useState('1')
  const [addingPart, setAddingPart] = useState(false)
  const [partMessage, setPartMessage] = useState('')
  const [partPickerOpen, setPartPickerOpen] = useState(false)

  async function loadSubassemblies() {
    const { data, error } = await supabase
      .from('sub_assemblies')
      .select('*')
      .order('name', { ascending: true })

    if (error) {
      setMessage(`Load failed: ${error.message}`)
      setItems([])
      return
    }

    const rows = (data ?? []) as SubAssembly[]
    setItems(rows)

    if (!selectedSubassemblyId && rows.length > 0) {
      setSelectedSubassemblyId(rows[0].id)
    }
  }

  async function loadParts() {
    const { data, error } = await supabase
      .from('parts')
      .select('id, part_number, description, part_type, dxf_file')
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
    await loadSubassemblies()
    await loadParts()
    setLoading(false)
  }

  useEffect(() => {
    initialLoad()
  }, [])

  useEffect(() => {
    if (selectedSubassemblyId) {
      loadSelectedSubassemblyParts(selectedSubassemblyId)
    }
  }, [selectedSubassemblyId])

  function updateField(name: string, value: string) {
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  function startNew() {
    setEditingId(null)
    setForm(emptySubassemblyForm)
    setMessage('')
  }

  function startEdit(item: SubAssembly) {
    setEditingId(item.id)
    setSelectedSubassemblyId(item.id)
    setForm({
      id: item.id,
      name: item.name,
      notes: item.notes || '',
    })
    setMessage('')
  }

  function duplicateSubassembly(item: SubAssembly) {
    setEditingId(null)
    setForm({
      id: `${item.id}-COPY`,
      name: `${item.name} Copy`,
      notes: item.notes || '',
    })
    setMessage('Duplicated into form. Save it, then add/edit parts as needed.')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMessage('')

    const payload = {
      id: form.id.trim(),
      name: form.name.trim(),
      notes: form.notes.trim() || null,
    }

    if (!payload.id || !payload.name) {
      setMessage('ID and Name are required.')
      setSaving(false)
      return
    }

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

      <section className="card">
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
                <label className="label">ID</label>
                <input
                  className="field"
                  value={form.id}
                  onChange={(e) => updateField('id', e.target.value)}
                  placeholder="44307-SIDE"
                  disabled={!!editingId}
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
              <div className="empty">Loading...</div>
            ) : filteredItems.length === 0 ? (
              <div className="empty">No matching subassemblies.</div>
            ) : (
              <div className="section-stack" style={{ gap: 10 }}>
                {filteredItems.map((item) => (
                  <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => startEdit(item)}
                      className={`sidebar-link ${selectedSubassemblyId === item.id ? 'active' : ''}`}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        background: selectedSubassemblyId === item.id ? 'var(--accent-soft)' : 'var(--panel-2)',
                        borderColor: selectedSubassemblyId === item.id ? 'rgba(216, 87, 22, 0.38)' : 'var(--border)',
                        color: selectedSubassemblyId === item.id ? '#ffd7c4' : 'var(--text)',
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{item.id}</div>
                      <div style={{ fontSize: '0.9rem', color: selectedSubassemblyId === item.id ? '#ffd7c4' : 'var(--muted)' }}>
                        {item.name}
                      </div>
                    </button>

                    <button className="btn btn-secondary" onClick={() => duplicateSubassembly(item)}>
                      Duplicate
                    </button>
                  </div>
                ))}
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
                                    tubeFallback={false}
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
