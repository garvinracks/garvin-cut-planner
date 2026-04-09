'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import GlobalSearch from '@/components/GlobalSearch'
import ThemeToggle from '@/components/ThemeToggle'

// ── Minimal inline SVG icons ──────────────────────────────────────────────────

function IconPlanner() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  )
}

function IconJobs() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h8a1 1 0 0 1 1 1v11l-5-3-5 3V3a1 1 0 0 1 1-1z" />
    </svg>
  )
}

function IconSKU() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2L2 5v6l6 3 6-3V5L8 2z" />
      <path d="M2 5l6 3 6-3" />
      <path d="M8 8v6" />
    </svg>
  )
}

function IconSubassemblies() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 11.5l6 3 6-3" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 4.5l6 3 6-3" />
    </svg>
  )
}

function IconParts() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2" />
      <path d="M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4" />
      <path d="M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
    </svg>
  )
}

function IconMaterials() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="11" width="12" height="3" rx="1" />
      <rect x="2" y="7"  width="12" height="3" rx="1" />
      <rect x="2" y="3"  width="12" height="3" rx="1" />
    </svg>
  )
}

function IconDxf() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 2h7l3 3v9H3V2z" />
      <path d="M10 2v3h3" />
      <path d="M5 9h2m2 0h2" />
      <path d="M5 12h6" />
    </svg>
  )
}

// ── Nav config ────────────────────────────────────────────────────────────────

const LINKS = [
  { href: '/planner',       label: 'Build Planner',  Icon: IconPlanner       },
  { href: '/jobs',          label: 'Saved Jobs',     Icon: IconJobs          },
  { href: '/skus',          label: 'SKUs',           Icon: IconSKU           },
  { href: '/subassemblies', label: 'Subassemblies',  Icon: IconSubassemblies },
  { href: '/parts',         label: 'Parts',          Icon: IconParts         },
  { href: '/materials',     label: 'Materials',      Icon: IconMaterials     },
  { href: '/dxf-manager',   label: 'DXF Files',      Icon: IconDxf           },
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="sidebar">
      {/* Brand */}
      <div className="sidebar-top">
        <div className="brand-mark">GI</div>
        <div>
          <div className="brand-title">Garvin</div>
          <div className="brand-subtitle">Cut Planner</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        <div className="sidebar-section-label">Navigation</div>

        {LINKS.map(({ href, label, Icon }) => {
          const active = pathname === href
          return (
            <Link
              key={href}
              href={href}
              className={`sidebar-link ${active ? 'active' : ''}`}
            >
              <Icon />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Theme toggle + Global search at bottom */}
      <div style={{ padding: '4px 8px 16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <ThemeToggle />
        <GlobalSearch />
      </div>
    </aside>
  )
}
