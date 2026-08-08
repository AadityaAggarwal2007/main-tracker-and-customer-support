import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// POST /api/support/shopify-sync?businessId=xxx
// Fetches Shopify Inbox conversations via GraphQL Admin API
// and imports them as support tickets.
// ✅ Safe to run multiple times — dedupes by Shopify conversation GID (source_ref)
// ✅ Never deletes or overwrites existing ticket data
// ✅ Paginates through ALL conversations automatically

const GRAPHQL_CONVERSATIONS = `
  query GetConversations($first: Int!, $after: String) {
    conversations(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        unreadCount
        customer {
          email
          firstName
          lastName
          phone
        }
        lastMessage {
          body
          sentAt
          direction
        }
        messages(first: 100) {
          nodes {
            id
            body
            direction
            sentAt
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

async function shopifyGraphQL(
  domain: string,
  token: string,
  query: string,
  variables: Record<string, unknown> = {}
) {
  const res = await fetch(
    `https://${domain}/admin/api/2024-04/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { businessId } = await request.json();
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  // ── Get Shopify credentials ────────────────────────────────────────
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
    // ── Paginate through ALL conversations ─────────────────────────
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const variables: Record<string, unknown> = { first: 50 };
      if (cursor) variables.after = cursor;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any;
      try {
        const gqlResult = await shopifyGraphQL(domain, token, GRAPHQL_CONVERSATIONS, variables);
        data = gqlResult?.data?.conversations;
        if (gqlResult?.errors?.length) {
          errors.push(`GraphQL errors: ${JSON.stringify(gqlResult.errors).slice(0, 200)}`);
          break;
        }
      } catch (fetchErr) {
        errors.push(`Fetch failed: ${String(fetchErr)}`);
        break;
      }

      if (!data) break;

      const conversations = data.nodes || [];
      hasNextPage = data.pageInfo?.hasNextPage || false;
      cursor = data.pageInfo?.endCursor || null;

      for (const conv of conversations) {
        try {
          const shopifyGid = String(conv.id); // e.g. gid://shopify/Conversation/123456
          const customerEmail = conv.customer?.email || '';
          const customerName = [conv.customer?.firstName, conv.customer?.lastName]
            .filter(Boolean).join(' ') || customerEmail || 'Unknown';
          const lastMsgBody = conv.lastMessage?.body || '';
          const subject = lastMsgBody.slice(0, 100) || 'Shopify Inbox';

          // ── DEDUP: by source_ref (Shopify GID) ─────────────────
          const existing = await queryOne<{ id: string; status: string }>(
            `SELECT id, status FROM support_tickets
             WHERE source_ref = $1 AND business_id = $2`,
            [shopifyGid, businessId]
          );

          let ticketId: string;

          if (existing) {
            ticketId = existing.id;
            // Only update metadata — never touch status or messages user has already handled
            await query(
              `UPDATE support_tickets
               SET last_message_at = NOW(), updated_at = NOW()
               WHERE id = $1`,
              [ticketId]
            );
            updated++;
          } else {
            // Detect order ID from last message
            const orderMatch = lastMsgBody.match(/#(\d{3,8})/);
            const detectedOrderId = orderMatch ? `#${orderMatch[1]}` : null;

            const newTicket = await queryOne<{ id: string }>(
              `INSERT INTO support_tickets
                 (business_id, source, source_ref, status, subject,
                  customer_email, customer_name, order_id, last_message_at)
               VALUES ($1, 'shopify', $2, 'open', $3, $4, $5, $6, NOW())
               RETURNING id`,
              [businessId, shopifyGid, subject, customerEmail, customerName, detectedOrderId]
            );
            if (!newTicket) { skipped++; continue; }
            ticketId = newTicket.id;
            imported++;
          }

          // ── Import messages — dedup by Shopify message GID ─────
          const messages = conv.messages?.nodes || [];
          for (const msg of messages) {
            if (!msg.body) continue;
            const msgGid = String(msg.id);

            // raw_email_id field used for any source's message dedup ID
            const existingMsg = await queryOne<{ id: string }>(
              `SELECT id FROM ticket_messages WHERE raw_email_id = $1`,
              [msgGid]
            );
            if (existingMsg) continue; // already imported — skip

            const direction = msg.direction === 'MERCHANT_TO_CUSTOMER' ? 'outbound' : 'inbound';
            const sentBy = direction === 'outbound'
              ? (msg.author?.name || msg.author?.email || 'merchant')
              : 'customer';

            await query(
              `INSERT INTO ticket_messages
                 (ticket_id, direction, body, sent_by, raw_email_id, created_at)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [ticketId, direction, msg.body.slice(0, 10000), sentBy, msgGid,
               msg.sentAt ? new Date(msg.sentAt) : new Date()]
            );
          }
        } catch (convErr) {
          errors.push(`Conv ${conv.id}: ${String(convErr)}`);
        }
      }

      // Safety: stop if no cursor (malformed response)
      if (!cursor) break;
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
