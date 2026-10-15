// Meta's delivery reports (sent / delivered / read / failed) for the automation's messages land on their row by
// the message id (owner 2026-10-10). Tiny on purpose: the webhook path imports only this and the database.
import { query } from '@/lib/db';
import { QUIET_MS, RATE_MAX_ATTEMPTS, codeIn, failureSide } from './whatsapp-auto-rules';
import { safetyStop } from './whatsapp-safety-stop';

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
  // A failure on META's side (owner 2026-10-15 night, whatsapp-auto-rules.ts failureSide: 130429, 132001 template missing,
  // the token ...): the message never reached the customer, so the row is NOT lost: it waits in line again (pending, due
  // now; failed only after RATE_MAX_ATTEMPTS tries) and every order message stops until Resume (whatsapp-safety-stop.ts).
  // A customer-side failure (not on WhatsApp, blocked) fails that one row below, as before.
  if (status === 'failed' && failureSide(null, error) === 'meta') {
    try {
      const code = codeIn(null, error);
      const r = await query(
        `UPDATE wa_auto_sends
            SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
                due_at = now(), error = $2, code = $4, updated_at = now()
          WHERE wa_id = $1 AND status IN ('pending', 'sent') RETURNING sent_at, order_id, kind, template`,
        [waId, error, RATE_MAX_ATTEMPTS, code]);
      const row = r.rows?.[0] as { sent_at?: string | Date | null; order_id?: string | null; kind?: string | null; template?: string | null } | undefined;
      // when that message went: a late report of a message sent before the last pause / stop ended is no new stop
      const sentAt = row?.sent_at ? new Date(row.sent_at).getTime() : null;
      // and was it the first order message after a quiet stretch? (then the refusal is Meta's side, not our speed)
      const quiet = sentAt != null ? await quietBefore(sentAt, waId) : false;
      // the template that message went with (2026-10-15 night): the stop's reason names it
      await safetyStop({ code, words: String(error || 'WhatsApp could not deliver it'), order: row?.order_id ?? null, kind: row?.kind ?? null, template: row?.template ?? null }, Date.now(), sentAt, quiet);
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
