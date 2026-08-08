import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { sendEmailDirect } from '@/lib/smtp-client';

export const dynamic = 'force-dynamic';

// Called every minute by VPS cron:
// * * * * * curl -s https://shiptrack.store/api/cron/send-queued-email > /dev/null

export async function GET(request: NextRequest) {
  // Simple secret check to prevent public abuse
  const secret = request.nextUrl.searchParams.get('secret');
  if (secret !== (process.env.CRON_SECRET || 'shiptrack-cron')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Pick the oldest pending email from queue
    const item = await queryOne<{
      id: string; to_email: string; subject: string; html: string; from_name: string; order_id: string; status_stage: string;
    }>(
      `SELECT id, to_email, subject, html, from_name, order_id, status_stage
       FROM email_queue
       WHERE state = 'pending'
       ORDER BY queued_at ASC
       LIMIT 1`
    );

    if (!item) {
      return NextResponse.json({ status: 'queue_empty', sent: 0 });
    }

    // Mark as sending (prevent double-send if cron overlaps)
    await query(`UPDATE email_queue SET state = 'sending' WHERE id = $1`, [item.id]);

    // Send it
    const result = await sendEmailDirect([{
      to: item.to_email,
      subject: item.subject,
      html: item.html,
      fromName: item.from_name,
    }]);

    if (result.sent > 0) {
      // Mark sent + log to email_logs
      await query(
        `UPDATE email_queue SET state = 'sent', sent_at = NOW() WHERE id = $1`,
        [item.id]
      );
      await query(
        `INSERT INTO email_logs (order_id, status, recipient_email, success, error_message)
         VALUES ($1, $2, $3, true, '')
         ON CONFLICT DO NOTHING`,
        [item.order_id, item.status_stage, item.to_email]
      );
    } else {
      // Mark failed — leave for retry
      await query(
        `UPDATE email_queue SET state = 'failed', error = $1 WHERE id = $2`,
        [result.errors[0] || 'Unknown error', item.id]
      );
    }

    // Queue stats
    const stats = await queryOne<{ pending: string; sent: string; failed: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'pending') as pending,
         COUNT(*) FILTER (WHERE state = 'sent')    as sent,
         COUNT(*) FILTER (WHERE state = 'failed')  as failed
       FROM email_queue`
    );

    return NextResponse.json({
      status: result.sent > 0 ? 'sent' : 'failed',
      email: item.to_email,
      queue: stats,
    });
  } catch (err) {
    console.error('Cron send error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
