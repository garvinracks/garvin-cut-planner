import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const SS_BASE = 'https://ssapi.shipstation.com'

function ssHeaders() {
  const key = process.env.SHIPSTATION_API_KEY
  const secret = process.env.SHIPSTATION_API_SECRET
  if (!key || !secret) throw new Error('ShipStation credentials not configured.')
  return {
    Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
  }
}

async function ssGet(path: string) {
  const res = await fetch(`${SS_BASE}${path}`, { headers: ssHeaders(), cache: 'no-store' })
  if (!res.ok) throw new Error(`ShipStation ${res.status}: ${await res.text()}`)
  return res.json()
}

// Fetch ALL pages of awaiting_shipment orders for a given store
async function fetchAllOrders(storeId: number): Promise<any[]> {
  const all: any[] = []
  let page = 1
  while (true) {
    const data = await ssGet(
      `/orders?storeId=${storeId}&orderStatus=awaiting_shipment&pageSize=500&page=${page}`
    )
    const batch: any[] = data.orders ?? []
    all.push(...batch)
    if (batch.length < 500 || all.length >= (data.total ?? 0)) break
    page++
  }
  return all
}

export async function POST() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )

    // ── Load store configuration saved in app_settings ─────────────────────────
    const { data: setting } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'shipstation_stores')
      .single()

    type StoreConf = { storeId: number; storeName: string; channel: string; enabled: boolean }
    const storeConfig: StoreConf[] = (setting?.value as StoreConf[]) ?? []
    const enabled = storeConfig.filter((s) => s.enabled)

    if (enabled.length === 0) {
      return NextResponse.json(
        { error: 'No stores configured. Go to the Orders page and set up your ShipStation stores first.' },
        { status: 400 }
      )
    }

    let imported = 0
    let skipped = 0
    let cancelled = 0

    // Track every ShipStation order ID seen in this sync across all stores
    const seenSsOrderIds = new Set<number>()

    for (const store of enabled) {
      const ssOrders = await fetchAllOrders(store.storeId)

      for (const o of ssOrders) {
        seenSsOrderIds.add(o.orderId)

        const customerName =
          o.shipTo?.name || o.billTo?.name || o.customerUsername || null

        // ── Upsert order ────────────────────────────────────────────────────────
        const { data: orderRow, error: orderErr } = await supabase
          .from('orders')
          .upsert(
            {
              shipstation_order_id: o.orderId,
              order_number: o.orderNumber,
              channel: store.channel,
              customer_name: customerName,
              customer_email: o.customerEmail ?? null,
              order_date: o.orderDate ?? null,
              ship_by_date: o.shipByDate ?? null,
              ss_status: o.orderStatus,
              status: 'open',
              synced_at: new Date().toISOString(),
            },
            { onConflict: 'shipstation_order_id' }
          )
          .select('id')
          .single()

        if (orderErr || !orderRow) {
          console.error('order upsert error', orderErr?.message)
          skipped++
          continue
        }

        // ── Re-sync line items: delete old then insert fresh ────────────────────
        await supabase.from('order_lines').delete().eq('order_id', orderRow.id)

        const items: any[] = (o.items ?? []).filter(
          (i: any) => i.sku && !i.adjustment && (i.quantity ?? 0) > 0
        )

        for (const item of items) {
          // Exact match against our skus table
          const { data: skuMatch } = await supabase
            .from('skus')
            .select('id')
            .eq('id', item.sku)
            .single()

          await supabase.from('order_lines').insert({
            order_id: orderRow.id,
            sku_id: skuMatch?.id ?? null,
            ss_sku: item.sku,
            description: item.name ?? null,
            qty: item.quantity ?? 1,
            unit_price: item.unitPrice ?? null,
          })
        }

        imported++
      }
    }

    // ── Mark cancelled: open orders no longer in ShipStation ───────────────────
    // Any order that is still 'open' in our DB but wasn't in the latest sync
    // has been cancelled or shipped in ShipStation — close it here too.
    if (seenSsOrderIds.size > 0) {
      const { data: openOrders } = await supabase
        .from('orders')
        .select('id, shipstation_order_id')
        .eq('status', 'open')

      const toCancel = (openOrders ?? []).filter(
        (o: any) => o.shipstation_order_id && !seenSsOrderIds.has(o.shipstation_order_id)
      )

      if (toCancel.length > 0) {
        await supabase
          .from('orders')
          .update({ status: 'cancelled', synced_at: new Date().toISOString() })
          .in('id', toCancel.map((o: any) => o.id))
        cancelled = toCancel.length
      }
    }

    return NextResponse.json({
      success: true,
      imported,
      skipped,
      cancelled,
      stores: enabled.map((s) => ({ name: s.storeName, channel: s.channel })),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ShipStation sync]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
