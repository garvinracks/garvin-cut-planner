export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { extractText } from 'unpdf'

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

function parseT5PO(raw: string): ParsedPO {
  // Normalise — collapse multiple spaces but keep a single space between tokens
  const text = raw.replace(/\r\n/g, ' ').replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ')

  // ── PO Number ──────────────────────────────────────────────────────────────
  const poNumber = text.match(/PO #(\d+)/)?.[1] ?? ''

  // ── Date ───────────────────────────────────────────────────────────────────
  const poDate = text.match(/Date:\s*(\d+\/\d+\/\d+)/)?.[1] ?? ''

  // ── Ship To block (between "Ship To:" and "PO NUMBER") ────────────────────
  const shipToStart = text.indexOf('Ship To:')
  const shipToEnd   = text.indexOf('PO NUMBER')
  const shipToBlock = shipToStart >= 0 && shipToEnd > shipToStart
    ? text.slice(shipToStart + 8, shipToEnd).trim()
    : ''

  let name = '', street1 = '', street2 = '', city = '', state = '', zip = '', phone = ''

  // Phone (label is always present)
  phone = shipToBlock.match(/Phone:\s*(\d+)/i)?.[1] ?? ''

  // Remove phone segment for cleaner parsing
  const addrBlock = shipToBlock.replace(/Phone:\s*\d+/i, '').trim()

  // City, State ZIP  — anchor on this to split name+street from city
  const cszMatch = addrBlock.match(/([A-Za-z][A-Za-z\s]+),\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/)
  if (cszMatch) {
    city  = cszMatch[1].trim()
    state = cszMatch[2]
    zip   = cszMatch[3]
    const beforeCsz = addrBlock.slice(0, addrBlock.indexOf(cszMatch[0])).trim()

    // Name = leading words before first digit (street number)
    const nameStreetMatch = beforeCsz.match(/^([A-Za-z][A-Za-z\s]+?)\s+(\d+.*)$/)
    if (nameStreetMatch) {
      name = nameStreetMatch[1].trim()
      const streetPart = nameStreetMatch[2].trim()
      // Apt/unit: short standalone token at the end — e.g. "A209", "#3", "Apt 2B"
      const aptMatch = streetPart.match(/^(.+?)\s+((?:[A-Z]\d+|\d+[A-Z]?|(?:Apt|Suite|Ste|Unit|#)\s*\w+))\s*$/i)
      if (aptMatch) { street1 = aptMatch[1].trim(); street2 = aptMatch[2].trim() }
      else           { street1 = streetPart }
    } else {
      name = beforeCsz
    }
  }

  // ── Line items ─────────────────────────────────────────────────────────────
  // Pattern (in flattened text): QTY(1-2d) T5-SKU(4-6d) LOCAL-SKU(alphanum) description $price $extended
  const items: ParsedPO['items'] = []
  const itemRe = /\b(\d{1,2})\s+(\d{4,6})\s+([A-Z][A-Z0-9]+)\s+([A-Za-z].*?)\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})/g

  let m: RegExpExecArray | null
  while ((m = itemRe.exec(text)) !== null) {
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

    const buffer = await file.arrayBuffer()
    const { text: pages } = await extractText(new Uint8Array(buffer), { mergePages: true })
    const text = Array.isArray(pages) ? pages.join('\n') : pages
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
