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
async function ssGetOrder(ssOrderId: number): Promise<{ orderStatus: string; shippingAmount?: number; shipDate?: string } | null> {
  try {
    return await ssGet(`/orders/${ssOrderId}`)
  } catch {
    return null
  }
}

// Get the actual label cost + ship date from the shipments on an order.
// shipmentCost = what Garvin paid for the USPS/UPS label (not what the buyer paid).
async function ssGetLabelCost(ssOrderId: number): Promise<{ labelCost: number | null; shipDate: string | null }> {
  try {
    const data = await ssGet(`/shipments?orderId=${ssOrderId}`)
    const shipments: any[] = (data.shipments ?? []).filter((s: any) => !s.voided)
    if (shipments.length === 0) return { labelCost: null, shipDate: null }
    // Use the most recent non-voided shipment
    const s = shipments[shipments.length - 1]
    const labelCost = (s.shipmentCost ?? 0) + (s.insuranceCost ?? 0)
    return { labelCost: labelCost > 0 ? labelCost : null, shipDate: s.shipDate ?? null }
  } catch {
    return { labelCost: null, shipDate: null }
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
    const { data: openRows,      error: openErr }      = await supabase.from('orders').select('id, shipstation_order_id, status').eq('status', 'open').not('shipstation_order_id', 'is', null)
    const { data: cancelledRows, error: cancelledErr } = await supabase.from('orders').select('id, shipstation_order_id, status').eq('status', 'cancelled').not('shipstation_order_id', 'is', null)

    const unresolvedOrders = [...(openRows ?? []), ...(cancelledRows ?? [])]

    const toResolve = unresolvedOrders.filter(
      (o: any) => !seenSsOrderIds.has(o.shipstation_order_id)
    )

    // Track customer names with a shipped order — both from this sync run
    // AND recently shipped in the DB (covers cases where surviving order
    // was already shipped in a prior sync run)
    const shippedCustomerNames = new Set<string>()

    // Pre-load ALL shipped orders from DB so we can detect combined shipments
    // regardless of whether shipped_at is populated (some manual combines may lack it)
    const { data: recentShipped } = await supabase
      .from('orders')
      .select('customer_name')
      .eq('status', 'shipped')
      .not('customer_name', 'is', null)
    for (const r of recentShipped ?? []) {
      if (r.customer_name) shippedCustomerNames.add(r.customer_name.toLowerCase().trim())
    }

    const pendingCancels: Array<{ row: any; ssStatus: string }> = []
    const resolveLog: Array<{ dbId: string; ssOrderId: number; dbStatus: string; ssStatus: string; customerKey: string; inShippedSet: boolean; action: string }> = []

    for (const row of toResolve) {
      const ssOrder = await ssGetOrder(row.shipstation_order_id)
      if (!ssOrder) { skipped++; continue }

      const ssStatus = ssOrder.orderStatus ?? ''

      if (ssStatus === 'shipped') {
        const { labelCost, shipDate } = await ssGetLabelCost(row.shipstation_order_id)
        await supabase
          .from('orders')
          .update({
            status: 'shipped',
            ss_status: 'shipped',
            shipped_at: shipDate ?? new Date().toISOString(),
            shipping_cost: labelCost,
            synced_at: new Date().toISOString(),
          })
          .eq('id', row.id)
        const { data: ord } = await supabase.from('orders').select('customer_name').eq('id', row.id).single()
        if (ord?.customer_name) shippedCustomerNames.add(ord.customer_name.toLowerCase().trim())
        resolveLog.push({ dbId: row.id, ssOrderId: row.shipstation_order_id, dbStatus: row.status, ssStatus, customerKey: ord?.customer_name ?? '', inShippedSet: true, action: 'marked_shipped' })
        shipped++
      } else if (ssStatus === 'cancelled' || ssStatus === 'on_hold') {
        pendingCancels.push({ row, ssStatus })
        resolveLog.push({ dbId: row.id, ssOrderId: row.shipstation_order_id, dbStatus: row.status, ssStatus, customerKey: '', inShippedSet: false, action: 'pending_cancel' })
      } else {
        resolveLog.push({ dbId: row.id, ssOrderId: row.shipstation_order_id, dbStatus: row.status, ssStatus, customerKey: '', inShippedSet: false, action: 'no_change' })
      }
    }

    // Process deferred cancels — if the same customer has a recently shipped
    // order, this was likely a ShipStation order combine, not a true cancel
    for (const { row, ssStatus } of pendingCancels) {
      const { data: ord } = await supabase.from('orders').select('customer_name, status').eq('id', row.id).single()
      const customerKey = ord?.customer_name?.toLowerCase().trim() ?? ''
      const isCombined  = ssStatus === 'cancelled' && customerKey && shippedCustomerNames.has(customerKey)

      // Update resolveLog entry
      const logEntry = resolveLog.find(l => l.dbId === row.id)
      if (logEntry) { logEntry.customerKey = customerKey; logEntry.inShippedSet = shippedCustomerNames.has(customerKey) }

      if (isCombined) {
        await supabase
          .from('orders')
          .update({
            status: 'shipped',
            ss_status: 'cancelled',
            shipped_at: new Date().toISOString(),
            notes: 'Combined shipment — orders merged in ShipStation',
            synced_at: new Date().toISOString(),
          })
          .eq('id', row.id)
        if (logEntry) logEntry.action = 'combined_shipped'
        shipped++
      } else {
        await supabase
          .from('orders')
          .update({ status: 'cancelled', ss_status: ssStatus, synced_at: new Date().toISOString() })
          .eq('id', row.id)
        if (logEntry) logEntry.action = 'cancelled'
        cancelled++
      }
    }

    // ── 3. Backfill shipped orders missing date or label cost ─────────────────
    // Orders shipped before label-cost tracking was added, plus any that came
    // back with $0 (shippingAmount from the order, not the actual label cost).
    let backfilled = 0
    const { data: incompleteShipped } = await supabase
      .from('orders')
      .select('id, shipstation_order_id')
      .eq('status', 'shipped')
      .not('shipstation_order_id', 'is', null)
      .or('shipping_cost.is.null,shipped_at.is.null,shipping_cost.eq.0')

    for (const row of (incompleteShipped ?? [])) {
      const { labelCost, shipDate } = await ssGetLabelCost(row.shipstation_order_id)
      await supabase
        .from('orders')
        .update({
          shipping_cost: labelCost,
          shipped_at:    shipDate ?? new Date().toISOString(),
          synced_at:     new Date().toISOString(),
        })
        .eq('id', row.id)
      backfilled++
    }

    return NextResponse.json({
      success: true,
      imported,
      shipped,
      skipped,
      cancelled,
      backfilled,
      stores: enabled.map((s) => ({ name: s.storeName, channel: s.channel })),
      debug: { resolveLog, shippedNamesCount: shippedCustomerNames.size, shippedNames: [...shippedCustomerNames] },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ShipStation sync]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
