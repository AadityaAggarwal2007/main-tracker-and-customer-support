import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne, queryCount } from '@/lib/db';

const BATCH_SIZE = 500; // pg .in() equivalent

// ── GET all orders with filtering ──────────────────────────────
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const search      = searchParams.get('search') || '';
  const status      = searchParams.get('status') || '';
  const brand       = searchParams.get('brand') || '';
  const store       = searchParams.get('store') || '';
  const businessId  = searchParams.get('businessId') || ''; // panel filter
  const dateFrom    = searchParams.get('dateFrom') || '';
  const dateTo      = searchParams.get('dateTo') || '';
  const page        = parseInt(searchParams.get('page') || '1');
  const limit       = Math.min(parseInt(searchParams.get('limit') || '50'), 1000);
  const offset      = (page - 1) * limit;

  // Build WHERE clauses dynamically
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (search) {
    const looksLikeOrderId = search.startsWith('#') || /^\d+$/.test(search);
    if (looksLikeOrderId) {
      // Fast exact/prefix match for order IDs
      const searchId = search.startsWith('#') ? search : `#${search}`;
      conditions.push(`(o.order_id = $${paramIdx} OR o.order_id ILIKE $${paramIdx + 1})`);
      params.push(searchId, `${searchId}%`);
      paramIdx += 2;
    } else {
      // Full text search — uses trigram indexes
      conditions.push(
        `(o.order_id ILIKE $${paramIdx} OR o.customer_name ILIKE $${paramIdx} OR o.customer_mobile ILIKE $${paramIdx} OR o.customer_email ILIKE $${paramIdx})`
      );
      params.push(`%${search}%`);
      paramIdx++;
    }
  }

  if (status) {
    if (status === 'Cancelled') {
      conditions.push(`o.is_cancelled = true`);
    } else {
      conditions.push(`o.tracking_status = $${paramIdx} AND o.is_cancelled = false`);
      params.push(status);
      paramIdx++;
    }
  }

  if (dateFrom) {
    conditions.push(`o.created_at >= $${paramIdx}`);
    params.push(`${dateFrom}T00:00:00`);
    paramIdx++;
  }

  if (dateTo) {
    conditions.push(`o.created_at <= $${paramIdx}`);
    params.push(`${dateTo}T23:59:59`);
    paramIdx++;
  }

  // Store filter — filter by which Shopify store the order came from
  if (store) {
    conditions.push(`o.source_store = $${paramIdx}`);
    params.push(store);
    paramIdx++;
  }

  // Panel (business) filter — from query param OR user's token access restriction
  const effectiveBusinessIds: string[] = [];
  if (businessId) effectiveBusinessIds.push(businessId);
  // If user has panel restrictions in their token, enforce them
  if (user.businessIds && user.businessIds.length > 0) {
    if (businessId && !user.businessIds.includes(businessId)) {
      // Requested a panel they don't have access to — return empty
      return NextResponse.json({ orders: [], total: 0, page, limit });
    }
    if (!businessId) effectiveBusinessIds.push(...user.businessIds);
  }
  if (effectiveBusinessIds.length === 1) {
    conditions.push(`o.business_id = $${paramIdx}`);
    params.push(effectiveBusinessIds[0]);
    paramIdx++;
  } else if (effectiveBusinessIds.length > 1) {
    conditions.push(`o.business_id = ANY($${paramIdx}::uuid[])`);
    params.push(effectiveBusinessIds);
    paramIdx++;
  }

  // Brand filter — find order_ids matching the brand
  let brandOrderIds: string[] | null = null;
  if (brand) {
    const brandResult = await query<{ order_id: string }>(
      `SELECT DISTINCT order_id FROM order_items WHERE brand = $1`,
      [brand]
    );
    if (brandResult.rows.length === 0) {
      return NextResponse.json({ orders: [], total: 0, page, limit });
    }
    brandOrderIds = brandResult.rows.map(r => r.order_id);
    conditions.push(`o.order_id = ANY($${paramIdx}::text[])`);
    params.push(brandOrderIds);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const total = await queryCount(
    `SELECT COUNT(*) FROM orders o ${whereClause}`,
    params
  );

  // Get paginated orders with items
  const ordersResult = await query<Record<string, unknown>>(
    `SELECT
       o.*,
       COALESCE(
         json_agg(
           json_build_object(
             'id', oi.id,
             'order_id', oi.order_id,
             'brand', oi.brand,
             'product_name', oi.product_name,
             'quantity', oi.quantity,
             'price', oi.price
           )
         ) FILTER (WHERE oi.id IS NOT NULL),
         '[]'::json
       ) AS order_items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.order_id
     ${whereClause}
     GROUP BY o.id
     ORDER BY o.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, limit, offset]
  );

  // Status counts for KPI pills — uses panel/date/search filters but NOT status filter
  // so all stage counts are visible regardless of which status tab is active
  const countConditions: string[] = [];
  const countParams: unknown[] = [];
  let cpIdx = 1;

  if (search) {
    const looksLikeOrderId = search.startsWith('#') || /^\d+$/.test(search);
    if (looksLikeOrderId) {
      const searchId = search.startsWith('#') ? search : `#${search}`;
      countConditions.push(`(o.order_id = $${cpIdx} OR o.order_id ILIKE $${cpIdx + 1})`);
      countParams.push(searchId, `${searchId}%`);
      cpIdx += 2;
    } else {
      countConditions.push(`(o.order_id ILIKE $${cpIdx} OR o.customer_name ILIKE $${cpIdx} OR o.customer_mobile ILIKE $${cpIdx} OR o.customer_email ILIKE $${cpIdx})`);
      countParams.push(`%${search}%`);
      cpIdx++;
    }
  }
  if (dateFrom) { countConditions.push(`o.created_at >= $${cpIdx}`); countParams.push(`${dateFrom}T00:00:00`); cpIdx++; }
  if (dateTo) { countConditions.push(`o.created_at <= $${cpIdx}`); countParams.push(`${dateTo}T23:59:59`); cpIdx++; }
  if (store) { countConditions.push(`o.source_store = $${cpIdx}`); countParams.push(store); cpIdx++; }
  if (effectiveBusinessIds.length === 1) { countConditions.push(`o.business_id = $${cpIdx}`); countParams.push(effectiveBusinessIds[0]); cpIdx++; }
  else if (effectiveBusinessIds.length > 1) { countConditions.push(`o.business_id = ANY($${cpIdx}::uuid[])`); countParams.push(effectiveBusinessIds); cpIdx++; }
  if (brand && brandOrderIds) { countConditions.push(`o.order_id = ANY($${cpIdx}::text[])`); countParams.push(brandOrderIds); cpIdx++; }

  const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';
  const statusCountsResult = await query<{ tracking_status: string; is_cancelled: boolean; cnt: string }>(
    `SELECT tracking_status, is_cancelled, COUNT(*) as cnt FROM orders o ${countWhere} GROUP BY tracking_status, is_cancelled`,
    countParams
  );
  const statusCounts: Record<string, number> = {};
  let cancelledCount = 0;
  for (const row of statusCountsResult.rows) {
    if (row.is_cancelled) { cancelledCount += parseInt(row.cnt); }
    else { statusCounts[row.tracking_status] = (statusCounts[row.tracking_status] || 0) + parseInt(row.cnt); }
  }
  statusCounts['Cancelled'] = cancelledCount;

  const response = NextResponse.json({
    orders: ordersResult.rows,
    total,
    page,
    limit,
    statusCounts,
  });
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  return response;
}

// ── PATCH - bulk update status ─────────────────────────────────
export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role === 'viewer') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { orderIds, status, trackingId, courierPartner, notes, estimatedDelivery } = await request.json();

    if (!orderIds || !Array.isArray(orderIds) || !status) {
      return NextResponse.json({ error: 'orderIds array and status required' }, { status: 400 });
    }

    // Build SET clause dynamically
    const setClauses = ['tracking_status = $1', 'status_updated_at = NOW()'];
    const setParams: unknown[] = [status];
    let pi = 2;

    if (status === 'Cancelled') {
      setClauses.push('is_cancelled = true', 'cancelled_at = NOW()');
    }
    if (trackingId)        { setClauses.push(`tracking_id = $${pi++}`);       setParams.push(trackingId); }
    if (courierPartner)    { setClauses.push(`courier_partner = $${pi++}`);    setParams.push(courierPartner); }
    if (estimatedDelivery) { setClauses.push(`estimated_delivery = $${pi++}`); setParams.push(estimatedDelivery); }

    let totalUpdated = 0;

    // Batch update in chunks of BATCH_SIZE
    for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
      const batch = orderIds.slice(i, i + BATCH_SIZE);
      const result = await query(
        `UPDATE orders
         SET ${setClauses.join(', ')}
         WHERE order_id = ANY($${pi}::text[])`,
        [...setParams, batch]
      );
      totalUpdated += result.rowCount ?? 0;
    }

    // Insert tracking history in batches
    for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
      const batch = orderIds.slice(i, i + BATCH_SIZE);
      const valuePlaceholders = batch.map(
        (_, j) => `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`
      ).join(', ');
      const historyParams: unknown[] = [];
      batch.forEach((orderId) => {
        historyParams.push(orderId, status, user.displayName || user.username, notes || `Status updated to ${status}`);
      });
      await query(
        `INSERT INTO tracking_history (order_id, status, changed_by, notes) VALUES ${valuePlaceholders}`,
        historyParams
      );
    }

    return NextResponse.json({ success: true, updated: totalUpdated, total: orderIds.length });
  } catch {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}

// ── DELETE - delete single order or all orders ─────────────────
export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized — admin only' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { orderId, deleteAll } = body;

    if (deleteAll === true) {
      // Cascade deletes handle related rows automatically (FK ON DELETE CASCADE)
      await query(`DELETE FROM email_logs`);
      await query(`DELETE FROM tracking_history`);
      await query(`DELETE FROM draft_queue`);
      await query(`DELETE FROM order_items`);
      await query(`DELETE FROM orders`);
      return NextResponse.json({ success: true, deleted: 'all' });
    }

    if (!orderId) {
      return NextResponse.json({ error: 'orderId required' }, { status: 400 });
    }

    // CASCADE handles related rows
    const result = await query(`DELETE FROM orders WHERE order_id = $1`, [orderId]);
    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, deleted: orderId });
  } catch {
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
