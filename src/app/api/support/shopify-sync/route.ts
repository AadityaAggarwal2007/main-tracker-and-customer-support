import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// POST /api/support/shopify-sync
// Fetches open conversations from Shopify Inbox (Admin API)
// and imports them as support tickets

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { businessId } = await request.json();
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  // Get Shopify credentials
  const biz = await queryOne<{
    shopify_domain: string; shopify_api_token: string;
    name: string; is_shopify_connected: boolean;
  }>(
    `SELECT shopify_domain, shopify_api_token, name, is_shopify_connected
     FROM businesses WHERE id = $1`,
    [businessId]
  );

  if (!biz?.shopify_domain || !biz?.shopify_api_token) {
    return NextResponse.json(
      { error: 'Shopify not connected for this panel. Go to Settings → Connect Shopify first.' },
      { status: 400 }
    );
  }

  const { shopify_domain: domain, shopify_api_token: token } = biz;
  const apiVersion = '2024-04';

  let imported = 0;
  let errors: string[] = [];

  try {
    // ── Fetch conversations from Shopify Inbox ──────────────────────
    // Shopify Inbox uses the conversations endpoint
    const convUrl = `https://${domain}/admin/api/${apiVersion}/conversations.json?status=open&limit=50`;
    const convRes = await fetch(convUrl, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });

    if (!convRes.ok) {
      // Fallback: try customer requests endpoint
      const fallbackUrl = `https://${domain}/admin/api/${apiVersion}/customer_requests.json?limit=50`;
      const fallbackRes = await fetch(fallbackUrl, {
        headers: { 'X-Shopify-Access-Token': token },
      });

      if (!fallbackRes.ok) {
        const errText = await convRes.text();
        return NextResponse.json({
          error: `Shopify API returned ${convRes.status}. You may need to add the 'read_customer_requests' scope to your API token.`,
          detail: errText,
        }, { status: 400 });
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convData: any = await convRes.json();
    const conversations = convData.conversations || convData.customer_requests || [];

    for (const conv of conversations) {
      try {
        const shopifyConvId = String(conv.id);
        const customerEmail = conv.customer?.email || conv.email || '';
        const customerName = conv.customer
          ? `${conv.customer.first_name || ''} ${conv.customer.last_name || ''}`.trim()
          : conv.name || customerEmail;
        const subject = conv.subject || conv.body?.slice(0, 80) || 'Shopify Inbox message';

        // Detect order ID
        const bodyText = conv.body || conv.message || '';
        const orderMatch = bodyText.match(/#?([A-Z]{0,4}[-]?\d{3,8})/i);
        const detectedOrderId = orderMatch?.[1] || null;

        // Dedup by shopify conversation ID stored as source_ref
        const existing = await queryOne<{ id: string }>(
          `SELECT id FROM support_tickets
           WHERE source = 'shopify' AND customer_email = $1 AND business_id = $2
           AND subject = $3`,
          [customerEmail, businessId, subject]
        );

        let ticketId: string;
        if (existing) {
          ticketId = existing.id;
          await query(
            `UPDATE support_tickets SET last_message_at = NOW(), status = 'open', updated_at = NOW() WHERE id = $1`,
            [ticketId]
          );
        } else {
          const newTicket = await queryOne<{ id: string }>(
            `INSERT INTO support_tickets (business_id, source, status, subject, customer_email, customer_name, order_id)
             VALUES ($1, 'shopify', 'open', $2, $3, $4, $5)
             RETURNING id`,
            [businessId, subject, customerEmail, customerName || 'Unknown', detectedOrderId]
          );
          if (!newTicket) continue;
          ticketId = newTicket.id;
          imported++;
        }

        // Fetch messages for this conversation
        let messages: { direction: string; body: string; author: string; created_at: string }[] = [];

        // Try to get messages from the conversation
        if (conv.messages && Array.isArray(conv.messages)) {
          messages = conv.messages.map((m: { body?: string; author?: string; sent_at?: string }) => ({
            direction: 'inbound',
            body: m.body || '',
            author: m.author || 'customer',
            created_at: m.sent_at || new Date().toISOString(),
          }));
        } else if (conv.body) {
          messages = [{ direction: 'inbound', body: conv.body, author: customerEmail, created_at: conv.created_at || new Date().toISOString() }];
        }

        for (const msg of messages) {
          if (!msg.body) continue;
          // Dedup by content
          const existingMsg = await queryOne<{ id: string }>(
            `SELECT id FROM ticket_messages WHERE ticket_id = $1 AND LEFT(body, 100) = $2`,
            [ticketId, msg.body.slice(0, 100)]
          );
          if (!existingMsg) {
            await query(
              `INSERT INTO ticket_messages (ticket_id, direction, body, sent_by)
               VALUES ($1, 'inbound', $2, 'customer')`,
              [ticketId, msg.body.slice(0, 10000)]
            );
          }
        }
      } catch (convErr) {
        errors.push(`Conv ${conv.id}: ${String(convErr)}`);
      }
    }

    return NextResponse.json({
      success: true,
      imported,
      total: conversations.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('Shopify sync error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
