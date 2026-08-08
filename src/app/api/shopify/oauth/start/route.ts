import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest, verifyToken } from '@/lib/auth';
import crypto from 'crypto';

// GET /api/shopify/oauth/start?shop=mystore.myshopify.com&businessId=uuid&token=xxx
// Starts the Shopify OAuth flow — redirects to Shopify authorization page
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const queryToken = searchParams.get('token') || '';

  // Accept token from query param (browser link navigation) OR Authorization header
  let user = getAuthFromRequest(request);
  if (!user && queryToken) {
    user = verifyToken(queryToken);
  }

  if (!user || user.role !== 'admin') {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/login`);
  }

  let shop = searchParams.get('shop') || '';
  const businessId = searchParams.get('businessId') || '';


  if (!shop) {
    return NextResponse.json({ error: 'shop parameter required (e.g. mystore.myshopify.com)' }, { status: 400 });
  }

  // Normalize — accept ANY Shopify URL format:
  // https://admin.shopify.com/store/rzqjxj-qq  → rzqjxj-qq.myshopify.com
  // https://roopvastra.myshopify.com           → roopvastra.myshopify.com
  // roopvastra.myshopify.com                   → roopvastra.myshopify.com
  // roopvastra                                 → roopvastra.myshopify.com
  shop = shop.trim();
  const adminUrlMatch = shop.match(/admin\.shopify\.com\/store\/([^/?]+)/);
  if (adminUrlMatch) {
    shop = `${adminUrlMatch[1]}.myshopify.com`;
  } else {
    shop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!shop.includes('.myshopify.com')) {
      shop = `${shop}.myshopify.com`;
    }
  }


  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'SHOPIFY_CLIENT_ID not set in .env' }, { status: 500 });
  }

  // State encodes businessId + nonce for CSRF protection
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = Buffer.from(JSON.stringify({ businessId, nonce })).toString('base64');

  const scopes = 'read_orders,read_products,read_content';
  const redirectUri = `${process.env.NEXT_PUBLIC_BASE_URL}/api/shopify/oauth/callback`;

  const authUrl = `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    redirect_uri: redirectUri,
    state,
    'grant_options[]': 'per-user',
  }).toString();

  return NextResponse.redirect(authUrl);
}
