import { query } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { can, canAccessPanel, isTeamLead, panelScope } from '@/lib/permissions';
import { loadForUser } from './thread-read';
import { verifiedSenders } from './mail-verify';
import { maskOrder } from './team-verify-rules';
import type { MailBoxInfo } from './mail-inbox';
import {
  ACTION_FROM, ACTION_STATUS, CORRECTION_TEXT, OVERDUE_MS, changedAt, changedWhat, cleanCorrection, cleanDoneNote, correctionSegment, isCorrectionAction,
  type ChangedWhat, type CorrectionAction, type CorrectionCounts, type CorrectionSegment,
} from './corrections-rules';
import { CORRECTION_COLS, missingCorrections, withChanges, type CorrectionRow } from './corrections-read';

// ── Corrections: the database side with the rights (owner 2026-10-11) ────────────────────────────────
// Rules in corrections-rules.ts; the light reads (thread, inbox rows, board) in corrections-read.ts. Here:
//   createForChat   a login with chat.view + chat.reply, inside its panels, on a website / email chat (never WhatsApp,
//                   never a merged shell) whose customer is VERIFIED (verified_order_id; an old 'legacy' check counts,
//                   as the thread treats it: Chikki answers it as verified and the Verify button is not offered on it;
//                   a phone match never counts: it is not verification). The row's order is the verified order.
//   createForMail   through the Mail tab (mailAccess 'reply' is checked by the route): the sender must be verified for an
//                   order of that panel (mail-verify.ts verifiedSenders, the team's or the automatic check); several
//                   verified orders = the body names one. The row keeps the mailbox + uid + address and the sender's chat
//                   for that order when one exists (the same chat the Customer card opens).
//   listCorrections every login with chat.view sees EVERY row of its panels (owner answer 1), pending oldest first
//                   (the forgotten one on top), done / cancelled newest first, 300 at most, with the customer name from
//                   the order and the counts {pending, overdue, done_today}.
//   setCorrection   done / cancel / reopen: the Super Admin and the Manager (team.lead) only, inside their panels.
// One log line per create and close, with the order masked (team-verify-rules maskOrder); the note is NEVER logged
// (it can hold an address or a phone number). Nothing is sent to the customer by any of this.

export type CorrectionResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const refuse = <T,>(status: number, error: string): CorrectionResult<T> => ({ ok: false, status, error });

// Who did it: the Super Admin is 'owner', a member their team_users id (a rename never changes it), as mail-verify.ts.
const actorKey = (u: AuthUser): string => (u.role === 'admin' ? 'owner' : (u.id || u.username));
const actorName = (u: AuthUser): string => (u.role === 'admin' ? 'Super Admin' : (u.displayName || u.username));

export interface CorrectionListRow extends CorrectionRow {
  panel_name: string | null;
  customer_name: string | null;
  // The chat it points at is still verified for this very order (the panel's Edit address / Edit items work on it).
  chat_verified: boolean;
  overdue: boolean;
  age_ms: number;
  // Owner 2026-10-12: Active / Changed / Done. Changed = the order's address or items were edited after this was written.
  segment: CorrectionSegment;
  changed_at: string | null;
  changed_what: ChangedWhat | null;
  changed_by_name: string | null;
  address_changed_at?: string | Date | null;
  items_changed_at?: string | Date | null;
}
export interface CorrectionList { rows: CorrectionListRow[]; counts: CorrectionCounts; installed: boolean }

const INSERT_SQL = `INSERT INTO order_corrections (business_id, source, conversation_id, mail_box_id, mail_uid, customer_email, order_id, kinds, note, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11)
    RETURNING id::text AS id, business_id, source, conversation_id, mail_box_id, mail_uid::int AS mail_uid, customer_email, order_id, kinds, note, status,
              created_by, created_by_name, created_at, done_by, done_by_name, done_at, done_note, updated_at`;

async function insertRow(v: {
  businessId: string; source: 'chat' | 'email' | 'mail'; conversationId: string | null; mailBoxId: string | null; mailUid: number | null;
  customerEmail: string | null; orderId: string; kinds: string[]; note: string; user: AuthUser;
}): Promise<CorrectionResult<CorrectionRow>> {
  try {
    const r = await query<CorrectionRow>(INSERT_SQL, [
      v.businessId, v.source, v.conversationId, v.mailBoxId, v.mailUid, v.customerEmail, v.orderId, v.kinds, v.note, actorKey(v.user), actorName(v.user),
    ]);
    const row = r.rows[0];
    if (!row) return refuse(500, 'Could not save the correction');
    console.log(`[correction] id=${row.id} panel=${row.business_id} order=${maskOrder(row.order_id)} kinds=${row.kinds.join(',')} source=${row.source} by ${actorKey(v.user)}`);
    return { ok: true, value: row };
  } catch (e) {
    if (missingCorrections(e)) return refuse(503, CORRECTION_TEXT.notInstalled);
    throw e;
  }
}

export async function createForChat(user: AuthUser, conversationId: string, body: unknown): Promise<CorrectionResult<CorrectionRow>> {
  if (!can(user, 'chat.view') || !can(user, 'chat.reply')) return refuse(403, CORRECTION_TEXT.cannot);
  const conv = await loadForUser(conversationId, user);
  if (!conv) return refuse(404, 'Not found');
  if (conv.source === 'whatsapp') return refuse(400, CORRECTION_TEXT.whatsapp);
  if (conv.merged_into) return refuse(409, CORRECTION_TEXT.merged);
  if (!conv.verified_order_id) return refuse(409, CORRECTION_TEXT.verifyFirst);
  if (!conv.tracker_business_id) return refuse(400, CORRECTION_TEXT.noPanel);
  const clean = cleanCorrection(body);
  if ('error' in clean) return refuse(400, clean.error);
  return insertRow({
    businessId: String(conv.tracker_business_id), source: conv.source === 'email' ? 'email' : 'chat', conversationId: conv.id,
    mailBoxId: null, mailUid: null, customerEmail: null, orderId: conv.verified_order_id, kinds: clean.kinds, note: clean.note, user,
  });
}

export async function createForMail(user: AuthUser, box: MailBoxInfo, uid: number, body: unknown): Promise<CorrectionResult<CorrectionRow>> {
  const b = (body && typeof body === 'object' ? body : {}) as { email?: unknown; orderId?: unknown };
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!email || !Number.isInteger(uid) || uid <= 0) return refuse(400, 'The mail and its sender are needed.');
  if (!box.panelId) return refuse(400, 'This mailbox is not linked to a panel, so no order can be corrected.');
  const vers = (await verifiedSenders(box.panelId, [email]))[email] || [];
  if (vers.length === 0) return refuse(409, CORRECTION_TEXT.verifySenderFirst);
  const wanted = typeof b.orderId === 'string' ? b.orderId.trim() : '';
  let pick = vers[0];
  if (vers.length > 1 || wanted) {
    if (!wanted) return refuse(409, CORRECTION_TEXT.pickOrder);
    const found = vers.find((v) => v.orderId === wanted || v.orderId.replace(/^#/, '') === wanted.replace(/^#/, ''));
    if (!found) return refuse(409, CORRECTION_TEXT.wrongOrder);
    pick = found;
  }
  const clean = cleanCorrection(body);
  if ('error' in clean) return refuse(400, clean.error);
  return insertRow({
    businessId: String(box.panelId), source: 'mail', conversationId: pick.chatId, mailBoxId: box.id, mailUid: uid, customerEmail: email,
    orderId: pick.orderId, kinds: clean.kinds, note: clean.note, user,
  });
}

export async function listCorrections(user: AuthUser, opts: { status?: string | null; panel?: string | null; now?: number } = {}): Promise<CorrectionResult<CorrectionList>> {
  if (!can(user, 'chat.view')) return refuse(403, 'You cannot open Chat Support');
  const scope = panelScope(user);
  let panels = scope;
  if (opts.panel) {
    if (!canAccessPanel(user, opts.panel)) return refuse(404, 'Not found');
    panels = [opts.panel];
  }
  // 'active' / 'changed' (both pending; owner 2026-10-12), 'pending' (both), 'done' (done + cancelled: the Done tab);
  // anything else = everything.
  const seg = opts.status === 'active' || opts.status === 'changed' ? opts.status : null;
  const status = opts.status === 'pending' || seg ? ['pending'] : opts.status === 'done' ? ['done', 'cancelled'] : null;
  const now = opts.now ?? Date.now();
  try {
    const r = await withChanges<CorrectionListRow>((_changed, cols) =>
      `SELECT ${CORRECTION_COLS},
              (SELECT b.name FROM businesses b WHERE b.id::text = x.business_id LIMIT 1) AS panel_name,
              (SELECT NULLIF(btrim(o.customer_name), '') FROM orders o WHERE o.order_id = x.order_id AND o.business_id::text = x.business_id ORDER BY o.created_at DESC LIMIT 1) AS customer_name,
              COALESCE((SELECT c.verified_order_id = x.order_id AND c.merged_into IS NULL FROM conversations c WHERE c.id = x.conversation_id), false) AS chat_verified,
              ${cols}
         FROM order_corrections x
        WHERE ($1::text[] IS NULL OR x.business_id = ANY($1::text[]))
          AND ($2::text[] IS NULL OR x.status = ANY($2::text[]))
        ORDER BY (x.status = 'pending') DESC,
                 CASE WHEN x.status = 'pending' THEN x.created_at END ASC,
                 COALESCE(x.done_at, x.updated_at) DESC
        LIMIT 300`,
      [panels, status]);
    const c = await withChanges<{ pending: number; overdue: number; done_today: number; changed: number }>((changed) =>
      `SELECT count(*) FILTER (WHERE x.status = 'pending')::int AS pending,
              count(*) FILTER (WHERE x.status = 'pending' AND NOT ${changed} AND x.created_at <= now() - interval '${Math.round(OVERDUE_MS / 3600000)} hours')::int AS overdue,
              count(*) FILTER (WHERE x.status = 'done' AND x.done_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS done_today,
              count(*) FILTER (WHERE x.status = 'pending' AND ${changed})::int AS changed
         FROM order_corrections x WHERE ($1::text[] IS NULL OR x.business_id = ANY($1::text[]))`,
      [panels]);
    let rows: CorrectionListRow[] = r.rows.map((row) => {
      const raw = row.created_at as unknown;
      const at = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
      const age = Number.isFinite(at) ? Math.max(0, now - at) : 0;
      const segment = correctionSegment(row);
      return {
        ...row, chat_verified: row.chat_verified === true, age_ms: age, overdue: segment === 'active' && age >= OVERDUE_MS, segment,
        changed_at: changedAt(row.address_changed_at, row.items_changed_at), changed_what: changedWhat(row.address_changed_at, row.items_changed_at),
        changed_by_name: row.changed_by_name ?? null,
      };
    });
    // Changed: the newest change first; Active keeps the oldest first.
    if (seg) rows = rows.filter((x) => x.segment === seg);
    if (seg === 'changed') rows.sort((a, b) => Date.parse(b.changed_at || '0') - Date.parse(a.changed_at || '0'));
    const k = c.rows[0] || { pending: 0, overdue: 0, done_today: 0, changed: 0 };
    const pending = Number(k.pending) || 0, changedN = Number(k.changed) || 0;
    return { ok: true, value: { rows, counts: { pending, overdue: Number(k.overdue) || 0, done_today: Number(k.done_today) || 0, active: Math.max(0, pending - changedN), changed: changedN }, installed: true } };
  } catch (e) {
    if (missingCorrections(e)) return refuse(503, CORRECTION_TEXT.notInstalled);
    throw e;
  }
}

export async function setCorrection(user: AuthUser, id: string, body: unknown): Promise<CorrectionResult<CorrectionRow>> {
  if (!can(user, 'chat.view')) return refuse(403, 'You cannot open Chat Support');
  if (!isTeamLead(user)) return refuse(403, CORRECTION_TEXT.cannotClose);
  if (!/^\d{1,18}$/.test(String(id))) return refuse(404, CORRECTION_TEXT.notFound);
  const b = (body && typeof body === 'object' ? body : {}) as { action?: unknown; note?: unknown };
  if (!isCorrectionAction(b.action)) return refuse(400, CORRECTION_TEXT.badAction);
  const action: CorrectionAction = b.action;
  const note = cleanDoneNote(b.note);
  if ('error' in note) return refuse(400, note.error);
  const scope = panelScope(user);
  try {
    const cur = await query<CorrectionRow>(
      `SELECT ${CORRECTION_COLS} FROM order_corrections x WHERE x.id = $1 AND ($2::text[] IS NULL OR x.business_id = ANY($2::text[]))`, [id, scope]);
    const row = cur.rows[0];
    if (!row) return refuse(404, CORRECTION_TEXT.notFound);
    if (!ACTION_FROM[action].includes(row.status)) return refuse(409, CORRECTION_TEXT.wrongState);
    const next = ACTION_STATUS[action];
    const r = action === 'reopen'
      ? await query<CorrectionRow>(
        `UPDATE order_corrections x SET status = 'pending', done_by = NULL, done_by_name = NULL, done_at = NULL, done_note = NULL, updated_at = now()
          WHERE x.id = $1 AND x.status = ANY($2::text[]) RETURNING ${CORRECTION_COLS}`, [id, ACTION_FROM.reopen])
      : await query<CorrectionRow>(
        `UPDATE order_corrections x SET status = $2, done_by = $3, done_by_name = $4, done_at = now(), done_note = $5, updated_at = now()
          WHERE x.id = $1 AND x.status = 'pending' RETURNING ${CORRECTION_COLS}`, [id, next, actorKey(user), actorName(user), note.note]);
    const out = r.rows[0];
    if (!out) return refuse(409, CORRECTION_TEXT.wrongState);
    console.log(`[correction] id=${out.id} panel=${out.business_id} order=${maskOrder(out.order_id)} kinds=${out.kinds.join(',')} ${action} by ${actorKey(user)}`);
    return { ok: true, value: out };
  } catch (e) {
    if (missingCorrections(e)) return refuse(503, CORRECTION_TEXT.notInstalled);
    throw e;
  }
}
