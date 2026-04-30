'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

const SA_IMAGE_BUCKET = 'subassembly-images'

export type PickableSA = {
  id: string
  name: string
  notes?: string | null
  image_file?: string | null
  requires_weld?: boolean | null
}

type Props = {
  subassemblies: PickableSA[]
  /** Called on plain click (single select) — modal closes automatically. */
  onSelect: (sa: PickableSA) => void
  /**
   * Optional — enables Ctrl+click multi-select. When provided an "Add X Selected"
   * button appears and calls this with all selected SAs when clicked.
   */
  onSelectMultiple?: (sas: PickableSA[]) => void
  onClose: () => void
}

export default function SubAssemblyPickerModal({ subassemblies, onSelect, onSelectMultiple, onClose }: Props) {
  const [search, setSearch]         = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const searchRef                   = useRef<HTMLInputElement>(null)
  const supabase                    = useMemo(() => createBrowserClient(), [])

  useEffect(() => {
    searchRef.current?.focus()
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (selectedIds.size > 0) { setSelectedIds(new Set()); return }
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, selectedIds])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return subassemblies
    return subassemblies.filter((sa) =>
      [sa.id, sa.name, sa.notes ?? ''].join(' ').toLowerCase().includes(q)
    )
  }, [subassemblies, search])

  function handleCardClick(sa: PickableSA, e: React.MouseEvent) {
    if ((e.ctrlKey || e.metaKey) && onSelectMultiple) {
      // Ctrl/Cmd+click → toggle in multi-select
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(sa.id)) next.delete(sa.id)
        else next.add(sa.id)
        return next
      })
    } else if (selectedIds.size > 0 && onSelectMultiple) {
      // Already in multi-select mode — regular click also toggles
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(sa.id)) next.delete(sa.id)
        else next.add(sa.id)
        return next
      })
    } else {
      // Plain click → single select + close
      onSelect(sa)
      onClose()
    }
  }

  function handleAddSelected() {
    if (!onSelectMultiple || selectedIds.size === 0) return
    const picked = subassemblies.filter((sa) => selectedIds.has(sa.id))
    onSelectMultiple(picked)
    onClose()
  }

  const selectedCount = selectedIds.size

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
          maxWidth: 860,
          maxHeight: 'calc(100vh - 96px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.65)',
        }}
      >
        {/* ── Header ── */}
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }}>🔍</span>
            <input
              ref={searchRef}
              className="field"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sub-assembly ID or name…"
              style={{ paddingLeft: 34, fontSize: '0.92rem' }}
            />
          </div>

          {/* Add Selected button — shown when multi-select is active */}
          {onSelectMultiple && selectedCount > 0 && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '6px 14px', fontSize: '0.82rem', whiteSpace: 'nowrap' }}
              onClick={handleAddSelected}
            >
              ✓ Add {selectedCount} Selected
            </button>
          )}

          <button type="button" className="btn btn-secondary" style={{ padding: '6px 10px', lineHeight: 1 }} onClick={onClose}>✕</button>
        </div>

        {/* ── Count bar ── */}
        <div style={{ padding: '7px 16px', fontSize: '0.76rem', color: 'var(--muted)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {filtered.length} sub-assembl{filtered.length !== 1 ? 'ies' : 'y'}
          {search ? ` matching "${search}"` : ''}
          {onSelectMultiple
            ? selectedCount > 0
              ? ` — ${selectedCount} selected — click to toggle, Ctrl+click to multi-select`
              : ' — click to add · Ctrl+click to multi-select'
            : ' — click to add'}
        </div>

        {/* ── Card grid ── */}
        <div
          style={{
            overflowY: 'auto',
            padding: 14,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 10,
            alignContent: 'start',
          }}
        >
          {filtered.length === 0 ? (
            <div className="empty" style={{ gridColumn: '1 / -1', padding: '40px 0' }}>No sub-assemblies found.</div>
          ) : (
            filtered.map((sa) => {
              const isSelected = selectedIds.has(sa.id)
              const imgUrl = sa.image_file
                ? supabase.storage.from(SA_IMAGE_BUCKET).getPublicUrl(sa.image_file).data.publicUrl
                : null

              return (
                <button
                  key={sa.id}
                  type="button"
                  onClick={(e) => handleCardClick(sa, e)}
                  style={{
                    background: isSelected ? 'var(--accent-soft)' : 'var(--panel-2)',
                    border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 8,
                    padding: 0,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    textAlign: 'left',
                    transition: 'border-color 0.13s, background 0.13s',
                    width: '100%',
                    overflow: 'visible',
                    position: 'relative',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.borderColor = 'var(--accent)'
                      e.currentTarget.style.background = 'var(--accent-soft)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.borderColor = 'var(--border)'
                      e.currentTarget.style.background = 'var(--panel-2)'
                    }
                  }}
                >
                  {/* Checkmark badge when selected */}
                  {isSelected && (
                    <div style={{
                      position: 'absolute', top: 6, right: 6, zIndex: 2,
                      width: 22, height: 22, borderRadius: '50%',
                      background: 'var(--accent)', color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.75rem', fontWeight: 700, boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                    }}>✓</div>
                  )}

                  {/* Image / placeholder */}
                  {imgUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imgUrl}
                      alt={sa.name}
                      style={{ width: '100%', height: 130, objectFit: 'cover', display: 'block', borderRadius: '6px 6px 0 0', flexShrink: 0 }}
                      onError={(e) => { e.currentTarget.style.display = 'none' }}
                    />
                  ) : (
                    <div style={{ width: '100%', height: 130, flexShrink: 0, background: 'var(--panel)', borderRadius: '6px 6px 0 0', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: '2rem', opacity: 0.4 }}>🔧</span>
                    </div>
                  )}

                  {/* Info */}
                  <div style={{ padding: '10px 11px 11px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.25)', borderRadius: 4, padding: '2px 5px', flexShrink: 0, lineHeight: 1.4 }}>
                        SA
                      </span>
                      <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text)', wordBreak: 'break-word', lineHeight: 1.2 }}>
                        {sa.name}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--muted)', fontFamily: 'monospace' }}>{sa.id}</div>
                    {sa.requires_weld && (
                      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#f97316', background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 4, padding: '2px 6px', alignSelf: 'flex-start' }}>
                        Requires Weld
                      </div>
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
