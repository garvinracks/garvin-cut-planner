'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import DxfPartPreview from '@/components/DxfPartPreview'

export type PickablePart = {
  id: string
  part_number: string
  description: string
  part_type: 'tube' | 'sheet'
  dxf_file: string | null
  material: string | null
  thickness: string | null
  tube_od: string | null
  tube_wall: string | null
}

type Props = {
  parts: PickablePart[]
  onSelect: (part: PickablePart) => void
  onClose: () => void
}

export default function PartPickerModal({ parts, onSelect, onClose }: Props) {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'sheet' | 'tube'>('all')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    searchRef.current?.focus()

    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return parts.filter((p) => {
      if (typeFilter !== 'all' && p.part_type !== typeFilter) return false
      if (!q) return true
      return [
        p.part_number,
        p.description,
        p.material || '',
        p.thickness || '',
        p.tube_od || '',
        p.tube_wall || '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [parts, search, typeFilter])

  function partSubtitle(p: PickablePart) {
    if (p.part_type === 'sheet') {
      return [p.thickness, p.material].filter(Boolean).join(' · ')
    }
    return [p.tube_od, p.tube_wall, p.material].filter(Boolean).join(' · ')
  }

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
        paddingTop: 60,
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
          maxHeight: 'calc(100vh - 120px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, position: 'relative' }}>
            <span
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--muted)',
                pointerEvents: 'none',
                fontSize: '1rem',
              }}
            >
              🔍
            </span>
            <input
              ref={searchRef}
              className="field"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search part number, description, material…"
              style={{ paddingLeft: 36, fontSize: '0.95rem' }}
            />
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            {(['all', 'sheet', 'tube'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`btn ${typeFilter === t ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                onClick={() => setTypeFilter(t)}
              >
                {t === 'all' ? 'All' : t === 'sheet' ? 'Sheet' : 'Tube'}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: '6px 10px', fontSize: '1rem', lineHeight: 1 }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Count */}
        <div
          style={{
            padding: '8px 20px',
            fontSize: '0.78rem',
            color: 'var(--muted)',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          {filtered.length} part{filtered.length !== 1 ? 's' : ''}
          {search && ` matching "${search}"`}
          {' — click a card to select'}
        </div>

        {/* Grid */}
        <div
          style={{
            overflowY: 'auto',
            padding: 16,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 12,
            alignContent: 'start',
          }}
        >
          {filtered.length === 0 ? (
            <div
              className="empty"
              style={{ gridColumn: '1 / -1', padding: '40px 0' }}
            >
              No matching parts.
            </div>
          ) : (
            filtered.map((part) => (
              <button
                key={part.id}
                type="button"
                onClick={() => onSelect(part)}
                style={{
                  background: 'var(--panel-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 0,
                  cursor: 'pointer',
                  text: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  transition: 'border-color 0.15s, background 0.15s',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'
                  ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-soft)'
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'
                  ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--panel-2)'
                }}
              >
                {/* DXF preview area */}
                <div
                  style={{
                    width: '100%',
                    height: 110,
                    background: 'var(--panel)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderBottom: '1px solid var(--border)',
                    overflow: 'hidden',
                  }}
                >
                  <DxfPartPreview
                    dxfFile={part.dxf_file}
                    partNumber={part.part_number}
                    size="small"
                    isTube={part.part_type === 'tube'}
                    tubeFallback={part.part_type === 'tube'}
                  />
                </div>

                {/* Info */}
                <div style={{ padding: '10px 12px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: 4,
                    }}
                  >
                    <span
                      style={{
                        fontSize: '0.68rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        background: part.part_type === 'sheet'
                          ? 'rgba(100, 160, 220, 0.15)'
                          : 'rgba(220, 150, 80, 0.15)',
                        color: part.part_type === 'sheet' ? '#7ab4e8' : '#e0a050',
                        border: `1px solid ${part.part_type === 'sheet' ? 'rgba(100,160,220,0.25)' : 'rgba(220,150,80,0.25)'}`,
                        borderRadius: 4,
                        padding: '1px 5px',
                      }}
                    >
                      {part.part_type}
                    </span>
                  </div>
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: '0.85rem',
                      color: 'var(--text)',
                      marginBottom: 2,
                      wordBreak: 'break-all',
                    }}
                  >
                    {part.part_number}
                  </div>
                  <div
                    style={{
                      fontSize: '0.78rem',
                      color: 'var(--muted)',
                      lineHeight: 1.3,
                    }}
                  >
                    {part.description}
                  </div>
                  {partSubtitle(part) && (
                    <div
                      style={{
                        fontSize: '0.73rem',
                        color: 'var(--muted)',
                        marginTop: 4,
                        opacity: 0.75,
                      }}
                    >
                      {partSubtitle(part)}
                    </div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
