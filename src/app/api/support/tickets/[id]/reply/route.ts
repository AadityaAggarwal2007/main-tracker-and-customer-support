import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { sendEmailDirect } from '@/lib/smtp-client';

// POST /api/support/tickets/[id]/reply
// Body: { body: string, isAiGenerated?: boolean }
// Auto-routes: Shopify tickets → Shopify Inbox API | Email tickets → Gmail SMTP

const SHOPIFY_API_VER = '2024-07';

async function replyViaShopify(
  domain: string,
  token: string,
  conversationId: string,
  messageBody: string
): Promise<{ sent: boolean; error?: string }> {
  try {
    const url = `https://${domain}/admin/api/${SHOPIFY_API_VER}/conversations/${conversationId}/messages.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: { body: messageBody },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { sent: false, error: `Shopify ${res.status}: ${text.slice(0, 200)}` };
    }

    return { sent: true };
  } catch (err) {
    return { sent: false, error: String(err) };
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { body: replyBody, isAiGenerated } = await request.json();

  if (!replyBody?.trim()) {
    return NextResponse.json({ error: 'Reply body required' }, { status: 400 });
  }

  const ticket = await queryOne<{
    id: string; customer_email: string; customer_name: string;
    subject: string; business_id: string; source: string; source_ref: string;
  }>(
    `SELECT id, customer_email, customer_name, subject, business_id, source, source_ref
     FROM support_tickets WHERE id = $1`,
    [params.id]
  );

  if (!ticket) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });

  // 1. Save the outbound message to DB
  await query(
    `INSERT INTO ticket_messages (ticket_id, direction, body, is_ai_generated, sent_by)
     VALUES ($1, 'outbound', $2, $3, $4)`,
    [params.id, replyBody, isAiGenerated || false, isAiGenerated ? 'ai' : user.username]
  );

  // 2. Update ticket metadata
  await query(
    `UPDATE support_tickets SET last_message_at = NOW(), status = 'pending', updated_at = NOW() WHERE id = $1`,
    [params.id]
  );

  let replySent = false;
  let replyError = '';
  let replyChannel = '';

  // 3a. If Shopify Inbox ticket → reply via Shopify API
  if (ticket.source === 'shopify' && ticket.source_ref) {
    try {
      const biz = await queryOne<{ shopify_domain: string; shopify_api_token: string }>(
        `SELECT shopify_domain, shopify_api_token FROM businesses WHERE id = $1`,
        [ticket.business_id]
      );

      if (biz?.shopify_domain && biz?.shopify_api_token) {
        const result = await replyViaShopify(
          biz.shopify_domain,
          biz.shopify_api_token,
          ticket.source_ref,
          replyBody
        );
        replySent = result.sent;
        replyError = result.error || '';
        replyChannel = 'shopify';
      }
    } catch (err) {
      replyError = String(err);
    }
  }

  // 3b. For email tickets (or as fallback if Shopify reply fails) → send via Gmail SMTP
  if (!replySent && ticket.customer_email && ticket.source !== 'shopify') {
    try {
      const biz = ticket.business_id
        ? await queryOne<{ name: string; support_email: string }>(
            `SELECT name, support_email FROM businesses WHERE id = $1`,
            [ticket.business_id]
          )
        : null;

      const fromName = biz?.name || 'Support';
      const subject = ticket.subject?.startsWith('Re:')
        ? ticket.subject
        : `Re: ${ticket.subject || 'Your query'}`;

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; color: #333;">
          <p>Hi ${ticket.customer_name || 'there'},</p>
          <div style="white-space: pre-wrap; line-height: 1.6;">${replyBody.replace(/\n/g, '<br>')}</div>
          <br>
          <p style="color: #666; font-size: 0.875rem;">— ${fromName} Support Team</p>
        </div>
      `;

      const result = await sendEmailDirect([
        { to: ticket.customer_email, subject, html },
      ]);

      replySent = result.sent > 0;
      if (!replySent && result.errors.length > 0) replyError = result.errors[0];
      replyChannel = 'email';
    } catch (err) {
      replyError = String(err);
    }
  }

  return NextResponse.json({
    success: true,
    replySent,
    replyChannel,
    replyError: replyError || undefined,
    // Legacy field for UI compatibility
    emailSent: replyChannel === 'email' && replySent,
  });
}
