import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { generateTrackingEmail } from '@/lib/email-templates';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || '';

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { orderIds, status } = body;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return NextResponse.json({ error: 'No order IDs provided' }, { status: 400 });
    }

    if (!status) {
      return NextResponse.json({ error: 'No status provided' }, { status: 400 });
    }

    // Fetch orders with business info
    interface OrderRow {
      order_id: string; customer_name: string; customer_email: string;
      tracking_id: string; courier_partner: string; tracking_token: string;
      estimated_delivery: string; order_total: number; city: string;
      business_id: string;
      order_items: { product_name: string }[];
      biz_name: string; biz_logo_url: string;
      biz_support_email: string; biz_support_phone: string;
      biz_tracking_domain: string | null;
      biz_primary_color: string | null;
    }

    const allOrders: OrderRow[] = [];
    for (let i = 0; i < orderIds.length; i += 100) {
      const batch = orderIds.slice(i, i + 100);
      const result = await query<OrderRow>(
        `SELECT
           o.order_id, o.customer_name, o.customer_email, o.tracking_id,
           o.courier_partner, o.tracking_token, o.estimated_delivery,
           o.order_total, o.city, o.business_id,
           COALESCE(
             json_agg(json_build_object('product_name', oi.product_name))
             FILTER (WHERE oi.id IS NOT NULL), '[]'::json
           ) AS order_items,
           b.name AS biz_name, b.logo_url AS biz_logo_url,
           b.support_email AS biz_support_email, b.support_phone AS biz_support_phone,
           b.tracking_domain AS biz_tracking_domain,
           b.primary_color AS biz_primary_color
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.order_id
         LEFT JOIN businesses b ON b.id = o.business_id
         WHERE o.order_id = ANY($1::text[])
         GROUP BY o.id, b.id`,
        [batch]
      );
      allOrders.push(...result.rows);
    }

    if (allOrders.length === 0) {
      return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
    }

    // Check which orders already received email for this status (dedup)
    const alreadySent = new Set<string>();
    for (let i = 0; i < orderIds.length; i += 100) {
      const batch = orderIds.slice(i, i + 100);
      const result = await query<{ order_id: string }>(
        `SELECT order_id FROM email_logs
         WHERE order_id = ANY($1::text[]) AND status = $2 AND success = true`,
        [batch, status]
      );
      result.rows.forEach(l => alreadySent.add(l.order_id));
    }

    const withEmail: OrderRow[] = [];
    const noEmail: string[] = [];
    const skipped: string[] = [];

    for (const order of allOrders) {
      if (alreadySent.has(order.order_id)) {
        skipped.push(order.order_id);
      } else if (order.customer_email && order.customer_email.includes('@')) {
        withEmail.push(order);
      } else {
        noEmail.push(order.order_id);
      }
    }

    // Build email payloads and add to queue (sent 1/min by cron)
    const emailRows: { orderId: string; to: string; subject: string; html: string; fromName: string }[] = [];

    for (const order of withEmail) {
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
          trackingUrl: `${order.biz_tracking_domain || BASE_URL}/track/${order.tracking_token}`,
          businessName: order.biz_name || 'ShipTrack',
          businessLogoUrl: logoUrl || undefined,
          primaryColor: order.biz_primary_color || undefined,
          supportEmail: order.biz_support_email || '',
          supportPhone: order.biz_support_phone || '',
          estimatedDelivery: order.estimated_delivery || undefined,
          orderTotal: order.order_total || 0,
          city: order.city || '',
        },
        status
      );
      if (!result) continue;
      emailRows.push({
        orderId: order.order_id,
        to: order.customer_email,
        subject: result.subject,
        html: result.html,
        fromName: order.biz_name || 'ShipTrack',
      });
    }

    if (emailRows.length === 0) {
      return NextResponse.json({
        queued: 0, noEmail: noEmail.length, skipped: skipped.length,
        message: 'No emails to queue',
      });
    }

    // Batch-insert into email_queue (1/min cron picks them up)
    const colCount = 6;
    const placeholders = emailRows.map(
      (_, j) => `(${Array.from({ length: colCount }, (_, k) => `$${j * colCount + k + 1}`).join(', ')})`
    ).join(', ');
    const queueParams: unknown[] = [];
    emailRows.forEach(r => {
      queueParams.push(r.orderId, status, r.to, r.subject, r.html, r.fromName);
    });
    await query(
      `INSERT INTO email_queue (order_id, status_stage, to_email, subject, html, from_name)
       VALUES ${placeholders}
       ON CONFLICT DO NOTHING`,
      queueParams
    );

    // Queue stats
    const pendingCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM email_queue WHERE state = 'pending'`
    );
    const totalPending = parseInt(pendingCount?.count || '0');
    const hoursLeft = Math.ceil(totalPending / 60);

    return NextResponse.json({
      queued: emailRows.length,
      noEmail: noEmail.length,
      skipped: skipped.length,
      totalPending,
      estimatedHours: hoursLeft,
      message: `${emailRows.length} emails queued. Sending 1/min — all done in ~${hoursLeft} hours.`,
    });
  } catch (err) {
    console.error('Send email error:', err);
    return NextResponse.json({ error: 'Email sending failed' }, { status: 500 });
  }
}

// GET: Fetch daily email stats + queue status
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [sentResult, queueResult] = await Promise.all([
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM email_logs WHERE sent_at >= $1 AND success = true`,
        [today.toISOString()]
      ),
      queryOne<{ pending: string; sent: string; failed: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE state = 'pending') as pending,
           COUNT(*) FILTER (WHERE state = 'sent')    as sent,
           COUNT(*) FILTER (WHERE state = 'failed')  as failed
         FROM email_queue`
      ),
    ]);

    return NextResponse.json({
      sentToday: parseInt(sentResult.rows[0]?.count ?? '0', 10),
      queue: {
        pending: parseInt(queueResult?.pending || '0'),
        sent: parseInt(queueResult?.sent || '0'),
        failed: parseInt(queueResult?.failed || '0'),
      },
    });
  } catch {
    return NextResponse.json({ sentToday: 0, queue: { pending: 0, sent: 0, failed: 0 } });
  }
}
