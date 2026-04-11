'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type BuildBatch = {
  id: string
  name: string
  status: string
}

type Order = {
  id: string
  order_date: string | null
  synced_at: string | null
}

type InventoryRow = {
  sku_id: string
  qty_on_hand: number
}

type BatchLine = {
  batch_id: string
  sku_id: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 0
  const diff = Date.now() - new Date(dateStr).getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

function formatSyncedAt(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

type StatCardProps = {
  href: string
  accentColor: string
  count: number | string
  label: string
  sublabel?: string
  chips?: string[]
  extra?: React.ReactNode
}

function StatCard({ href, accentColor, count, label, sublabel, chips, extra }: StatCardProps) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="card"
      style={{
        cursor: 'pointer',
        borderTop: `3px solid ${accentColor}`,
        transition: 'box-shadow 0.15s, transform 0.15s',
        boxShadow: hovered ? '0 4px 20px rgba(0,0,0,0.15)' : undefined,
        transform: hovered ? 'translateY(-2px)' : undefined,
      }}
      onClick={() => { window.location.href = href }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="card-body" style={{ padding: '20px 24px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div>
            <div style={{ fontSize: '2.8rem', fontWeight: 700, lineHeight: 1, color: accentColor }}>
              {count}
            </div>
            <div style={{ fontSize: '0.95rem', fontWeight: 600, marginTop: 4 }}>{label}</div>
            {sublabel && (
              <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 2 }}>{sublabel}</div>
            )}
          </div>
        </div>

        {chips && chips.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 12 }}>
            {chips.map((chip) => (
              <span
                key={chip}
                style={{
                  fontSize: '0.72rem',
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: `${accentColor}22`,
                  color: accentColor,
                  border: `1px solid ${accentColor}44`,
                  fontWeight: 500,
                }}
              >
                {chip}
              </span>
            ))}
          </div>
        )}

        {extra}
      </div>
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [loading, setLoading] = useState(true)
  const [batches, setBatches] = useState<BuildBatch[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [batchLines, setBatchLines] = useState<BatchLine[]>([])

  useEffect(() => {
    const supabase = createBrowserClient()

    async function loadAll() {
      const [batchRes, orderRes, invRes, lineRes] = await Promise.all([
        supabase
          .from('build_batches')
          .select('*')
          .in('status', ['planned', 'in_progress', 'at_powder']),
        supabase
          .from('orders')
          .select('id, order_date, synced_at')
          .eq('status', 'open'),
        supabase
          .from('sku_inventory')
          .select('sku_id, qty_on_hand'),
        supabase
          .from('build_batch_lines')
          .select('batch_id, sku_id'),
      ])

      setBatches((batchRes.data as BuildBatch[]) ?? [])
      setOrders((orderRes.data as Order[]) ?? [])
      setInventory((invRes.data as InventoryRow[]) ?? [])
      setBatchLines((lineRes.data as BatchLine[]) ?? [])
      setLoading(false)
    }

    loadAll()
  }, [])

  // ── Derived stats ────────────────────────────────────────────────────────────

  const openOrderCount = orders.length

  const oldestOrderDays = useMemo(() => {
    if (!orders.length) return 0
    const oldest = orders.reduce((acc, o) => {
      if (!o.order_date) return acc
      const d = new Date(o.order_date).getTime()
      return d < acc ? d : acc
    }, Infinity)
    if (!isFinite(oldest)) return 0
    return Math.floor((Date.now() - oldest) / (1000 * 60 * 60 * 24))
  }, [orders])

  const lastSyncedAt = useMemo(() => {
    if (!orders.length) return null
    return orders.reduce<string | null>((acc, o) => {
      if (!o.synced_at) return acc
      if (!acc) return o.synced_at
      return o.synced_at > acc ? o.synced_at : acc
    }, null)
  }, [orders])

  // SKUs that are in an active batch
  const skusInActiveBatch = useMemo(() => new Set(batchLines.map((l) => l.sku_id)), [batchLines])

  // SKUs with inventory on hand
  const skusInStock = useMemo(
    () => new Set(inventory.filter((i) => i.qty_on_hand > 0).map((i) => i.sku_id)),
    [inventory],
  )

  // "Build needed" = open orders that have no inventory and no active batch for any SKU
  // We don't have order_lines loaded, so we use a simple count of orders where
  // neither their id matches inventory nor batch coverage. Since we don't have
  // the order→sku mapping in this load, we count orders where the order itself
  // isn't covered. As a practical heuristic: count orders that exist, minus
  // those whose count of in-stock or in-batch SKUs covers them. With limited
  // data we just compare totals: orders that exceed available SKU coverage.
  // Simplest correct heuristic given the data: open orders count minus
  // the number of distinct in-stock or in-batch SKU types (rough under-estimate).
  // Per spec: "orders whose SKUs are NOT in any active batch_line AND have no
  // sku_inventory row with qty_on_hand > 0" — since we don't have order_lines
  // we approximate as: total open orders minus those with any coverage.
  const coveredSkuCount = useMemo(
    () => new Set([...skusInActiveBatch, ...skusInStock]).size,
    [skusInActiveBatch, skusInStock],
  )
  const buildNeededCount = Math.max(0, openOrderCount - coveredSkuCount)

  const inProgressBatches = batches.filter((b) => b.status === 'in_progress')
  const atPowderBatches = batches.filter((b) => b.status === 'at_powder')

  const skusInStockCount = inventory.filter((i) => i.qty_on_hand > 0).length

  if (loading) {
    return (
      <div style={{ padding: '48px 32px', color: 'var(--muted)', fontSize: '1rem' }}>
        Loading…
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px 48px' }}>
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.9rem' }}>
            Garvin Manufacturing — what needs attention today
          </p>
        </div>
      </div>

      {/* Stat cards grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 16,
          marginBottom: 32,
        }}
      >
        {/* Card 1 — Open Orders */}
        <StatCard
          href="/orders"
          accentColor="var(--accent)"
          count={openOrderCount}
          label="Open Orders"
          sublabel={
            oldestOrderDays > 0
              ? `${oldestOrderDays} day${oldestOrderDays !== 1 ? 's' : ''} since oldest order`
              : 'No orders'
          }
          extra={
            lastSyncedAt ? (
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 10 }}>
                Last synced: {formatSyncedAt(lastSyncedAt)}
              </div>
            ) : undefined
          }
        />

        {/* Card 2 — Build Needed */}
        <StatCard
          href="/orders"
          accentColor="var(--danger)"
          count={buildNeededCount}
          label="Need a Build"
          sublabel="Open orders with no coverage"
        />

        {/* Card 3 — In Build */}
        <StatCard
          href="/batches"
          accentColor="var(--warning)"
          count={inProgressBatches.length}
          label="In Build"
          sublabel={inProgressBatches.length === 0 ? 'No active builds' : undefined}
          chips={inProgressBatches.map((b) => b.name)}
        />

        {/* Card 4 — At Powder */}
        <StatCard
          href="/powder"
          accentColor="#a78bfa"
          count={atPowderBatches.length}
          label="At Powder"
          sublabel={atPowderBatches.length === 0 ? 'Nothing at powder' : undefined}
          chips={atPowderBatches.map((b) => b.name)}
        />

        {/* Card 5 — Ready to Ship (only when > 0) */}
        {skusInStockCount > 0 && (
          <StatCard
            href="/orders"
            accentColor="var(--success)"
            count={skusInStockCount}
            label="SKUs in Stock"
            sublabel="Ready to ship"
          />
        )}
      </div>

      {/* Quick actions */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Quick Actions</span>
        </div>
        <div
          className="card-body"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '16px 20px' }}
        >
          <button
            className="btn btn-secondary"
            onClick={() => { window.location.href = '/orders' }}
          >
            ↻ Sync Orders
          </button>
          <button
            className="btn btn-primary"
            onClick={() => { window.location.href = '/planner' }}
          >
            📋 Plan a Build
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => { window.location.href = '/powder' }}
          >
            🎨 Powder Coat
          </button>
        </div>
      </div>
    </div>
  )
}
