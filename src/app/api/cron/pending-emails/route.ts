import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { sendEmailDirect } from '@/lib/smtp-client';
import { generateTrackingEmail } from '@/lib/email-templates';

export const dynamic = 'force-dynamic';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || '';
const QUEUE_SECRET = process.env.DRAFT_QUEUE_SECRET || '';

// ═══════════════════════════════════════════════════════════════
// GET /api/cron/pending-emails?key=SECRET
// Called by Linux cron every minute.
// Picks the OLDEST unsent order, sends 1 email via SMTP, logs result.
// Result: 1 email/minute regardless of queue size.
// ═══════════════════════════════════════════════════════════════
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') || '';
  if (!QUEUE_SECRET || key !== QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Pick 1 oldest order that has a valid email and no successful send yet
    const order = await queryOne<Record<string, unknown>>(
      `SELECT
         o.order_id, o.customer_name, o.customer_email, o.tracking_id,
         o.courier_partner, o.tracking_token, o.estimated_delivery,
         o.order_total, o.city, o.tracking_status, o.business_id,
         COALESCE(
           json_agg(
             json_build_object('product_name', oi.product_name)
           ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
         ) AS order_items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.customer_email IS NOT NULL
         AND o.customer_email != ''
         AND o.customer_email LIKE '%@%'
         AND o.is_cancelled = false
         AND NOT EXISTS (
           SELECT 1 FROM email_logs el
           WHERE el.order_id = o.order_id AND el.success = true
         )
       GROUP BY o.id
       ORDER BY o.created_at ASC
       LIMIT 1`
    );

    if (!order) {
      return NextResponse.json({ sent: 0, message: 'No pending emails' });
    }

    // Get branding for THIS order's panel — fall back to default only if no business_id
    const biz = await queryOne<{
      name: string; logo_url: string; support_email: string; support_phone: string;
    }>(
      order.business_id
        ? `SELECT name, logo_url, support_email, support_phone
           FROM businesses WHERE id = $1 LIMIT 1`
        : `SELECT name, logo_url, support_email, support_phone
           FROM businesses WHERE is_default = true LIMIT 1`,
      order.business_id ? [order.business_id] : []
    );

    const bizName = biz?.name || 'ShipTrack';
    let logoUrl = biz?.logo_url || '';
    if (logoUrl && logoUrl.includes('drive.google.com')) {
      logoUrl = logoUrl.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1');
    }

    const items = (order.order_items || []) as { product_name: string }[];

    const emailResult = generateTrackingEmail(
      {
        customerName: order.customer_name as string,
        orderId: order.order_id as string,
        productNames: items.map(i => i.product_name).filter(Boolean),
        trackingId: (order.tracking_id as string) || '',
        courierPartner: (order.courier_partner as string) || '',
        trackingUrl: `${BASE_URL}/track/${order.tracking_token}`,
        businessName: bizName,
        businessLogoUrl: logoUrl || undefined,
        supportEmail: biz?.support_email || '',
        supportPhone: biz?.support_phone || '',
        estimatedDelivery: (order.estimated_delivery as string) || undefined,
        orderTotal: (order.order_total as number) || 0,
        city: (order.city as string) || '',
      },
      'Order Placed'
    );

    if (!emailResult) {
      // Log as failed so it doesn't block the queue
      await query(
        `INSERT INTO email_logs (order_id, status, recipient_email, success, error_message)
         VALUES ($1, $2, $3, $4, $5)`,
        [order.order_id, 'Order Placed', order.customer_email, false, 'Email template generation failed']
      );
      return NextResponse.json({ sent: 0, error: 'Template generation failed', orderId: order.order_id });
    }

    // Send via SMTP
    const sendResult = await sendEmailDirect([
      { to: order.customer_email as string, subject: emailResult.subject, html: emailResult.html },
    ]);

    // Log result
    await query(
      `INSERT INTO email_logs (order_id, status, recipient_email, success, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        order.order_id, 'Order Placed', order.customer_email,
        sendResult.sent > 0,
        sendResult.errors[0] || '',
      ]
    );

    return NextResponse.json({
      sent: sendResult.sent,
      orderId: order.order_id,
      to: order.customer_email,
      success: sendResult.sent > 0,
      error: sendResult.errors[0] || null,
    });

  } catch (err) {
    console.error('Pending emails cron error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

// POST: Legacy endpoint — kept for backward compatibility, returns queue stats
export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') || '';
  if (!QUEUE_SECRET || key !== QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM orders
       WHERE customer_email LIKE '%@%'
         AND is_cancelled = false
         AND NOT EXISTS (
           SELECT 1 FROM email_logs el WHERE el.order_id = orders.order_id AND el.success = true
         )`
    );
    const pending = parseInt(result.rows[0]?.count || '0', 10);
    return NextResponse.json({ pending, message: 'Use GET to process queue' });
  } catch (err) {
    console.error('Pending emails POST error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
