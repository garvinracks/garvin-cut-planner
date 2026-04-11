'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import DxfPartPreview from '@/components/DxfPartPreview'

const DXF_BUCKET = 'dxf-files'

type StorageFile = {
  name: string
  id: string | null
  updated_at: string | null
  created_at: string | null
  metadata: { size?: number; mimetype?: string } | null
}

type Part = {
  id: string
  part_number: string
  description: string
  part_type: 'tube' | 'sheet'
  dxf_file: string | null
}

function fmtBytes(n: number | undefined) {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export default function DxfManagerPage() {
  const supabase  = useMemo(() => createBrowserClient(), [])
  const fileInput = useRef<HTMLInputElement>(null)

  const [files,    setFiles]    = useState<StorageFile[]>([])
  const [parts,    setParts]    = useState<Part[]>([])
  const [loading,  setLoading]  = useState(true)
  const [message,  setMessage]  = useState('')
  const [msgType,  setMsgType]  = useState<'ok' | 'err'>('ok')
  const [uploading, setUploading] = useState(false)
  const [search,   setSearch]   = useState('')
  const [preview,  setPreview]  = useState<string | null>(null)
  const [relinking, setRelinking] = useState<string | null>(null) // filename being relinked
  const [relinkTarget, setRelinkTarget] = useState('')

  // ── loaders ────────────────────────────────────────────────────────────────

  async function loadFiles() {
    const { data, error } = await supabase.storage
      .from(DXF_BUCKET)
      .list('', { limit: 1000, sortBy: { column: 'name', order: 'asc' } })

    if (error) {
      msg(`Could not load files: ${error.message}`, 'err')
      setFiles([])
    } else {
      setFiles((data ?? []).filter((f) => f.name !== '.emptyFolderPlaceholder') as StorageFile[])
    }
  }

  async function loadParts() {
    const { data } = await supabase
      .from('parts')
      .select('id, part_number, description, part_type, dxf_file')
      .order('part_number', { ascending: true })
    setParts((data ?? []) as Part[])
  }

  useEffect(() => {
    setLoading(true)
    Promise.all([loadFiles(), loadParts()]).finally(() => setLoading(false))
  }, [])

  function msg(text: string, type: 'ok' | 'err' = 'ok') {
    setMessage(text)
    setMsgType(type)
  }

  // ── upload ─────────────────────────────────────────────────────────────────

  async function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.dxf')) {
      msg('Only .dxf files are accepted.', 'err')
      return
    }
    setUploading(true)
    msg('')

    const { error } = await supabase.storage
      .from(DXF_BUCKET)
      .upload(file.name, file, { upsert: true })

    if (error) {
      msg(`Upload failed: ${error.message}`, 'err')
    } else {
      msg(`Uploaded ${file.name}.`)
      await loadFiles()
    }
    setUploading(false)
    if (fileInput.current) fileInput.current.value = ''
  }

  // ── delete ─────────────────────────────────────────────────────────────────

  async function handleDelete(filename: string) {
    const linkedPart = parts.find((p) => p.dxf_file === filename)
    const warning = linkedPart
      ? `This file is linked to part ${linkedPart.part_number}. Deleting it will clear that link. Continue?`
      : `Delete ${filename}?`
    if (!window.confirm(warning)) return

    const { error } = await supabase.storage.from(DXF_BUCKET).remove([filename])
    if (error) {
      msg(`Delete failed: ${error.message}`, 'err')
      return
    }
    // Clear link if part referenced this file
    if (linkedPart) {
      await supabase.from('parts').update({ dxf_file: null }).eq('id', linkedPart.id)
    }
    msg(`Deleted ${filename}.`)
    await Promise.all([loadFiles(), loadParts()])
  }

  // ── relink ─────────────────────────────────────────────────────────────────

  async function handleRelink(filename: string) {
    const targetPartId = relinkTarget
    if (!targetPartId) { setRelinking(null); return }

    // Unlink any existing part that references this file
    const prev = parts.find((p) => p.dxf_file === filename && p.id !== targetPartId)
    if (prev) {
      await supabase.from('parts').update({ dxf_file: null }).eq('id', prev.id)
    }
    // Link to chosen part
    const { error } = await supabase.from('parts').update({ dxf_file: filename }).eq('id', targetPartId)
    if (error) {
      msg(`Link failed: ${error.message}`, 'err')
    } else {
      const p = parts.find((pp) => pp.id === targetPartId)
      msg(`Linked ${filename} → ${p?.part_number ?? targetPartId}.`)
    }
    setRelinking(null)
    setRelinkTarget('')
    await loadParts()
  }

  async function handleUnlink(filename: string) {
    const linked = parts.find((p) => p.dxf_file === filename)
    if (!linked) return
    if (!window.confirm(`Unlink ${filename} from ${linked.part_number}?`)) return
    await supabase.from('parts').update({ dxf_file: null }).eq('id', linked.id)
    msg(`Unlinked ${filename} from ${linked.part_number}.`)
    await loadParts()
  }

  // ── derived ────────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return files
    return files.filter((f) => {
      if (f.name.toLowerCase().includes(q)) return true
      const linked = parts.find((p) => p.dxf_file === f.name)
      return (
        linked?.part_number.toLowerCase().includes(q) ||
        linked?.description.toLowerCase().includes(q)
      )
    })
  }, [files, parts, search])

  const linkedCount   = files.filter((f) => parts.some((p) => p.dxf_file === f.name)).length
  const unlinkedCount = files.length - linkedCount
  const sheetPartsNoDxf = parts.filter((p) => p.part_type === 'sheet' && !p.dxf_file)

  return (
    <div className="section-stack">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <div className="kicker">Garvin Internal Tool</div>
          <h1 className="page-title">DXF File Manager</h1>
          <div className="page-subtitle">
            All files in the <strong>dxf-files</strong> storage bucket. Link each file to
            the part that uses it, upload new DXFs, and clean up orphaned files.
          </div>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="result-summary">
        <div className="pill">
          Total files: <strong>{files.length}</strong>
        </div>
        <div className="pill" style={{ borderColor: 'var(--success-border)', color: 'var(--success)' }}>
          Linked: <strong>{linkedCount}</strong>
        </div>
        {unlinkedCount > 0 && (
          <div className="pill" style={{ borderColor: 'var(--warning-border)', color: 'var(--warning)' }}>
            Unlinked: <strong>{unlinkedCount}</strong>
          </div>
        )}
        {sheetPartsNoDxf.length > 0 && (
          <div className="pill" style={{ borderColor: 'var(--danger-border)', color: 'var(--danger)' }}>
            Sheet parts missing DXF: <strong>{sheetPartsNoDxf.length}</strong>
          </div>
        )}
      </div>

      {/* ── Upload + search ── */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Upload DXF</h2>
          <div className="card-subtitle">
            Files with the same name will be replaced. Names should match the part number for easy linking.
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={fileInput}
              type="file"
              accept=".dxf"
              disabled={uploading}
              onChange={handleFileInput}
              style={{ fontSize: '0.85rem', color: 'var(--text-2)' }}
            />
            {uploading && (
              <span style={{ color: 'var(--muted)', fontSize: '0.84rem' }}>Uploading…</span>
            )}
          </div>

          {message && (
            <div
              className={msgType === 'err' ? 'warning-box' : 'message'}
              style={{ marginTop: 12, color: msgType === 'err' ? 'var(--danger)' : undefined }}
            >
              {message}
            </div>
          )}
        </div>
      </section>

      {/* ── Sheet parts missing DXF ── */}
      {sheetPartsNoDxf.length > 0 && (
        <section className="card">
          <div className="card-header" style={{ background: 'var(--danger-soft)' }}>
            <div>
              <h2 className="card-title" style={{ color: 'var(--danger)' }}>
                {sheetPartsNoDxf.length} Sheet Part{sheetPartsNoDxf.length !== 1 ? 's' : ''} Missing a DXF File
              </h2>
              <div className="card-subtitle">These sheet parts have no DXF linked — upload the file and then link it below.</div>
            </div>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {sheetPartsNoDxf.map((p) => (
                <span
                  key={p.id}
                  style={{
                    background: 'var(--panel-2)',
                    border: '1px solid var(--danger-border)',
                    borderRadius: 6,
                    padding: '4px 10px',
                    fontSize: '0.8rem',
                    color: 'var(--text-2)',
                  }}
                >
                  {p.part_number}
                  <span style={{ color: 'var(--muted)', marginLeft: 6 }}>{p.description}</span>
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── File list ── */}
      <section className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 className="card-title">All Files</h2>
            <div className="card-subtitle">Click the preview column to open the DXF viewer. Green = linked, amber = orphaned.</div>
          </div>
          <div style={{ position: 'relative', minWidth: 240 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }}>🔍</span>
            <input
              className="field"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search filename or part…"
              style={{ paddingLeft: 32, fontSize: '0.85rem' }}
            />
          </div>
        </div>

        <div className="card-body" style={{ padding: 0 }}>
          {loading ? (
            <div className="empty">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              {files.length === 0
                ? 'No DXF files in bucket yet. Upload one above.'
                : 'No files match your search.'}
            </div>
          ) : (
            <div className="table-wrap" style={{ borderRadius: 0, border: 'none' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 100 }}>Preview</th>
                    <th>Filename</th>
                    <th>Size</th>
                    <th>Linked Part</th>
                    <th style={{ width: 200 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((file) => {
                    const linkedPart = parts.find((p) => p.dxf_file === file.name)
                    const isLinked   = !!linkedPart
                    const isRelink   = relinking === file.name

                    return (
                      <tr key={file.name}>
                        {/* ── Preview ── */}
                        <td
                          style={{ cursor: 'pointer' }}
                          onClick={() => setPreview(preview === file.name ? null : file.name)}
                          title="Click to expand preview"
                        >
                          {preview === file.name ? (
                            <div style={{ width: 90, height: 70 }}>
                              <DxfPartPreview
                                dxfFile={file.name}
                                partNumber={file.name}
                                size="fill"
                              />
                            </div>
                          ) : (
                            <div
                              style={{
                                width: 60,
                                height: 44,
                                background: 'var(--panel-2)',
                                border: '1px solid var(--border)',
                                borderRadius: 6,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '0.7rem',
                                color: 'var(--muted)',
                              }}
                            >
                              DXF
                            </div>
                          )}
                        </td>

                        {/* ── Filename ── */}
                        <td>
                          <div style={{ fontWeight: 600, fontSize: '0.84rem', color: 'var(--text)' }}>
                            {file.name}
                          </div>
                          <div
                            style={{
                              marginTop: 3,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              fontSize: '0.68rem',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: '0.07em',
                              padding: '2px 7px',
                              borderRadius: 4,
                              background: isLinked ? 'var(--success-soft)' : 'var(--warning-soft)',
                              color:      isLinked ? 'var(--success)'      : 'var(--warning)',
                              border:     `1px solid ${isLinked ? 'var(--success-border)' : 'var(--warning-border)'}`,
                            }}
                          >
                            {isLinked ? '● Linked' : '○ Unlinked'}
                          </div>
                        </td>

                        {/* ── Size ── */}
                        <td style={{ color: 'var(--muted)', fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
                          {fmtBytes(file.metadata?.size)}
                        </td>

                        {/* ── Linked part ── */}
                        <td>
                          {isRelink ? (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <select
                                className="select"
                                style={{ fontSize: '0.8rem' }}
                                value={relinkTarget}
                                onChange={(e) => setRelinkTarget(e.target.value)}
                                autoFocus
                              >
                                <option value="">— choose part —</option>
                                {parts
                                  .filter((p) => p.part_type === 'sheet')
                                  .map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.part_number} — {p.description}
                                    </option>
                                  ))}
                              </select>
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ padding: '0 10px', fontSize: '0.78rem' }}
                                onClick={() => void handleRelink(file.name)}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ padding: '0 8px', fontSize: '0.78rem' }}
                                onClick={() => { setRelinking(null); setRelinkTarget('') }}
                              >
                                ✕
                              </button>
                            </div>
                          ) : linkedPart ? (
                            <div>
                              <div style={{ fontWeight: 700, fontSize: '0.84rem' }}>{linkedPart.part_number}</div>
                              <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>{linkedPart.description}</div>
                            </div>
                          ) : (
                            <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>Not linked</span>
                          )}
                        </td>

                        {/* ── Actions ── */}
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ fontSize: '0.76rem', padding: '0 9px' }}
                              onClick={() => {
                                setRelinking(file.name)
                                setRelinkTarget(linkedPart?.id ?? '')
                              }}
                            >
                              {isLinked ? 'Re-link' : 'Link Part'}
                            </button>
                            {isLinked && (
                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ fontSize: '0.76rem', padding: '0 9px' }}
                                onClick={() => void handleUnlink(file.name)}
                              >
                                Unlink
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-danger"
                              style={{ fontSize: '0.76rem', padding: '0 9px' }}
                              onClick={() => void handleDelete(file.name)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
