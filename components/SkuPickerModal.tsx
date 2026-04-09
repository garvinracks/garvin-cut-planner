'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

export type PickableSKU = {
  id: string
  description: string
  category: string | null
  active: boolean
}

type Props = {
  skus: PickableSKU[]
  onSelect: (skus: PickableSKU[]) => void
  onClose: () => void
}

// Category accent colours
const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  Racks:        { bg: 'rgba(59,130,246,0.12)',  text: '#60a5fa', border: 'rgba(59,130,246,0.25)'  },
  Ladders:      { bg: 'rgba(34,197,94,0.12)',   text: '#4ade80', border: 'rgba(34,197,94,0.25)'   },
  Accessories:  { bg: 'rgba(168,85,247,0.12)',  text: '#c084fc', border: 'rgba(168,85,247,0.25)'  },
  Deflectors:   { bg: 'rgba(249,115,22,0.12)',  text: '#fb923c', border: 'rgba(249,115,22,0.25)'  },
}

function catColor(cat: string | null) {
  const key = cat ?? ''
  return (
    CATEGORY_COLORS[key] ?? { bg: 'rgba(170,170,192,0.10)', text: '#aaaac0', border: 'rgba(170,170,192,0.20)' }
  )
}

function catLabel(cat: string | null) {
  return cat ?? 'Uncategorized'
}

export default function SkuPickerModal({ skus, onSelect, onClose }: Props) {
  const [search, setSearch]               = useState('')
  const [catFilter, setCatFilter]         = useState<string>('all')
  const [selected, setSelected]           = useState<Set<string>>(new Set())
  const searchRef                         = useRef<HTMLInputElement>(null)

  // Unique categories from data
  const categories = useMemo(() => {
    const seen = new Set<string>()
    const list: Array<string | null> = []
    for (const s of skus) {
      const key = s.category ?? null
      const label = catLabel(key)
      if (!seen.has(label)) { seen.add(label); list.push(key) }
    }
    return list
  }, [skus])

  useEffect(() => {
    searchRef.current?.focus()
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (selected.size > 0) { setSelected(new Set()); return }
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, selected])

  const isFiltering = search.trim() !== '' || catFilter !== 'all'

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return skus.filter((s) => {
      if (catFilter !== 'all' && catLabel(s.category) !== catFilter) return false
      if (!q) return true
      return (s.id + ' ' + s.description).toLowerCase().includes(q)
    })
  }, [skus, search, catFilter])

  // Grouped by category (used when not filtering)
  const grouped = useMemo(() => {
    const map = new Map<string, PickableSKU[]>()
    for (const s of filtered) {
      const key = catLabel(s.category)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    }
    return map
  }, [filtered])

  function handleCardClick(e: React.MouseEvent, sku: PickableSKU) {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click → toggle in multi-select
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(sku.id)) next.delete(sku.id)
        else next.add(sku.id)
        return next
      })
    } else if (selected.size > 0) {
      // If already in multi-select mode, regular click also toggles
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(sku.id)) next.delete(sku.id)
        else next.add(sku.id)
        return next
      })
    } else {
      // Plain click with no selection → immediate add + close
      onSelect([sku])
      onClose()
    }
  }

  function handleAddSelected() {
    const picked = skus.filter((s) => selected.has(s.id))
    onSelect(picked)
    onClose()
  }

  const renderCards = (list: PickableSKU[]) =>
    list.map((sku) => {
      const isSelected = selected.has(sku.id)
      const cc = catColor(sku.category)
      return (
        <button
          key={sku.id}
          type="button"
          onClick={(e) => handleCardClick(e, sku)}
          style={{
            background: isSelected ? 'var(--accent-soft)' : 'var(--panel-2)',
            border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 8,
            padding: '12px 13px',
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            textAlign: 'left',
            position: 'relative',
            transition: 'border-color 0.13s, background 0.13s',
          }}
          onMouseEnter={(e) => {
            if (!isSelected) {
              e.currentTarget.style.borderColor = 'var(--accent)'
              e.currentTarget.style.background   = 'var(--accent-soft)'
            }
          }}
          onMouseLeave={(e) => {
            if (!isSelected) {
              e.currentTarget.style.borderColor = 'var(--border)'
              e.currentTarget.style.background   = 'var(--panel-2)'
            }
          }}
        >
          {/* Checkmark overlay when selected */}
          {isSelected && (
            <span
              style={{
                position: 'absolute',
                top: 8,
                right: 9,
                width: 18,
                height: 18,
                background: 'var(--accent)',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.7rem',
                color: '#fff',
                fontWeight: 700,
              }}
            >
              ✓
            </span>
          )}

          {/* SKU ID — prominent */}
          <div
            style={{
              fontWeight: 700,
              fontSize: '0.88rem',
              color: 'var(--text)',
              letterSpacing: '0.01em',
              paddingRight: isSelected ? 24 : 0,
            }}
          >
            {sku.id}
          </div>

          {/* Description */}
          {sku.description && (
            <div
              style={{
                fontSize: '0.74rem',
                color: 'var(--text-2)',
                lineHeight: 1.4,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {sku.description}
            </div>
          )}

          {/* Category badge */}
          <div style={{ marginTop: 2 }}>
            <span
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
                background: cc.bg,
                color: cc.text,
                border: `1px solid ${cc.border}`,
                borderRadius: 4,
                padding: '2px 5px',
                lineHeight: 1.4,
              }}
            >
              {catLabel(sku.category)}
            </span>
          </div>
        </button>
      )
    })

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.72)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 48,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          width: '100%',
          maxWidth: 900,
          maxHeight: 'calc(100vh - 96px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.65)',
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          {/* Search */}
          <div style={{ flex: 1, position: 'relative' }}>
            <span
              style={{
                position: 'absolute',
                left: 11,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--muted)',
                pointerEvents: 'none',
              }}
            >
              🔍
            </span>
            <input
              ref={searchRef}
              className="field"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setCatFilter('all') }}
              placeholder="Search SKU number or description…"
              style={{ paddingLeft: 34, fontSize: '0.92rem' }}
            />
          </div>

          {/* Category filter pills */}
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              className={`btn ${catFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ padding: '6px 14px', fontSize: '0.8rem' }}
              onClick={() => setCatFilter('all')}
            >
              All
            </button>
            {categories.map((cat) => {
              const label = catLabel(cat)
              const cc = catColor(cat)
              const active = catFilter === label
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => { setCatFilter(active ? 'all' : label); setSearch('') }}
                  style={{
                    padding: '6px 14px',
                    fontSize: '0.8rem',
                    borderRadius: 6,
                    border: `1px solid ${active ? cc.border : 'var(--border)'}`,
                    background: active ? cc.bg : 'var(--panel-2)',
                    color: active ? cc.text : 'var(--text-2)',
                    cursor: 'pointer',
                    fontWeight: active ? 700 : 500,
                    transition: 'all 0.12s',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: '6px 10px', lineHeight: 1, flexShrink: 0 }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* ── Status bar ── */}
        <div
          style={{
            padding: '7px 16px',
            fontSize: '0.76rem',
            color: 'var(--muted)',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>
            {filtered.length} SKU{filtered.length !== 1 ? 's' : ''}
            {search ? ` matching "${search}"` : ''}
            {' — '}
            {selected.size === 0
              ? 'click to add • Ctrl+click to multi-select'
              : `${selected.size} selected`}
          </span>
          {selected.size > 0 && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '5px 16px', fontSize: '0.8rem' }}
              onClick={handleAddSelected}
            >
              Add {selected.size} to Build
            </button>
          )}
        </div>

        {/* ── Card grid ── */}
        <div style={{ overflowY: 'auto', padding: 14, flex: 1 }}>
          {filtered.length === 0 ? (
            <div className="empty" style={{ padding: '40px 0' }}>
              No matching SKUs.
            </div>
          ) : isFiltering ? (
            /* Flat grid when filtering/searching */
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                gap: 10,
                alignContent: 'start',
                alignItems: 'start',
              }}
            >
              {renderCards(filtered)}
            </div>
          ) : (
            /* Grouped by category when showing all */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              {Array.from(grouped.entries()).map(([groupLabel, groupSkus]) => {
                const cat = groupSkus[0]?.category ?? null
                const cc  = catColor(cat)
                return (
                  <div key={groupLabel}>
                    {/* Group header */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        marginBottom: 10,
                      }}
                    >
                      <span
                        style={{
                          fontSize: '0.68rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.1em',
                          color: cc.text,
                        }}
                      >
                        {groupLabel}
                      </span>
                      <span
                        style={{
                          fontSize: '0.68rem',
                          color: 'var(--muted)',
                          background: 'var(--panel-2)',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          padding: '1px 6px',
                        }}
                      >
                        {groupSkus.length}
                      </span>
                      <div
                        style={{
                          flex: 1,
                          height: 1,
                          background: 'var(--border)',
                        }}
                      />
                    </div>

                    {/* Cards */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                        gap: 10,
                        alignContent: 'start',
                        alignItems: 'start',
                      }}
                    >
                      {renderCards(groupSkus)}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
