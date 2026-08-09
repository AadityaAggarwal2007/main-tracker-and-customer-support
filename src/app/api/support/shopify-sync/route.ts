import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// POST /api/support/shopify-sync
// Syncs ALL Shopify Inbox conversations via GraphQL Admin API
// ✅ Safe to re-run — dedupes by Shopify GID

const API_VER = '2024-07';

async function shopifyGraphQL(
  domain: string,
  token: string,
  q: string,
  vars: Record<string, unknown> = {}
) {
  const res = await fetch(`https://${domain}/admin/api/${API_VER}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: vars }),
    cache: 'no-store',
  });
  return res.json();
}

export async function shopifyRESTPost(
  domain: string,
  token: string,
  path: string,
  body: Record<string, unknown>
) {
  const url = `https://${domain}/admin/api/${API_VER}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify POST ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const GQL_CONVERSATIONS = `
  query GetConversations($first: Int!, $after: String) {
    conversations(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        unreadCount
        customer { email firstName lastName phone }
        lastMessage { body sentAt direction }
        messages(first: 100) {
          nodes {
            id body direction sentAt
            author {
              ... on Customer { email firstName lastName }
              ... on StaffMember { name email }
            }
          }
        }
      }
    }
  }
`;

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { businessId } = await request.json();
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  const biz = await queryOne<{
    shopify_domain: string; shopify_api_token: string; name: string;
  }>(
    `SELECT shopify_domain, shopify_api_token, name FROM businesses WHERE id = $1`,
    [businessId]
  );

  if (!biz?.shopify_domain || !biz?.shopify_api_token) {
    return NextResponse.json(
      { error: 'Shopify not connected. Go to Settings → Connect Shopify first.' },
      { status: 400 }
    );
  }

  const { shopify_domain: domain, shopify_api_token: token } = biz;

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];
  const debug: string[] = [];

  try {
    // ── Step 1: Verify token ─────────────────────────────────────────────
    const shopCheck = await shopifyGraphQL(domain, token, `{ shop { name } }`);
    debug.push(`Token OK: shop=${shopCheck?.data?.shop?.name || 'null'}`);
    if (shopCheck?.errors?.length) {
      debug.push(`Token errors: ${JSON.stringify(shopCheck.errors)}`);
    }

    // ── Step 2: Paginate conversations via GraphQL ───────────────────────
    let hasNextPage = true;
    let cursor: string | null = null;
    let pageCount = 0;

    while (hasNextPage && pageCount < 20) {
      pageCount++;
      const vars: Record<string, unknown> = { first: 50 };
      if (cursor) vars.after = cursor;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let gqlResult: any;
      try {
        gqlResult = await shopifyGraphQL(domain, token, GQL_CONVERSATIONS, vars);
      } catch (e) {
        errors.push(`GQL fetch error: ${String(e)}`);
        break;
      }

      // Return raw response on first page for diagnostics
      if (pageCount === 1) {
        debug.push(`GQL page 1 raw: ${JSON.stringify(gqlResult).slice(0, 800)}`);
      }

      if (gqlResult?.errors?.length) {
        errors.push(`GQL errors: ${JSON.stringify(gqlResult.errors).slice(0, 600)}`);
        break;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const convData: any = gqlResult?.data?.conversations;
      if (!convData) {
        debug.push('conversations=null — token may lack required scope. Add read_customers + read_assigned_fulfillment_orders to Aaditya app and re-install.');
        break;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conversations: any[] = convData.nodes || [];
      hasNextPage = convData.pageInfo?.hasNextPage || false;
      cursor = convData.pageInfo?.endCursor || null;
      debug.push(`Page ${pageCount}: ${conversations.length} conversations`);

      for (const conv of conversations) {
        try {
          const convId = String(conv.id);
          const customer = conv.customer || {};
          const customerEmail = customer.email || '';
          const customerName = [customer.firstName, customer.lastName]
            .filter(Boolean).join(' ') || customerEmail || 'Unknown';
          const lastMsgBody: string = conv.lastMessage?.body || '';
          const subject = lastMsgBody.slice(0, 120) || customerName || 'Shopify Inbox';

          // Dedup by Shopify GID
          const existing = await queryOne<{ id: string }>(
            `SELECT id FROM support_tickets WHERE source_ref = $1 AND business_id = $2`,
            [convId, businessId]
          );

          let ticketId: string;

          if (existing) {
            ticketId = existing.id;
            await query(
              `UPDATE support_tickets SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
              [ticketId]
            );
            updated++;
          } else {
            const orderMatch = lastMsgBody.match(/#(\d{3,8})/);
            const detectedOrderId = orderMatch ? `#${orderMatch[1]}` : null;
            const newTicket = await queryOne<{ id: string }>(
              `INSERT INTO support_tickets
                 (business_id, source, source_ref, status, subject,
                  customer_email, customer_name, order_id, last_message_at)
               VALUES ($1, 'shopify', $2, 'open', $3, $4, $5, $6, NOW())
               RETURNING id`,
              [businessId, convId, subject, customerEmail, customerName, detectedOrderId]
            );
            if (!newTicket) { skipped++; continue; }
            ticketId = newTicket.id;
            imported++;
          }

          // Import all messages in the thread
          const messages = conv.messages?.nodes || [];
          for (const msg of messages) {
            if (!msg?.body) continue;
            const msgId = String(msg.id);

            const existingMsg = await queryOne<{ id: string }>(
              `SELECT id FROM ticket_messages WHERE raw_email_id = $1`, [msgId]
            );
            if (existingMsg) continue;

            const direction = msg.direction === 'MERCHANT_TO_CUSTOMER' ? 'outbound' : 'inbound';
            const sentBy = direction === 'outbound'
              ? (msg.author?.name || msg.author?.email || 'merchant')
              : (customerName || 'customer');

            await query(
              `INSERT INTO ticket_messages
                 (ticket_id, direction, body, sent_by, raw_email_id, created_at)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [ticketId, direction, String(msg.body).slice(0, 10000), sentBy, msgId,
               msg.sentAt ? new Date(String(msg.sentAt)) : new Date()]
            );
          }
        } catch (convErr) {
          errors.push(`Conv ${conv.id}: ${String(convErr)}`);
        }
      }

      if (!cursor) break;
    }

    return NextResponse.json({
      success: true,
      imported,
      updated,
      skipped,
      debug,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('Shopify sync error:', err);
    return NextResponse.json({ error: String(err), debug }, { status: 500 });
  }
}
