// Meta's delivery reports (sent / delivered / read / failed) for the automation's messages land on their row by
// the message id (owner 2026-10-10). Tiny on purpose: the webhook path imports only this and the database.
import { query } from '@/lib/db';

// A report never moves a row backwards (reports can arrive out of order): sent -> delivered -> read; failed wins.
export async function noteAutoStatus(waId: string, status: string, error: string | null): Promise<boolean> {
  if (!waId || !['sent', 'delivered', 'read', 'failed'].includes(status)) return false;
  try {
    const r = await query(
      `UPDATE wa_auto_sends
          SET status = CASE
                WHEN $2 = 'failed' THEN 'failed'
                WHEN $2 = 'read' THEN 'read'
                WHEN $2 = 'delivered' AND status IN ('pending', 'sent') THEN 'delivered'
                WHEN $2 = 'sent' AND status = 'pending' THEN 'sent'
                ELSE status END,
              error = CASE WHEN $2 = 'failed' THEN $3 ELSE error END,
              updated_at = now()
        WHERE wa_id = $1`,
      [waId, status, error]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    if ((e as { code?: string })?.code !== '42P01') console.error('[whatsapp] automation status:', (e as Error).message);
    return false;   // table not installed yet, or a failed read: the message record is the one that matters
  }
}
