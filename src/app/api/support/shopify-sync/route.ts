import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// POST /api/support/shopify-sync
// Syncs ALL Shopify Inbox conversations (historical + new) via REST Admin API
// Supports full message thread import and deduplication
// ✅ Safe to re-run — dedupes by Shopify conversation ID

const API_VER = '2024-07';

async function shopifyREST(domain: string, token: string, path: string) {
  const url = path.startsWith('http')
    ? path
    : `https://${domain}/admin/api/${API_VER}${path}`;

  const res = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Shopify ${res.status} @ ${path}: ${text.slice(0, 400)}`);
  }

  // Return both parsed JSON and the Link header for pagination
  return {
    data: JSON.parse(text),
    linkHeader: res.headers.get('link') || '',
  };
}

// Parse Shopify's Link header for cursor-based pagination
function parseNextLink(linkHeader: string): string | null {
  // Format: <https://...?page_info=xxx>; rel="next"
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function shopifyRESTPost(
  domain: string,
  token: string,
  path: string,
  body: Record<string, unknown>
) {
  const url = `https://${domain}/admin/api/${API_VER}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify POST ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

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
      { error: 'Shopify not connected for this panel. Go to Settings → Connect Shopify first.' },
      { status: 400 }
    );
  }

  const { shopify_domain: domain, shopify_api_token: token } = biz;

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    // ── Step 1: Fetch all conversations via REST with pagination ───────
    let nextUrl: string | null = `/conversations.json?limit=250&status=open`;

    while (nextUrl) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let convData: any;
      let linkHeader = '';

      try {
        const result = await shopifyREST(domain, token, nextUrl);
        convData = result.data;
        linkHeader = result.linkHeader;
      } catch (fetchErr) {
        errors.push(`Fetch failed: ${String(fetchErr)}`);
        break;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conversations: any[] = convData?.conversations || [];
      if (conversations.length === 0) break;

      for (const conv of conversations) {
        try {
          const convId = String(conv.id);
          const customer = conv.customer || {};
          const customerEmail = customer.email || '';
          const customerName = [customer.first_name, customer.last_name]
            .filter(Boolean).join(' ') || customerEmail || 'Unknown';

          // Get messages for this conversation
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let messages: any[] = conv.messages?.nodes || conv.messages || [];
          if (messages.length === 0) {
            try {
              const msgResult = await shopifyREST(
                domain, token,
                `/conversations/${convId}/messages.json?limit=250`
              );
              messages = msgResult.data?.messages || [];
            } catch {
              // conversations might not have separate messages endpoint
            }
          }

          const lastMsg = messages[messages.length - 1];
          const lastMsgBody: string = lastMsg?.body || conv.last_message?.body || '';
          const subject = lastMsgBody.slice(0, 120) || customerName || 'Shopify Inbox';

          // ── DEDUP: by Shopify conversation ID ───────────────────────
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

          // ── Import messages — dedup by Shopify message ID ───────────
          for (const msg of messages) {
            if (!msg?.body) continue;
            const msgId = String(msg.id);

            const existingMsg = await queryOne<{ id: string }>(
              `SELECT id FROM ticket_messages WHERE raw_email_id = $1`,
              [msgId]
            );
            if (existingMsg) continue;

            // Shopify Inbox: type is 'customer' or 'merchant' (varies by API version)
            const isCustomer =
              msg.author === 'customer' ||
              msg.type === 'customer_to_merchant' ||
              msg.originator === 'customer';
            const direction = isCustomer ? 'inbound' : 'outbound';
            const sentBy = isCustomer
              ? (customerName || 'customer')
              : (msg.author?.name || msg.author || 'merchant');

            await query(
              `INSERT INTO ticket_messages
                 (ticket_id, direction, body, sent_by, raw_email_id, created_at)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                ticketId, direction,
                String(msg.body).slice(0, 10000),
                String(sentBy),
                msgId,
                msg.created_at ? new Date(String(msg.created_at)) : new Date(),
              ]
            );
          }
        } catch (convErr) {
          errors.push(`Conv ${conv.id}: ${String(convErr)}`);
        }
      }

      // Follow Link header for next page
      nextUrl = parseNextLink(linkHeader);
    }

    return NextResponse.json({
      success: true,
      imported,
      updated,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('Shopify sync error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper exported for use in reply route
// ─────────────────────────────────────────────────────────────────────────────
export { shopifyRESTPost };
