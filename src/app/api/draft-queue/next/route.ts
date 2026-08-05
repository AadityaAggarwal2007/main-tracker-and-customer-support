import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { generateTrackingEmail } from '@/lib/email-templates';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/draft-queue/next?limit=5&key=SECRET
// Called by Google Apps Script every minute.
// Returns the next N pending orders as ready-to-send email payloads.
// Atomically marks them as 'processing' so no two triggers race.

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || '';
const QUEUE_SECRET = process.env.DRAFT_QUEUE_SECRET || '';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key') || '';
  const limit = Math.min(parseInt(searchParams.get('limit') || '5', 10), 20);

  if (!QUEUE_SECRET || key !== QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 1. Fetch next N pending rows (oldest first)
    const rowsResult = await query<{ id: string; order_id: string; email_status: string }>(
      `SELECT id, order_id, email_status
       FROM draft_queue
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit]
    );

    const rows = rowsResult.rows;
    if (rows.length === 0) {
      return NextResponse.json({ emails: [], count: 0, message: 'Queue empty' });
    }

    // 2. Mark them as 'processing' atomically
    const ids = rows.map(r => r.id);
    await query(
      `UPDATE draft_queue SET status = 'processing' WHERE id = ANY($1::uuid[])`,
      [ids]
    );

    // 3. Fetch full order data with items and business via JOIN
    const orderIds = rows.map(r => r.order_id);

    interface OrderRow {
      order_id: string; customer_name: string; customer_email: string;
      tracking_id: string; courier_partner: string; tracking_token: string;
      estimated_delivery: string; order_total: number; city: string; business_id: string;
      order_items: { product_name: string }[];
      biz_name: string; biz_logo_url: string;
      biz_support_email: string; biz_support_phone: string;
    }

    const ordersResult = await query<OrderRow>(
      `SELECT
         o.order_id, o.customer_name, o.customer_email, o.tracking_id,
         o.courier_partner, o.tracking_token, o.estimated_delivery,
         o.order_total, o.city, o.business_id,
         COALESCE(
           json_agg(json_build_object('product_name', oi.product_name))
           FILTER (WHERE oi.id IS NOT NULL), '[]'::json
         ) AS order_items,
         b.name AS biz_name, b.logo_url AS biz_logo_url,
         b.support_email AS biz_support_email, b.support_phone AS biz_support_phone
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.order_id
       LEFT JOIN businesses b ON b.id = o.business_id
       WHERE o.order_id = ANY($1::text[])
       GROUP BY o.id, b.id`,
      [orderIds]
    );

    const orders = ordersResult.rows;
    if (orders.length === 0) {
      await query(
        `UPDATE draft_queue
         SET status = 'failed', updated_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      return NextResponse.json({ emails: [], count: 0, message: 'Orders not found' });
    }

    // 4. Build map of order_id → queue row id
    const queueIdMap = new Map(rows.map(r => [r.order_id, { queueId: r.id, emailStatus: r.email_status }]));

    // 5. Render email HTML for each order
    const emails = orders.map(order => {
      const meta = queueIdMap.get(order.order_id);
      if (!meta) return null;

      if (!order.customer_email || !order.customer_email.includes('@')) {
        return { queueId: meta.queueId, skip: true, reason: 'no_email' };
      }

      const items = order.order_items || [];
      const logoUrl = order.biz_logo_url && order.biz_logo_url.includes('drive.google.com')
        ? order.biz_logo_url.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1')
        : order.biz_logo_url;

      const result = generateTrackingEmail(
        {
          customerName: order.customer_name,
          orderId: order.order_id,
          productNames: items.map(i => i.product_name).filter(Boolean),
          trackingId: order.tracking_id || '',
          courierPartner: order.courier_partner || '',
          trackingUrl: `${BASE_URL}/track/${order.tracking_token}`,
          businessName: order.biz_name || 'ShipTrack',
          businessLogoUrl: logoUrl || undefined,
          supportEmail: order.biz_support_email || '',
          supportPhone: order.biz_support_phone || '',
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
      count: emails.filter(e => e && !e.skip).length,
    });
  } catch (err) {
    console.error('Draft queue next error:', err);
    const detail = err ? JSON.stringify(err, Object.getOwnPropertyNames(err as object)) : 'Unknown error';
    return NextResponse.json({ error: 'Failed to fetch queue', detail }, { status: 500 });
  }
}
