'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type SKU = {
  id: string
  description: string
  category: string | null
  active: boolean
}

type InventoryRow = {
  sku_id: string
  qty_on_hand: number
  target_stock: number
  notes: string | null
  updated_at: string | null
}

type InventoryDisplay = {
  sku_id: string
  description: string
  category: string | null
  qty_on_hand: number
  target_stock: number
  committed: number
  available: number
  need_to_build: number
  notes: string | null
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const supabase = useMemo(() => createBrowserClient(), [])

  const [skus, setSkus] = useState<SKU[]>([])
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [committed, setCommitted] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editOnHand, setEditOnHand] = useState('')
  const [editTarget, setEditTarget] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function loadSkus() {
    const { data } = await supabase
      .from('skus')
      .select('id, description, category, active')
      .eq('active', true)
      .order('category', { ascending: true })
      .order('id', { ascending: true })
    setSkus((data ?? []) as SKU[])
  }

  async function loadInventory() {
    const { data } = await supabase
      .from('sku_inventory')
      .select('sku_id, qty_on_hand, target_stock, notes, updated_at')
    setInventory((data ?? []) as InventoryRow[])
  }

  // Calculate committed qty per SKU from open order_lines
  async function loadCommitted() {
    const { data } = await supabase
      .from('order_lines')
      .select(`
        sku_id, qty,
        order:order_id(status)
      `)
      .not('sku_id', 'is', null)

    if (!data) return
    const map: Record<string, number> = {}
    for (const line of data as any[]) {
      if (line.order?.status !== 'open') continue
      const id = line.sku_id as string
      map[id] = (map[id] ?? 0) + (line.qty as number)
    }
    setCommitted(map)
  }

  async function initialLoad() {
    setLoading(true)
    await Promise.all([loadSkus(), loadInventory(), loadCommitted()])
    setLoading(false)
  }

  useEffect(() => { void initialLoad() }, [])

  // ── Save inventory row ────────────────────────────────────────────────────────
  async function saveRow(skuId: string) {
    setSaving(true)
    setMessage('')
    const onHand = parseInt(editOnHand, 10)
    const target = parseInt(editTarget, 10)

    if (isNaN(onHand) || onHand < 0) {
      setMessage('On-hand qty must be 0 or greater.')
      setSaving(false)
      return
    }

    const { error } = await supabase
      .from('sku_inventory')
      .upsert(
        {
          sku_id:       skuId,
          qty_on_hand:  onHand,
          target_stock: isNaN(target) ? 0 : target,
          notes:        editNotes.trim() || null,
          updated_at:   new Date().toISOString(),
        },
        { onConflict: 'sku_id' }
      )

    if (error) {
      setMessage(`Save failed: ${error.message}`)
    } else {
      setEditingId(null)
      await loadInventory()
    }
    setSaving(false)
  }

  function startEdit(row: InventoryDisplay) {
    setEditingId(row.sku_id)
    setEditOnHand(String(row.qty_on_hand))
    setEditTarget(String(row.target_stock))
    setEditNotes(row.notes ?? '')
    setMessage('')
  }

  // ── Build display rows ────────────────────────────────────────────────────────
  const inventoryMap = inventory.reduce<Record<string, InventoryRow>>((acc, r) => {
    acc[r.sku_id] = r
    return acc
  }, {})

  const displayRows: InventoryDisplay[] = skus
    .filter((sku) => {
      const q = search.trim().toLowerCase()
      if (!q) return true
      return `${sku.id} ${sku.description} ${sku.category ?? ''}`.toLowerCase().includes(q)
    })
    .map((sku) => {
      const inv       = inventoryMap[sku.id]
      const onHand    = inv?.qty_on_hand ?? 0
      const target    = inv?.target_stock ?? 0
      const comm      = committed[sku.id] ?? 0
      const available = onHand - comm
      const need      = Math.max(0, target - available)
      return {
        sku_id:       sku.id,
        description:  sku.description,
        category:     sku.category,
        qty_on_hand:  onHand,
        target_stock: target,
        committed:    comm,
        available,
        need_to_build: need,
        notes:        inv?.notes ?? null,
      }
    })

  const totalOnHand    = displayRows.reduce((s, r) => s + r.qty_on_hand, 0)
  const totalCommitted = displayRows.reduce((s, r) => s + r.committed, 0)
  const totalNeedBuild = displayRows.reduce((s, r) => s + r.need_to_build, 0)

  const categories = [...new Set(skus.map((s) => s.category ?? 'Uncategorized'))]

  // ── Status color for available column ─────────────────────────────────────────
  function availColor(row: InventoryDisplay) {
    if (row.available < 0) return 'var(--danger)'
    if (row.available < row.target_stock) return 'var(--warning)'
    return 'var(--success)'
  }

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Finished Goods Inventory</h1>
          <div className="page-subtitle">
            Track on-hand stock, set target levels, and see what needs to be built to fill open orders.
          </div>
        </div>
      </div>

      {/* ── Summary stat cards ───────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        {[
          { label: 'Total On Hand',    value: totalOnHand,    color: 'var(--success)' },
          { label: 'Committed (Open Orders)', value: totalCommitted, color: 'var(--warning)' },
          { label: 'Need to Build',    value: totalNeedBuild, color: totalNeedBuild > 0 ? 'var(--danger)' : 'var(--success)' },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '18px 22px',
            }}
          >
            <div style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              {stat.label}
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 800, color: stat.color }}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      {/* ── Inventory Table ──────────────────────────────────────────────────── */}
      <section className="card">
        <div
          className="card-header"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}
        >
          <div>
            <h2 className="card-title">SKU Inventory</h2>
            <div className="card-subtitle">Click a row to edit on-hand qty and target stock.</div>
          </div>
          <div style={{ position: 'relative', minWidth: 240 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }}>🔍</span>
            <input
              className="field"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SKU or description…"
              style={{ paddingLeft: 36 }}
            />
          </div>
        </div>

        <div className="card-body">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : displayRows.length === 0 ? (
            <div className="empty">No SKUs found.</div>
          ) : (
            <>
              {message && <div className="warning-box" style={{ marginBottom: 14 }}>{message}</div>}

              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Description</th>
                      <th>Category</th>
                      <th style={{ textAlign: 'center' }}>On Hand</th>
                      <th style={{ textAlign: 'center' }}>Committed</th>
                      <th style={{ textAlign: 'center' }}>Available</th>
                      <th style={{ textAlign: 'center' }}>Target Stock</th>
                      <th style={{ textAlign: 'center' }}>Need to Build</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((row) => {
                      const isEditing = editingId === row.sku_id
                      return (
                        <tr
                          key={row.sku_id}
                          style={{ background: isEditing ? 'var(--accent-soft)' : 'transparent' }}
                        >
                          <td style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                            {row.sku_id}
                          </td>
                          <td>{row.description}</td>
                          <td style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>
                            {row.category ?? '—'}
                          </td>

                          {/* On Hand */}
                          <td style={{ textAlign: 'center' }}>
                            {isEditing ? (
                              <input
                                className="field-sm"
                                type="number"
                                min="0"
                                value={editOnHand}
                                onChange={(e) => setEditOnHand(e.target.value)}
                                style={{ width: 60, textAlign: 'center' }}
                                autoFocus
                              />
                            ) : (
                              <span style={{ fontWeight: 700 }}>{row.qty_on_hand}</span>
                            )}
                          </td>

                          {/* Committed */}
                          <td style={{ textAlign: 'center', color: row.committed > 0 ? 'var(--warning)' : 'var(--muted)' }}>
                            {row.committed}
                          </td>

                          {/* Available */}
                          <td style={{ textAlign: 'center', fontWeight: 700, color: availColor(row) }}>
                            {row.available}
                          </td>

                          {/* Target Stock */}
                          <td style={{ textAlign: 'center' }}>
                            {isEditing ? (
                              <input
                                className="field-sm"
                                type="number"
                                min="0"
                                value={editTarget}
                                onChange={(e) => setEditTarget(e.target.value)}
                                style={{ width: 60, textAlign: 'center' }}
                              />
                            ) : (
                              <span style={{ color: 'var(--muted)' }}>{row.target_stock}</span>
                            )}
                          </td>

                          {/* Need to Build */}
                          <td style={{ textAlign: 'center' }}>
                            {row.need_to_build > 0 ? (
                              <span style={{
                                background: 'rgba(239,68,68,0.15)',
                                color: 'var(--danger)',
                                borderRadius: 12,
                                padding: '2px 10px',
                                fontWeight: 700,
                                fontSize: '0.85rem',
                              }}>
                                {row.need_to_build}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--success)' }}>✓</span>
                            )}
                          </td>

                          {/* Actions */}
                          <td>
                            {isEditing ? (
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  className="btn btn-primary"
                                  style={{ height: 28, fontSize: '0.76rem', padding: '0 10px' }}
                                  onClick={() => saveRow(row.sku_id)}
                                  disabled={saving}
                                >
                                  {saving ? '…' : 'Save'}
                                </button>
                                <button
                                  className="btn btn-secondary"
                                  style={{ height: 28, fontSize: '0.76rem', padding: '0 8px' }}
                                  onClick={() => setEditingId(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                className="btn btn-secondary"
                                style={{ height: 28, fontSize: '0.76rem', padding: '0 10px' }}
                                onClick={() => startEdit(row)}
                              >
                                Edit
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3} style={{ fontWeight: 700, color: 'var(--muted)' }}>
                        {displayRows.length} SKUs
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 700 }}>{totalOnHand}</td>
                      <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--warning)' }}>{totalCommitted}</td>
                      <td style={{ textAlign: 'center', fontWeight: 700 }}>
                        {displayRows.reduce((s, r) => s + r.available, 0)}
                      </td>
                      <td />
                      <td style={{ textAlign: 'center', fontWeight: 700, color: totalNeedBuild > 0 ? 'var(--danger)' : 'var(--success)' }}>
                        {totalNeedBuild > 0 ? totalNeedBuild : '✓'}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── How it works note ────────────────────────────────────────────────── */}
      <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px', fontSize: '0.84rem', color: 'var(--text-2)', lineHeight: 1.7 }}>
        <strong>How this works:</strong> On Hand = physically in stock. Committed = qty tied up in open ShipStation orders.
        Available = On Hand − Committed. Need to Build = max(0, Target Stock − Available).
        Sync orders on the <a href="/orders" style={{ color: 'var(--accent)' }}>Orders page</a> to keep committed quantities current.
      </div>
    </div>
  )
}
