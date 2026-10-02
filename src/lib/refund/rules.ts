// ── Refund form: the pure rules (owner, 2026-10-02) ─────────────
// ShipTrack's own refund form replaces the Google Form. This file has NO imports: the customer page
// (/refund) and the server use the same checks, and the server always checks again (master rule 30:
// the client never decides). Spec: refund_form_spec.md 2.2 and 7.4.
//
// Owner answers 2026-10-02 12:30 IST:
//   Q1  yes: the refund goes to the UPI ID or bank account the customer gives, for EVERY order (COD and
//       prepaid). Master rule 18 is changed by the owner (MASTER_RULES_STATUS.md), so
//       PREPAID_PAYOUT_ALLOWED stays true; prepaid orders still get the red "check the gateway" flag
//       and the required gateway tick before Refunded.
//   Q12 yes: "shows delivered but not received" needs the tick "checked with family / neighbours /
//       security" (checked_around).
//   Q13 yes: the quality sub-options below.
// Owner change 2026-10-02 ~15:00 ("upload yeh sab mat bana, humein sirf bank details mil jaye bahut
// hai"): NO photo / video upload. The form has no file step and the submit has no file_ids (a client
// that still sends them is ignored, like any other unknown key).
// Nothing in here reads the database, the network, the clock (callers pass `now`) or a secret.

export const LINK_DAYS = 7, LINKS_PER_ORDER_7D = 5, SEND_COOLDOWN_MS = 60_000, STATUS_VIEW_DAYS = 90;
// Owner change 2026-10-02 ("details is optional"): the details text may be empty. DETAILS_MIN = 0 keeps
// refund-forms.sql's CHECK (char_length(details) BETWEEN 0 AND 1000) pinned to these numbers (refund-unit.js U14).
export const DETAILS_MIN = 0, DETAILS_MAX = 1000, NOTE_MAX = 500, RETURN_NOTE_MAX = 300;
export const CONSENT_VERSION = 'v1-2026-10-02';
// A refund amount when the order total is 0 or unknown is capped here (₹1,00,000), with a confirm.
export const AMOUNT_CAP = 100000;
// The "form received" message counts as failed (red flag, Post now) when it is missing after this long.
export const ACK_GRACE_MS = 2 * 60_000;
// Owner answer Q1 (2026-10-02): UPI / bank for every order, COD and prepaid. false = prepaid orders are
// blocked at Send with 'prepaid_gateway'.
export const PREPAID_PAYOUT_ALLOWED = true;

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;   // India has no daylight saving

// ── Reasons ────────────────────────────────────────────────────
export type Reason = 'damaged' | 'wrong_missing' | 'not_received' | 'quality';
export const REASONS: Reason[] = ['damaged', 'wrong_missing', 'not_received', 'quality'];
export const SUB_REASONS: Record<Reason, string[]> = {
  damaged: [],
  wrong_missing: ['wrong_product', 'wrong_size', 'wrong_colour', 'item_missing'],
  not_received: ['shows_delivered', 'never_came'],
  quality: ['poor_quality', 'not_as_shown', 'did_not_like'],
};
// Q12: the one sub-option that needs the "checked with family / neighbours / security" tick.
export const NEEDS_CHECKED_AROUND = { reason: 'not_received' as Reason, sub: 'shows_delivered' };
export const needsCheckedAround = (reason: unknown, sub: unknown) =>
  reason === NEEDS_CHECKED_AROUND.reason && sub === NEEDS_CHECKED_AROUND.sub;

export type Method = 'upi' | 'bank';

// ── Status moves (the DB trigger refund_request_guard is the second gate; refund-unit.js pins both) ──
export type Status = 'new' | 'approved' | 'rejected' | 'refunded' | 'cancelled';
export const STATUSES: Status[] = ['new', 'approved', 'rejected', 'refunded', 'cancelled'];
export type MoveAction = 'approve' | 'reject' | 'refunded' | 'cancel';
export const MOVES: Record<MoveAction, { from: Status[]; to: Status; message: 'approved' | 'rejected' | 'refunded' | null; noteRequired: boolean }> = {
  approve:  { from: ['new', 'rejected'],  to: 'approved',  message: 'approved', noteRequired: false },
  reject:   { from: ['new', 'approved'],  to: 'rejected',  message: 'rejected', noteRequired: true },
  refunded: { from: ['approved'],         to: 'refunded',  message: 'refunded', noteRequired: false },
  cancel:   { from: ['new', 'approved'],  to: 'cancelled', message: null,       noteRequired: true },
};
export const isMoveAction = (a: unknown): a is MoveAction => typeof a === 'string' && Object.prototype.hasOwnProperty.call(MOVES, a);
// May a request in `from` move to `to`? Same table as the trigger: new -> approved / rejected /
// cancelled; approved -> refunded / rejected / cancelled; rejected -> approved. Refunded and
// cancelled are final.
export function canMove(from: string, to: string): boolean {
  return (Object.keys(MOVES) as MoveAction[]).some((a) => MOVES[a].to === to && (MOVES[a].from as string[]).includes(from));
}
// The actions a request in `status` offers (for the panel's action bar).
export const actionsFor = (status: string): MoveAction[] =>
  (Object.keys(MOVES) as MoveAction[]).filter((a) => (MOVES[a].from as string[]).includes(status));

// What the customer's status view says for each internal status (Q4, Q5: cancelled reads "closed").
export type PublicStatus = 'received' | 'approved' | 'not_approved' | 'refunded' | 'closed';
export const PUBLIC_STATUS: Record<Status, PublicStatus> = {
  new: 'received', approved: 'approved', rejected: 'not_approved', refunded: 'refunded', cancelled: 'closed',
};

// ── Results ────────────────────────────────────────────────────
// `code?: undefined` / `value?: undefined` let `if (!x.ok) errors.f = x.code` compile: the repo's
// tsconfig has strict off, so TypeScript does not narrow on the `ok` literal.
export type Check<T> = { ok: true; value: T; warn?: string; code?: undefined } | { ok: false; code: string; value?: undefined; warn?: undefined };
const ok = <T>(value: T, warn?: string): Check<T> => (warn ? { ok: true, value, warn } : { ok: true, value });
const no = <T>(code: string): Check<T> => ({ ok: false, code });

// Characters counted like PostgreSQL's char_length (code points, not UTF-16 units).
const chars = (s: string) => Array.from(s).length;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'number' ? String(v) : '');

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Customer fields (2.2) ──────────────────────────────────────
export function checkReason(v: unknown): Check<Reason> {
  return typeof v === 'string' && (REASONS as string[]).includes(v) ? ok(v as Reason) : no('reason_required');
}
export function checkSubReason(reason: Reason, v: unknown): Check<string | null> {
  const list = SUB_REASONS[reason] || [];
  if (!list.length) return ok(null);   // damaged: no sub-option
  return typeof v === 'string' && list.includes(v) ? ok(v) : no('sub_reason_required');
}
// Required (true) for not_received + shows_delivered (Q12); forced to false everywhere else.
export function checkCheckedAround(reason: Reason, sub: string | null, v: unknown): Check<boolean> {
  if (!needsCheckedAround(reason, sub)) return ok(false);
  return v === true ? ok(true) : no('checked_around_required');
}

const CTRL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
export function cleanDetails(v: unknown): string {
  return str(v).replace(CTRL, '').replace(/\n{3,}/g, '\n\n').trim();
}
// OPTIONAL (owner change 2026-10-02): an empty text (or only spaces) is accepted and stored as ''; only a
// text over DETAILS_MAX is refused. `mask` is the server's maskSensitive(...).text (this file has no
// imports); the length is checked again after it, so the stored text always fits the column's CHECK.
export function checkDetails(v: unknown, mask?: (s: string) => string): Check<string> {
  let s = cleanDetails(v);
  if (chars(s) > DETAILS_MAX) return no('details_long');
  if (mask && s) {
    s = mask(s);
    if (chars(s) > DETAILS_MAX) return no('details_long');
  }
  return ok(s);
}

export function checkMethod(v: unknown): Check<Method> {
  return v === 'upi' || v === 'bank' ? ok(v) : no('method_required');
}

// UPI: trimmed and lower-cased. A space INSIDE the ID is not removed: it is a typo, so the customer is
// asked to look again (refund-unit.js U1: "ra hul@ybl" is refused).
export const UPI_RE = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/;
export const normUpi = (v: unknown) => str(v).trim().toLowerCase();
export function checkUpi(v: unknown): Check<string> {
  const s = normUpi(v);
  return UPI_RE.test(s) ? ok(s) : no('upi_format');
}

// Holder name, as banks store it: Latin letters, upper case. Phone keyboards' curly apostrophes become '.
export const HOLDER_RE = /^[A-Z][A-Z .'-]{1,79}$/;
export const normHolder = (v: unknown) => str(v).replace(/[‘’ʼ`´]/g, "'").trim().replace(/\s+/g, ' ').toUpperCase();
export function checkHolder(v: unknown): Check<string> {
  const s = normHolder(v);
  return HOLDER_RE.test(s) ? ok(s) : no('holder_format');
}

export const normAccount = (v: unknown) => str(v).replace(/[\s-]/g, '');
export function checkAccount(v: unknown): Check<string> {
  const s = normAccount(v);
  return /^\d{9,18}$/.test(s) && !/^(\d)\1+$/.test(s) ? ok(s) : no('account_format');
}
export function checkAccountConfirm(account: unknown, confirm: unknown): Check<string> {
  const a = normAccount(account), c = normAccount(confirm);
  return c === a ? ok(c) : no('account_mismatch');
}

// IFSC: 4 letters, a zero, 6 letters / digits. A letter O typed in 5th place becomes 0 (the page shows
// "We changed the letter O to zero (0)").
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export function normIfsc(v: unknown): { value: string; fixedO: boolean } {
  let s = str(v).trim().toUpperCase().replace(/\s+/g, '');
  let fixedO = false;
  if (s.length === 11 && s[4] === 'O') { s = s.slice(0, 4) + '0' + s.slice(5); fixedO = true; }
  return { value: s, fixedO };
}
export function checkIfsc(v: unknown): Check<string> {
  const { value, fixedO } = normIfsc(v);
  return IFSC_RE.test(value) ? ok(value, fixedO ? 'ifsc_o_fixed' : undefined) : no('ifsc_format');
}

export const checkConsent = (v: unknown): Check<true> => (v === true ? ok(true as const) : no('consent_required'));
export const checkNonce = (v: unknown): Check<string> =>
  (typeof v === 'string' && UUID_V4_RE.test(v) ? ok(v.toLowerCase()) : no('bad_request'));

// ── The whole submit (POST /api/refund/submit) ─────────────────
// What gets encrypted (crypto.ts sealJson): never stored or logged in clear.
export type Payout =
  | { v: 1; method: 'upi'; upi: string; holder: string }
  | { v: 1; method: 'bank'; account: string; ifsc: string; holder: string };

export interface SubmitInput {
  client_nonce: string;
  reason: Reason;
  sub_reason: string | null;
  checked_around: boolean;
  details: string;
  method: Method;
  payout: Payout;
  payout_mask: string;
  consent: true;
  ifsc_fixed: boolean;
}
export type SubmitErrors = Partial<Record<
  'client_nonce' | 'reason' | 'sub_reason' | 'checked_around' | 'details' | 'method' | 'upi' | 'holder' |
  'account' | 'account_confirm' | 'ifsc' | 'consent', string>>;

// Every field error at once (the page shows them all). Only the listed keys are read: an order_id,
// name or phone the client sends is ignored (master rule 30; the order comes from the link's snapshot).
export function validateSubmit(body: unknown, opts: { mask?: (s: string) => string } = {}):
  { ok: true; value: SubmitInput } | { ok: false; errors: SubmitErrors } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const errors: SubmitErrors = {};
  const nonce = checkNonce(b.client_nonce);
  if (!nonce.ok) errors.client_nonce = nonce.code;

  const reason = checkReason(b.reason);
  let sub: Check<string | null> = ok(null), around: Check<boolean> = ok(false);
  if (!reason.ok) errors.reason = reason.code;
  else {
    sub = checkSubReason(reason.value, b.sub_reason);
    if (!sub.ok) errors.sub_reason = sub.code;
    else {
      around = checkCheckedAround(reason.value, sub.value, b.checked_around);
      if (!around.ok) errors.checked_around = around.code;
    }
  }
  const details = checkDetails(b.details, opts.mask);
  if (!details.ok) errors.details = details.code;

  const method = checkMethod(b.method);
  const holder = checkHolder(b.holder);
  let payout: Payout | null = null, ifscFixed = false;
  if (!method.ok) errors.method = method.code;
  else {
    if (!holder.ok) errors.holder = holder.code;
    if (method.value === 'upi') {
      const upi = checkUpi(b.upi);
      if (!upi.ok) errors.upi = upi.code;
      if (upi.ok && holder.ok) payout = { v: 1, method: 'upi', upi: upi.value, holder: holder.value };
    } else {
      const account = checkAccount(b.account);
      const confirm = checkAccountConfirm(b.account, b.account_confirm);
      const ifsc = checkIfsc(b.ifsc);
      if (!account.ok) errors.account = account.code;
      else if (!confirm.ok) errors.account_confirm = confirm.code;
      if (!ifsc.ok) errors.ifsc = ifsc.code;
      else ifscFixed = ifsc.warn === 'ifsc_o_fixed';
      if (account.ok && confirm.ok && ifsc.ok && holder.ok) payout = { v: 1, method: 'bank', account: account.value, ifsc: ifsc.value, holder: holder.value };
    }
  }
  const consent = checkConsent(b.consent);
  if (!consent.ok) errors.consent = consent.code;

  if (Object.keys(errors).length || !payout || !nonce.ok || !reason.ok || !sub.ok || !around.ok || !details.ok || !method.ok) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      client_nonce: nonce.value, reason: reason.value, sub_reason: sub.value, checked_around: around.value,
      details: details.value, method: method.value, payout, payout_mask: payoutMask(payout),
      consent: true, ifsc_fixed: ifscFixed,
    },
  };
}

// ── Masks (what lists, the panel and the status view show) ─────
export const MASK_MAX = 60;   // refund_requests.payout_mask CHECK
export function maskUpi(vpa: string): string {
  const at = vpa.lastIndexOf('@');
  const L = at >= 0 ? vpa.slice(0, at) : vpa, H = at >= 0 ? vpa.slice(at + 1) : '';
  const out = L.length <= 4 ? `${L.slice(0, 1)}•••@${H}` : `${L.slice(0, 2)}•••${L.slice(-2)}@${H}`;
  return out.length > MASK_MAX ? out.slice(0, MASK_MAX - 1) + '…' : out;
}
export const maskBank = (account: string, ifsc: string) => `${ifsc.slice(0, 4)} ••••${account.slice(-4)}`;
export const last4FromMask = (mask: string) => (mask || '').slice(-4);
export const payoutMask = (p: Payout) => (p.method === 'upi' ? maskUpi(p.upi) : maskBank(p.account, p.ifsc));
// The value fingerprinted for "same UPI / account on another order" (crypto.ts fingerprint).
export const payoutFpInput = (p: Payout): { kind: 'upi' | 'bank'; value: string } =>
  (p.method === 'upi' ? { kind: 'upi', value: p.upi } : { kind: 'bank', value: `${p.ifsc}:${p.account}` });

// ── Orders ─────────────────────────────────────────────────────
// The same COD test the chat AI uses (src/lib/chat/orders.ts).
export function isCod(raw: unknown): boolean {
  const r = str(raw).toLowerCase();
  return r === 'cod' || r.includes('cash on delivery');
}
export const paymentLabel = (raw: unknown): 'COD' | 'Prepaid' => (isCod(raw) ? 'COD' : 'Prepaid');
// Delivered only when the team marked it (journey.ts: the schedule never marks Delivered).
export const isDelivered = (o: { tracking_status?: unknown; delivered_at?: unknown } | null | undefined) =>
  !!o && (!!o.delivered_at || str(o.tracking_status).trim().toLowerCase() === 'delivered');

// Holder name vs order name: true = a shared word, false = none, null = cannot tell (empty, or the
// order name is not in Latin letters).
const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'SMT', 'SHRI', 'SRI', 'KUMARI', 'DR']);
const nameWords = (s: unknown) => str(s).toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ')
  .filter((w) => w && !TITLES.has(w) && w.length >= 3);
export function namesMatch(holder: unknown, orderName: unknown): boolean | null {
  const a = nameWords(holder), b = new Set(nameWords(orderName));
  if (!a.length || !b.size) return null;
  return a.some((w) => b.has(w));
}

// ── Device label: never the full user agent ────────────────────
export function deviceLabel(ua: unknown): string {
  const u = str(ua);
  const os = /iPad/.test(u) ? 'iPad' : /iPhone|iPod/.test(u) ? 'iPhone' : /Android/.test(u) ? 'Android'
    : /Windows/.test(u) ? 'Windows' : /Macintosh|Mac OS X/.test(u) ? 'Mac' : 'Other';
  const browser = /WhatsApp/i.test(u) ? 'WhatsApp'
    : /FBAN|FBAV|Instagram/.test(u) ? 'Instagram/Facebook app'
    : /SamsungBrowser/.test(u) ? 'Samsung Internet'
    : /Edg(e|A|iOS)?\//.test(u) ? 'Edge'
    : /CriOS|Chrome\//.test(u) ? 'Chrome'
    : /FxiOS|Firefox\//.test(u) ? 'Firefox'
    : /Safari\//.test(u) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`.slice(0, 40);
}

// ── Request number: RF- + 6 of 32 letters / digits (no I, L, O, U) ──
export const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const REF_RE = /^RF-[0-9A-HJKMNP-TV-Z]{6}$/;
export function newRefCode(rand: Uint8Array): string {
  if (!rand || rand.length < 6) throw new Error('newRefCode needs 6 random bytes');
  let out = 'RF-';
  for (let i = 0; i < 6; i++) out += REF_ALPHABET[rand[i] & 31];
  return out;
}

// ── Dates (IST) ────────────────────────────────────────────────
const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(str(v)));
export const istDay = (at: unknown): string => new Date(toMs(at) + IST_OFFSET_MS).toISOString().slice(0, 10);

// ── The link's state for the public routes (3.1, in this order) ──
export type LinkState = 'submitted' | 'replaced' | 'cancelled' | 'expired' | 'open';
export function linkState(row: { status: string; revoked_reason?: string | null; expires_at: unknown }, nowMs: number): LinkState {
  if (row.status === 'submitted') return 'submitted';
  if (row.status === 'revoked') return row.revoked_reason === 'reissued' ? 'replaced' : 'cancelled';
  if (!(toMs(row.expires_at) > nowMs)) return 'expired';
  return 'open';
}
// The submitted link shows the status for 90 days (Q4), then only "already submitted".
export const statusViewOpen = (submittedAt: unknown, nowMs: number) => nowMs - toMs(submittedAt) < STATUS_VIEW_DAYS * DAY_MS;

// ── Super Admin fields (2.2 "Admin validators") ────────────────
export const UTR_RE = /^[A-Z0-9]{8,30}$/;
export const normUtr = (v: unknown) => str(v).replace(/[\s-]/g, '').toUpperCase();
// Soft warning utr_not_upi: a UPI refund's reference (RRN) is normally 12 digits.
export function checkUtr(v: unknown, method?: string | null): Check<string> {
  const s = normUtr(v);
  if (!UTR_RE.test(s)) return no('utr_format');
  return ok(s, method === 'upi' && !/^\d{12}$/.test(s) ? 'utr_not_upi' : undefined);
}

const paise = (n: number) => Math.round(n * 100);
// Amount in rupees: up to 7 digits and 2 decimals, > 0, never above the order total; when the total
// is 0 or unknown, at most AMOUNT_CAP. Soft warning 'partial' when below the total.
export function checkAmount(v: unknown, orderTotal: unknown): Check<number> {
  const s = str(v).trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s) || !(Number(s) > 0)) return no('amount_format');
  const amount = paise(Number(s)) / 100;
  const total = Number(orderTotal);
  if (Number.isFinite(total) && total > 0) {
    if (paise(amount) > paise(total)) return no('amount_over_total');
    return ok(amount, paise(amount) < paise(total) ? 'partial' : undefined);
  }
  return amount > AMOUNT_CAP ? no('amount_high') : ok(amount);
}

// The day the refund was paid: YYYY-MM-DD, from the submit day (IST) to today (IST).
export function checkRefundDate(v: unknown, submittedAt: unknown, nowMs: number): Check<string> {
  const s = str(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return no('date_range');
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return no('date_range');
  if (s < istDay(submittedAt) || s > istDay(nowMs)) return no('date_range');
  return ok(s);
}

// Internal note (never sent to the customer): 1-500 characters when required, else optional.
export function checkNote(v: unknown, required: boolean): Check<string | null> {
  const s = str(v).replace(CTRL, '').trim();
  if (!s) return required ? no('note_required') : ok(null);
  return chars(s) > NOTE_MAX ? no('note_long') : ok(s);
}
export function checkReturnNote(v: unknown): Check<string | null> {
  const s = str(v).replace(CTRL, '').trim();
  if (!s) return ok(null);
  return chars(s) > RETURN_NOTE_MAX ? no('return_note_long') : ok(s);
}
// Prepaid: the Super Admin must tick "I checked the payment gateway" before Refunded (no double refund).
export const checkGatewayTick = (paymentRaw: unknown, ticked: unknown): Check<boolean> =>
  (isCod(paymentRaw) ? ok(ticked === true) : ticked === true ? ok(true) : no('gateway_tick'));

export interface MoveInput {
  status: string;                       // the request's status now
  note?: unknown; utr?: unknown; amount?: unknown; refund_date?: unknown; gateway_checked?: unknown;
  method?: string | null;               // payout_method (for utr_not_upi)
  payment_raw?: unknown;                // order_snapshot.payment_raw
  order_total?: unknown;                // order_snapshot.total
  submitted_at: unknown;                // refund_requests.created_at
  now: number;
}
export interface MoveValue {
  to: Status; message: 'approved' | 'rejected' | 'refunded' | null; note: string | null;
  utr: string | null; amount: number | null; refund_date: string | null; gateway_checked: boolean | null; warnings: string[];
}
// One PATCH status move, every field error at once. The route still does the compare-and-set
// (UPDATE ... WHERE status = $expect) and the trigger checks the move again.
export function validateMove(action: unknown, i: MoveInput): { ok: true; value: MoveValue } | { ok: false; errors: Record<string, string> } {
  if (!isMoveAction(action)) return { ok: false, errors: { action: 'bad_action' } };
  const m = MOVES[action];
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  if (!(m.from as string[]).includes(i.status)) errors.status = 'move_not_allowed';
  const note = checkNote(i.note, m.noteRequired);
  if (!note.ok) errors.note = note.code;
  let utr: string | null = null, amount: number | null = null, date: string | null = null, gw: boolean | null = null;
  if (action === 'refunded') {
    const u = checkUtr(i.utr, i.method);
    if (!u.ok) errors.utr = u.code; else { utr = u.value; if (u.warn) warnings.push(u.warn); }
    const a = checkAmount(i.amount, i.order_total);
    if (!a.ok) errors.amount = a.code; else { amount = a.value; if (a.warn) warnings.push(a.warn); }
    const d = checkRefundDate(i.refund_date, i.submitted_at, i.now);
    if (!d.ok) errors.refund_date = d.code; else date = d.value;
    const g = checkGatewayTick(i.payment_raw, i.gateway_checked);
    if (!g.ok) errors.gateway_checked = g.code; else gw = g.value;
  }
  if (Object.keys(errors).length || !note.ok) return { ok: false, errors };
  return { ok: true, value: { to: m.to, message: m.message, note: note.value, utr, amount, refund_date: date, gateway_checked: gw, warnings } };
}

// ── Flags (7.4): pure, red first, then amber, then grey ────────
export type FlagCode = 'prepaid' | 'cod_not_delivered' | 'cod_not_received' | 'payout_reused' | 'ack_failed' | 'email_failed'
  | 'order_cancelled' | 'name_differs' | 'repeat_customer' | 'order_changed' | 'opened_by_many' | 'not_refund_case';
export type FlagLevel = 'red' | 'amber' | 'grey';
export interface Flag { code: FlagCode; level: FlagLevel; text: string; refs: string[] }
// A field left undefined means "not known here" and its flags are skipped (the list view knows only
// the stored columns: prepaid, name_differs, payout_reused, repeat_customer, ack_failed).
export interface FlagInput {
  paymentRaw?: unknown;                 // order_snapshot.payment_raw
  delivered?: boolean;                  // isDelivered(order now, else snapshot)
  reason?: string;
  isCancelled?: boolean;
  holderMatches?: boolean | null;
  orderName?: string | null;
  payoutReusedRefs?: string[];          // refs of requests for ANOTHER order with the same payout_fp
  phoneRequests90d?: number;            // requests with this phone_fp in 90 days, this one included
  orderChanged?: boolean;
  openNetworks?: number;                // distinct ip hashes among link_opened events
  ackPosted?: boolean;
  createdAtMs?: number;
  nowMs?: number;
  emailFailed?: boolean;
  caseKind?: string | null;             // the target chat's case_kind now
}
export const FLAG_LEVEL: Record<FlagCode, FlagLevel> = {
  prepaid: 'red', cod_not_delivered: 'red', cod_not_received: 'red', payout_reused: 'red', ack_failed: 'red', email_failed: 'red',
  order_cancelled: 'amber', name_differs: 'amber', repeat_customer: 'amber', order_changed: 'amber', opened_by_many: 'amber',
  not_refund_case: 'grey',
};
export function computeFlags(i: FlagInput): Flag[] {
  const out: Flag[] = [];
  const add = (code: FlagCode, text: string, refs: string[] = []) => out.push({ code, level: FLAG_LEVEL[code], text, refs });
  const cod = i.paymentRaw !== undefined ? isCod(i.paymentRaw) : null;
  if (cod === false) add('prepaid', 'Prepaid order: check the payment gateway first (no refund or chargeback already open).');
  if (cod === true && i.delivered === false) add('cod_not_delivered', 'COD order not marked Delivered: the customer may not have paid anything.');
  if (cod === true && i.reason === 'not_received') add('cod_not_received', 'COD + "not received": COD is paid only at delivery. Check they actually paid.');
  const refs = (i.payoutReusedRefs || []).filter(Boolean);
  if (refs.length) add('payout_reused', `The same UPI / account was given on ${refs.join(', ')} (another order).`, refs);
  if (i.ackPosted === false && i.createdAtMs !== undefined && i.nowMs !== undefined && i.nowMs - i.createdAtMs > ACK_GRACE_MS) {
    add('ack_failed', 'The "form received" message was not sent. [Post now]');
  }
  if (i.emailFailed) add('email_failed', 'An email to the customer failed. [Retry]');
  if (i.isCancelled) add('order_cancelled', 'The order is cancelled in the panel.');
  if (i.holderMatches === false) add('name_differs', `The name on the account does not match the order name (${i.orderName || '-'}).`);
  if ((i.phoneRequests90d || 0) >= 2) add('repeat_customer', `This phone has ${i.phoneRequests90d} refund requests in 90 days.`);
  if (i.orderChanged) add('order_changed', 'The order total or phone changed since the form was sent.');
  if ((i.openNetworks || 0) >= 3) add('opened_by_many', 'The link was opened from 3+ networks.');
  if (i.caseKind !== undefined && i.caseKind !== 'refund') add('not_refund_case', 'The chat is no longer in the Refund section.');
  const rank: Record<FlagLevel, number> = { red: 0, amber: 1, grey: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
