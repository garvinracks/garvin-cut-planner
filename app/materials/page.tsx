'use client'

/*
 * SQL migrations — run once in Supabase SQL editor:
 *   ALTER TABLE material_price_logs ADD COLUMN IF NOT EXISTS qty_received  numeric;
 *   ALTER TABLE material_price_logs ADD COLUMN IF NOT EXISTS length_per_bar_in numeric;
 *   ALTER TABLE materials ADD COLUMN IF NOT EXISTS tube_shape text NOT NULL DEFAULT 'round';
 *   ALTER TABLE parts     ADD COLUMN IF NOT EXISTS tube_shape text NOT NULL DEFAULT 'round';
 */

/* eslint-disable react-hooks/exhaustive-deps */

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type MaterialRow = {
  id: string
  name: string
  material_type: 'tube' | 'sheet'
  material: string | null
  thickness: string | null
  tube_od: string | null
  tube_wall: string | null
  tube_shape: string | null
  notes: string | null
  unit_weight_lbs: number | null
  scrap_rate: number | null
  stock_length_in: number | null
  qty_on_hand: number | null
}

type PriceLogEntry = {
  id: string
  material_id: string
  price: number
  date_purchased: string
  order_number: string | null
  supplier: string | null
  notes: string | null
  qty_received: number | null
  length_per_bar_in: number | null
}

type ActiveBatch = { id: string; name: string; status: string }
type BatchLine   = { batch_id: string; sku_id: string; qty: number }
type SkuPart     = { sku_id: string; part_id: string; qty: number }
type SkuSub      = { sku_id: string; sub_assembly_id: string; qty: number }
type SubPart     = { sub_assembly_id: string; part_id: string; qty: number }
type BomPart     = {
  id: string
  part_type: 'tube' | 'sheet'
  material: string | null
  thickness: string | null
  tube_od: string | null
  tube_wall: string | null
  cut_length: number | null
  weight_lbs: number | null
}

// ── Form defaults ─────────────────────────────────────────────────────────────

const emptyForm = {
  material_type: 'sheet',
  tube_shape: 'round',
  material: '',
  sheet_thickness: '',
  tube_dimension: '',
  wall_thickness: '',
  notes: '',
  unit_weight_lbs: '',
  scrap_rate: '',
  stock_length_in: '',
  qty_on_hand: '',
}

// Multi-line delivery receipt types
type DeliveryLine = {
  material_id: string
  qty_received: string
  price_per_unit: string
  length_per_bar_in: string   // tubes only
}

function emptyDeliveryLine(): DeliveryLine {
  return { material_id: '', qty_received: '', price_per_unit: '', length_per_bar_in: '' }
}

const emptyPriceForm = {
  price: '',
  date_purchased: new Date().toISOString().split('T')[0],
  order_number: '',
  supplier: '',
  notes: '',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(v: string) {
  return v.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
}

function buildMaterialName(form: typeof emptyForm) {
  const mat = form.material.trim()
  if (form.material_type === 'sheet') {
    return [form.sheet_thickness.trim(), mat].filter(Boolean).join(' ')
  }
  const shape = form.tube_shape === 'square' ? 'Square' : 'Round'
  const dim = form.tube_dimension.trim()
  const wall = form.wall_thickness.trim()
  return [shape, dim, wall ? `x ${wall}` : '', mat].filter(Boolean).join(' ')
}

function buildMaterialId(form: typeof emptyForm) {
  if (form.material_type === 'sheet') {
    return ['sheet', slugify(form.sheet_thickness), slugify(form.material)].filter(Boolean).join('-')
  }
  return ['tube', slugify(form.tube_shape), slugify(form.tube_dimension), slugify(form.wall_thickness), slugify(form.material)].filter(Boolean).join('-')
}

const STATUS_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  planned:     { label: 'Planned',   bg: 'rgba(100,116,139,0.2)', color: '#94a3b8' },
  in_progress: { label: 'In Build',  bg: 'rgba(234,179,8,0.2)',   color: '#facc15' },
}

// ── Mini price chart ──────────────────────────────────────────────────────────

function PriceChart({ entries }: { entries: PriceLogEntry[] }) {
  if (entries.length < 2) return null
  const sorted = [...entries].sort((a, b) => new Date(a.date_purchased).getTime() - new Date(b.date_purchased).getTime())
  const W = 440; const H = 140; const pL = 56; const pR = 12; const pT = 20; const pB = 36
  const cw = W - pL - pR; const ch = H - pT - pB
  const prices = sorted.map((e) => e.price)
  const minP = Math.min(...prices); const maxP = Math.max(...prices); const range = maxP === minP ? 1 : maxP - minP
  const pts = sorted.map((e, i) => ({
    x: pL + (sorted.length > 1 ? (i / (sorted.length - 1)) * cw : cw / 2),
    y: pT + ch - ((e.price - minP) / range) * ch,
    entry: e,
  }))
  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block', maxWidth: W }}>
      <line x1={pL} y1={pT} x2={pL} y2={pT + ch} stroke="var(--border)" strokeWidth={1} />
      <line x1={pL} y1={pT + ch} x2={pL + cw} y2={pT + ch} stroke="var(--border)" strokeWidth={1} />
      <text x={pL - 4} y={pT + 5} textAnchor="end" fontSize={10} fill="var(--muted)">${maxP.toFixed(0)}</text>
      {maxP !== minP && <text x={pL - 4} y={pT + ch + 4} textAnchor="end" fontSize={10} fill="var(--muted)">${minP.toFixed(0)}</text>}
      <path d={pathD} stroke="var(--accent)" strokeWidth={2} fill="none" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={3.5} fill="var(--accent)" />
          <text x={p.x} y={p.y - 7} textAnchor="middle" fontSize={9} fill="var(--text)">${sorted[i].price.toFixed(2)}</text>
          <text x={p.x} y={pT + ch + 14} textAnchor="middle" fontSize={9} fill="var(--muted)">{sorted[i].date_purchased.slice(5)}</text>
        </g>
      ))}
    </svg>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MaterialsPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [rows, setRows]               = useState<MaterialRow[]>([])
  const [loading, setLoading]         = useState(true)
  const [saving, setSaving]           = useState(false)
  const [message, setMessage]         = useState('')
  const [search, setSearch]           = useState('')
  const [editingId, setEditingId]     = useState<string | null>(null)
  const [form, setForm]               = useState(emptyForm)

  // Price / purchase history
  const [priceLogs, setPriceLogs]           = useState<PriceLogEntry[]>([])
  const [priceForm, setPriceForm]           = useState(emptyPriceForm)
  const [savingPrice, setSavingPrice]       = useState(false)
  const [priceMessage, setPriceMessage]     = useState('')
  const [loadingPriceLogs, setLoadingPriceLogs] = useState(false)

  // Multi-line delivery modal (top-level, covers whole order at once)
  const [deliveryOpen, setDeliveryOpen]         = useState(false)
  const [deliveryDate, setDeliveryDate]         = useState(new Date().toISOString().split('T')[0])
  const [deliveryPO, setDeliveryPO]             = useState('')
  const [deliverySupplier, setDeliverySupplier] = useState('')
  const [deliveryNotes, setDeliveryNotes]       = useState('')
  const [deliveryLines, setDeliveryLines]       = useState<DeliveryLine[]>([emptyDeliveryLine()])
  const [savingDelivery, setSavingDelivery]     = useState(false)
  const [deliveryMessage, setDeliveryMessage]   = useState('')

  // Batch allocation data
  const [activeBatches, setActiveBatches]   = useState<ActiveBatch[]>([])
  const [batchLines, setBatchLines]         = useState<BatchLine[]>([])
  const [skuParts, setSkuParts]             = useState<SkuPart[]>([])
  const [skuSubs, setSkuSubs]               = useState<SkuSub[]>([])
  const [subParts, setSubParts]             = useState<SubPart[]>([])
  const [bomParts, setBomParts]             = useState<BomPart[]>([])

  // ── Data loading ──────────────────────────────────────────────────────────────

  async function loadRows() {
    setLoading(true)
    const { data, error } = await supabase.from('materials').select('*').order('name')
    if (error) { setMessage(`Load failed: ${error.message}`); setRows([]) }
    else setRows((data as MaterialRow[]) || [])
    setLoading(false)
  }

  async function loadPriceLogs(materialId: string) {
    setLoadingPriceLogs(true)
    const { data } = await supabase
      .from('material_price_logs').select('*').eq('material_id', materialId)
      .order('date_purchased', { ascending: false })
    setPriceLogs((data ?? []) as PriceLogEntry[])
    setLoadingPriceLogs(false)
  }

  async function loadBatchData() {
    const [
      { data: ab },
      { data: bl },
      { data: sp },
      { data: ss },
      { data: sap },
      { data: bp },
    ] = await Promise.all([
      supabase.from('build_batches').select('id, name, status').in('status', ['planned', 'in_progress']),
      supabase.from('build_batch_lines').select('batch_id, sku_id, qty'),
      supabase.from('sku_parts').select('sku_id, part_id, qty'),
      supabase.from('sku_sub_assemblies').select('sku_id, sub_assembly_id, qty'),
      supabase.from('sub_assembly_parts').select('sub_assembly_id, part_id, qty'),
      supabase.from('parts').select('id, part_type, material, thickness, tube_od, tube_wall, cut_length, weight_lbs'),
    ])
    setActiveBatches((ab ?? []) as ActiveBatch[])
    setBatchLines((bl ?? []) as BatchLine[])
    setSkuParts((sp ?? []) as SkuPart[])
    setSkuSubs((ss ?? []) as SkuSub[])
    setSubParts((sap ?? []) as SubPart[])
    setBomParts((bp ?? []) as BomPart[])
  }

  useEffect(() => { void loadRows(); void loadBatchData() }, [])

  // Auto-select from ?id= query param
  useEffect(() => {
    if (loading || rows.length === 0) return
    try {
      const id = new URLSearchParams(window.location.search).get('id')
      if (!id) return
      const match = rows.find((r) => r.id === id)
      if (match) {
        startEdit(match)
        setTimeout(() => document.getElementById(`mat-row-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
      }
    } catch { /* ignore */ }
  }, [loading, rows])

  // ── Batch allocation computation ──────────────────────────────────────────────

  // Returns: material_id → { totalQty (bars/sheets), batches: [{id, name, status, qty}] }
  const batchAllocation = useMemo(() => {
    const alloc: Record<string, { totalQty: number; batches: Array<{ id: string; name: string; status: string; qty: number }> }> = {}

    function addAlloc(materialId: string, qty: number, batchId: string, batchName: string, batchStatus: string) {
      if (qty <= 0) return
      if (!alloc[materialId]) alloc[materialId] = { totalQty: 0, batches: [] }
      alloc[materialId].totalQty += qty
      const existing = alloc[materialId].batches.find((b) => b.id === batchId)
      if (existing) existing.qty += qty
      else alloc[materialId].batches.push({ id: batchId, name: batchName, status: batchStatus, qty })
    }

    function findMaterial(part: BomPart): MaterialRow | null {
      return rows.find((m) => {
        if (m.material_type !== part.part_type) return false
        if (part.part_type === 'sheet') return m.material === part.material && m.thickness === part.thickness
        return m.material === part.material && m.tube_od === part.tube_od && m.tube_wall === part.tube_wall
      }) ?? null
    }

    for (const batch of activeBatches) {
      for (const line of batchLines.filter((l) => l.batch_id === batch.id)) {
        // Direct parts
        for (const sp of skuParts.filter((s) => s.sku_id === line.sku_id)) {
          const part = bomParts.find((p) => p.id === sp.part_id)
          if (!part) continue
          const mat = findMaterial(part)
          if (!mat) continue
          const totalPartQty = sp.qty * line.qty

          if (part.part_type === 'tube' && part.cut_length && mat.stock_length_in) {
            const bars = Math.ceil((part.cut_length * totalPartQty) / mat.stock_length_in)
            addAlloc(mat.id, bars, batch.id, batch.name, batch.status)
          } else if (part.part_type === 'sheet' && part.weight_lbs && mat.unit_weight_lbs) {
            const sheets = Math.ceil((part.weight_lbs * totalPartQty) / (mat.unit_weight_lbs * (1 - (mat.scrap_rate ?? 0.15))))
            addAlloc(mat.id, sheets, batch.id, batch.name, batch.status)
          }
        }
        // Sub-assembly parts
        for (const ss of skuSubs.filter((s) => s.sku_id === line.sku_id)) {
          for (const sap of subParts.filter((s) => s.sub_assembly_id === ss.sub_assembly_id)) {
            const part = bomParts.find((p) => p.id === sap.part_id)
            if (!part) continue
            const mat = findMaterial(part)
            if (!mat) continue
            const totalPartQty = sap.qty * ss.qty * line.qty

            if (part.part_type === 'tube' && part.cut_length && mat.stock_length_in) {
              const bars = Math.ceil((part.cut_length * totalPartQty) / mat.stock_length_in)
              addAlloc(mat.id, bars, batch.id, batch.name, batch.status)
            } else if (part.part_type === 'sheet' && part.weight_lbs && mat.unit_weight_lbs) {
              const sheets = Math.ceil((part.weight_lbs * totalPartQty) / (mat.unit_weight_lbs * (1 - (mat.scrap_rate ?? 0.15))))
              addAlloc(mat.id, sheets, batch.id, batch.name, batch.status)
            }
          }
        }
      }
    }
    return alloc
  }, [activeBatches, batchLines, skuParts, skuSubs, subParts, bomParts, rows])

  // ── Edit helpers ──────────────────────────────────────────────────────────────

  function updateField(name: string, value: string) {
    setForm((prev) => {
      const next = { ...prev, [name]: value }
      if (name === 'material_type' && value === 'sheet') { next.tube_shape = 'round'; next.tube_dimension = ''; next.wall_thickness = '' }
      if (name === 'material_type' && value === 'tube') next.sheet_thickness = ''
      return next
    })
  }

  function startNew() {
    setEditingId(null); setForm(emptyForm); setMessage('')
    setPriceLogs([]); setPriceForm(emptyPriceForm); setPriceMessage('')
  }

  function openDeliveryModal() {
    setDeliveryDate(new Date().toISOString().split('T')[0])
    setDeliveryPO(''); setDeliverySupplier(''); setDeliveryNotes('')
    setDeliveryLines([emptyDeliveryLine()])
    setDeliveryMessage('')
    setDeliveryOpen(true)
  }

  function startEdit(row: MaterialRow) {
    const isTube = row.material_type === 'tube'
    // Prefer the stored tube_shape column; fall back to deriving from tube_od for old rows
    const tubeShape = row.tube_shape ?? (row.tube_od?.toLowerCase().includes('x') ? 'square' : 'round')
    setEditingId(row.id)
    setForm({
      material_type: row.material_type,
      tube_shape: isTube ? tubeShape : 'round',
      material: row.material || '',
      sheet_thickness: !isTube ? row.thickness || '' : '',
      tube_dimension: isTube ? row.tube_od || '' : '',
      wall_thickness: isTube ? row.tube_wall || '' : '',
      notes: row.notes || '',
      unit_weight_lbs: row.unit_weight_lbs != null ? String(row.unit_weight_lbs) : '',
      scrap_rate: row.scrap_rate != null ? String(Math.round(row.scrap_rate * 100)) : '',
      stock_length_in: row.stock_length_in != null ? String(row.stock_length_in) : '',
      qty_on_hand: row.qty_on_hand != null ? String(row.qty_on_hand) : '',
    })
    setMessage(''); setPriceMessage('')
    void loadPriceLogs(row.id)
  }

  // ── Save material ─────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setMessage('')
    const generatedName = buildMaterialName(form)
    const generatedId = editingId || buildMaterialId(form)
    if (!generatedName) { setMessage('Fill out the material fields first.'); setSaving(false); return }

    const payload = {
      id: generatedId, name: generatedName,
      material_type: form.material_type as 'tube' | 'sheet',
      material: form.material.trim() || null,
      thickness: form.material_type === 'sheet' ? form.sheet_thickness.trim() || null : null,
      tube_shape: form.material_type === 'tube' ? form.tube_shape : 'round',
      tube_od: form.material_type === 'tube' ? form.tube_dimension.trim() || null : null,
      tube_wall: form.material_type === 'tube' ? form.wall_thickness.trim() || null : null,
      notes: form.notes.trim() || null,
      unit_weight_lbs: form.unit_weight_lbs.trim() ? parseFloat(form.unit_weight_lbs) : null,
      scrap_rate: form.scrap_rate.trim() ? parseFloat(form.scrap_rate) / 100 : null,
      stock_length_in: form.stock_length_in.trim() ? parseInt(form.stock_length_in, 10) : null,
      qty_on_hand: form.qty_on_hand.trim() ? parseFloat(form.qty_on_hand) : null,
    }
    const { error } = editingId
      ? await supabase.from('materials').update(payload).eq('id', editingId)
      : await supabase.from('materials').insert(payload)

    if (error) { setMessage(`${editingId ? 'Update' : 'Save'} failed: ${error.message}`) }
    else { setMessage(editingId ? 'Material updated.' : 'Material saved.'); startNew(); await loadRows() }
    setSaving(false)
  }

  async function handleDelete() {
    if (!editingId) return
    if (!window.confirm('Delete this material?')) return
    const { error } = await supabase.from('materials').delete().eq('id', editingId)
    if (error) setMessage(`Delete failed: ${error.message}`)
    else { setMessage('Material deleted.'); startNew(); await loadRows() }
  }

  // ── Receive delivery (multi-line) ────────────────────────────────────────────

  function updateDeliveryLine(idx: number, field: keyof DeliveryLine, value: string) {
    setDeliveryLines((prev) => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l))
  }

  async function handleReceiveDelivery(e: React.FormEvent) {
    e.preventDefault()
    setSavingDelivery(true); setDeliveryMessage('')

    const filledLines = deliveryLines.filter((l) => l.material_id && l.qty_received && l.price_per_unit)
    if (filledLines.length === 0) {
      setDeliveryMessage('Add at least one material line with qty and price.')
      setSavingDelivery(false); return
    }
    if (!deliveryDate) { setDeliveryMessage('Date is required.'); setSavingDelivery(false); return }

    const errors: string[] = []

    for (const line of filledLines) {
      const mat = rows.find((r) => r.id === line.material_id)
      if (!mat) { errors.push(`Unknown material: ${line.material_id}`); continue }

      const qty = parseFloat(line.qty_received)
      const price = parseFloat(line.price_per_unit)
      if (isNaN(qty) || qty <= 0) { errors.push(`${mat.name}: invalid qty`); continue }
      if (isNaN(price) || price <= 0) { errors.push(`${mat.name}: invalid price`); continue }

      const isTube = mat.material_type === 'tube'
      const lengthPerBar = isTube && line.length_per_bar_in.trim()
        ? parseFloat(line.length_per_bar_in) : null

      // Log price entry
      const { error: logErr } = await supabase.from('material_price_logs').insert({
        material_id: mat.id,
        price,
        date_purchased: deliveryDate,
        order_number: deliveryPO.trim() || null,
        supplier: deliverySupplier.trim() || null,
        notes: deliveryNotes.trim() || null,
        qty_received: qty,
        length_per_bar_in: lengthPerBar,
      })
      if (logErr) { errors.push(`${mat.name}: ${logErr.message}`); continue }

      // Increment qty_on_hand
      const newQty = (mat.qty_on_hand ?? 0) + qty
      const updatePayload: Record<string, unknown> = { qty_on_hand: newQty }
      if (isTube && lengthPerBar && lengthPerBar !== mat.stock_length_in) {
        updatePayload.stock_length_in = lengthPerBar
      }
      await supabase.from('materials').update(updatePayload).eq('id', mat.id)
    }

    await loadRows()

    // Reload price logs if we just touched the currently-editing material
    if (editingId && filledLines.some((l) => l.material_id === editingId)) {
      await loadPriceLogs(editingId)
      const fresh = rows.find((r) => r.id === editingId)
      if (fresh) setForm((prev) => ({ ...prev, qty_on_hand: String((fresh.qty_on_hand ?? 0) + filledLines.filter(l => l.material_id === editingId).reduce((s, l) => s + parseFloat(l.qty_received), 0)) }))
    }

    setSavingDelivery(false)
    if (errors.length > 0) {
      setDeliveryMessage(`⚠ Some lines failed: ${errors.join('; ')}`)
    } else {
      setDeliveryMessage('')
      setDeliveryOpen(false)
      setMessage(`✓ Delivery logged — ${filledLines.length} material${filledLines.length !== 1 ? 's' : ''} received.`)
    }
  }

  // ── Log price (manual, no qty change) ────────────────────────────────────────

  async function handleSavePrice(e: React.FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setSavingPrice(true); setPriceMessage('')
    const price = parseFloat(priceForm.price)
    if (isNaN(price) || price <= 0) { setPriceMessage('Price must be positive.'); setSavingPrice(false); return }
    if (!priceForm.date_purchased) { setPriceMessage('Date is required.'); setSavingPrice(false); return }
    const { error } = await supabase.from('material_price_logs').insert({
      material_id: editingId, price,
      date_purchased: priceForm.date_purchased,
      order_number: priceForm.order_number.trim() || null,
      supplier: priceForm.supplier.trim() || null,
      notes: priceForm.notes.trim() || null,
    })
    if (error) { setPriceMessage(`Save failed: ${error.message}`) }
    else { setPriceMessage('Price logged.'); setPriceForm({ ...emptyPriceForm, date_purchased: new Date().toISOString().split('T')[0] }); await loadPriceLogs(editingId) }
    setSavingPrice(false)
  }

  async function handleDeletePriceLog(id: string) {
    const { error } = await supabase.from('material_price_logs').delete().eq('id', id)
    if (error) { setPriceMessage(`Delete failed: ${error.message}`) }
    else if (editingId) { setPriceMessage('Entry removed.'); await loadPriceLogs(editingId) }
  }

  // ── Derived ───────────────────────────────────────────────────────────────────

  const filteredRows = rows.filter((row) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return [row.name, row.material_type, row.material || '', row.thickness || '', row.tube_od || '', row.tube_wall || ''].join(' ').toLowerCase().includes(q)
  })
  const filteredTubes  = filteredRows.filter((r) => r.material_type === 'tube')
  const filteredSheets = filteredRows.filter((r) => r.material_type === 'sheet')

  const generatedName = buildMaterialName(form)

  const lastPurchase = priceLogs.length > 0
    ? [...priceLogs].sort((a, b) => new Date(b.date_purchased).getTime() - new Date(a.date_purchased).getTime())[0]
    : null

  const editingRow = rows.find((r) => r.id === editingId) ?? null
  const isTubeEdit = editingRow?.material_type === 'tube'

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Materials</h1>
          <div className="page-subtitle">Track tube and sheet materials — stock levels, batch allocation, and purchase history.</div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ background: 'var(--success)', borderColor: 'var(--success)', fontSize: '0.95rem', padding: '8px 20px', whiteSpace: 'nowrap' }}
          onClick={openDeliveryModal}
        >
          📦 Receive Delivery
        </button>
      </div>

      {/* ── Delivery Modal ── */}
      {deliveryOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', overflowY: 'auto' }}
          onClick={() => setDeliveryOpen(false)}
        >
          <div
            style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 28, width: '100%', maxWidth: 720, position: 'relative' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ margin: '0 0 4px', fontSize: '1.15rem', fontWeight: 800 }}>📦 Receive Material Delivery</h2>
            <p style={{ margin: '0 0 20px', fontSize: '0.83rem', color: 'var(--muted)' }}>Log multiple sizes from one delivery at once. Stock levels update automatically.</p>

            <form onSubmit={(e) => void handleReceiveDelivery(e)}>
              {/* Shared header fields */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
                <div>
                  <label className="label">Date Received *</label>
                  <input className="field" type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
                </div>
                <div>
                  <label className="label">PO / Order Number</label>
                  <input className="field" value={deliveryPO} onChange={(e) => setDeliveryPO(e.target.value)} placeholder="PO-12345" />
                </div>
                <div>
                  <label className="label">Supplier</label>
                  <input className="field" value={deliverySupplier} onChange={(e) => setDeliverySupplier(e.target.value)} placeholder="Metal supplier name" />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label className="label">Notes</label>
                  <input className="field" value={deliveryNotes} onChange={(e) => setDeliveryNotes(e.target.value)} placeholder="Optional delivery notes" />
                </div>
              </div>

              {/* Line items */}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 14 }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
                  Materials Received
                </div>

                {/* Column headers */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 110px 110px 36px', gap: 8, marginBottom: 6, padding: '0 4px' }}>
                  {['Material', 'Qty', 'Price / unit', 'Bar length', ''].map((h) => (
                    <div key={h} style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>{h}</div>
                  ))}
                </div>

                {deliveryLines.map((line, idx) => {
                  const mat = rows.find((r) => r.id === line.material_id)
                  const isTube = mat?.material_type === 'tube'
                  return (
                    <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 110px 110px 36px', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                      {/* Material picker */}
                      <select
                        className="select"
                        value={line.material_id}
                        onChange={(e) => {
                          const m = rows.find((r) => r.id === e.target.value)
                          updateDeliveryLine(idx, 'material_id', e.target.value)
                          // Pre-fill bar length from material default
                          if (m?.material_type === 'tube' && m.stock_length_in) {
                            updateDeliveryLine(idx, 'length_per_bar_in', String(m.stock_length_in))
                          } else {
                            updateDeliveryLine(idx, 'length_per_bar_in', '')
                          }
                        }}
                      >
                        <option value="">— select material —</option>
                        {['tube', 'sheet'].map((type) => {
                          const typeRows = rows.filter((r) => r.material_type === type)
                          if (typeRows.length === 0) return null
                          return (
                            <optgroup key={type} label={type === 'tube' ? 'Tube' : 'Sheet'}>
                              {typeRows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                            </optgroup>
                          )
                        })}
                      </select>

                      {/* Qty */}
                      <input
                        className="field"
                        type="number" step="1" min="1"
                        value={line.qty_received}
                        onChange={(e) => updateDeliveryLine(idx, 'qty_received', e.target.value)}
                        placeholder="0"
                      />

                      {/* Price per unit */}
                      <div style={{ position: 'relative' }}>
                        <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none', fontSize: '0.85rem' }}>$</span>
                        <input
                          className="field"
                          type="number" step="0.01" min="0"
                          value={line.price_per_unit}
                          onChange={(e) => updateDeliveryLine(idx, 'price_per_unit', e.target.value)}
                          placeholder="0.00"
                          style={{ paddingLeft: 22 }}
                        />
                      </div>

                      {/* Bar length (tubes only) */}
                      {isTube ? (
                        <div style={{ position: 'relative' }}>
                          <input
                            className="field"
                            type="number" step="1" min="1"
                            value={line.length_per_bar_in}
                            onChange={(e) => updateDeliveryLine(idx, 'length_per_bar_in', e.target.value)}
                            placeholder={String(mat?.stock_length_in ?? 240)}
                            title="Bar length in inches (20ft = 240, 24ft = 288)"
                          />
                          {line.length_per_bar_in && mat?.stock_length_in && parseFloat(line.length_per_bar_in) !== mat.stock_length_in && (
                            <span title={`Default is ${mat.stock_length_in}″`} style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', color: '#fbbf24' }}>⚠</span>
                          )}
                        </div>
                      ) : (
                        <div style={{ color: 'var(--muted)', fontSize: '0.75rem', textAlign: 'center' }}>—</div>
                      )}

                      {/* Remove row */}
                      <button
                        type="button"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: '1rem', padding: 0, lineHeight: 1 }}
                        onClick={() => setDeliveryLines((prev) => prev.filter((_, i) => i !== idx))}
                        disabled={deliveryLines.length === 1}
                        title="Remove row"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}

                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: '0.8rem', marginTop: 4 }}
                  onClick={() => setDeliveryLines((prev) => [...prev, emptyDeliveryLine()])}
                >
                  + Add Row
                </button>
              </div>

              {/* Cost summary */}
              {deliveryLines.some((l) => l.qty_received && l.price_per_unit) && (
                <div style={{ padding: '8px 14px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 6, fontSize: '0.83rem', color: 'var(--success)', marginBottom: 14 }}>
                  Total delivery cost: <strong>
                    ${deliveryLines.reduce((sum, l) => {
                      const q = parseFloat(l.qty_received); const p = parseFloat(l.price_per_unit)
                      return sum + (isNaN(q) || isNaN(p) ? 0 : q * p)
                    }, 0).toFixed(2)}
                  </strong>
                </div>
              )}

              {deliveryMessage && (
                <div className="warning-box" style={{ marginBottom: 14 }}>{deliveryMessage}</div>
              )}

              <div className="btn-row">
                <button type="submit" disabled={savingDelivery} className="btn btn-primary" style={{ background: 'var(--success)', borderColor: 'var(--success)' }}>
                  {savingDelivery ? 'Saving...' : '✓ Log Delivery & Update Stock'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setDeliveryOpen(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {message && <div className="message">{message}</div>}

      {/* ── Two-panel layout ── */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>

        {/* ── Left: Material List ── */}
        <div style={{ minWidth: 260, maxWidth: 360, flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input
              className="field"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search materials..."
              style={{ flex: 1, minWidth: 0 }}
            />
            <button type="button" className="btn btn-primary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={startNew}>
              ＋ New
            </button>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {loading ? (
              <div className="empty" style={{ padding: 20 }}>Loading...</div>
            ) : (
              <div style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }}>
                {/* Sheet materials */}
                {filteredSheets.length > 0 && (
                  <div>
                    <div style={{ padding: '5px 12px', fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#93c5fd', background: 'rgba(37,99,235,0.1)', borderBottom: '1px solid rgba(37,99,235,0.2)' }}>
                      Sheet ({filteredSheets.length})
                    </div>
                    {filteredSheets.map((row) => {
                      const alloc = batchAllocation[row.id]
                      const allocated = alloc?.totalQty ?? 0
                      const onHand = row.qty_on_hand ?? 0
                      const available = onHand - allocated
                      const isSelected = editingId === row.id
                      return (
                        <div
                          key={row.id}
                          id={`mat-row-${row.id}`}
                          onClick={() => startEdit(row)}
                          style={{
                            padding: '8px 12px',
                            cursor: 'pointer',
                            borderBottom: '1px solid var(--border)',
                            background: isSelected ? 'var(--accent-soft)' : 'transparent',
                            borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
                          }}
                          onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--panel-2)' }}
                          onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                        >
                          <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{row.name}</div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: '0.75rem' }}>
                            <span style={{ color: onHand > 0 ? 'var(--success)' : 'var(--muted)' }}>
                              {onHand ?? '?'} on hand
                            </span>
                            {allocated > 0 && <span style={{ color: '#facc15' }}>−{allocated} alloc</span>}
                            {allocated > 0 && (
                              <span style={{ color: available >= 0 ? 'var(--text-2)' : 'var(--danger)', fontWeight: 700 }}>
                                = {available} avail
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Tube materials */}
                {filteredTubes.length > 0 && (
                  <div>
                    <div style={{ padding: '5px 12px', fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#86efac', background: 'rgba(22,163,74,0.1)', borderBottom: '1px solid rgba(22,163,74,0.2)' }}>
                      Tube ({filteredTubes.length})
                    </div>
                    {filteredTubes.map((row) => {
                      const alloc = batchAllocation[row.id]
                      const allocated = alloc?.totalQty ?? 0
                      const onHand = row.qty_on_hand ?? 0
                      const available = onHand - allocated
                      const isSelected = editingId === row.id
                      return (
                        <div
                          key={row.id}
                          id={`mat-row-${row.id}`}
                          onClick={() => startEdit(row)}
                          style={{
                            padding: '8px 12px',
                            cursor: 'pointer',
                            borderBottom: '1px solid var(--border)',
                            background: isSelected ? 'var(--accent-soft)' : 'transparent',
                            borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
                          }}
                          onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--panel-2)' }}
                          onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                        >
                          <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{row.name}</div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: 1 }}>
                            {row.tube_od} × {row.tube_wall} · {row.stock_length_in ? `${row.stock_length_in}″ bar` : 'no length set'}
                          </div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: '0.75rem' }}>
                            <span style={{ color: onHand > 0 ? 'var(--success)' : 'var(--muted)' }}>
                              {onHand ?? '?'} bars
                            </span>
                            {allocated > 0 && <span style={{ color: '#facc15' }}>−{allocated} alloc</span>}
                            {allocated > 0 && (
                              <span style={{ color: available >= 0 ? 'var(--text-2)' : 'var(--danger)', fontWeight: 700 }}>
                                = {available} avail
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {filteredRows.length === 0 && (
                  <div className="empty" style={{ padding: 20 }}>No materials found.</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Right: Detail Panel ── */}
        <div style={{ flex: 1, minWidth: 0 }}>

          {/* ── Stock & Allocation card (always visible if material selected) ── */}
          {editingRow && (() => {
            const alloc = batchAllocation[editingRow.id]
            const allocated = alloc?.totalQty ?? 0
            const onHand = editingRow.qty_on_hand ?? 0
            const available = onHand - allocated
            const unit = isTubeEdit ? 'bar' : 'sheet'
            return (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-body">
                  <div>
                    <div className="group-title" style={{ marginBottom: 4 }}>{editingRow.name}</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                      {isTubeEdit
                        ? `${editingRow.tube_od} × ${editingRow.tube_wall} · ${editingRow.stock_length_in ?? '?'}″ default bar length`
                        : `${editingRow.thickness ?? '?'} thick · ${editingRow.unit_weight_lbs ?? '?'} lbs/sheet`}
                    </div>
                  </div>

                  {/* Stock summary */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 14 }}>
                    {[
                      { label: 'On Hand', value: onHand, unit, color: onHand > 0 ? 'var(--success)' : 'var(--muted)' },
                      { label: 'Allocated (active batches)', value: allocated, unit, color: allocated > 0 ? '#facc15' : 'var(--muted)' },
                      { label: 'Available', value: available, unit, color: available > 0 ? 'var(--text)' : available === 0 ? 'var(--muted)' : 'var(--danger)' },
                    ].map(({ label, value, unit: u, color }) => (
                      <div key={label} style={{ padding: '10px 14px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                        <div style={{ fontSize: '0.72rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 800, color }}>{value}</div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{u}{Math.abs(value) !== 1 ? 's' : ''}</div>
                      </div>
                    ))}
                  </div>

                  {/* Batch allocation breakdown */}
                  {alloc && alloc.batches.length > 0 && (
                    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Active Batch Allocation
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {alloc.batches.map((b) => {
                          const ss = STATUS_STYLE[b.status] ?? STATUS_STYLE.planned
                          return (
                            <div key={b.id} style={{ padding: '6px 12px', background: ss.bg, border: `1px solid ${ss.color}33`, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: '0.72rem', color: ss.color, fontWeight: 700 }}>{ss.label}</span>
                              <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>{b.name}</span>
                              <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                                {b.qty} {unit}{b.qty !== 1 ? 's' : ''}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                </div>
              </div>
            )
          })()}

          {/* ── Edit / Add Material form ── */}
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">{editingId ? 'Edit Material' : 'Add Material'}</h2>
              <div className="card-subtitle">Name is auto-generated from the selections below.</div>
            </div>
            <div className="card-body">
              <form onSubmit={(e) => void handleSubmit(e)}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
                  <div>
                    <label className="label">Type</label>
                    <select className="select" value={form.material_type} onChange={(e) => updateField('material_type', e.target.value)}>
                      <option value="sheet">Sheet</option>
                      <option value="tube">Tube</option>
                    </select>
                  </div>

                  {form.material_type === 'tube' && (
                    <div>
                      <label className="label">Tube Shape</label>
                      <select className="select" value={form.tube_shape} onChange={(e) => updateField('tube_shape', e.target.value)}>
                        <option value="round">Round</option>
                        <option value="square">Square</option>
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="label">Material</label>
                    <input className="field" value={form.material} onChange={(e) => updateField('material', e.target.value)} placeholder="DOM / HRPO / Steel / Aluminum" />
                  </div>

                  {form.material_type === 'sheet' ? (
                    <div>
                      <label className="label">Thickness</label>
                      <input className="field" value={form.sheet_thickness} onChange={(e) => updateField('sheet_thickness', e.target.value)} placeholder="3/16" />
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className="label">Dimension</label>
                        <input className="field" value={form.tube_dimension} onChange={(e) => updateField('tube_dimension', e.target.value)} placeholder={form.tube_shape === 'square' ? '2 x 2' : '1.75'} />
                      </div>
                      <div>
                        <label className="label">Wall Thickness</label>
                        <input className="field" value={form.wall_thickness} onChange={(e) => updateField('wall_thickness', e.target.value)} placeholder=".120" />
                      </div>
                    </>
                  )}

                  <div style={{ gridColumn: '1 / -1' }}>
                    <label className="label">Generated Name</label>
                    <input className="field" value={generatedName} readOnly placeholder="Auto-generated" />
                  </div>

                  <div>
                    <label className="label">Unit Weight (lbs) — one {form.material_type === 'tube' ? 'bar' : 'sheet'}</label>
                    <input className="field" type="number" step="0.01" min="0" value={form.unit_weight_lbs} onChange={(e) => updateField('unit_weight_lbs', e.target.value)} placeholder="130" />
                  </div>

                  {form.material_type === 'tube' && (
                    <div>
                      <label className="label">
                        Default Stock Length (inches)
                        <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6, fontSize: '0.75rem' }}>20ft = 240, 24ft = 288</span>
                      </label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input className="field" type="number" step="1" min="1" value={form.stock_length_in} onChange={(e) => updateField('stock_length_in', e.target.value)} placeholder="240" />
                        <div style={{ display: 'flex', gap: 4 }}>
                          {[['20ft', '240'], ['24ft', '288']].map(([label, val]) => (
                            <button key={val} type="button" className="btn btn-secondary"
                              style={{ height: 32, fontSize: '0.75rem', padding: '0 10px', whiteSpace: 'nowrap',
                                background: form.stock_length_in === val ? 'var(--accent)' : undefined,
                                color: form.stock_length_in === val ? '#fff' : undefined }}
                              onClick={() => updateField('stock_length_in', val)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="label">Scrap / Utilization Rate (%)</label>
                    <input className="field" type="number" step="0.1" min="0" max="100" value={form.scrap_rate} onChange={(e) => updateField('scrap_rate', e.target.value)} placeholder="10" />
                  </div>

                  <div>
                    <label className="label">
                      Stock On Hand
                      <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6, fontSize: '0.75rem' }}>{form.material_type === 'tube' ? '— bars' : '— sheets'}</span>
                    </label>
                    <input className="field" type="number" step="0.5" min="0" value={form.qty_on_hand} onChange={(e) => updateField('qty_on_hand', e.target.value)} placeholder="0" />
                  </div>

                  <div style={{ gridColumn: '1 / -1' }}>
                    <label className="label">Notes</label>
                    <textarea className="textarea" value={form.notes} onChange={(e) => updateField('notes', e.target.value)} rows={2} placeholder="Optional notes" />
                  </div>
                </div>

                <div className="btn-row" style={{ marginTop: 16 }}>
                  <button type="submit" disabled={saving} className="btn btn-primary">
                    {saving ? 'Saving...' : editingId ? 'Update Material' : 'Save Material'}
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={startNew}>New</button>
                  {editingId && <button type="button" className="btn btn-danger" onClick={() => void handleDelete()}>Delete</button>}
                </div>
                {message && <div className="message" style={{ marginTop: 10 }}>{message}</div>}
              </form>
            </div>
          </section>

          {/* ── Price / Purchase History ── */}
          {editingId && (
            <section className="card">
              <div className="card-header">
                <h2 className="card-title">Purchase History</h2>
                <div className="card-subtitle">{editingId} — price trends and past orders.</div>
              </div>
              <div className="card-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, alignItems: 'start' }}>
                  {/* Log price form (manual, no qty change) */}
                  <div>
                    <div className="group-title" style={{ marginBottom: 12 }}>Log Price (no stock change)</div>
                    <form onSubmit={(e) => void handleSavePrice(e)}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <div>
                          <label className="label">Price ($)</label>
                          <input className="field" type="number" step="0.01" min="0" value={priceForm.price}
                            onChange={(e) => setPriceForm((p) => ({ ...p, price: e.target.value }))} placeholder="0.00" />
                        </div>
                        <div>
                          <label className="label">Date</label>
                          <input className="field" type="date" value={priceForm.date_purchased}
                            onChange={(e) => setPriceForm((p) => ({ ...p, date_purchased: e.target.value }))} />
                        </div>
                        <div>
                          <label className="label">Order #</label>
                          <input className="field" value={priceForm.order_number}
                            onChange={(e) => setPriceForm((p) => ({ ...p, order_number: e.target.value }))} placeholder="PO-12345" />
                        </div>
                        <div>
                          <label className="label">Supplier</label>
                          <input className="field" value={priceForm.supplier}
                            onChange={(e) => setPriceForm((p) => ({ ...p, supplier: e.target.value }))} placeholder="Supplier name" />
                        </div>
                        <div style={{ gridColumn: '1 / -1' }}>
                          <label className="label">Notes</label>
                          <input className="field" value={priceForm.notes}
                            onChange={(e) => setPriceForm((p) => ({ ...p, notes: e.target.value }))} placeholder="Optional" />
                        </div>
                      </div>
                      <div className="btn-row" style={{ marginTop: 10 }}>
                        <button type="submit" disabled={savingPrice} className="btn btn-secondary">
                          {savingPrice ? 'Saving...' : 'Log Price'}
                        </button>
                      </div>
                      {priceMessage && <div className="message" style={{ marginTop: 8 }}>{priceMessage}</div>}
                    </form>
                  </div>

                  {/* Price chart */}
                  <div>
                    <div className="group-title" style={{ marginBottom: 12 }}>Price Over Time</div>
                    {loadingPriceLogs ? (
                      <div className="empty">Loading...</div>
                    ) : priceLogs.length < 2 ? (
                      <div className="empty" style={{ fontSize: '0.83rem' }}>Need at least 2 price entries for chart.</div>
                    ) : (
                      <PriceChart entries={priceLogs} />
                    )}
                    {lastPurchase && (
                      <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Last Purchase</div>
                        <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent)' }}>${lastPurchase.price.toFixed(2)}</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 2 }}>
                          {lastPurchase.date_purchased}
                          {lastPurchase.supplier && ` · ${lastPurchase.supplier}`}
                          {lastPurchase.order_number && ` · ${lastPurchase.order_number}`}
                          {lastPurchase.qty_received && ` · ${lastPurchase.qty_received} ${isTubeEdit ? 'bars' : 'sheets'} received`}
                          {lastPurchase.length_per_bar_in && ` · ${lastPurchase.length_per_bar_in}″/bar`}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Full history table */}
                {priceLogs.length > 0 && (
                  <div style={{ marginTop: 24 }}>
                    <div className="group-title" style={{ marginBottom: 10 }}>All Entries</div>
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th style={{ textAlign: 'right' }}>Price/unit</th>
                            {isTubeEdit && <th style={{ textAlign: 'center' }}>Bar Length</th>}
                            <th style={{ textAlign: 'center' }}>Qty Recv'd</th>
                            <th>Order #</th>
                            <th>Supplier</th>
                            <th>Notes</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {priceLogs.map((entry) => (
                            <tr key={entry.id}>
                              <td style={{ whiteSpace: 'nowrap' }}>{entry.date_purchased}</td>
                              <td style={{ textAlign: 'right', fontWeight: 700, fontFamily: 'monospace' }}>${entry.price.toFixed(2)}</td>
                              {isTubeEdit && (
                                <td style={{ textAlign: 'center', fontSize: '0.83rem', color: 'var(--text-2)' }}>
                                  {entry.length_per_bar_in ? `${entry.length_per_bar_in}″` : <span style={{ color: 'var(--muted)' }}>—</span>}
                                </td>
                              )}
                              <td style={{ textAlign: 'center', fontSize: '0.83rem' }}>
                                {entry.qty_received != null
                                  ? <span style={{ fontWeight: 600, color: 'var(--success)' }}>+{entry.qty_received}</span>
                                  : <span style={{ color: 'var(--muted)' }}>—</span>}
                              </td>
                              <td style={{ fontSize: '0.83rem' }}>{entry.order_number || ''}</td>
                              <td style={{ fontSize: '0.83rem' }}>{entry.supplier || ''}</td>
                              <td style={{ fontSize: '0.83rem', color: 'var(--text-2)' }}>{entry.notes || ''}</td>
                              <td>
                                <button className="btn btn-danger" style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                                  onClick={() => void handleDeletePriceLog(entry.id)}>
                                  ✕
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

        </div>
      </div>
    </div>
  )
}
