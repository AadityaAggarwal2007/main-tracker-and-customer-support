import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';
import { sendEmailDirect } from '@/lib/smtp-client';
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

    // Fetch orders with business info in one query using JOIN
    interface OrderRow {
      order_id: string; customer_name: string; customer_email: string;
      tracking_id: string; courier_partner: string; tracking_token: string;
      estimated_delivery: string; order_total: number; city: string;
      business_id: string;
      order_items: { product_name: string }[];
      biz_name: string; biz_logo_url: string;
      biz_support_email: string; biz_support_phone: string;
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
           b.support_email AS biz_support_email, b.support_phone AS biz_support_phone
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

    // Build email payloads
    const emails = withEmail
      .map(order => {
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
          status
        );

        if (!result) return null;
        return { to: order.customer_email, subject: result.subject, html: result.html };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    if (emails.length === 0) {
      const hasEmailCount = withEmail.length;
      const templateExists = ['Order Placed', 'Processing', 'Packed', 'Shipped', 'In Transit', 'Out for Delivery', 'Delivered'].includes(status);
      return NextResponse.json({
        sent: 0, failed: 0,
        noEmail: noEmail.length, noEmailOrders: noEmail,
        message: 'No emails to send',
        debug: { totalOrders: allOrders.length, ordersWithEmail: hasEmailCount, ordersWithoutEmail: noEmail.length, templateExists, statusRequested: status, gmailConfigured: !!process.env.GMAIL_USER },
      });
    }

    // Send emails via SMTP
    const result = await sendEmailDirect(emails);

    // Log to email_logs table (batch insert)
    if (withEmail.length > 0) {
      const colCount = 5;
      const placeholders = withEmail.map(
        (_, j) => `(${Array.from({ length: colCount }, (_, k) => `$${j * colCount + k + 1}`).join(', ')})`
      ).join(', ');
      const logParams: unknown[] = [];
      withEmail.forEach((order, i) => {
        logParams.push(
          order.order_id, status, order.customer_email,
          i < result.sent,
          i >= result.sent ? (result.errors[i - result.sent] || '') : ''
        );
      });
      await query(
        `INSERT INTO email_logs (order_id, status, recipient_email, success, error_message) VALUES ${placeholders}`,
        logParams
      );
    }

    return NextResponse.json({
      sent: result.sent, failed: result.failed,
      noEmail: noEmail.length, noEmailOrders: noEmail,
      errors: result.errors, skipped: skipped.length,
      message: `${result.sent} emails sent, ${result.failed} failed, ${skipped.length} already sent, ${noEmail.length} have no email`,
      debug: { scriptConfigured: !!process.env.GMAIL_USER, baseUrl: BASE_URL || 'NOT SET' },
    });
  } catch (err) {
    console.error('Send email error:', err);
    return NextResponse.json({ error: 'Email sending failed' }, { status: 500 });
  }
}

// GET: Fetch daily email stats
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM email_logs
       WHERE sent_at >= $1 AND success = true`,
      [today.toISOString()]
    );

    return NextResponse.json({ sentToday: parseInt(result.rows[0]?.count ?? '0', 10) });
  } catch {
    return NextResponse.json({ sentToday: 0 });
  }
}
