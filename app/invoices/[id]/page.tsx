'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { useParams } from 'next/navigation'

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

function fmt(n: number) { return '$' + n.toFixed(2) }
function fmtDate(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export default function InvoicePrintPage() {
  const params  = useParams()
  const id      = params.id as string
  const supabase = useMemo(() => createBrowserClient(), [])

  const [invoice, setInvoice] = useState<T5Invoice | null>(null)
  const [order, setOrder]     = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: inv } = await supabase.from('turn5_invoices').select('*').eq('id', id).single()
      if (!inv) { setLoading(false); return }
      setInvoice(inv as T5Invoice)
      const { data: ord } = await supabase
        .from('orders')
        .select('id, order_number, order_date, shipping_cost, order_lines(id, ss_sku, description, qty, unit_price, skus(description))')
        .eq('id', inv.order_id)
        .single()
      setOrder(ord as Order)
      setLoading(false)
    }
    void load()
  }, [id, supabase])

  if (loading) return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>Loading…</div>
  if (!invoice || !order) return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>Invoice not found.</div>

  const shipping   = invoice.shipping_cost ?? order.shipping_cost ?? 0
  const lineTotal  = order.order_lines.reduce((s, l) => s + (l.unit_price ?? 0) * l.qty, 0)
  const total      = lineTotal + shipping
  const invoiceNum = `TURN INV-${order.order_number}`

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

        .page-wrap {
          background: #fff;
          max-width: 780px;
          margin: 32px auto;
          padding: 56px 64px;
          box-shadow: 0 4px 32px rgba(0,0,0,0.08);
          border-radius: 4px;
        }

        /* ── No-print toolbar ── */
        .toolbar {
          max-width: 780px;
          margin: 0 auto 12px;
          display: flex;
          gap: 10px;
          padding: 0 4px;
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

        /* ── Invoice layout ── */
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
        .company-block strong {
          font-weight: 700;
          font-size: 0.88rem;
        }

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

        .meta-field {
          display: flex;
          font-size: 0.84rem;
          margin-bottom: 4px;
        }
        .meta-field .key {
          color: #888;
          min-width: 110px;
        }
        .meta-field .val {
          font-weight: 600;
          color: #111;
        }

        .bill-to-name {
          font-weight: 700;
          font-size: 0.9rem;
          margin-bottom: 3px;
        }
        .bill-to-addr {
          font-size: 0.82rem;
          color: #444;
          line-height: 1.6;
        }

        /* ── Line items table ── */
        .items-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 0;
          font-size: 0.84rem;
        }

        .items-table thead tr {
          background: #111;
          color: #fff;
        }

        .items-table th {
          padding: 10px 14px;
          text-align: left;
          font-weight: 700;
          font-size: 0.78rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .items-table th.right { text-align: right; }

        .items-table td {
          padding: 11px 14px;
          border-bottom: 1px solid #e8e8e8;
          color: #111;
        }
        .items-table td.right { text-align: right; }
        .items-table td.mono  { font-family: monospace; font-weight: 600; }

        .items-table tr.shipping td {
          color: #555;
          font-size: 0.82rem;
          border-bottom: none;
        }

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
        .terms-value {
          font-weight: 700;
          font-size: 0.9rem;
          color: #111;
        }

        @media print {
          body { background: #fff; }
          .toolbar { display: none !important; }
          .page-wrap { margin: 0; box-shadow: none; border-radius: 0; max-width: 100%; padding: 40px 48px; }
        }
      `}</style>

      {/* Toolbar — hidden on print */}
      <div className="toolbar">
        <a href="/invoices" className="btn-back">← Back</a>
        <button className="btn-print" onClick={() => window.print()}>🖨 Print / Save as PDF</button>
      </div>

      {/* Invoice */}
      <div className="page-wrap">

        {/* Header */}
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

        {/* Invoice details + Bill To */}
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

        {/* Line items */}
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
              // Prefer Garvin SKU description; fall back to ShipStation description
              const desc = line.skus?.[0]?.description ?? line.description ?? '—'
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

        {/* Terms */}
        <div className="terms-block">
          <strong>Terms</strong>
          <div className="terms-value">NET 30</div>
        </div>

      </div>
    </>
  )
}
