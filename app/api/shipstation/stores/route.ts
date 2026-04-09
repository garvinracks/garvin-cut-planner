import { NextResponse } from 'next/server'

const SS_BASE = 'https://ssapi.shipstation.com'

function ssHeaders() {
  const key = process.env.SHIPSTATION_API_KEY
  const secret = process.env.SHIPSTATION_API_SECRET
  if (!key || !secret) {
    throw new Error(
      'ShipStation credentials not configured. ' +
      'Add SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET to your Vercel environment variables.'
    )
  }
  return {
    Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
  }
}

export async function GET() {
  try {
    const res = await fetch(`${SS_BASE}/stores?showInactive=false`, {
      headers: ssHeaders(),
      cache: 'no-store',
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json(
        { error: `ShipStation returned ${res.status}: ${text}` },
        { status: res.status }
      )
    }

    const data = await res.json()
    return NextResponse.json(data)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
