import { withTransaction } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { customerKeyForOrderSql, verifyOrderByPhone } from './orders';
import { isLimited, release, reserve } from './lookup-limits';
import { heldMessage, holderOf, logChatEvent, staffActor } from './team-routing';
import type { ConversationRow } from './thread-read';
import {
  VERIFY_LIMIT, VERIFY_TEXT, VERIFY_VIA, canTeamVerify, cleanCustomerName, maskOrder, parseVerifyInput, verifyLimitKey, verifyTake,
} from './team-verify-rules';

// ── The team verifies a chat (owner 2026-10-11 13:10, "Team ka Verify button") ───────────────────
// POST /api/chat/conversations/[id]/verify { orderId, phone } | { remove: true }. The rules are in
// team-verify-rules.ts; this file is the database side. The check is verifyOrderByPhone (orders.ts):
// the order ID + the FULL phone must be on ONE order of the chat's own panel (the site's
// tracker_business_id), never another panel's. On a match, in one transaction: verified_order_id /
// verified_at / verified_via = 'team' on the chat, customer_key for a widget chat (the order's own
// 10-digit phone, read from the order as /api/widget/verify and Chikki's lookup do; an email chat
// keeps none, as mail-verify.ts does), and one chat_events row (kind 'verify', reason 'team', no CHECK
// on kind in chat-team.sql) saying who did it; the phone is never stored or logged. Re-verifying a
// chat that was verified for another order is allowed (the team corrects it) and noted in the log.
// 'team' is deliberately NOT in case-auto.ts STRICT_PROOF: no automatic Refund promise or Ship again
// mark is made on a team check, same as the Mail tab's 'mail'.

export type TeamVerifyResult =
  | { ok: true; orderId: string; customerName: string | null }
  | { ok: false; status: number; error: string };

const VERIFY_SQL = `UPDATE conversations
    SET verified_order_id = $1, verified_at = now(), verified_via = '${VERIFY_VIA}',
        customer_key = CASE WHEN source = 'chat' THEN ${customerKeyForOrderSql('$1', 'conversations.site_id')} ELSE customer_key END,
        updated_at = now()
  WHERE id = $2 AND merged_into IS NULL AND source <> 'whatsapp'
RETURNING customer_key`;

// Remove (a wrong click): only a verification the team made here. customer_key goes too when it is
// the removed order's own key on a widget chat (it was set by this check, so it is a stranger's number
// if the click was wrong); a key from an earlier check of another order stays.
const REMOVE_SQL = `UPDATE conversations
    SET verified_order_id = NULL, verified_at = NULL, verified_via = NULL,
        customer_key = CASE WHEN source = 'chat' AND customer_key IS NOT DISTINCT FROM ${customerKeyForOrderSql('conversations.verified_order_id', 'conversations.site_id')}
                            THEN NULL ELSE customer_key END,
        updated_at = now()
  WHERE id = $1 AND verified_via = '${VERIFY_VIA}'
RETURNING verified_order_id`;

type Refused = { ok: false; status: number; error: string };
function gate(conv: ConversationRow, user: AuthUser): { ok: true; actor: NonNullable<ReturnType<typeof staffActor>> } | Refused {
  const actor = staffActor(user);
  if (!actor || !actor.canReply) return { ok: false, status: 403, error: VERIFY_TEXT.cannot };
  if (conv.source === 'whatsapp') return { ok: false, status: 400, error: VERIFY_TEXT.whatsapp };
  if (conv.merged_into) return { ok: false, status: 409, error: VERIFY_TEXT.merged };
  const h = holderOf(conv.assigned_to, conv.tracker_business_id);
  if (!canTeamVerify(actor, h, conv)) return { ok: false, status: 409, error: h ? heldMessage(h, verifyTake(actor, h)) : VERIFY_TEXT.cannot };
  return { ok: true, actor };
}

export async function teamVerify(conv: ConversationRow, user: AuthUser, raw: unknown): Promise<TeamVerifyResult> {
  const g = gate(conv, user);
  if (!g.ok) return g as Refused;
  const input = parseVerifyInput(raw);
  if ('error' in input) return { ok: false, status: 400, error: input.error };
  if (!conv.tracker_business_id) return { ok: false, status: 400, error: VERIFY_TEXT.noPanel };

  const key = verifyLimitKey(g.actor.key);
  if (isLimited(key, VERIFY_LIMIT.max)) return { ok: false, status: 429, error: VERIFY_TEXT.limited };
  reserve(key, VERIFY_LIMIT.windowMs);
  const order = await verifyOrderByPhone(input.orderId, input.phone, conv.tracker_business_id);
  if (!order) return { ok: false, status: 400, error: VERIFY_TEXT.noMatch };
  release(key);

  const before = conv.verified_order_id;
  const out = await withTransaction(async (db) => {
    const r = await db.query<{ customer_key: string | null }>(VERIFY_SQL, [order.order_id, conv.id]);
    if (r.rows.length !== 1) return null;
    await logChatEvent(db, g.actor, {
      conversationId: conv.id, siteId: conv.site_id, kind: 'verify', reason: 'team',
      fromStatus: conv.status, toStatus: conv.status,
      meta: { verify: 'team', order: order.order_id, source: conv.source, ...(before && before !== order.order_id ? { replaced: before } : {}) },
    });
    return r.rows[0];
  });
  if (!out) return { ok: false, status: 409, error: conv.source === 'whatsapp' ? VERIFY_TEXT.whatsapp : VERIFY_TEXT.merged };
  console.log(`[chat-verify] conv ${conv.id} verified for order ${maskOrder(order.order_id)} by ${g.actor.key}${
    before && before !== order.order_id ? ` (was ${maskOrder(before)})` : ''}`);
  return { ok: true, orderId: order.order_id, customerName: cleanCustomerName(order.customer_name) };
}

export async function removeTeamVerify(conv: ConversationRow, user: AuthUser): Promise<TeamVerifyResult> {
  const g = gate(conv, user);
  if (!g.ok) return g as Refused;
  if (conv.verified_via !== VERIFY_VIA || !conv.verified_order_id) return { ok: false, status: 409, error: VERIFY_TEXT.notTeam };
  const removed = await withTransaction(async (db) => {
    const r = await db.query<{ verified_order_id: string | null }>(REMOVE_SQL, [conv.id]);
    if (r.rows.length !== 1) return null;
    await logChatEvent(db, g.actor, {
      conversationId: conv.id, siteId: conv.site_id, kind: 'verify', reason: 'remove',
      fromStatus: conv.status, toStatus: conv.status, meta: { verify: 'team', order: conv.verified_order_id },
    });
    return conv.verified_order_id;
  });
  if (!removed) return { ok: false, status: 409, error: VERIFY_TEXT.notTeam };
  console.log(`[chat-verify] conv ${conv.id} verification for order ${maskOrder(removed)} removed by ${g.actor.key}`);
  return { ok: true, orderId: removed, customerName: null };
}
