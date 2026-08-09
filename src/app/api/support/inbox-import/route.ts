import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// POST /api/support/inbox-import
// Accepts raw Shopify Inbox conversation data from the browser-side script
// The browser script runs on inbox.shopify.com (already authenticated) and
// ships the data here. No Shopify token needed — just our JWT auth.

interface InboxMessage {
  id: string;
  sentAt: string;
  body: string;
  direction: 'inbound' | 'outbound';
  senderName: string;
}

interface InboxConversation {
  id: string;
  done: boolean;
  subject: string;
  lastMessageSentAt: string;
  customerName: string;
  customerEmail: string;
  customerId?: string;
  lastMessage?: InboxMessage;
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { businessId, conversations } = await request.json() as {
    businessId: string;
    conversations: InboxConversation[];
  };

  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  if (!Array.isArray(conversations) || conversations.length === 0) {
    return NextResponse.json({ error: 'conversations array required' }, { status: 400 });
  }

  let imported = 0;
  let updated  = 0;
  let skipped  = 0;
  const errors: string[] = [];

  for (const conv of conversations) {
    try {
      const convId       = String(conv.id);
      const customerName = conv.customerName || 'Unknown';
      const customerEmail = conv.customerEmail || '';
      const subject      = conv.subject || customerName || 'Shopify Inbox';
      const status       = conv.done ? 'resolved' : 'open';

      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM support_tickets WHERE source_ref = $1 AND business_id = $2`,
        [convId, businessId]
      );

      let ticketId: string;

      if (existing) {
        ticketId = existing.id;
        await query(
          `UPDATE support_tickets
             SET last_message_at = $1, updated_at = NOW(), status = $2,
                 customer_email  = COALESCE(NULLIF(customer_email,''), $3),
                 customer_name   = COALESCE(NULLIF(customer_name,'Unknown'), $4)
           WHERE id = $5`,
          [
            conv.lastMessageSentAt ? new Date(conv.lastMessageSentAt) : new Date(),
            status, customerEmail, customerName, ticketId,
          ]
        );
        updated++;
      } else {
        const orderMatch = subject.match(/#(\d{3,8})/);
        const newTicket  = await queryOne<{ id: string }>(
          `INSERT INTO support_tickets
             (business_id, source, source_ref, status, subject,
              customer_email, customer_name, order_id, last_message_at)
           VALUES ($1,'shopify',$2,$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [
            businessId, convId, status, subject,
            customerEmail, customerName,
            orderMatch ? `#${orderMatch[1]}` : null,
            conv.lastMessageSentAt ? new Date(conv.lastMessageSentAt) : new Date(),
          ]
        );
        if (!newTicket) { skipped++; continue; }
        ticketId = newTicket.id;
        imported++;
      }

      // Import last message
      const msg = conv.lastMessage;
      if (msg?.id && msg.body) {
        const alreadyHave = await queryOne<{ id: string }>(
          `SELECT id FROM ticket_messages WHERE raw_email_id = $1`, [String(msg.id)]
        );
        if (!alreadyHave) {
          await query(
            `INSERT INTO ticket_messages
               (ticket_id, direction, body, sent_by, raw_email_id, created_at)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              ticketId, msg.direction, msg.body.slice(0, 10000),
              msg.senderName, String(msg.id),
              msg.sentAt ? new Date(msg.sentAt) : new Date(),
            ]
          );
        }
      }
    } catch (e) {
      errors.push(`Conv ${conv.id}: ${String(e)}`);
    }
  }

  return NextResponse.json({
    success: true, imported, updated, skipped,
    errors: errors.length > 0 ? errors : undefined,
  });
}
