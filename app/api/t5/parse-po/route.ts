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

  // Anchor on ", STATE ZIP" (unambiguous) to extract state + zip first
  const szM = addrBlock.match(/,\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/)
  if (szM) {
    state = szM[1]
    zip   = szM[2]
    // Everything before ", STATE ZIP" contains: name + street number + street name + [apt] + city
    const beforeStateZip = addrBlock.slice(0, szM.index!).trim()

    // Use the last common street suffix to cleanly split street from city.
    // This prevents "Randalsville Rd Hamilton" being treated as one city name.
    const SUFFIX_RE = /\b(Rd|St|Ave|Blvd|Dr|Ln|Way|Ct|Pl|Ter|Cir|Hwy|Pkwy|Trl|Loop|Sq)\b/gi
    let lastSfx: RegExpExecArray | null = null
    let sfxM: RegExpExecArray | null
    while ((sfxM = SUFFIX_RE.exec(beforeStateZip)) !== null) { lastSfx = sfxM }

    if (lastSfx) {
      const sfxEnd = lastSfx.index + lastSfx[0].length
      const afterSuffix = beforeStateZip.slice(sfxEnd).trim()
      const nameStreetBlock = beforeStateZip.slice(0, sfxEnd).trim()

      // After the suffix there may be an apt/unit token before the city
      // e.g. "A209 Lehi" → street2="A209", city="Lehi"
      const aptCityM = afterSuffix.match(/^([A-Z]\d+|\d+[A-Z]|(?:Apt|Suite|Ste|Unit|#)\s*\w+)\s+(.+)$/i)
      if (aptCityM) {
        street2 = aptCityM[1].trim()
        city    = aptCityM[2].trim()
      } else {
        city = afterSuffix
      }

      // Parse name and street number+name from nameStreetBlock
      // Name can contain hyphens (Young-gray), apostrophes (O'Brien), periods (Jr.)
      const nsM = nameStreetBlock.match(/^([A-Za-z][A-Za-z\s'.-]+?)\s+(\d+.*)$/)
      if (nsM) {
        name    = nsM[1].trim()
        street1 = nsM[2].trim()
      } else {
        name = nameStreetBlock
      }
    } else {
      // Fallback: no street suffix — try splitting on last run of alpha words (city)
      const nsM = beforeStateZip.match(/^([A-Za-z][A-Za-z\s'.-]+?)\s+(\d+.*?)\s+([A-Za-z][A-Za-z\s]*)$/)
      if (nsM) {
        name    = nsM[1].trim()
        street1 = nsM[2].trim()
        city    = nsM[3].trim()
      } else {
        name = beforeStateZip
      }
    }
  }

  // ── Line items ─────────────────────────────────────────────────────────────
  // SKU can be alphanumeric with hyphens (e.g. "20097-4XE", "44085")
  const items: ParsedPO['items'] = []
  const itemRe = /\b(\d{1,2})\s+(\d[\dA-Z-]{3,})\s+([A-Z][A-Z0-9-]+)\s+([A-Za-z].*?)\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})/g

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
