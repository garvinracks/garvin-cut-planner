'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import GlobalSearch from '@/components/GlobalSearch'

const links = [
  { href: '/planner', label: 'Build Planner' },
  { href: '/jobs', label: 'Saved Jobs' },
  { href: '/skus', label: 'SKUs' },
  { href: '/subassemblies', label: 'Subassemblies' },
  { href: '/parts', label: 'Parts' },
  { href: '/materials', label: 'Materials' },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand-mark">GI</div>
        <div>
          <div className="brand-title">Garvin</div>
          <div className="brand-subtitle">Cut Planner</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {links.map((link) => {
          const active = pathname === link.href
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`sidebar-link ${active ? 'active' : ''}`}
            >
              {link.label}
            </Link>
          )
        })}
      </nav>

      <div style={{ padding: '0 12px' }}>
        <GlobalSearch />
      </div>
    </aside>
  )
}