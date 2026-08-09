import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { sendEmailDirect } from '@/lib/smtp-client';
import { generateTrackingEmail } from '@/lib/email-templates';
import crypto from 'crypto';

// ═══════════════════════════════════════════════
// Shopify Webhook: Order Creation
// ═══════════════════════════════════════════════
// When a customer places an order on Shopify,
// this endpoint automatically:
//   1. Creates the order in PostgreSQL
//   2. Sends a tracking email via Gmail SMTP (direct)
//   3. Logs the email in email_logs for dedup
// ═══════════════════════════════════════════════

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || '';


function generateTrackingId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'ST';
  for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function generateTrackingToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

function normalizePhone(phone: string): string {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  cleaned = cleaned.replace(/^0+/, '');
  // Only strip 91 if remaining is exactly 10 digits
  if (cleaned.startsWith('91') && cleaned.length > 10) {
    const stripped = cleaned.slice(2);
    if (stripped.length === 10) cleaned = stripped;
  }
  return cleaned.slice(-10);
}

function verifyShopifyWebhook(rawBody: string, hmacHeader: string, secret: string): boolean {
  // If no secret configured, skip verification (development only)
  if (!secret) return true;
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// ── Helper: send tracking email and log it ──────────────────────
async function sendAndLogEmail(
  orderId: string, customerEmail: string, customerName: string,
  trackingId: string, trackingToken: string, orderTotal: number,
  city: string, lineItems: { product_name: string }[],
  businessId?: string
) {
  // Get business branding (by id if known, else default)
  const biz = await queryOne<{
    name: string; logo_url: string; support_email: string; support_phone: string; tracking_domain: string | null;
  }>(
    businessId
      ? `SELECT name, logo_url, support_email, support_phone, tracking_domain FROM businesses WHERE id = $1 LIMIT 1`
      : `SELECT name, logo_url, support_email, support_phone, tracking_domain FROM businesses WHERE is_default = true LIMIT 1`,
    businessId ? [businessId] : []
  );

  let bizName = biz?.name || 'ShipTrack';
  let logoUrl = biz?.logo_url || '';
  if (logoUrl && logoUrl.includes('drive.google.com')) {
    logoUrl = logoUrl.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1');
  }
  const trackingBase = biz?.tracking_domain || BASE_URL;

  const emailResult = generateTrackingEmail(
    {
      customerName,
      orderId,
      productNames: lineItems.map(i => i.product_name).filter(Boolean),
      trackingId,
      courierPartner: '',
      trackingUrl: `${trackingBase}/track/${trackingToken}`,
      businessName: bizName,
      businessLogoUrl: logoUrl || undefined,
      supportEmail: biz?.support_email || '',
      supportPhone: biz?.support_phone || '',
      estimatedDelivery: undefined,
      orderTotal,
      city,
    },
    'Order Placed'
  );

  if (emailResult) {
    const sendResult = await sendEmailDirect([
      { to: customerEmail, subject: emailResult.subject, html: emailResult.html },
    ]);

    await query(
      `INSERT INTO email_logs (order_id, status, recipient_email, success, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, 'Order Placed', customerEmail, sendResult.sent > 0, sendResult.errors[0] || '']
    );

    return sendResult.sent > 0;
  }
  return false;
}

export async function POST(request: NextRequest) {
  // 1. Read raw body for HMAC verification
  const rawBody = await request.text();
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256') || '';

  // 2. Get business_id from query param (?b=uuid)
  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('b') || '';

  // 3. Look up per-business HMAC secret
  let webhookSecret = '';
  if (businessId) {
    const biz = await queryOne<{ shopify_webhook_secret: string | null }>(
      `SELECT shopify_webhook_secret FROM businesses WHERE id = $1 LIMIT 1`,
      [businessId]
    );
    webhookSecret = biz?.shopify_webhook_secret || '';
  }

  // 4. Verify HMAC signature
  if (!verifyShopifyWebhook(rawBody, hmacHeader, webhookSecret)) {
    console.error('Shopify webhook: Invalid HMAC signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  try {
    // 3. Parse the Shopify order payload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shopifyOrder: any = JSON.parse(rawBody);

    const orderId = shopifyOrder.name || `#${shopifyOrder.order_number}`;
    const shopifyId = String(shopifyOrder.id || '');

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

    // Capture which Shopify store this order came from
    const sourceStore = request.headers.get('x-shopify-shop-domain') || shopifyOrder.domain || 'unknown';

    // 8. Resolve business_id — prefer ?b= param, fall back to shop domain
    const shopDomain = request.headers.get('x-shopify-shop-domain') || shopifyOrder.domain || '';
    let resolvedBusinessId: string | null = businessId || null;

    if (!resolvedBusinessId && shopDomain) {
      const bizByDomain = await queryOne<{ id: string }>(
        `SELECT id FROM businesses WHERE shopify_domain = $1 LIMIT 1`,
        [shopDomain]
      );
      resolvedBusinessId = bizByDomain?.id || null;
      if (resolvedBusinessId) {
        console.log(`Webhook: resolved business ${resolvedBusinessId} via shop domain ${shopDomain}`);
      }
    }

    if (!resolvedBusinessId) {
      console.warn(`Webhook ignored: no ?b= and no matching shop domain (${shopDomain}). Register webhook with ?b=YOUR_PANEL_ID`);
      return NextResponse.json({ skipped: true, reason: 'no panel ID' });
    }



    // 9. Check if order already exists (dedup by order_id + source_store)
    const existing = await queryOne<{ order_id: string }>(
      `SELECT order_id FROM orders WHERE order_id = $1 AND source_store = $2`,
      [orderId, sourceStore]
    );

    const trackingId = generateTrackingId();
    const trackingToken = generateTrackingToken();

    if (existing) {
      // ── Update existing order ──────────────────────────────
      const updateParams: unknown[] = [
        shopifyId, paymentMethod, financialStatus, customerName, customerEmail,
        customerMobile, address1, address2, city, state, pincode, orderTotal,
        isCancelled, sourceStore,
      ];
      const updateSets = [
        'shopify_id = $1', 'payment_method = $2', 'financial_status = $3',
        'customer_name = $4', 'customer_email = $5', 'customer_mobile = $6',
        'address_line1 = $7', 'address_line2 = $8', 'city = $9', 'state = $10',
        'pincode = $11', 'order_total = $12', 'is_cancelled = $13', 'source_store = $14',
      ];
      if (businessId) {
        // COALESCE: only set panel if order doesn't already have one
        updateSets.push(`business_id = COALESCE(business_id, $${updateParams.length + 1})`);
        updateParams.push(businessId);
      }
      updateParams.push(orderId, sourceStore);
      await query(
        `UPDATE orders SET ${updateSets.join(', ')}
         WHERE order_id = $${updateParams.length - 1} AND source_store = $${updateParams.length}`,
        updateParams
      );

      // Replace items
      await query(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);
      if (lineItems.length > 0) {
        const colCount = 5;
        const placeholders = lineItems.map(
          (_: unknown, j: number) => `(${Array.from({ length: colCount }, (_, k) => `$${j * colCount + k + 1}`).join(', ')})`
        ).join(', ');
        const params: unknown[] = [];
        lineItems.forEach((item: { brand: string; product_name: string; quantity: number; price: number }) => {
          params.push(orderId, item.brand, item.product_name, item.quantity, item.price);
        });
        await query(
          `INSERT INTO order_items (order_id, brand, product_name, quantity, price) VALUES ${placeholders}`,
          params
        );
      }

      // Send email if not already sent
      if (customerEmail && customerEmail.includes('@') && !isCancelled) {
        try {
          const existingLog = await queryOne(
            `SELECT id FROM email_logs WHERE order_id = $1 AND success = true LIMIT 1`,
            [orderId]
          );

          if (!existingLog) {
            const existingOrder = await queryOne<{
              tracking_id: string; tracking_token: string; order_total: number;
              city: string; customer_name: string;
            }>(
              `SELECT tracking_id, tracking_token, order_total, city, customer_name
               FROM orders WHERE order_id = $1`,
              [orderId]
            );

            if (existingOrder) {
              await sendAndLogEmail(
                orderId, customerEmail,
                existingOrder.customer_name || customerName,
                existingOrder.tracking_id || '',
                existingOrder.tracking_token || '',
                existingOrder.order_total || orderTotal,
                existingOrder.city || city,
                lineItems,
                businessId || undefined  // ← pass panel so email uses correct branding
              );
            }
          }
        } catch (emailErr) {
          console.error('Webhook update: Email send failed:', emailErr);
        }
      }

      return NextResponse.json({ success: true, action: 'updated', orderId });
    }

    // 10. Insert new order
    const insertResult = await query(
      `INSERT INTO orders (
         order_id, shopify_id, payment_method, financial_status,
         customer_name, customer_email, customer_mobile,
         address_line1, address_line2, city, state, pincode,
         order_total, is_cancelled, tracking_status,
         tracking_id, tracking_token, status_updated_at, source_store
         ${businessId ? ', business_id' : ''}
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18${businessId ? ',$19' : ''})`,
      [
        orderId, shopifyId, paymentMethod, financialStatus,
        customerName, customerEmail, customerMobile,
        address1, address2, city, state, pincode,
        orderTotal, isCancelled, isCancelled ? 'Cancelled' : 'Order Placed',
        trackingId, trackingToken, sourceStore,
        ...(businessId ? [businessId] : []),
      ]
    );

    if ((insertResult.rowCount ?? 0) === 0) {
      console.error('Shopify webhook: Failed to insert order');
      return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }

    // 11. Insert line items
    if (lineItems.length > 0) {
      const colCount = 5;
      const placeholders = lineItems.map(
        (_: unknown, j: number) => `(${Array.from({ length: colCount }, (_, k) => `$${j * colCount + k + 1}`).join(', ')})`
      ).join(', ');
      const params: unknown[] = [];
      lineItems.forEach((item: { brand: string; product_name: string; quantity: number; price: number }) => {
        params.push(orderId, item.brand, item.product_name, item.quantity, item.price);
      });
      await query(
        `INSERT INTO order_items (order_id, brand, product_name, quantity, price) VALUES ${placeholders}`,
        params
      );
    }

    // 12. Tracking history
    await query(
      `INSERT INTO tracking_history (order_id, status, changed_by, notes)
       VALUES ($1, $2, 'shopify-webhook', 'Auto-imported from Shopify')`,
      [orderId, isCancelled ? 'Cancelled' : 'Order Placed']
    );

    // 13. Send email immediately
    let emailSent = false;
    if (customerEmail && customerEmail.includes('@') && !isCancelled) {
      try {
        emailSent = await sendAndLogEmail(
          orderId, customerEmail, customerName,
          trackingId, trackingToken, orderTotal, city, lineItems,
          businessId || undefined  // ← pass panel so email uses correct branding
        );
      } catch (emailErr) {
        console.error('Shopify webhook: Email send failed (order still created):', emailErr);
      }
    }

    return NextResponse.json({
      success: true, action: 'created', orderId,
      ...(emailSent !== undefined ? { emailSent } : {}),
    });
  } catch (err) {
    console.error('Shopify webhook error:', err);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

// Shopify sends a GET to verify the endpoint exists
export async function GET() {
  return NextResponse.json({ status: 'ok', endpoint: 'shopify-webhook' });
}
