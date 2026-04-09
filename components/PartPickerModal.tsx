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
  cut_length: number | null
}

type Props = {
  parts: PickablePart[]
  onSelect: (part: PickablePart) => void
  onClose: () => void
}

const PREVIEW_HEIGHT = 140 // px — every card has this exact preview area height

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
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search part number, description, material…"
              style={{ paddingLeft: 34, fontSize: '0.92rem' }}
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
            style={{ padding: '6px 10px', lineHeight: 1 }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* ── Count bar ── */}
        <div
          style={{
            padding: '7px 16px',
            fontSize: '0.76rem',
            color: 'var(--muted)',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          {filtered.length} part{filtered.length !== 1 ? 's' : ''}
          {search ? ` matching "${search}"` : ''}
          {' — click a card to select'}
        </div>

        {/* ── Card grid ── */}
        <div
          style={{
            overflowY: 'auto',
            padding: 14,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))',
            gap: 10,
            alignContent: 'start',
          }}
        >
          {filtered.length === 0 ? (
            <div className="empty" style={{ gridColumn: '1 / -1', padding: '40px 0' }}>
              No matching parts.
            </div>
          ) : (
            filtered.map((part) => (
              <PartCard key={part.id} part={part} onSelect={onSelect} previewHeight={PREVIEW_HEIGHT} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ── Individual card ──────────────────────────────────────────────────────────

function PartCard({
  part,
  onSelect,
  previewHeight,
}: {
  part: PickablePart
  onSelect: (p: PickablePart) => void
  previewHeight: number
}) {
  const isSheet = part.part_type === 'sheet'
  const isSquare = (part.tube_od ?? '').toLowerCase().includes('x')

  const typeColor = isSheet
    ? { bg: 'rgba(100,160,220,0.15)', text: '#7ab4e8', border: 'rgba(100,160,220,0.25)' }
    : { bg: 'rgba(220,150,80,0.15)', text: '#e0a050', border: 'rgba(220,150,80,0.25)' }

  return (
    <button
      type="button"
      onClick={() => onSelect(part)}
      style={{
        background: 'var(--panel-2)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 0,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        textAlign: 'left',
        transition: 'border-color 0.13s, background 0.13s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent)'
        e.currentTarget.style.background = 'var(--accent-soft)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border)'
        e.currentTarget.style.background = 'var(--panel-2)'
      }}
    >
      {/* ── Preview area: always exactly previewHeight px ── */}
      <div
        style={{
          width: '100%',
          height: previewHeight,
          flexShrink: 0,
          background: 'var(--panel)',
          borderBottom: '1px solid var(--border)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <DxfPartPreview
          dxfFile={part.dxf_file}
          partNumber={part.part_number}
          size="fill"
          isTube={!isSheet}
          tubeFallback={true}
          tubeOd={part.tube_od}
          tubeWall={part.tube_wall}
          tubeShape={isSquare ? 'square' : 'round'}
          cutLength={part.cut_length}
        />
      </div>

      {/* ── Info area ── */}
      <div style={{ padding: '9px 11px', flex: 1 }}>
        {/* Type badge */}
        <span
          style={{
            display: 'inline-block',
            fontSize: '0.63rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            background: typeColor.bg,
            color: typeColor.text,
            border: `1px solid ${typeColor.border}`,
            borderRadius: 4,
            padding: '1px 5px',
            marginBottom: 5,
          }}
        >
          {part.part_type}
        </span>

        {/* Part number */}
        <div style={{ fontWeight: 700, fontSize: '0.84rem', color: 'var(--text)', marginBottom: 2, wordBreak: 'break-word' }}>
          {part.part_number}
        </div>

        {/* Description */}
        <div style={{ fontSize: '0.76rem', color: 'var(--muted)', lineHeight: 1.35, marginBottom: 4 }}>
          {part.description}
        </div>

        {/* Material / dims */}
        <div style={{ fontSize: '0.71rem', color: 'var(--muted)', opacity: 0.8 }}>
          {isSheet
            ? [part.thickness, part.material].filter(Boolean).join(' · ')
            : [part.tube_od, part.tube_wall, part.material].filter(Boolean).join(' · ')}
        </div>
      </div>
    </button>
  )
}
