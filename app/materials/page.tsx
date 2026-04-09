'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

type MaterialRow = {
  id: string
  name: string
  material_type: 'tube' | 'sheet'
  material: string | null
  thickness: string | null
  tube_od: string | null
  tube_wall: string | null
  notes: string | null
  cost_per_lb: number | null
  scrap_rate: number | null   // stored as 0–1 decimal (e.g. 0.10 = 10 %)
}

type PriceLogEntry = {
  id: string
  material_id: string
  price: number
  date_purchased: string
  order_number: string | null
  supplier: string | null
  notes: string | null
}

const emptyForm = {
  material_type: 'sheet',
  tube_shape: 'round',
  material: '',
  sheet_thickness: '',
  tube_dimension: '',
  wall_thickness: '',
  notes: '',
  cost_per_lb: '',
  scrap_rate: '',   // displayed as percent (e.g. "10" → stored as 0.10)
}

const emptyPriceForm = {
  price: '',
  date_purchased: new Date().toISOString().split('T')[0],
  order_number: '',
  supplier: '',
  notes: '',
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function buildMaterialName(form: typeof emptyForm) {
  const material = form.material.trim()

  if (form.material_type === 'sheet') {
    const thickness = form.sheet_thickness.trim()
    return [thickness, material].filter(Boolean).join(' ')
  }

  const shape = form.tube_shape === 'square' ? 'Square' : 'Round'
  const dimension = form.tube_dimension.trim()
  const wall = form.wall_thickness.trim()
  return [shape, dimension, wall ? `x ${wall}` : '', material].filter(Boolean).join(' ')
}

function buildMaterialId(form: typeof emptyForm) {
  if (form.material_type === 'sheet') {
    const thickness = slugify(form.sheet_thickness)
    const material = slugify(form.material)
    return ['sheet', thickness, material].filter(Boolean).join('-')
  }

  const shape = slugify(form.tube_shape)
  const dimension = slugify(form.tube_dimension)
  const wall = slugify(form.wall_thickness)
  const material = slugify(form.material)
  return ['tube', shape, dimension, wall, material].filter(Boolean).join('-')
}

function PriceChart({ entries }: { entries: PriceLogEntry[] }) {
  if (entries.length === 0) {
    return <div className="empty" style={{ textAlign: 'center', padding: '24px 0' }}>No price history yet.</div>
  }

  const sorted = [...entries].sort(
    (a, b) => new Date(a.date_purchased).getTime() - new Date(b.date_purchased).getTime()
  )

  const width = 520
  const height = 200
  const padL = 64
  const padR = 16
  const padT = 24
  const padB = 44
  const cw = width - padL - padR
  const ch = height - padT - padB

  const prices = sorted.map((e) => e.price)
  const minP = Math.min(...prices)
  const maxP = Math.max(...prices)
  const range = maxP === minP ? 1 : maxP - minP

  const pts = sorted.map((e, i) => ({
    x: padL + (sorted.length > 1 ? (i / (sorted.length - 1)) * cw : cw / 2),
    y: padT + ch - ((e.price - minP) / range) * ch,
    entry: e,
  }))

  const pathD = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', display: 'block', maxWidth: width }}
    >
      {/* Axes */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + ch} stroke="var(--border)" strokeWidth={1} />
      <line x1={padL} y1={padT + ch} x2={padL + cw} y2={padT + ch} stroke="var(--border)" strokeWidth={1} />

      {/* Y axis labels */}
      <text x={padL - 6} y={padT + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
        ${maxP.toFixed(2)}
      </text>
      {maxP !== minP && (
        <text x={padL - 6} y={padT + ch + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
          ${minP.toFixed(2)}
        </text>
      )}

      {/* Line */}
      {sorted.length > 1 && (
        <path d={pathD} stroke="var(--accent)" strokeWidth={2} fill="none" strokeLinejoin="round" />
      )}

      {/* Points, price labels, date labels */}
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={4} fill="var(--accent)" />
          <text
            x={p.x}
            y={p.y - 10}
            textAnchor="middle"
            fontSize={10}
            fill="var(--text)"
          >
            ${sorted[i].price.toFixed(2)}
          </text>
          <text
            x={p.x}
            y={padT + ch + 16}
            textAnchor="middle"
            fontSize={10}
            fill="var(--muted)"
          >
            {sorted[i].date_purchased.slice(5)}
          </text>
          {sorted[i].supplier && (
            <text
              x={p.x}
              y={padT + ch + 28}
              textAnchor="middle"
              fontSize={9}
              fill="var(--muted)"
            >
              {sorted[i].supplier}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

export default function MaterialsPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [rows, setRows] = useState<MaterialRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)

  const [priceLogs, setPriceLogs] = useState<PriceLogEntry[]>([])
  const [priceForm, setPriceForm] = useState(emptyPriceForm)
  const [savingPrice, setSavingPrice] = useState(false)
  const [priceMessage, setPriceMessage] = useState('')
  const [loadingPriceLogs, setLoadingPriceLogs] = useState(false)

  async function loadRows() {
    setLoading(true)
    setMessage('')

    const { data, error } = await supabase
      .from('materials')
      .select('*')
      .order('name', { ascending: true })

    if (error) {
      setMessage(`Load failed: ${error.message}`)
      setRows([])
    } else {
      setRows((data as MaterialRow[]) || [])
    }

    setLoading(false)
  }

  async function loadPriceLogs(materialId: string) {
    setLoadingPriceLogs(true)
    const { data, error } = await supabase
      .from('material_price_logs')
      .select('*')
      .eq('material_id', materialId)
      .order('date_purchased', { ascending: true })

    if (!error) {
      setPriceLogs((data ?? []) as PriceLogEntry[])
    }
    setLoadingPriceLogs(false)
  }

  useEffect(() => {
    loadRows()
  }, [])

  // Auto-select material from ?id= query param after data loads
  useEffect(() => {
    if (loading || rows.length === 0) return
    try {
      const params = new URLSearchParams(window.location.search)
      const idParam = params.get('id')
      if (!idParam) return
      const match = rows.find((r) => r.id === idParam)
      if (match) {
        startEdit(match)
        setTimeout(() => {
          document.getElementById(`mat-row-${match.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 100)
      }
    } catch {
      // ignore
    }
  }, [loading, rows])

  function updateField(name: string, value: string) {
    setForm((prev) => {
      const next = { ...prev, [name]: value }

      if (name === 'material_type' && value === 'sheet') {
        next.tube_shape = 'round'
        next.tube_dimension = ''
        next.wall_thickness = ''
      }

      if (name === 'material_type' && value === 'tube') {
        next.sheet_thickness = ''
      }

      return next
    })
  }

  function startNew() {
    setEditingId(null)
    setForm(emptyForm)
    setMessage('')
    setPriceLogs([])
    setPriceForm(emptyPriceForm)
    setPriceMessage('')
  }

  function startEdit(row: MaterialRow) {
    const isTube = row.material_type === 'tube'
    const tubeShape = row.tube_od?.toLowerCase().includes('x') ? 'square' : 'round'

    setEditingId(row.id)
    setForm({
      material_type: row.material_type,
      tube_shape: isTube ? tubeShape : 'round',
      material: row.material || '',
      sheet_thickness: !isTube ? row.thickness || '' : '',
      tube_dimension: isTube ? row.tube_od || '' : '',
      wall_thickness: isTube ? row.tube_wall || '' : '',
      notes: row.notes || '',
      cost_per_lb: row.cost_per_lb != null ? String(row.cost_per_lb) : '',
      scrap_rate: row.scrap_rate != null ? String(Math.round(row.scrap_rate * 100)) : '',
    })
    setMessage('')
    setPriceMessage('')
    loadPriceLogs(row.id)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMessage('')

    const generatedName = buildMaterialName(form)
    const generatedId = editingId || buildMaterialId(form)

    if (!generatedName) {
      setMessage('Fill out the material fields first.')
      setSaving(false)
      return
    }

    const payload = {
      id: generatedId,
      name: generatedName,
      material_type: form.material_type as 'tube' | 'sheet',
      material: form.material.trim() || null,
      thickness: form.material_type === 'sheet' ? form.sheet_thickness.trim() || null : null,
      tube_od: form.material_type === 'tube' ? form.tube_dimension.trim() || null : null,
      tube_wall: form.material_type === 'tube' ? form.wall_thickness.trim() || null : null,
      notes: form.notes.trim() || null,
      cost_per_lb: form.cost_per_lb.trim() ? parseFloat(form.cost_per_lb) : null,
      scrap_rate: form.scrap_rate.trim() ? parseFloat(form.scrap_rate) / 100 : null,
    }

    const query = editingId
      ? supabase.from('materials').update(payload).eq('id', editingId)
      : supabase.from('materials').insert(payload)

    const { error } = await query

    if (error) {
      setMessage(`${editingId ? 'Update' : 'Save'} failed: ${error.message}`)
    } else {
      setMessage(editingId ? 'Material updated.' : 'Material saved.')
      startNew()
      await loadRows()
    }

    setSaving(false)
  }

  async function handleDelete() {
    if (!editingId) return
    const ok = window.confirm('Delete this material?')
    if (!ok) return

    const { error } = await supabase.from('materials').delete().eq('id', editingId)

    if (error) {
      setMessage(`Delete failed: ${error.message}`)
    } else {
      setMessage('Material deleted.')
      startNew()
      await loadRows()
    }
  }

  async function handleSavePrice(e: React.FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setSavingPrice(true)
    setPriceMessage('')

    const price = parseFloat(priceForm.price)
    if (isNaN(price) || price <= 0) {
      setPriceMessage('Price must be a positive number.')
      setSavingPrice(false)
      return
    }

    if (!priceForm.date_purchased) {
      setPriceMessage('Date is required.')
      setSavingPrice(false)
      return
    }

    const { error } = await supabase.from('material_price_logs').insert({
      material_id: editingId,
      price,
      date_purchased: priceForm.date_purchased,
      order_number: priceForm.order_number.trim() || null,
      supplier: priceForm.supplier.trim() || null,
      notes: priceForm.notes.trim() || null,
    })

    if (error) {
      setPriceMessage(`Save failed: ${error.message}`)
    } else {
      setPriceMessage('Price logged.')
      setPriceForm({ ...emptyPriceForm, date_purchased: new Date().toISOString().split('T')[0] })
      await loadPriceLogs(editingId)
    }

    setSavingPrice(false)
  }

  async function handleDeletePriceLog(id: string) {
    const { error } = await supabase.from('material_price_logs').delete().eq('id', id)
    if (error) {
      setPriceMessage(`Delete failed: ${error.message}`)
    } else if (editingId) {
      setPriceMessage('Entry removed.')
      await loadPriceLogs(editingId)
    }
  }

  const filteredRows = rows.filter((row) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return [
      row.name,
      row.material_type,
      row.material || '',
      row.thickness || '',
      row.tube_od || '',
      row.tube_wall || '',
      row.notes || '',
    ]
      .join(' ')
      .toLowerCase()
      .includes(q)
  })

  const filteredTubes = filteredRows.filter((r) => r.material_type === 'tube')
  const filteredSheets = filteredRows.filter((r) => r.material_type === 'sheet')

  const generatedName = buildMaterialName(form)

  const lastPurchase = priceLogs.length > 0
    ? [...priceLogs].sort(
        (a, b) => new Date(b.date_purchased).getTime() - new Date(a.date_purchased).getTime()
      )[0]
    : null

  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Materials</h1>
          <div className="page-subtitle">
            Store your standard tube and sheet sizes so parts can use dropdowns instead of manual re-entry.
          </div>
        </div>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">{editingId ? 'Edit Material' : 'Add Material'}</h2>
          <div className="card-subtitle">
            Name is auto-generated from the selections below.
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
                <label className="label">Type</label>
                <select
                  className="select"
                  value={form.material_type}
                  onChange={(e) => updateField('material_type', e.target.value)}
                >
                  <option value="sheet">Sheet</option>
                  <option value="tube">Tube</option>
                </select>
              </div>

              {form.material_type === 'tube' && (
                <div>
                  <label className="label">Tube Shape</label>
                  <select
                    className="select"
                    value={form.tube_shape}
                    onChange={(e) => updateField('tube_shape', e.target.value)}
                  >
                    <option value="round">Round</option>
                    <option value="square">Square</option>
                  </select>
                </div>
              )}

              <div>
                <label className="label">Material</label>
                <input
                  className="field"
                  value={form.material}
                  onChange={(e) => updateField('material', e.target.value)}
                  placeholder="DOM / HRPO / Steel / Aluminum"
                />
              </div>

              {form.material_type === 'sheet' ? (
                <div>
                  <label className="label">Thickness</label>
                  <input
                    className="field"
                    value={form.sheet_thickness}
                    onChange={(e) => updateField('sheet_thickness', e.target.value)}
                    placeholder="3/16"
                  />
                </div>
              ) : (
                <>
                  <div>
                    <label className="label">Dimension</label>
                    <input
                      className="field"
                      value={form.tube_dimension}
                      onChange={(e) => updateField('tube_dimension', e.target.value)}
                      placeholder={form.tube_shape === 'square' ? '2 x 2' : '1.75'}
                    />
                  </div>

                  <div>
                    <label className="label">Wall Thickness</label>
                    <input
                      className="field"
                      value={form.wall_thickness}
                      onChange={(e) => updateField('wall_thickness', e.target.value)}
                      placeholder=".120"
                    />
                  </div>
                </>
              )}

              <div style={{ gridColumn: '1 / -1' }}>
                <label className="label">Generated Name</label>
                <input
                  className="field"
                  value={generatedName}
                  readOnly
                  placeholder="Auto-generated"
                />
              </div>

              <div>
                <label className="label">Cost per lb ($)</label>
                <input
                  className="field"
                  type="number"
                  step="0.001"
                  min="0"
                  value={form.cost_per_lb}
                  onChange={(e) => updateField('cost_per_lb', e.target.value)}
                  placeholder="0.45"
                />
              </div>

              <div>
                <label className="label">Scrap / Utilization Rate (%)</label>
                <input
                  className="field"
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={form.scrap_rate}
                  onChange={(e) => updateField('scrap_rate', e.target.value)}
                  placeholder="10"
                />
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <label className="label">Notes</label>
                <textarea
                  className="textarea"
                  value={form.notes}
                  onChange={(e) => updateField('notes', e.target.value)}
                  rows={3}
                  placeholder="Optional notes"
                />
              </div>
            </div>

            <div className="btn-row" style={{ marginTop: 18 }}>
              <button type="submit" disabled={saving} className="btn btn-primary">
                {saving ? 'Saving...' : editingId ? 'Update Material' : 'Save Material'}
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

      {editingId && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Price History</h2>
            <div className="card-subtitle">
              {editingId} — log purchases to track price changes over time.
            </div>
          </div>

          <div className="card-body">
            <div className="grid-2" style={{ gap: 28, alignItems: 'start' }}>
              <div>
                <div style={{ marginBottom: 18 }}>
                  <div className="group-title" style={{ marginBottom: 12 }}>Log a Purchase</div>
                  <form onSubmit={handleSavePrice}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div>
                        <label className="label">Price ($)</label>
                        <input
                          className="field"
                          type="number"
                          step="0.01"
                          min="0"
                          value={priceForm.price}
                          onChange={(e) => setPriceForm((p) => ({ ...p, price: e.target.value }))}
                          placeholder="0.00"
                        />
                      </div>

                      <div>
                        <label className="label">Date Purchased</label>
                        <input
                          className="field"
                          type="date"
                          value={priceForm.date_purchased}
                          onChange={(e) => setPriceForm((p) => ({ ...p, date_purchased: e.target.value }))}
                        />
                      </div>

                      <div>
                        <label className="label">Order Number</label>
                        <input
                          className="field"
                          value={priceForm.order_number}
                          onChange={(e) => setPriceForm((p) => ({ ...p, order_number: e.target.value }))}
                          placeholder="PO-12345"
                        />
                      </div>

                      <div>
                        <label className="label">Supplier</label>
                        <input
                          className="field"
                          value={priceForm.supplier}
                          onChange={(e) => setPriceForm((p) => ({ ...p, supplier: e.target.value }))}
                          placeholder="Metal supplier name"
                        />
                      </div>

                      <div style={{ gridColumn: '1 / -1' }}>
                        <label className="label">Notes</label>
                        <input
                          className="field"
                          value={priceForm.notes}
                          onChange={(e) => setPriceForm((p) => ({ ...p, notes: e.target.value }))}
                          placeholder="Optional notes"
                        />
                      </div>
                    </div>

                    <div className="btn-row" style={{ marginTop: 14 }}>
                      <button type="submit" disabled={savingPrice} className="btn btn-primary">
                        {savingPrice ? 'Saving...' : 'Log Price'}
                      </button>
                    </div>

                    {priceMessage && <div className="message">{priceMessage}</div>}
                  </form>
                </div>

                {lastPurchase && (
                  <div
                    style={{
                      background: 'var(--panel-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '14px 16px',
                    }}
                  >
                    <div className="kicker" style={{ marginBottom: 6 }}>Last Purchase</div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent)' }}>
                      ${lastPurchase.price.toFixed(2)}
                    </div>
                    <div style={{ fontSize: '0.9rem', color: 'var(--muted)', marginTop: 4 }}>
                      {lastPurchase.date_purchased}
                      {lastPurchase.supplier && ` · ${lastPurchase.supplier}`}
                      {lastPurchase.order_number && ` · ${lastPurchase.order_number}`}
                    </div>
                    {lastPurchase.notes && (
                      <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: 4 }}>
                        {lastPurchase.notes}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div>
                <div className="group-title" style={{ marginBottom: 12 }}>Price Over Time</div>
                {loadingPriceLogs ? (
                  <div className="empty">Loading...</div>
                ) : (
                  <PriceChart entries={priceLogs} />
                )}
              </div>
            </div>

            {priceLogs.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <div className="group-title" style={{ marginBottom: 12 }}>Purchase History</div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Price</th>
                        <th>Order #</th>
                        <th>Supplier</th>
                        <th>Notes</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...priceLogs]
                        .sort(
                          (a, b) =>
                            new Date(b.date_purchased).getTime() -
                            new Date(a.date_purchased).getTime()
                        )
                        .map((entry) => (
                          <tr key={entry.id}>
                            <td>{entry.date_purchased}</td>
                            <td>${entry.price.toFixed(2)}</td>
                            <td>{entry.order_number || ''}</td>
                            <td>{entry.supplier || ''}</td>
                            <td>{entry.notes || ''}</td>
                            <td>
                              <button
                                className="btn btn-danger"
                                onClick={() => handleDeletePriceLog(entry.id)}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="card">
        <div
          className="card-header"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}
        >
          <div>
            <h2 className="card-title">All Materials</h2>
            <div className="card-subtitle">Click a row to edit it.</div>
          </div>
          <div style={{ minWidth: 220, flex: '0 0 300px', position: 'relative' }}>
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
              placeholder="Search name, thickness, tube size..."
              style={{ paddingLeft: 36 }}
            />
          </div>
        </div>

        <div className="card-body section-stack" style={{ gap: 28 }}>
          {loading ? (
            <div className="empty">Loading...</div>
          ) : (
            <>
              <div>
                <div className="group-title" style={{ marginBottom: 12 }}>
                  Sheet Materials ({filteredSheets.length})
                </div>
                {filteredSheets.length === 0 ? (
                  <div className="empty">No matching sheet materials.</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Material</th>
                          <th>Thickness</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredSheets.map((row) => (
                          <tr
                            key={row.id}
                            id={`mat-row-${row.id}`}
                            onClick={() => startEdit(row)}
                            style={{
                              cursor: 'pointer',
                              background: editingId === row.id ? 'var(--accent-soft)' : 'transparent',
                            }}
                          >
                            <td>{row.name}</td>
                            <td>{row.material || ''}</td>
                            <td>{row.thickness || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div>
                <div className="group-title" style={{ marginBottom: 12 }}>
                  Tube Materials ({filteredTubes.length})
                </div>
                {filteredTubes.length === 0 ? (
                  <div className="empty">No matching tube materials.</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Material</th>
                          <th>Dimension</th>
                          <th>Wall</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTubes.map((row) => (
                          <tr
                            key={row.id}
                            id={`mat-row-${row.id}`}
                            onClick={() => startEdit(row)}
                            style={{
                              cursor: 'pointer',
                              background: editingId === row.id ? 'var(--accent-soft)' : 'transparent',
                            }}
                          >
                            <td>{row.name}</td>
                            <td>{row.material || ''}</td>
                            <td>{row.tube_od || ''}</td>
                            <td>{row.tube_wall || ''}</td>
                          </tr>
                        ))}
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
  )
}
