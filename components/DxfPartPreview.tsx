'use client'

import { useEffect, useMemo, useState } from 'react'
import { Helper } from 'dxf'
import { createBrowserClient } from '@/lib/supabase'

const DXF_BUCKET = 'dxf-files'

function normalizeSvgMarkup(rawSvg: string) {
  let svg = rawSvg.trim()

  svg = svg.replace(/<\?xml[\s\S]*?\?>/gi, '')
  svg = svg.replace(/<!DOCTYPE[\s\S]*?>/gi, '')

  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/i)
  if (viewBoxMatch) {
    const nums = viewBoxMatch[1]
      .trim()
      .split(/[ ,]+/)
      .map((v) => Number(v))

    if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) {
      const [x, y, w, h] = nums
      const pad = Math.max(w, h) * 0.18
      svg = svg.replace(
        /viewBox="[^"]*"/i,
        `viewBox="${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}"`
      )
    }
  }

  if (svg.includes('preserveAspectRatio=')) {
    svg = svg.replace(/preserveAspectRatio="[^"]*"/i, 'preserveAspectRatio="xMidYMid meet"')
  } else {
    svg = svg.replace('<svg', '<svg preserveAspectRatio="xMidYMid meet"')
  }

  svg = svg.replace(/width="[^"]*"/i, 'width="100%"')
  if (!svg.includes('width=')) svg = svg.replace('<svg', '<svg width="100%"')

  svg = svg.replace(/height="[^"]*"/i, 'height="100%"')
  if (!svg.includes('height=')) svg = svg.replace('<svg', '<svg height="100%"')

  const styleAttr = 'style="display:block;width:100%;height:100%;overflow:visible;background:transparent"'
  if (svg.includes('style=')) {
    svg = svg.replace(/style="[^"]*"/i, styleAttr)
  } else {
    svg = svg.replace('<svg', `<svg ${styleAttr}`)
  }

  svg = svg.replace(
    /<svg([^>]*)>/i,
    `<svg$1>
      <style>
        * {
          fill: none !important;
          stroke: #e5e7eb !important;
          stroke-width: 1.6 !important;
          stroke-linecap: round !important;
          stroke-linejoin: round !important;
          vector-effect: non-scaling-stroke !important;
        }
      </style>`
  )

  return svg
}

export type DxfPartPreviewProps = {
  dxfFile: string | null
  partNumber: string
  /** 'tiny' 92×58 | 'small' 156×96 | 'large' 100%×520 | 'fill' 100%×100% of parent */
  size?: 'tiny' | 'small' | 'large' | 'fill'
  tubeFallback?: boolean
  isTube?: boolean
  /** For tube cards: shown in the fallback display */
  tubeOd?: string | null
  tubeWall?: string | null
  tubeShape?: 'round' | 'square'
  cutLength?: number | null
}

export default function DxfPartPreview({
  dxfFile,
  partNumber,
  size = 'small',
  tubeFallback = true,
  isTube = false,
  tubeOd,
  tubeWall,
  tubeShape = 'round',
  cutLength,
}: DxfPartPreviewProps) {
  const supabase = useMemo(() => createBrowserClient(), [])
  const [svgMarkup, setSvgMarkup] = useState<string>('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  useEffect(() => {
    let cancelled = false

    async function run() {
      if (isTube || !dxfFile) {
        setSvgMarkup('')
        setStatus('error')
        return
      }

      setStatus('loading')

      try {
        const { data } = supabase.storage.from(DXF_BUCKET).getPublicUrl(dxfFile)
        const response = await fetch(data.publicUrl)

        if (!response.ok) throw new Error(`Failed to fetch DXF: ${response.status}`)

        const text = await response.text()
        const helper = new Helper(text)
        const rawSvg = helper.toSVG()

        if (!rawSvg || typeof rawSvg !== 'string') throw new Error('DXF renderer returned empty SVG')

        const svg = normalizeSvgMarkup(rawSvg)
        if (!cancelled) { setSvgMarkup(svg); setStatus('ready') }
      } catch (error) {
        console.error('DXF preview failed for', dxfFile, error)
        if (!cancelled) { setSvgMarkup(''); setStatus('error') }
      }
    }

    void run()
    return () => { cancelled = true }
  }, [dxfFile, isTube, supabase])

  // Size → outer frame dimensions. 'fill' means take 100% of parent.
  const frameStyle: React.CSSProperties =
    size === 'fill'
      ? { width: '100%', height: '100%' }
      : size === 'large'
        ? { width: '100%', height: 520 }
        : size === 'tiny'
          ? { width: 92, height: 58 }
          : { width: 156, height: 96 }

  const baseBox: React.CSSProperties = {
    ...frameStyle,
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: size === 'fill' ? 0 : 12,
    background: 'rgba(255,255,255,0.02)',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  // ── DXF ready ────────────────────────────────────────────────
  if (status === 'ready' && svgMarkup && !isTube) {
    return (
      <div style={{ ...baseBox, padding: size === 'large' ? 22 : size === 'tiny' ? 6 : 10 }}>
        <div
          style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
      </div>
    )
  }

  // ── Tube fallback: rich info card ────────────────────────────
  if (isTube && tubeFallback) {
    const isSquare = tubeShape === 'square'
    const isFillOrLarge = size === 'fill' || size === 'large'
    const svgSize = isFillOrLarge ? 48 : size === 'small' ? 36 : 26

    return (
      <div style={{ ...baseBox, flexDirection: 'row', gap: 10, padding: isFillOrLarge ? 12 : 8, alignItems: 'center', justifyContent: 'center' }}>
        {/* Cross-section SVG */}
        <svg
          width={svgSize}
          height={svgSize}
          viewBox="0 0 52 52"
          style={{ flexShrink: 0 }}
        >
          {isSquare ? (
            <>
              <rect x={4} y={4} width={44} height={44} rx={2} fill="none" stroke="#94a3b8" strokeWidth={3} />
              <rect x={13} y={13} width={26} height={26} rx={1} fill="none" stroke="#94a3b8" strokeWidth={2} />
            </>
          ) : (
            <>
              <circle cx={26} cy={26} r={22} fill="none" stroke="#94a3b8" strokeWidth={3} />
              <circle cx={26} cy={26} r={13} fill="none" stroke="#94a3b8" strokeWidth={2} />
            </>
          )}
        </svg>

        {/* Dims / cut length */}
        {isFillOrLarge && (tubeOd || tubeWall || (cutLength != null && cutLength > 0)) && (
          <div style={{ lineHeight: 1.4, minWidth: 0 }}>
            {(tubeOd || tubeWall) && (
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#e0a050', whiteSpace: 'nowrap' }}>
                {[tubeOd, tubeWall].filter(Boolean).join(' × ')}
              </div>
            )}
            {cutLength != null && cutLength > 0 && (
              <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 1, whiteSpace: 'nowrap' }}>
                {cutLength}&Prime; · {(cutLength / 12).toFixed(2)} ft
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── No preview / loading ─────────────────────────────────────
  return (
    <div
      style={{
        ...baseBox,
        flexDirection: 'column',
        gap: 4,
        fontSize: size === 'large' ? '0.95rem' : size === 'tiny' ? '0.66rem' : '0.72rem',
        color: '#94a3b8',
        textAlign: 'center',
        padding: 8,
      }}
    >
      <div>{status === 'loading' ? 'Loading…' : 'No Preview'}</div>
      <div style={{ fontWeight: 700 }}>{partNumber}</div>
    </div>
  )
}
