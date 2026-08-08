import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { sendEmailDirect } from '@/lib/smtp-client';

// POST /api/support/tickets/[id]/reply
// Body: { body: string, isAiGenerated?: boolean }

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
    subject: string; business_id: string;
  }>(
    `SELECT id, customer_email, customer_name, subject, business_id FROM support_tickets WHERE id = $1`,
    [params.id]
  );

  if (!ticket) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });

  // 1. Save the outbound message
  await query(
    `INSERT INTO ticket_messages (ticket_id, direction, body, is_ai_generated, sent_by)
     VALUES ($1, 'outbound', $2, $3, $4)`,
    [params.id, replyBody, isAiGenerated || false, isAiGenerated ? 'ai' : user.username]
  );

  // 2. Update ticket's last_message_at + set to pending
  await query(
    `UPDATE support_tickets SET last_message_at = NOW(), status = 'pending', updated_at = NOW() WHERE id = $1`,
    [params.id]
  );

  // 3. Send email via Gmail SMTP
  let emailSent = false;
  let emailError = '';

  if (ticket.customer_email) {
    try {
      // Get from-name from business
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

      emailSent = result.sent > 0;
      if (!emailSent && result.errors.length > 0) emailError = result.errors[0];
    } catch (err) {
      emailError = String(err);
    }
  }

  return NextResponse.json({ success: true, emailSent, emailError: emailError || undefined });
}
