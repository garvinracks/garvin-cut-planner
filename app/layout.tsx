import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Sidebar from '@/components/Sidebar'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Garvin Cut Planner',
  description: 'Internal cut list and build planning tool',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <div className="app-shell">
          <Sidebar />
          <main className="main-content section-stack">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}
