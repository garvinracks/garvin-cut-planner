'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

type Job = {
  id: string
  name: string
  order_number: string | null
  notes: string | null
  created_at: string
}

type JobRow = {
  id: string
  job_id: string
  sku_id: string
  qty: number
}

export default function JobsPage() {
  const supabase = useMemo(() => createBrowserClient(), [])
  const router = useRouter()

  const [jobs, setJobs] = useState<Job[]>([])
  const [jobRows, setJobRows] = useState<JobRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')

  async function loadData() {
    setLoading(true)
    setMessage('')
    const [{ data: jobData, error: jobError }, { data: rowData }] = await Promise.all([
      supabase.from('jobs').select('*').order('created_at', { ascending: false }),
      supabase.from('job_rows').select('*').order('sku_id', { ascending: true }),
    ])

    if (jobError) {
      setMessage(`Load failed: ${jobError.message}`)
      setLoading(false)
      return
    }

    setJobs((jobData ?? []) as Job[])
    setJobRows((rowData ?? []) as JobRow[])
    setLoading(false)
  }

  useEffect(() => { void loadData() }, [])

  function loadIntoPlanner(job: Job) {
    const rows = jobRows.filter((r) => r.job_id === job.id)
    localStorage.setItem(
      'garvin:load_job',
      JSON.stringify({
        name: job.name,
        order_number: job.order_number ?? '',
        rows: rows.map((r) => ({ skuId: r.sku_id, qty: String(r.qty), skuLookup: r.sku_id })),
      })
    )
    router.push('/planner')
  }

  async function deleteJob(id: string) {
    if (!confirm('Delete this saved job? This cannot be undone.')) return
    const { error } = await supabase.from('jobs').delete().eq('id', id)
    if (error) {
      setMessage(`Delete failed: ${error.message}`)
    } else {
      if (expandedId === id) setExpandedId(null)
      await loadData()
    }
  }

  function formatDate(ts: string) {
    return new Date(ts).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  }

  const filtered = jobs.filter((j) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return `${j.name} ${j.order_number ?? ''} ${j.notes ?? ''}`.toLowerCase().includes(q)
  })

  return (
    <div className="section-stack">
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">Saved Jobs</h1>
          <div className="page-subtitle">
            Past build planner runs saved by order. Click any job to see its SKU list or load it back into the planner.
          </div>
        </div>
      </div>

      <section className="card">
        <div className="card-header" style={{ gap: 10 }}>
          <h2 className="card-title" style={{ flex: 1 }}>All Jobs</h2>
          <input
            className="field"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or order #…"
            style={{ width: 240, fontSize: '0.88rem' }}
          />
        </div>

        <div className="card-body">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              {search ? `No jobs matching "${search}".` : 'No saved jobs yet. Generate a cut list in the Build Planner and save it.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filtered.map((job) => {
                const rows = jobRows.filter((r) => r.job_id === job.id)
                const totalQty = rows.reduce((s, r) => s + r.qty, 0)
                const isExpanded = expandedId === job.id

                return (
                  <div
                    key={job.id}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      overflow: 'hidden',
                      background: 'var(--panel-2)',
                    }}
                  >
                    {/* ── Job header row ── */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 16px',
                        cursor: 'pointer',
                      }}
                      onClick={() => setExpandedId(isExpanded ? null : job.id)}
                    >
                      {/* Expand chevron */}
                      <div style={{
                        color: 'var(--muted)',
                        fontSize: '0.8rem',
                        transition: 'transform 0.15s',
                        transform: isExpanded ? 'rotate(90deg)' : 'none',
                        flexShrink: 0,
                        userSelect: 'none',
                      }}>
                        ▶
                      </div>

                      {/* Main info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text)' }}>
                            {job.name}
                          </span>
                          {job.order_number && (
                            <span style={{
                              fontSize: '0.72rem',
                              fontWeight: 600,
                              background: 'var(--accent-soft)',
                              color: 'var(--accent)',
                              border: '1px solid var(--accent-border)',
                              borderRadius: 4,
                              padding: '1px 7px',
                            }}>
                              {job.order_number}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.76rem', color: 'var(--muted)', marginTop: 2 }}>
                          {formatDate(job.created_at)}
                          {' · '}
                          {rows.length} SKU{rows.length !== 1 ? 's' : ''}
                          {' · '}
                          {totalQty} total units
                          {job.notes && ` · ${job.notes}`}
                        </div>
                      </div>

                      {/* Actions */}
                      <div
                        style={{ display: 'flex', gap: 8, flexShrink: 0 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ fontSize: '0.78rem', padding: '5px 12px' }}
                          onClick={() => loadIntoPlanner(job)}
                        >
                          Load into Planner
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          style={{ fontSize: '0.78rem', padding: '5px 10px' }}
                          onClick={() => deleteJob(job.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {/* ── Expanded SKU list ── */}
                    {isExpanded && (
                      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
                        {rows.length === 0 ? (
                          <div className="empty" style={{ padding: '12px 0' }}>No SKU rows saved.</div>
                        ) : (
                          <div className="table-wrap">
                            <table className="table">
                              <thead>
                                <tr>
                                  <th>SKU</th>
                                  <th style={{ width: 100 }}>Qty</th>
                                </tr>
                              </thead>
                              <tbody>
                                {rows.map((r) => (
                                  <tr key={r.id}>
                                    <td style={{ fontWeight: 600 }}>{r.sku_id}</td>
                                    <td>{r.qty}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {message && <div className="message" style={{ marginTop: 14 }}>{message}</div>}
        </div>
      </section>
    </div>
  )
}
