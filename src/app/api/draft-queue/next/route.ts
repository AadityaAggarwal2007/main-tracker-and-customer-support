import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { generateTrackingEmail } from '@/lib/email-templates';

// GET /api/draft-queue/next?limit=5&key=SECRET
// Called by Google Apps Script every minute.
// Returns the next N pending orders as ready-to-send email payloads.
// Atomically marks them as 'processing' so no two triggers race.

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || '';
const QUEUE_SECRET = process.env.DRAFT_QUEUE_SECRET || '';

export async function GET(request: NextRequest) {
  // Validate secret key
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key') || '';
  const limit = Math.min(parseInt(searchParams.get('limit') || '5', 10), 20);

  if (!QUEUE_SECRET || key !== QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 1. Fetch next N pending rows (oldest first)
    const { data: rows, error } = await getSupabaseAdmin()
      .from('draft_queue')
      .select('id, order_id, email_status')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw error;
    if (!rows || rows.length === 0) {
      return NextResponse.json({ emails: [], count: 0, message: 'Queue empty' });
    }

    // 2. Mark them as 'processing' atomically
    const ids = rows.map((r) => r.id);
    await getSupabaseAdmin()
      .from('draft_queue')
      .update({ status: 'processing' })
      .in('id', ids);

    // 3. Fetch full order data for these order_ids
    const orderIds = rows.map((r) => r.order_id);
    const { data: orders } = await getSupabaseAdmin()
      .from('orders')
      .select(`
        order_id, customer_name, customer_email, tracking_id, courier_partner,
        tracking_token, estimated_delivery, order_total, city,
        business_id, order_items (product_name),
        businesses (name, logo_url, support_email, support_phone)
      `)
      .in('order_id', orderIds);

    if (!orders || orders.length === 0) {
      // No orders found — mark as failed
      await getSupabaseAdmin()
        .from('draft_queue')
        .update({ status: 'failed', error: 'Order not found in DB', processed_at: new Date().toISOString() })
        .in('id', ids);
      return NextResponse.json({ emails: [], count: 0, message: 'Orders not found' });
    }

    // 4. Build a map of order_id → queue row id (so Apps Script can report back)
    const queueIdMap = new Map(rows.map((r) => [r.order_id, { queueId: r.id, emailStatus: r.email_status }]));

    // 5. Render email HTML for each order
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emails = orders.map((order: any) => {
      const meta = queueIdMap.get(order.order_id);
      if (!meta) return null;

      // Skip orders with no email address
      if (!order.customer_email || !order.customer_email.includes('@')) {
        return { queueId: meta.queueId, skip: true, reason: 'no_email' };
      }

      const biz = order.businesses || {};
      const items = order.order_items || [];
      const logoUrl = biz.logo_url && biz.logo_url.includes('drive.google.com')
        ? biz.logo_url.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1')
        : biz.logo_url;

      const result = generateTrackingEmail(
        {
          customerName: order.customer_name,
          orderId: order.order_id,
          productNames: items.map((i: { product_name: string }) => i.product_name).filter(Boolean),
          trackingId: order.tracking_id || '',
          courierPartner: order.courier_partner || '',
          trackingUrl: `${BASE_URL}/track/${order.tracking_token}`,
          businessName: biz.name || 'ShipTrack',
          businessLogoUrl: logoUrl || undefined,
          supportEmail: biz.support_email || '',
          supportPhone: biz.support_phone || '',
          estimatedDelivery: order.estimated_delivery || undefined,
          orderTotal: order.order_total || 0,
          city: order.city || '',
        },
        meta.emailStatus
      );

      if (!result) {
        return { queueId: meta.queueId, skip: true, reason: 'template_not_found' };
      }

      return {
        queueId: meta.queueId,
        orderId: order.order_id,
        to: order.customer_email,
        subject: result.subject,
        html: result.html,
        skip: false,
      };
    }).filter(Boolean);

    return NextResponse.json({
      emails,
      count: emails.filter((e) => e && !e.skip).length,
    });
  } catch (err) {
    console.error('Draft queue next error:', err);
    return NextResponse.json({ error: 'Failed to fetch queue' }, { status: 500 });
  }
}
