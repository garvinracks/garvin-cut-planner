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
async function fetchAwaitingOrders(storeId: number): Promise<any[]> {
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

// Look up a single order's real status from ShipStation
async function ssGetOrder(ssOrderId: number): Promise<{ orderStatus: string; shippingAmount?: number } | null> {
  try {
    return await ssGet(`/orders/${ssOrderId}`)
  } catch {
    return null
  }
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
    let shipped  = 0
    let skipped  = 0
    let cancelled = 0

    const seenSsOrderIds = new Set<number>()

    for (const store of enabled) {
      // ── 1. Sync awaiting_shipment → status 'open' ────────────────────────────
      const awaitingOrders = await fetchAwaitingOrders(store.storeId)

      for (const o of awaitingOrders) {
        seenSsOrderIds.add(o.orderId)

        const customerName =
          o.shipTo?.name || o.billTo?.name || o.customerUsername || null

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

        // Re-sync line items: delete old then insert fresh
        await supabase.from('order_lines').delete().eq('order_id', orderRow.id)

        const items: any[] = (o.items ?? []).filter(
          (i: any) => i.sku && !i.adjustment && (i.quantity ?? 0) > 0
        )

        for (const item of items) {
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

    // ── 2. Resolve orders absent from awaiting_shipment ──────────────────────
    // Any order that is 'open' OR 'cancelled' in our DB but not in the sync
    // may have been shipped or explicitly cancelled in ShipStation.
    // Look each one up individually to get the real status.
    // Query open and cancelled orders separately to avoid any .in() issues
    const { data: openRows,      error: openErr }      = await supabase.from('orders').select('id, shipstation_order_id, shipping_cost, status').eq('status', 'open').not('shipstation_order_id', 'is', null)
    const { data: cancelledRows, error: cancelledErr } = await supabase.from('orders').select('id, shipstation_order_id, shipping_cost, status').eq('status', 'cancelled').not('shipstation_order_id', 'is', null)

    const unresolvedOrders = [...(openRows ?? []), ...(cancelledRows ?? [])]

    const toResolve = unresolvedOrders.filter(
      (o: any) => !seenSsOrderIds.has(o.shipstation_order_id)
    )

    // Debug info to surface in the UI
    const debug = {
      openErr: openErr?.message ?? null,
      cancelledErr: cancelledErr?.message ?? null,
      openCount: openRows?.length ?? 0,
      cancelledCount: cancelledRows?.length ?? 0,
      unresolvedTotal: unresolvedOrders.length,
      toResolveCount: toResolve.length,
      seenCount: seenSsOrderIds.size,
      ssStatuses: [] as string[],
    }

    for (const row of toResolve) {
      const ssOrder = await ssGetOrder(row.shipstation_order_id)
      if (!ssOrder) { skipped++; continue }

      const ssStatus = ssOrder.orderStatus ?? ''
      debug.ssStatuses.push(ssStatus)

      if (ssStatus === 'shipped') {
        await supabase
          .from('orders')
          .update({
            status: 'shipped',
            ss_status: 'shipped',
            shipping_cost: row.shipping_cost ?? ssOrder.shippingAmount ?? null,
            synced_at: new Date().toISOString(),
          })
          .eq('id', row.id)
        shipped++
      } else if (ssStatus === 'cancelled' || ssStatus === 'on_hold') {
        await supabase
          .from('orders')
          .update({ status: 'cancelled', ss_status: ssStatus, synced_at: new Date().toISOString() })
          .eq('id', row.id)
        cancelled++
      }
    }

    return NextResponse.json({
      success: true,
      imported,
      shipped,
      skipped,
      cancelled,
      debug,
      stores: enabled.map((s) => ({ name: s.storeName, channel: s.channel })),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ShipStation sync]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
