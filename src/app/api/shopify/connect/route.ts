import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// POST /api/shopify/connect
// Registers a Shopify webhook for orders/create and saves credentials to the business
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { businessId, shopifyDomain, apiToken } = await request.json();

    if (!businessId || !shopifyDomain || !apiToken) {
      return NextResponse.json({ error: 'businessId, shopifyDomain, apiToken required' }, { status: 400 });
    }

    // Normalize domain (remove https:// if user typed it)
    const domain = shopifyDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Get the app's public URL for the webhook callback
    const appUrl = process.env.NEXT_PUBLIC_BASE_URL || '';
    if (!appUrl) {
      return NextResponse.json({ error: 'NEXT_PUBLIC_BASE_URL not set in .env' }, { status: 500 });
    }

    const webhookAddress = `${appUrl}/api/shopify/webhook?b=${businessId}`;

    // Delete any existing webhook for this business first (cleanup)
    const existingBiz = await queryOne<{ shopify_webhook_id: string | null }>(
      `SELECT shopify_webhook_id FROM businesses WHERE id = $1`,
      [businessId]
    );
    if (existingBiz?.shopify_webhook_id) {
      await fetch(`https://${domain}/admin/api/2024-01/webhooks/${existingBiz.shopify_webhook_id}.json`, {
        method: 'DELETE',
        headers: { 'X-Shopify-Access-Token': apiToken },
      }).catch(() => {}); // ignore errors if already deleted
    }

    // Register new webhook with Shopify
    const shopifyRes = await fetch(`https://${domain}/admin/api/2024-01/webhooks.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': apiToken,
      },
      body: JSON.stringify({
        webhook: {
          topic: 'orders/create',
          address: webhookAddress,
          format: 'json',
        },
      }),
    });

    if (!shopifyRes.ok) {
      const err = await shopifyRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: `Shopify API error: ${JSON.stringify(err)}` },
        { status: 400 }
      );
    }

    const shopifyData = await shopifyRes.json();
    const webhookId = shopifyData.webhook?.id?.toString();
    const webhookSecret = shopifyData.webhook?.api_version || ''; // Shopify doesn't return HMAC secret via API

    // Save credentials to business
    await query(
      `UPDATE businesses SET
         shopify_domain = $1,
         shopify_api_token = $2,
         shopify_webhook_id = $3,
         is_shopify_connected = true
       WHERE id = $4`,
      [domain, apiToken, webhookId, businessId]
    );

    return NextResponse.json({
      success: true,
      webhookId,
      webhookAddress,
      message: `Webhook registered! Orders from ${domain} will now auto-import.`,
    });
  } catch (err) {
    console.error('Shopify connect error:', err);
    return NextResponse.json({ error: 'Failed to connect Shopify store' }, { status: 500 });
  }
}

// DELETE /api/shopify/connect?businessId=xxx
// Disconnects Shopify — deletes webhook from Shopify and clears credentials
export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('businessId');
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  try {
    const biz = await queryOne<{
      shopify_domain: string; shopify_api_token: string; shopify_webhook_id: string;
    }>(`SELECT shopify_domain, shopify_api_token, shopify_webhook_id FROM businesses WHERE id = $1`, [businessId]);

    if (biz?.shopify_webhook_id && biz.shopify_domain && biz.shopify_api_token) {
      await fetch(`https://${biz.shopify_domain}/admin/api/2024-01/webhooks/${biz.shopify_webhook_id}.json`, {
        method: 'DELETE',
        headers: { 'X-Shopify-Access-Token': biz.shopify_api_token },
      }).catch(() => {});
    }

    await query(
      `UPDATE businesses SET
         shopify_domain = NULL, shopify_api_token = NULL,
         shopify_webhook_id = NULL, is_shopify_connected = false
       WHERE id = $1`,
      [businessId]
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Shopify disconnect error:', err);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
