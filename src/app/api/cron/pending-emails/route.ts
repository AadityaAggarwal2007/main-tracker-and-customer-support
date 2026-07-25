import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { generateTrackingEmail } from '@/lib/email-templates';

export const dynamic = 'force-dynamic';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || '';
const QUEUE_SECRET = process.env.DRAFT_QUEUE_SECRET || '';

// GET: Returns orders that need emails sent (no successful email_log entry)
// Called by Apps Script every minute
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') || '';
  if (!QUEUE_SECRET || key !== QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '5', 10), 20);

    // Find orders that were created in last 7 days and have NO successful email log
    const { data: orders, error } = await getSupabaseAdmin()
      .from('orders')
      .select(`
        order_id, customer_name, customer_email, tracking_id, courier_partner,
        tracking_token, estimated_delivery, order_total, city, tracking_status,
        business_id, created_at,
        order_items (product_name)
      `)
      .not('customer_email', 'is', null)
      .neq('customer_email', '')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: true })
      .limit(100); // fetch more to filter

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!orders || orders.length === 0) {
      return NextResponse.json({ emails: [], count: 0 });
    }

    // Check which orders already have successful emails
    const orderIds = orders.map(o => o.order_id);
    const { data: sentLogs } = await getSupabaseAdmin()
      .from('email_logs')
      .select('order_id')
      .in('order_id', orderIds)
      .eq('success', true);

    const sentSet = new Set((sentLogs || []).map(l => l.order_id));

    // Filter to only unsent orders
    const unsent = orders.filter(o =>
      !sentSet.has(o.order_id) &&
      o.customer_email &&
      o.customer_email.includes('@')
    ).slice(0, limit);

    if (unsent.length === 0) {
      return NextResponse.json({ emails: [], count: 0 });
    }

    // Get default business for branding
    const { data: biz } = await getSupabaseAdmin()
      .from('businesses')
      .select('name, logo_url, support_email, support_phone')
      .eq('is_default', true)
      .maybeSingle();

    const bizName = biz?.name || 'ShipTrack';
    let logoUrl = biz?.logo_url || '';
    if (logoUrl && logoUrl.includes('drive.google.com')) {
      logoUrl = logoUrl.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1');
    }

    // Generate email HTML for each unsent order
    const emails = unsent.map(order => {
      const items = (order.order_items || []) as { product_name: string }[];
      const result = generateTrackingEmail(
        {
          customerName: order.customer_name,
          orderId: order.order_id,
          productNames: items.map(i => i.product_name).filter(Boolean),
          trackingId: order.tracking_id || '',
          courierPartner: order.courier_partner || '',
          trackingUrl: `${BASE_URL}/track/${order.tracking_token}`,
          businessName: bizName,
          businessLogoUrl: logoUrl || undefined,
          supportEmail: biz?.support_email || '',
          supportPhone: biz?.support_phone || '',
          estimatedDelivery: order.estimated_delivery || undefined,
          orderTotal: order.order_total || 0,
          city: order.city || '',
        },
        'Order Placed'
      );

      if (!result) return null;

      return {
        orderId: order.order_id,
        to: order.customer_email,
        subject: result.subject,
        html: result.html,
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

    for (const r of results) {
      await getSupabaseAdmin().from('email_logs').insert({
        order_id: r.orderId,
        status: 'Order Placed',
        recipient_email: r.to,
        success: r.success,
        error_message: r.error || '',
      });
    }

    return NextResponse.json({ success: true, logged: results.length });
  } catch (err) {
    console.error('Log emails error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
