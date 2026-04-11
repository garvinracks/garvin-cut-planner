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

const PREVIEW_HEIGHT = 120 // px — fixed preview area height

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
          maxWidth: 980,
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
                style={{ padding: '6px 14px', fontSize: '0.8rem' }}
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
            gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
            gap: 10,
            alignContent: 'start',
            alignItems: 'start',   // cards are natural height — no row-stretching
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

  const dims = isSheet
    ? [part.thickness, part.material].filter(Boolean).join(' · ')
    : [part.tube_od, part.tube_wall, part.material].filter(Boolean).join(' · ')

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
        textAlign: 'left',
        transition: 'border-color 0.13s, background 0.13s',
        width: '100%',
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
      {/* ── Preview area: fixed height ── */}
      <div
        style={{
          width: '100%',
          height: previewHeight,
          flexShrink: 0,
          background: 'var(--panel)',
          borderBottom: '1px solid var(--border)',
          overflow: 'hidden',
          borderRadius: '8px 8px 0 0',
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
      <div style={{ padding: '10px 11px 11px', display: 'flex', flexDirection: 'column', gap: 4 }}>

        {/* Row 1: badge + part number side by side */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: '0.6rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
              background: typeColor.bg,
              color: typeColor.text,
              border: `1px solid ${typeColor.border}`,
              borderRadius: 4,
              padding: '2px 5px',
              flexShrink: 0,
              lineHeight: 1.4,
            }}
          >
            {part.part_type}
          </span>
          <span
            style={{
              fontWeight: 700,
              fontSize: '0.82rem',
              color: 'var(--text)',
              wordBreak: 'break-word',
              lineHeight: 1.2,
            }}
          >
            {part.part_number}
          </span>
        </div>

        {/* Row 2: description — max 2 lines */}
        {part.description && (
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--muted)',
              lineHeight: 1.4,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {part.description}
          </div>
        )}

        {/* Row 3: dims */}
        {dims && (
          <div
            style={{
              fontSize: '0.7rem',
              color: typeColor.text,
              fontWeight: 600,
              marginTop: 1,
              wordBreak: 'break-word',
            }}
          >
            {dims}
          </div>
        )}

        {/* Row 4: cut length for tubes */}
        {!isSheet && part.cut_length != null && part.cut_length > 0 && (
          <div style={{ fontSize: '0.68rem', color: 'var(--muted)' }}>
            Cut: {part.cut_length}&Prime; &nbsp;({(part.cut_length / 12).toFixed(2)} ft)
          </div>
        )}
      </div>
    </button>
  )
}
