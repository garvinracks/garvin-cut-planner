export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>

export interface ParsedPO {
  poNumber: string
  poDate: string
  shipTo: {
    name: string
    street1: string
    street2: string
    city: string
    state: string
    zip: string
    phone: string
  }
  items: Array<{
    qty: number
    sku: string
    localSku: string
    description: string
    unitPrice: number
  }>
}

function parseT5PO(text: string): ParsedPO {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  // ── PO Number ──────────────────────────────────────────────────────────────
  const poMatch = text.match(/PO #(\d+)/)
  const poNumber = poMatch?.[1] ?? ''

  // ── Date ───────────────────────────────────────────────────────────────────
  const dateMatch = text.match(/Date:\s*(\d+\/\d+\/\d+)/)
  const poDate = dateMatch?.[1] ?? ''

  // ── Ship To block (between "Ship To:" and "PO NUMBER") ────────────────────
  const shipToStart = text.indexOf('Ship To:')
  const shipToEnd   = text.indexOf('PO NUMBER')
  const shipToBlock = shipToStart >= 0 && shipToEnd > shipToStart
    ? text.slice(shipToStart + 8, shipToEnd).trim()
    : ''

  const stLines = shipToBlock.split('\n').map((l) => l.trim()).filter(Boolean)

  let name = '', street1 = '', street2 = '', city = '', state = '', zip = '', phone = ''

  if (stLines.length >= 1) name = stLines[0]

  // City/state/zip line: "City, ST XXXXX"
  const cszIdx = stLines.findIndex((l) => /^.+,\s+[A-Z]{2}\s+\d{5}/.test(l))
  if (cszIdx >= 0) {
    const m = stLines[cszIdx].match(/^(.+),\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/)
    if (m) { city = m[1].trim(); state = m[2]; zip = m[3] }
    const streets = stLines.slice(1, cszIdx)
    street1 = streets[0] ?? ''
    street2 = streets[1] ?? ''
  }

  // Phone
  const phoneLine = stLines.find((l) => /^Phone:/i.test(l))
  if (phoneLine) phone = phoneLine.replace(/^Phone:\s*/i, '').trim()

  // ── Line items ─────────────────────────────────────────────────────────────
  // Format: QTY  SKU  LOCAL_SKU  DESCRIPTION  $PRICE  $EXTENDED
  const items: ParsedPO['items'] = []
  const itemRe = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})/

  for (const line of lines) {
    if (/^QTY\b/i.test(line)) continue
    const m = line.match(itemRe)
    if (!m) continue
    items.push({
      qty:         parseInt(m[1]),
      sku:         m[2],
      localSku:    m[3],
      description: m[4].trim(),
      unitPrice:   parseFloat(m[5].replace(',', '')),
    })
  }

  return { poNumber, poDate, shipTo: { name, street1, street2, city, state, zip, phone }, items }
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('pdf') as File | null
    if (!file) return NextResponse.json({ error: 'No PDF uploaded.' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const { text } = await pdfParse(buffer)
    const parsed = parseT5PO(text)

    if (!parsed.poNumber) {
      return NextResponse.json({ error: 'Could not find PO number in PDF. Make sure this is a Turn5 PO.' }, { status: 422 })
    }

    return NextResponse.json(parsed)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
