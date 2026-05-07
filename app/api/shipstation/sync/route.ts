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

// Fetch ALL pages of orders with a given status for a store
async function fetchOrdersByStatus(storeId: number, orderStatus: string, modifyDateStart?: string): Promise<any[]> {
  const all: any[] = []
  let page = 1
  while (true) {
    let url = `/orders?storeId=${storeId}&orderStatus=${orderStatus}&pageSize=500&page=${page}`
    if (modifyDateStart) url += `&modifyDateStart=${modifyDateStart}`
    const data = await ssGet(url)
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
    let shipped  = 0
    let skipped  = 0
    let cancelled = 0

    // Track every ShipStation order ID seen in this sync across all stores
    const seenSsOrderIds = new Set<number>()

    // Shipped orders: look back 90 days so recently-shipped orders are captured
    const since90 = new Date()
    since90.setDate(since90.getDate() - 90)
    const sinceStr = since90.toISOString().split('T')[0]

    for (const store of enabled) {
      // ── 1. awaiting_shipment → status: 'open' ─────────────────────────────
      const awaitingOrders = await fetchOrdersByStatus(store.storeId, 'awaiting_shipment')

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

      // ── 2. shipped (last 90 days) → status: 'shipped' ─────────────────────
      // This corrects orders that were wrongly marked 'cancelled' after shipping.
      const shippedOrders = await fetchOrdersByStatus(store.storeId, 'shipped', sinceStr)

      for (const o of shippedOrders) {
        seenSsOrderIds.add(o.orderId)

        const customerName =
          o.shipTo?.name || o.billTo?.name || o.customerUsername || null

        // Upsert but do NOT overwrite shipping_cost if already recorded locally
        const { data: existing } = await supabase
          .from('orders')
          .select('id, shipping_cost')
          .eq('shipstation_order_id', o.orderId)
          .single()

        const { error: shipErr } = await supabase
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
              ss_status: 'shipped',
              status: 'shipped',
              // Use locally-recorded shipping cost if set, otherwise pull from ShipStation
              shipping_cost: existing?.shipping_cost ?? (o.shippingAmount ?? null),
              synced_at: new Date().toISOString(),
            },
            { onConflict: 'shipstation_order_id' }
          )

        if (!shipErr) shipped++
      }
    }

    // ── 3. Mark truly-cancelled: open orders absent from both lists ────────────
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
      shipped,
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
