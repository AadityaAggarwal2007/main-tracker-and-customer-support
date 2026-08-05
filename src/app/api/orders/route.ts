import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

const BATCH_SIZE = 100; // Supabase .in() limit

// GET all orders with filtering
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const search = searchParams.get('search') || '';
  const status = searchParams.get('status') || '';
  const brand = searchParams.get('brand') || '';
  const store = searchParams.get('store') || '';
  const dateFrom = searchParams.get('dateFrom') || '';
  const dateTo = searchParams.get('dateTo') || '';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 1000); // Cap at 1000
  const offset = (page - 1) * limit;

  let query = getSupabaseAdmin()
    .from('orders')
    .select('*, order_items(*)', { count: 'exact' });

  if (search) {
    query = query.or(
      `order_id.ilike.%${search}%,customer_name.ilike.%${search}%,customer_mobile.ilike.%${search}%,customer_email.ilike.%${search}%`
    );
  }

  if (status) {
    if (status === 'Cancelled') {
      query = query.eq('is_cancelled', true);
    } else {
      query = query.eq('tracking_status', status).eq('is_cancelled', false);
    }
  }

  // Date filter
  if (dateFrom) {
    query = query.gte('created_at', `${dateFrom}T00:00:00`);
  }
  if (dateTo) {
    query = query.lte('created_at', `${dateTo}T23:59:59`);
  }

  // Store filter — filter by which Shopify store the order came from
  if (store) {
    query = query.eq('source_store', store);
  }

  if (brand) {
    const { data: orderIds } = await getSupabaseAdmin()
      .from('order_items')
      .select('order_id')
      .eq('brand', brand);
    
    if (orderIds && orderIds.length > 0) {
      const uniqueIds = [...new Set(orderIds.map(o => o.order_id))];
      query = query.in('order_id', uniqueIds);
    } else {
      return NextResponse.json({ orders: [], total: 0, page, limit });
    }
  }



  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    orders: data || [],
    total: count || 0,
    page,
    limit,
  });
}

// PATCH - bulk update status + estimated delivery + notes
// Batched to handle 500+ orders (Supabase .in() limit ~100)
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

    const updateData: Record<string, unknown> = {
      tracking_status: status,
      status_updated_at: new Date().toISOString(),
    };

    if (status === 'Cancelled') {
      updateData.is_cancelled = true;
      updateData.cancelled_at = new Date().toISOString();
    }

    if (trackingId) updateData.tracking_id = trackingId;
    if (courierPartner) updateData.courier_partner = courierPartner;
    if (estimatedDelivery) updateData.estimated_delivery = estimatedDelivery;

    // Batch update — split into chunks of 100 to avoid .in() limit
    let totalUpdated = 0;
    for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
      const batch = orderIds.slice(i, i + BATCH_SIZE);
      const { error } = await getSupabaseAdmin()
        .from('orders')
        .update(updateData)
        .in('order_id', batch);

      if (error) {
        console.error(`Batch update failed at chunk ${i}:`, error.message);
      } else {
        totalUpdated += batch.length;
      }
    }

    // Batch insert tracking history
    const historyEntries = orderIds.map((orderId: string) => ({
      order_id: orderId,
      status,
      changed_by: user.displayName || user.username,
      notes: notes || `Status updated to ${status}`,
    }));

    for (let i = 0; i < historyEntries.length; i += BATCH_SIZE) {
      const batch = historyEntries.slice(i, i + BATCH_SIZE);
      await getSupabaseAdmin().from('tracking_history').insert(batch);
    }

    return NextResponse.json({
      success: true,
      updated: totalUpdated,
      total: orderIds.length,
    });
  } catch {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}

// DELETE - delete individual order OR all orders
export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized — admin only' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { orderId, deleteAll } = body;

    // ── DELETE ALL ORDERS ──
    if (deleteAll === true) {
      await getSupabaseAdmin().from('email_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await getSupabaseAdmin().from('tracking_history').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await getSupabaseAdmin().from('order_items').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      const { error } = await getSupabaseAdmin().from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, deleted: 'all' });
    }

    // ── DELETE SINGLE ORDER ──
    if (!orderId) {
      return NextResponse.json({ error: 'orderId required' }, { status: 400 });
    }

    await getSupabaseAdmin().from('order_items').delete().eq('order_id', orderId);
    await getSupabaseAdmin().from('tracking_history').delete().eq('order_id', orderId);
    await getSupabaseAdmin().from('email_logs').delete().eq('order_id', orderId);
    const { error } = await getSupabaseAdmin().from('orders').delete().eq('order_id', orderId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, deleted: orderId });
  } catch {
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}

