import { withTransaction } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { staffActor } from '@/lib/chat/team-routing';
import {
  STATUSES, UUID_RE, actionsFor, checkNote, checkReturnNote, computeFlags, deviceLabel, isDelivered, isMoveAction, validateMove,
  type Flag, type FlagInput, type MoveValue, type Status,
} from './rules';
import { bankName, chatMessage, formatDateTime, type Lang, type Step } from './texts';
import { ipHash, openJson, payoutAad, refundCryptoReady, refundFormsState, RefundCryptoError } from './crypto';
import { hit, REFUND_LIMITS } from './limits';
import {
  type Db, type Res, type Row, type TargetChat, byMeta, chatLang, codeOf, deliverEmail, iso, last4, logRefundEvent, ms, num, obj, pickLang, pool,
  postRefundMessage, res, softEvent, stateOf, targetConversation, tx,
} from './server-shared';
import { STATUS_WORD } from './server-send';
import { postAck } from './server-public';

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
// scope: the panels this login may see (null = every panel; the Manager limited to some panels sees only theirs).
export async function listRefunds(viewRaw: string | null, beforeRaw: string | null, scope: string[] | null = null): Promise<Res> {
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
       FROM refund_requests WHERE ($1::text[] IS NULL OR business_id = ANY($1::text[]))`, [scope]
  )).rows[0] || {};
  const sent = (await pool.query(
    `SELECT count(*)::int AS n FROM refund_links WHERE status = 'active' AND created_at > now() - interval '14 days'
        AND ($1::text[] IS NULL OR business_id = ANY($1::text[]))`, [scope]
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
          AND ($1::text[] IS NULL OR l.business_id = ANY($1::text[]))
        ORDER BY l.created_at DESC LIMIT 100`, [scope]
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
        AND ($3::text[] IS NULL OR r.business_id = ANY($3::text[]))
      ORDER BY r.created_at DESC LIMIT 101`,
    [view, before, scope]
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
export async function refundCounts(scope: string[] | null = null): Promise<Res> {
  const r = (await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'new' AND seen_at IS NULL)::int AS unseen,
            count(*) FILTER (WHERE status = 'new')::int AS new,
            count(*) FILTER (WHERE status = 'approved')::int AS approved
       FROM refund_requests WHERE ($1::text[] IS NULL OR business_id = ANY($1::text[]))`, [scope]
  )).rows[0] || {};
  return res(200, { unseen: Number(r.unseen) || 0, new: Number(r.new) || 0, approved: Number(r.approved) || 0 });
}

// GET /api/refunds/counts?byPanel=1 (the panel board, owner 2026-10-09): new requests per panel, { by_panel: { <business_id>: n } }.
// Kept here so the refund tables stay inside the refund files (refund-isolation I2); the board reads it over HTTP.
export async function refundCountsByPanel(scope: string[] | null = null): Promise<Res> {
  const r = await pool.query(`SELECT business_id, count(*)::int AS n FROM refund_requests WHERE status = 'new' AND ($1::text[] IS NULL OR business_id = ANY($1::text[])) GROUP BY business_id`, [scope]);
  const by_panel: Record<string, number> = {};
  for (const row of r.rows as { business_id: string; n: number }[]) by_panel[String(row.business_id)] = Number(row.n) || 0;
  return res(200, { by_panel });
}

// A request outside the login's panels is "not found" (the Manager limited to some panels).
const inScope = (r: Row, scope: string[] | null) => !scope || scope.includes(String(r.business_id));

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
export async function getRefund(id: string, scope: string[] | null = null, user?: AuthUser | null): Promise<Res> {
  const r = await readRequest(pool, id);
  if (!r || !inScope(r, scope)) return res(404, { error: 'Not found' });
  const nowMs = Date.now();
  if (!r.seen_at) await pool.query(`UPDATE refund_requests SET seen_at = now() WHERE id = $1 AND seen_at IS NULL`, [r.id]);
  const recent = (await pool.query(
    `SELECT 1 AS x FROM refund_events WHERE request_id = $1 AND kind = 'viewed' AND created_at > now() - interval '10 minutes' LIMIT 1`, [r.id]
  )).rows.length;
  if (!recent) await softEvent({ link_id: r.link_id, request_id: r.id, conversation_id: r.conversation_id, kind: 'viewed', actor: 'owner', meta: byMeta(user) });
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
export async function patchRefund(user: AuthUser, id: string, body: unknown, scope: string[] | null = null): Promise<Res> {
  const b = obj(body);
  const action = String(b.action ?? '');
  const r = await readRequest(pool, id);
  if (!r || !inScope(r, scope)) return res(404, { error: 'Not found' });
  if (isMoveAction(action)) return moveStatus(user, r, action, b);
  if (action === 'note') {
    const n = checkNote(b.note, true);
    if (!n.ok) return res(400, { error: 'Write a note (up to 500 characters).', errors: { note: n.code } });
    await logRefundEvent(pool, { link_id: r.link_id, request_id: r.id, conversation_id: r.conversation_id, kind: 'note', actor: 'owner', note: n.value, meta: byMeta(user) });
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
        await logRefundEvent(db, { link_id: row.link_id, request_id: row.id, conversation_id: target.id, kind: 'status', actor: 'owner', from_status: expect, to_status: mv.to, note: mv.note, meta: byMeta(user) });
        await logRefundEvent(db, {
          link_id: row.link_id, request_id: row.id, conversation_id: target.id, kind: 'message_posted', actor: 'system',
          meta: { step: mv.message, message_id: msg.id, lang },
        });
      } else {
        await logRefundEvent(db, { link_id: row.link_id, request_id: row.id, conversation_id: row.conversation_id, kind: 'status', actor: 'owner', from_status: expect, to_status: mv.to, note: mv.note, meta: byMeta(user) });
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
