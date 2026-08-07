import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';

// GET /api/shopify/oauth/callback?code=xxx&shop=xxx&state=xxx&hmac=xxx
// Called by Shopify after merchant approves — exchanges code for token,
// fetches shop info (name, logo), registers webhook, saves to DB
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code   = searchParams.get('code')  || '';
  const shop   = searchParams.get('shop')  || '';
  const state  = searchParams.get('state') || '';
  const hmac   = searchParams.get('hmac')  || '';

  const adminUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/admin`;

  // ── 1. Verify HMAC ───────────────────────────────────────────────
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
  const params = new URLSearchParams(request.url.split('?')[1] || '');
  params.delete('hmac');
  params.sort();
  const message = params.toString();
  const expectedHmac = require('crypto')
    .createHmac('sha256', clientSecret)
    .update(message)
    .digest('hex');

  if (hmac !== expectedHmac) {
    console.error('Shopify OAuth: HMAC mismatch');
    return NextResponse.redirect(`${adminUrl}?error=invalid_hmac`);
  }

  // ── 2. Decode state to get businessId ────────────────────────────
  let businessId = '';
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    businessId = decoded.businessId || '';
  } catch {
    return NextResponse.redirect(`${adminUrl}?error=invalid_state`);
  }

  // ── 3. Exchange code for permanent access token ──────────────────
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(`${adminUrl}?error=token_exchange_failed`);
  }

  const { access_token: accessToken } = await tokenRes.json();

  // ── 4. Fetch shop info (name, email, logo) ───────────────────────
  const shopRes = await fetch(`https://${shop}/admin/api/2024-01/shop.json`, {
    headers: { 'X-Shopify-Access-Token': accessToken },
  });

  let shopName  = shop.replace('.myshopify.com', '');
  let shopEmail = '';
  let logoUrl   = '';

  if (shopRes.ok) {
    const { shop: shopData } = await shopRes.json();
    shopName  = shopData.name  || shopName;
    shopEmail = shopData.email || '';

    // Try to get the shop logo from branding assets
    // Fallback 1: Try shop's Google favicon (reliable)
    logoUrl = `https://logo.clearbit.com/${shopData.domain || shop}`;
  }

  // ── 5. Register orders/create webhook ───────────────────────────
  const webhookAddress = `${process.env.NEXT_PUBLIC_BASE_URL}/api/shopify/webhook${businessId ? `?b=${businessId}` : ''}`;

  // Delete any existing webhook first
  const existingBiz = businessId ? await queryOne<{
    shopify_webhook_id: string | null;
  }>(`SELECT shopify_webhook_id FROM businesses WHERE id = $1`, [businessId]) : null;

  if (existingBiz?.shopify_webhook_id) {
    await fetch(`https://${shop}/admin/api/2024-01/webhooks/${existingBiz.shopify_webhook_id}.json`, {
      method: 'DELETE',
      headers: { 'X-Shopify-Access-Token': accessToken },
    }).catch(() => {});
  }

  let webhookId = '';
  const webhookRes = await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({
      webhook: { topic: 'orders/create', address: webhookAddress, format: 'json' },
    }),
  });

  if (webhookRes.ok) {
    const wData = await webhookRes.json();
    webhookId = wData.webhook?.id?.toString() || '';
  }

  // ── 6. Save or create business record ───────────────────────────
  const domain = shop.replace('.myshopify.com', '');
  const normalizedShop = shop;

  if (businessId) {
    // Update existing panel
    await query(
      `UPDATE businesses SET
         name = COALESCE(NULLIF($1, ''), name),
         logo_url = COALESCE(NULLIF($2, ''), logo_url),
         support_email = COALESCE(NULLIF($3, ''), support_email),
         shopify_domain = $4,
         shopify_api_token = $5,
         shopify_webhook_id = $6,
         is_shopify_connected = true
       WHERE id = $7`,
      [shopName, logoUrl, shopEmail, normalizedShop, accessToken, webhookId, businessId]
    );
  } else {
    // Create new panel automatically
    await query(
      `INSERT INTO businesses (name, logo_url, support_email, shopify_domain, shopify_api_token, shopify_webhook_id, is_shopify_connected)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (shopify_domain) DO UPDATE SET
         shopify_api_token = EXCLUDED.shopify_api_token,
         shopify_webhook_id = EXCLUDED.shopify_webhook_id,
         is_shopify_connected = true`,
      [shopName, logoUrl, shopEmail, normalizedShop, accessToken, webhookId]
    );
  }

  // ── 7. Redirect back to admin settings with success ─────────────
  return NextResponse.redirect(`${adminUrl}?shopify_connected=${encodeURIComponent(shopName)}`);
}
