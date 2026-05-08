'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { useSearchParams } from 'next/navigation'
import JSZip from 'jszip'

type OrderLine = {
  id: string
  ss_sku: string | null
  description: string | null
  qty: number
  unit_price: number | null
  skus: { description: string }[] | null
}

type Order = {
  id: string
  order_number: string
  order_date: string
  shipping_cost: number | null
  order_lines: OrderLine[]
}

type T5Invoice = {
  id: string
  order_id: string
  issue_date: string
  due_date: string
  shipping_cost: number | null
  status: string
}

type InvoiceWithOrder = { invoice: T5Invoice; order: Order }

function fmt(n: number) { return '$' + n.toFixed(2) }
function fmtDate(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function PrintAllInner() {
  const supabase     = useMemo(() => createBrowserClient(), [])
  const searchParams = useSearchParams()
  const idsParam     = searchParams.get('ids')   // comma-separated invoice IDs, or null = all

  const [items, setItems]       = useState<InvoiceWithOrder[]>([])
  const [loading, setLoading]   = useState(true)
  const [zipping, setZipping]   = useState(false)

  useEffect(() => {
    async function load() {
      let query = supabase
        .from('turn5_invoices')
        .select('*')
        .order('created_at', { ascending: true })

      if (idsParam) {
        const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean)
        query = query.in('id', ids) as typeof query
      }

      const { data: invData } = await query
      if (!invData || invData.length === 0) { setLoading(false); return }

      const orderIds = [...new Set(invData.map((i: T5Invoice) => i.order_id))]
      const { data: ordData } = await supabase
        .from('orders')
        .select('id, order_number, order_date, shipping_cost, order_lines(id, ss_sku, description, qty, unit_price, skus(description))')
        .in('id', orderIds)

      const orderMap = new Map<string, Order>((ordData ?? []).map((o: Order) => [o.id, o]))

      const paired: InvoiceWithOrder[] = invData
        .map((inv: T5Invoice) => ({ invoice: inv, order: orderMap.get(inv.order_id)! }))
        .filter((p: InvoiceWithOrder) => p.order)

      setItems(paired)
      setLoading(false)
    }
    void load()
  }, [idsParam, supabase])

  async function downloadZip() {
    setZipping(true)
    // Dynamically import jsPDF to keep initial bundle small
    const { jsPDF } = await import('jspdf')
    const zip = new JSZip()

    for (const { invoice, order } of items) {
      const shipping  = invoice.shipping_cost ?? order.shipping_cost ?? 0
      const lineTotal = order.order_lines.reduce((s, l) => s + (l.unit_price ?? 0) * l.qty, 0)
      const total     = lineTotal + shipping
      const invoiceNum = `TURN INV-${order.order_number}`

      const doc = new jsPDF({ unit: 'pt', format: 'letter' })
      const W = 612  // letter width in pt
      const margin = 56
      let y = 56

      // ── Header ──
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(28)
      doc.text('Invoice', margin, y)

      // Company block (right)
      doc.setFontSize(8)
      doc.setFont('helvetica', 'bold')
      doc.text('Garvin Industries LLC', W - margin, y, { align: 'right' })
      doc.setFont('helvetica', 'normal')
      const companyLines = ['14324 172nd Ave.', 'Grand Haven, MI 49417', '231-375-7197', 'charlie@garvinracks.com', 'garvinracks.com']
      companyLines.forEach((line) => { y += 11; doc.text(line, W - margin, y, { align: 'right' }) })

      y += 28

      // ── Invoice details ──
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(7)
      doc.setTextColor(150)
      doc.text('INVOICE DETAILS', margin, y)
      doc.text('BILL TO', W / 2, y)
      doc.setTextColor(0)
      y += 14

      const detailRows = [
        ['Invoice #', invoiceNum],
        ['Date of Issue', fmtDate(invoice.issue_date)],
        ['Due Date', fmtDate(invoice.due_date)],
      ]
      doc.setFontSize(8.5)
      for (const [key, val] of detailRows) {
        doc.setFont('helvetica', 'normal'); doc.setTextColor(120)
        doc.text(key, margin, y)
        doc.setFont('helvetica', 'bold'); doc.setTextColor(0)
        doc.text(val, margin + 80, y)
        y += 13
      }

      // Bill to (alongside)
      let by = y - (detailRows.length * 13) - 1
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(0)
      doc.text('Turn5', W / 2, by); by += 13
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80)
      doc.text('600 Cedar Hollow Rd', W / 2, by); by += 11
      doc.text('Paoli, PA 19301', W / 2, by)

      y += 20

      // ── Table header ──
      doc.setFillColor(17, 17, 17)
      doc.rect(margin, y, W - margin * 2, 20, 'F')
      doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5)
      const cols = [margin + 6, 150, 220, 430, 490, 540]
      const headers = ['PO NUMBER', 'SKU', 'DESCRIPTION', 'QTY', 'RATE', 'AMOUNT']
      const aligns: Array<'left' | 'right'> = ['left', 'left', 'left', 'right', 'right', 'right']
      headers.forEach((h, i) => doc.text(h, cols[i], y + 13, { align: aligns[i] }))
      y += 20

      // ── Line items ──
      doc.setTextColor(0); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5)
      for (const line of order.order_lines) {
        y += 16
        const rate   = line.unit_price ?? 0
        const amount = rate * line.qty
        const desc   = (line.skus as any)?.[0]?.description ?? line.description ?? '—'
        doc.setTextColor(0)
        doc.text(order.order_number, cols[0], y)
        doc.setFont('helvetica', 'bold')
        doc.text(line.ss_sku ?? '—', cols[1], y)
        doc.setFont('helvetica', 'normal')
        doc.text(doc.splitTextToSize(desc, 200)[0], cols[2], y)
        doc.text(String(line.qty), cols[3], y, { align: 'right' })
        doc.text(fmt(rate), cols[4], y, { align: 'right' })
        doc.text(fmt(amount), cols[5] + 10, y, { align: 'right' })
        doc.setDrawColor(220); doc.line(margin, y + 4, W - margin, y + 4)
      }

      // Shipping row
      y += 16
      doc.setTextColor(100); doc.setFontSize(8)
      doc.text('Shipping Cost', cols[0], y)
      doc.text(fmt(shipping), cols[5] + 10, y, { align: 'right' })

      // Total row
      y += 6
      doc.setDrawColor(17); doc.setLineWidth(1.5)
      doc.line(margin, y, W - margin, y)
      doc.setLineWidth(0.5)
      y += 14
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(0)
      doc.text('TOTAL', cols[3], y, { align: 'right' })
      doc.text(fmt(total), cols[5] + 10, y, { align: 'right' })

      // Terms
      y += 40
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(150)
      doc.text('TERMS', W / 2, y, { align: 'center' })
      y += 12
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(0)
      doc.text('NET 30', W / 2, y, { align: 'center' })

      zip.file(`TURN-INV-${order.order_number}.pdf`, doc.output('arraybuffer'))
    }

    const blob = await zip.generateAsync({ type: 'blob' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = items.length === 1
      ? `TURN-INV-${items[0].order.order_number}.pdf`
      : `Turn5-Invoices-${items.length}.zip`
    a.click()
    URL.revokeObjectURL(url)
    setZipping(false)
  }

  if (loading) return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>Loading…</div>
  if (items.length === 0) return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>No invoices found.</div>

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          font-family: 'Inter', Arial, sans-serif;
          background: #f5f5f5;
          color: #111;
        }

        /* ── No-print toolbar ── */
        .toolbar {
          max-width: 820px;
          margin: 0 auto 12px;
          display: flex;
          gap: 10px;
          align-items: center;
          padding: 16px 4px 0;
        }
        .btn-print {
          background: #111;
          color: #fff;
          border: none;
          border-radius: 6px;
          padding: 8px 20px;
          font-size: 0.88rem;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
        }
        .btn-back {
          background: transparent;
          color: #555;
          border: 1px solid #ccc;
          border-radius: 6px;
          padding: 8px 16px;
          font-size: 0.88rem;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
        }
        .count-label {
          font-size: 0.82rem;
          color: #888;
          margin-left: 4px;
        }

        /* ── Invoice page ── */
        .invoice-page {
          background: #fff;
          max-width: 780px;
          margin: 0 auto 32px;
          padding: 56px 64px;
          box-shadow: 0 4px 32px rgba(0,0,0,0.08);
          border-radius: 4px;
        }

        .header-row {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 48px;
        }
        .invoice-title {
          font-size: 2.6rem;
          font-weight: 800;
          color: #111;
          letter-spacing: -0.02em;
        }
        .company-block {
          text-align: right;
          font-size: 0.82rem;
          line-height: 1.65;
          color: #333;
        }
        .company-block strong { font-weight: 700; font-size: 0.88rem; }

        .meta-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 32px;
          margin-bottom: 36px;
        }
        .meta-label {
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #888;
          margin-bottom: 10px;
        }
        .meta-field { display: flex; font-size: 0.84rem; margin-bottom: 4px; }
        .meta-field .key { color: #888; min-width: 110px; }
        .meta-field .val { font-weight: 600; color: #111; }
        .bill-to-name { font-weight: 700; font-size: 0.9rem; margin-bottom: 3px; }
        .bill-to-addr { font-size: 0.82rem; color: #444; line-height: 1.6; }

        .items-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
        .items-table thead tr { background: #111; color: #fff; }
        .items-table th {
          padding: 10px 14px;
          text-align: left;
          font-weight: 700;
          font-size: 0.78rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .items-table th.right { text-align: right; }
        .items-table td { padding: 11px 14px; border-bottom: 1px solid #e8e8e8; color: #111; }
        .items-table td.right { text-align: right; }
        .items-table td.mono  { font-family: monospace; font-weight: 600; }
        .items-table tr.shipping td { color: #555; font-size: 0.82rem; border-bottom: none; }
        .items-table tr.total-row td {
          border-top: 2px solid #111;
          border-bottom: none;
          font-weight: 800;
          font-size: 0.9rem;
          padding-top: 12px;
        }

        .terms-block {
          margin-top: 48px;
          text-align: center;
          font-size: 0.8rem;
          color: #888;
        }
        .terms-block strong {
          display: block;
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          margin-bottom: 4px;
          color: #888;
        }
        .terms-value { font-weight: 700; font-size: 0.9rem; color: #111; }

        @media print {
          body { background: #fff; }
          .toolbar { display: none !important; }
          .invoice-page {
            margin: 0;
            box-shadow: none;
            border-radius: 0;
            max-width: 100%;
            padding: 40px 48px;
            page-break-after: always;
          }
          .invoice-page:last-child { page-break-after: avoid; }
        }
      `}</style>

      {/* Toolbar */}
      <div className="toolbar">
        <a href="/invoices" className="btn-back">← Back</a>
        <button className="btn-print" onClick={() => window.print()}>
          🖨 Print / Save as PDF
        </button>
        <button className="btn-print" style={{ background: '#1d4ed8' }} onClick={() => void downloadZip()} disabled={zipping}>
          {zipping ? '⏳ Building ZIP…' : `⬇ Download ${items.length > 1 ? 'ZIP' : 'PDF'}`}
        </button>
        <span className="count-label">{items.length} invoice{items.length !== 1 ? 's' : ''}</span>
      </div>

      {/* One .invoice-page per invoice */}
      {items.map(({ invoice, order }) => {
        const shipping   = invoice.shipping_cost ?? order.shipping_cost ?? 0
        const lineTotal  = order.order_lines.reduce((s, l) => s + (l.unit_price ?? 0) * l.qty, 0)
        const total      = lineTotal + shipping
        const invoiceNum = `TURN INV-${order.order_number}`

        return (
          <div key={invoice.id} className="invoice-page">
            <div className="header-row">
              <div className="invoice-title">Invoice</div>
              <div className="company-block">
                <strong>Garvin Industries LLC</strong><br />
                14324 172nd Ave.<br />
                Grand Haven, MI 49417<br />
                231-375-7197<br />
                charlie@garvinracks.com<br />
                garvinracks.com
              </div>
            </div>

            <div className="meta-row">
              <div>
                <div className="meta-label">Invoice Details</div>
                <div className="meta-field"><span className="key">Invoice #</span><span className="val">{invoiceNum}</span></div>
                <div className="meta-field"><span className="key">Date of Issue</span><span className="val">{fmtDate(invoice.issue_date)}</span></div>
                <div className="meta-field"><span className="key">Due Date</span><span className="val">{fmtDate(invoice.due_date)}</span></div>
              </div>
              <div>
                <div className="meta-label">Bill To</div>
                <div className="bill-to-name">Turn5</div>
                <div className="bill-to-addr">
                  600 Cedar Hollow Rd<br />
                  Paoli, PA 19301
                </div>
              </div>
            </div>

            <table className="items-table">
              <thead>
                <tr>
                  <th>PO Number</th>
                  <th>SKU</th>
                  <th>Description</th>
                  <th className="right">QTY</th>
                  <th className="right">Rate</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {order.order_lines.map((line) => {
                  const rate   = line.unit_price ?? 0
                  const amount = rate * line.qty
                  const desc   = line.skus?.[0]?.description ?? line.description ?? '—'
                  return (
                    <tr key={line.id}>
                      <td>{order.order_number}</td>
                      <td className="mono">{line.ss_sku ?? '—'}</td>
                      <td>{desc}</td>
                      <td className="right">{line.qty}</td>
                      <td className="right">{fmt(rate)}</td>
                      <td className="right">{fmt(amount)}</td>
                    </tr>
                  )
                })}
                <tr className="shipping">
                  <td colSpan={3}>Shipping Cost</td>
                  <td></td>
                  <td className="right">{fmt(shipping)}</td>
                </tr>
                <tr className="total-row">
                  <td colSpan={4} className="right">TOTAL</td>
                  <td className="right">{fmt(total)}</td>
                </tr>
              </tbody>
            </table>

            <div className="terms-block">
              <strong>Terms</strong>
              <div className="terms-value">NET 30</div>
            </div>
          </div>
        )
      })}
    </>
  )
}

export default function PrintAllPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, fontFamily: 'sans-serif' }}>Loading…</div>}>
      <PrintAllInner />
    </Suspense>
  )
}
