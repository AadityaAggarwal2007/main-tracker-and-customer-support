import { randomBytes, randomUUID } from 'crypto';
import { withTransaction } from '@/lib/db';
import { maskSensitive } from '@/lib/chat/sensitive';
import {
  CONSENT_VERSION, DETAILS_MIN, DETAILS_MAX, PUBLIC_STATUS, deviceLabel, istDay, namesMatch, newRefCode, payoutFpInput, statusViewOpen,
  validateSubmit, type Status, type SubmitInput,
} from './rules';
import { chatMessage, payoutLabel, type Lang } from './texts';
import { fingerprint, ipHash, payoutAad, sealJson } from './crypto';
import { hash8, hit, REFUND_LIMITS } from './limits';
import { noteBadToken, INVALID } from './public';
import {
  type Res, type Row, chatLang, codeOf, deliverEmail, iso, logFail, logRefundEvent, num, obj, orderKey, pickLang, pool, postRefundMessage, res,
  softEvent, stateOf, targetConversation, tx,
} from './server-shared';

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
