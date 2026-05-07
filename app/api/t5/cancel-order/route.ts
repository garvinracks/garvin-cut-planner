export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'

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
    const { ssOrderId } = await req.json() as { ssOrderId: number }
    if (!ssOrderId) return NextResponse.json({ error: 'ssOrderId required.' }, { status: 400 })

    const res = await fetch(`${SS_BASE}/orders/${ssOrderId}/void`, {
      method:  'POST',
      headers: ssHeaders(),
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `ShipStation error ${res.status}: ${text}` }, { status: 502 })
    }

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
