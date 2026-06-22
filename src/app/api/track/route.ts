import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

// GET - public tracking by token or orderId+phone
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const orderId = searchParams.get('orderId');
  const phone = searchParams.get('phone');

  // Always fetch the default business (set in Settings) — this is what customers should see
  const { data: defaultBiz } = await getSupabaseAdmin()
    .from('businesses')
    .select('name, logo_url, support_email, support_phone')
    .eq('is_default', true)
    .single();

  // Fallback: grab the first business if no default is set
  let business = defaultBiz;
  if (!business) {
    const { data: firstBiz } = await getSupabaseAdmin()
      .from('businesses')
      .select('name, logo_url, support_email, support_phone')
      .limit(1)
      .single();
    business = firstBiz;
  }

  if (token) {
    // Token-based tracking
    const { data: order, error } = await getSupabaseAdmin()
      .from('orders')
      .select(`
        order_id, customer_name, tracking_status, tracking_id, courier_partner,
        status_updated_at, estimated_delivery, order_total, payment_method,
        is_cancelled, city, state, pincode, created_at, business_id,
        order_items(*)
      `)
      .eq('tracking_token', token)
      .single();

    if (error || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // History
    const { data: history } = await getSupabaseAdmin()
      .from('tracking_history')
      .select('status, created_at, notes')
      .eq('order_id', order.order_id)
      .order('created_at', { ascending: true });

    return NextResponse.json({ order, business, history: history || [] });
  }

  if (orderId && phone) {
    const normalizedPhone = phone.replace(/\D/g, '').slice(-4);

    const { data: order, error } = await getSupabaseAdmin()
      .from('orders')
      .select(`
        order_id, customer_name, tracking_status, tracking_id, courier_partner,
        status_updated_at, estimated_delivery, order_total, payment_method,
        is_cancelled, city, state, pincode, created_at, customer_mobile, business_id,
        order_items(*)
      `)
      .eq('order_id', orderId)
      .single();

    if (error || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Verify phone
    const orderPhoneLast4 = order.customer_mobile.slice(-4);
    if (normalizedPhone !== orderPhoneLast4) {
      return NextResponse.json({ error: 'Phone number does not match' }, { status: 403 });
    }

    // Strip customer_mobile from response
    const { customer_mobile, ...safeOrder } = order as Record<string, unknown>;

    const { data: history } = await getSupabaseAdmin()
      .from('tracking_history')
      .select('status, created_at, notes')
      .eq('order_id', order.order_id)
      .order('created_at', { ascending: true });

    return NextResponse.json({ order: safeOrder, business, history: history || [] });
  }

  return NextResponse.json({ error: 'Provide token or orderId+phone' }, { status: 400 });
}
