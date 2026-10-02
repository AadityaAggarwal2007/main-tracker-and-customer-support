// ── Refund form: everything that reads or writes the refund tables (owner, 2026-10-02) ──
// SERVER ONLY. Spec refund_form_spec.md sections 2.6, 3 and 4. The only callers are:
//   - the Super Admin's Send control   /api/chat/conversations/[id]/refund-form (and the thread GET's
//                                      refund_form block + the Refund-mark gate, slice D)
//   - the customer's form              /api/refund/* (by the link's token only; public.ts guards it)
//   - the Super Admin's list           /api/refunds/*
// Staff, the AI, the learner, search and the team score never reach this file.
//
// Privacy (spec 9): the UPI / bank details are sealed (crypto.ts sealJson, AAD = request id) BEFORE
// any SQL; the token is stored only as its SHA-256; log lines carry ids, refs, steps, statuses and pg
// codes only (logFail). Chat messages are sender 'system' (shown as "Vastora Support"); they never
// claim the chat or change its holder (J2). Owner answer Q3 (2026-10-02): no customer message carries
// the UPI ID or the account, not even masked (texts.ts).
// Owner change 2026-10-02 ~15:00 ("upload yeh sab mat bana, humein sirf bank details mil jaye bahut
// hai"): NO photo / video upload. Nothing here reads or writes refund_files / refund_file_parts, and no
// refund route takes a file (refund-route.js R8 pins it).
//
// Locks, always in this order so two actions cannot deadlock:
//   Send:     chat group (lockChatGroup) -> advisory lock of the order -> its links (FOR UPDATE)
//   Submit:   advisory lock of the order -> the link (FOR UPDATE)
//   Status / "form received": the request (CAS UPDATE / FOR UPDATE) -> the target chat (FOR NO KEY UPDATE)
// Every transaction sets lock_timeout 5 s first: a busy row is a 409 "try again", never a hang.

import { randomBytes, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { MERGED_MESSAGE, lockChatGroup, setActor, staffActor } from '@/lib/chat/team-routing';
import { sendAgentEmailReply } from '@/lib/chat/email';
import { looksHinglish } from '@/lib/chat/escalation';
import { maskSensitive } from '@/lib/chat/sensitive';
import {
  CONSENT_VERSION, DETAILS_MIN, DETAILS_MAX, LINKS_PER_ORDER_7D, SEND_COOLDOWN_MS,
  PREPAID_PAYOUT_ALLOWED, PUBLIC_STATUS, STATUSES, UUID_RE, actionsFor, checkNote, checkReturnNote, computeFlags, deviceLabel,
  isCod, isDelivered, isMoveAction, istDay, linkState, namesMatch, newRefCode, paymentLabel, payoutFpInput, statusViewOpen,
  validateMove, validateSubmit, type Flag, type FlagInput, type MoveValue, type Status, type SubmitInput,
} from './rules';
import { bankName, chatMessage, formatDateTime, formatDayMonth, payoutLabel, type Lang, type Step } from './texts';
import {
  fingerprint, ipHash, newToken, openJson, payoutAad, refundCryptoReady, refundFormsState, sealJson,
  RefundCryptoError,
} from './crypto';
import { hash8, hit, REFUND_LIMITS } from './limits';
import { REFUND_LINK_MASK, maskRefundLinks } from './link-mask';
import { noteBadToken, INVALID } from './public';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
interface Db { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }> }
const pool: Db = { query: (sql, params) => query(sql, params) as Promise<{ rows: Row[]; rowCount?: number | null }> };
const tx = (client: PoolClient): Db => client as unknown as Db;

// What a route answers: its status and JSON body (the route adds the headers).
export interface Res { status: number; body: Record<string, unknown> }
const res = (status: number, body: Record<string, unknown>): Res => ({ status, body });

// ── Logging: codes only ────────────────────────────────────────
// A pg error's SQLSTATE and its message (pg messages name tables and constraints, never values), else
// only the error's class name: a JSON or library message could quote what the customer typed.
export const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[A-Z0-9_]{1,24}$/i.test(c) ? c : '-';
};
const isSqlState = (e: unknown) => /^[0-9A-Z]{5}$/.test(codeOf(e));
export const msgOf = (e: unknown): string => (isSqlState(e)
  ? String((e as { message?: unknown }).message ?? '').slice(0, 80)
  : String((e as { name?: unknown } | null)?.name ?? 'Error').slice(0, 40));
export function logFail(where: string, e: unknown): void {
  console.error(`[refund] ${where} failed:`, codeOf(e), msgOf(e));
}
export const isMissingTable = (e: unknown) => codeOf(e) === '42P01';
export const NOT_INSTALLED = 'Refund forms are not installed yet';
const BUSY = 'Someone else is changing this right now. Try again.';
const isBusy = (e: unknown) => codeOf(e) === '55P03' || codeOf(e) === '40P01';
const noKey = (e: unknown) => e instanceof RefundCryptoError && e.code === 'no_key';

// What a Super Admin route answers for an error this file threw (a chat lock refusal, ChatActionError,
// is answered by the route through actionError). Logged with codes only.
export function adminFailure(where: string, e: unknown): Res {
  if (isMissingTable(e)) return res(503, { error: NOT_INSTALLED });
  if (isBusy(e)) return res(409, { error: BUSY });
  if (noKey(e)) return res(503, { error: 'key_missing' });
  logFail(where, e);
  return res(500, { error: 'Something went wrong. Try again.' });
}
// The same for the customer's form: before refund-forms.sql is applied, or without a key, the form is
// closed; anything else is an error the page retries (the same client_nonce keeps a submit single).
export function publicFailure(where: string, e: unknown): Res {
  if (isMissingTable(e) || noKey(e)) return res(503, { state: 'closed' });
  logFail(where, e);
  return res(500, { state: 'error' });
}

const H = 60 * 60_000;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const ms = (v: unknown): number => {
  const t = iso(v);
  return t ? Date.parse(t) : NaN;
};
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const last4 = (phone: unknown) => String(phone ?? '').replace(/\D/g, '').slice(-4) || null;
const baseUrl = () => (process.env.NEXT_PUBLIC_BASE_URL || 'https://shiptrack.store').trim().replace(/\/+$/, '');
const orderKey = (business: string, order: string) => `refund:${business}:${order}`;
// A refund_links row's state (rules.ts linkState: submitted / replaced / cancelled / expired / open).
type LinkRow = { status: string; revoked_reason?: string | null; expires_at: unknown };
const stateOf = (l: Row, now: number) => linkState(l as LinkRow, now);

// ── Shared: events, target chat, language, the system message, email ──
export interface RefundEvent {
  link_id?: string | null; request_id?: string | null; conversation_id?: string | null;
  kind: string; actor: 'owner' | 'customer' | 'system';
  from_status?: string | null; to_status?: string | null; note?: string | null; ip_hash?: string | null;
  meta?: Record<string, unknown> | null;   // ids, counts, step, device: NEVER payout, token or details
}
export async function logRefundEvent(db: Db, ev: RefundEvent): Promise<void> {
  await db.query(
    `INSERT INTO refund_events (link_id, request_id, conversation_id, kind, actor, from_status, to_status, note, ip_hash, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [ev.link_id ?? null, ev.request_id ?? null, ev.conversation_id ?? null, ev.kind, ev.actor, ev.from_status ?? null,
      ev.to_status ?? null, ev.note ?? null, ev.ip_hash ?? null, ev.meta ? JSON.stringify(ev.meta) : null]
  );
}
// Outside a transaction, best effort (an open count, a view): a failed history row never fails the answer.
const softEvent = (ev: RefundEvent) => logRefundEvent(pool, ev).catch((e) => logFail(`event ${ev.kind}`, e));

export interface TargetChat { id: string; site_id: string; status: string; source: string; case_kind: string | null }
// The chat a message goes to: the link's chat, following merged_into (at most 5 hops, like
// widget-api.ts conversationForSite). lock: FOR NO KEY UPDATE, inside the caller's transaction.
export async function targetConversation(db: Db, startId: string, lock = false): Promise<TargetChat | null> {
  let id = startId;
  for (let hop = 0; hop <= 5; hop++) {
    const r = await db.query(
      `SELECT c.id, c.site_id, c.status, c.source, c.case_kind, c.merged_into FROM conversations c WHERE c.id = $1${lock ? ' FOR NO KEY UPDATE' : ''}`,
      [id]
    );
    const row = r.rows[0];
    if (!row) return null;
    if (!row.merged_into || hop === 5) {
      if (row.merged_into) console.log(`[refund] merge chain too long ${startId}`);
      return { id: row.id, site_id: row.site_id, status: row.status, source: row.source, case_kind: row.case_kind ?? null };
    }
    id = row.merged_into;
  }
  return null;
}

// Hinglish when the customer's last 3 visible messages look Hinglish (escalation.ts), else English;
// no customer text yet: the fallback (the link's language).
export async function chatLang(db: Db, convId: string, fallback: Lang): Promise<Lang> {
  const r = await db.query(
    `SELECT content FROM messages
      WHERE conversation_id = $1 AND sender = 'visitor' AND deleted_at IS NULL
        AND COALESCE(metadata->>'hidden', 'false') <> 'true'
      ORDER BY created_at DESC LIMIT 3`,
    [convId]
  );
  if (!r.rows.length) return fallback;
  return looksHinglish(r.rows.map((x) => String(x.content ?? '')).join('\n')) ? 'hinglish' : 'en';
}
const pickLang = (v: unknown): Lang | null => (v === 'hinglish' || v === 'en' ? v : null);

// One 'system' message ("Vastora Support") inside the caller's transaction. Never claims the chat,
// never touches the holder or chat_events. 'received' counts as unread and reopens a Closed chat to the
// team (agent_handling while still marked, else human_needed; actor 'customer', reason 'reopen', the same
// rule as a customer's own message); 'rejected' reopens it the same way, named as the Super Admin's (Q14).
export async function postRefundMessage(
  db: Db, target: { id: string }, step: Step, text: string, lang: Lang, opts: { actor?: ReturnType<typeof staffActor> } = {},
): Promise<{ id: string; created_at: string }> {
  const m = await db.query(
    `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
     VALUES (gen_random_uuid()::text, $1, 'system', $2, jsonb_build_object('system', 'refund', 'step', $3::text, 'lang', $4::text), now())
     RETURNING id, created_at`,
    [target.id, text, step, lang]
  );
  const reopen = step === 'received' || step === 'rejected';
  if (step === 'rejected' && opts.actor) await setActor(db as unknown as PoolClient, opts.actor, 'refund_rejected');
  await db.query(
    `UPDATE conversations
        SET last_message_at = now(), updated_at = now(), unread_count = unread_count + $2::int,
            status = CASE WHEN $3::boolean AND status = 'resolved'
                          THEN CASE WHEN case_kind IS NOT NULL THEN 'agent_handling' ELSE 'human_needed' END
                          ELSE status END
      WHERE id = $1`,
    [target.id, step === 'received' ? 1 : 0, reopen]
  );
  return { id: String(m.rows[0].id), created_at: iso(m.rows[0].created_at) || new Date().toISOString() };
}

// An email chat also gets the message as an email reply, after commit (spec 4.5). sendAgentEmailReply
// returns silently with no mailbox, so the mailbox is checked first. The message is kept either way;
// the result goes on the message (metadata.emailed, like a staff reply) and in the history.
export async function deliverEmail(
  target: { id: string; site_id: string }, messageId: string, content: string,
  ids: { step: Step; link_id?: string | null; request_id?: string | null },
): Promise<boolean> {
  let emailed = false;
  let code: string | null = null;
  try {
    const box = await query(
      `SELECT 1 AS ok FROM site_emails WHERE site_id = $1 AND email IS NOT NULL AND app_password IS NOT NULL LIMIT 1`,
      [target.site_id]
    );
    if (!box.rows.length) code = 'no_mailbox';
    else {
      await sendAgentEmailReply(target.id, content, []);
      emailed = true;
    }
  } catch (e) {
    code = codeOf(e) === '-' ? 'send' : codeOf(e);
  }
  await query(
    `UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('emailed', $2::boolean) WHERE id = $1`,
    [messageId, emailed]
  ).catch((e) => logFail('email status', e));
  await softEvent({
    link_id: ids.link_id ?? null, request_id: ids.request_id ?? null, conversation_id: target.id,
    kind: emailed ? 'email_sent' : 'email_failed', actor: 'system',
    meta: { step: ids.step, message_id: messageId, ...(code ? { code } : {}) },
  });
  if (!emailed) console.error(`[refund] email not sent conv ${target.id} (${code})`);
  return emailed;
}

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
const STATUS_WORD: Record<string, string> = { new: 'New', approved: 'Approved', rejected: 'Rejected', refunded: 'Refunded', cancelled: 'Cancelled' };
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
        meta: { reason: 'reissued', replaced_by: linkId, expired: activeState !== 'open' },
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
      meta: { message_id: msg.id, channel, lang: L, ...(active ? { replaced: active.id } : {}) },
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
    await logRefundEvent(db, { link_id: id, conversation_id: c.id, kind: 'link_revoked', actor: 'owner', meta: { reason: 'cancelled' } });
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

// ── Public side (spec 3.1): by the link's token hash only ──────
const slowDown = () => res(429, { state: 'slow_down' });
const invalid = (ip: string) => { noteBadToken(ip); return res(404, { ...INVALID }); };

// POST /api/refund/open {token}
export async function openLink(hash: string, ip: string, ua: string | null): Promise<Res> {
  if (hit(`rf:open:${ip}`, REFUND_LIMITS.open_ip.max, REFUND_LIMITS.open_ip.windowMs)
    || hit(`rf:open:tok:${hash8(hash)}`, REFUND_LIMITS.open_tok.max, REFUND_LIMITS.open_tok.windowMs)) return slowDown();
  const row = (await pool.query(
    `SELECT l.id, l.status, l.revoked_reason, l.expires_at, l.lang, l.order_snapshot, l.submitted_at, l.conversation_id,
            s.name AS site_name, b.logo_url
       FROM refund_links l
       LEFT JOIN sites s ON s.id = l.site_id
       LEFT JOIN businesses b ON b.id::text = l.business_id
      WHERE l.token_hash = $1`,
    [hash]
  )).rows[0];
  if (!row) return invalid(ip);
  const now = Date.now();
  const st = stateOf(row, now);
  const brand = { name: row.site_name ?? null, logo_url: row.logo_url ?? null };
  const lang: Lang = pickLang(row.lang) || 'en';
  if (st === 'submitted') {
    if (!statusViewOpen(row.submitted_at, now)) return res(200, { state: 'used', brand });
    const r = (await pool.query(
      `SELECT ref_code, created_at, status, payout_method, payout_mask, refund_amount, refund_date::text AS refund_date, utr
         FROM refund_requests WHERE link_id = $1`,
      [row.id]
    )).rows[0];
    if (!r) return res(200, { state: 'used', brand });
    return res(200, {
      state: 'submitted', lang, brand,
      request: {
        ref: r.ref_code, submitted_at: iso(r.created_at), status: PUBLIC_STATUS[r.status as Status] ?? 'received',
        payout: payoutLabel(r.payout_method, r.payout_mask),
        refunded: r.status === 'refunded' ? { amount: num(r.refund_amount), date: r.refund_date ?? null, utr: r.utr ?? null } : null,
      },
    });
  }
  if (st !== 'open') return res(410, { state: st, brand });

  await pool.query(
    `UPDATE refund_links SET opened_count = opened_count + 1, first_opened_at = COALESCE(first_opened_at, now()), last_opened_at = now() WHERE id = $1`,
    [row.id]
  );
  const seen = (await pool.query(`SELECT count(*)::int AS n FROM refund_events WHERE link_id = $1 AND kind = 'link_opened'`, [row.id])).rows[0];
  if ((Number(seen?.n) || 0) < 50) {
    await softEvent({ link_id: row.id, conversation_id: row.conversation_id, kind: 'link_opened', actor: 'customer', ip_hash: ipHash(ip), meta: { device: deviceLabel(ua) } });
  }
  const snap = obj(row.order_snapshot);
  return res(200, {
    state: 'open', lang, expires_at: iso(row.expires_at), brand,
    order: {
      order_id: snap.order_id ?? null, name: snap.customer_name ?? null, phone_last4: snap.phone_last4 ?? null,
      total: num(snap.total), payment: snap.payment ?? null,
      items: (Array.isArray(snap.items) ? snap.items : []).map((i: Row) => ({ name: String(i?.name ?? ''), qty: num(i?.qty) ?? 1 })),
      placed_on: snap.placed_at ? istDay(snap.placed_at) : null,
    },
    // Owner change 2026-10-02 ~15:00: no photo / video upload, so no file limits and no staged files.
    limits: { details_min: DETAILS_MIN, details_max: DETAILS_MAX },
  });
}

// POST /api/refund/submit. Transaction A saves the request (it never waits on a chat lock); the
// "form received" message is transaction B (postAckWithRetry), so a busy chat never fails a submit.
export async function submitRefund(hash: string, ip: string, ua: string | null, body: Record<string, unknown>): Promise<Res> {
  if (hit(`rf:submit:tok:${hash8(hash)}`, REFUND_LIMITS.submit_tok.max, REFUND_LIMITS.submit_tok.windowMs)
    || hit(`rf:submit:${ip}`, REFUND_LIMITS.submit_ip.max, REFUND_LIMITS.submit_ip.windowMs)) return slowDown();
  const pre = (await pool.query(`SELECT id, business_id, order_id FROM refund_links WHERE token_hash = $1`, [hash])).rows[0];
  if (!pre) return invalid(ip);
  const nonce = typeof body.client_nonce === 'string' ? body.client_nonce.toLowerCase() : '';

  type Done = { id: string; ref: string; method: string };
  type SubmitOut = { res: Res; done?: undefined } | { done: Done; res?: undefined };
  const out: SubmitOut = await withTransaction(async (client): Promise<SubmitOut> => {
    const db = tx(client);
    await db.query(`SET LOCAL lock_timeout = '5s'`);
    // Advisory first, then the link row: the same order as Send, so the two never deadlock.
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [orderKey(pre.business_id, pre.order_id)]);
    const link = (await db.query(
      `SELECT id, status, revoked_reason, expires_at, conversation_id, site_id, business_id, order_id, order_uuid, order_snapshot
         FROM refund_links WHERE token_hash = $1 FOR UPDATE`,
      [hash]
    )).rows[0];
    if (!link) return { res: res(404, { ...INVALID }) };
    const now = Date.now();
    const st = stateOf(link, now);
    if (st === 'submitted') {
      const prev = (await db.query(`SELECT ref_code, client_nonce FROM refund_requests WHERE link_id = $1`, [link.id])).rows[0];
      // The same submit again (a retry after a lost answer): the same answer.
      if (prev && nonce && String(prev.client_nonce).toLowerCase() === nonce) return { res: res(200, { state: 'submitted', ref: prev.ref_code }) };
      return { res: res(409, { state: 'used' }) };
    }
    if (st !== 'open') return { res: res(410, { state: st }) };

    const v = validateSubmit(body, { mask: (t) => maskSensitive(t).text });
    if (!v.ok) return { res: res(400, { state: 'invalid_input', errors: (v as { errors: Record<string, string> }).errors }) };
    const input = (v as { value: SubmitInput }).value;

    // The order as it is now (panel-scoped): the phone only becomes an HMAC, never stored or logged.
    const orderNow = (await db.query(
      `SELECT o.customer_mobile, o.tracking_status, o.delivered_at, o.is_cancelled FROM orders o
        WHERE o.order_id = $1 AND o.business_id::text = $2::text LIMIT 2`,
      [link.order_id, link.business_id]
    )).rows;
    const one = orderNow.length === 1 ? orderNow[0] : null;
    const snap = obj(link.order_snapshot);
    const snapshot = {
      ...snap,
      tracking_status: one ? one.tracking_status ?? null : snap.tracking_status ?? null,
      delivered_at: one ? iso(one.delivered_at) : snap.delivered_at ?? null,
      is_cancelled: one ? !!one.is_cancelled : !!snap.is_cancelled,
    };
    const id = randomUUID();
    const payout = input.payout;
    const sealed = sealJson(payout, payoutAad(id));
    const fpIn = payoutFpInput(payout);
    const phoneFp = one && String(one.customer_mobile ?? '').replace(/\D/g, '').length >= 4 ? fingerprint('phone', String(one.customer_mobile)) : null;
    const insertParams = (ref: string) => [
      id, ref, link.id, input.client_nonce, link.conversation_id, link.site_id, link.business_id, link.order_id, link.order_uuid ?? null,
      JSON.stringify(snapshot), phoneFp, input.reason, input.sub_reason, input.checked_around, input.details, input.method,
      input.payout_mask, sealed.blob, sealed.keyId, fingerprint(fpIn.kind, fpIn.value), namesMatch(payout.holder, snap.customer_name),
      CONSENT_VERSION, ipHash(ip), deviceLabel(ua),
    ];
    let ref: string | null = null;
    for (let attempt = 0; attempt < 3 && !ref; attempt++) {
      const tryRef = newRefCode(randomBytes(6));
      await db.query('SAVEPOINT rf_ref');
      try {
        await db.query(
          `INSERT INTO refund_requests (id, ref_code, link_id, client_nonce, conversation_id, site_id, business_id, order_id, order_uuid,
                                        order_snapshot, phone_fp, reason, sub_reason, checked_around, details, payout_method, payout_mask,
                                        payout_enc, payout_key_id, payout_fp, holder_matches, consent_version, consent_at, submit_ip_hash, submit_device)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, now(), $23, $24)`,
          insertParams(tryRef)
        );
        await db.query('RELEASE SAVEPOINT rf_ref');
        ref = tryRef;
      } catch (e) {
        await db.query('ROLLBACK TO SAVEPOINT rf_ref');
        const constraint = String((e as { constraint?: unknown })?.constraint ?? '');
        if (codeOf(e) === '23505' && constraint === 'refund_requests_one_open') return { res: res(409, { state: 'already_requested' }) };
        if (codeOf(e) === '23505' && constraint === 'refund_requests_ref_code_key') continue;
        throw e;
      }
    }
    if (!ref) throw Object.assign(new Error('refund ref'), { code: 'RF_REF' });
    await db.query(`UPDATE refund_links SET status = 'submitted', submitted_at = now() WHERE id = $1`, [link.id]);
    await logRefundEvent(db, {
      link_id: link.id, request_id: id, conversation_id: link.conversation_id, kind: 'submitted', actor: 'customer',
      to_status: 'new', ip_hash: ipHash(ip), meta: { device: deviceLabel(ua), method: input.method },
    });
    return { done: { id, ref, method: input.method } };
  });

  if (out.res) {
    if (out.res.status === 404) noteBadToken(ip);
    return out.res;
  }
  const d = out.done;
  console.log(`[refund] ${d.ref} submitted (${d.method})`);
  await postAckWithRetry(d.id);
  return res(200, { state: 'submitted', ref: d.ref });
}
// ── "Form received" (transaction B, spec 4.4) ──────────────────
// Posted once: the request row is locked and ack_message_id must still be empty (the trigger refuses a
// second value). Returns null when it was already posted.
export async function postAck(requestId: string): Promise<{ message_id: string } | null> {
  const out = await withTransaction(async (client) => {
    const db = tx(client);
    await db.query(`SET LOCAL lock_timeout = '5s'`);
    const r = (await db.query(
      `SELECT id, link_id, conversation_id FROM refund_requests WHERE id = $1 AND ack_message_id IS NULL FOR UPDATE`, [requestId]
    )).rows[0];
    if (!r) return null;
    const link = (await db.query(`SELECT lang FROM refund_links WHERE id = $1`, [r.link_id])).rows[0];
    const target = await targetConversation(db, r.conversation_id, true);
    if (!target) throw Object.assign(new Error('refund chat missing'), { code: 'RF_NO_CHAT' });
    const lang = await chatLang(db, target.id, pickLang(link?.lang) || 'en');
    const text = chatMessage('received', lang);
    const msg = await postRefundMessage(db, target, 'received', text, lang);
    await db.query(`UPDATE refund_requests SET ack_message_id = $2 WHERE id = $1`, [r.id, msg.id]);
    await logRefundEvent(db, {
      link_id: r.link_id, request_id: r.id, conversation_id: target.id, kind: 'message_posted', actor: 'system',
      meta: { step: 'received', message_id: msg.id, lang },
    });
    return { target, msg, text, linkId: String(r.link_id) };
  });
  if (!out) return null;
  if (out.target.source === 'email') await deliverEmail(out.target, out.msg.id, out.text, { step: 'received', request_id: requestId, link_id: out.linkId });
  return { message_id: out.msg.id };
}
// Two tries (a chat busy for 5 s, a deadlock); then the history says it failed and the panel offers
// "Post now" (PATCH post_ack). The request itself is already saved.
const ACK_ATTEMPTS = 2;
export async function postAckWithRetry(requestId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= ACK_ATTEMPTS; attempt++) {
    try {
      await postAck(requestId);
      return true;
    } catch (e) {
      logFail(`received message ${requestId} try ${attempt}`, e);
    }
  }
  await softEvent({ request_id: requestId, kind: 'message_failed', actor: 'system', meta: { step: 'received' } });
  return false;
}

// ── Super Admin side (spec 3.5) ────────────────────────────────
export const VIEWS = ['new', 'approved', 'rejected', 'refunded', 'cancelled', 'all', 'sent'] as const;

// The list's flags, from stored columns only.
function listFlags(r: Row, now: number): string[] {
  const snap = obj(r.order_snapshot);
  const input: FlagInput = {
    paymentRaw: snap.payment_raw ?? snap.payment ?? '',
    holderMatches: r.holder_matches ?? null,
    orderName: (snap.customer_name as string) ?? null,
    payoutReusedRefs: r.payout_reused ? ['another order'] : [],
    phoneRequests90d: Number(r.phone_count) || 0,
    ackPosted: !!r.ack_message_id,
    createdAtMs: ms(r.created_at),
    nowMs: now,
  };
  return computeFlags(input).map((f) => f.code);
}

// GET /api/refunds?view=&before=
export async function listRefunds(viewRaw: string | null, beforeRaw: string | null): Promise<Res> {
  const view = (viewRaw || 'new') as typeof VIEWS[number];
  if (!(VIEWS as readonly string[]).includes(view)) return res(400, { error: 'Unknown view' });
  const before = beforeRaw ? iso(beforeRaw) : null;
  if (beforeRaw && !before) return res(400, { error: 'Bad date' });
  const now = Date.now();
  const countsRow = (await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'new')::int AS new,
            count(*) FILTER (WHERE status = 'new' AND seen_at IS NULL)::int AS unseen,
            count(*) FILTER (WHERE status = 'approved')::int AS approved,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE status = 'refunded')::int AS refunded,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
       FROM refund_requests`
  )).rows[0] || {};
  const sent = (await pool.query(
    `SELECT count(*)::int AS n FROM refund_links WHERE status = 'active' AND created_at > now() - interval '14 days'`
  )).rows[0];
  const counts = {
    new: Number(countsRow.new) || 0, unseen: Number(countsRow.unseen) || 0, approved: Number(countsRow.approved) || 0,
    rejected: Number(countsRow.rejected) || 0, refunded: Number(countsRow.refunded) || 0, cancelled: Number(countsRow.cancelled) || 0,
    sent: Number(sent?.n) || 0,
  };
  const st = refundFormsState();
  const setup = st === 'on' ? null : st;
  if (view === 'sent') {
    const links = (await pool.query(
      `SELECT l.id, l.order_id, l.order_snapshot, s.name AS panel, l.status, l.revoked_reason, l.created_at, l.expires_at,
              l.opened_count, l.last_opened_at, l.conversation_id
         FROM refund_links l LEFT JOIN sites s ON s.id = l.site_id
        WHERE l.status = 'active' AND l.created_at > now() - interval '14 days'
        ORDER BY l.created_at DESC LIMIT 100`
    )).rows;
    return res(200, {
      links: links.map((l) => ({
        id: l.id, order_id: l.order_id, customer_name: obj(l.order_snapshot).customer_name ?? null, panel: l.panel ?? null,
        sent_at: iso(l.created_at), expires_at: iso(l.expires_at), state: stateOf(l, now) === 'open' ? 'active' : 'expired',
        opened_count: Number(l.opened_count) || 0, last_opened_at: iso(l.last_opened_at), conversation_id: l.conversation_id,
      })),
      counts, next_before: null, setup,
    });
  }
  const rows = (await pool.query(
    `SELECT r.id, r.ref_code, r.status, r.seen_at, r.created_at, r.status_at, r.order_id, r.reason, r.sub_reason, r.order_snapshot,
            r.payout_method, r.payout_mask, r.holder_matches, r.return_needed, r.conversation_id, r.ack_message_id,
            s.name AS panel,
            EXISTS (SELECT 1 FROM refund_requests o
                     WHERE o.payout_fp = r.payout_fp AND o.id <> r.id
                       AND NOT (o.business_id = r.business_id AND o.order_id = r.order_id)) AS payout_reused,
            (SELECT count(*) FROM refund_requests p
              WHERE r.phone_fp IS NOT NULL AND p.phone_fp = r.phone_fp AND p.created_at > now() - interval '90 days')::int AS phone_count
       FROM refund_requests r LEFT JOIN sites s ON s.id = r.site_id
      WHERE ($1::text = 'all' OR r.status = $1::text) AND ($2::timestamptz IS NULL OR r.created_at < $2::timestamptz)
      ORDER BY r.created_at DESC LIMIT 101`,
    [view, before]
  )).rows;
  const page = rows.slice(0, 100);
  return res(200, {
    items: page.map((r) => {
      const snap = obj(r.order_snapshot);
      return {
        id: r.id, ref: r.ref_code, status: r.status, seen: !!r.seen_at, created_at: iso(r.created_at), status_at: iso(r.status_at),
        panel: r.panel ?? null, order_id: r.order_id, customer_name: snap.customer_name ?? null, reason: r.reason, sub_reason: r.sub_reason ?? null,
        total: num(snap.total), payment: snap.payment ?? null,
        payout: { method: r.payout_method, mask: r.payout_mask }, flags: listFlags(r, now),
        return_needed: !!r.return_needed, conversation_id: r.conversation_id,
      };
    }),
    counts, next_before: rows.length > 100 ? iso(page[page.length - 1].created_at) : null, setup,
  });
}

// GET /api/refunds/counts (the red badge next to the tab).
export async function refundCounts(): Promise<Res> {
  const r = (await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'new' AND seen_at IS NULL)::int AS unseen,
            count(*) FILTER (WHERE status = 'new')::int AS new,
            count(*) FILTER (WHERE status = 'approved')::int AS approved
       FROM refund_requests`
  )).rows[0] || {};
  return res(200, { unseen: Number(r.unseen) || 0, new: Number(r.new) || 0, approved: Number(r.approved) || 0 });
}

// Never payout_enc: the full details come only from revealPayout.
const REQ_COLS = `r.id, r.ref_code, r.link_id, r.conversation_id, r.site_id, r.business_id, r.order_id, r.order_snapshot, r.phone_fp,
       r.reason, r.sub_reason, r.checked_around, r.details, r.payout_method, r.payout_mask, r.payout_fp, r.holder_matches,
       r.consent_version, r.consent_at, r.submit_device, r.ack_message_id, r.status, r.status_at, r.refund_amount,
       r.refund_date::text AS refund_date, r.utr, r.gateway_checked, r.return_needed, r.return_note, r.return_told_at, r.seen_at, r.created_at`;
async function readRequest(db: Db, id: string): Promise<Row | null> {
  if (!UUID_RE.test(id || '')) return null;
  return (await db.query(`SELECT ${REQ_COLS} FROM refund_requests r WHERE r.id = $1`, [id.toLowerCase()])).rows[0] || null;
}
function detailRequest(r: Row) {
  return {
    id: r.id, ref: r.ref_code, status: r.status, status_at: iso(r.status_at), created_at: iso(r.created_at),
    reason: r.reason, sub_reason: r.sub_reason ?? null, checked_around: !!r.checked_around, details: r.details,
    consent_version: r.consent_version, consent_at: iso(r.consent_at), device: r.submit_device ?? null,
    payout: {
      method: r.payout_method, mask: r.payout_mask, bank_name: r.payout_method === 'bank' ? bankName(r.payout_mask) : null,
      holder_matches: r.holder_matches ?? null,
    },
    refund_amount: num(r.refund_amount), refund_date: r.refund_date ?? null, utr: r.utr ?? null, gateway_checked: !!r.gateway_checked,
    return_needed: !!r.return_needed, return_note: r.return_note ?? null, return_told_at: iso(r.return_told_at),
    ack_posted: !!r.ack_message_id,
  };
}

interface MsgView { step: string; id: string | null; at: string | null; lang: string | null; emailed: boolean | null; failed: boolean }
async function messagesOf(r: Row): Promise<MsgView[]> {
  const evs = (await pool.query(
    `SELECT id, created_at, kind, link_id, meta FROM refund_events
      WHERE (request_id = $1 OR link_id = $2) AND kind IN ('link_sent', 'message_posted', 'message_failed', 'email_sent', 'email_failed')
      ORDER BY id`,
    [r.id, r.link_id]
  )).rows;
  const out: MsgView[] = [];
  for (const e of evs) {
    const meta = obj(e.meta);
    if (e.kind === 'link_sent' && e.link_id === r.link_id) {
      out.push({ step: 'form', id: (meta.message_id as string) ?? null, at: iso(e.created_at), lang: (meta.lang as string) ?? null, emailed: null, failed: false });
    } else if (e.kind === 'message_posted') {
      out.push({ step: String(meta.step ?? ''), id: (meta.message_id as string) ?? null, at: iso(e.created_at), lang: (meta.lang as string) ?? null, emailed: null, failed: false });
    } else if (e.kind === 'message_failed') {
      out.push({ step: String(meta.step ?? ''), id: null, at: iso(e.created_at), lang: null, emailed: null, failed: true });
    }
  }
  for (const e of evs) {
    if (e.kind !== 'email_sent' && e.kind !== 'email_failed') continue;
    const m = out.find((x) => x.id && x.id === obj(e.meta).message_id);
    if (m) m.emailed = e.kind === 'email_sent';
  }
  return out;
}

async function orderNowOf(r: Row): Promise<{ now: Record<string, unknown> | null; changed: boolean }> {
  const o = (await pool.query(
    `SELECT o.order_total, o.customer_mobile, o.tracking_status, o.delivered_at, o.is_cancelled FROM orders o
      WHERE o.order_id = $1 AND o.business_id::text = $2::text LIMIT 2`,
    [r.order_id, r.business_id]
  )).rows;
  if (o.length !== 1) return { now: null, changed: false };
  const snap = obj(r.order_snapshot);
  const now = {
    tracking_status: o[0].tracking_status ?? null, delivered_at: iso(o[0].delivered_at), is_cancelled: !!o[0].is_cancelled,
    total: num(o[0].order_total), phone_last4: last4(o[0].customer_mobile),
  };
  const changed = (num(snap.total) !== null && now.total !== null && num(snap.total) !== now.total)
    || (!!snap.phone_last4 && !!now.phone_last4 && snap.phone_last4 !== now.phone_last4);
  return { now, changed };
}

async function flagsOf(r: Row, extra: { now: Record<string, unknown> | null; changed: boolean; nets: number; msgs: MsgView[]; caseKind: string | null | undefined }, nowMs: number): Promise<Flag[]> {
  const snap = obj(r.order_snapshot);
  const reused = (await pool.query(
    `SELECT ref_code FROM refund_requests WHERE payout_fp = $1 AND id <> $2 AND NOT (business_id = $3 AND order_id = $4)
      ORDER BY created_at DESC LIMIT 5`,
    [r.payout_fp, r.id, r.business_id, r.order_id]
  )).rows.map((x) => String(x.ref_code));
  let phoneCount = 0;
  if (r.phone_fp) {
    phoneCount = Number((await pool.query(
      `SELECT count(*)::int AS n FROM refund_requests WHERE phone_fp = $1 AND created_at > now() - interval '90 days'`, [r.phone_fp]
    )).rows[0]?.n) || 0;
  }
  const order = extra.now || snap;
  return computeFlags({
    paymentRaw: snap.payment_raw ?? snap.payment ?? '',
    delivered: isDelivered(order as Row),
    reason: r.reason,
    isCancelled: !!(order as Row).is_cancelled,
    holderMatches: r.holder_matches ?? null,
    orderName: (snap.customer_name as string) ?? null,
    payoutReusedRefs: reused,
    phoneRequests90d: phoneCount,
    orderChanged: extra.changed,
    openNetworks: extra.nets,
    ackPosted: !!r.ack_message_id,
    createdAtMs: ms(r.created_at),
    nowMs,
    emailFailed: extra.msgs.some((m) => m.id && m.emailed === false),
    caseKind: extra.caseKind,
  });
}

// GET /api/refunds/<id>: the drawer. Marks it seen; a 'viewed' event at most every 10 minutes.
export async function getRefund(id: string): Promise<Res> {
  const r = await readRequest(pool, id);
  if (!r) return res(404, { error: 'Not found' });
  const nowMs = Date.now();
  if (!r.seen_at) await pool.query(`UPDATE refund_requests SET seen_at = now() WHERE id = $1 AND seen_at IS NULL`, [r.id]);
  const recent = (await pool.query(
    `SELECT 1 AS x FROM refund_events WHERE request_id = $1 AND kind = 'viewed' AND created_at > now() - interval '10 minutes' LIMIT 1`, [r.id]
  )).rows.length;
  if (!recent) await softEvent({ link_id: r.link_id, request_id: r.id, conversation_id: r.conversation_id, kind: 'viewed', actor: 'owner' });
  return res(200, await detailOf(r, nowMs));
}

async function detailOf(r: Row, nowMs: number): Promise<Record<string, unknown>> {
  const link = (await pool.query(
    `SELECT created_at, expires_at, opened_count, first_opened_at, last_opened_at, submitted_at, lang FROM refund_links WHERE id = $1`, [r.link_id]
  )).rows[0] || {};
  const opens = (await pool.query(
    `SELECT count(DISTINCT ip_hash)::int AS nets, array_remove(array_agg(DISTINCT meta->>'device'), NULL) AS devices
       FROM refund_events WHERE link_id = $1 AND kind = 'link_opened'`,
    [r.link_id]
  )).rows[0] || {};
  const target = await targetConversation(pool, r.conversation_id, false);
  const order = await orderNowOf(r);
  const msgs = await messagesOf(r);
  const flags = await flagsOf(r, { ...order, nets: Number(opens.nets) || 0, msgs, caseKind: target ? target.case_kind : undefined }, nowMs);
  const events = (await pool.query(
    `SELECT id, created_at, kind, actor, from_status, to_status, note, meta FROM refund_events
      WHERE request_id = $1 OR link_id = $2 ORDER BY id DESC LIMIT 100`,
    [r.id, r.link_id]
  )).rows.reverse();
  const lang: Lang = target ? await chatLang(pool, target.id, pickLang(link.lang) || 'en') : pickLang(link.lang) || 'en';
  const allowed: string[] = [...actionsFor(r.status), 'note'];
  if (r.status !== 'cancelled') allowed.push('return');
  if (r.return_needed && !r.return_told_at && r.status !== 'cancelled') allowed.push('tell_return');
  if (!r.ack_message_id) allowed.push('post_ack');
  if (msgs.some((m) => m.id && m.emailed === false)) allowed.push('retry_email');
  const both = (step: Step, vars = {}) => ({ en: chatMessage(step, 'en', vars), hinglish: chatMessage(step, 'hinglish', vars) });
  return {
    request: detailRequest(r),
    order: { snapshot: obj(r.order_snapshot), now: order.now, changed: order.changed },
    chat: {
      conversation_id: r.conversation_id, live_id: target ? target.id : null, channel: target?.source === 'email' ? 'email' : 'chat',
      status: target ? target.status : null, case_kind: target ? target.case_kind : null,
      open_url: target ? `/admin/chat?open=${encodeURIComponent(target.id)}` : null,
    },
    link: {
      sent_at: iso(link.created_at), expires_at: iso(link.expires_at), opened_count: Number(link.opened_count) || 0,
      first_opened_at: iso(link.first_opened_at), last_opened_at: iso(link.last_opened_at), submitted_at: iso(link.submitted_at),
      devices: Array.isArray(opens.devices) ? opens.devices.slice(0, 10) : [],
    },
    flags,
    messages: msgs,
    events: events.map((e) => ({
      at: iso(e.created_at), kind: e.kind, actor: e.actor, from: e.from_status ?? null, to: e.to_status ?? null, note: e.note ?? null, meta: e.meta ?? null,
    })),
    allowed,
    lang,
    previews: {
      approved: both('approved'), rejected: both('rejected'), return: both('return'),
      refunded: both('refunded', { utr: '{utr}', amount: '{amount}', date: '{date}', method: r.payout_method }),
    },
  };
}

// POST /api/refunds/<id>/reveal: the full UPI / bank details, recorded (event 'revealed'), 30 an hour.
export async function revealPayout(id: string, ip: string, ua: string | null): Promise<Res> {
  if (!refundCryptoReady()) return res(503, { error: 'key_missing' });
  if (hit('rf:reveal', REFUND_LIMITS.reveal.max, REFUND_LIMITS.reveal.windowMs)) return res(429, { error: 'Too many full views in the last hour. Try again later.' });
  if (!UUID_RE.test(id || '')) return res(404, { error: 'Not found' });
  const r = (await pool.query(`SELECT id, link_id, conversation_id, payout_enc FROM refund_requests WHERE id = $1`, [id.toLowerCase()])).rows[0];
  if (!r) return res(404, { error: 'Not found' });
  let p: Record<string, unknown>;
  try {
    p = openJson<Record<string, unknown>>(r.payout_enc, payoutAad(r.id));
  } catch (e) {
    const code = e instanceof RefundCryptoError ? e.code : '-';
    console.error(`[refund] decrypt failed ${r.id} ${code}`);
    return res(500, { error: 'These details cannot be read. Cancel this request and send a new form from the chat.' });
  }
  // Recorded before anything is shown: no record, no details.
  await logRefundEvent(pool, { link_id: r.link_id, request_id: r.id, conversation_id: r.conversation_id, kind: 'revealed', actor: 'owner', ip_hash: ipHash(ip), meta: { device: deviceLabel(ua) } });
  const payout = p.method === 'bank'
    ? { method: 'bank', account: p.account, ifsc: p.ifsc, bank_name: bankName(String(p.ifsc ?? '')), holder: p.holder }
    : { method: 'upi', upi: p.upi, holder: p.holder };
  return res(200, { payout });
}

// ── PATCH /api/refunds/<id> (spec 3.5) ─────────────────────────
// approve / reject / refunded / cancel: a compare-and-set on the status the screen showed (`expect`),
// the customer's message in the SAME transaction (none for cancel), email after commit. The DB trigger
// is the second gate on every move. note / return / tell_return / post_ack / retry_email as listed.
export async function patchRefund(user: AuthUser, id: string, body: unknown): Promise<Res> {
  const b = obj(body);
  const action = String(b.action ?? '');
  const r = await readRequest(pool, id);
  if (!r) return res(404, { error: 'Not found' });
  if (isMoveAction(action)) return moveStatus(user, r, action, b);
  if (action === 'note') {
    const n = checkNote(b.note, true);
    if (!n.ok) return res(400, { error: 'Write a note (up to 500 characters).', errors: { note: n.code } });
    await logRefundEvent(pool, { link_id: r.link_id, request_id: r.id, conversation_id: r.conversation_id, kind: 'note', actor: 'owner', note: n.value });
    return res(200, { ok: true, request: detailRequest(r), message: null, emailed: null });
  }
  if (action === 'return') {
    if (typeof b.needed !== 'boolean') return res(400, { error: 'needed must be true or false' });
    const n = checkReturnNote(b.note);
    if (!n.ok) return res(400, { error: 'The return note can be up to 300 characters.', errors: { note: n.code } });
    const u = await pool.query(
      `UPDATE refund_requests SET return_needed = $2, return_note = $3 WHERE id = $1 AND status <> 'cancelled' RETURNING id`,
      [r.id, b.needed, b.needed ? n.value : null]
    );
    if (!u.rows.length) return res(409, { error: 'A cancelled request has no return.' });
    await logRefundEvent(pool, {
      link_id: r.link_id, request_id: r.id, conversation_id: r.conversation_id, kind: 'return_flag', actor: 'owner',
      note: b.needed ? n.value : null, meta: { needed: b.needed },
    });
    return res(200, { ok: true, request: detailRequest(await readRequest(pool, r.id)), message: null, emailed: null });
  }
  if (action === 'tell_return') return tellReturn(r, pickLang(b.lang));
  if (action === 'post_ack') {
    if (r.ack_message_id) return res(409, { error: 'The "form received" message is already in the chat.' });
    const posted = await postAck(r.id);
    if (!posted) return res(409, { error: 'The "form received" message is already in the chat.' });
    return res(200, { ok: true, request: detailRequest(await readRequest(pool, r.id)), message: { id: posted.message_id, step: 'received' }, emailed: null });
  }
  if (action === 'retry_email') return retryEmail(r, b.message_id);
  return res(400, { error: 'Unknown action' });
}

async function moveStatus(user: AuthUser, r: Row, action: 'approve' | 'reject' | 'refunded' | 'cancel', b: Record<string, unknown>): Promise<Res> {
  const expect = typeof b.expect === 'string' && (STATUSES as string[]).includes(b.expect) ? (b.expect as Status) : null;
  if (!expect) return res(400, { error: 'Reload and try again.' });
  const snap = obj(r.order_snapshot);
  const nowMs = Date.now();
  const v = validateMove(action, {
    status: expect, note: b.note, utr: b.utr, amount: b.amount, refund_date: b.refund_date, gateway_checked: b.gateway_checked,
    method: r.payout_method, payment_raw: snap.payment_raw ?? snap.payment ?? '', order_total: snap.total, submitted_at: r.created_at, now: nowMs,
  });
  if (!v.ok) {
    const errors = (v as { errors: Record<string, string> }).errors;
    if (errors.status === 'move_not_allowed') return res(409, { error: `This is not allowed for a request that is ${STATUS_WORD[expect] || expect}. Reload.`, errors });
    return res(400, { error: 'Please check the highlighted fields.', errors });
  }
  const mv = (v as { value: MoveValue }).value;
  const actor = staffActor(user);
  let out: { row: Row; msg: { id: string } | null; text: string | null; target: TargetChat | null } | null;
  try {
    out = await withTransaction(async (client) => {
      const db = tx(client);
      await db.query(`SET LOCAL lock_timeout = '5s'`);
      const u = await db.query(
        `UPDATE refund_requests
            SET status = $3, status_at = now(), status_by = 'owner',
                utr = $4, refund_amount = $5, refund_date = $6::date, gateway_checked = COALESCE($7::boolean, gateway_checked)
          WHERE id = $1 AND status = $2
          RETURNING id, ref_code, status, conversation_id, link_id, payout_method`,
        [r.id, expect, mv.to, mv.utr, mv.amount, mv.refund_date, action === 'refunded' ? mv.gateway_checked : null]
      );
      const row = u.rows[0];
      if (!row) return null;
      let msg: { id: string } | null = null, text: string | null = null, target: TargetChat | null = null;
      if (mv.message) {
        target = await targetConversation(db, row.conversation_id, true);
        if (!target) throw Object.assign(new Error('refund chat missing'), { code: 'RF_NO_CHAT' });
        const linkLang = (await db.query(`SELECT lang FROM refund_links WHERE id = $1`, [row.link_id])).rows[0]?.lang;
        const lang = pickLang(b.lang) || await chatLang(db, target.id, pickLang(linkLang) || 'en');
        text = chatMessage(mv.message, lang, mv.message === 'refunded'
          ? { utr: mv.utr, amount: mv.amount, date: mv.refund_date, method: row.payout_method }
          : {});
        msg = await postRefundMessage(db, target, mv.message, text, lang, { actor });
        await logRefundEvent(db, { link_id: row.link_id, request_id: row.id, conversation_id: target.id, kind: 'status', actor: 'owner', from_status: expect, to_status: mv.to, note: mv.note });
        await logRefundEvent(db, {
          link_id: row.link_id, request_id: row.id, conversation_id: target.id, kind: 'message_posted', actor: 'system',
          meta: { step: mv.message, message_id: msg.id, lang },
        });
      } else {
        await logRefundEvent(db, { link_id: row.link_id, request_id: row.id, conversation_id: row.conversation_id, kind: 'status', actor: 'owner', from_status: expect, to_status: mv.to, note: mv.note });
      }
      return { row, msg, text, target };
    });
  } catch (e) {
    const constraint = String((e as { constraint?: unknown })?.constraint ?? '');
    if (codeOf(e) === '23505' && constraint === 'refund_requests_utr') {
      // The other request's ref is read again here, never from the error's text.
      const other = (await pool.query(`SELECT ref_code FROM refund_requests WHERE utr = $1 AND id <> $2 LIMIT 1`, [mv.utr, r.id])).rows[0];
      return res(409, { error: `This UTR is already on ${other?.ref_code || 'another request'}.`, errors: { utr: 'utr_used' } });
    }
    if (codeOf(e) === '23505' && constraint === 'refund_requests_one_open') {
      const other = (await pool.query(
        `SELECT ref_code FROM refund_requests WHERE business_id = $1 AND order_id = $2 AND id <> $3 AND status IN ('new', 'approved', 'refunded') LIMIT 1`,
        [r.business_id, r.order_id, r.id]
      )).rows[0];
      return res(409, { error: `Another request for this order is open (${other?.ref_code || 'see the list'}).` });
    }
    if (codeOf(e) === '23514') return res(409, { error: 'This move is not allowed now. Reload.' });
    throw e;
  }
  if (!out) {
    const cur = (await pool.query(`SELECT status, status_at FROM refund_requests WHERE id = $1`, [r.id])).rows[0];
    return res(409, { error: `Already ${STATUS_WORD[cur?.status] || cur?.status || 'changed'} at ${formatDateTime(iso(cur?.status_at)) || '-'}. Reload.`, status: cur?.status ?? null });
  }
  console.log(`[refund] ${out.row.ref_code} ${expect} -> ${mv.to}`);
  let emailed: boolean | null = null;
  if (out.msg && out.target && out.target.source === 'email') {
    emailed = await deliverEmail(out.target, out.msg.id, out.text as string, { step: mv.message as Step, request_id: r.id, link_id: r.link_id });
  }
  return res(200, {
    ok: true, request: detailRequest(await readRequest(pool, r.id)),
    message: out.msg ? { id: out.msg.id, step: mv.message } : null, emailed,
    ...(mv.warnings.length ? { warnings: mv.warnings } : {}),
  });
}

// "Tell customer" about the return pickup: once (compare-and-set on return_told_at).
async function tellReturn(r: Row, langPick: Lang | null): Promise<Res> {
  const out = await withTransaction(async (client) => {
    const db = tx(client);
    await db.query(`SET LOCAL lock_timeout = '5s'`);
    const u = (await db.query(
      `UPDATE refund_requests SET return_told_at = now()
        WHERE id = $1 AND return_needed AND return_told_at IS NULL AND status <> 'cancelled'
        RETURNING id, conversation_id, link_id`,
      [r.id]
    )).rows[0];
    if (!u) return null;
    const target = await targetConversation(db, u.conversation_id, true);
    if (!target) throw Object.assign(new Error('refund chat missing'), { code: 'RF_NO_CHAT' });
    const linkLang = (await db.query(`SELECT lang FROM refund_links WHERE id = $1`, [u.link_id])).rows[0]?.lang;
    const lang = langPick || await chatLang(db, target.id, pickLang(linkLang) || 'en');
    const text = chatMessage('return', lang);
    const msg = await postRefundMessage(db, target, 'return', text, lang);
    await logRefundEvent(db, { link_id: u.link_id, request_id: u.id, conversation_id: target.id, kind: 'return_told', actor: 'owner' });
    await logRefundEvent(db, {
      link_id: u.link_id, request_id: u.id, conversation_id: target.id, kind: 'message_posted', actor: 'system',
      meta: { step: 'return', message_id: msg.id, lang },
    });
    return { target, msg, text };
  });
  if (!out) return res(409, { error: 'Already told, or no return is set for this request.' });
  let emailed: boolean | null = null;
  if (out.target.source === 'email') emailed = await deliverEmail(out.target, out.msg.id, out.text, { step: 'return', request_id: r.id, link_id: r.link_id });
  return res(200, { ok: true, request: detailRequest(await readRequest(pool, r.id)), message: { id: out.msg.id, step: 'return' }, emailed });
}

// Send a refund message's email again (no new message row): only one whose last email failed.
async function retryEmail(r: Row, messageId: unknown): Promise<Res> {
  const msgs = await messagesOf(r);
  const m = msgs.find((x) => x.id && x.id === messageId);
  if (!m || m.emailed !== false) return res(409, { error: 'This message has no failed email to send again.' });
  const row = (await pool.query(`SELECT id, conversation_id, content FROM messages WHERE id = $1 AND sender = 'system'`, [m.id])).rows[0];
  if (!row) return res(404, { error: 'Not found' });
  const target = await targetConversation(pool, row.conversation_id, false);
  if (!target || target.source !== 'email') return res(409, { error: 'This chat is not an email chat.' });
  const emailed = await deliverEmail(target, row.id, String(row.content), { step: m.step as Step, request_id: r.id, link_id: r.link_id });
  return res(200, { ok: true, request: detailRequest(r), message: { id: row.id, step: m.step }, emailed });
}
