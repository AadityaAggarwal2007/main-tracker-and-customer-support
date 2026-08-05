import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';

// GET - public tracking by token or orderId+phone
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token   = searchParams.get('token');
  const orderId = searchParams.get('orderId');
  const phone   = searchParams.get('phone');

  // Always fetch the default business — this is what customers see
  let business = await queryOne(
    `SELECT name, logo_url, support_email, support_phone
     FROM businesses
     WHERE is_default = true
     LIMIT 1`
  );

  // Fallback: first business if no default set
  if (!business) {
    business = await queryOne(
      `SELECT name, logo_url, support_email, support_phone
       FROM businesses
       ORDER BY created_at ASC
       LIMIT 1`
    );
  }

  if (token) {
    // ── Token-based tracking ──────────────────────────────────
    const order = await queryOne<Record<string, unknown>>(
      `SELECT
         o.order_id, o.customer_name, o.tracking_status, o.tracking_id,
         o.courier_partner, o.status_updated_at, o.estimated_delivery,
         o.order_total, o.payment_method, o.is_cancelled, o.city,
         o.state, o.pincode, o.created_at, o.business_id,
         COALESCE(
           json_agg(
             json_build_object('id', oi.id, 'product_name', oi.product_name,
               'brand', oi.brand, 'quantity', oi.quantity, 'price', oi.price)
           ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
         ) AS order_items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.tracking_token = $1
       GROUP BY o.id`,
      [token]
    );

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const history = await query(
      `SELECT status, created_at, notes
       FROM tracking_history
       WHERE order_id = $1
       ORDER BY created_at ASC`,
      [order.order_id]
    );

    return NextResponse.json({ order, business, history: history.rows });
  }

  if (orderId && phone) {
    // ── Order ID + phone last 4 digits ────────────────────────
    const normalizedPhone = phone.replace(/\D/g, '').slice(-4);

    const order = await queryOne<Record<string, unknown>>(
      `SELECT
         o.order_id, o.customer_name, o.tracking_status, o.tracking_id,
         o.courier_partner, o.status_updated_at, o.estimated_delivery,
         o.order_total, o.payment_method, o.is_cancelled, o.city,
         o.state, o.pincode, o.created_at, o.customer_mobile, o.business_id,
         COALESCE(
           json_agg(
             json_build_object('id', oi.id, 'product_name', oi.product_name,
               'brand', oi.brand, 'quantity', oi.quantity, 'price', oi.price)
           ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
         ) AS order_items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.order_id = $1
       GROUP BY o.id`,
      [orderId]
    );

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Verify phone (last 4 digits)
    const orderPhoneLast4 = String(order.customer_mobile || '').slice(-4);
    if (normalizedPhone !== orderPhoneLast4) {
      return NextResponse.json({ error: 'Phone number does not match' }, { status: 403 });
    }

    // Strip customer_mobile from response
    const { customer_mobile, ...safeOrder } = order;
    void customer_mobile;

    const history = await query(
      `SELECT status, created_at, notes
       FROM tracking_history
       WHERE order_id = $1
       ORDER BY created_at ASC`,
      [order.order_id]
    );

    return NextResponse.json({ order: safeOrder, business, history: history.rows });
  }

  return NextResponse.json({ error: 'Provide token or orderId+phone' }, { status: 400 });
}
