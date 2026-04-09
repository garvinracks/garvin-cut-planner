'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

type SearchResult = {
  id: string
  label: string
  sub: string
  type: 'sku' | 'part' | 'subassembly' | 'material'
  href: string
}

const TYPE_LABELS: Record<SearchResult['type'], string> = {
  sku: 'SKUs',
  part: 'Parts',
  subassembly: 'Subassemblies',
  material: 'Materials',
}

const TYPE_COLORS: Record<SearchResult['type'], string> = {
  sku: '#3498db',
  part: '#e67e22',
  subassembly: '#2ecc71',
  material: '#9b59b6',
}

export default function GlobalSearch() {
  const supabase = useMemo(() => createBrowserClient(), [])
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-focus input when overlay opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      setQuery('')
      setResults([])
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [])

  async function runSearch(q: string) {
    if (!q.trim()) {
      setResults([])
      return
    }
    setSearching(true)
    const pattern = `%${q.trim()}%`
    const [
      { data: skuData },
      { data: partData },
      { data: subData },
      { data: matData },
    ] = await Promise.all([
      supabase.from('skus').select('id, description').or(`id.ilike.${pattern},description.ilike.${pattern}`).limit(5),
      supabase.from('parts').select('id, part_number, description').or(`part_number.ilike.${pattern},description.ilike.${pattern}`).limit(5),
      supabase.from('sub_assemblies').select('id, name').or(`id.ilike.${pattern},name.ilike.${pattern}`).limit(5),
      supabase.from('materials').select('id, name').ilike('name', pattern).limit(5),
    ])

    const next: SearchResult[] = [
      ...((skuData ?? []) as Array<{ id: string; description: string }>).map((r) => ({
        id: r.id,
        label: r.id,
        sub: r.description,
        type: 'sku' as const,
        href: `/skus?id=${encodeURIComponent(r.id)}`,
      })),
      ...((partData ?? []) as Array<{ id: string; part_number: string; description: string }>).map((r) => ({
        id: r.id,
        label: r.part_number,
        sub: r.description,
        type: 'part' as const,
        href: `/parts?id=${encodeURIComponent(r.id)}`,
      })),
      ...((subData ?? []) as Array<{ id: string; name: string }>).map((r) => ({
        id: r.id,
        label: r.id,
        sub: r.name,
        type: 'subassembly' as const,
        href: `/subassemblies?id=${encodeURIComponent(r.id)}`,
      })),
      ...((matData ?? []) as Array<{ id: string; name: string }>).map((r) => ({
        id: r.id,
        label: r.name,
        sub: r.id,
        type: 'material' as const,
        href: `/materials?id=${encodeURIComponent(r.id)}`,
      })),
    ]
    setResults(next)
    setSearching(false)
  }

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(val), 200)
  }

  function handleSelect(href: string) {
    setOpen(false)
    router.push(href)
  }

  // Group results by type
  const grouped = useMemo(() => {
    const order: SearchResult['type'][] = ['sku', 'part', 'subassembly', 'material']
    return order
      .map((type) => ({ type, items: results.filter((r) => r.type === type) }))
      .filter((g) => g.items.length > 0)
  }, [results])

  return (
    <>
      {/* Search icon button */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Global search"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '8px 12px',
          cursor: 'pointer',
          color: 'var(--muted)',
          fontSize: '0.82rem',
          marginTop: 12,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="9" r="6" />
          <line x1="14" y1="14" x2="19" y2="19" />
        </svg>
        Search…
      </button>

      {/* Full-screen overlay */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            zIndex: 9000,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: 80,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              width: '100%',
              maxWidth: 560,
              margin: '0 16px',
              boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
              overflow: 'hidden',
            }}
          >
            {/* Input */}
            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)', gap: 10 }}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="9" cy="9" r="6" />
                <line x1="14" y1="14" x2="19" y2="19" />
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={handleQueryChange}
                placeholder="Search SKUs, parts, subassemblies, materials…"
                style={{
                  flex: 1,
                  background: 'none',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--text)',
                  fontSize: '1rem',
                }}
              />
              {searching && (
                <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Searching…</span>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  background: 'none',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '2px 7px',
                  cursor: 'pointer',
                  color: 'var(--muted)',
                  fontSize: '0.72rem',
                  flexShrink: 0,
                }}
              >
                Esc
              </button>
            </div>

            {/* Results */}
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {!query.trim() && (
                <div style={{ padding: '24px 16px', color: 'var(--muted)', fontSize: '0.88rem', textAlign: 'center' }}>
                  Start typing to search across all records.
                </div>
              )}
              {query.trim() && !searching && results.length === 0 && (
                <div style={{ padding: '24px 16px', color: 'var(--muted)', fontSize: '0.88rem', textAlign: 'center' }}>
                  No results found for &ldquo;{query}&rdquo;
                </div>
              )}
              {grouped.map((group) => (
                <div key={group.type}>
                  <div style={{
                    padding: '8px 16px 4px',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: TYPE_COLORS[group.type],
                    borderTop: '1px solid var(--border)',
                  }}>
                    {TYPE_LABELS[group.type]}
                  </div>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelect(item.href)}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        width: '100%',
                        padding: '10px 16px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        gap: 2,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--panel-2)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                    >
                      <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.9rem' }}>{item.label}</span>
                      {item.sub && (
                        <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{item.sub}</span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
