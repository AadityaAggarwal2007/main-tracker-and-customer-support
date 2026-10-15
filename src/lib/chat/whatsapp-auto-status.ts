// Meta's delivery reports (sent / delivered / read / failed) for the automation's messages land on their row by
// the message id (owner 2026-10-10). Tiny on purpose: the webhook path imports only this and the database.
import { query } from '@/lib/db';
import { isRateLimited, PAUSE_MS, QUIET_MS, RATE_MAX_ATTEMPTS } from './whatsapp-auto-rules';
import { pauseWhatsApp } from './whatsapp-pause';

// Was the 10 minutes before `atMs` quiet, i.e. did NO other order message go out then? (owner 2026-10-15: a 130429 on
// the first message after a quiet stretch is Meta's side, not our speed.) A failed read = not quiet (nothing is flagged
// on a guess). `exceptWaId` leaves the refused message itself out.
export async function quietBefore(atMs: number, exceptWaId: string | null = null): Promise<boolean> {
  try {
    const r = await query(
      `SELECT 1 FROM wa_auto_sends WHERE sent_at > $1::timestamptz - $2 * interval '1 millisecond' AND sent_at < $1::timestamptz
          AND ($3::text IS NULL OR wa_id IS DISTINCT FROM $3::text) LIMIT 1`,
      [new Date(atMs), QUIET_MS, exceptWaId]);
    return (r.rowCount ?? 0) === 0;
  } catch { return false; }
}

// A report never moves a row backwards (reports can arrive out of order): sent -> delivered -> read; failed wins.
export async function noteAutoStatus(waId: string, status: string, error: string | null): Promise<boolean> {
  if (!waId || !['sent', 'delivered', 'read', 'failed'].includes(status)) return false;
  // Meta's rate limit (owner 2026-10-15, "130429 Rate limit hit"): the message never went out, so the row waits and goes
  // again after the pause (at most RATE_MAX_ATTEMPTS tries), and the whole number pauses.
  if (status === 'failed' && isRateLimited(null, error)) {
    try {
      const r = await query(
        `UPDATE wa_auto_sends
            SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
                due_at = now() + $4 * interval '1 millisecond', error = $2, code = 130429, updated_at = now()
          WHERE wa_id = $1 AND status IN ('pending', 'sent') RETURNING sent_at`,
        [waId, error, RATE_MAX_ATTEMPTS, PAUSE_MS]);
      // when that message went: a late report of a message sent before the last pause ended is no new refusal
      const sent = (r.rows?.[0] as { sent_at?: string | Date | null } | undefined)?.sent_at;
      const sentAt = sent ? new Date(sent).getTime() : null;
      // and was it the first order message after a quiet stretch? (then the refusal is Meta's side, not our speed)
      const quiet = sentAt != null ? await quietBefore(sentAt, waId) : false;
      await pauseWhatsApp(String(error || '130429 rate limit'), Date.now(), undefined, sentAt, quiet);
      return (r.rowCount ?? 0) > 0;
    } catch (e) {
      if ((e as { code?: string })?.code !== '42P01') console.error('[whatsapp] automation status:', (e as Error).message);
      return false;
    }
  }
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
