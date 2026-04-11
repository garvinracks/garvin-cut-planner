'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Sidebar from '@/components/Sidebar'

// ── Hamburger icon ────────────────────────────────────────────────────────────

function IconMenu() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <path d="M3 5h14M3 10h14M3 15h14" />
    </svg>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Close drawer on route change
  useEffect(() => {
    setSidebarOpen(false)
  }, [pathname])

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (sidebarOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [sidebarOpen])

  return (
    <div className="app-shell">

      {/* ── Mobile-only top bar ────────────────────────────────────── */}
      <div className="mobile-topbar no-print">
        <button
          className="hamburger-btn"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open navigation"
        >
          <IconMenu />
        </button>
        <div className="mobile-brand">
          <div className="brand-mark" style={{ width: 30, height: 30, fontSize: '0.72rem' }}>GI</div>
          <div>
            <div className="brand-title">Garvin</div>
            <div className="brand-subtitle">Cut Planner</div>
          </div>
        </div>
      </div>

      {/* ── Overlay (closes drawer on tap) ────────────────────────── */}
      {sidebarOpen && (
        <div
          className="sidebar-overlay no-print"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar (receives open state for mobile) ─────────────── */}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* ── Page content ──────────────────────────────────────────── */}
      <main className="main-content section-stack">
        {children}
      </main>

    </div>
  )
}
