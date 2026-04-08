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

  if (svg.includes('width=')) {
    svg = svg.replace(/width="[^"]*"/i, 'width="100%"')
  } else {
    svg = svg.replace('<svg', '<svg width="100%"')
  }

  if (svg.includes('height=')) {
    svg = svg.replace(/height="[^"]*"/i, 'height="100%"')
  } else {
    svg = svg.replace('<svg', '<svg height="100%"')
  }

  if (svg.includes('style=')) {
    svg = svg.replace(
      /style="[^"]*"/i,
      'style="display:block;width:100%;height:100%;overflow:visible;background:transparent"'
    )
  } else {
    svg = svg.replace(
      '<svg',
      '<svg style="display:block;width:100%;height:100%;overflow:visible;background:transparent"'
    )
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
  size?: 'tiny' | 'small' | 'large'
  tubeFallback?: boolean
  isTube?: boolean
}

export default function DxfPartPreview({
  dxfFile,
  partNumber,
  size = 'small',
  tubeFallback = true,
  isTube = false,
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

        if (!response.ok) {
          throw new Error(`Failed to fetch DXF: ${response.status}`)
        }

        const text = await response.text()
        const helper = new Helper(text)
        const rawSvg = helper.toSVG()

        if (!rawSvg || typeof rawSvg !== 'string') {
          throw new Error('DXF renderer returned empty SVG')
        }

        const svg = normalizeSvgMarkup(rawSvg)

        if (!cancelled) {
          setSvgMarkup(svg)
          setStatus('ready')
        }
      } catch (error) {
        console.error('DXF preview failed for', dxfFile, error)
        if (!cancelled) {
          setSvgMarkup('')
          setStatus('error')
        }
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [dxfFile, isTube, supabase])

  const frameStyle =
    size === 'large'
      ? { width: '100%', height: 520 }
      : size === 'tiny'
        ? { width: 92, height: 58 }
        : { width: 156, height: 96 }

  if (status === 'ready' && svgMarkup && !isTube) {
    return (
      <div
        style={{
          ...frameStyle,
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          background: 'rgba(255,255,255,0.02)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          padding: size === 'large' ? 22 : size === 'tiny' ? 6 : 10,
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
      </div>
    )
  }

  if (isTube && tubeFallback) {
    return (
      <div
        style={{
          ...frameStyle,
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          background: 'rgba(255,255,255,0.02)',
          color: '#94a3b8',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: size === 'tiny' ? '0.68rem' : '0.78rem',
          fontWeight: 600,
          padding: 8,
        }}
      >
        Tube
      </div>
    )
  }

  return (
    <div
      style={{
        ...frameStyle,
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        background: 'rgba(255,255,255,0.02)',
        color: '#94a3b8',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size === 'large' ? '0.95rem' : size === 'tiny' ? '0.66rem' : '0.72rem',
        textAlign: 'center',
        padding: 8,
      }}
    >
      <div>{status === 'loading' ? 'Loading...' : 'No Preview'}</div>
      <div style={{ fontWeight: 700 }}>{partNumber}</div>
    </div>
  )
}