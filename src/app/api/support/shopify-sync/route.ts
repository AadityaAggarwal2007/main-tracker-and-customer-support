import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// ═══════════════════════════════════════════════════════════════════════════
// Shopify Inbox Sync — uses the internal inbox.shopify.com GraphQL API
// Authentication: session cookie + CSRF token (extracted from browser)
// Stored as: SHOPIFY_INBOX_COOKIE + SHOPIFY_INBOX_CSRF_TOKEN in .env.local
// ═══════════════════════════════════════════════════════════════════════════

const INBOX_API = 'https://inbox.shopify.com/admin/api/messaging/unstable/graphql';

// Exact query format that Shopify Inbox web app uses
const GQL_GET_CONVERSATIONS = `
  query GetOpenConversations($limit: Int!, $after: String, $filter: ConversationFilterInput) {
    conversations(
      first: $limit
      after: $after
      filter: $filter
      sort: {att: LAST_MESSAGE_SENT_AT, dir: DESC}
    ) {
      nodes {
        id
        done
        preamble
        source
        lastMessageSentAt
        createdAt
        channelBuyers {
          nodes {
            id
            name
            ... on CustomerChannelBuyer {
              customerId
            }
          }
        }
        lastMessage {
          id
          sentAt
          content {
            __typename
            ... on TextMessageContent { text }
            ... on EventMessageContent { text }
            ... on AttachmentMessageContent { mimeType url }
          }
          sender {
            id
            name
            ... on CustomerChannelBuyer { customerId isOnline }
            ... on InboxStaffMember { staffMemberId avatarEnabled }
          }
        }
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

async function inboxFetch(
  shopDomain: string,   // e.g. 'rzqjxj-qq' (no .myshopify.com)
  cookie: string,
  csrfToken: string,
  variables: Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const res = await fetch(`${INBOX_API}?operation=GetOpenConversations`, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'accept-language': 'en',
      'client-name': 'inbox-client-web',
      'client-version': '8.57.7',
      'content-type': 'application/json; charset=utf-8',
      'cookie': cookie,
      'origin': 'https://inbox.shopify.com',
      'x-csrf-token': csrfToken,
      'x-shopify-shop-domain': shopDomain,
    },
    body: JSON.stringify({
      operationName: 'GetOpenConversations',
      variables,
      query: GQL_GET_CONVERSATIONS,
    }),
    cache: 'no-store',
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Inbox ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Look up customer email from Admin API using Shopify customer GID
async function lookupCustomer(
  shopDomain: string,
  adminToken: string,
  customerGid: string
): Promise<{ email: string; name: string }> {
  if (!customerGid) return { email: '', name: '' };
  const numericId = customerGid.split('/').pop() || customerGid.replace(/\D/g, '');
  if (!numericId) return { email: '', name: '' };
  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/2024-07/customers/${numericId}.json`,
      { headers: { 'X-Shopify-Access-Token': adminToken }, cache: 'no-store' }
    );
    if (!res.ok) return { email: '', name: '' };
    const { customer } = await res.json();
    return {
      email: customer?.email || '',
      name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || customer?.email || '',
    };
  } catch { return { email: '', name: '' }; }
}

// ── Exported for reply route use ────────────────────────────────────────────
export async function shopifyRESTPost(
  domain: string,
  token: string,
  path: string,
  body: Record<string, unknown>
) {
  const url = `https://${domain}/admin/api/2024-07${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
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
    return NextResponse.json({ error: 'Shopify not connected for this panel.' }, { status: 400 });
  }

  const { shopify_domain: domain, shopify_api_token: adminToken } = biz;
  const inboxCookie = process.env.SHOPIFY_INBOX_COOKIE || '';
  const inboxCsrf   = process.env.SHOPIFY_INBOX_CSRF_TOKEN || '';
  // Strip .myshopify.com — inbox API wants just the subdomain
  const shopSubdomain = domain.replace('.myshopify.com', '');

  if (!inboxCookie || !inboxCsrf) {
    return NextResponse.json({
      error: 'Shopify Inbox session not configured. Add SHOPIFY_INBOX_COOKIE and SHOPIFY_INBOX_CSRF_TOKEN to /var/www/tracker/.env.local on VPS.',
    }, { status: 400 });
  }

  let imported = 0;
  let updated  = 0;
  let skipped  = 0;
  const errors: string[] = [];
  const debug:  string[] = [];

  try {
    // ── Fetch ALL conversations (open + closed) ────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allConversations: any[] = [];

    for (const done of [false, true]) {
      let cursor: string | null = null;
      let hasMore = true;
      let page = 0;

      while (hasMore && page < 20) {
        page++;
        const vars: Record<string, unknown> = {
          limit: 50,
          filter: { done: { eq: done } },
        };
        if (cursor) vars.after = cursor;

        try {
          const result = await inboxFetch(shopSubdomain, inboxCookie, inboxCsrf, vars);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const convData: any = result?.data?.conversations;

          if (!convData) {
            debug.push(`No data (done=${done} p${page}): ${JSON.stringify(result).slice(0, 200)}`);
            break;
          }

          const nodes = convData.nodes || [];
          allConversations.push(...nodes);
          hasMore = convData.pageInfo?.hasNextPage || false;
          cursor  = convData.pageInfo?.endCursor  || null;
          debug.push(`done=${done} p${page}: ${nodes.length} conversations`);
          if (!cursor) break;
        } catch (e) {
          errors.push(`Fetch (done=${done} p${page}): ${String(e)}`);
          break;
        }
      }
    }

    debug.push(`Total fetched: ${allConversations.length}`);

    // ── Import each conversation as a support ticket ───────────────────────
    for (const conv of allConversations) {
      try {
        const convId = String(conv.id);

        // Customer info from channelBuyers
        const buyer      = conv.channelBuyers?.nodes?.[0];
        let customerName = buyer?.name || 'Unknown';
        let customerEmail = '';

        if (buyer?.customerId) {
          const info = await lookupCustomer(domain, adminToken, buyer.customerId);
          if (info.email) customerEmail = info.email;
          if (info.name)  customerName  = info.name;
        }

        // Extract message text
        const lastMsg  = conv.lastMessage;
        const lastText: string =
          lastMsg?.content?.text  ||
          conv.preamble           ||
          '';
        const subject = lastText.slice(0, 120) || customerName || 'Shopify Inbox';

        // ── Dedup by conversation GID ──────────────────────────────────────
        const existing = await queryOne<{ id: string }>(
          `SELECT id FROM support_tickets WHERE source_ref = $1 AND business_id = $2`,
          [convId, businessId]
        );

        let ticketId: string;

        if (existing) {
          ticketId = existing.id;
          await query(
            `UPDATE support_tickets
               SET last_message_at = $1, updated_at = NOW(), status = $2
             WHERE id = $3`,
            [
              conv.lastMessageSentAt ? new Date(conv.lastMessageSentAt) : new Date(),
              conv.done ? 'resolved' : 'open',
              ticketId,
            ]
          );
          updated++;
        } else {
          const orderMatch = lastText.match(/#(\d{3,8})/);
          const newTicket  = await queryOne<{ id: string }>(
            `INSERT INTO support_tickets
               (business_id, source, source_ref, status, subject,
                customer_email, customer_name, order_id, last_message_at)
             VALUES ($1,'shopify',$2,$3,$4,$5,$6,$7,$8)
             RETURNING id`,
            [
              businessId, convId,
              conv.done ? 'resolved' : 'open',
              subject, customerEmail, customerName,
              orderMatch ? `#${orderMatch[1]}` : null,
              conv.lastMessageSentAt ? new Date(conv.lastMessageSentAt) : new Date(),
            ]
          );
          if (!newTicket) { skipped++; continue; }
          ticketId = newTicket.id;
          imported++;
        }

        // ── Import last message ────────────────────────────────────────────
        if (lastText && lastMsg?.id) {
          const msgId = String(lastMsg.id);
          const alreadyHave = await queryOne<{ id: string }>(
            `SELECT id FROM ticket_messages WHERE raw_email_id = $1`, [msgId]
          );
          if (!alreadyHave) {
            const isStaff  = !!(lastMsg.sender?.staffMemberId);
            const direction = isStaff ? 'outbound' : 'inbound';
            const sentBy    = isStaff
              ? (lastMsg.sender?.name || 'merchant')
              : (customerName || 'customer');

            await query(
              `INSERT INTO ticket_messages
                 (ticket_id, direction, body, sent_by, raw_email_id, created_at)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [
                ticketId, direction,
                lastText.slice(0, 10000), sentBy, msgId,
                lastMsg.sentAt ? new Date(lastMsg.sentAt) : new Date(),
              ]
            );
          }
        }
      } catch (convErr) {
        errors.push(`Conv ${conv.id}: ${String(convErr)}`);
      }
    }

    return NextResponse.json({
      success: true, imported, updated, skipped, debug,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('Shopify Inbox sync error:', err);
    return NextResponse.json({ error: String(err), debug }, { status: 500 });
  }
}
