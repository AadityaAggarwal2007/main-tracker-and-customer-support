import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { MERGED_MESSAGE, lockChatGroup } from '@/lib/chat/team-routing';
import {
  LINKS_PER_ORDER_7D, SEND_COOLDOWN_MS, PREPAID_PAYOUT_ALLOWED, isCod, isDelivered, paymentLabel, type Status,
} from './rules';
import { chatMessage, formatDateTime, formatDayMonth, type Lang } from './texts';
import { newToken, refundFormsState } from './crypto';
import { REFUND_LINK_MASK, maskRefundLinks } from './link-mask';
import {
  byMeta,
  type Db, type Res, type Row, H, NOT_INSTALLED, baseUrl, chatLang, deliverEmail, isMissingTable, iso, last4, logRefundEvent, ms, num, obj,
  orderKey, pickLang, pool, postRefundMessage, res, stateOf, targetConversation, tx,
} from './server-shared';

// ── Orders (spec 2.6): panel-scoped, exactly one row ───────────
const ORDER_SQL = `SELECT o.id, o.order_id, o.customer_name, o.customer_mobile, o.payment_method, o.financial_status, o.order_total,
       o.tracking_status, o.delivered_at, o.is_cancelled, o.created_at
  FROM orders o WHERE o.order_id = $1 AND o.business_id::text = $2::text LIMIT 2`;
async function readOrder(db: Db, orderId: string, business: string): Promise<Row | null> {
  const r = await db.query(ORDER_SQL, [orderId, business]);
  return r.rows.length === 1 ? r.rows[0] : null;
}
async function snapshotOf(db: Db, o: Row): Promise<Record<string, unknown>> {
  const items = await db.query(`SELECT product_name, quantity, price FROM order_items WHERE order_id = $1 ORDER BY id LIMIT 50`, [o.order_id]);
  return {
    order_id: o.order_id,
    customer_name: o.customer_name ?? null,
    phone_last4: last4(o.customer_mobile),             // never the full phone (Q9)
    payment: paymentLabel(o.payment_method),
    payment_raw: String(o.payment_method ?? '').slice(0, 40),
    financial_status: o.financial_status ?? null,
    total: num(o.order_total) ?? 0,
    items: items.rows.map((i) => ({ name: String(i.product_name ?? ''), qty: num(i.quantity) ?? 1, price: num(i.price) ?? 0 })),
    placed_at: iso(o.created_at),
    tracking_status: o.tracking_status ?? null,
    delivered_at: iso(o.delivered_at),
    is_cancelled: !!o.is_cancelled,
  };
}

// ── Send side (spec 3.2) ───────────────────────────────────────
export type Block = 'setup' | 'not_refund_case' | 'not_verified' | 'order_mismatch' | 'no_panel' | 'request_open' | 'merged'
  | 'prepaid_gateway' | 'order_not_found' | 'no_mailbox' | 'cooldown' | 'too_many';
export interface RefundThreadState {
  can_send: boolean;
  block: Block | null;
  block_text: string | null;
  // email_failed: the form message's last email to the customer failed (an email chat whose mail
  // server refused it): the chip turns red with "Retry email" (spec 4.5; retryFormEmail).
  link: null | { id: string; state: 'active' | 'expired'; sent_at: string; expires_at: string; opened_count: number; last_opened_at: string | null; email_failed: boolean };
  request: null | { id: string; ref: string; status: Status; utr_last4: string | null };
}
// The fields of a chat this file reads ([id]/route.ts's ConversationRow has them all).
export interface RefundConv {
  id: string; site_id: string; source: string; status: string;
  case_kind: string | null; case_order_id: string | null; verified_order_id: string | null; verified_via: string | null;
  tracker_business_id: string | null; merged_into: string | null;
  customer_key?: string | null; visitor_id?: string | null;
}

export const BLOCK_TEXT = {
  // The key's name is left out on purpose: crypto.ts is the only file that names it (refund-isolation I1).
  setup: 'Refund form is switched off (the refund key is missing on the server, or REFUND_FORMS=off).',
  not_installed: `${NOT_INSTALLED} (refund-forms.sql).`,
  not_refund_case: 'The refund form is sent only from a chat in the Refund section.',
  merged: MERGED_MESSAGE,
  not_verified: 'The customer has not verified this order here (Order ID + full phone). Ask them to verify first.',
  order_mismatch: (marked: string, verified: string) =>
    `Refund was marked for order ${marked} but the chat is now verified for ${verified}. Ask the customer to verify order ${marked} again.`,
  no_panel: 'This chat has no panel, so the order cannot be read.',
  order_not_found: (order: string) => `Order ${order} was not found in this panel.`,
  prepaid_gateway: 'Prepaid order: refund through the payment gateway (master rule 18).',
  no_mailbox: 'This panel has no mailbox, so the email cannot go out.',
  request_open: (ref: string, status: string) => `This order already has a refund request (${ref}, ${status}). Open it in Refund requests.`,
  cooldown: 'A link was just sent. Try again in a minute.',
  too_many: `${LINKS_PER_ORDER_7D} links were already sent for this order in 7 days.`,
};
export const STATUS_WORD: Record<string, string> = { new: 'New', approved: 'Approved', rejected: 'Rejected', refunded: 'Refunded', cancelled: 'Cancelled' };
type BlockOut = { block: Block; text: string };

// The blocks that need no query, in the spec's order.
function staticBlock(c: RefundConv): BlockOut | null {
  if (refundFormsState() !== 'on') return { block: 'setup', text: BLOCK_TEXT.setup };
  if (c.case_kind !== 'refund') return { block: 'not_refund_case', text: BLOCK_TEXT.not_refund_case };
  if (c.merged_into) return { block: 'merged', text: BLOCK_TEXT.merged };
  if (!c.verified_order_id || c.verified_via === 'legacy') return { block: 'not_verified', text: BLOCK_TEXT.not_verified };
  if (c.case_order_id && c.case_order_id !== c.verified_order_id) {
    return { block: 'order_mismatch', text: BLOCK_TEXT.order_mismatch(c.case_order_id, c.verified_order_id) };
  }
  if (!c.tracker_business_id) return { block: 'no_panel', text: BLOCK_TEXT.no_panel };
  return null;
}
const blockStatus = (b: Block) => (b === 'setup' ? 503 : b === 'cooldown' || b === 'too_many' ? 429 : b === 'request_open' || b === 'merged' ? 409 : 400);

const LINK_COLS = `id, status, revoked_reason, created_at, expires_at, opened_count, last_opened_at, conversation_id, message_id`;
function linkView(l: Row, now: number, emailFailed = false): RefundThreadState['link'] {
  return {
    id: l.id, state: stateOf(l, now) === 'open' ? 'active' : 'expired', sent_at: iso(l.created_at), expires_at: iso(l.expires_at),
    opened_count: Number(l.opened_count) || 0, last_opened_at: iso(l.last_opened_at), email_failed: emailFailed,
  };
}
// Did the link's form message's LAST email fail? (deliverEmail's events; a chat link has none: false.)
async function formEmailFailed(db: Db, l: Row): Promise<boolean> {
  if (!l.message_id) return false;
  const r = await db.query(
    `SELECT kind FROM refund_events WHERE link_id = $1 AND kind IN ('email_sent', 'email_failed') AND meta->>'message_id' = $2 ORDER BY id DESC LIMIT 1`,
    [l.id, String(l.message_id)]
  );
  return r.rows[0]?.kind === 'email_failed';
}
const requestView = (r: Row): RefundThreadState['request'] => ({
  id: r.id, ref: r.ref_code, status: r.status, utr_last4: r.utr ? String(r.utr).slice(-4) : null,
});
const isOpenRequest = (r: Row | null | undefined) => !!r && ['new', 'approved', 'refunded'].includes(r.status);

// The order the chat's refund is about: the order it was marked for, else the verified one.
const orderOfConv = (c: RefundConv) => c.case_order_id || c.verified_order_id || null;

async function orderLinksAndRequests(db: Db, business: string, order: string) {
  const link = (await db.query(
    `SELECT ${LINK_COLS} FROM refund_links WHERE business_id = $1 AND order_id = $2 AND status = 'active' LIMIT 1`, [business, order]
  )).rows[0] || null;
  const reqs = (await db.query(
    `SELECT id, ref_code, status, utr, status_at, created_at FROM refund_requests
      WHERE business_id = $1 AND order_id = $2 ORDER BY created_at DESC LIMIT 5`, [business, order]
  )).rows;
  const open = reqs.find(isOpenRequest) || null;
  return { link, open, latest: reqs[0] || null, reqs };
}

async function baseState(db: Db, c: RefundConv, now: number): Promise<{ state: RefundThreadState; facts: Awaited<ReturnType<typeof orderLinksAndRequests>> | null }> {
  const sb = staticBlock(c);
  const business = c.tracker_business_id, order = orderOfConv(c);
  const facts = business && order ? await orderLinksAndRequests(db, business, order) : null;
  let block: BlockOut | null = sb;
  if (!block && facts?.open) {
    block = { block: 'request_open', text: BLOCK_TEXT.request_open(facts.open.ref_code, STATUS_WORD[facts.open.status] || facts.open.status) };
  }
  const shown = facts ? facts.open || facts.latest : null;
  const link = facts?.link || null;
  const emailFailed = !!link && stateOf(link, now) === 'open' && await formEmailFailed(db, link);
  return {
    state: {
      can_send: !block, block: block?.block ?? null, block_text: block?.text ?? null,
      link: link ? linkView(link, now, emailFailed) : null,
      request: shown ? requestView(shown) : null,
    },
    facts,
  };
}

// The Refund chip in the thread header (embedded in the thread GET for the Super Admin, Refund chats
// only). Blocks that need the order row, the mailbox or the link history are checked by the dialog GET.
export async function refundThreadState(conv: RefundConv): Promise<RefundThreadState> {
  try {
    return (await baseState(pool, conv, Date.now())).state;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    return { can_send: false, block: 'setup', block_text: BLOCK_TEXT.not_installed, link: null, request: null };
  }
}

const CONV_SQL = `SELECT c.id, c.site_id, c.source, c.status, c.visitor_id, c.customer_key, c.case_kind, c.case_order_id,
       c.verified_order_id, c.verified_via, c.merged_into, s.tracker_business_id
  FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = $1`;
// The chat, if this login may see its panel (the same rule as loadForUser in [id]/route.ts).
async function loadConv(convId: string, user: AuthUser | null | undefined): Promise<RefundConv | null> {
  if (typeof convId !== 'string' || !convId || convId.length > 100) return null;
  const c = (await pool.query(CONV_SQL, [convId])).rows[0] as RefundConv | undefined;
  if (!c) return null;
  if (user && user.businessIds && user.businessIds.length > 0) {
    if (!c.tracker_business_id || !user.businessIds.includes(c.tracker_business_id)) return null;
  }
  return c;
}
const maskEmail = (visitorId: unknown): string | null => {
  const e = String(visitorId ?? '').replace(/^email:/, '');
  const at = e.lastIndexOf('@');
  return at > 0 ? `${e[0]}•••@${e.slice(at + 1)}` : null;
};
async function hasMailbox(db: Db, siteId: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 AS ok FROM site_emails WHERE site_id = $1 AND email IS NOT NULL AND app_password IS NOT NULL LIMIT 1`, [siteId]);
  return r.rows.length > 0;
}
// Cooldown (60 s since the last link) and at most 5 links in 7 days, per order.
async function sendLimits(db: Db, business: string, order: string, now: number): Promise<BlockOut | null> {
  const r = await db.query(`SELECT created_at FROM refund_links WHERE business_id = $1 AND order_id = $2 ORDER BY created_at DESC LIMIT ${LINKS_PER_ORDER_7D}`, [business, order]);
  const times = r.rows.map((x) => ms(x.created_at)).filter((t) => Number.isFinite(t));
  if (times.length && now - times[0] < SEND_COOLDOWN_MS) return { block: 'cooldown', text: BLOCK_TEXT.cooldown };
  if (times.filter((t) => now - t < 7 * 24 * H).length >= LINKS_PER_ORDER_7D) return { block: 'too_many', text: BLOCK_TEXT.too_many };
  return null;
}

// GET .../refund-form: the Send dialog (state + order + warnings + the exact preview).
export async function refundFormState(convId: string, user?: AuthUser | null): Promise<Res> {
  const c = await loadConv(convId, user);
  if (!c) return res(404, { error: 'Not found' });
  return res(200, await dialogState(c));
}
async function dialogState(c: RefundConv): Promise<Record<string, unknown>> {
  const now = Date.now();
  let base: Awaited<ReturnType<typeof baseState>>;
  try {
    base = await baseState(pool, c, now);
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    return { can_send: false, block: 'setup', block_text: BLOCK_TEXT.not_installed, link: null, request: null, order: null, channel: c.source === 'email' ? 'email' : 'chat', email_to: null, lang: 'en', warnings: [], preview: null };
  }
  const st = base.state;
  const business = c.tracker_business_id, order = orderOfConv(c);
  const o = business && order ? await readOrder(pool, order, business) : null;
  let block: BlockOut | null = st.block ? { block: st.block, text: st.block_text } : null;
  if (!block && !o) block = { block: 'order_not_found', text: BLOCK_TEXT.order_not_found(order || '-') };
  if (!block && !PREPAID_PAYOUT_ALLOWED && !isCod(o.payment_method)) block = { block: 'prepaid_gateway', text: BLOCK_TEXT.prepaid_gateway };
  if (!block && c.source === 'email' && !(await hasMailbox(pool, c.site_id))) block = { block: 'no_mailbox', text: BLOCK_TEXT.no_mailbox };
  if (!block && business && order) block = await sendLimits(pool, business, order, now);

  const warnings: { code: string; text: string }[] = [];
  const warn = (code: string, text: string) => warnings.push({ code, text });
  if (c.status === 'resolved' && c.source !== 'email') warn('closed_chat', 'This chat is Closed. The customer sees the message when they open the chat again.');
  if (o) {
    if (isCod(o.payment_method) && !isDelivered(o)) warn('cod_not_delivered', 'COD order not marked Delivered: the customer has not paid anything yet.');
    // Owner answer Q1 (2026-10-02, rule 18 changed): prepaid orders too are paid to the customer's UPI / bank.
    if (!isCod(o.payment_method)) warn('prepaid', 'Prepaid order: the refund goes to the UPI / bank the customer gives in the form (owner change to rule 18). Before paying, check the payment gateway that no refund or chargeback is already open for this payment (no double refund).');
    if (o.is_cancelled) warn('order_cancelled', 'This order is cancelled in the panel.');
  }
  const link = base.facts?.link;
  if (link && stateOf(link, now) === 'open') {
    const opened = Number(link.opened_count) || 0;
    warn('active_link', `A link sent on ${formatDateTime(iso(link.created_at))} is still open (${opened ? `opened ${opened}×` : 'not opened'}). Sending a new one closes it at once.`);
    const lastOpen = ms(link.last_opened_at);
    if (Number.isFinite(lastOpen) && now - lastOpen < 30 * 60_000) {
      warn('opened_recently', `The customer opened the current link ${Math.max(0, Math.floor((now - lastOpen) / 60_000))} min ago and may be filling it now.`);
    }
  }
  const rejected = base.facts?.reqs.find((r) => r.status === 'rejected');
  if (rejected && !base.facts?.open) warn('rejected_before', `An earlier request for this order was rejected on ${formatDayMonth(iso(rejected.status_at))}.`);

  const lang = await chatLang(pool, c.id, 'en');
  const orderId = c.verified_order_id || order || '';
  return {
    ...st,
    can_send: !block, block: block?.block ?? null, block_text: block?.text ?? null,
    order: o ? {
      order_id: o.order_id, name: o.customer_name ?? null, total: num(o.order_total) ?? 0, payment: paymentLabel(o.payment_method),
      status: o.tracking_status ?? null, delivered: isDelivered(o),
    } : null,
    channel: c.source === 'email' ? 'email' : 'chat',
    email_to: c.source === 'email' ? maskEmail(c.visitor_id) : null,
    lang,
    warnings,
    preview: orderId ? {
      hinglish: chatMessage('form', 'hinglish', { order: orderId, link: REFUND_LINK_MASK }),
      en: chatMessage('form', 'en', { order: orderId, link: REFUND_LINK_MASK }),
    } : null,
  };
}

// POST .../refund-form {lang, replace, expectLinkId}: one transaction (spec 3.2). Pressing again while a
// link is open needs replace + the link's id (the dialog's confirm); an expired link is replaced
// without one. The old link is revoked in the same transaction. Holder, status, unread and
// chat_events stay as they are (J2).
export async function sendRefundForm(user: AuthUser, convId: string, body: unknown): Promise<Res> {
  const b = obj(body);
  const lang = pickLang(b.lang);
  const replace = b.replace === true;
  const expect = typeof b.expectLinkId === 'string' && b.expectLinkId ? b.expectLinkId : null;
  const c = await loadConv(convId, user);
  if (!c) return res(404, { error: 'Not found' });
  if (refundFormsState() !== 'on') return res(503, { error: BLOCK_TEXT.setup, block: 'setup' });
  if (c.merged_into) return res(409, { error: MERGED_MESSAGE, block: 'merged' });

  type Sent = { linkId: string; msg: { id: string; created_at: string }; text: string; channel: string; siteId: string; chatId: string };
  type SendOut = { res: Res; withState?: boolean; sent?: undefined } | { sent: Sent; res?: undefined; withState?: undefined };
  const out: SendOut = await withTransaction(async (client): Promise<SendOut> => {
    const db = tx(client);
    const { chat } = await lockChatGroup(client, c.id, c.site_id, c.customer_key ?? null);
    const fresh = (await db.query(
      `SELECT c.verified_via, c.visitor_id, s.tracker_business_id FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = $1`, [chat.id]
    )).rows[0] || {};
    const locked: RefundConv = {
      id: chat.id, site_id: chat.site_id, source: chat.source, status: chat.status, case_kind: chat.case_kind,
      case_order_id: chat.case_order_id, verified_order_id: chat.verified_order_id, verified_via: fresh.verified_via ?? null,
      tracker_business_id: fresh.tracker_business_id ?? null, merged_into: chat.merged_into,
    };
    const fail = (bo: BlockOut, extra: Record<string, unknown> = {}): SendOut => ({ res: res(blockStatus(bo.block), { error: bo.text, block: bo.block, ...extra }) });
    const sb = staticBlock(locked);
    if (sb) return fail(sb);
    const business = locked.tracker_business_id as string, order = locked.verified_order_id as string;
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [orderKey(business, order)]);
    const o = await readOrder(db, order, business);
    if (!o) return fail({ block: 'order_not_found', text: BLOCK_TEXT.order_not_found(order) });
    if (!PREPAID_PAYOUT_ALLOWED && !isCod(o.payment_method)) return fail({ block: 'prepaid_gateway', text: BLOCK_TEXT.prepaid_gateway });
    if (locked.source === 'email' && !(await hasMailbox(db, locked.site_id))) return fail({ block: 'no_mailbox', text: BLOCK_TEXT.no_mailbox });
    const open = (await db.query(
      `SELECT id, ref_code, status FROM refund_requests WHERE business_id = $1 AND order_id = $2 AND status IN ('new', 'approved', 'refunded') LIMIT 1`,
      [business, order]
    )).rows[0];
    if (open) {
      return fail({ block: 'request_open', text: BLOCK_TEXT.request_open(open.ref_code, STATUS_WORD[open.status] || open.status) },
        { request: { id: open.id, ref: open.ref_code, status: open.status } });
    }
    const now = Date.now();
    // The re-issue rule first (a double click on Send is a 409 need:'replace', edge case 1), then the
    // cooldown and the 7-day cap (a confirmed replace within 60 s is a 429).
    const active = (await db.query(
      `SELECT ${LINK_COLS} FROM refund_links WHERE business_id = $1 AND order_id = $2 AND status = 'active' FOR UPDATE`, [business, order]
    )).rows[0] || null;
    const activeState = active ? stateOf(active, now) : null;
    if (active && activeState === 'open') {
      if (!replace) {
        return { res: res(409, { error: 'A form link for this order is still open. Send a new one? The old link stops working at once.', need: 'replace', link: linkView(active, now) }) };
      }
      if (expect !== active.id) return { res: res(409, { error: 'Something changed. Look again.' }), withState: true };
    } else if (expect && (!active || expect !== active.id)) {
      return { res: res(409, { error: 'Something changed. Look again.' }), withState: true };
    }
    const lim = await sendLimits(db, business, order, now);
    if (lim) return fail(lim);

    const linkId = randomUUID();
    if (active) {
      await db.query(
        `UPDATE refund_links SET status = 'revoked', revoked_reason = 'reissued', revoked_at = now(), replaced_by = $2 WHERE id = $1 AND status = 'active'`,
        [active.id, linkId]
      );
      await logRefundEvent(db, {
        link_id: active.id, conversation_id: chat.id, kind: 'link_revoked', actor: 'owner',
        meta: { reason: 'reissued', replaced_by: linkId, expired: activeState !== 'open', ...byMeta(user) },
      });
    }
    const snapshot = await snapshotOf(db, o);
    const { token, hash } = newToken();
    const L: Lang = lang || await chatLang(db, chat.id, 'en');
    const text = chatMessage('form', L, { order, link: `${baseUrl()}/refund#${token}` });
    const msg = await postRefundMessage(db, { id: chat.id }, 'form', text, L);
    const channel = locked.source === 'email' ? 'email' : 'chat';
    await db.query(
      `INSERT INTO refund_links (id, token_hash, conversation_id, site_id, business_id, order_id, order_uuid, order_snapshot, channel, lang, message_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, now() + interval '7 days')`,
      [linkId, hash, chat.id, locked.site_id, business, order, o.id ?? null, JSON.stringify(snapshot), channel, L, msg.id]
    );
    await logRefundEvent(db, {
      link_id: linkId, conversation_id: chat.id, kind: 'link_sent', actor: 'owner',
      meta: { message_id: msg.id, channel, lang: L, ...(active ? { replaced: active.id } : {}), ...byMeta(user) },
    });
    return { sent: { linkId, msg, text, channel, siteId: locked.site_id, chatId: chat.id } };
  });

  if (out.res) {
    if (out.withState) out.res.body.state = await dialogState(c).catch(() => null);
    return out.res;
  }
  const s = out.sent;
  console.log(`[refund] form sent conv ${s.chatId} link ${s.linkId}`);
  let emailed: boolean | null = null;
  if (s.channel === 'email') emailed = await deliverEmail({ id: s.chatId, site_id: s.siteId }, s.msg.id, s.text, { step: 'form', link_id: s.linkId });
  const fresh = await loadConv(c.id, user);
  return res(200, {
    ok: true,
    state: fresh ? await dialogState(fresh).catch(() => null) : null,
    message: { id: s.msg.id, sender: 'system', content: maskRefundLinks(s.text), created_at: s.msg.created_at },
    emailed,
  });
}

// DELETE .../refund-form: the order's open link stops working at once. Nothing is sent to the customer.
export async function cancelRefundLink(convId: string, user?: AuthUser | null): Promise<Res> {
  const c = await loadConv(convId, user);
  if (!c) return res(404, { error: 'Not found' });
  const business = c.tracker_business_id, order = orderOfConv(c);
  if (!business || !order) return res(404, { error: 'No open form link for this chat' });
  const done = await withTransaction(async (client) => {
    const db = tx(client);
    await db.query(`SET LOCAL lock_timeout = '5s'`);
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [orderKey(business, order)]);
    const r = await db.query(
      `UPDATE refund_links SET status = 'revoked', revoked_reason = 'cancelled', revoked_at = now()
        WHERE business_id = $1 AND order_id = $2 AND status = 'active' RETURNING id`,
      [business, order]
    );
    const id = r.rows[0]?.id;
    if (!id) return null;
    await logRefundEvent(db, { link_id: id, conversation_id: c.id, kind: 'link_revoked', actor: 'owner', meta: { reason: 'cancelled', ...byMeta(user) } });
    return String(id);
  });
  if (!done) return res(404, { error: 'No open form link for this chat' });
  console.log(`[refund] link ${done} cancelled conv ${c.id}`);
  return res(200, { ok: true, state: await dialogState(c) });
}

// POST .../refund-form {action: 'retry_email', linkId}: the chip's "Retry email" (spec 4.5, edge case 11).
// The SAME form message is emailed again: no new link, no new message row. Only for the order's open
// link whose last email failed; an expired, cancelled or replaced link is never re-sent (send a new
// link instead). A customer of an email chat gets the link only by email, so this is their only way in.
export async function retryFormEmail(user: AuthUser, convId: string, body: unknown): Promise<Res> {
  const b = obj(body);
  const c = await loadConv(convId, user);
  if (!c) return res(404, { error: 'Not found' });
  if (refundFormsState() !== 'on') return res(503, { error: BLOCK_TEXT.setup, block: 'setup' });
  const business = c.tracker_business_id, order = orderOfConv(c);
  const facts = business && order ? await orderLinksAndRequests(pool, business, order) : null;
  const link = facts?.link || null;
  if (!link || stateOf(link, Date.now()) !== 'open') {
    return res(409, { error: 'This form link is no longer open. Send a new link instead.', state: await dialogState(c) });
  }
  if (typeof b.linkId === 'string' && b.linkId !== link.id) return res(409, { error: 'Something changed. Look again.', state: await dialogState(c) });
  if (!(await formEmailFailed(pool, link))) return res(409, { error: 'This form link has no failed email to send again.' });
  const row = (await pool.query(`SELECT id, conversation_id, content FROM messages WHERE id = $1 AND sender = 'system'`, [link.message_id])).rows[0];
  if (!row) return res(404, { error: 'Not found' });
  const target = await targetConversation(pool, row.conversation_id, false);
  if (!target || target.source !== 'email') return res(409, { error: 'This chat is not an email chat.' });
  const emailed = await deliverEmail(target, row.id, String(row.content), { step: 'form', link_id: link.id });
  console.log(`[refund] form email retried conv ${target.id} link ${link.id} (${emailed ? 'sent' : 'failed again'})`);
  return res(200, { ok: true, emailed, state: await dialogState(c) });
}

// The Refund-mark gate for setCase (Q6, slice D): while this chat's (or its order's) link is open and
// unexpired, or its request is New / Approved, only the Super Admin may remove or switch the mark.
// Inside setCase's transaction, in a savepoint: before refund-forms.sql is applied (42P01) it answers
// false (nothing to protect yet); any other error is the caller's.
export async function refundMarkLocked(client: PoolClient, chat: { id: string; site_id: string; case_order_id: string | null }): Promise<boolean> {
  const db = tx(client);
  await db.query('SAVEPOINT refund_mark');
  try {
    const r = await db.query(
      `SELECT EXISTS (
                SELECT 1 FROM refund_links l
                 WHERE l.status = 'active' AND l.expires_at > now()
                   AND (l.conversation_id = $1
                        OR (l.order_id = $3 AND l.business_id = (SELECT s.tracker_business_id::text FROM sites s WHERE s.id = $2))))
           OR EXISTS (
                SELECT 1 FROM refund_requests r
                 WHERE r.status IN ('new', 'approved')
                   AND (r.conversation_id = $1
                        OR (r.order_id = $3 AND r.business_id = (SELECT s.tracker_business_id::text FROM sites s WHERE s.id = $2))))
           AS locked`,
      [chat.id, chat.site_id, chat.case_order_id ?? null]
    );
    await db.query('RELEASE SAVEPOINT refund_mark');
    return !!r.rows[0]?.locked;
  } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT refund_mark');
    if (isMissingTable(e)) return false;
    throw e;
  }
}
