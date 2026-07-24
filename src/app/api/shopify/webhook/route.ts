import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { sendBatchEmails } from '@/lib/gmail-client';
import { generateTrackingEmail } from '@/lib/email-templates';
import crypto from 'crypto';

// ═══════════════════════════════════════════════
// Shopify Webhook: Order Creation
// ═══════════════════════════════════════════════
// When a customer places an order on Shopify,
// this endpoint automatically:
//   1. Creates the order in Supabase
//   2. Sends a tracking email via Gmail (Apps Script)
//   3. Logs the email in email_logs for dedup
// ═══════════════════════════════════════════════

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || '';

// Generate tracking ID: ST + 10 uppercase alphanumeric chars
function generateTrackingId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'ST';
  for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// Generate tracking token: random 32-char hex string
function generateTrackingToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Normalize phone: strip country code, keep last 10 digits
function normalizePhone(phone: string): string {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.length > 10 && cleaned.startsWith('91')) {
    cleaned = cleaned.slice(2);
  }
  return cleaned.slice(-10);
}

// Verify Shopify HMAC-SHA256 signature
function verifyShopifyWebhook(rawBody: string, hmacHeader: string): boolean {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

export async function POST(request: NextRequest) {
  // 1. Read raw body for HMAC verification
  const rawBody = await request.text();
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256') || '';

  // 2. Verify signature
  if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
    console.error('Shopify webhook: Invalid HMAC signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  try {
    // 3. Parse the Shopify order payload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shopifyOrder: any = JSON.parse(rawBody);

    const orderId = shopifyOrder.name || `#${shopifyOrder.order_number}`; // e.g. "#1001"
    const shopifyId = String(shopifyOrder.id || '');

    // Skip test/draft orders
    if (shopifyOrder.test || shopifyOrder.source_name === 'web' && shopifyOrder.confirmed === false) {
      return NextResponse.json({ skipped: true, reason: 'test/draft order' });
    }

    // 4. Extract customer info
    const customer = shopifyOrder.customer || {};
    const shippingAddress = shopifyOrder.shipping_address || shopifyOrder.billing_address || {};

    const customerName =
      `${shippingAddress.first_name || customer.first_name || ''} ${shippingAddress.last_name || customer.last_name || ''}`.trim() ||
      `${customer.first_name || ''} ${customer.last_name || ''}`.trim() ||
      'Unknown';

    const customerEmail = shopifyOrder.email || customer.email || '';
    const customerMobile = normalizePhone(shippingAddress.phone || customer.phone || '');

    // 5. Extract address
    const address1 = shippingAddress.address1 || '';
    const address2 = shippingAddress.address2 || '';
    const city = shippingAddress.city || '';
    const state = shippingAddress.province || '';
    const pincode = shippingAddress.zip || '';

    // 6. Extract line items
    const lineItems = (shopifyOrder.line_items || []).map((item: Record<string, unknown>) => ({
      brand: (item.vendor as string) || '',
      product_name: (item.title as string) || (item.name as string) || '',
      quantity: (item.quantity as number) || 1,
      price: parseFloat(String(item.price || '0')),
    }));

    // 7. Financial info
    const orderTotal = parseFloat(shopifyOrder.total_price || '0');
    const financialStatus = shopifyOrder.financial_status || 'pending';
    const paymentMethod = shopifyOrder.gateway || 'COD';
    const isCancelled = shopifyOrder.cancelled_at ? true : false;

    // 8. Auto-detect brand → create/find business
    const brand = lineItems[0]?.brand || '';
    let businessId: string | null = null;

    if (brand) {
      const { data: existingBiz } = await getSupabaseAdmin()
        .from('businesses')
        .select('id')
        .ilike('name', brand)
        .single();

      if (existingBiz) {
        businessId = existingBiz.id;
      } else {
        const { data: newBiz } = await getSupabaseAdmin()
          .from('businesses')
          .insert({ name: brand })
          .select('id')
          .single();
        if (newBiz) businessId = newBiz.id;
      }
    }

    // 9. Check if order already exists (dedup)
    const { data: existing } = await getSupabaseAdmin()
      .from('orders')
      .select('order_id')
      .eq('order_id', orderId)
      .single();

    const trackingId = generateTrackingId();
    const trackingToken = generateTrackingToken();

    if (existing) {
      // Update existing order
      await getSupabaseAdmin()
        .from('orders')
        .update({
          shopify_id: shopifyId,
          payment_method: paymentMethod,
          financial_status: financialStatus,
          customer_name: customerName,
          customer_email: customerEmail,
          customer_mobile: customerMobile,
          address_line1: address1,
          address_line2: address2,
          city,
          state,
          pincode,
          order_total: orderTotal,
          is_cancelled: isCancelled,
          ...(businessId ? { business_id: businessId } : {}),
        })
        .eq('order_id', orderId);

      // Replace items
      await getSupabaseAdmin().from('order_items').delete().eq('order_id', orderId);
      if (lineItems.length > 0) {
        await getSupabaseAdmin()
          .from('order_items')
          .insert(lineItems.map((item: { brand: string; product_name: string; quantity: number; price: number }) => ({ order_id: orderId, ...item })));
      }

      return NextResponse.json({ success: true, action: 'updated', orderId });
    }

    // 10. Insert new order
    const { error: insertError } = await getSupabaseAdmin()
      .from('orders')
      .insert({
        order_id: orderId,
        shopify_id: shopifyId,
        payment_method: paymentMethod,
        financial_status: financialStatus,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_mobile: customerMobile,
        address_line1: address1,
        address_line2: address2,
        city,
        state,
        pincode,
        order_total: orderTotal,
        is_cancelled: isCancelled,
        tracking_status: isCancelled ? 'Cancelled' : 'Order Placed',
        tracking_id: trackingId,
        tracking_token: trackingToken,
        ...(businessId ? { business_id: businessId } : {}),
      });

    if (insertError) {
      console.error('Shopify webhook: Failed to insert order:', insertError);
      return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }

    // 11. Insert line items
    if (lineItems.length > 0) {
      await getSupabaseAdmin()
        .from('order_items')
        .insert(lineItems.map((item: { brand: string; product_name: string; quantity: number; price: number }) => ({ order_id: orderId, ...item })));
    }

    // 12. Tracking history entry
    await getSupabaseAdmin()
      .from('tracking_history')
      .insert({
        order_id: orderId,
        status: isCancelled ? 'Cancelled' : 'Order Placed',
        changed_by: 'shopify-webhook',
        notes: 'Auto-imported from Shopify',
      });

    // 13. Send email immediately (skip drafts!) — only if customer has email
    if (customerEmail && customerEmail.includes('@') && !isCancelled) {
      try {
        // Fetch brand settings from admin dashboard (default business)
        // This uses the brand configured in Settings, NOT the Shopify vendor name
        let bizName = 'ShipTrack';
        let logoUrl = '';
        let supportEmail = '';
        let supportPhone = '';

        // First try: get the default business (configured in Brand Settings)
        const { data: defaultBiz } = await getSupabaseAdmin()
          .from('businesses')
          .select('name, logo_url, support_email, support_phone')
          .eq('is_default', true)
          .single();

        if (defaultBiz) {
          bizName = defaultBiz.name || bizName;
          logoUrl = defaultBiz.logo_url || '';
          supportEmail = defaultBiz.support_email || '';
          supportPhone = defaultBiz.support_phone || '';
        } else if (businessId) {
          // Fallback: use the matched business
          const { data: biz } = await getSupabaseAdmin()
            .from('businesses')
            .select('name, logo_url, support_email, support_phone')
            .eq('id', businessId)
            .single();
          if (biz) {
            bizName = biz.name || bizName;
            logoUrl = biz.logo_url || '';
            supportEmail = biz.support_email || '';
            supportPhone = biz.support_phone || '';
          }
        }

        // Transform Google Drive URLs
        if (logoUrl && logoUrl.includes('drive.google.com')) {
          logoUrl = logoUrl.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1');
        }

        const emailResult = generateTrackingEmail(
          {
            customerName,
            orderId,
            productNames: lineItems.map((i: { product_name: string }) => i.product_name).filter(Boolean),
            trackingId,
            courierPartner: '',
            trackingUrl: `${BASE_URL}/track/${trackingToken}`,
            businessName: bizName,
            businessLogoUrl: logoUrl || undefined,
            supportEmail,
            supportPhone,
            estimatedDelivery: undefined,
            orderTotal,
            city,
          },
          'Order Placed'
        );

        if (emailResult) {
          const sendResult = await sendBatchEmails([
            { to: customerEmail, subject: emailResult.subject, html: emailResult.html },
          ]);

          // Log the email
          await getSupabaseAdmin().from('email_logs').insert({
            order_id: orderId,
            status: 'Order Placed',
            recipient_email: customerEmail,
            success: sendResult.sent > 0,
            error_message: sendResult.errors[0] || '',
          });

          return NextResponse.json({
            success: true,
            action: 'created',
            orderId,
            emailSent: sendResult.sent > 0,
          });
        }
      } catch (emailErr) {
        console.error('Shopify webhook: Email send failed (order still created):', emailErr);
        // Don't fail the webhook — order is already created
      }
    }

    return NextResponse.json({ success: true, action: 'created', orderId });
  } catch (err) {
    console.error('Shopify webhook error:', err);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

// Shopify sends a GET to verify the endpoint exists
export async function GET() {
  return NextResponse.json({ status: 'ok', endpoint: 'shopify-webhook' });
}
