'use client'

import { useEffect, useState } from 'react'

function IconSun() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: 15, height: 15, flexShrink: 0 }}
    >
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8" />
      <path d="M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" />
    </svg>
  )
}

function IconMoon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: 15, height: 15, flexShrink: 0 }}
    >
      <path d="M13.5 10A6 6 0 0 1 6 2.5a5.5 5.5 0 1 0 7.5 7.5z" />
    </svg>
  )
}

export default function ThemeToggle() {
  const [dark, setDark] = useState(true)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem('garvin:theme')
    const isDark = saved !== 'light'
    setDark(isDark)
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
    setMounted(true)
  }, [])

  function toggle() {
    const next = !dark
    setDark(next)
    const theme = next ? 'dark' : 'light'
    localStorage.setItem('garvin:theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
  }

  if (!mounted) return null

  return (
    <button
      type="button"
      onClick={toggle}
      className="sidebar-link"
      style={{ width: '100%', opacity: 0.8 }}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, opacity: 0.6 }}>
        {dark ? <IconSun /> : <IconMoon />}
      </span>
      {dark ? 'Light Mode' : 'Dark Mode'}
    </button>
  )
}
