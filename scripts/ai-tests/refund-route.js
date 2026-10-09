// Refund form (owner, 2026-10-02), slice B: the REAL routes and src/lib/refund/server.ts against a fake
// database. Spec refund_form_spec.md 11.2 (R1-R17), owner answers 2026-10-02 (Q1 every order, Q3 no
// destination in any customer message, Q6 the Refund-mark gate, Q14 reopen on Rejected).
//   R1  auth on every Super Admin route: 401 / 403 (panel admin with chat.cases + chat.edit, senior,
//       agent) / 200; the first Super Admin request after a restart waits for the logins
//   R2  Send gates (every block, its code and text)     R3  Send success (one link, one 'system' message)
//   R4  re-issue, expectLinkId, cooldown, 7-day cap, request_open, after rejected / cancelled
//   R5  email chats (no mailbox, send fails, retry_email; a failed form email stays red on the chip and
//       its Retry email re-sends the same message, never a dead link)  R6  open: invalid / expired / replaced /
//       cancelled / closed, opened_count, 50 events, status view, used after 90 days
//   R7  hardening (origin, Sec-Fetch-Site, content type, size, 21 bad tokens, headers)
//   R8  NO photo / video upload (owner change 2026-10-02 ~15:00): no file route, no file / multipart /
//       raw-bytes body on any refund route, no file SQL in any test
//   R9  submit (validation, ignored order fields and file_ids, parallel, retry, NO payout in clear in any
//       SQL parameter, AAD, mask, holder check, link submitted)
//   R10 "form received" (merged chats, reopen, unread, both tries busy -> message_failed -> Post now once)
//   R11 status moves (CAS, every move, UTR, amount, date, prepaid tick, notes never sent, reopen, return)
//   R12 reveal (recorded, no-store, 30 an hour, key missing)   R13 logs never carry customer data
//   R14 thread state (refundThreadState) + the thread route's refund_form / link mask (slice D, pinned)
//   R15 the Refund-mark gate (refundMarkLocked) + setCase's call (slice D, pinned)
//   R16 staff replies / edits with a form link are 403 (slice D's routes, run for real)
//   R18 list, counts, sent links, detail   (R17, the Super Admin's file stream, went with the uploads)
// The fake database keeps what matters here: row and advisory locks (a wait needs SET LOCAL
// lock_timeout; 5 s stands for 120 ms, then 55P03), an aborted transaction stays aborted until ROLLBACK
// (TO SAVEPOINT), a pool query from inside a transaction is a failure, the refund CHECKs, unique indexes
// and the link / request guard triggers of refund-forms.sql, and chat-team.sql's status trigger. Every statement must
// match one the code is known to send, or the test fails (so any refund_files / refund_file_parts
// statement fails it: there is no handler for one). No network, no real database, no email sent.
// Nothing printed carries a token, a UPI ID, an account, a phone or a customer's text.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), nodeCrypto = require('crypto');
const util = require('util');
const Module = require('module');
const { AsyncLocalStorage } = require('async_hooks');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'refund-route-')));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

process.env.AUTH_TOKEN_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.ADMIN_USERNAME = 'Owner';
process.env.ADMIN_PASSWORD = 'env-pass-123';
for (const k of ['REFUND_DATA_KEY', 'REFUND_DATA_KEY_OLD', 'REFUND_FORMS', 'NEXT_PUBLIC_BASE_URL', 'DATABASE_URL']) delete process.env[k];
const KEY = nodeCrypto.randomBytes(32).toString('base64');
process.env.REFUND_DATA_KEY = KEY;

// ── Clock (every module reads Date.now(); the fake database's now() is the same) ──
const realNow = Date.now.bind(Date);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, MB = 1024 * 1024;
const BASE_NOW = Date.parse('2026-10-05T06:30:00.000Z');   // 12:00 IST
let NOW = BASE_NOW;
Date.now = () => NOW;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fake modules: next/server, the database, the email sender ──
const FAKE_NEXT = path.join(dir, 'next-server.js');
fs.writeFileSync(FAKE_NEXT, `
class NextResponse extends Response {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new NextResponse(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
class NextRequest extends Request {}
module.exports = { NextResponse, NextRequest };`);
const FAKE_DB = path.join(dir, 'db.js');
fs.writeFileSync(FAKE_DB, `
const f = () => global.__refundFakeDb;
module.exports = {
  query: (sql, p) => f().pool(sql, p),
  queryOne: async (sql, p) => (await f().pool(sql, p)).rows[0] ?? null,
  withTransaction: (fn) => f().withTransaction(fn),
  getPool: () => { throw new Error('fake db: getPool'); },
};`);
const FAKE_EMAIL = path.join(dir, 'email.js');
fs.writeFileSync(FAKE_EMAIL, `
module.exports = { sendAgentEmailReply: async (convId, content, ids) => global.__refundEmail(convId, content, ids) };`);
const emails = { sent: [], mode: 'ok' };
global.__refundEmail = async (convId, content, ids) => {
  emails.sent.push({ convId, content, ids });
  if (emails.mode === 'throw') { const e = new Error('Invalid login: 535 Authentication failed'); e.code = 'EAUTH'; throw e; }
};

// TypeScript straight from src (the mutation harness runs this file in a mutated copy of the repo).
require.extensions['.ts'] = (mod, filename) => {
  const src = fs.readFileSync(filename, 'utf8');
  mod._compile(ts.transpileModule(src, { fileName: filename, compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true } }).outputText, filename);
};
const origResolve = Module._resolveFilename;
const REAL_DB = path.join(SRC, 'lib/db.ts'), REAL_EMAIL = path.join(SRC, 'lib/chat/email.ts');
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'next/server') return FAKE_NEXT;
  const r = request.startsWith('@/') ? path.join(SRC, request.slice(2)) : request;
  const out = origResolve.call(this, r, parent, ...rest);
  if (out === REAL_DB) return FAKE_DB;
  if (out === REAL_EMAIL) return FAKE_EMAIL;
  return out;
};
const load = (rel) => require(path.join(SRC, rel));

// ── Console capture: every line the code writes is kept, the way Node would print it ──
const logs = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info };
for (const k of ['log', 'error', 'warn', 'info']) console[k] = (...a) => { logs.push(util.format(...a)); };
const out = (s) => realConsole.log(s);

// ══ Fake database ═══════════════════════════════════════════════
const T = {
  team_users: [], admin_login: [], sites: [], businesses: [], site_emails: [], orders: [], order_items: [], conversations: [],
  messages: [], chat_events: [], refund_links: [], refund_requests: [], refund_events: [],
};
const db = { log: [], violations: [], fails: [], adminDelay: 0, evSeq: 0 };
const now = () => new Date(NOW);
const tms = (v) => (v instanceof Date ? v.getTime() : v == null ? NaN : Date.parse(v));
const json = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const clone = (o) => (o == null ? o : { ...o });
const num2 = (n) => (n == null ? null : Number(n).toFixed(2));

function pgErr(code, message, extra = {}) { const e = new Error(message); e.code = code; Object.assign(e, extra); return e; }
const failingRow = (row) => `Failing row contains (${Object.values(row).map((v) => (v instanceof Date ? v.toISOString() : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(', ')}).`;
const checkErr = (table, name, row) => pgErr('23514', `new row for relation "${table}" violates check constraint "${name}"`, { constraint: name, table, detail: failingRow(row) });
const uniqueErr = (table, name, cols, row) => pgErr('23505', `duplicate key value violates unique constraint "${name}"`,
  { constraint: name, table, detail: `Key (${cols.join(', ')})=(${cols.map((c) => row[c]).join(', ')}) already exists.` });
const raise = (msg) => pgErr('23514', msg);

// Transactions, locks
const als = new AsyncLocalStorage();
const LOCK_WAIT_MS = 120;   // stands for lock_timeout = '5s'
const locks = new Map();    // key -> Map(tx -> 'x' | 's')
let txSeq = 0;
function newTx(auto) { return { id: ++txSeq, auto, undo: [], aborted: false, lockTimeout: null, savepoints: [], config: {}, held: new Set() }; }
async function acquire(tx, key, mode) {
  let ent = locks.get(key);
  if (!ent) { ent = new Map(); locks.set(key, ent); }
  const free = () => [...ent.entries()].every(([t, m]) => t === tx || (m === 's' && mode === 's'));
  if (!free()) {
    if (!tx.lockTimeout) db.violations.push(`a lock wait without SET LOCAL lock_timeout (${key.split(':')[0]})`);
    const until = realNow() + (tx.lockTimeout ? LOCK_WAIT_MS : 1000);
    while (!free()) {
      if (realNow() > until) throw pgErr('55P03', 'canceling statement due to lock timeout');
      await sleep(3);
    }
  }
  if (ent.get(tx) !== 'x') ent.set(tx, mode);
  tx.held.add(key);
}
function releaseAll(tx) {
  for (const k of tx.held) { const ent = locks.get(k); if (ent) { ent.delete(tx); if (!ent.size) locks.delete(k); } }
  tx.held.clear();
}
const rowKey = (table, row) => `${table}:${row.id}`;
const lockRows = async (tx, table, rows, mode = 'x') => { for (const r of rows) await acquire(tx, rowKey(table, r), mode); };

// Writes (with undo for ROLLBACK)
function ins(tx, table, row) { T[table].push(row); tx.undo.push(() => { const i = T[table].indexOf(row); if (i >= 0) T[table].splice(i, 1); }); return row; }
function setRow(tx, row, next) {
  const old = { ...row };
  for (const k of Object.keys(row)) if (!(k in next)) delete row[k];
  Object.assign(row, next);
  tx.undo.push(() => { for (const k of Object.keys(row)) delete row[k]; Object.assign(row, old); });
}
function delRow(tx, table, row) {
  const i = T[table].indexOf(row);
  if (i < 0) return;
  T[table].splice(i, 1);
  tx.undo.push(() => T[table].push(row));
}

// ── refund-forms.sql: CHECKs, unique indexes, guard triggers (the file tables are never written) ──
const RE_HASH = /^[0-9a-f]{64}$/, RE_KEYID = /^[0-9a-f]{8}$/, RE_REF = /^RF-[0-9A-HJKMNP-TV-Z]{6}$/;
const RE_ENC = /^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, RE_FP = /^[A-Za-z0-9_-]{32}$/;
const SUBS = { damaged: [null], wrong_missing: ['wrong_product', 'wrong_size', 'wrong_colour', 'item_missing'],
  not_received: ['shows_delivered', 'never_came'], quality: ['poor_quality', 'not_as_shown', 'did_not_like'] };
function checkLink(l) {
  if (!RE_HASH.test(l.token_hash || '')) throw checkErr('refund_links', 'refund_links_token_hash_check', l);
  if (!['chat', 'email'].includes(l.channel)) throw checkErr('refund_links', 'refund_links_channel_check', l);
  if (!['en', 'hinglish'].includes(l.lang)) throw checkErr('refund_links', 'refund_links_lang_check', l);
  if (!['active', 'submitted', 'revoked'].includes(l.status)) throw checkErr('refund_links', 'refund_links_status_check', l);
  if (l.revoked_reason != null && !['reissued', 'cancelled'].includes(l.revoked_reason)) throw checkErr('refund_links', 'refund_links_revoked_reason_check', l);
  if (l.created_by !== 'owner') throw checkErr('refund_links', 'refund_links_created_by_check', l);
  if (!(tms(l.expires_at) > tms(l.created_at) && tms(l.expires_at) <= tms(l.created_at) + 7 * DAY + MIN)) throw checkErr('refund_links', 'refund_link_life', l);
  if ((l.status === 'revoked') !== (l.revoked_reason != null && l.revoked_at != null)) throw checkErr('refund_links', 'refund_link_revoked', l);
  if ((l.status === 'submitted') !== (l.submitted_at != null)) throw checkErr('refund_links', 'refund_link_submitted', l);
  if (!(l.opened_count >= 0)) throw checkErr('refund_links', 'refund_links_opened_count_check', l);
  for (const o of T.refund_links) {
    if (o === l) continue;
    if (o.token_hash === l.token_hash) throw uniqueErr('refund_links', 'refund_links_token_hash_key', ['token_hash'], l);
    if (o.status === 'active' && l.status === 'active' && o.business_id === l.business_id && o.order_id === l.order_id) {
      throw uniqueErr('refund_links', 'refund_links_one_active', ['business_id', 'order_id'], l);
    }
  }
}
function checkRequest(r) {
  const c = (ok, name) => { if (!ok) throw checkErr('refund_requests', name, r); };
  c(RE_REF.test(r.ref_code || ''), 'refund_requests_ref_code_check');
  c(['damaged', 'wrong_missing', 'not_received', 'quality'].includes(r.reason), 'refund_requests_reason_check');
  const len = Array.from(String(r.details ?? '')).length;
  c(len <= 1000, 'refund_requests_details_check');   // BETWEEN 0 AND 1000: optional (owner 2026-10-02)
  c(['upi', 'bank'].includes(r.payout_method), 'refund_requests_payout_method_check');
  const ml = Array.from(String(r.payout_mask ?? '')).length;
  c(ml >= 4 && ml <= 60, 'refund_requests_payout_mask_check');
  c(RE_ENC.test(r.payout_enc || ''), 'refund_requests_payout_enc_check');
  c(RE_KEYID.test(r.payout_key_id || ''), 'refund_requests_payout_key_id_check');
  c(RE_FP.test(r.payout_fp || ''), 'refund_requests_payout_fp_check');
  c(r.submit_ip_hash == null || String(r.submit_ip_hash).length <= 32, 'refund_requests_submit_ip_hash_check');
  c(r.submit_device == null || String(r.submit_device).length <= 40, 'refund_requests_submit_device_check');
  c(['new', 'approved', 'rejected', 'refunded', 'cancelled'].includes(r.status), 'refund_requests_status_check');
  c(r.status_by == null || r.status_by === 'owner', 'refund_requests_status_by_check');
  c(r.refund_amount == null || Number(r.refund_amount) > 0, 'refund_requests_refund_amount_check');
  c(r.utr == null || /^[A-Z0-9]{8,30}$/.test(r.utr), 'refund_requests_utr_check');
  c(r.return_note == null || Array.from(r.return_note).length <= 300, 'refund_requests_return_note_check');
  c((SUBS[r.reason] || []).includes(r.sub_reason ?? null), 'refund_sub_reason_fits');
  c(!r.checked_around || (r.reason === 'not_received' && r.sub_reason === 'shows_delivered'), 'refund_checked_around_fits');
  c(r.status !== 'refunded' || (r.utr != null && r.refund_amount != null && r.refund_date != null), 'refund_sent_has_proof');
  if (!T.refund_links.some((l) => l.id === r.link_id)) throw pgErr('23503', 'insert or update on table "refund_requests" violates foreign key constraint "refund_requests_link_id_fkey"');
  for (const o of T.refund_requests) {
    if (o === r) continue;
    if (o.ref_code === r.ref_code) throw uniqueErr('refund_requests', 'refund_requests_ref_code_key', ['ref_code'], r);
    if (o.link_id === r.link_id) throw uniqueErr('refund_requests', 'refund_requests_link_id_key', ['link_id'], r);
    const open = (x) => ['new', 'approved', 'refunded'].includes(x.status);
    if (open(o) && open(r) && o.business_id === r.business_id && o.order_id === r.order_id) {
      throw uniqueErr('refund_requests', 'refund_requests_one_open', ['business_id', 'order_id'], r);
    }
    if (r.utr != null && o.utr === r.utr) throw uniqueErr('refund_requests', 'refund_requests_utr', ['utr'], r);
  }
}
const MOVES_SQL = { new: ['approved', 'rejected', 'cancelled'], approved: ['refunded', 'rejected', 'cancelled'], rejected: ['approved'] };
const same = (a, b) => (a instanceof Date || b instanceof Date ? tms(a) === tms(b) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null));
function requestGuard(o, n, tx) {
  for (const k of ['id', 'ref_code', 'link_id', 'client_nonce', 'conversation_id', 'site_id', 'business_id', 'order_id', 'order_uuid', 'order_snapshot',
    'reason', 'sub_reason', 'checked_around', 'details', 'payout_method', 'payout_mask', 'holder_matches', 'consent_version', 'consent_at',
    'submit_ip_hash', 'submit_device', 'created_at']) {
    if (!same(o[k], n[k])) throw raise(`refund request ${o.id} keeps what the customer sent`);
  }
  const rekey = tx.config['shiptrack.refund_rekey'] === 'on';
  if (['payout_enc', 'payout_key_id', 'payout_fp', 'phone_fp'].some((k) => !same(o[k], n[k])) && !rekey) throw raise(`refund request ${o.id}: payout details are written once`);
  if (o.ack_message_id != null && n.ack_message_id !== o.ack_message_id) throw raise(`refund request ${o.id}: the received message is already posted`);
  if (n.status !== o.status && !(MOVES_SQL[o.status] || []).includes(n.status)) throw raise(`refund request ${o.id}: ${o.status} -> ${n.status} is not allowed`);
  if (n.status !== 'refunded' && (n.utr != null || n.refund_amount != null || n.refund_date != null)) throw raise(`refund request ${o.id}: UTR, amount and date belong to a sent refund`);
  if (o.status === 'refunded' && (!same(o.utr, n.utr) || !same(o.refund_amount, n.refund_amount) || !same(o.refund_date, n.refund_date) || o.gateway_checked !== n.gateway_checked)) {
    throw raise(`refund request ${o.id}: a sent refund keeps its UTR, amount and date`);
  }
  n.updated_at = now();
}
function linkGuard(o, n) {
  for (const k of ['id', 'token_hash', 'conversation_id', 'site_id', 'business_id', 'order_id', 'order_snapshot', 'channel', 'created_by', 'created_at', 'expires_at']) {
    if (!same(o[k], n[k])) throw raise(`refund link ${o.id} is fixed once sent`);
  }
  if (o.message_id != null && n.message_id !== o.message_id) throw raise(`refund link ${o.id} is fixed once sent`);
  if (n.status !== o.status && !(o.status === 'active' && ['submitted', 'revoked'].includes(n.status))) throw raise(`refund link ${o.id}: ${o.status} -> ${n.status} is not allowed`);
}
// conversations: chat-team.sql trg_chat_status_event
function setConv(tx, c, patch) {
  const before = { ...c };
  setRow(tx, c, { ...c, ...patch });
  if (before.status !== c.status) {
    const who = tx.config['shiptrack.actor'] || null;
    ins(tx, 'chat_events', {
      conversation_id: c.id, kind: 'status', actor: who || (before.status === 'resolved' ? 'customer' : 'system'),
      actor_name: tx.config['shiptrack.actor_name'] || null, from_status: before.status, to_status: c.status,
      reason: tx.config['shiptrack.reason'] || (before.status === 'resolved' ? 'reopen' : null),
    });
  }
}

// ── The statements the code sends ──
const conv = (id) => T.conversations.find((c) => c.id === id);
const site = (id) => T.sites.find((s) => s.id === id);
const linkByHash = (h) => T.refund_links.find((l) => l.token_hash === h);
const reqById = (id) => T.refund_requests.find((r) => r.id === id);
const ordersOf = (orderId, biz) => T.orders.filter((o) => o.order_id === orderId && String(o.business_id) === String(biz)).slice(0, 2);
const rows = (r) => ({ rows: r, rowCount: r.length });
const pick = (o, cols) => Object.fromEntries(cols.map((c) => [c, o[c] === undefined ? null : o[c]]));
const LINK_COLS = ['id', 'status', 'revoked_reason', 'created_at', 'expires_at', 'opened_count', 'last_opened_at', 'conversation_id', 'message_id'];
const H = [];
const on = (re, fn) => H.push([re, fn]);

// auth.ts
on(/^SELECT id, username, display_name, role, is_active, business_ids, permissions, session_version FROM team_users$/, () => rows(T.team_users.map(clone)));
on(/^SELECT username, password_hash, session_version, updated_at FROM admin_login WHERE id = 1$/, async () => {
  if (db.adminDelay) await sleep(db.adminDelay);
  return rows(T.admin_login.map(clone));
});
on(/^INSERT INTO staff_presence \(actor, last_seen_at\) SELECT \* FROM unnest/, () => rows([]));
on(/^SELECT actor, last_seen_at FROM staff_presence$/, () => rows([]));
// team-routing.ts
on(/^SELECT c\.id, c\.site_id, c\.status, c\.assigned_to, c\.case_kind, c\.case_order_id, c\.merged_into, c\.verified_order_id, c\.phone_match_order_id, c\.customer_key, c\.source FROM conversations c WHERE c\.id = \$1 OR \(\$2::text IS NOT NULL AND c\.source = 'chat' AND c\.site_id = \$3 AND c\.customer_key = \$2 AND c\.merged_into IS NULL AND c\.status <> 'resolved'\) ORDER BY c\.id FOR NO KEY UPDATE$/,
  async ([id, key, siteId], tx) => {
    const found = T.conversations.filter((c) => c.id === id || (key != null && c.source === 'chat' && c.site_id === siteId && c.customer_key === key && !c.merged_into && c.status !== 'resolved'))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    await lockRows(tx, 'conversations', found);
    return rows(found.map(clone));
  });
on(/^SELECT set_config\('shiptrack\.actor', \$1, true\), set_config\('shiptrack\.actor_name', \$2, true\), set_config\('shiptrack\.reason', \$3, true\)$/, ([a, n, r], tx) => {
  if (tx.auto) db.violations.push('set_config outside a transaction');
  Object.assign(tx.config, { 'shiptrack.actor': a, 'shiptrack.actor_name': n, 'shiptrack.reason': r });
  return rows([{}]);
});
on(/^SET LOCAL lock_timeout = '5s'$/, (p, tx) => { if (tx.auto) db.violations.push('SET LOCAL outside a transaction'); tx.lockTimeout = 5000; return rows([]); });
on(/^SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)$/, async ([k], tx) => {
  if (tx.auto) db.violations.push('advisory xact lock outside a transaction');
  await acquire(tx, 'adv:' + k, 'x');
  return rows([{ pg_advisory_xact_lock: '' }]);
});
// server.ts: chats, messages, orders
on(/^SELECT c\.id, c\.site_id, c\.source, c\.status, c\.visitor_id, c\.customer_key, c\.case_kind, c\.case_order_id, c\.verified_order_id, c\.verified_via, c\.merged_into, s\.tracker_business_id FROM conversations c JOIN sites s ON s\.id = c\.site_id WHERE c\.id = \$1$/,
  ([id]) => { const c = conv(id); return rows(c && site(c.site_id) ? [{ ...pick(c, ['id', 'site_id', 'source', 'status', 'visitor_id', 'customer_key', 'case_kind', 'case_order_id', 'verified_order_id', 'verified_via', 'merged_into']), tracker_business_id: site(c.site_id).tracker_business_id }] : []); });
on(/^SELECT c\.verified_via, c\.visitor_id, s\.tracker_business_id FROM conversations c JOIN sites s ON s\.id = c\.site_id WHERE c\.id = \$1$/,
  ([id]) => { const c = conv(id); return rows(c ? [{ verified_via: c.verified_via, visitor_id: c.visitor_id, tracker_business_id: site(c.site_id).tracker_business_id }] : []); });
on(/^SELECT c\.id, c\.site_id, c\.status, c\.source, c\.case_kind, c\.merged_into FROM conversations c WHERE c\.id = \$1( FOR NO KEY UPDATE)?$/, async ([id], tx, q) => {
  const c = conv(id);
  if (c && / FOR NO KEY UPDATE$/.test(q)) { if (tx.auto) db.violations.push('FOR NO KEY UPDATE outside a transaction'); await lockRows(tx, 'conversations', [c]); }
  return rows(c ? [pick(c, ['id', 'site_id', 'status', 'source', 'case_kind', 'merged_into'])] : []);
});
on(/^SELECT content FROM messages WHERE conversation_id = \$1 AND sender = 'visitor' AND deleted_at IS NULL AND COALESCE\(metadata->>'hidden', 'false'\) <> 'true' ORDER BY created_at DESC LIMIT 3$/,
  ([id]) => rows(T.messages.filter((m) => m.conversation_id === id && m.sender === 'visitor' && !m.deleted_at && String(m.metadata?.hidden ?? 'false') !== 'true')
    .sort((a, b) => tms(b.created_at) - tms(a.created_at)).slice(0, 3).map((m) => ({ content: m.content }))));
on(/^INSERT INTO messages \(id, conversation_id, sender, content, metadata, created_at\) VALUES \(gen_random_uuid\(\)::text, \$1, 'system', \$2, jsonb_build_object\('system', 'refund', 'step', \$3::text, 'lang', \$4::text\), now\(\)\) RETURNING id, created_at$/,
  ([convId, content, step, lang], tx) => {
    if (!conv(convId)) throw pgErr('23503', 'insert or update on table "messages" violates foreign key constraint "messages_conversation_id_fkey"');
    const m = ins(tx, 'messages', { id: nodeCrypto.randomUUID(), conversation_id: convId, sender: 'system', content, metadata: { system: 'refund', step, lang }, created_at: now(), deleted_at: null });
    return rows([{ id: m.id, created_at: m.created_at }]);
  });
on(/^UPDATE conversations SET last_message_at = now\(\), updated_at = now\(\), unread_count = unread_count \+ \$2::int, status = CASE WHEN \$3::boolean AND status = 'resolved' THEN CASE WHEN case_kind IS NOT NULL THEN 'agent_handling' ELSE 'human_needed' END ELSE status END WHERE id = \$1$/,
  async ([id, add, reopen], tx) => {
    const c = conv(id);
    if (!c) return rows([]);
    await lockRows(tx, 'conversations', [c]);
    setConv(tx, c, {
      last_message_at: now(), updated_at: now(), unread_count: c.unread_count + Number(add),
      status: reopen && c.status === 'resolved' ? (c.case_kind != null ? 'agent_handling' : 'human_needed') : c.status,
    });
    return { rows: [], rowCount: 1 };
  });
on(/^SELECT 1 AS ok FROM site_emails WHERE site_id = \$1 AND email IS NOT NULL AND app_password IS NOT NULL LIMIT 1$/, ([s], tx) => {
  if (db.mailboxGoneAfterCommit && tx.auto) return rows([]);   // removed between the locked send and the email step
  return rows(T.site_emails.filter((e) => e.site_id === s && e.email != null && e.app_password != null).slice(0, 1).map(() => ({ ok: 1 })));
});
on(/^UPDATE messages SET metadata = COALESCE\(metadata, '\{\}'::jsonb\) \|\| jsonb_build_object\('emailed', \$2::boolean\) WHERE id = \$1$/, ([id, v], tx) => {
  const m = T.messages.find((x) => x.id === id);
  if (m) setRow(tx, m, { ...m, metadata: { ...(m.metadata || {}), emailed: !!v } });
  return { rows: [], rowCount: m ? 1 : 0 };
});
on(/^SELECT o\.id, o\.order_id, o\.customer_name, o\.customer_mobile, o\.payment_method, o\.financial_status, o\.order_total, o\.tracking_status, o\.delivered_at, o\.is_cancelled, o\.created_at FROM orders o WHERE o\.order_id = \$1 AND o\.business_id::text = \$2::text LIMIT 2$/,
  ([o, b]) => rows(ordersOf(o, b).map((x) => pick(x, ['id', 'order_id', 'customer_name', 'customer_mobile', 'payment_method', 'financial_status', 'order_total', 'tracking_status', 'delivered_at', 'is_cancelled', 'created_at']))));
on(/^SELECT o\.customer_mobile, o\.tracking_status, o\.delivered_at, o\.is_cancelled FROM orders o WHERE o\.order_id = \$1 AND o\.business_id::text = \$2::text LIMIT 2$/,
  ([o, b]) => rows(ordersOf(o, b).map((x) => pick(x, ['customer_mobile', 'tracking_status', 'delivered_at', 'is_cancelled']))));
on(/^SELECT o\.order_total, o\.customer_mobile, o\.tracking_status, o\.delivered_at, o\.is_cancelled FROM orders o WHERE o\.order_id = \$1 AND o\.business_id::text = \$2::text LIMIT 2$/,
  ([o, b]) => rows(ordersOf(o, b).map((x) => pick(x, ['order_total', 'customer_mobile', 'tracking_status', 'delivered_at', 'is_cancelled']))));
on(/^SELECT product_name, quantity, price FROM order_items WHERE order_id = \$1 ORDER BY id LIMIT 50$/,
  ([o]) => rows(T.order_items.filter((i) => i.order_id === o).sort((a, b) => a.id - b.id).slice(0, 50).map((i) => pick(i, ['product_name', 'quantity', 'price']))));
// server.ts: links (Send side)
on(/^SELECT id, status, revoked_reason, created_at, expires_at, opened_count, last_opened_at, conversation_id, message_id FROM refund_links WHERE business_id = \$1 AND order_id = \$2 AND status = 'active' (LIMIT 1|FOR UPDATE)$/,
  async ([b, o], tx, q) => {
    const found = T.refund_links.filter((l) => l.business_id === b && l.order_id === o && l.status === 'active');
    if (/FOR UPDATE$/.test(q)) await lockRows(tx, 'refund_links', found);
    return rows(found.slice(0, 1).map((l) => pick(l, LINK_COLS)));
  });
on(/^SELECT id, ref_code, status, utr, status_at, created_at FROM refund_requests WHERE business_id = \$1 AND order_id = \$2 ORDER BY created_at DESC LIMIT 5$/,
  ([b, o]) => rows(T.refund_requests.filter((r) => r.business_id === b && r.order_id === o).sort((x, y) => tms(y.created_at) - tms(x.created_at)).slice(0, 5)
    .map((r) => pick(r, ['id', 'ref_code', 'status', 'utr', 'status_at', 'created_at']))));
on(/^SELECT created_at FROM refund_links WHERE business_id = \$1 AND order_id = \$2 ORDER BY created_at DESC LIMIT 5$/,
  ([b, o]) => rows(T.refund_links.filter((l) => l.business_id === b && l.order_id === o).sort((x, y) => tms(y.created_at) - tms(x.created_at)).slice(0, 5).map((l) => ({ created_at: l.created_at }))));
on(/^SELECT id, ref_code, status FROM refund_requests WHERE business_id = \$1 AND order_id = \$2 AND status IN \('new', 'approved', 'refunded'\) LIMIT 1$/,
  ([b, o]) => rows(T.refund_requests.filter((r) => r.business_id === b && r.order_id === o && ['new', 'approved', 'refunded'].includes(r.status)).slice(0, 1).map((r) => pick(r, ['id', 'ref_code', 'status']))));
on(/^UPDATE refund_links SET status = 'revoked', revoked_reason = 'reissued', revoked_at = now\(\), replaced_by = \$2 WHERE id = \$1 AND status = 'active'$/, async ([id, by], tx) => {
  const l = T.refund_links.find((x) => x.id === id && x.status === 'active');
  if (!l) return { rows: [], rowCount: 0 };
  await lockRows(tx, 'refund_links', [l]);
  const n = { ...l, status: 'revoked', revoked_reason: 'reissued', revoked_at: now(), replaced_by: by };
  linkGuard(l, n); setRow(tx, l, n); checkLink(l);
  return { rows: [], rowCount: 1 };
});
on(/^INSERT INTO refund_links \(id, token_hash, conversation_id, site_id, business_id, order_id, order_uuid, order_snapshot, channel, lang, message_id, expires_at\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8::jsonb, \$9, \$10, \$11, now\(\) \+ interval '7 days'\)$/,
  (p, tx) => {
    const [id, token_hash, conversation_id, site_id, business_id, order_id, order_uuid, snap, channel, lang, message_id] = p;
    const l = { id, token_hash, conversation_id, site_id, business_id, order_id, order_uuid, order_snapshot: json(snap), channel, lang, status: 'active',
      revoked_reason: null, replaced_by: null, message_id, created_by: 'owner', created_at: now(), expires_at: new Date(NOW + 7 * DAY), opened_count: 0,
      first_opened_at: null, last_opened_at: null, submitted_at: null, revoked_at: null };
    T.refund_links.push(l);
    try { checkLink(l); } finally { T.refund_links.pop(); }
    ins(tx, 'refund_links', l);
    return { rows: [], rowCount: 1 };
  });
on(/^UPDATE refund_links SET status = 'revoked', revoked_reason = 'cancelled', revoked_at = now\(\) WHERE business_id = \$1 AND order_id = \$2 AND status = 'active' RETURNING id$/,
  async ([b, o], tx) => {
    const found = T.refund_links.filter((l) => l.business_id === b && l.order_id === o && l.status === 'active');
    await lockRows(tx, 'refund_links', found);
    for (const l of found) { const n = { ...l, status: 'revoked', revoked_reason: 'cancelled', revoked_at: now() }; linkGuard(l, n); setRow(tx, l, n); checkLink(l); }
    return rows(found.map((l) => ({ id: l.id })));
  });
on(/^SELECT EXISTS \( SELECT 1 FROM refund_links l WHERE l\.status = 'active' AND l\.expires_at > now\(\) AND \(l\.conversation_id = \$1 OR \(l\.order_id = \$3 AND l\.business_id = \(SELECT s\.tracker_business_id::text FROM sites s WHERE s\.id = \$2\)\)\)\) OR EXISTS \( SELECT 1 FROM refund_requests r WHERE r\.status IN \('new', 'approved'\) AND \(r\.conversation_id = \$1 OR \(r\.order_id = \$3 AND r\.business_id = \(SELECT s\.tracker_business_id::text FROM sites s WHERE s\.id = \$2\)\)\)\) AS locked$/,
  ([c, s, o]) => {
    if (db.missingTables) throw pgErr('42P01', 'relation "refund_links" does not exist');
    const biz = site(s)?.tracker_business_id ?? null;
    const mine = (x) => x.conversation_id === c || (o != null && x.order_id === o && biz != null && x.business_id === String(biz));
    const locked = T.refund_links.some((l) => l.status === 'active' && tms(l.expires_at) > NOW && mine(l))
      || T.refund_requests.some((r) => ['new', 'approved'].includes(r.status) && mine(r));
    return rows([{ locked }]);
  });
// server.ts: public side
on(/^SELECT l\.id, l\.status, l\.revoked_reason, l\.expires_at, l\.lang, l\.order_snapshot, l\.submitted_at, l\.conversation_id, s\.name AS site_name, b\.logo_url FROM refund_links l LEFT JOIN sites s ON s\.id = l\.site_id LEFT JOIN businesses b ON b\.id::text = l\.business_id WHERE l\.token_hash = \$1$/,
  ([h]) => {
    if (db.missingTables) throw pgErr('42P01', 'relation "refund_links" does not exist');
    const l = linkByHash(h);
    return rows(l ? [{ ...pick(l, ['id', 'status', 'revoked_reason', 'expires_at', 'lang', 'order_snapshot', 'submitted_at', 'conversation_id']),
      site_name: site(l.site_id)?.name ?? null, logo_url: T.businesses.find((b) => b.id === l.business_id)?.logo_url ?? null }] : []);
  });
on(/^SELECT ref_code, created_at, status, payout_method, payout_mask, refund_amount, refund_date::text AS refund_date, utr FROM refund_requests WHERE link_id = \$1$/,
  ([l]) => rows(T.refund_requests.filter((r) => r.link_id === l).map((r) => ({ ...pick(r, ['ref_code', 'created_at', 'status', 'payout_method', 'payout_mask', 'utr']), refund_amount: num2(r.refund_amount), refund_date: r.refund_date ?? null }))));
on(/^UPDATE refund_links SET opened_count = opened_count \+ 1, first_opened_at = COALESCE\(first_opened_at, now\(\)\), last_opened_at = now\(\) WHERE id = \$1$/, async ([id], tx) => {
  const l = T.refund_links.find((x) => x.id === id);
  if (!l) return { rows: [], rowCount: 0 };
  await lockRows(tx, 'refund_links', [l]);
  const n = { ...l, opened_count: l.opened_count + 1, first_opened_at: l.first_opened_at ?? now(), last_opened_at: now() };
  linkGuard(l, n); setRow(tx, l, n);
  return { rows: [], rowCount: 1 };
});
on(/^SELECT count\(\*\)::int AS n FROM refund_events WHERE link_id = \$1 AND kind = 'link_opened'$/, ([l]) => rows([{ n: T.refund_events.filter((e) => e.link_id === l && e.kind === 'link_opened').length }]));
on(/^SELECT id, business_id, order_id FROM refund_links WHERE token_hash = \$1$/, ([h]) => { const l = linkByHash(h); return rows(l ? [pick(l, ['id', 'business_id', 'order_id'])] : []); });
on(/^SELECT id, status, revoked_reason, expires_at, conversation_id, site_id, business_id, order_id, order_uuid, order_snapshot FROM refund_links WHERE token_hash = \$1 FOR UPDATE$/,
  async ([h], tx) => {
    const l = linkByHash(h);
    if (l) await lockRows(tx, 'refund_links', [l]);
    return rows(l ? [pick(l, ['id', 'status', 'revoked_reason', 'expires_at', 'conversation_id', 'site_id', 'business_id', 'order_id', 'order_uuid', 'order_snapshot'])] : []);
  });
on(/^SELECT ref_code, client_nonce FROM refund_requests WHERE link_id = \$1$/, ([l]) => rows(T.refund_requests.filter((r) => r.link_id === l).map((r) => pick(r, ['ref_code', 'client_nonce']))));
on(/^SAVEPOINT (\w+)$/, (p, tx, q) => { tx.savepoints.push({ name: q.split(' ')[1], undo: tx.undo.length }); return rows([]); });
on(/^RELEASE SAVEPOINT (\w+)$/, (p, tx, q) => {
  const name = q.split(' ')[2]; const i = tx.savepoints.map((s) => s.name).lastIndexOf(name);
  if (i < 0) throw pgErr('3B001', `savepoint "${name}" does not exist`);
  tx.savepoints.length = i; return rows([]);
});
on(/^INSERT INTO refund_requests \(id, ref_code, link_id, client_nonce, conversation_id, site_id, business_id, order_id, order_uuid, order_snapshot, phone_fp, reason, sub_reason, checked_around, details, payout_method, payout_mask, payout_enc, payout_key_id, payout_fp, holder_matches, consent_version, consent_at, submit_ip_hash, submit_device\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10::jsonb, \$11, \$12, \$13, \$14, \$15, \$16, \$17, \$18, \$19, \$20, \$21, \$22, now\(\), \$23, \$24\)$/,
  (p, tx) => {
    const k = ['id', 'ref_code', 'link_id', 'client_nonce', 'conversation_id', 'site_id', 'business_id', 'order_id', 'order_uuid', 'order_snapshot', 'phone_fp', 'reason',
      'sub_reason', 'checked_around', 'details', 'payout_method', 'payout_mask', 'payout_enc', 'payout_key_id', 'payout_fp', 'holder_matches', 'consent_version'];
    const r = Object.fromEntries(k.map((c, i) => [c, p[i]]));
    Object.assign(r, { order_snapshot: json(r.order_snapshot), consent_at: now(), submit_ip_hash: p[22], submit_device: p[23], ack_message_id: null, status: 'new', status_at: now(),
      status_by: null, refund_amount: null, refund_date: null, utr: null, gateway_checked: false, return_needed: false, return_note: null, return_told_at: null,
      seen_at: null, created_at: now(), updated_at: now(), checked_around: !!r.checked_around });
    T.refund_requests.push(r);
    try { checkRequest(r); } finally { T.refund_requests.pop(); }
    ins(tx, 'refund_requests', r);
    return { rows: [], rowCount: 1 };
  });
on(/^UPDATE refund_links SET status = 'submitted', submitted_at = now\(\) WHERE id = \$1$/, async ([id], tx) => {
  const l = T.refund_links.find((x) => x.id === id);
  await lockRows(tx, 'refund_links', [l]);
  const n = { ...l, status: 'submitted', submitted_at: now() }; linkGuard(l, n); setRow(tx, l, n); checkLink(l);
  return { rows: [], rowCount: 1 };
});
on(/^SELECT id, link_id, conversation_id FROM refund_requests WHERE id = \$1 AND ack_message_id IS NULL FOR UPDATE$/, async ([id], tx) => {
  const r = T.refund_requests.find((x) => x.id === id);
  if (!r) return rows([]);
  await lockRows(tx, 'refund_requests', [r]);
  return rows(r.ack_message_id == null ? [pick(r, ['id', 'link_id', 'conversation_id'])] : []);
});
on(/^SELECT lang FROM refund_links WHERE id = \$1$/, ([id]) => rows(T.refund_links.filter((l) => l.id === id).map((l) => ({ lang: l.lang }))));
const updRequest = async (tx, r, patch) => {
  await lockRows(tx, 'refund_requests', [r]);
  const n = { ...r, ...patch };
  requestGuard(r, n, tx);
  const i = T.refund_requests.indexOf(r);
  T.refund_requests.splice(i, 1);
  try { checkRequest(n); } finally { T.refund_requests.splice(i, 0, r); }
  setRow(tx, r, n);
};
on(/^UPDATE refund_requests SET ack_message_id = \$2 WHERE id = \$1$/, async ([id, m], tx) => {
  const r = reqById(id); await updRequest(tx, r, { ack_message_id: m }); return { rows: [], rowCount: 1 };
});
// server.ts: Super Admin side
on(/^SELECT count\(\*\) FILTER \(WHERE status = 'new'(?: AND seen_at IS NULL)?\)::int AS (?:new|unseen), .* FROM refund_requests$/, () => {
  if (db.missingTables) throw pgErr('42P01', 'relation "refund_requests" does not exist');
  const c = (f) => T.refund_requests.filter(f).length;
  return rows([{ new: c((r) => r.status === 'new'), unseen: c((r) => r.status === 'new' && !r.seen_at), approved: c((r) => r.status === 'approved'),
    rejected: c((r) => r.status === 'rejected'), refunded: c((r) => r.status === 'refunded'), cancelled: c((r) => r.status === 'cancelled') }]);
});
on(/^SELECT business_id, count\(\*\)::int AS n FROM refund_requests WHERE status = 'new' GROUP BY business_id$/, () => {
  if (db.missingTables) throw pgErr('42P01', 'relation "refund_requests" does not exist');
  const by = {}; for (const r of T.refund_requests) if (r.status === 'new') by[r.business_id] = (by[r.business_id] || 0) + 1;
  return rows(Object.entries(by).map(([business_id, n]) => ({ business_id, n })));
});
on(/^SELECT count\(\*\)::int AS n FROM refund_links WHERE status = 'active' AND created_at > now\(\) - interval '14 days'$/,
  () => rows([{ n: T.refund_links.filter((l) => l.status === 'active' && tms(l.created_at) > NOW - 14 * DAY).length }]));
on(/^SELECT l\.id, l\.order_id, l\.order_snapshot, s\.name AS panel, l\.status, l\.revoked_reason, l\.created_at, l\.expires_at, l\.opened_count, l\.last_opened_at, l\.conversation_id FROM refund_links l LEFT JOIN sites s ON s\.id = l\.site_id WHERE l\.status = 'active' AND l\.created_at > now\(\) - interval '14 days' ORDER BY l\.created_at DESC LIMIT 100$/,
  () => rows(T.refund_links.filter((l) => l.status === 'active' && tms(l.created_at) > NOW - 14 * DAY).sort((a, b) => tms(b.created_at) - tms(a.created_at)).slice(0, 100)
    .map((l) => ({ ...pick(l, ['id', 'order_id', 'order_snapshot', 'status', 'revoked_reason', 'created_at', 'expires_at', 'opened_count', 'last_opened_at', 'conversation_id']), panel: site(l.site_id)?.name ?? null }))));
on(/^SELECT r\.id, r\.ref_code, r\.status, r\.seen_at, r\.created_at, r\.status_at, r\.order_id, r\.reason, r\.sub_reason, r\.order_snapshot, r\.payout_method, r\.payout_mask, r\.holder_matches, r\.return_needed, r\.conversation_id, r\.ack_message_id, s\.name AS panel, EXISTS \(SELECT 1 FROM refund_requests o WHERE o\.payout_fp = r\.payout_fp AND o\.id <> r\.id AND NOT \(o\.business_id = r\.business_id AND o\.order_id = r\.order_id\)\) AS payout_reused, \(SELECT count\(\*\) FROM refund_requests p WHERE r\.phone_fp IS NOT NULL AND p\.phone_fp = r\.phone_fp AND p\.created_at > now\(\) - interval '90 days'\)::int AS phone_count FROM refund_requests r LEFT JOIN sites s ON s\.id = r\.site_id WHERE \(\$1::text = 'all' OR r\.status = \$1::text\) AND \(\$2::timestamptz IS NULL OR r\.created_at < \$2::timestamptz\) ORDER BY r\.created_at DESC LIMIT 101$/,
  ([view, before]) => rows(T.refund_requests.filter((r) => (view === 'all' || r.status === view) && (before == null || tms(r.created_at) < tms(before)))
    .sort((a, b) => tms(b.created_at) - tms(a.created_at)).slice(0, 101).map((r) => ({
      ...pick(r, ['id', 'ref_code', 'status', 'seen_at', 'created_at', 'status_at', 'order_id', 'reason', 'sub_reason', 'order_snapshot', 'payout_method', 'payout_mask', 'holder_matches', 'return_needed', 'conversation_id', 'ack_message_id']),
      panel: site(r.site_id)?.name ?? null,
      payout_reused: T.refund_requests.some((o) => o.payout_fp === r.payout_fp && o.id !== r.id && !(o.business_id === r.business_id && o.order_id === r.order_id)),
      phone_count: r.phone_fp == null ? 0 : T.refund_requests.filter((p) => p.phone_fp === r.phone_fp && tms(p.created_at) > NOW - 90 * DAY).length,
    }))));
const REQ_COLS = ['id', 'ref_code', 'link_id', 'conversation_id', 'site_id', 'business_id', 'order_id', 'order_snapshot', 'phone_fp', 'reason', 'sub_reason', 'checked_around',
  'details', 'payout_method', 'payout_mask', 'payout_fp', 'holder_matches', 'consent_version', 'consent_at', 'submit_device', 'ack_message_id', 'status', 'status_at',
  'utr', 'gateway_checked', 'return_needed', 'return_note', 'return_told_at', 'seen_at', 'created_at'];
on(/^SELECT r\.id, r\.ref_code, r\.link_id, r\.conversation_id, r\.site_id, r\.business_id, r\.order_id, r\.order_snapshot, r\.phone_fp, r\.reason, r\.sub_reason, r\.checked_around, r\.details, r\.payout_method, r\.payout_mask, r\.payout_fp, r\.holder_matches, r\.consent_version, r\.consent_at, r\.submit_device, r\.ack_message_id, r\.status, r\.status_at, r\.refund_amount, r\.refund_date::text AS refund_date, r\.utr, r\.gateway_checked, r\.return_needed, r\.return_note, r\.return_told_at, r\.seen_at, r\.created_at FROM refund_requests r WHERE r\.id = \$1$/,
  ([id]) => {
    if (db.missingTables) throw pgErr('42P01', 'relation "refund_requests" does not exist');
    return rows(T.refund_requests.filter((r) => r.id === id).map((r) => ({ ...pick(r, REQ_COLS), refund_amount: num2(r.refund_amount), refund_date: r.refund_date ?? null })));
  });
// The chip's email state: the last email result of the link's form message (review fix 2026-10-02).
on(/^SELECT kind FROM refund_events WHERE link_id = \$1 AND kind IN \('email_sent', 'email_failed'\) AND meta->>'message_id' = \$2 ORDER BY id DESC LIMIT 1$/,
  ([l, m]) => rows(T.refund_events.filter((e) => e.link_id === l && ['email_sent', 'email_failed'].includes(e.kind) && String(e.meta?.message_id ?? '') === m)
    .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 1).map((e) => ({ kind: e.kind }))));
on(/^SELECT id, created_at, kind, link_id, meta FROM refund_events WHERE \(request_id = \$1 OR link_id = \$2\) AND kind IN \('link_sent', 'message_posted', 'message_failed', 'email_sent', 'email_failed'\) ORDER BY id$/,
  ([r, l]) => rows(T.refund_events.filter((e) => (e.request_id === r || e.link_id === l) && ['link_sent', 'message_posted', 'message_failed', 'email_sent', 'email_failed'].includes(e.kind))
    .sort((a, b) => Number(a.id) - Number(b.id)).map((e) => pick(e, ['id', 'created_at', 'kind', 'link_id', 'meta']))));
on(/^SELECT ref_code FROM refund_requests WHERE payout_fp = \$1 AND id <> \$2 AND NOT \(business_id = \$3 AND order_id = \$4\) ORDER BY created_at DESC LIMIT 5$/,
  ([fp, id, b, o]) => rows(T.refund_requests.filter((r) => r.payout_fp === fp && r.id !== id && !(r.business_id === b && r.order_id === o)).slice(0, 5).map((r) => ({ ref_code: r.ref_code }))));
on(/^SELECT count\(\*\)::int AS n FROM refund_requests WHERE phone_fp = \$1 AND created_at > now\(\) - interval '90 days'$/,
  ([fp]) => rows([{ n: T.refund_requests.filter((r) => r.phone_fp === fp && tms(r.created_at) > NOW - 90 * DAY).length }]));
on(/^UPDATE refund_requests SET seen_at = now\(\) WHERE id = \$1 AND seen_at IS NULL$/, async ([id], tx) => {
  const r = reqById(id);
  if (!r || r.seen_at) return { rows: [], rowCount: 0 };
  await updRequest(tx, r, { seen_at: now() }); return { rows: [], rowCount: 1 };
});
on(/^SELECT 1 AS x FROM refund_events WHERE request_id = \$1 AND kind = 'viewed' AND created_at > now\(\) - interval '10 minutes' LIMIT 1$/,
  ([r]) => rows(T.refund_events.filter((e) => e.request_id === r && e.kind === 'viewed' && tms(e.created_at) > NOW - 10 * MIN).slice(0, 1).map(() => ({ x: 1 }))));
on(/^SELECT created_at, expires_at, opened_count, first_opened_at, last_opened_at, submitted_at, lang FROM refund_links WHERE id = \$1$/,
  ([id]) => rows(T.refund_links.filter((l) => l.id === id).map((l) => pick(l, ['created_at', 'expires_at', 'opened_count', 'first_opened_at', 'last_opened_at', 'submitted_at', 'lang']))));
on(/^SELECT count\(DISTINCT ip_hash\)::int AS nets, array_remove\(array_agg\(DISTINCT meta->>'device'\), NULL\) AS devices FROM refund_events WHERE link_id = \$1 AND kind = 'link_opened'$/, ([l]) => {
  const evs = T.refund_events.filter((e) => e.link_id === l && e.kind === 'link_opened');
  return rows([{ nets: new Set(evs.map((e) => e.ip_hash).filter((x) => x != null)).size, devices: [...new Set(evs.map((e) => e.meta?.device).filter((x) => x != null))] }]);
});
on(/^SELECT id, created_at, kind, actor, from_status, to_status, note, meta FROM refund_events WHERE request_id = \$1 OR link_id = \$2 ORDER BY id DESC LIMIT 100$/,
  ([r, l]) => rows(T.refund_events.filter((e) => e.request_id === r || e.link_id === l).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 100)
    .map((e) => pick(e, ['id', 'created_at', 'kind', 'actor', 'from_status', 'to_status', 'note', 'meta']))));
on(/^SELECT id, link_id, conversation_id, payout_enc FROM refund_requests WHERE id = \$1$/, ([id]) => rows(T.refund_requests.filter((r) => r.id === id).map((r) => pick(r, ['id', 'link_id', 'conversation_id', 'payout_enc']))));
on(/^UPDATE refund_requests SET return_needed = \$2, return_note = \$3 WHERE id = \$1 AND status <> 'cancelled' RETURNING id$/, async ([id, need, note], tx) => {
  const r = reqById(id);
  if (!r || r.status === 'cancelled') return rows([]);
  await updRequest(tx, r, { return_needed: !!need, return_note: note ?? null });
  return rows([{ id: r.id }]);
});
on(/^UPDATE refund_requests SET status = \$3, status_at = now\(\), status_by = 'owner', utr = \$4, refund_amount = \$5, refund_date = \$6::date, gateway_checked = COALESCE\(\$7::boolean, gateway_checked\) WHERE id = \$1 AND status = \$2 RETURNING id, ref_code, status, conversation_id, link_id, payout_method$/,
  async ([id, expect, to, utr, amount, date, gw], tx) => {
    const r = reqById(id);
    if (!r) return rows([]);
    await lockRows(tx, 'refund_requests', [r]);
    if (r.status !== expect) return rows([]);
    await updRequest(tx, r, { status: to, status_at: now(), status_by: 'owner', utr: utr ?? null, refund_amount: amount == null ? null : Number(amount),
      refund_date: date ?? null, gateway_checked: gw == null ? r.gateway_checked : !!gw });
    return rows([pick(r, ['id', 'ref_code', 'status', 'conversation_id', 'link_id', 'payout_method'])]);
  });
on(/^SELECT ref_code FROM refund_requests WHERE utr = \$1 AND id <> \$2 LIMIT 1$/, ([u, id]) => rows(T.refund_requests.filter((r) => r.utr === u && r.id !== id).slice(0, 1).map((r) => ({ ref_code: r.ref_code }))));
on(/^SELECT ref_code FROM refund_requests WHERE business_id = \$1 AND order_id = \$2 AND id <> \$3 AND status IN \('new', 'approved', 'refunded'\) LIMIT 1$/,
  ([b, o, id]) => rows(T.refund_requests.filter((r) => r.business_id === b && r.order_id === o && r.id !== id && ['new', 'approved', 'refunded'].includes(r.status)).slice(0, 1).map((r) => ({ ref_code: r.ref_code }))));
on(/^SELECT status, status_at FROM refund_requests WHERE id = \$1$/, ([id]) => rows(T.refund_requests.filter((r) => r.id === id).map((r) => pick(r, ['status', 'status_at']))));
on(/^UPDATE refund_requests SET return_told_at = now\(\) WHERE id = \$1 AND return_needed AND return_told_at IS NULL AND status <> 'cancelled' RETURNING id, conversation_id, link_id$/, async ([id], tx) => {
  const r = reqById(id);
  if (!r) return rows([]);
  await lockRows(tx, 'refund_requests', [r]);
  if (!(r.return_needed && r.return_told_at == null && r.status !== 'cancelled')) return rows([]);
  await updRequest(tx, r, { return_told_at: now() });
  return rows([pick(r, ['id', 'conversation_id', 'link_id'])]);
});
// messages/[id]/route.ts (R16 only: in case slice D checks the text after reading the message)
const MSG_COLS = ['id', 'conversation_id', 'sender', 'content', 'metadata', 'created_at', 'edited_at', 'edited_by', 'deleted_at', 'deleted_by'];
on(/^SELECT m\.id, m\.conversation_id, m\.sender, m\.content, m\.metadata, m\.created_at, m\.edited_at, m\.edited_by, m\.deleted_at, m\.deleted_by, c\.source, s\.tracker_business_id FROM messages m JOIN conversations c ON c\.id = m\.conversation_id JOIN sites s ON s\.id = c\.site_id WHERE m\.id = \$1$/,
  ([id]) => rows(T.messages.filter((m) => m.id === id).map((m) => { const c = conv(m.conversation_id); return { ...pick(m, MSG_COLS), source: c.source, tracker_business_id: site(c.site_id).tracker_business_id }; })));
on(/^SELECT id, conversation_id, sender, content, metadata, created_at, edited_at, edited_by, deleted_at, deleted_by FROM messages WHERE id = \$1 FOR UPDATE$/, async ([id], tx) => {
  const found = T.messages.filter((m) => m.id === id);
  await lockRows(tx, 'messages', found);
  return rows(found.map((m) => pick(m, MSG_COLS)));
});
on(/^SELECT id, conversation_id, content FROM messages WHERE id = \$1 AND sender = 'system'$/, ([id]) => rows(T.messages.filter((m) => m.id === id && m.sender === 'system').map((m) => pick(m, ['id', 'conversation_id', 'content']))));
const EVENT_KINDS = ['link_sent', 'link_revoked', 'link_opened', 'file_added', 'file_rejected', 'file_deleted', 'submitted', 'viewed', 'revealed', 'file_viewed', 'status',
  'note', 'return_flag', 'return_told', 'message_posted', 'message_failed', 'email_sent', 'email_failed', 'rekey'];
on(/^INSERT INTO refund_events \(link_id, request_id, conversation_id, kind, actor, from_status, to_status, note, ip_hash, meta\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10::jsonb\)$/,
  (p, tx) => {
    const e = { id: String(++db.evSeq), created_at: now(), link_id: p[0], request_id: p[1], conversation_id: p[2], kind: p[3], actor: p[4], from_status: p[5], to_status: p[6], note: p[7], ip_hash: p[8], meta: json(p[9]) };
    if (!EVENT_KINDS.includes(e.kind)) throw checkErr('refund_events', 'refund_events_kind_check', e);
    if (!['owner', 'customer', 'system'].includes(e.actor)) throw checkErr('refund_events', 'refund_events_actor_check', e);
    if (e.note != null && Array.from(e.note).length > 500) throw checkErr('refund_events', 'refund_events_note_check', e);
    if (e.ip_hash != null && String(e.ip_hash).length > 32) throw checkErr('refund_events', 'refund_events_ip_hash_check', e);
    ins(tx, 'refund_events', e);
    return { rows: [], rowCount: 1 };
  });

// Postgres refuses a parameter it never reads, or reads one it was not sent.
function checkParams(q, params) {
  const used = new Set(Array.from(q.matchAll(/\$(\d+)/g), (m) => Number(m[1])));
  for (let i = 1; i <= params.length; i++) if (!used.has(i)) throw new Error(`fake db: $${i} is sent but never used: ${q.slice(0, 90)}`);
  for (const u of used) if (u > params.length) throw new Error(`fake db: $${u} is used but not sent: ${q.slice(0, 90)}`);
}
async function run(sql, params, tx) {
  const q = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  db.log.push({ q, params: p, tx: tx.id });
  if (tx.aborted && !/^ROLLBACK/.test(q)) throw pgErr('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
  if (/^ROLLBACK TO SAVEPOINT (\w+)$/.test(q)) {
    const name = q.split(' ')[3]; const i = tx.savepoints.map((s) => s.name).lastIndexOf(name);
    if (i < 0) throw pgErr('3B001', `savepoint "${name}" does not exist`);
    const sp = tx.savepoints[i];
    while (tx.undo.length > sp.undo) tx.undo.pop()();
    tx.savepoints.length = i + 1; tx.aborted = false;
    return rows([]);
  }
  try {
    checkParams(q, p);
    const f = db.fails.find((x) => x.re.test(q) && x.times > 0);
    if (f) { f.times--; throw f.make ? f.make(p) : pgErr(f.code, f.message || 'injected failure'); }
    const h = H.find(([re]) => re.test(q));
    if (!h) throw Object.assign(new Error('fake db: unexpected SQL: ' + q.slice(0, 200)), { unexpected: true });
    return await h[1](p, tx, q);
  } catch (e) {
    if (e.unexpected) db.violations.push(e.message);
    if (!tx.auto) tx.aborted = true;
    throw e;
  }
}
global.__refundFakeDb = {
  async pool(sql, params) {
    const outer = als.getStore();
    if (outer) db.violations.push('a pool query from inside a transaction: ' + String(sql).replace(/\s+/g, ' ').trim().slice(0, 80));
    const tx = newTx(true);
    try { const r = await run(sql, params, tx); return r; } catch (e) { while (tx.undo.length) tx.undo.pop()(); throw e; } finally { releaseAll(tx); }
  },
  async withTransaction(fn) {
    const tx = newTx(false);
    const client = { query: (sql, params) => run(sql, params, tx) };
    db.log.push({ q: 'BEGIN', params: [], tx: tx.id });
    return als.run(tx, async () => {
      try {
        const r = await fn(client);
        if (tx.aborted) db.violations.push('COMMIT of an aborted transaction (an error was swallowed)');
        db.log.push({ q: 'COMMIT', params: [], tx: tx.id });
        return r;
      } catch (e) {
        while (tx.undo.length) tx.undo.pop()();
        db.log.push({ q: 'ROLLBACK', params: [], tx: tx.id });
        throw e;
      } finally { releaseAll(tx); }
    });
  },
};
// A transaction the test holds open (a busy chat): resolves its lock until release().
async function holdRow(table, row) {
  const tx = newTx(false); tx.lockTimeout = 5000;
  await acquire(tx, rowKey(table, row), 'x');
  return () => releaseAll(tx);
}

// ══ The code ════════════════════════════════════════════════════
const auth = load('lib/auth.ts');
const rcrypto = load('lib/refund/crypto.ts');
const limits = load('lib/refund/limits.ts');
const server = load('lib/refund/server.ts');
const lm = load('lib/refund/link-mask.ts');
const R = {
  open: load('app/api/refund/open/route.ts'),
  submit: load('app/api/refund/submit/route.ts'),
  form: load('app/api/chat/conversations/[id]/refund-form/route.ts'),
  list: load('app/api/refunds/route.ts'),
  counts: load('app/api/refunds/counts/route.ts'),
  one: load('app/api/refunds/[id]/route.ts'),
  reveal: load('app/api/refunds/[id]/reveal/route.ts'),
};

// ══ Data ════════════════════════════════════════════════════════
const BIZ = '7b1c0e4a-1111-4111-8111-000000000001';
const SITE1 = 'site-vastora', SITE2 = 'site-vastora-mail', SITE3 = 'site-no-panel';
const IDS = { neha: 'a0000000-0000-4000-8000-00000000000a', rahul: 'b0000000-0000-4000-8000-00000000000b', anurag: 'c0000000-0000-4000-8000-00000000000c' };
T.team_users = [
  { id: IDS.neha, username: 'neha', display_name: 'Neha', role: 'panel_admin', is_active: true, business_ids: null, permissions: null, session_version: 1 },
  { id: IDS.rahul, username: 'rahul', display_name: 'Rahul', role: 'agent', is_active: true, business_ids: null, permissions: ['orders.view', 'chat.view', 'chat.reply', 'chat.cases', 'chat.edit', 'chat.senior'], session_version: 1 },
  { id: IDS.anurag, username: 'anurag', display_name: 'Anurag', role: 'agent', is_active: true, business_ids: null, permissions: null, session_version: 1 },
];
T.admin_login = [{ username: 'jatin.owner', password_hash: 'not-used', session_version: 2, updated_at: new Date(BASE_NOW - DAY) }];
T.sites = [{ id: SITE1, name: 'Vastora', tracker_business_id: BIZ }, { id: SITE2, name: 'Vastora', tracker_business_id: BIZ }, { id: SITE3, name: 'Loose site', tracker_business_id: null }];
T.businesses = [{ id: BIZ, logo_url: 'https://cdn.example.test/vastora.png' }];
T.site_emails = [{ site_id: SITE2, email: 'support@example.test', app_password: 'app-pass-x' }];

const owner = () => auth.generateToken('jatin.owner', 'admin', null, { name: 'Super Admin', sv: 2 });
const member = (u) => auth.generateToken(u, T.team_users.find((x) => x.username === u).role, null, { name: u, uid: IDS[u], sv: 1 });
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const ORIGIN = 'https://shiptrack.store';
let seq = 0, itemSeq = 0;
const SECRETS = { names: new Set(), phones: new Set(), details: new Set(), tokens: new Set() };
function mkOrder(o = {}) {
  const n = ++seq;
  const order_id = o.order_id || `#${7000 + n}`;
  const phone = `98${String(76500000 + n * 7919).slice(-8)}`;
  const name = o.customer_name || `Meera Sharma${'abcdefghijklmnopqrstuvwxyz'[n % 26]}`;
  SECRETS.names.add(name); SECRETS.phones.add(phone);
  T.orders.push({ id: nodeCrypto.randomUUID(), order_id, business_id: BIZ, customer_name: name, customer_mobile: `+91 ${phone}`, payment_method: 'COD',
    financial_status: 'pending', order_total: '1299.00', tracking_status: 'Delivered', delivered_at: new Date(NOW - 3 * DAY), is_cancelled: false,
    created_at: new Date(NOW - 12 * DAY), ...o, order_id });
  T.order_items.push({ id: ++itemSeq, order_id, product_name: 'Kurta Set - Blue / M', quantity: 1, price: '1299.00' });
  return order_id;
}
function mkConv(order, o = {}) {
  const id = `conv-${String(++seq).padStart(4, '0')}`;
  T.conversations.push({ id, site_id: SITE1, source: 'chat', status: 'agent_handling', visitor_id: `v-${id}`, customer_key: null, case_kind: 'refund',
    case_order_id: order, verified_order_id: order, verified_via: 'form', merged_into: null, unread_count: 0, last_message_at: new Date(NOW - HOUR),
    updated_at: new Date(NOW - HOUR), assigned_to: null, phone_match_order_id: null, ...o });
  return id;
}
function say(convId, text) {
  SECRETS.details.add(text);
  T.messages.push({ id: nodeCrypto.randomUUID(), conversation_id: convId, sender: 'visitor', content: text, metadata: null, created_at: new Date(NOW - 20 * MIN), deleted_at: null });
}

// ── Calling the routes ──
async function call(handler, req, params) {
  const res = await handler(req, { params: params || {} });
  const bytes = Buffer.from(await res.arrayBuffer());
  let body = null;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { body = null; }
  return { status: res.status, headers: res.headers, body, text: bytes.toString('utf8'), bytes };
}
let ipSeq = 0;
const freshIp = () => `10.20.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
function preq(p, { method = 'POST', body, raw, headers = {}, ip = '10.1.1.1' } = {}) {
  const h = { host: 'shiptrack.store', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-real-ip': ip, 'user-agent': UA };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (raw !== undefined) h['content-type'] = 'application/octet-stream';
  Object.assign(h, headers);
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
  return new Request(ORIGIN + p, { method, headers: h, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : raw });
}
function areq(p, token, { method = 'GET', body } = {}) {
  const h = { 'x-real-ip': '10.9.9.9', 'user-agent': UA };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return new Request(ORIGIN + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
const open = (token, o = {}) => call(R.open.POST, preq('/api/refund/open', { body: { token }, ...o }));
const submit = (token, f, o = {}) => call(R.submit.POST, preq('/api/refund/submit', { body: { token, ...f }, ...o }));
const formGet = (convId, tok = owner()) => call(R.form.GET, areq(`/api/chat/conversations/${convId}/refund-form`, tok), { id: convId });
const formPost = (convId, body = {}, tok = owner()) => call(R.form.POST, areq(`/api/chat/conversations/${convId}/refund-form`, tok, { method: 'POST', body }), { id: convId });
const formDelete = (convId, tok = owner()) => call(R.form.DELETE, areq(`/api/chat/conversations/${convId}/refund-form`, tok, { method: 'DELETE' }), { id: convId });
const list = (q = '', tok = owner()) => call(R.list.GET, areq(`/api/refunds${q}`, tok));
const counts = (tok = owner()) => call(R.counts.GET, areq('/api/refunds/counts', tok));
const detail = (id, tok = owner()) => call(R.one.GET, areq(`/api/refunds/${id}`, tok), { id });
const patch = (id, body, tok = owner()) => call(R.one.PATCH, areq(`/api/refunds/${id}`, tok, { method: 'PATCH', body }), { id });
const reveal = (id, tok = owner()) => call(R.reveal.POST, areq(`/api/refunds/${id}/reveal`, tok, { method: 'POST' }), { id });

const UPI = 'qtestrefund.k77@okaxis', HOLDER = 'MEERA QTESTHOLDER', ACCOUNT = '501009988776655', IFSC = 'HDFC0QT4321';
const DETAILS = 'Size L aaya jabki maine M order kiya tha, packet kholte hi pata chala.';
SECRETS.details.add(DETAILS);
const fill = (o = {}) => ({ client_nonce: nodeCrypto.randomUUID(), reason: 'wrong_missing', sub_reason: 'wrong_size', checked_around: false, details: DETAILS,
  method: 'upi', upi: UPI, holder: HOLDER, account: null, account_confirm: null, ifsc: null, consent: true, ...o });
const tokenOfMsg = (msgId) => {
  const m = T.messages.find((x) => x.id === msgId);
  const t = (/\/refund#([A-Za-z0-9_-]{43})/.exec(m ? m.content : '') || [])[1];
  if (t) SECRETS.tokens.add(t);
  return t;
};
// A Refund chat with a link sent (and the customer's token).
async function withLink(o = {}) {
  const order = mkOrder(o.order);
  const convId = mkConv(order, o.conv);
  if (o.hinglish) say(convId, 'mera refund kab milega bhai, size galat aaya hai');
  const r = await formPost(convId, o.body || {});
  assert.strictEqual(r.status, 200, `send: ${r.status} ${r.body && (r.body.error || r.body.block)}`);
  const link = T.refund_links.find((l) => l.message_id === r.body.message.id);
  return { order, convId, token: tokenOfMsg(r.body.message.id), link, msgId: r.body.message.id, res: r };
}
async function withRequest(o = {}) {
  const c = await withLink(o);
  const s = await submit(c.token, fill(o.form || {}), { ip: freshIp() });
  assert.strictEqual(s.status, 200, `submit: ${s.status} ${JSON.stringify(s.body)}`);
  const req = T.refund_requests.find((r) => r.ref_code === s.body.ref);
  return { ...c, ref: s.body.ref, req, id: req.id };
}
const jpeg = (size) => { const b = nodeCrypto.randomBytes(size); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; return b; };
const sysMsgs = (convId) => T.messages.filter((m) => m.conversation_id === convId && m.sender === 'system');
const events = (f) => T.refund_events.filter(f);
const sha = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');
function reset() {
  NOW = BASE_NOW; limits.resetRefundLimits(); db.fails.length = 0; emails.mode = 'ok'; db.missingTables = false; db.mailboxGoneAfterCommit = false;
  process.env.REFUND_DATA_KEY = KEY; delete process.env.REFUND_FORMS; delete process.env.REFUND_DATA_KEY_OLD;
}

// ── Runner ──
let passed = 0;
const failed = [];
const clean = (s) => String(s).replace(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+/g, '[x@y]').replace(/[A-Za-z0-9_-]{40,}/g, '[long]').replace(/\d{6,}/g, '[digits]');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const eq = (a, b, m) => assert.strictEqual(a, b, m);
const deq = (a, b, m) => assert.deepStrictEqual(a, b, m);
const ok = (v, m) => assert.ok(v, m);

// ══ R1: auth ════════════════════════════════════════════════════
t('R1 the first Super Admin request after a restart waits for the logins (authReady)', async () => {
  db.adminDelay = 40;
  const r = await counts();
  db.adminDelay = 0;
  eq(r.status, 200, 'a Super Admin token is refused until the logins are read: the route must wait');
  deq(Object.keys(r.body).sort(), ['approved', 'new', 'unseen']);
});
t('R1 every Super Admin route: 401 without a login, 403 for staff (panel admin, senior, agent), Super Admin allowed', async () => {
  const c = await withRequest();
  const calls = [
    ['refund-form GET', (tok) => formGet(c.convId, tok)],
    ['refund-form POST', (tok) => formPost(c.convId, {}, tok)],
    ['refund-form DELETE', (tok) => formDelete(c.convId, tok)],
    ['refunds GET', (tok) => list('', tok)],
    ['counts GET', (tok) => counts(tok)],
    ['detail GET', (tok) => detail(c.id, tok)],
    ['detail PATCH', (tok) => patch(c.id, { action: 'note', note: 'checked' }, tok)],
    ['reveal POST', (tok) => reveal(c.id, tok)],
  ];
  for (const [name, fn] of calls) {
    eq((await fn(null)).status, 401, `${name}: no login`);
    for (const u of ['neha', 'rahul', 'anurag']) {
      const r = await fn(member(u));
      eq(r.status, 403, `${name}: ${u} (team member) must be refused`);
      ok(!/payout|upi|ref_code|RF-/.test(r.text), `${name}: a refusal carries no refund data`);
    }
  }
  eq((await list('', owner())).status, 200);
  eq((await counts(owner())).status, 200);
  eq((await detail(c.id, owner())).status, 200);
  eq((await formGet(c.convId, owner())).status, 200);
  const tamper = owner().replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
  eq((await counts(tamper)).status, 401, 'a tampered token');
});

// ══ R2: Send gates ══════════════════════════════════════════════
t('R2 every block: its code, status and text; nothing is sent', async () => {
  const before = T.refund_links.length, msgs = T.messages.length;
  const cases = [];
  const o1 = mkOrder(); cases.push(['not_refund_case', mkConv(o1, { case_kind: null }), 400, /only from a chat in the Refund section/]);
  const o2 = mkOrder(); cases.push(['not_verified', mkConv(o2, { verified_order_id: null, phone_match_order_id: o2 }), 400, /has not verified this order here/]);
  const o3 = mkOrder(); cases.push(['not_verified', mkConv(o3, { verified_via: 'legacy' }), 400, /Order ID \+ full phone/]);
  const o4 = mkOrder(), o4b = mkOrder(); cases.push(['order_mismatch', mkConv(o4, { verified_order_id: o4b }), 400, new RegExp(`marked for order ${o4} but the chat is now verified for ${o4b}`)]);
  const o5 = mkOrder(); cases.push(['no_panel', mkConv(o5, { site_id: SITE3 }), 400, /no panel/]);
  cases.push(['order_not_found', mkConv('#404404'), 400, /Order #404404 was not found in this panel/]);
  const o7 = mkOrder(); cases.push(['no_mailbox', mkConv(o7, { source: 'email', site_id: SITE1, visitor_id: 'email:buyer@example.test' }), 400, /no mailbox/]);
  const o8 = mkOrder(), target = mkConv(o8); cases.push(['merged', mkConv(o8, { merged_into: target }), 409, /merged into the customer's other chat/]);
  for (const [block, convId, status, re] of cases) {
    const g = await formGet(convId);
    eq(g.status, 200, `${block}: dialog GET`);
    eq(g.body.block, block, `${block}: dialog block`);
    eq(g.body.can_send, false, `${block}: can_send`);
    ok(re.test(g.body.block_text), `${block}: dialog text`);
    const p = await formPost(convId, {});
    eq(p.status, status, `${block}: POST status`);
    eq(p.body.block, block, `${block}: POST block`);
    ok(re.test(p.body.error), `${block}: POST text`);
  }
  eq(T.refund_links.length, before, 'no link');
  eq(T.messages.length, msgs, 'no message');
  // The kill switch and a missing key: 503 setup, nothing sent.
  const o9 = mkOrder(), c9 = mkConv(o9);
  process.env.REFUND_FORMS = 'off';
  let p = await formPost(c9, {});
  eq(p.status, 503, 'REFUND_FORMS=off'); eq(p.body.block, 'setup');
  eq((await formGet(c9)).body.block, 'setup');
  delete process.env.REFUND_FORMS; delete process.env.REFUND_DATA_KEY;
  p = await formPost(c9, {});
  eq(p.status, 503, 'key missing'); eq(p.body.block, 'setup');
  process.env.REFUND_DATA_KEY = 'x'.repeat(10);
  eq((await formPost(c9, {})).status, 503, 'a bad key is no key');
  process.env.REFUND_DATA_KEY = KEY;
  eq(T.refund_links.length, before, 'still no link');
});
t('R2 the dialog: order facts, warnings (COD not delivered, prepaid, cancelled, Closed chat), preview masked, language', async () => {
  const o = mkOrder({ payment_method: 'COD', tracking_status: 'In Transit', delivered_at: null, is_cancelled: true });
  const convId = mkConv(o, { status: 'resolved' });
  say(convId, 'bhai mera paisa wapas kab milega');
  const g = await formGet(convId);
  eq(g.status, 200);
  eq(g.body.can_send, true);
  const codes = g.body.warnings.map((w) => w.code);
  for (const c of ['closed_chat', 'cod_not_delivered', 'order_cancelled']) ok(codes.includes(c), `warning ${c}`);
  ok(!codes.includes('prepaid'), 'COD is not prepaid');
  eq(g.body.lang, 'hinglish', 'the chat writes Hinglish');
  eq(g.body.order.order_id, o); eq(g.body.order.payment, 'COD'); eq(g.body.order.delivered, false);
  ok(g.body.preview.hinglish.includes('[refund form link]') && g.body.preview.en.includes('[refund form link]'), 'preview masked');
  ok(!/\/refund#/.test(g.text), 'no raw link anywhere in the dialog');
  eq(g.headers.get('cache-control'), 'no-store');
  const p = mkOrder({ payment_method: 'razorpay', financial_status: 'paid' });
  const g2 = await formGet(mkConv(p));
  const pre = g2.body.warnings.find((w) => w.code === 'prepaid');
  ok(pre, 'prepaid warning');
  // Owner answer Q1 (rule 18 changed): the refund goes to the customer's UPI / bank; the gateway is
  // checked for an open refund / chargeback only (no double refund). Never "go back through the gateway".
  ok(/UPI \/ bank/.test(pre.text) && /payment gateway/.test(pre.text) && !/normally go back|through the payment gateway/i.test(pre.text), 'prepaid warning matches Q1');
  eq(g2.body.can_send, true, 'owner answer Q1: prepaid orders may be sent too');
  eq(g2.body.order.payment, 'Prepaid');
});

// ══ R3: Send success ════════════════════════════════════════════
t('R3 Send: one active link, one system message with the raw link, nothing else in the chat changes', async () => {
  const order = mkOrder();
  const convId = mkConv(order, { assigned_to: IDS.rahul, status: 'agent_handling', unread_count: 2 });
  say(convId, 'where is my refund for the wrong size');
  const chatEventsBefore = T.chat_events.length;
  const r = await formPost(convId, {});
  eq(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const links = T.refund_links.filter((l) => l.order_id === order);
  eq(links.length, 1); eq(links[0].status, 'active');
  const msgs = sysMsgs(convId);
  eq(msgs.length, 1, 'one system message');
  const m = msgs[0];
  const token = tokenOfMsg(m.id);
  ok(token && /^[A-Za-z0-9_-]{43}$/.test(token), 'the message carries the raw link (43-character token)');
  ok(m.content.includes(`https://shiptrack.store/refund#${token}\n`), 'link on the base URL, followed by a newline');
  deq(m.metadata, { system: 'refund', step: 'form', lang: 'en' }, 'metadata: only system, step, lang');
  ok(m.content.includes(order), 'the order id is in the text');
  const l = links[0];
  eq(l.message_id, m.id); eq(l.token_hash, sha(token)); eq(tms(l.expires_at) - tms(l.created_at), 7 * DAY);
  eq(l.conversation_id, convId); eq(l.channel, 'chat'); eq(l.lang, 'en'); eq(l.created_by, 'owner');
  ok(!JSON.stringify(l.order_snapshot).includes(T.orders.find((o) => o.order_id === order).customer_mobile.replace(/\D/g, '').slice(-10)), 'no full phone in the snapshot');
  eq(l.order_snapshot.phone_last4.length, 4);
  const c = T.conversations.find((x) => x.id === convId);
  eq(c.assigned_to, IDS.rahul, 'the holder stays (J2)'); eq(c.status, 'agent_handling'); eq(c.unread_count, 2, 'unread unchanged');
  eq(T.chat_events.length, chatEventsBefore, 'no chat_events row');
  eq(events((e) => e.link_id === l.id && e.kind === 'link_sent').length, 1);
  eq(r.body.message.sender, 'system');
  ok(r.body.message.content.includes('[refund form link]') && !r.body.message.content.includes('/refund#'), 'the answer shows the link masked');
  ok(!r.text.includes(token) && !r.text.includes(sha(token)), 'neither the token nor its hash in the answer');
  eq(r.body.emailed, null);
  eq(r.body.state.link.state, 'active');
  // Hinglish chat, or the language picked in the dialog.
  const h = await withLink({ hinglish: true });
  eq(T.messages.find((x) => x.id === h.msgId).metadata.lang, 'hinglish');
  ok(T.messages.find((x) => x.id === h.msgId).content.startsWith(`Aapke order ${h.order} ki refund request`), 'Hinglish text');
  const e = await withLink({ hinglish: true, body: { lang: 'en' } });
  eq(T.messages.find((x) => x.id === e.msgId).metadata.lang, 'en', 'the dialog choice wins');
});

// ══ R4: re-issue ════════════════════════════════════════════════
t('R4 pressing again: need replace, expectLinkId, cooldown, a replace revokes the old link in the same transaction', async () => {
  const c = await withLink();
  let r = await formPost(c.convId, {});
  eq(r.status, 409, 'double click: replace needed'); eq(r.body.need, 'replace'); eq(r.body.link.id, c.link.id);
  r = await formPost(c.convId, { replace: true, expectLinkId: nodeCrypto.randomUUID() });
  eq(r.status, 409, 'a wrong expectLinkId'); ok(/Something changed/.test(r.body.error)); ok(r.body.state, 'the fresh state comes along');
  r = await formPost(c.convId, { replace: true, expectLinkId: c.link.id });
  eq(r.status, 429, 'within 60 s: cooldown'); eq(r.body.block, 'cooldown');
  NOW += 61_000;
  r = await formPost(c.convId, { replace: true, expectLinkId: c.link.id });
  eq(r.status, 200, 'replace after the cooldown');
  const old = T.refund_links.find((l) => l.id === c.link.id);
  eq(old.status, 'revoked'); eq(old.revoked_reason, 'reissued');
  const fresh = T.refund_links.filter((l) => l.order_id === c.order && l.status === 'active');
  eq(fresh.length, 1, 'one active link'); eq(old.replaced_by, fresh[0].id);
  eq(sysMsgs(c.convId).length, 2, 'two form messages in all');
  eq(events((e) => e.link_id === old.id && e.kind === 'link_revoked').length, 1);
  eq((await open(c.token, { ip: freshIp() })).body.state, 'replaced', 'the old link says replaced');
  // An expired link is replaced without a confirm.
  NOW += 8 * DAY;
  r = await formPost(c.convId, {});
  eq(r.status, 200, 'expired: no confirm needed');
  eq(T.refund_links.filter((l) => l.order_id === c.order && l.status === 'active').length, 1);
});
t('R4 at most 5 links per order in 7 days; an open request blocks; a rejected or cancelled one allows a new form', async () => {
  const c = await withLink();
  let lastId = c.link.id;
  for (let i = 0; i < 4; i++) {
    NOW += 61_000;
    const r = await formPost(c.convId, { replace: true, expectLinkId: lastId });
    eq(r.status, 200, `link ${i + 2}`);
    lastId = T.refund_links.find((l) => l.order_id === c.order && l.status === 'active').id;
  }
  NOW += 61_000;
  const r6 = await formPost(c.convId, { replace: true, expectLinkId: lastId });
  eq(r6.status, 429, 'the 6th link in 7 days'); eq(r6.body.block, 'too_many');
  const q = await withRequest();
  const blocked = await formPost(q.convId, {});
  eq(blocked.status, 409); eq(blocked.body.block, 'request_open'); eq(blocked.body.request.ref, q.ref);
  ok(blocked.body.error.includes(q.ref), 'the text names the ref');
  NOW += 61_000;
  eq((await patch(q.id, { action: 'reject', expect: 'new', note: 'photo shows a different product' })).status, 200);
  const g = await formGet(q.convId);
  eq(g.body.can_send, true, 'after Rejected a new form may go');
  ok(g.body.warnings.some((w) => w.code === 'rejected_before'));
  eq((await formPost(q.convId, {})).status, 200, 'sent after rejected');
  const k = await withRequest();
  eq((await patch(k.id, { action: 'cancel', expect: 'new', note: 'test request' })).status, 200);
  NOW += 61_000;
  eq((await formPost(k.convId, {})).status, 200, 'sent after cancelled');
  for (const st of ['approved', 'refunded']) {
    const z = await withRequest();
    eq((await patch(z.id, { action: 'approve', expect: 'new' })).status, 200);
    if (st === 'refunded') eq((await patch(z.id, { action: 'refunded', expect: 'approved', utr: `UTR${seq}99887766`, amount: '1299', refund_date: '2026-10-05' })).status, 200);
    eq((await formPost(z.convId, {})).body.block, 'request_open', `${st} blocks`);
  }
});
t('R4 Cancel link: the link stops working, nothing is sent; a second cancel is 404', async () => {
  const c = await withLink();
  const msgs = T.messages.length;
  const d = await formDelete(c.convId);
  eq(d.status, 200); eq(d.body.ok, true);
  eq(T.refund_links.find((l) => l.id === c.link.id).revoked_reason, 'cancelled');
  eq(T.messages.length, msgs, 'nothing sent');
  eq((await open(c.token, { ip: freshIp() })).body.state, 'cancelled');
  eq((await formDelete(c.convId)).status, 404);
});

// ══ R5: email chats ═════════════════════════════════════════════
t('R5 an email chat: the email goes once with the raw link; a failed send keeps the message, records it, and retry_email sends the same text', async () => {
  const order = mkOrder();
  const convId = mkConv(order, { source: 'email', site_id: SITE2, visitor_id: 'email:buyer77@example.test' });
  const g = await formGet(convId);
  eq(g.body.channel, 'email'); ok(/^b•••@example\.test$/.test(g.body.email_to), 'email masked');
  emails.sent.length = 0;
  const r = await formPost(convId, {});
  eq(r.status, 200); eq(r.body.emailed, true);
  eq(emails.sent.length, 1, 'one email');
  eq(emails.sent[0].convId, convId);
  const token = tokenOfMsg(r.body.message.id);
  ok(emails.sent[0].content.includes(`/refund#${token}`), 'the email carries the raw link');
  eq(T.messages.find((m) => m.id === r.body.message.id).metadata.emailed, true);
  eq(events((e) => e.kind === 'email_sent' && e.meta?.message_id === r.body.message.id).length, 1);
  // The mail server refuses.
  const order2 = mkOrder();
  const conv2 = mkConv(order2, { source: 'email', site_id: SITE2, visitor_id: 'email:buyer78@example.test' });
  emails.mode = 'throw'; emails.sent.length = 0;
  const f = await formPost(conv2, {});
  eq(f.status, 200, 'the send itself succeeds'); eq(f.body.emailed, false);
  const msg = T.messages.find((m) => m.id === f.body.message.id);
  ok(msg, 'the message is kept'); eq(msg.metadata.emailed, false);
  eq(events((e) => e.kind === 'email_failed' && e.meta?.message_id === msg.id && e.meta?.code === 'EAUTH').length, 1);
  eq(T.refund_links.find((l) => l.message_id === msg.id).status, 'active', 'the link stays valid');
  emails.mode = 'ok';
  const tok2 = tokenOfMsg(msg.id);
  const s = await submit(tok2, fill(), { ip: freshIp() });
  eq(s.status, 200);
  const req = T.refund_requests.find((x) => x.ref_code === s.body.ref);
  const d = await detail(req.id);
  ok(d.body.allowed.includes('retry_email'), 'retry offered');
  ok(d.body.flags.some((x) => x.code === 'email_failed'), 'email_failed flag');
  const rowsBefore = T.messages.length; emails.sent.length = 0;
  const rt = await patch(req.id, { action: 'retry_email', message_id: msg.id });
  eq(rt.status, 200); eq(rt.body.emailed, true);
  eq(emails.sent.length, 1); eq(emails.sent[0].content, msg.content, 'the same text');
  eq(T.messages.length, rowsBefore, 'no new message row');
  eq((await patch(req.id, { action: 'retry_email', message_id: msg.id })).status, 409, 'nothing failed any more');
  // The mailbox gone by the time the email goes (spec 4.5: sendAgentEmailReply would return silently):
  // emailed false, email_failed no_mailbox, nothing handed to the mailer.
  const order4 = mkOrder();
  const conv4 = mkConv(order4, { source: 'email', site_id: SITE2, visitor_id: 'email:buyer80@example.test' });
  emails.sent.length = 0; db.mailboxGoneAfterCommit = true;
  const gone = await formPost(conv4, {});
  db.mailboxGoneAfterCommit = false;
  eq(gone.status, 200); eq(gone.body.emailed, false); eq(emails.sent.length, 0, 'the mailer is not called without a mailbox');
  eq(events((e) => e.kind === 'email_failed' && e.meta?.message_id === gone.body.message.id && e.meta?.code === 'no_mailbox').length, 1);
  // A mailbox removed between the dialog and the send: blocked before anything is sent.
  const order3 = mkOrder();
  const conv3 = mkConv(order3, { source: 'email', site_id: SITE1, visitor_id: 'email:buyer79@example.test' });
  emails.sent.length = 0;
  const nb = await formPost(conv3, {});
  eq(nb.body.block, 'no_mailbox'); eq(emails.sent.length, 0);
});

t('R5 a failed form email stays on the chip (red) and Retry email sends the same message once: no new link, no new row; never a dead link', async () => {
  const cv = (id) => ({ ...T.conversations.find((x) => x.id === id), tracker_business_id: BIZ });
  const failedSend = async (who) => {
    const order = mkOrder();
    const convId = mkConv(order, { source: 'email', site_id: SITE2, visitor_id: `email:${who}@example.test` });
    emails.mode = 'throw';
    const f = await formPost(convId, {});
    emails.mode = 'ok';
    eq(f.status, 200); eq(f.body.emailed, false);
    return { order, convId, f, msgId: f.body.message.id, linkId: T.refund_links.find((l) => l.message_id === f.body.message.id).id };
  };
  const a = await failedSend('buyer91');
  eq(a.f.body.state.link.email_failed, true, 'the dialog state says the email failed');
  let st = await server.refundThreadState(cv(a.convId));
  eq(st.link.state, 'active'); eq(st.link.email_failed, true, 'the chip stays red after the toast is gone');
  // Staff never reach it (the route's Super Admin gate).
  eq((await formPost(a.convId, { action: 'retry_email', linkId: a.linkId }, member('rahul'))).status, 403);
  // A stale link id (a new link was sent from another tab): 409, nothing sent.
  emails.sent.length = 0;
  eq((await formPost(a.convId, { action: 'retry_email', linkId: 'some-other-link' })).status, 409);
  eq(emails.sent.length, 0);
  // Still failing: recorded again, still red.
  emails.mode = 'throw';
  let r = await formPost(a.convId, { action: 'retry_email', linkId: a.linkId });
  emails.mode = 'ok';
  eq(r.status, 200); eq(r.body.emailed, false); eq(r.body.state.link.email_failed, true);
  // Retry works: the SAME message, once; no new message row, no new link, the link unchanged.
  const msgs = T.messages.length, links = T.refund_links.length;
  emails.sent.length = 0;
  r = await formPost(a.convId, { action: 'retry_email', linkId: a.linkId });
  eq(r.status, 200); eq(r.body.emailed, true);
  eq(emails.sent.length, 1, 'one email'); eq(emails.sent[0].convId, a.convId);
  eq(emails.sent[0].content, T.messages.find((m) => m.id === a.msgId).content, 'the same text, the same link');
  eq(T.messages.length, msgs, 'no new message row'); eq(T.refund_links.length, links, 'no new link');
  eq(T.refund_links.find((l) => l.id === a.linkId).status, 'active');
  eq(T.messages.find((m) => m.id === a.msgId).metadata.emailed, true);
  eq(events((e) => e.kind === 'email_sent' && e.link_id === a.linkId && e.meta?.message_id === a.msgId && e.meta?.step === 'form').length, 1);
  st = await server.refundThreadState(cv(a.convId));
  eq(st.link.email_failed, false, 'the chip is back to "Form sent"');
  eq((await formPost(a.convId, { action: 'retry_email', linkId: a.linkId })).status, 409, 'nothing failed any more');
  eq(emails.sent.length, 1, 'no second email');
  // A dead link is never re-sent: expired (7 days + 1 minute), or cancelled.
  const b = await failedSend('buyer92');
  NOW += 7 * DAY + MIN;
  emails.sent.length = 0;
  r = await formPost(b.convId, { action: 'retry_email', linkId: b.linkId });
  eq(r.status, 409); ok(/Send a new link/.test(r.body.error), 'says to send a new link');
  eq((await server.refundThreadState(cv(b.convId))).link.email_failed, false, 'an expired link is not shown as a failed email');
  NOW = BASE_NOW;
  const c = await failedSend('buyer93');
  eq((await formDelete(c.convId)).status, 200);
  emails.sent.length = 0;
  r = await formPost(c.convId, { action: 'retry_email', linkId: c.linkId });
  eq(r.status, 409);
  eq(emails.sent.length, 0, 'nothing sent for a dead link');
  // A chat (widget) link never shows a failed email and has nothing to retry.
  const w = await withLink();
  eq((await server.refundThreadState(cv(w.convId))).link.email_failed, false);
  eq((await formPost(w.convId, { action: 'retry_email', linkId: w.link.id })).status, 409);
  eq(emails.sent.length, 0);
});

// ══ R6: open ════════════════════════════════════════════════════
t('R6 open: invalid (bad format and unknown are byte-identical), open, opened_count, at most 50 open events', async () => {
  const a = await open('short', { ip: freshIp() });
  const b = await open('A'.repeat(43), { ip: freshIp() });
  eq(a.status, 404); eq(b.status, 404); eq(a.text, b.text, 'byte-identical'); eq(a.text, '{"state":"invalid"}');
  const c = await withLink();
  const r = await open(c.token, { ip: freshIp() });
  eq(r.status, 200); eq(r.body.state, 'open');
  eq(r.body.order.order_id, c.order); eq(r.body.order.phone_last4.length, 4); eq(r.body.order.payment, 'COD');
  eq(r.body.brand.name, 'Vastora'); ok(r.body.brand.logo_url);
  ok(!/customer_mobile|payment_raw|\+91/.test(r.text), 'no full phone, no raw payment field');
  deq(Object.keys(r.body.limits).sort(), ['details_max', 'details_min'], 'no photo / video limits (no upload)');
  ok(!('files' in r.body), 'no staged files in the answer');
  eq(T.refund_links.find((l) => l.id === c.link.id).opened_count, 1);
  for (let i = 0; i < 54; i++) await open(c.token, { ip: freshIp() });
  eq(T.refund_links.find((l) => l.id === c.link.id).opened_count, 55);
  eq(events((e) => e.link_id === c.link.id && e.kind === 'link_opened').length, 50, 'at most 50 open events');
  const ev = events((e) => e.link_id === c.link.id && e.kind === 'link_opened')[0];
  ok(ev.ip_hash && ev.ip_hash.length === 24, 'ip as a 24-character hash'); eq(ev.meta.device, 'Android · Chrome');
});
t('R6 open: expired (7 days + 1 min), cancelled, closed (no key / kill switch / not installed), status view, used after 90 days', async () => {
  const c = await withLink();
  NOW += 7 * DAY + MIN;
  let r = await open(c.token, { ip: freshIp() });
  eq(r.status, 410); eq(r.body.state, 'expired');
  NOW = BASE_NOW;
  process.env.REFUND_FORMS = 'off';
  r = await open(c.token, { ip: freshIp() }); eq(r.status, 503); eq(r.body.state, 'closed');
  delete process.env.REFUND_FORMS; delete process.env.REFUND_DATA_KEY;
  r = await open(c.token, { ip: freshIp() }); eq(r.status, 503); eq(r.body.state, 'closed');
  process.env.REFUND_DATA_KEY = KEY;
  db.missingTables = true;
  r = await open(c.token, { ip: freshIp() }); eq(r.status, 503, 'before refund-forms.sql: closed'); eq(r.body.state, 'closed');
  db.missingTables = false;
  const q = await withRequest();
  r = await open(q.token, { ip: freshIp() });
  eq(r.status, 200); eq(r.body.state, 'submitted');
  eq(r.body.request.ref, q.ref); eq(r.body.request.status, 'received'); eq(r.body.request.refunded, null);
  ok(r.body.request.payout.startsWith('UPI ID ') && !r.text.includes(UPI), 'masked destination only');
  NOW += 90 * DAY + MIN;
  r = await open(q.token, { ip: freshIp() });
  eq(r.status, 200); eq(r.body.state, 'used'); ok(!('request' in r.body), 'nothing after 90 days');
});

// ══ R7: hardening ═══════════════════════════════════════════════
t('R7 origin, Sec-Fetch-Site, content type, size; no CORS; the safety headers on every answer', async () => {
  const c = await withLink();
  let r = await open(c.token, { headers: { origin: 'https://evil.example' }, ip: freshIp() });
  eq(r.status, 403); eq(r.body.state, 'forbidden');
  r = await open(c.token, { headers: { 'sec-fetch-site': 'cross-site' }, ip: freshIp() });
  eq(r.status, 403);
  r = await open(c.token, { headers: { origin: null, 'sec-fetch-site': null }, ip: freshIp() });
  eq(r.status, 200, 'no Origin and no Sec-Fetch-Site (an old browser): allowed');
  r = await call(R.open.POST, preq('/api/refund/open', { body: JSON.stringify({ token: c.token }), headers: { 'content-type': 'text/plain' }, ip: freshIp() }));
  eq(r.status, 415);
  r = await submit(c.token, fill({ details: 'x'.repeat(17 * 1024) }), { ip: freshIp() });
  eq(r.status, 413, 'a 17 KB submit'); eq(r.body.state, 'too_large');
  r = await call(R.open.POST, preq('/api/refund/open', { body: '{"token":', ip: freshIp() }));
  eq(r.status, 400, 'not JSON');
  const all = [
    await open(c.token, { ip: freshIp() }), await open('bad', { ip: freshIp() }),
    await submit(c.token, fill({ reason: 'x' }), { ip: freshIp() }), await open(c.token, { headers: { origin: 'https://evil.example' }, ip: freshIp() }),
  ];
  for (const x of all) {
    eq(x.headers.get('cache-control'), 'no-store'); eq(x.headers.get('x-robots-tag'), 'noindex, nofollow');
    eq(x.headers.get('referrer-policy'), 'no-referrer'); eq(x.headers.get('x-content-type-options'), 'nosniff');
    for (const k of x.headers.keys()) ok(!/^access-control-/i.test(k), `no CORS header (${k})`);
  }
  const admin = [await list(), await counts(), await formGet(c.convId)];
  for (const x of admin) eq(x.headers.get('cache-control'), 'no-store', 'admin answers are no-store');
});
t('R7 21 bad tokens from one IP: 429 on every refund route from that IP (other IPs unaffected)', async () => {
  const c = await withLink();
  const ip = '10.66.6.6';
  for (let i = 0; i < 20; i++) eq((await open(`bad${i}`, { ip })).status, 404);
  const r = [await open(c.token, { ip }), await submit(c.token, fill(), { ip })];
  for (const x of r) { eq(x.status, 429); eq(x.body.state, 'slow_down'); }
  eq((await open(c.token, { ip: freshIp() })).status, 200, 'another IP still works');
});

// ══ R8: no photo / video upload (owner change 2026-10-02 ~15:00) ══
// "upload yeh sab mat bana, humein sirf bank details mil jaye bahut hai": no route takes a file.
const API = path.join(SRC, 'app/api');
const routeFiles = (rel) => {
  const abs = path.join(API, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? routeFiles(path.join(rel, d.name)) : /^route\.(ts|tsx|js)$/.test(d.name) ? [path.join(rel, d.name)] : []));
};
const multipart = (boundary) => Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), jpeg(300),
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);
t('R8 no upload: the file routes are gone; every refund route exports only its JSON / GET methods (no PUT)', async () => {
  for (const rel of ['refund/files', 'refunds/files']) ok(!fs.existsSync(path.join(API, rel)), `api/${rel} is gone`);
  const pub = routeFiles('refund'), admin = routeFiles('refunds');
  deq(pub.map((f) => path.dirname(f)).sort(), ['refund/open', 'refund/submit'], 'the public routes are open and submit only');
  ok(admin.length === 4, admin.join(', '));
  const HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const methods = (rel) => HTTP.filter((m) => typeof load(path.join('app/api', rel))[m] === 'function');
  for (const rel of pub) deq(methods(rel), ['POST'], `${rel}: POST only`);
  for (const rel of admin) ok(!methods(rel).includes('PUT'), `${rel}: no PUT`);
  deq(methods('refunds/[id]/route.ts'), ['GET', 'PATCH']);
});
t('R8 no upload: open and submit refuse a file, multipart or raw-bytes body (415) and store nothing', async () => {
  const c = await withLink();
  const before = { req: T.refund_requests.length, ev: T.refund_events.length };
  const bodies = [
    ['application/octet-stream', jpeg(2000)],
    ['image/jpeg', jpeg(2000)],
    ['video/mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), nodeCrypto.randomBytes(500)])],
    ['multipart/form-data; boundary=qtestboundary', multipart('qtestboundary')],
    ['application/x-www-form-urlencoded', Buffer.from(`token=${c.token}&file=x`)],
  ];
  for (const [type, raw] of bodies) {
    for (const [name, handler, p] of [['open', R.open.POST, '/api/refund/open'], ['submit', R.submit.POST, '/api/refund/submit']]) {
      const r = await call(handler, preq(p, { raw, headers: { 'content-type': type, 'x-refund-token': c.token }, ip: freshIp() }));
      eq(r.status, 415, `${name} with ${type.split(';')[0]}`); eq(r.body.state, 'bad_request');
      for (const k of r.headers.keys()) ok(!/^access-control-/i.test(k), 'no CORS header');
    }
  }
  eq(T.refund_requests.length, before.req, 'no request stored'); eq(T.refund_events.length, before.ev, 'no event');
  eq(T.refund_links.find((l) => l.id === c.link.id).status, 'active', 'the link is untouched');
  // An old page that still sends file ids / files in the JSON: ignored, the form goes through, nothing about files is kept.
  const logFrom = db.log.length;
  const s = await submit(c.token, fill({ file_ids: [nodeCrypto.randomUUID()], files: [{ kind: 'image', data: jpeg(50).toString('base64') }] }), { ip: freshIp() });
  eq(s.status, 200, JSON.stringify(s.body));
  const q = T.refund_requests.find((x) => x.ref_code === s.body.ref);
  ok(q && !Object.keys(q).some((k) => /file|photo|video/.test(k)), 'no file column written');
  deq(events((e) => e.request_id === q.id && e.kind === 'submitted')[0].meta, { device: 'Android · Chrome', method: 'upi' }, 'no file count');
  ok(!db.log.slice(logFrom).some((x) => /refund_file/.test(x.q)), 'no file SQL');
  // The Super Admin's PATCH takes JSON only: a multipart body is refused and changes nothing.
  const m = await call(R.one.PATCH, new Request(`${ORIGIN}/api/refunds/${q.id}`, {
    method: 'PATCH', body: multipart('qtestb2'),
    headers: { authorization: `Bearer ${owner()}`, 'content-type': 'multipart/form-data; boundary=qtestb2', 'x-real-ip': '10.9.9.9' },
  }), { id: q.id });
  eq(m.status, 400, 'multipart PATCH'); eq(T.refund_requests.find((x) => x.id === q.id).status, 'new');
});

// ══ R9: submit ══════════════════════════════════════════════════
t('R9 validation: every field error at once; the attempt counts', async () => {
  const c = await withLink();
  const r = await submit(c.token, { token: c.token, client_nonce: 'x', reason: 'not_received', sub_reason: 'shows_delivered', checked_around: false,
    details: 'x'.repeat(1001), method: 'bank', holder: 'राहुल', account: '50100123', account_confirm: '50100124', ifsc: 'HDFC123', file_ids: 'x', consent: false }, { ip: freshIp() });
  eq(r.status, 400); eq(r.body.state, 'invalid_input');
  deq(r.body.errors, { client_nonce: 'bad_request', checked_around: 'checked_around_required', details: 'details_long', holder: 'holder_format',
    account: 'account_format', ifsc: 'ifsc_format', consent: 'consent_required' }, 'file_ids is not a field (no upload)');
  eq(T.refund_links.find((l) => l.id === c.link.id).status, 'active', 'nothing saved');
  for (let i = 0; i < 9; i++) await submit(c.token, fill({ reason: 'x' }), { ip: freshIp() });
  eq((await submit(c.token, fill(), { ip: freshIp() })).status, 429, 'the 11th try in an hour (validation failures count)');
});
t('R9 submit: the details text is optional (owner 2026-10-02): empty, spaces or missing is stored as an empty text', async () => {
  for (const over of [{ details: '' }, { details: '  \n ' }, { details: undefined }]) {
    const c = await withLink();
    const r = await submit(c.token, fill(over), { ip: freshIp() });
    eq(r.status, 200, JSON.stringify(r.body)); eq(r.body.state, 'submitted');
    eq(T.refund_requests.find((x) => x.ref_code === r.body.ref).details, '', 'stored as an empty text');
  }
  const c = await withLink();
  const r = await submit(c.token, fill({ details: 'x'.repeat(1001) }), { ip: freshIp() });
  eq(r.status, 400); eq(r.body.errors.details, 'details_long');
  eq(T.refund_links.find((l) => l.id === c.link.id).status, 'active', 'nothing saved');
});
t('R9 submit: order fields from the client are ignored; payout sealed with its own AAD; mask, holder check, link', async () => {
  const c = await withLink();
  const ip = freshIp();
  const logFrom = db.log.length;
  const r = await submit(c.token, fill({ order_id: '#HACKED', name: 'Someone Else', phone: '9999999999', status: 'refunded' }), { ip });
  eq(r.status, 200); eq(r.body.state, 'submitted'); ok(/^RF-[0-9A-HJKMNP-TV-Z]{6}$/.test(r.body.ref));
  const q = T.refund_requests.find((x) => x.ref_code === r.body.ref);
  eq(q.order_id, c.order, 'the order comes from the link'); eq(q.status, 'new');
  eq(q.order_snapshot.order_id, c.order); eq(q.order_snapshot.customer_name, c.link.order_snapshot.customer_name);
  ok(!JSON.stringify(q).includes('HACKED') && !JSON.stringify(q).includes('Someone Else'));
  eq(q.payout_method, 'upi'); eq(q.payout_mask, 'qt•••77@okaxis'); eq(q.holder_matches, true, 'MEERA is in the order name');
  ok(q.phone_fp && q.phone_fp.length === 32, 'phone fingerprint, never the phone');
  deq(rcrypto.openJson(q.payout_enc, rcrypto.payoutAad(q.id)), { v: 1, method: 'upi', upi: UPI, holder: HOLDER }, 'opens with its own AAD');
  assert.throws(() => rcrypto.openJson(q.payout_enc, rcrypto.payoutAad(nodeCrypto.randomUUID())), /auth_failed/, 'another request id cannot open it');
  const l = T.refund_links.find((x) => x.id === c.link.id);
  eq(l.status, 'submitted'); ok(l.submitted_at);
  eq(q.consent_version, 'v1-2026-10-02'); eq(q.submit_device, 'Android · Chrome'); eq(q.submit_ip_hash.length, 24);
  // No SQL parameter of any statement carries the payout in clear.
  const sent = JSON.stringify(db.log.slice(logFrom).map((x) => x.params.map((p) => (Buffer.isBuffer(p) ? p.toString('latin1') : p))));
  for (const [what, v] of [['UPI', UPI], ['holder', HOLDER], ['holder word', 'QTESTHOLDER']]) ok(!sent.toLowerCase().includes(v.toLowerCase()), `${what} in clear in an SQL parameter`);
  const ev = events((e) => e.request_id === q.id && e.kind === 'submitted')[0];
  deq(ev.meta, { device: 'Android · Chrome', method: 'upi' });
  // A bank account: same checks.
  const b = await withLink();
  const logB = db.log.length;
  const rb = await submit(b.token, fill({ method: 'bank', upi: null, account: ACCOUNT.replace(/(\d{4})/g, '$1 '), account_confirm: ACCOUNT, ifsc: 'hdfcOqt4321' }), { ip: freshIp() });
  eq(rb.status, 200, JSON.stringify(rb.body));
  const qb = T.refund_requests.find((x) => x.ref_code === rb.body.ref);
  eq(qb.payout_mask, `HDFC ••••${ACCOUNT.slice(-4)}`);
  deq(rcrypto.openJson(qb.payout_enc, rcrypto.payoutAad(qb.id)), { v: 1, method: 'bank', account: ACCOUNT, ifsc: IFSC, holder: HOLDER });
  const sentB = JSON.stringify(db.log.slice(logB).map((x) => x.params));
  for (const [what, v] of [['account', ACCOUNT], ['IFSC', IFSC], ['holder', HOLDER]]) ok(!sentB.includes(v), `${what} in clear in an SQL parameter`);
});
t('R9 two submits at once: one 200, one 409 used; a retry with the same nonce gets the same answer', async () => {
  const c = await withLink();
  const [a, b] = await Promise.all([submit(c.token, fill(), { ip: freshIp() }), submit(c.token, fill(), { ip: freshIp() })]);
  deq([a.status, b.status].sort(), [200, 409]);
  eq((a.status === 409 ? a : b).body.state, 'used');
  eq(T.refund_requests.filter((x) => x.link_id === c.link.id).length, 1, 'one request');
  const d = await withLink();
  const once = fill();
  const r1 = await submit(d.token, once, { ip: freshIp() });
  const r2 = await submit(d.token, once, { ip: freshIp() });
  eq(r2.status, 200, 'a retried submit'); eq(r2.body.ref, r1.body.ref, 'the same ref');
  eq(sysMsgs(d.convId).filter((m) => m.metadata.step === 'received').length, 1, 'one "form received" message');
  // Expired, replaced: no request.
  const x = await withLink();
  NOW += 7 * DAY + MIN;
  const ex = await submit(x.token, fill(), { ip: freshIp() });
  eq(ex.status, 410); eq(ex.body.state, 'expired');
  eq(T.refund_requests.filter((q) => q.link_id === x.link.id).length, 0);
});

// ══ R10: "form received" ════════════════════════════════════════
t('R10 the "form received" message: to the merged-into chat, reopens a Closed chat, unread + 1, no destination (Q3)', async () => {
  const c = await withLink({ hinglish: true });
  const target = mkConv(c.order, { status: 'resolved', case_kind: 'refund', unread_count: 0 });
  T.conversations.find((x) => x.id === c.convId).merged_into = target;
  const s = await submit(c.token, fill({ method: 'upi' }), { ip: freshIp() });
  eq(s.status, 200);
  eq(sysMsgs(c.convId).filter((m) => m.metadata.step === 'received').length, 0, 'not in the merged shell');
  const ack = sysMsgs(target).find((m) => m.metadata.step === 'received');
  ok(ack, 'in the chat it was merged into');
  eq(ack.content, 'Aapka refund form mil gaya hai. Team check karke isi chat me update degi.', 'the owner\'s words, in the link\'s language');
  ok(!ack.content.includes('qt•••') && !/aapka nahi|not yours|ending|\d{4}/i.test(ack.content), 'no destination in the message (Q3)');
  const tc = T.conversations.find((x) => x.id === target);
  eq(tc.status, 'agent_handling', 'a Closed marked chat reopens to the team'); eq(tc.unread_count, 1);
  const ce = T.chat_events.filter((e) => e.conversation_id === target && e.kind === 'status').pop();
  eq(ce.actor, 'customer'); eq(ce.reason, 'reopen');
  const req = T.refund_requests.find((x) => x.ref_code === s.body.ref);
  eq(req.ack_message_id, ack.id);
  // An unmarked Closed chat goes to Needs you.
  const d = await withLink();
  T.conversations.find((x) => x.id === d.convId).status = 'resolved';
  T.conversations.find((x) => x.id === d.convId).case_kind = null;
  eq((await submit(d.token, fill(), { ip: freshIp() })).status, 200);
  eq(T.conversations.find((x) => x.id === d.convId).status, 'human_needed');
});
t('R10 a chat busy for both tries: the request stays, message_failed, the red flag, Post now posts once', async () => {
  const c = await withLink();
  const chat = T.conversations.find((x) => x.id === c.convId);
  const release = await holdRow('conversations', chat);
  const s = await submit(c.token, fill(), { ip: freshIp() });
  release();
  eq(s.status, 200, 'the submit still succeeds');
  const req = T.refund_requests.find((x) => x.ref_code === s.body.ref);
  ok(req, 'request saved'); eq(req.ack_message_id, null);
  eq(sysMsgs(c.convId).filter((m) => m.metadata.step === 'received').length, 0);
  eq(events((e) => e.request_id === req.id && e.kind === 'message_failed' && e.meta?.step === 'received').length, 1);
  NOW += 3 * MIN;
  const d = await detail(req.id);
  ok(d.body.flags.some((f) => f.code === 'ack_failed' && f.level === 'red'), 'ack_failed flag');
  ok(d.body.allowed.includes('post_ack'));
  ok((await list()).body.items.find((x) => x.id === req.id).flags.includes('ack_failed'), 'in the list too');
  const p = await patch(req.id, { action: 'post_ack' });
  eq(p.status, 200); eq(p.body.message.step, 'received');
  eq(sysMsgs(c.convId).filter((m) => m.metadata.step === 'received').length, 1);
  const p2 = await patch(req.id, { action: 'post_ack' });
  eq(p2.status, 409, 'a second Post now'); eq(sysMsgs(c.convId).filter((m) => m.metadata.step === 'received').length, 1, 'posts nothing');
});
t('R10 a chat busy on the first try only: the second try posts it (the retry path)', async () => {
  const c = await withLink();
  db.fails.push({ re: /^SELECT c\.id, c\.site_id, c\.status, c\.source, c\.case_kind, c\.merged_into FROM conversations c WHERE c\.id = \$1 FOR NO KEY UPDATE$/, times: 1, code: '55P03', message: 'canceling statement due to lock timeout' });
  const s = await submit(c.token, fill(), { ip: freshIp() });
  eq(s.status, 200);
  const req = T.refund_requests.find((x) => x.ref_code === s.body.ref);
  ok(req.ack_message_id, 'posted on the second try');
  eq(events((e) => e.request_id === req.id && e.kind === 'message_failed').length, 0);
});

// ══ R11: status moves ═══════════════════════════════════════════
t('R11 approve twice: 200 then 409, one message; the rejected message never carries the note; reject reopens a Closed chat', async () => {
  const q = await withRequest();
  const a = await patch(q.id, { action: 'approve', expect: 'new' });
  eq(a.status, 200); eq(a.body.request.status, 'approved'); eq(a.body.message.step, 'approved');
  const a2 = await patch(q.id, { action: 'approve', expect: 'new' });
  eq(a2.status, 409); ok(/Already Approved/.test(a2.body.error)); eq(a2.body.status, 'approved');
  eq(sysMsgs(q.convId).filter((m) => m.metadata.step === 'approved').length, 1, 'one approved message');
  const NOTE = 'Photo shows a used product, QTESTNOTE';
  T.conversations.find((x) => x.id === q.convId).status = 'resolved';
  const rj = await patch(q.id, { action: 'reject', expect: 'approved', note: NOTE });
  eq(rj.status, 200);
  const rm = sysMsgs(q.convId).find((m) => m.metadata.step === 'rejected');
  ok(rm && !rm.content.includes('QTESTNOTE'), 'the note is never sent');
  eq(events((e) => e.request_id === q.id && e.kind === 'status' && e.to_status === 'rejected')[0].note, NOTE, 'the note stays internal');
  const c = T.conversations.find((x) => x.id === q.convId);
  eq(c.status, 'agent_handling', 'reject reopens the Closed chat (Q14)');
  const ce = T.chat_events.filter((e) => e.conversation_id === q.convId && e.kind === 'status').pop();
  eq(ce.actor, 'owner'); eq(ce.reason, 'refund_rejected');
  eq((await patch(q.id, { action: 'approve', expect: 'rejected' })).status, 200, 'rejected -> approved');
});
t('R11 the move table, the CAS and the trigger; illegal moves are 409; cancel and return post nothing; tell_return once', async () => {
  const q = await withRequest();
  eq((await patch(q.id, { action: 'refunded', expect: 'new', utr: 'ABCD12345678', amount: '1299', refund_date: '2026-10-05' })).status, 409, 'new -> refunded');
  const stale = await patch(q.id, { action: 'approve', expect: 'rejected' });
  eq(stale.status, 409, 'a stale screen (CAS)'); ok(/Already New/.test(stale.body.error));
  eq(T.refund_requests.find((x) => x.id === q.id).status, 'new');
  db.fails.push({ re: /^UPDATE refund_requests SET status = \$3/, times: 1, code: '23514', message: `refund request ${q.id}: new -> approved is not allowed` });
  eq((await patch(q.id, { action: 'approve', expect: 'new' })).status, 409, 'the trigger refusing is a 409');
  eq((await patch(q.id, { action: 'reject', expect: 'new' })).status, 400, 'reject without a note');
  eq((await patch(q.id, { action: 'cancel', expect: 'new' })).status, 400, 'cancel without a note');
  eq((await patch(q.id, { action: 'fly' })).status, 400);
  const msgs = T.messages.length;
  const rt = await patch(q.id, { action: 'return', needed: true, note: 'pickup from home' });
  eq(rt.status, 200); eq(rt.body.request.return_needed, true); eq(T.messages.length, msgs, 'return posts nothing');
  const tr = await patch(q.id, { action: 'tell_return' });
  eq(tr.status, 200); eq(tr.body.message.step, 'return');
  eq((await patch(q.id, { action: 'tell_return' })).status, 409, 'told once');
  eq(sysMsgs(q.convId).filter((m) => m.metadata.step === 'return').length, 1);
  const before = T.messages.length;
  const cn = await patch(q.id, { action: 'cancel', expect: 'new', note: 'test request' });
  eq(cn.status, 200); eq(cn.body.message, null); eq(T.messages.length, before, 'cancel posts nothing');
  eq((await patch(q.id, { action: 'approve', expect: 'cancelled' })).status, 409, 'cancelled is final');
  eq((await patch(q.id, { action: 'return', needed: false })).status, 409, 'no return on a cancelled request');
});
t('R11 Mark refunded: UTR, amount, date, prepaid tick; the message has amount, date, where and UTR, never the number (Q2 / Q3)', async () => {
  const q = await withRequest();
  eq((await patch(q.id, { action: 'approve', expect: 'new' })).status, 200);
  const base = { action: 'refunded', expect: 'approved', utr: '4278 1234 5678', amount: '1299', refund_date: '2026-10-05' };
  let r = await patch(q.id, { ...base, utr: '' });
  eq(r.status, 400); eq(r.body.errors.utr, 'utr_format');
  r = await patch(q.id, { ...base, amount: '1300' });
  eq(r.status, 400); eq(r.body.errors.amount, 'amount_over_total');
  r = await patch(q.id, { ...base, refund_date: '2026-09-01' });
  eq(r.status, 400); eq(r.body.errors.refund_date, 'date_range', 'before the submit day');
  r = await patch(q.id, { ...base, refund_date: '2026-10-06' });
  eq(r.body.errors.refund_date, 'date_range', 'in the future');
  r = await patch(q.id, base);
  eq(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  eq(r.body.request.utr, '427812345678'); eq(r.body.request.refund_amount, 1299); eq(r.body.request.refund_date, '2026-10-05');
  const m = sysMsgs(q.convId).find((x) => x.metadata.step === 'refunded');
  ok(m.content.includes('427812345678') && m.content.includes('₹1,299') && m.content.includes('5 Oct 2026'), 'UTR, amount, date');
  ok(m.content.includes('the UPI ID you gave'), 'where it went, in words');
  ok(!m.content.includes('qt•••') && !m.content.includes('@okaxis'), 'never the UPI ID, not even masked');
  eq((await patch(q.id, { action: 'reject', expect: 'refunded', note: 'x' })).status, 409, 'refunded is final');
  // The same UTR on another request: 409 naming the other ref.
  const q2 = await withRequest();
  await patch(q2.id, { action: 'approve', expect: 'new' });
  r = await patch(q2.id, { ...base });
  eq(r.status, 409); ok(r.body.error.includes(q.ref), 'names the other request');
  eq(T.refund_requests.find((x) => x.id === q2.id).status, 'approved', 'nothing changed');
  // Prepaid: the gateway tick is required.
  const p = await withRequest({ order: { payment_method: 'razorpay', financial_status: 'paid', order_total: '899.00' } });
  await patch(p.id, { action: 'approve', expect: 'new' });
  r = await patch(p.id, { action: 'refunded', expect: 'approved', utr: 'PAYOUT99887766', amount: '899', refund_date: '2026-10-05' });
  eq(r.status, 400); eq(r.body.errors.gateway_checked, 'gateway_tick');
  r = await patch(p.id, { action: 'refunded', expect: 'approved', utr: 'PAYOUT99887766', amount: '899', refund_date: '2026-10-05', gateway_checked: true });
  eq(r.status, 200); eq(r.body.request.gateway_checked, true);
  ok(r.body.warnings.includes('utr_not_upi'), 'soft warning for a non-RRN UTR on UPI');
});

// ══ R12: reveal ═════════════════════════════════════════════════
t('R12 reveal: recorded before it is shown, no-store, 30 an hour, key missing 503', async () => {
  const q = await withRequest();
  const r = await reveal(q.id);
  eq(r.status, 200); deq(r.body.payout, { method: 'upi', upi: UPI, holder: HOLDER });
  eq(r.headers.get('cache-control'), 'no-store');
  const ev = events((e) => e.request_id === q.id && e.kind === 'revealed');
  eq(ev.length, 1); ok(ev[0].ip_hash); eq(ev[0].meta.device, 'Android · Chrome');
  ok(!JSON.stringify(ev).includes(UPI), 'the event carries no payout');
  db.fails.push({ re: /^INSERT INTO refund_events/, times: 1, code: '53100', message: 'could not extend file' });
  const nr = await reveal(q.id);
  eq(nr.status, 500, 'no record, no details'); ok(!nr.text.includes(UPI));
  delete process.env.REFUND_DATA_KEY;
  eq((await reveal(q.id)).status, 503);
  process.env.REFUND_DATA_KEY = KEY;
  limits.resetRefundLimits();
  for (let i = 0; i < 30; i++) eq((await reveal(q.id)).status, 200);
  eq((await reveal(q.id)).status, 429, 'the 31st in an hour');
  NOW += HOUR + MIN;
  eq((await reveal(q.id)).status, 200, 'an hour later');
  // A rotated key without the old one: cannot be read, logged with the id and code only.
  limits.resetRefundLimits();
  process.env.REFUND_DATA_KEY = nodeCrypto.randomBytes(32).toString('base64');
  const lost = await reveal(q.id);
  eq(lost.status, 500); ok(/cannot be read/.test(lost.body.error));
  ok(logs.some((l) => l.includes(`[refund] decrypt failed ${q.id} unknown_key`)));
  process.env.REFUND_DATA_KEY = KEY;
});

// ══ R18: list, counts, sent links, detail ═══════════════════════
t('R18 list, counts, sent links and the detail drawer (masked; seen; viewed once per 10 min)', async () => {
  const q = await withRequest({ order: { customer_name: 'Ravi Kumar' } });
  const c = await counts();
  ok(c.body.unseen >= 1 && c.body.new >= 1);
  // ?byPanel=1 (the panel board, owner 2026-10-09): new requests per panel, Super Admin only
  const bp = await call(R.counts.GET, areq('/api/refunds/counts?byPanel=1', owner()));
  eq(bp.status, 200); ok(Object.values(bp.body.by_panel).some((n) => n >= 1), 'this panel has a new request');
  eq((await call(R.counts.GET, areq('/api/refunds/counts?byPanel=1', member('neha')))).status, 403);
  const l = await list('?view=new');
  eq(l.status, 200);
  const row = l.body.items.find((x) => x.id === q.id);
  ok(row, 'listed'); eq(row.ref, q.ref); eq(row.seen, false); eq(row.payment, 'COD'); eq(row.total, 1299);
  deq(row.payout, { method: 'upi', mask: 'qt•••77@okaxis' });
  ok(row.flags.includes('name_differs'), 'MEERA vs Ravi Kumar');
  ok(!l.text.includes(UPI) && !l.text.includes('payout_enc') && !l.text.includes('v1.'), 'no payout in clear or sealed');
  ok(!('photos' in row) && !('videos' in row), 'no photo / video counts (no upload)');
  eq((await list('?view=bogus')).status, 400);
  const sent = await withLink();
  const s = await list('?view=sent');
  ok(s.body.links.some((x) => x.id === sent.link.id && x.state === 'active'), 'form sent, not filled');
  ok(!s.text.includes(sent.token), 'no token in the list');
  const d = await detail(q.id);
  eq(d.status, 200);
  eq(d.body.request.payout.mask, 'qt•••77@okaxis'); ok(!d.text.includes(UPI) && !d.text.includes('payout_enc'), 'masked');
  eq(d.body.request.details, DETAILS); eq(d.body.chat.live_id, q.convId); eq(d.body.chat.open_url, `/admin/chat?open=${q.convId}`);
  deq(d.body.allowed.slice(0, 3), ['approve', 'reject', 'cancel']);
  ok(!('files' in d.body), 'no files in the drawer (no upload)');
  ok(d.body.messages.some((m) => m.step === 'form') && d.body.messages.some((m) => m.step === 'received'));
  ok(d.body.previews.refunded.en.includes('{utr}'), 'refunded preview with placeholders');
  ok(T.refund_requests.find((x) => x.id === q.id).seen_at, 'seen');
  await detail(q.id);
  eq(events((e) => e.request_id === q.id && e.kind === 'viewed').length, 1, 'viewed once per 10 min');
  eq((await detail(nodeCrypto.randomUUID())).status, 404);
  eq((await detail('not-a-uuid')).status, 404);
  db.missingTables = true;
  const m = await counts();
  eq(m.status, 503); eq(m.body.error, 'Refund forms are not installed yet');
  db.missingTables = false;
});

// ══ R14 / R15 / R16: slice D's shared routes ════════════════════
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(SRC, rel));
const THREAD = 'app/api/chat/conversations/[id]/route.ts';
const sliceD = exists(THREAD) && /refundThreadState/.test(read(THREAD));
t('R14 refundThreadState: block, link and request for the chip; no table yet = setup', async () => {
  const c = await withLink();
  const conv = T.conversations.find((x) => x.id === c.convId);
  const st = await server.refundThreadState({ ...conv, tracker_business_id: BIZ });
  eq(st.can_send, true); eq(st.link.id, c.link.id); eq(st.link.state, 'active'); eq(st.request, null);
  ok(!JSON.stringify(st).includes(c.token) && !JSON.stringify(st).includes(sha(c.token)), 'no token, no hash');
  const q = await withRequest();
  const st2 = await server.refundThreadState({ ...T.conversations.find((x) => x.id === q.convId), tracker_business_id: BIZ });
  eq(st2.block, 'request_open'); eq(st2.request.ref, q.ref);
  db.missingTables = true;
  db.fails.push({ re: /FROM refund_links WHERE business_id = \$1 AND order_id = \$2 AND status = 'active' LIMIT 1$/, times: 1, code: '42P01', message: 'relation "refund_links" does not exist' });
  const st3 = await server.refundThreadState({ ...conv, tracker_business_id: BIZ });
  db.missingTables = false;
  eq(st3.block, 'setup'); eq(st3.can_send, false);
});
t('R14 the thread route (slice D): refund_form only for the Super Admin in a Refund chat; messages and earlier chats masked', async () => {
  if (!sliceD) { out('SKIP R14 thread route: slice D has not landed yet (no refundThreadState in the thread route)'); return; }
  const src = read(THREAD);
  ok(/isSuperAdmin\(user\) && conversation\.case_kind === 'refund' \? \{ refund_form: await refundThreadState\(conversation\)/.test(src), 'the Super Admin + Refund gate on refund_form');
  ok(/messages\.rows\.map\(\(m\) => unlink\(/.test(src), 'thread messages masked');
  ok(/c\.messages\.map\(\(m\) => unlink\(/.test(src), 'earlier chats masked');
  ok(/maskRefundLinks/.test(src));
  const list = read('app/api/chat/conversations/route.ts');
  ok(/regexp_replace\(m\.content, '\$\{REFUND_LINK_SQL\}', '\[refund form link\]', 'gi'\)/.test(list), 'list last_message masked in SQL (any case: gi)');
  ok(/const unlink = .*\/refund\/i\.test\(m\.content \?\? ''\)/.test(src), 'the thread masks any text naming refund (a %2Frefund%23 copy too)');
  ok(/maskRefundLinks/.test(read('app/api/chat/messages/[id]/route.ts')), 'message details masked');
});
t('R15 refundMarkLocked: an open link or a New / Approved request locks the mark; expired, rejected or no data do not; 42P01 = not locked', async () => {
  const run = async (chat) => global.__refundFakeDb.withTransaction(async (client) => {
    await client.query("SET LOCAL lock_timeout = '5s'");
    return server.refundMarkLocked(client, chat);
  });
  const c = await withLink();
  eq(await run({ id: c.convId, site_id: SITE1, case_order_id: c.order }), true, 'an open link');
  eq(await run({ id: mkConv(c.order), site_id: SITE1, case_order_id: c.order }), true, 'the same order in another chat');
  NOW += 7 * DAY + MIN;
  eq(await run({ id: c.convId, site_id: SITE1, case_order_id: c.order }), false, 'an expired link');
  NOW = BASE_NOW;
  const q = await withRequest();
  eq(await run({ id: q.convId, site_id: SITE1, case_order_id: q.order }), true, 'a New request');
  await patch(q.id, { action: 'approve', expect: 'new' });
  eq(await run({ id: q.convId, site_id: SITE1, case_order_id: q.order }), true, 'an Approved request');
  await patch(q.id, { action: 'reject', expect: 'approved', note: 'no' });
  eq(await run({ id: q.convId, site_id: SITE1, case_order_id: q.order }), false, 'a Rejected request');
  eq(await run({ id: mkConv(mkOrder()), site_id: SITE1, case_order_id: null }), false, 'nothing');
  db.missingTables = true;
  eq(await run({ id: c.convId, site_id: SITE1, case_order_id: c.order }), false, 'before refund-forms.sql');
  db.missingTables = false;
  if (!sliceD) { out('SKIP R15 setCase gate: slice D has not landed yet'); return; }
  const src = read(THREAD);
  ok(/chat\.case_kind === 'refund' && kind !== 'refund' && !isSuperAdmin\(user\) && await refundMarkLocked\(client, chat\)/.test(src), 'setCase calls the gate for staff only');
  ok(/Only the Super Admin can change or remove the Refund mark now/.test(src));
});
t('R16 a staff reply or edit with a Google Form or refund-form link is 403, for every login (slice D)', async () => {
  const MSG = 'app/api/chat/messages/route.ts', EDIT = 'app/api/chat/messages/[id]/route.ts';
  if (!(/hasFormLink/.test(read(MSG)) && /hasFormLink/.test(read(EDIT)))) { out('SKIP R16: slice D has not landed yet (no hasFormLink in the message routes)'); return; }
  const post = load(MSG).POST, edit = load(EDIT).PATCH;
  const convId = mkConv(mkOrder());
  T.messages.push({ id: 'm-r16', conversation_id: convId, sender: 'ai', content: 'Your order is on its way.', metadata: null, created_at: new Date(NOW - MIN), deleted_at: null, edited_at: null, edited_by: null, deleted_by: null });
  const before = JSON.stringify(T.messages.find((m) => m.id === 'm-r16'));
  const bad = ['Please fill https://docs.google.com/forms/d/e/1FAIpQLSc-x/viewform', 'Fill this: https://forms.gle/AbCdEf12', `https://shiptrack.store/refund#${'Z'.repeat(43)}`];
  for (const tok of [owner(), member('neha'), member('rahul'), member('anurag')]) {
    for (const text of bad) {
      const msgs = T.messages.length;
      const r = await call(post, areq('/api/chat/messages', tok, { method: 'POST', body: { conversationId: convId, content: text } }));
      eq(r.status, 403, 'reply'); ok(/Refund forms go only through/.test(r.body.error));
      eq(T.messages.length, msgs, 'nothing sent');
      const e = await call(edit, areq('/api/chat/messages/m-r16', tok, { method: 'PATCH', body: { content: text } }), { id: 'm-r16' });
      eq(e.status, 403, 'edit'); ok(/Refund forms go only through/.test(e.body.error));
      eq(JSON.stringify(T.messages.find((m) => m.id === 'm-r16')), before, 'the message is unchanged');
    }
  }
});

t('R8 across every test: no statement ever touched refund_files / refund_file_parts (no upload)', async () => {
  const hits = db.log.filter((x) => /refund_file/.test(x.q));
  deq(hits.map((x) => x.q.slice(0, 60)), [], 'file SQL');
  ok(db.log.length > 500, `${db.log.length} statements checked`);
});

// ══ R13: logs ═══════════════════════════════════════════════════
t('R13 a failing submit logs codes only (a pg error that quotes the row is never printed)', async () => {
  const c = await withLink();
  const SECRET_DETAILS = 'QTESTDETAILS packet phata hua tha aur kurta bhi.';
  SECRETS.details.add(SECRET_DETAILS);
  db.fails.push({ re: /^INSERT INTO refund_requests/, times: 1, make: (p) => checkErr('refund_requests', 'refund_requests_details_check', Object.fromEntries(p.map((v, i) => [`c${i}`, v]))) });
  const from = logs.length;
  const r = await submit(c.token, fill({ details: SECRET_DETAILS }), { ip: freshIp() });
  eq(r.status, 500); eq(r.body.state, 'error');
  const lines = logs.slice(from).join('\n');
  ok(/\[refund\] submit failed: 23514/.test(lines), 'one line with the code');
  ok(!lines.includes('QTESTDETAILS') && !lines.includes('Failing row'), 'never the row');
  eq(T.refund_requests.filter((x) => x.link_id === c.link.id).length, 0, 'nothing saved');
  eq(T.refund_links.find((x) => x.id === c.link.id).status, 'active', 'the link stays open for a retry');
});
t('R13 across every test: no token, hash, UPI, account, IFSC, holder, details, customer name or phone in any log line', async () => {
  const all = logs.join('\n');
  const hits = [];
  for (const tok of SECRETS.tokens) { if (all.includes(tok)) hits.push('a link token'); if (all.includes(sha(tok))) hits.push('a token hash'); }
  for (const [what, v] of [['UPI', UPI], ['account', ACCOUNT], ['IFSC', IFSC], ['holder', HOLDER], ['holder word', 'QTESTHOLDER']]) if (all.toLowerCase().includes(v.toLowerCase())) hits.push(what);
  for (const d of SECRETS.details) if (all.includes(d)) hits.push('customer text');
  for (const n of SECRETS.names) if (all.includes(n)) hits.push('a customer name');
  for (const p of SECRETS.phones) if (all.includes(p) || all.includes(p.slice(-10))) hits.push('a phone');
  if (/\/refund#/.test(all)) hits.push('a refund link');
  deq([...new Set(hits)], [], 'log lines with customer data');
  ok(logs.some((l) => /\[refund\] form sent conv conv-\d+ link [0-9a-f-]{36}$/.test(l)), 'the send line: ids only');
  ok(logs.some((l) => /^\[refund\] RF-[0-9A-HJKMNP-TV-Z]{6} submitted \((upi|bank)\)$/.test(l)), 'the submit line: ref and method only');
});

// ══ Run ═════════════════════════════════════════════════════════
(async () => {
  for (const [name, fn] of tests) {
    reset();
    const v = db.violations.length;
    try {
      await fn();
      if (db.violations.length > v) throw new Error(`fake db: ${db.violations.slice(v).join(' | ')}`);
      passed++;
    } catch (e) {
      failed.push(name.split(' ')[0]);
      out(`FAIL ${name}: ${clean(String(e && e.message).split('\n')[0]).slice(0, 300)}`);
    }
  }
  for (const k of Object.keys(realConsole)) console[k] = realConsole[k];
  if (failed.length) {
    out(`REFUND ROUTE: ${failed.length} failed, ${passed} passed`);
    process.exit(1);
  }
  out(`REFUND ROUTE: all ${passed} groups passed (R1-R18${sliceD ? '' : '; R14-R16 slice D parts skipped until it lands'})`);
  process.exit(0);
})().catch((e) => { out(`FAIL R0 harness: ${clean(String(e && e.message)).slice(0, 300)}`); process.exit(1); });
