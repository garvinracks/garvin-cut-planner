import { NextRequest, NextResponse } from 'next/server'

const SS_BASE = 'https://ssapi.shipstation.com'

function ssHeaders() {
  const key = process.env.SHIPSTATION_API_KEY
  const secret = process.env.SHIPSTATION_API_SECRET
  if (!key || !secret) throw new Error('ShipStation credentials not configured.')
  return {
    Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
  }
}

// Returns the raw SS order for a given order NUMBER (not internal ID)
// Usage: GET /api/shipstation/debug-order?orderNumber=1309
export async function GET(req: NextRequest) {
  const orderNumber = req.nextUrl.searchParams.get('orderNumber')
  if (!orderNumber) return NextResponse.json({ error: 'orderNumber query param required' }, { status: 400 })

  const res = await fetch(`${SS_BASE}/orders?orderNumber=${orderNumber}&pageSize=10`, {
    headers: ssHeaders(),
    cache: 'no-store',
  })
  if (!res.ok) return NextResponse.json({ error: `SS ${res.status}` }, { status: 500 })
  const data = await res.json()

  // Return the full order objects so we can see every field
  return NextResponse.json({ orders: data.orders ?? [] })
}
