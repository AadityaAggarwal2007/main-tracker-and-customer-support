import { query } from '@/lib/db';

// ── A visitor whose number is a customer's ─────────────────────
// Asked for by the owner on 2026-09-30 (chat-phone-match.sql). After a visitor
// writes, or saves a number to pick the chat up elsewhere, the numbers in it
// are looked up in the orders of the chat's own panel; a match is kept on the
// conversation (phone_match_order_id) so the inbox lists the chat with the
// customers, tagged "Phone match".
//
// It is a hint for staff and NOTHING ELSE. It is not verification, and this
// file never touches verified_order_id: anyone can type someone else's number,
// so the AI still shows an order only after order ID + last 4 (or the widget
// form). Nothing found here is sent to the visitor or the model.
//
// A number is 10 digits starting 6-9, standing alone (not inside a longer run
// of digits such as a tracking number), with or without +91 / 0, and with single
// spaces / dots / dashes inside it ("98765 43210"): the separators are allowed
// only INSIDE a candidate, so "order 1234 9876543210" still finds the number. A
// saved number must be exactly 10 digits, or 11 with a leading 0, or 12 with a
// leading 91. Fired without awaiting, never throws.

export async function detectPhoneMatch(conversationId: string): Promise<void> {
  try {
    if (!conversationId) return;
    const res = await query(
      `WITH conv AS (
         SELECT c.id, c.visitor_phone, s.tracker_business_id
           FROM conversations c JOIN sites s ON s.id = c.site_id
          WHERE c.id = $1 AND c.verified_order_id IS NULL AND s.tracker_business_id IS NOT NULL
       ), typed AS (
         SELECT DISTINCT regexp_replace((regexp_matches(m.content,
                         '(?:^|[^0-9])(?:\\+?91[ .-]?|0)?([6-9](?:[ .-]?[0-9]){9})(?![0-9])', 'g'))[1], '[ .-]', '', 'g') AS phone
           FROM messages m JOIN conv ON conv.id = m.conversation_id
          WHERE m.sender = 'visitor' AND m.deleted_at IS NULL AND m.content ~ '[6-9](?:[ .-]?[0-9]){9}'
       ), saved AS (
         SELECT CASE WHEN length(d) = 10 THEN d
                     WHEN length(d) = 11 AND d LIKE '0%' THEN right(d, 10)
                     WHEN length(d) = 12 AND d LIKE '91%' THEN right(d, 10) END AS phone
           FROM (SELECT regexp_replace(COALESCE(visitor_phone, ''), '\\D', '', 'g') AS d FROM conv) x
       ), nums AS (
         SELECT phone FROM typed UNION SELECT phone FROM saved WHERE phone ~ '^[6-9]'
       ), op AS MATERIALIZED (
         SELECT o.order_id, o.created_at,
                right(regexp_replace(COALESCE(o.customer_mobile, ''), '\\D', '', 'g'), 10) AS phone
           FROM orders o
          WHERE o.business_id::text IN (SELECT tracker_business_id FROM conv)
       ), hit AS (
         SELECT op.order_id FROM op
          WHERE op.phone IN (SELECT phone FROM nums)
          ORDER BY op.created_at DESC NULLS LAST
          LIMIT 1
       )
       UPDATE conversations c
          SET phone_match_order_id = hit.order_id, phone_matched_at = now()
         FROM hit
        WHERE c.id = $1 AND c.verified_order_id IS NULL
          AND c.phone_match_order_id IS DISTINCT FROM hit.order_id`,
      [conversationId]
    );
    if (res.rowCount) console.log(`[phone-match] ${conversationId}: matched a customer`);
  } catch (err) {
    // Before chat-phone-match.sql is applied the columns do not exist yet.
    console.error(`[phone-match] ${conversationId} failed: ${(err as Error)?.message || String(err)}`);
  }
}
