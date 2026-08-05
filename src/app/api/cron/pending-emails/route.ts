import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { generateTrackingEmail } from '@/lib/email-templates';

export const dynamic = 'force-dynamic';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || '';
const QUEUE_SECRET = process.env.DRAFT_QUEUE_SECRET || '';

// GET: Returns orders that need emails sent (no successful email_log entry)
// Called by Linux cron every minute
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') || '';
  if (!QUEUE_SECRET || key !== QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '5', 10), 20);

    // Single query: find orders from last 7 days that have NO successful email log
    const result = await query<Record<string, unknown>>(
      `SELECT
         o.order_id, o.customer_name, o.customer_email, o.tracking_id,
         o.courier_partner, o.tracking_token, o.estimated_delivery,
         o.order_total, o.city, o.tracking_status, o.business_id, o.created_at,
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
         AND o.created_at >= NOW() - INTERVAL '7 days'
         AND NOT EXISTS (
           SELECT 1 FROM email_logs el
           WHERE el.order_id = o.order_id AND el.success = true
         )
       GROUP BY o.id
       ORDER BY o.created_at ASC
       LIMIT $1`,
      [limit]
    );

    const unsent = result.rows;
    if (unsent.length === 0) {
      return NextResponse.json({ emails: [], count: 0 });
    }

    // Get default business for branding
    const biz = await queryOne<{
      name: string; logo_url: string; support_email: string; support_phone: string;
    }>(
      `SELECT name, logo_url, support_email, support_phone
       FROM businesses WHERE is_default = true LIMIT 1`
    );

    const bizName = biz?.name || 'ShipTrack';
    let logoUrl = biz?.logo_url || '';
    if (logoUrl && logoUrl.includes('drive.google.com')) {
      logoUrl = logoUrl.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1');
    }

    // Generate email HTML for each unsent order
    const emails = unsent.map(order => {
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

      if (!emailResult) return null;

      return {
        orderId: order.order_id,
        to: order.customer_email,
        subject: emailResult.subject,
        html: emailResult.html,
      };
    }).filter(Boolean);

    return NextResponse.json({ emails, count: emails.length });
  } catch (err) {
    console.error('Pending emails error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

// POST: Mark emails as sent (called by Apps Script after sending)
export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') || '';
  if (!QUEUE_SECRET || key !== QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { results } = await request.json();

    if (!results || !Array.isArray(results)) {
      return NextResponse.json({ error: 'Invalid results' }, { status: 400 });
    }

    // Batch insert all email logs in one query
    if (results.length > 0) {
      const valuePlaceholders = results.map(
        (_: unknown, i: number) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`
      ).join(', ');

      const params: unknown[] = [];
      results.forEach((r: { orderId: string; to: string; success: boolean; error?: string }) => {
        params.push(r.orderId, 'Order Placed', r.to, r.success, r.error || '');
      });

      await query(
        `INSERT INTO email_logs (order_id, status, recipient_email, success, error_message) VALUES ${valuePlaceholders}`,
        params
      );
    }

    return NextResponse.json({ success: true, logged: results.length });
  } catch (err) {
    console.error('Log emails error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
