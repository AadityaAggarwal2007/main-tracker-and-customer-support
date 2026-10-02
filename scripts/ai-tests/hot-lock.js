// Hot chats (owner, 2026-10-02): on a HOT chat only the Super Admin may Close it or Hand it to the AI.
// A 77% Critical chat whose customer had threatened a consumer complaint was closed and handed to the AI
// by staff within seconds; the owner chose "Close + Hand to AI band" for staff on angry / threat chats
// (only the Super Admin may) and "Kuch nahi" for blocking staff wording.
//
// HOT (src/lib/chat/team-rules.ts hotChat) = a KNOWN customer's threat or fraud claim that no team member
// has answered since (the `urgent` marker on the message, escalation.ts), a KNOWN customer the scorer's
// model rates HEALTH_PIN_MIN+ (health_signals.llm; a score saved before that key: health_score), or
// Chikki's own Refund mark (case_kind 'refund', marked by "Chikki (auto)"). Review fix 2026-10-02: never
// health-rules.ts's word counts (health_signals threat / accuse) nor the 85 floor they put on the score
// ("fir kab aayega", "tracking id fake hai", an address near a court). Take over, Take from X, Transfer,
// replies and the Refund / Ship again marks are not gated; system code (auto-close, merges, Chikki) never
// goes through this route.
//
//   H1  the pure rules and their texts; the values agree with health-rules.ts, tracking-claim.ts and the
//       list route's tabs
//   H2  PATCH: a member's Close / Hand to AI on a hot chat is 403 for each condition, nothing saved
//   H3  PATCH: the Super Admin may; members may on a chat that is not hot
//   H4  PATCH: Take over, Transfer and a Refund mark on a hot chat stay open to members
//   H5  GET: hot_lock { can_close, can_hand_to_ai, lock_reason } for each login; staff block unchanged
//   H6  a Refund mark made between the read and the lock: 409 "try again", nothing saved; the retry is 403
//   H7  the inbox draws hot_lock (buttons off, the reason line on every screen size, the Super Admin line)
//   H8  review fixes: the urgent marker locks at once (no score yet); answered = not hot; word counts and
//       the floor they cause never lock; the model's own number decides At risk
//
// The REAL thread route (src/app/api/chat/conversations/[id]/route.ts) runs against a small fake
// database in the pattern of team-routing.js: row locks need SET LOCAL lock_timeout first, a pool query
// inside a locked action fails the test, ROLLBACK undoes every write, and any statement the routes are
// not known to send fails the test.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { AsyncLocalStorage } = require('async_hooks');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hot-lock-')));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

process.env.AUTH_TOKEN_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.ADMIN_USERNAME = 'Owner';
process.env.ADMIN_PASSWORD = 'env-pass-123';

// ── Fake modules ───────────────────────────────────────────────
fs.writeFileSync(path.join(dir, 'next-server.js'), `
class NextResponse {
  constructor(body, init = {}) { this.status = init.status || 200; this.body = body; this.headers = init.headers || {}; }
  static json(body, init = {}) { return new NextResponse(body, init); }
}
class NextRequest {}
module.exports = { NextResponse, NextRequest };`);
fs.writeFileSync(path.join(dir, 'db.js'), `
const f = () => global.__fakeDb;
module.exports = {
  query: (sql, p) => f().run(sql, p, null),
  queryOne: async (sql, p) => (await f().run(sql, p, null)).rows[0] ?? null,
  withTransaction: (fn) => f().withTransaction(fn),
};`);
const stub = (name, body) => fs.writeFileSync(path.join(dir, name + '.js'), body);
stub('order-facts', 'module.exports = { loadOrderFacts: async () => null };');
stub('order-address-db', 'module.exports = { loadOrderAddress: async () => null };');
stub('refund-server', 'module.exports = { refundThreadState: async () => ({ can_send: true, block: null, block_text: null, link: null, request: null }), refundMarkLocked: async () => false };');

const compile = (from, to) => {
  const src = fs.readFileSync(path.join(SRC, from), 'utf8')
    .replace(/from '@\/lib\/chat\/([\w-]+)'/g, "from './$1'")
    .replace(/from '@\/lib\/refund\/([\w-]+)'/g, "from './refund-$1'")
    .replace(/from '@\/lib\/([\w-]+)'/g, "from './$1'")
    .replace(/from 'next\/server'/g, "from './next-server'");
  fs.writeFileSync(path.join(dir, to + '.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true } }).outputText);
};
for (const f of ['permissions', 'auth', 'office-hours']) compile(`lib/${f}.ts`, f);
compile('lib/refund/link-mask.ts', 'refund-link-mask');
for (const f of ['team-rules', 'waiting', 'waiting-sql', 'team-routing', 'display-name', 'health-rules']) compile(`lib/chat/${f}.ts`, f);
compile('app/api/chat/conversations/[id]/route.ts', 'r-thread');
const wsql = require(path.join(dir, 'waiting-sql.js'));

// ── The fake database ──────────────────────────────────────────
const RAHUL = '11111111-1111-4111-8111-111111111111';   // senior (chat.senior)
const ANURAG = '22222222-2222-4222-8222-222222222222';  // junior
const NEHA = '33333333-3333-4333-8333-333333333333';    // panel "Admin" (a team role, not the Super Admin)
const VIEWER = '55555555-5555-4555-8555-555555555555';  // reads chats, cannot reply
const CHAT_PERMS = ['orders.view', 'chat.view', 'chat.reply', 'chat.cases', 'chat.edit'];
const member = (id, username, name, role, perms) => ({ id, username, display_name: name, role, is_active: true, business_ids: null, permissions: perms, session_version: 7 });
const TEAM = [
  member(RAHUL, 'rahul', 'Rahul', 'manager', [...CHAT_PERMS, 'orders.update', 'chat.senior']),
  member(ANURAG, 'anurag', 'Anurag', 'agent', [...CHAT_PERMS]),
  member(NEHA, 'neha', 'Neha', 'panel_admin', [...CHAT_PERMS, 'orders.update', 'chikki.edit', 'settings.panel']),
  member(VIEWER, 'viewer', 'Vikas', 'viewer', ['chat.view']),
];

const SCALE = 0.01;   // lock_timeout '5s' = 50 ms here
const db = { convs: [], messages: [], events: [], caseEvents: [], presence: [], stmts: [], afterRead: null };
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const rows = (r) => ({ rows: r, rowCount: r.length });
const conv = (id) => db.convs.find((c) => c.id === id);
const SITES = { S1: { name: 'Vastora', panel: 'P1' } };
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] === undefined ? null : clone(o[k])]));
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const nowIso = () => new Date(Date.now()).toISOString();
const pgErr = (code, message) => Object.assign(new Error(message), { code });
let seq = 0;

const lockOwner = new Map();
async function lockRow(tx, id) {
  const until = Date.now() + (tx.lockTimeoutMs ?? 1500);
  for (;;) {
    const owner = lockOwner.get(id);
    if (!owner || owner === tx) { lockOwner.set(id, tx); tx.locks.add(id); return; }
    if (tx.lockTimeoutMs == null) throw new Error(`fake db: waited for chat ${id} with no lock_timeout set`);
    if (Date.now() > until) throw pgErr('55P03', 'canceling statement due to lock timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const releaseLocks = (tx) => { for (const id of tx.locks) if (lockOwner.get(id) === tx) lockOwner.delete(id); tx.locks.clear(); };
function setRow(tx, obj, patch) {
  const old = {};
  for (const k of Object.keys(patch)) old[k] = obj[k];
  if (tx) tx.undo.push(() => Object.assign(obj, old));
  Object.assign(obj, patch);
}
function add(tx, arr, item) {
  arr.push(item);
  if (tx) tx.undo.push(() => { const i = arr.indexOf(item); if (i >= 0) arr.splice(i, 1); });
}
const need = (tx, q) => { if (!tx) throw new Error('fake db: must run inside the action\'s transaction: ' + q.slice(0, 90)); };

const LOCK_SQL = "SELECT c.id, c.site_id, c.status, c.assigned_to, c.case_kind, c.case_order_id, c.merged_into, c.verified_order_id, c.phone_match_order_id, c.customer_key, c.source FROM conversations c WHERE c.id = $1 OR ($2::text IS NOT NULL AND c.source = 'chat' AND c.site_id = $3 AND c.customer_key = $2 AND c.merged_into IS NULL AND c.status <> 'resolved') ORDER BY c.id FOR NO KEY UPDATE";
const LOCK_COLS = ['id', 'site_id', 'status', 'assigned_to', 'case_kind', 'case_order_id', 'merged_into', 'verified_order_id', 'phone_match_order_id', 'customer_key', 'source'];
const WAITING_Q = norm(`SELECT (${wsql.WAITING_SINCE_SQL}) IS NOT NULL AS w FROM conversations c ${wsql.WAITING_LATERAL} WHERE c.id = $1`);
const STATUS_SQL = "UPDATE conversations SET status = $1, unread_count = CASE WHEN $1 = 'resolved' THEN 0 ELSE unread_count END, closed_by_name = CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN $3::text ELSE closed_by_name END, closed_at = CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN now() ELSE closed_at END, auto_closed_at = CASE WHEN $1 = 'resolved' AND status = 'resolved' THEN auto_closed_at ELSE NULL END, assigned_to = CASE WHEN $4::text IS NOT NULL THEN $4::text ELSE assigned_to END, assigned_at = CASE WHEN $4::text IS NOT NULL THEN now() ELSE assigned_at END, updated_at = now() WHERE id = $2 RETURNING status, closed_by_name, closed_at, auto_closed_at, assigned_to";
const EVENT_SQL = 'INSERT INTO chat_events (conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner, from_status, to_status, reason, note, message_id, meta) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)';
const CASE_MARK_SQL = "UPDATE conversations SET case_prev_status = CASE WHEN case_kind IS NULL THEN status ELSE case_prev_status END, case_kind = $2, case_marked_by = $3, case_marked_at = now(), case_order_id = $4, status = CASE WHEN status = 'resolved' THEN status ELSE 'agent_handling' END, auto_closed_at = NULL, updated_at = now() WHERE id = $1 RETURNING case_kind, case_marked_by, case_marked_at, case_order_id, status";
const CASE_EVENT_SQL = "INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role) VALUES ($1, $2, $3, $4, 'mark', $5, $6, $7)";
// The thread read's unanswered urgent marker (review fix 2026-10-02), played here over db.messages: the newest
// 'threat' (else 'accusation') on a visible customer message with no visible team reply after it.
const URGENT_OPEN_SQL = norm(`(SELECT u.metadata->>'urgent' FROM messages u
              WHERE u.conversation_id = c.id AND u.sender = 'visitor' AND u.deleted_at IS NULL
                AND u.metadata->>'urgent' IN ('threat', 'accusation')
                AND COALESCE(u.metadata->>'hidden', 'false') <> 'true'
                AND NOT EXISTS (SELECT 1 FROM messages a
                                 WHERE a.conversation_id = c.id AND a.sender = 'agent' AND a.deleted_at IS NULL
                                   AND COALESCE(a.metadata->>'hidden', 'false') <> 'true' AND COALESCE(a.metadata->>'withheld', '') = ''
                                   AND a.content IS NOT NULL AND btrim(a.content) <> '' AND a.created_at > u.created_at)
              ORDER BY (u.metadata->>'urgent' = 'threat') DESC, u.created_at DESC LIMIT 1) AS urgent_open`);
function urgentOpen(id) {
  const meta = (m) => m.metadata || {};
  const ms = db.messages.filter((m) => m.conversation_id === id && !m.deleted_at && String(meta(m).hidden) !== 'true');
  const answered = (t) => ms.some((a) => a.sender === 'agent' && !meta(a).withheld && String(a.content || '').trim() !== '' && Date.parse(a.created_at) > t);
  const open = ms.filter((m) => m.sender === 'visitor' && ['threat', 'accusation'].includes(meta(m).urgent) && !answered(Date.parse(m.created_at)));
  open.sort((a, b) => (Number(meta(b).urgent === 'threat') - Number(meta(a).urgent === 'threat')) || Date.parse(b.created_at) - Date.parse(a.created_at));
  return open.length ? meta(open[0]).urgent : null;
}

async function handle(q, p, tx) {
  let m;
  if (q === 'BEGIN') return rows([]);
  if (q === 'COMMIT') { if (tx.aborted) throw new Error('fake db: COMMIT of an aborted transaction'); tx.open = false; releaseLocks(tx); return rows([]); }
  if (q === 'ROLLBACK') { while (tx.undo.length) tx.undo.pop()(); tx.open = false; releaseLocks(tx); return rows([]); }
  if ((m = q.match(/^SAVEPOINT (\w+)$/))) { need(tx, q); tx.sp.set(m[1], tx.undo.length); return rows([]); }
  if ((m = q.match(/^RELEASE SAVEPOINT (\w+)$/))) { tx.sp.delete(m[1]); return rows([]); }
  if ((m = q.match(/^ROLLBACK TO SAVEPOINT (\w+)$/))) { const at = tx.sp.get(m[1]); while (tx.undo.length > at) tx.undo.pop()(); tx.aborted = false; return rows([]); }
  if ((m = q.match(/^SET LOCAL lock_timeout = '(\d+)s'$/))) { need(tx, q); tx.lockTimeoutMs = Number(m[1]) * 1000 * SCALE; return rows([]); }
  if (q === "SELECT set_config('shiptrack.actor', $1, true), set_config('shiptrack.actor_name', $2, true), set_config('shiptrack.reason', $3, true)") {
    need(tx, q); tx.actor = { key: p[0], name: p[1], reason: p[2] }; return rows([{}]);
  }

  // Logins and presence (src/lib/auth.ts)
  if (q === 'SELECT id, username, display_name, role, is_active, business_ids, permissions, session_version FROM team_users') return rows(clone(TEAM));
  if (q === 'SELECT username, password_hash, session_version, updated_at FROM admin_login WHERE id = 1') return rows([]);
  if (q === 'INSERT INTO staff_presence (actor, last_seen_at) SELECT * FROM unnest($1::text[], $2::timestamptz[]) ON CONFLICT (actor) DO UPDATE SET last_seen_at = GREATEST(staff_presence.last_seen_at, EXCLUDED.last_seen_at)') return rows([]);
  if (q === 'SELECT actor, last_seen_at FROM staff_presence') return rows([]);

  // The chat lock (team-routing.ts lockChatGroup) and the team's events
  if (q === LOCK_SQL) {
    need(tx, q);
    if (tx.lockTimeoutMs == null) throw new Error('fake db: a chat lock taken before SET LOCAL lock_timeout');
    const [id, key, siteId] = p;
    const match = (c) => c.id === id || (key != null && c.source === 'chat' && c.site_id === siteId && c.customer_key === key && !c.merged_into && c.status !== 'resolved');
    const ids = db.convs.filter(match).map((c) => c.id).sort();
    for (const x of ids) await lockRow(tx, x);
    return rows(ids.map((x) => pick(conv(x), LOCK_COLS)));
  }
  if (q === WAITING_Q) return rows(conv(p[0]) ? [{ w: !!conv(p[0]).waiting }] : []);
  if (q === EVENT_SQL) {
    const [conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner, from_status, to_status, reason, note, message_id, meta] = p;
    add(tx, db.events, { id: ++seq, conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner, from_status, to_status, reason, note, message_id, meta: meta == null ? null : JSON.parse(meta) });
    return rows([]);
  }
  if (q === 'UPDATE conversations SET assigned_to = $1, assigned_at = now() WHERE id = ANY($2::text[])') {
    need(tx, q);
    for (const id of p[1]) { await lockRow(tx, id); setRow(tx, conv(id), { assigned_to: p[0], assigned_at: nowIso() }); }
    return rows([]);
  }

  // The thread (GET, and the unlocked read every PATCH starts with)
  if (/^SELECT c\.id, c\.site_id, c\.visitor_name, .* FROM conversations c JOIN sites s ON s\.id = c\.site_id LEFT JOIN businesses b .* WHERE c\.id = \$1$/.test(q)) {
    if (!q.includes('c.health_signals')) throw new Error('fake db: the thread read must select c.health_signals');
    if (!q.includes(URGENT_OPEN_SQL)) throw new Error('fake db: the thread read must select the unanswered urgent marker');
    const c = conv(p[0]);
    if (!c) return rows([]);
    const s = SITES[c.site_id];
    const last = db.caseEvents.filter((e) => e.conversation_id === c.id && e.kind === c.case_kind && e.action === 'mark').pop();
    const out = rows([{ ...clone(c), display_name: c.visitor_name, name_from_order: false, site_name: s.name, tracker_business_id: s.panel, panel_name: 'Panel ' + s.panel,
      case_mark_role: c.case_kind ? (last ? last.actor_role : null) : null, urgent_open: urgentOpen(c.id) }]);
    // Something changes the chat right after this read (H6).
    if (db.afterRead) { const f = db.afterRead; db.afterRead = null; f(c); }
    return out;
  }
  if (/^SELECT id, sender, content, metadata, created_at, edited_at, edited_by, deleted_at, deleted_by, \(SELECT u\.notes FROM brain_usage u WHERE u\.message_id = messages\.id\) AS brain FROM messages WHERE conversation_id = \$1 AND /.test(q)) {
    return rows(db.messages.filter((x) => x.conversation_id === p[0]).map((x) => ({ ...clone(x), brain: null })));
  }
  if (/^WITH older AS \( SELECT c\.id, c\.created_at, c\.status, /.test(q)) return rows([]);
  if (/^SELECT c\.id AS conversation_id, c\.created_at, c\.last_message_at, c\.status FROM conversations c /.test(q)) return rows([]);
  if (q === 'UPDATE conversations SET unread_count = 0, updated_at = now() WHERE id = $1') { const c = conv(p[0]); if (c) c.unread_count = 0; return rows([]); }
  if (q === "SELECT id, created_at, kind, actor, actor_name, from_owner, to_owner, reason, note FROM chat_events WHERE conversation_id = $1 AND kind IN ('claim','take','transfer','inherit','merge') ORDER BY id DESC LIMIT 10") return rows([]);
  if (q === "SELECT DISTINCT ON (message_id) message_id, actor, actor_name FROM chat_events WHERE kind = 'reply' AND message_id = ANY($1::text[]) ORDER BY message_id, id") return rows([]);

  // Take over / Take from X / Hand to AI / Close
  if (q === STATUS_SQL) {
    need(tx, q);
    const c = conv(p[1]);
    await lockRow(tx, c.id);
    const [st, , name, owner] = p;
    const was = c.status;
    setRow(tx, c, {
      status: st, unread_count: st === 'resolved' ? 0 : c.unread_count,
      closed_by_name: st === 'resolved' && was !== 'resolved' ? name : c.closed_by_name,
      closed_at: st === 'resolved' && was !== 'resolved' ? nowIso() : c.closed_at,
      auto_closed_at: st === 'resolved' && was === 'resolved' ? c.auto_closed_at : null,
      ...(owner != null ? { assigned_to: owner, assigned_at: nowIso() } : {}),
    });
    return rows([pick(c, ['status', 'closed_by_name', 'closed_at', 'auto_closed_at', 'assigned_to'])]);
  }
  // Transfer
  if (q === 'UPDATE conversations SET assigned_to = $2::text, assigned_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, status = $3, auto_closed_at = NULL, updated_at = now() WHERE id = $1 RETURNING status, assigned_to') {
    need(tx, q);
    const c = conv(p[0]);
    setRow(tx, c, { assigned_to: p[1], assigned_at: p[1] == null ? null : nowIso(), status: p[2], auto_closed_at: null });
    return rows([pick(c, ['status', 'assigned_to'])]);
  }
  if (q === 'UPDATE conversations SET assigned_to = $1::text, assigned_at = CASE WHEN $1::text IS NULL THEN NULL ELSE now() END WHERE id = ANY($2::text[])') {
    need(tx, q);
    for (const id of p[1]) setRow(tx, conv(id), { assigned_to: p[0], assigned_at: p[0] == null ? null : nowIso() });
    return rows([]);
  }
  // Refund / Ship again mark
  if (q === CASE_MARK_SQL) {
    need(tx, q);
    const c = conv(p[0]);
    setRow(tx, c, {
      case_prev_status: c.case_kind == null ? c.status : c.case_prev_status, case_kind: p[1], case_marked_by: p[2], case_marked_at: nowIso(), case_order_id: p[3],
      status: c.status === 'resolved' ? c.status : 'agent_handling', auto_closed_at: null,
    });
    return rows([pick(c, ['case_kind', 'case_marked_by', 'case_marked_at', 'case_order_id', 'status'])]);
  }
  if (q === CASE_EVENT_SQL) {
    need(tx, q);
    add(tx, db.caseEvents, { id: p[0], conversation_id: p[1], site_id: p[2], kind: p[3], action: 'mark', order_id: p[4], actor: p[5], actor_role: p[6] });
    return rows([]);
  }
  throw new Error('fake db: unexpected SQL: ' + q.slice(0, 200));
}

const als = new AsyncLocalStorage();
let txSeq = 0;
async function run(sql, params = [], tx = null) {
  const q = norm(sql);
  const inTx = als.getStore();
  if (!tx && inTx && inTx.open && !/team_users|admin_login|staff_presence/.test(q)) {
    throw new Error('fake db: a pool query inside a locked action (it would wait on its own lock): ' + q.slice(0, 120));
  }
  db.stmts.push({ tx: tx ? tx.id : null, q });
  if (tx && tx.aborted && !/^ROLLBACK/.test(q)) throw new Error('fake db: current transaction is aborted: ' + q.slice(0, 80));
  try {
    return await handle(q, params || [], tx);
  } catch (e) {
    if (tx && !/^ROLLBACK/.test(q)) tx.aborted = true;
    throw e;
  }
}
async function withTransaction(fn) {
  const tx = { id: ++txSeq, undo: [], sp: new Map(), locks: new Set(), lockTimeoutMs: null, aborted: false, open: true, actor: null };
  const client = { query: (sql, params) => run(sql, params, tx) };
  await run('BEGIN', [], tx);
  try {
    const r = await als.run(tx, () => fn(client));
    await run('COMMIT', [], tx);
    return r;
  } catch (e) {
    if (tx.open) await run('ROLLBACK', [], tx);
    throw e;
  }
}
global.__fakeDb = { run, withTransaction };

// ── Requests, people, the clock ────────────────────────────────
const ist = (h, m = 0, day = 2) => Date.UTC(2026, 9, day, h, m) - 330 * 60_000;   // IST wall time -> instant
const realNow = Date.now;
const clock = ist(15, 0);   // 2 Oct 2026, 15:00 IST: office hours
Date.now = () => clock;

const r = (f) => require(path.join(dir, f + '.js'));
const auth = r('auth'), rules = r('team-rules'), thread = r('r-thread'), health = r('health-rules');
const tokens = {};
function makeTokens() {
  const m = (u) => auth.generateToken(u.username, u.role, u.business_ids, { name: u.display_name, perms: u.permissions, sv: u.session_version, uid: u.id });
  tokens.owner = auth.generateToken('Owner', 'admin', null, { name: 'Super Admin' });
  for (const u of TEAM) tokens[u.username] = m(u);
}
function req(who, body, method) {
  return {
    method, url: 'http://x/api',
    headers: { get: (k) => (k.toLowerCase() === 'authorization' && tokens[who] ? `Bearer ${tokens[who]}` : null) },
    json: async () => { if (body === undefined) throw new Error('no body'); return clone(body); },
  };
}
const patch = (who, id, body) => thread.PATCH(req(who, body, 'PATCH'), { params: { id } });
const get = (who, id) => thread.GET(req(who, undefined, 'GET'), { params: { id } });
const close = (who, id) => patch(who, id, { status: 'resolved' });
const toAi = (who, id) => patch(who, id, { status: 'ai_handling' });

let convSeq = 0;
function newConv(o = {}) {
  const id = o.id || 'h' + (++convSeq);
  const c = {
    id, site_id: 'S1', source: 'chat', status: 'agent_handling', assigned_to: null, assigned_at: null, customer_key: null, merged_into: null,
    case_kind: null, case_order_id: null, case_prev_status: null, case_marked_by: null, case_marked_at: null,
    verified_order_id: null, verified_via: null, phone_match_order_id: null, unread_count: 0, auto_closed_at: null,
    closed_by_name: null, closed_at: null, visitor_name: 'Visitor', visitor_phone: null, category: 'others',
    subject_label: null, subject_summary: null, subject_updated_at: null,
    health_score: null, health_reason: null, health_updated_at: null, health_signals: null,
    created_at: new Date(clock - 3600_000).toISOString(), last_message_at: new Date(clock - 60_000).toISOString(),
    ...o,
  };
  db.convs.push(c);
  return c;
}
// A known customer (verified by the widget form).
const known = (o = {}) => newConv({ verified_order_id: '#' + (o.id || 'x' + convSeq), verified_via: 'form', ...o });
const sig = (o) => ({ refund: 0, abuse: 0, rude: 0, accuse: 0, threat: 0, escalate: 0, caps: 0, burst: 0, repeats: 0, chats: 1, ...o });
const autoRefund = (o = {}) => known({ case_kind: 'refund', case_marked_by: 'Chikki (auto)', case_marked_at: new Date(clock - 120_000).toISOString(), case_prev_status: 'human_needed', ...o });
// Messages as the widget route / the inbox store them (minutes ago). urgent: escalation.ts urgentKind.
let msgSeq = 0;
const said = (id, sender, minsAgo, o = {}) => {
  const m = { id: 'm' + (++msgSeq), conversation_id: id, sender, content: o.content ?? (sender === 'visitor' ? 'customer words' : 'team words'),
    metadata: o.metadata ?? null, created_at: new Date(clock - minsAgo * 60_000).toISOString(), edited_at: null, edited_by: null, deleted_at: o.deleted_at ?? null, deleted_by: null };
  db.messages.push(m);
  return m;
};
const urgentSaid = (id, kind, minsAgo = 5) => said(id, 'visitor', minsAgo, { metadata: { urgent: kind } });
// The four hot conditions, each on its own (a fresh chat per call). The threat / fraud chats also carry the
// word counts health-rules.ts gave them; the lock reads the marker, never the counts.
const HOT = {
  risk: () => known({ health_score: 77, health_signals: sig({ escalate: 1, llm: 77 }) }),
  threat: () => { const c = known({ health_score: 20, health_signals: sig({ threat: 1, llm: 20 }) }); urgentSaid(c.id, 'threat'); return c; },
  fraud: () => { const c = known({ health_score: 20, health_signals: sig({ accuse: 2, llm: 20 }) }); urgentSaid(c.id, 'accusation'); return c; },
  auto_refund: () => autoRefund({ health_score: 10, health_signals: sig({ llm: 10 }) }),
};
const snapshot = (id) => clone({ c: conv(id), events: db.events.filter((e) => e.conversation_id === id), caseEvents: db.caseEvents.filter((e) => e.conversation_id === id) });
const txWrites = (n) => db.stmts.slice(n).filter((s) => s.tx !== null && /^(UPDATE|INSERT|SELECT set_config)/.test(s.q));

// Console output is kept, and shown only when a test fails.
const logged = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn };
for (const k of ['log', 'error', 'warn']) console[k] = (...a) => logged.push(`[${k}] ` + a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(' '));

let n = 0;
const t = async (name, fn) => {
  try { await fn(); n++; } catch (e) {
    Object.assign(console, realConsole);
    console.error('FAIL ' + name);
    console.error(logged.slice(-25).join('\n'));
    throw e;
  }
};
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;
const status = (res, want, label = '') => eq(res.status, want, `${label} expected ${want}, got ${res.status}: ${JSON.stringify(res.body)}`);
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

(async () => {
  await auth.refreshTeamCache();
  makeTokens();

  // ── H1: the pure rules ────────────────────────────────────────
  await t('H1 hotChat: each condition on its own, strongest first; visitors only by Chikki\'s Refund; never the word counts; edges', () => {
    const f = (o) => ({ known: true, healthScore: null, urgent: null, caseKind: null, caseMarkedBy: null, ...o });
    eq(rules.hotChat(f({})), null, 'a calm known customer');
    // A score saved before the model's number was kept (no modelScore key): health_score, as before.
    eq(rules.hotChat(f({ healthScore: 64 })), null, '64% is not At risk');
    eq(rules.hotChat(f({ healthScore: 65 })), 'risk', '65% is (HEALTH_PIN_MIN)');
    eq(rules.hotChat(f({ healthScore: 100 })), 'risk');
    // With the model's own number: it decides, whatever floor the word counts put on health_score.
    eq(rules.hotChat(f({ healthScore: 85, modelScore: 10 })), null, '"fir kab aayega": counts floor 85, the model 10');
    eq(rules.hotChat(f({ healthScore: 70, modelScore: 65 })), 'risk');
    eq(rules.hotChat(f({ healthScore: 85, modelScore: '72' })), 'risk', 'a number read as text');
    eq(rules.hotChat(f({ healthScore: 85, modelScore: null })), null, 'the model failed: no At risk from the counts');
    eq(rules.hotChat(f({ urgent: 'threat' })), 'threat', 'the marker locks before any score');
    eq(rules.hotChat(f({ urgent: 'accusation' })), 'fraud');
    eq(rules.hotChat(f({ urgent: 'x', healthScore: NaN, modelScore: {} })), null, 'junk is nothing');
    eq(rules.hotChat(f({ threat: 3, accuse: 3 })), null, 'the word counts are not read at all');
    eq(rules.hotChat(f({ caseKind: 'refund', caseMarkedBy: 'Chikki (auto)' })), 'auto_refund');
    eq(rules.hotChat(f({ caseKind: 'refund', caseMarkedBy: 'Rahul' })), null, 'a person\'s Refund mark is not hot by itself');
    eq(rules.hotChat(f({ caseKind: 'reship', caseMarkedBy: 'Chikki (auto)' })), null, 'Chikki\'s Ship again is not hot by itself');
    eq(rules.hotChat(f({ caseKind: 'refund', caseMarkedBy: 'Chikki (auto)', urgent: 'threat', healthScore: 90 })), 'auto_refund', 'strongest first');
    eq(rules.hotChat(f({ urgent: 'threat', healthScore: 90 })), 'threat');
    eq(rules.hotChat(f({ urgent: 'accusation', healthScore: 90 })), 'fraud');
    // A visitor is never in the problem tabs (KNOWN_CUSTOMER), so not hot by score or marker.
    eq(rules.hotChat(f({ known: false, healthScore: 100, modelScore: 100, urgent: 'threat' })), null);
    eq(rules.hotChat(f({ known: false, caseKind: 'refund', caseMarkedBy: 'Chikki (auto)' })), 'auto_refund');
    eq(rules.hotLocked({ superAdmin: false }, 'risk'), true);
    eq(rules.hotLocked({ superAdmin: true }, 'risk'), false);
    eq(rules.hotLocked({ superAdmin: false }, null), false);
  });

  await t('H1 the texts: plain, staff only, no customer data; Close and Hand to AI named', () => {
    eq(rules.hotLockNote('risk', 77), 'Super Admin only. The customer is at risk (77% frustrated).');
    eq(rules.hotLockNote('threat'), 'Super Admin only. The customer made a threat (chargeback, court, police, legal action or bad reviews).');
    eq(rules.hotLockNote('fraud'), 'Super Admin only. The customer called the store a fraud.');
    eq(rules.hotLockNote('auto_refund'), 'Super Admin only. Chikki told the customer their refund is being processed and a refund form will come in this chat.');
    eq(rules.hotLockMessage('risk', 'close', 77), 'Only the Super Admin can close this chat. The customer is at risk (77% frustrated). You can still reply, take it over or transfer it.');
    ok(rules.hotLockMessage('threat', 'hand_to_ai').startsWith('Only the Super Admin can hand this chat to the AI. '));
    for (const k of ['risk', 'threat', 'fraud', 'auto_refund']) {
      for (const s of [rules.hotLockNote(k, 80), rules.hotLockMessage(k, 'close', 80), rules.hotLockMessage(k, 'hand_to_ai', 80)]) {
        ok(!/today|tomorrow|courier|\d{6,}/i.test(s), s);
      }
    }
  });

  await t('H1 the same values as the rest of the app (team-rules.ts has no imports)', () => {
    eq(rules.HOT_SCORE_MIN, health.HEALTH_PIN_MIN, 'HOT_SCORE_MIN = HEALTH_PIN_MIN');
    const mark = read('lib/chat/tracking-claim.ts').match(/export const AUTO_MARK_NAME = '([^']+)'/);
    ok(mark, 'tracking-claim.ts AUTO_MARK_NAME');
    eq(rules.HOT_AUTO_MARKER, mark[1], 'HOT_AUTO_MARKER = AUTO_MARK_NAME');
    ok(!/^\s*import\s/m.test(read('lib/chat/team-rules.ts')), 'team-rules.ts has no imports');
    // The At risk level = HEALTH_PIN_MIN+, known customers only (the list route's tab).
    const list = read('app/api/chat/conversations/route.ts');
    ok(/if \(key === 'risk'\) return `COALESCE\(\$\{a\}\.health_score, 0\) >= \$\{HEALTH_PIN_MIN\}`;/.test(list), 'At risk tab');
    ok(/conditions\.push\(KNOWN_CUSTOMER\);\s*\/\/ problem tabs are for customers/.test(list), 'the tabs are for known customers');
    // The marker values are escalation.ts's (UrgentKind), saved on the message by the widget route and the email poller.
    ok(/export type UrgentKind = 'threat' \| 'accusation';/.test(read('lib/chat/escalation.ts')), 'UrgentKind');
    ok(/\.\.\.\(urgent \? \{ urgent \} : \{\}\)/.test(read('app/api/widget/message/route.ts')), 'the widget route saves the marker');
    // The model's own number is kept beside the counts (health.ts), and the thread route reads it, never the counts.
    ok(read('lib/chat/health.ts').includes('JSON.stringify({ ...signals, llm: llm ? llm.score : null })'), 'health.ts keeps the model\'s number');
    const thread = read('app/api/chat/conversations/[id]/route.ts');
    ok(norm(thread).includes(URGENT_OPEN_SQL), 'the thread read selects the unanswered urgent marker');
    ok(!/sig\?\.(threat|accuse)|health_signals->>'(threat|accuse)'/.test(thread), 'the lock never reads the word counts');
  });

  // ── H2: a member on a hot chat ─────────────────────────────────
  await t('H2 a member\'s Close / Hand to AI on a hot chat is 403 for each condition (junior, senior holder, panel Admin); nothing saved', async () => {
    for (const [kind, make] of Object.entries(HOT)) {
      for (const who of ['anurag', 'rahul', 'neha']) {
        const holder = who === 'rahul' ? RAHUL : null;   // the senior holds his chat; the others act on an unheld one
        const c = make();
        if (holder) c.assigned_to = holder;
        const before = snapshot(c.id), s0 = db.stmts.length;
        const rc = await close(who, c.id);
        status(rc, 403, `${kind} ${who} close`);
        ok(rc.body.error.startsWith('Only the Super Admin can close this chat. '), rc.body.error);
        ok(rc.body.error.endsWith(' You can still reply, take it over or transfer it.'));
        const ra = await toAi(who, c.id);
        status(ra, 403, `${kind} ${who} hand to AI`);
        ok(ra.body.error.startsWith('Only the Super Admin can hand this chat to the AI. '), ra.body.error);
        deq(snapshot(c.id), before, `${kind} ${who}: nothing changed`);
        deq(txWrites(s0), [], `${kind} ${who}: no write, no actor set`);
        ok(db.stmts.slice(s0).some((s) => s.q === 'ROLLBACK'), 'the transaction rolled back');
      }
    }
    // The reason each time is the one the inbox shows.
    const c = HOT.risk();
    eq((await close('anurag', c.id)).body.error, rules.hotLockMessage('risk', 'close', 77));
    const a = HOT.auto_refund();
    eq((await toAi('anurag', a.id)).body.error, rules.hotLockMessage('auto_refund', 'hand_to_ai', 10),
      'on Chikki\'s Refund a member is told why, not "remove the mark first"');
  });

  await t('H2 a hot chat that is already Closed, or in Needs you, or the AI\'s: still the Super Admin\'s to close / hand to the AI', async () => {
    for (const st of ['human_needed', 'ai_handling', 'resolved']) {
      const c = HOT.threat(); c.status = st;
      status(await close('anurag', c.id), 403, st);
      status(await toAi('anurag', c.id), 403, st);
      eq(conv(c.id).status, st);
    }
  });

  await t('H2 a viewer stays 403 as before; someone else\'s hot chat is refused too (403, nothing saved)', async () => {
    const c = HOT.risk();
    eq((await close('viewer', c.id)).body.error, 'You cannot change conversations');
    c.assigned_to = RAHUL;
    const before = snapshot(c.id);
    status(await close('anurag', c.id), 403);
    deq(snapshot(c.id), before);
  });

  // ── H3: who may ───────────────────────────────────────────────
  await t('H3 the Super Admin closes and hands to the AI on every hot chat (a member\'s too)', async () => {
    for (const [kind, make] of Object.entries(HOT)) {
      const c = make();
      c.assigned_to = ANURAG;
      if (kind !== 'auto_refund') {
        status(await toAi('owner', c.id), 200, kind);
        eq(conv(c.id).status, 'ai_handling');
        conv(c.id).status = 'agent_handling';
      } else {
        // Any marked chat: the mark is removed first, for him too (unchanged rule).
        const ra = await toAi('owner', c.id);
        status(ra, 409);
        eq(ra.body.error, 'Remove the Refund / Ship again mark before handing this chat to the AI');
      }
      const rc = await close('owner', c.id);
      status(rc, 200, kind);
      deq([conv(c.id).status, conv(c.id).closed_by_name, conv(c.id).assigned_to], ['resolved', 'Super Admin', ANURAG]);
    }
  });

  await t('H3 not hot: a member closes and hands to the AI as before (calm, 64%, visitor at 100% with a threat, a person\'s Refund, Chikki\'s Ship again)', async () => {
    const cases = {
      calm: () => known({ health_score: 30, health_signals: sig({ refund: 2, escalate: 1 }) }),
      '64%': () => known({ health_score: 64, health_signals: sig({ abuse: 1 }) }),
      'no score yet': () => known({}),
      visitor: () => { const c = newConv({ health_score: 100, health_signals: sig({ threat: 2, accuse: 1, llm: 100 }) }); urgentSaid(c.id, 'threat'); return c; },
      // Review fix 2026-10-02 (owner 19:20): word counts alone ("fir kab aayega", "tracking id fake hai") and the 85
      // floor they put on health_score, with the model at 10: not hot.
      'word counts only': () => known({ health_score: 85, health_signals: sig({ threat: 1, accuse: 2, llm: 10 }) }),
      'threat answered': () => { const c = known({ health_score: 40, health_signals: sig({ threat: 1, llm: 40 }) }); urgentSaid(c.id, 'threat', 30); said(c.id, 'agent', 20); return c; },
      'model failed': () => known({ health_score: 85, health_signals: sig({ threat: 1, llm: null }) }),
      'staff Refund': () => known({ case_kind: 'refund', case_marked_by: 'Rahul', health_score: 40, health_signals: sig({ refund: 3 }) }),
      'Chikki Ship again': () => known({ case_kind: 'reship', case_marked_by: 'Chikki (auto)', health_score: 40, health_signals: sig({}) }),
    };
    for (const [label, make] of Object.entries(cases)) {
      const c = make();
      if (!c.case_kind) {
        status(await toAi('anurag', c.id), 200, label + ' hand to AI');
        eq(conv(c.id).status, 'ai_handling');
        conv(c.id).status = 'agent_handling';
      }
      status(await close('anurag', c.id), 200, label + ' close');
      eq(conv(c.id).status, 'resolved', label);
    }
  });

  // ── H4: what stays open to members ─────────────────────────────
  await t('H4 on a hot chat a member may still Take over, Take from a junior (senior), Transfer and mark Refund', async () => {
    const c = HOT.threat(); c.status = 'human_needed';
    const r1 = await patch('anurag', c.id, { status: 'agent_handling' });
    status(r1, 200, 'take over');
    deq([conv(c.id).status, conv(c.id).assigned_to], ['agent_handling', ANURAG]);
    status(await patch('rahul', c.id, { status: 'agent_handling', take: true }), 200, 'take from a junior');
    eq(conv(c.id).assigned_to, RAHUL);
    status(await patch('rahul', c.id, { transferTo: ANURAG, note: 'angry customer, please call' }), 200, 'transfer');
    eq(conv(c.id).assigned_to, ANURAG);
    const m = HOT.risk();
    const rm = await patch('rahul', m.id, { caseKind: 'refund' });
    status(rm, 200, 'mark Refund');
    deq([conv(m.id).case_kind, conv(m.id).case_marked_by], ['refund', 'Rahul']);
    // ... and still no Close for the junior who now has it.
    status(await close('anurag', c.id), 403);
  });

  // ── H5: what the thread says ──────────────────────────────────
  await t('H5 GET hot_lock: members off with the reason on every hot chat; the Super Admin never; staff block shape unchanged', async () => {
    for (const [kind, make] of Object.entries(HOT)) {
      const c = make();
      const g = await get('anurag', c.id);
      status(g, 200);
      deq(g.body.hot_lock, { can_close: false, can_hand_to_ai: false, lock_reason: rules.hotLockNote(kind, c.health_score) }, kind);
      eq(g.body.staff.can_act, true, 'the member still acts on it (reply, Take over, Transfer)');
      deq(Object.keys(g.body.staff).sort(), ['can_act', 'can_mark_case', 'claims', 'holder', 'mark_note', 'mark_override', 'me', 'office_open', 'take', 'transfer_to']);
      const go = await get('owner', c.id);
      deq(go.body.hot_lock, { can_close: true, can_hand_to_ai: kind !== 'auto_refund', lock_reason: null }, kind + ' owner');
    }
  });

  await t('H5 GET hot_lock: a chat that is not hot; someone else\'s chat; a viewer; a marked chat has no Hand to AI', async () => {
    const calm = known({ health_score: 20 });
    deq((await get('anurag', calm.id)).body.hot_lock, { can_close: true, can_hand_to_ai: true, lock_reason: null });
    const held = known({ health_score: 20, assigned_to: RAHUL });
    deq((await get('anurag', held.id)).body.hot_lock, { can_close: false, can_hand_to_ai: false, lock_reason: null }, 'Rahul\'s chat: not this login\'s to close');
    const heldHot = HOT.fraud(); heldHot.assigned_to = RAHUL;
    deq((await get('anurag', heldHot.id)).body.hot_lock, { can_close: false, can_hand_to_ai: false, lock_reason: rules.hotLockNote('fraud') });
    deq((await get('rahul', heldHot.id)).body.hot_lock, { can_close: false, can_hand_to_ai: false, lock_reason: rules.hotLockNote('fraud') }, 'the senior holder too');
    deq((await get('viewer', calm.id)).body.hot_lock, { can_close: false, can_hand_to_ai: false, lock_reason: null });
    const marked = known({ case_kind: 'refund', case_marked_by: 'Rahul' });
    deq((await get('anurag', marked.id)).body.hot_lock, { can_close: true, can_hand_to_ai: false, lock_reason: null });
    // The Super Admin's own refund chip still comes only to him, in a Refund chat.
    const a = HOT.auto_refund();
    ok((await get('owner', a.id)).body.refund_form, 'refund_form for the Super Admin');
    eq((await get('anurag', a.id)).body.refund_form, undefined, 'never for staff');
  });

  // ── H6: a mark between the read and the lock ───────────────────
  await t('H6 Chikki\'s Refund mark lands between the read and the lock: 409 try again, nothing saved; the retry is 403', async () => {
    const c = known({ health_score: 30, health_signals: sig({}) });
    db.afterRead = (row) => Object.assign(row, { case_kind: 'refund', case_marked_by: 'Chikki (auto)', case_marked_at: nowIso(), case_prev_status: 'agent_handling' });
    const s0 = db.stmts.length;
    const r1 = await close('anurag', c.id);
    status(r1, 409);
    eq(r1.body.error, 'Someone else is changing this chat right now. Try again.');
    deq([conv(c.id).status, conv(c.id).closed_by_name], ['agent_handling', null]);
    deq(txWrites(s0), [], 'no write, no actor set');
    const r2 = await close('anurag', c.id);
    status(r2, 403);
    eq(r2.body.error, rules.hotLockMessage('auto_refund', 'close', 30));
    // The other way round: the mark is removed in between; the member retries on a fresh read.
    const d = autoRefund({ health_score: 30, health_signals: sig({}) });
    db.afterRead = (row) => Object.assign(row, { case_kind: null, case_marked_by: null, case_marked_at: null });
    status(await close('anurag', d.id), 409);
    eq(conv(d.id).status, 'agent_handling');
    status(await close('anurag', d.id), 200);
    // The Super Admin is never held up by it.
    const e = known({ health_score: 30 });
    db.afterRead = (row) => Object.assign(row, { case_kind: 'refund', case_marked_by: 'Chikki (auto)' });
    status(await close('owner', e.id), 200);
  });

  // ── H7: the inbox ─────────────────────────────────────────────
  await t('H7 the inbox draws hot_lock: Close / Hand to AI off with the reason, a line on every screen size, the Super Admin\'s line', () => {
    const chatFiles = (d) => fs.readdirSync(path.join(SRC, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? chatFiles(`${d}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${d}/${e.name}`] : []));
    const page = ['app/admin/chat/page.tsx', ...chatFiles('app/admin/chat').filter((f) => f !== 'app/admin/chat/page.tsx').sort()].map(read).join('\n');
    ok(/hotLock: data\.hot_lock \?\? null/.test(page), 'the thread answer\'s hot_lock is kept with its chat');
    ok(/disabled=\{!!hotLock && !hotLock\.can_hand_to_ai\}[\s\S]{0,200}onClick=\{\(\) => changeStatus\('ai_handling'\)\}>Hand to AI</.test(page), 'Hand to AI off');
    ok(/disabled=\{!!hotLock && !hotLock\.can_close\}[\s\S]{0,200}onClick=\{\(\) => changeStatus\('resolved'\)\}>Close</.test(page), 'Close off');
    const line = page.indexOf('Close / Hand to AI: {hotLock.lock_reason}');
    ok(line > 0, 'the reason line');
    const block = page.slice(page.lastIndexOf('<div', line), line);
    ok(/flexBasis: '100%'/.test(block) && !/@media|display: 'none'|hide/i.test(block), 'a line of its own, never hidden on a phone');
    ok(page.includes('Chikki promised a refund form - press Send refund form'), 'the Super Admin\'s line');
    ok(/isSuperAdmin\(user\) && activeConv\.case_kind === 'refund' && activeConv\.case_marked_by === AUTO_MARK_NAME/.test(page), 'only for him, on Chikki\'s Refund');
    // The chip names Chikki on its own Refund mark, as on its Ship again marks.
    ok(/const autoRefund = refund && auto;/.test(page));
    ok(/\{big && by \? <span style=\{\{ fontWeight: 500 \}\}>· \{by\}/.test(page), 'the big chip shows who marked it');
    // Only the thread route gates Close / Hand to AI; system code never imports the lock.
    const users = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name) && /hotLockMessage|hotLocked\(/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(SRC, p)); } };
    walk(SRC);
    deq(users.sort(), ['app/api/chat/conversations/[id]/route.ts', 'lib/chat/team-rules.ts']);
  });

  // ── H8: review fixes 2026-10-02 ──────────────────────────────
  await t('H8 the urgent marker locks at once (the 18:30 chat: no score yet, a member presses Close within seconds); a team reply opens it; a hidden or blank reply does not', async () => {
    // The owner's sentence without "fraud", and four more the word counts miss (hot-miss): marked urgent by the widget route.
    const c = known({ health_score: null, health_signals: null });
    urgentSaid(c.id, 'threat', 1);
    status(await close('anurag', c.id), 403);
    eq((await close('anurag', c.id)).body.error, rules.hotLockMessage('threat', 'close', null));
    deq((await get('anurag', c.id)).body.hot_lock, { can_close: false, can_hand_to_ai: false, lock_reason: rules.hotLockNote('threat', null) });
    // A hidden team message, a withheld draft or a blank one is no answer.
    said(c.id, 'agent', 0.5, { metadata: { hidden: true } });
    said(c.id, 'agent', 0.5, { metadata: { withheld: 'draft' } });
    said(c.id, 'agent', 0.5, { content: '   ' });
    said(c.id, 'agent', 0.5, { deleted_at: nowIso() });
    status(await close('anurag', c.id), 403, 'still unanswered');
    // A real team reply: the threat is answered; the model's number (none yet here) decides from now on.
    said(c.id, 'agent', 0.2);
    deq((await get('anurag', c.id)).body.hot_lock, { can_close: true, can_hand_to_ai: true, lock_reason: null });
    // The customer threatens again after the reply: locked again; a fraud claim alone after it: fraud.
    const d = known({ health_score: 30, health_signals: sig({ llm: 30 }) });
    urgentSaid(d.id, 'threat', 10); said(d.id, 'agent', 8); urgentSaid(d.id, 'accusation', 2);
    eq((await get('anurag', d.id)).body.hot_lock.lock_reason, rules.hotLockNote('fraud', 30));
    urgentSaid(d.id, 'threat', 1);
    eq((await get('anurag', d.id)).body.hot_lock.lock_reason, rules.hotLockNote('threat', 30), 'a threat is named first');
    // A visitor's threat: the problem tabs are for known customers; Close stays open as before.
    const v = newConv({}); urgentSaid(v.id, 'threat', 1);
    status(await close('anurag', v.id), 200);
  });

  await t('H8 never the word counts: "fir kab aayega", an address near a court, "tracking id fake hai" (counts + the 85 floor, the model low): a member closes; the model At risk, or a score saved before the model\'s number was kept: locked', async () => {
    for (const [label, signals, score] of [
      ['fir kab aayega', sig({ threat: 1, llm: 10 }), 85], ['Opp. District Court', sig({ threat: 1, llm: 5 }), 85],
      ['tracking id fake hai', sig({ accuse: 1, llm: 30 }), 30], ['duplicate order / loot sale', sig({ accuse: 2, llm: 12 }), 22],
    ]) {
      const c = known({ health_score: score, health_signals: signals });
      deq((await get('anurag', c.id)).body.hot_lock, { can_close: true, can_hand_to_ai: true, lock_reason: null }, label);
      status(await close('anurag', c.id), 200, label);
    }
    const m = known({ health_score: 70, health_signals: sig({ llm: 68 }) });
    status(await close('anurag', m.id), 403, 'the model says At risk');
    eq((await close('anurag', m.id)).body.error, rules.hotLockMessage('risk', 'close', 70));
    const legacy = known({ health_score: 77, health_signals: sig({ escalate: 1 }) });   // scored before the llm key
    status(await close('anurag', legacy.id), 403, 'an older score stands until the customer writes again');
    status(await close('owner', m.id), 200, 'the Super Admin always');
  });

  Object.assign(console, realConsole);
  Date.now = realNow;
  console.log(`HOT-LOCK: ${n} groups passed`);
  process.exit(0);
})().catch((e) => { Object.assign(console, realConsole); console.error(e); process.exit(1); });
