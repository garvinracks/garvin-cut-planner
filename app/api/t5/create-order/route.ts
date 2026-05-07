export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { ParsedPO } from '../parse-po/route'

const SS_BASE = 'https://ssapi.shipstation.com'

function ssHeaders() {
  const key    = process.env.SHIPSTATION_API_KEY
  const secret = process.env.SHIPSTATION_API_SECRET
  if (!key || !secret) throw new Error('ShipStation credentials not configured.')
  return {
    Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
    'Content-Type': 'application/json',
  }
}

export async function POST(req: NextRequest) {
  try {
    const body: ParsedPO = await req.json()
    const { poNumber, poDate, shipTo, items } = body

    // ── Get Turn5 store ID from app_settings ──────────────────────────────────
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
    const { data: setting } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'shipstation_stores')
      .single()

    type StoreConf = { storeId: number; storeName: string; channel: string; enabled: boolean }
    const stores: StoreConf[] = (setting?.value as StoreConf[]) ?? []
    const t5Store = stores.find((s) => s.channel === 'turn5' && s.enabled)
    if (!t5Store) {
      return NextResponse.json({ error: 'No Turn5 store configured in ShipStation settings.' }, { status: 400 })
    }

    // ── Parse date to ISO ─────────────────────────────────────────────────────
    let orderDateIso = new Date().toISOString()
    if (poDate) {
      const [m, d, y] = poDate.split('/')
      orderDateIso = new Date(`${y}-${m?.padStart(2,'0')}-${d?.padStart(2,'0')}T12:00:00.000Z`).toISOString()
    }

    // ── Build ShipStation order payload ───────────────────────────────────────
    const ssOrder = {
      orderNumber:   poNumber,
      orderDate:     orderDateIso,
      orderStatus:   'awaiting_shipment',
      shipTo: {
        name:       shipTo.name,
        company:    null,
        street1:    shipTo.street1,
        street2:    shipTo.street2 || null,
        street3:    null,
        city:       shipTo.city,
        state:      shipTo.state,
        postalCode: shipTo.zip,
        country:    'US',
        phone:      shipTo.phone || null,
        residential: true,
      },
      billTo: {
        name:       'Turn5',
        company:    'Turn5',
        street1:    '600 Cedar Hollow Rd',
        street2:    null,
        street3:    null,
        city:       'Paoli',
        state:      'PA',
        postalCode: '19301',
        country:    'US',
        phone:      null,
        residential: false,
      },
      items: items.map((item) => ({
        lineItemKey:  null,
        sku:          item.sku,
        name:         item.description,
        quantity:     item.qty,
        unitPrice:    item.unitPrice,
        adjustment:   false,
      })),
      amountPaid:   0,
      taxAmount:    0,
      shippingAmount: 0,
      advancedOptions: {
        storeId: t5Store.storeId,
      },
    }

    // ── Create order in ShipStation ───────────────────────────────────────────
    const res = await fetch(`${SS_BASE}/orders/createorder`, {
      method:  'POST',
      headers: ssHeaders(),
      body:    JSON.stringify(ssOrder),
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `ShipStation error ${res.status}: ${text}` }, { status: 502 })
    }

    const created = await res.json()
    return NextResponse.json({ success: true, orderId: created.orderId, orderNumber: created.orderNumber })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
