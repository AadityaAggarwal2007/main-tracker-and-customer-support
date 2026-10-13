// ── Refund / Ship again from the Mail tab always has a chat to mark (owner 2026-10-13: "anurag wala email verified
// customer ma refund aur ship again ka option nai arha") ──
// The buttons need the sender's EMAIL chat (Chat Support's Refund / Ship again lists are made of chats), verified for
// that order. Two cases had none: a verified customer who wrote again later (the poller files the new mail as an
// unverified email chat: verifySender moved only the chats that existed then), and a customer who wrote to the
// chargeback Gmail (that Gmail never makes email chats). Before the PATCH, the Mail tab asks for the chat here:
//   - the sender must be VERIFIED for that order in this panel (mail_verifications, the same list the card shows);
//   - their email chat in this panel (the one verified for that order first), verified for it now when it was not
//     (verified_via 'mail', a team check: not STRICT_PROOF, so no automatic Refund promise), opened again when Closed
//     (a person is acting on it), else a new one (`source 'email'`, `visitor_id 'email:<address>'`, like the poller's);
//   - a chat already marked for ANOTHER order is never re-pointed: a new chat is made instead.
// Nothing is sent to the customer. The PATCH (setCase / forward) then checks the rights again.
import { query } from '@/lib/db';
import { verifiedSenders } from './mail-verify';

export type CaseChatResult = { ok: true; chatId: string; created: boolean } | { ok: false; status: number; error: string };
const sameOrder = (a: string | null | undefined, b: string) => String(a || '').replace(/^#/, '') === String(b || '').replace(/^#/, '');

export async function ensureMailCaseChat(box: { panelId: string | null; siteId?: string | null }, email: string, orderId: string): Promise<CaseChatResult> {
  if (!box.panelId) return { ok: false, status: 409, error: 'This Gmail has no panel.' };
  const vers = (await verifiedSenders(box.panelId, [email]))[email] || [];
  const ver = vers.find(v => sameOrder(v.orderId, orderId));
  if (!ver) return { ok: false, status: 409, error: 'Verify this sender for that order first.' };
  const order = ver.orderId;

  const r = await query<{ id: string; status: string; verified_order_id: string | null; case_kind: string | null }>(
    `SELECT c.id, c.status, c.verified_order_id, c.case_kind
       FROM conversations c JOIN sites s ON s.id = c.site_id
      WHERE s.tracker_business_id::text = $1::text AND c.source = 'email' AND lower(c.visitor_id) = $2 AND c.merged_into IS NULL
      ORDER BY (c.verified_order_id = $3) DESC NULLS LAST, c.last_message_at DESC NULLS LAST LIMIT 1`,
    [box.panelId, `email:${email}`, order]);
  const row = r.rows[0];
  if (row && (sameOrder(row.verified_order_id, order) || !row.case_kind)) {
    await query(
      `UPDATE conversations
          SET verified_order_id = $2,
              verified_at = CASE WHEN verified_order_id = $2 THEN verified_at ELSE now() END,
              verified_via = CASE WHEN verified_order_id = $2 THEN verified_via ELSE 'mail' END,
              status = CASE WHEN status = 'resolved' THEN 'agent_handling' ELSE status END,
              updated_at = now()
        WHERE id = $1`, [row.id, order]);
    return { ok: true, chatId: row.id, created: false };
  }

  const site = await query<{ id: string }>(
    `SELECT s.id FROM sites s WHERE s.tracker_business_id::text = $1::text
      ORDER BY (s.id = $2) DESC, s.created_at ASC LIMIT 1`, [box.panelId, box.siteId || '']);
  if (!site.rows[0]) return { ok: false, status: 409, error: 'This panel has no chat site, so the customer cannot be put in a list.' };
  const made = await query<{ id: string }>(
    `INSERT INTO conversations
       (id, site_id, visitor_id, visitor_name, status, source, unread_count, last_message_at, created_at, updated_at,
        verified_order_id, verified_at, verified_via)
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'agent_handling', 'email', 0, now(), now(), now(), $4, now(), 'mail')
     RETURNING id`,
    [site.rows[0].id, `email:${email}`, email, order]);
  console.log(`[mail-case] email chat made for a verified sender, panel=${box.panelId}`);
  return { ok: true, chatId: made.rows[0].id, created: true };
}
