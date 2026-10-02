// Chat team, part 3 (owner, 2026-10-01): the REAL routes against a fake database (spec section 9,
// R1-R20), built with the owner's answers: the Super Admin's own first reply or Take over on a chat
// nobody holds makes it his (OWNER_ACTIONS_CLAIM = true), a waiting customer may be taken from an
// away member (AWAY_TAKE = true, never from the Super Admin), and the Super Admin can give all his
// open chats back to the team (POST /api/chat/team/release, R21).
//
// The fake database is small but strict where the real one is:
//   - row locks: FOR NO KEY UPDATE (and every UPDATE inside a transaction) waits for the row; a wait
//     needs SET LOCAL lock_timeout first, and fails with 55P03 when it runs out (5 s here = 50 ms);
//   - a statement that fails inside a transaction aborts it until ROLLBACK (TO SAVEPOINT), and a
//     COMMIT of an aborted transaction is a test failure (an error was swallowed);
//   - a pool query made while the caller holds a transaction is a test failure (on the server it
//     would wait on its own lock);
//   - conversations.assigned_to and chat_events.note keep their CHECKs (chat-team.sql);
//   - trg_chat_status_event is played: one 'status' row per real status change, named by the
//     transaction's set_config, else customer / ai / system;
//   - trg_chat_owner_back is played (chat-team-owner-back.sql, owner answer A5, R23): a Closed chat
//     of the Super Admin's that the customer reopens goes to the open pool.
// Every other statement must match one the routes are known to send, or the test fails.
// The SQL itself (triggers, grants) is checked on the server in a rolled-back transaction.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
// The real path: Node keys its module cache by it (on a Mac the temp folder is a symlink), and a
// restart below drops the compiled modules from that cache.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-routing-')));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

process.env.AUTH_TOKEN_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.ADMIN_USERNAME = 'Owner';
process.env.ADMIN_PASSWORD = 'env-pass-123';

// ── Fake modules ───────────────────────────────────────────────
fs.writeFileSync(path.join(dir, 'next-server.js'), `
class NextResponse {
  // headers: the init's own (read as a plain object), plus set() as the pending route uses it.
  constructor(body, init = {}) { this.status = init.status || 200; this.body = body; this.headers = Object.assign(Object.create({ set(k, v) { this[k] = v; } }), init.headers || {}); }
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
stub('email', 'module.exports = { sendAgentEmailReply: async (...a) => { global.__emails.push(a); } };');
stub('order-facts', 'module.exports = { loadOrderFacts: async () => null };');
stub('order-address-db', 'module.exports = { loadOrderAddress: async () => null };');
stub('subject', 'module.exports = { updateConversationSubject: async () => {} };');
stub('health', 'module.exports = { updateConversationHealth: async () => {} };');
stub('brain-usage', 'module.exports = { recordBrainUsage: async () => {} };');
stub('chikki-runs', 'module.exports = { recordChikkiRun: async () => {} };');
// The customer's own earlier messages, newest first (index 0 = the message just stored): set by a test.
stub('chat-history', 'module.exports = { recentVisitorMessages: async () => global.__recentSaid || [] };');
// The verified order as orders.ts loads it (case-auto.ts): global.__orders[order id], else not found.
stub('orders', `module.exports = {
  lookupVerifiedOrder: async (id) => {
    global.__orderLookups.push(id);
    const o = global.__orders[id];
    return o ? { found: true, count: 1, orders: [JSON.parse(JSON.stringify(o))] } : { found: false, message: 'The verified order could not be loaded.' };
  },
};`);
// The model, scripted: the widget route's night line is what is tested, not the AI. next.onCall
// plays what the model's tools do to the chat during the turn (verify, escalate).
stub('ai', `module.exports = {
  AI_BUSY_REPLY: 'Sorry, that took longer than expected on my end. Could you send that again?',
  getAIResponse: async (...a) => { global.__ai.calls.push(a); if (global.__ai.next.onCall) global.__ai.next.onCall(); return { content: global.__ai.next.content, escalated: !!global.__ai.next.escalated, allFailed: false, toolCallMeta: global.__ai.next.toolCallMeta || null }; },
};`);
stub('refund-server', 'module.exports = { refundThreadState: async () => ({ can_send: false, block: "setup" }), refundMarkLocked: async () => false };');
global.__emails = [];
global.__ai = { calls: [], next: { content: '' } };
global.__orders = {};
global.__orderLookups = [];
global.__recentSaid = [];

// ── Compile the real code next to the fakes ────────────────────
const compile = (from, to) => {
  const src = fs.readFileSync(path.join(SRC, from), 'utf8')
    .replace(/from '@\/lib\/chat\/([\w-]+)'/g, "from './$1'")
    .replace(/from '@\/lib\/refund\/([\w-]+)'/g, "from './refund-$1'")
    .replace(/from '@\/lib\/([\w-]+)'/g, "from './$1'")
    .replace(/from 'next\/server'/g, "from './next-server'");
  fs.writeFileSync(path.join(dir, to + '.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true } }).outputText);
};
for (const f of ['permissions', 'auth', 'office-hours', 'journey']) compile(`lib/${f}.ts`, f);
// Refund form (owner 2026-10-02): the pure link mask is the real one; the refund server (its own suite,
// refund-route.js) is a stub here: no refund data, so the Refund mark is never locked.
compile('lib/refund/link-mask.ts', 'refund-link-mask');
for (const f of ['team-rules', 'waiting', 'waiting-sql', 'team-routing', 'plain-text', 'attachment-rules', 'display-name', 'inbox-search',
  'health-rules', 'inbox-topics', 'merge-chats', 'escalation', 'address-conflict', 'sensitive', 'widget-api', 'verified',
  'reply-guards', 'tracking-claim', 'refund-threat', 'case-auto']) compile(`lib/chat/${f}.ts`, f);
compile('app/api/chat/messages/route.ts', 'r-messages');
compile('app/api/chat/conversations/[id]/route.ts', 'r-thread');
compile('app/api/chat/conversations/route.ts', 'r-list');
compile('app/api/chat/pending/route.ts', 'r-pending');
compile('app/api/chat/team/release/route.ts', 'r-release');
compile('app/api/widget/messages/[conversationId]/route.ts', 'r-widget-messages');
compile('app/api/widget/message/route.ts', 'r-widget-message');
const wsql = require(path.join(dir, 'waiting-sql.js'));
const waitingMod = require(path.join(dir, 'waiting.js'));
const esc = require(path.join(dir, 'escalation.js'));
const tc = require(path.join(dir, 'tracking-claim.js'));
const rt = require(path.join(dir, 'refund-threat.js'));

// ── The fake database ──────────────────────────────────────────
const RAHUL = '11111111-1111-4111-8111-111111111111';   // senior (chat.senior)
const ANURAG = '22222222-2222-4222-8222-222222222222';  // junior
const OFF = '33333333-3333-4333-8333-333333333333';     // switched off
const PRIYA = '44444444-4444-4444-8444-444444444444';   // replies, but only in panel P2
const VIEWER = '55555555-5555-4555-8555-555555555555';  // reads chats, cannot reply
const GONE = '66666666-6666-4666-8666-666666666666';    // removed from the team (not in team_users)
const CHAT_PERMS = ['orders.view', 'chat.view', 'chat.reply', 'chat.cases', 'chat.edit'];
const member = (id, username, name, role, perms, extra = {}) => ({ id, username, display_name: name, role, is_active: true, business_ids: null, permissions: perms, session_version: 7, ...extra });
const TEAM = () => [
  member(RAHUL, 'rahul', 'Rahul', 'manager', [...CHAT_PERMS, 'orders.update', 'chat.senior']),
  member(ANURAG, 'anurag', 'Anurag', 'agent', [...CHAT_PERMS]),
  member(OFF, 'old.agent', 'Old Agent', 'agent', [...CHAT_PERMS], { is_active: false }),
  member(PRIYA, 'priya', 'Priya', 'agent', [...CHAT_PERMS], { business_ids: ['P2'] }),
  member(VIEWER, 'viewer', 'Vikas', 'viewer', ['chat.view']),
];

const SCALE = 0.01;                  // lock_timeout '5s' = 50 ms here
const NO_TIMEOUT_CAP_MS = 1500;      // a lock wait with no lock_timeout set fails the test after this
const db = {
  team: TEAM(), admin: null,
  sites: [
    { id: 'S1', name: 'Vastora', panel: 'P1', ai_enabled: true, widget_key: 'key-s1', system_prompt: null, cod_available: true },
    { id: 'S2', name: 'Other', panel: 'P2', ai_enabled: true, widget_key: 'key-s2', system_prompt: null, cod_available: true },
  ],
  convs: [], messages: [], events: [], caseEvents: [], presence: [], attachments: [],
  waiting: {}, waitingAsked: [], stmts: [], fail: [], after: [], lockWaits: 0,
  teamGate: null, presenceMissing: false, eventsBroken: false, ownerBack: true,
  list: null, unanswered: { n: 4, mine_open: 2, mine_waiting: 1 },
};
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const rows = (r) => ({ rows: r, rowCount: r.length });
const conv = (id) => db.convs.find((c) => c.id === id);
const siteOf = (id) => db.sites.find((s) => s.id === id);
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] === undefined ? null : clone(o[k])]));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const pgErr = (code, message) => Object.assign(new Error(message), { code });
const nowIso = () => new Date(Date.now()).toISOString();
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let seq = 0;

// Row locks, held to the end of the transaction.
const lockOwner = new Map(), waiters = new Map();
async function lockRow(tx, id) {
  for (;;) {
    const owner = lockOwner.get(id);
    if (!owner || owner === tx) { lockOwner.set(id, tx); tx.locks.add(id); return; }
    db.lockWaits++;
    const ms = tx.lockTimeoutMs ?? NO_TIMEOUT_CAP_MS;
    const got = await new Promise((resolve) => {
      const list = waiters.get(id) || []; waiters.set(id, list);
      const wake = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { const i = list.indexOf(wake); if (i >= 0) list.splice(i, 1); resolve(false); }, ms);
      list.push(wake);
    });
    if (!got) {
      if (tx.lockTimeoutMs == null) throw new Error(`fake db: waited for chat ${id} with no lock_timeout set (on the server this hangs)`);
      throw pgErr('55P03', 'canceling statement due to lock timeout');
    }
  }
}
function releaseLocks(tx) {
  for (const id of tx.locks) {
    if (lockOwner.get(id) === tx) lockOwner.delete(id);
    const list = waiters.get(id) || []; waiters.delete(id);
    for (const w of list) w();
  }
  tx.locks.clear();
}
// Another action holding a chat and not letting go (a stuck transaction).
function holdLock(id) {
  const tx = { id: 'stuck', locks: new Set() };
  lockOwner.set(id, tx); tx.locks.add(id);
  return () => releaseLocks(tx);
}

// Writes inside a transaction are undone by ROLLBACK (TO SAVEPOINT).
function add(tx, arr, item) {
  arr.push(item);
  if (tx) tx.undo.push(() => { const i = arr.indexOf(item); if (i >= 0) arr.splice(i, 1); });
}
function setRow(tx, obj, patch) {
  const before = { ...obj };
  // trg_chat_owner_back (chat-team-owner-back.sql, owner answer A5): BEFORE UPDATE OF status. A Closed
  // chat the Super Admin held BEFORE the update that is reopened with no staff person named in the
  // transaction (the customer's own writes) goes to the open pool, its transfer event first. A chat
  // that only becomes his in the same update (a merge target taking his chat's holder) stays his.
  // A failed event only warns.
  if ('status' in patch && db.ownerBack && db.convs.includes(obj) && !(tx && tx.actor)) {
    const next = { ...obj, ...patch };
    if (before.status === 'resolved' && next.status !== 'resolved' && before.assigned_to === 'owner' && next.assigned_to === 'owner' && !next.merged_into && !db.eventsBroken) {
      add(tx, db.events, {
        id: ++seq, conversation_id: obj.id, site_id: obj.site_id, kind: 'transfer', actor: 'system', actor_name: 'System',
        from_owner: 'owner', to_owner: null, from_status: before.status, to_status: next.status, reason: 'owner_customer_back',
        note: null, message_id: null, meta: { auto: true },
      });
      patch = { ...patch, assigned_to: null, assigned_at: nowIso() };
    }
  }
  if ('assigned_to' in patch && !(patch.assigned_to === null || patch.assigned_to === 'owner' || UUID.test(patch.assigned_to))) {
    throw pgErr('23514', 'new row for relation "conversations" violates check constraint "conversations_assigned_to_check"');
  }
  if (tx) { const old = {}; for (const k of Object.keys(patch)) old[k] = obj[k]; tx.undo.push(() => Object.assign(obj, old)); }
  Object.assign(obj, patch);
  // trg_chat_status_event (chat-team.sql): AFTER UPDATE OF status, a real change only. Never blocks.
  if ('status' in patch && before.status !== obj.status && db.convs.includes(obj) && !db.eventsBroken) {
    const who = tx && tx.actor;
    add(tx, db.events, {
      id: ++seq, conversation_id: obj.id, site_id: obj.site_id, kind: 'status',
      actor: who ? who.key : before.status === 'resolved' ? 'customer' : before.status === 'ai_handling' && obj.status === 'human_needed' ? 'ai' : 'system',
      actor_name: who ? who.name : null, from_owner: before.assigned_to, to_owner: obj.assigned_to,
      from_status: before.status, to_status: obj.status, reason: who ? who.reason : null, note: null, message_id: null, meta: null,
    });
  }
}
// An UPDATE inside a transaction locks the row, like Postgres.
async function rowFor(tx, id) {
  const c = conv(id);
  if (c && tx) await lockRow(tx, id);
  return c;
}
const need = (tx, q) => { if (!tx) throw new Error('fake db: must run inside the action\'s transaction: ' + q.slice(0, 90)); };

const LOCK_COLS = ['id', 'site_id', 'status', 'assigned_to', 'case_kind', 'case_order_id', 'merged_into', 'verified_order_id', 'phone_match_order_id', 'customer_key', 'source'];
const WAITING_Q = norm(`SELECT (${wsql.WAITING_SINCE_SQL}) IS NOT NULL AS w FROM conversations c ${wsql.WAITING_LATERAL} WHERE c.id = $1`);
// The Refund / Ship again SQL exactly as it was before the chat team (cb29348): byte-identical.
const OLD_CASE_SQL = {
  mark: "UPDATE conversations SET case_prev_status = CASE WHEN case_kind IS NULL THEN status ELSE case_prev_status END, case_kind = $2, case_marked_by = $3, case_marked_at = now(), case_order_id = $4, status = CASE WHEN status = 'resolved' THEN status ELSE 'agent_handling' END, auto_closed_at = NULL, updated_at = now() WHERE id = $1 RETURNING case_kind, case_marked_by, case_marked_at, case_order_id, status",
  remove: "UPDATE conversations SET status = CASE WHEN status = 'resolved' THEN status ELSE COALESCE(case_prev_status, 'agent_handling') END, case_kind = NULL, case_marked_by = NULL, case_marked_at = NULL, case_order_id = NULL, case_prev_status = NULL, updated_at = now() WHERE id = $1 RETURNING status",
  eventMark: "INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role) VALUES ($1, $2, $3, $4, 'mark', $5, $6, $7)",
  eventRemove: "INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role) VALUES ($1, $2, $3, $4, 'remove', $5, $6, $7)",
};
// Chikki's own Ship again mark, the red flag and their reads (case-auto.ts, owner 2026-10-02): exact.
const AUTO_SQL = {
  state: norm(`SELECT c.site_id, c.customer_key, c.status, c.verified_order_id, c.verified_via, c.case_kind, c.case_marked_by,
       c.case_marked_at, c.merged_into,
       EXISTS (SELECT 1 FROM chat_case_events e
                WHERE e.conversation_id = c.id AND e.kind = 'reship' AND e.action = 'remove') AS reship_removed,
       r.id AS other_reship_id, r.status AS other_reship_status
  FROM conversations c
  LEFT JOIN LATERAL (
    SELECT o.id, o.status FROM conversations o
     WHERE o.site_id = c.site_id AND o.id <> c.id AND o.merged_into IS NULL
       AND o.case_kind = 'reship' AND o.case_order_id = c.verified_order_id
     ORDER BY o.case_marked_at DESC LIMIT 1) r ON true
 WHERE c.id = $1`),
  mark: norm(`UPDATE conversations
          SET case_prev_status = CASE WHEN status = 'agent_handling' THEN 'agent_handling' ELSE 'human_needed' END,
              case_kind = 'reship', case_marked_by = $2, case_marked_at = now(), case_order_id = $3,
              status = CASE WHEN $4::boolean AND status = 'human_needed' THEN 'human_needed' ELSE 'agent_handling' END,
              auto_closed_at = NULL,
              updated_at = now()
        WHERE id = $1 AND case_kind IS NULL
        RETURNING status`),
  // "Complained first, verified next": this conversation's own last messages (since the chat before
  // the merge was opened, last 24 hours), never an older merged chat's history.
  earlier: norm(`SELECT m.content FROM messages m
      WHERE m.conversation_id = $1 AND m.sender = 'visitor' AND m.deleted_at IS NULL
        AND COALESCE(m.metadata->>'hidden', 'false') <> 'true' AND btrim(m.content) <> ''
        AND m.created_at >= (SELECT s.created_at FROM conversations s WHERE s.id = $2)
        AND m.created_at > now() - interval '24 hours'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 4`),
  age: 'SELECT case_marked_by, (extract(epoch FROM now() - case_marked_at) * 1000)::float8 AS age_ms FROM conversations WHERE id = $1',
  red: "UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1 AND case_kind = 'reship' AND status = 'agent_handling'",
  // reminded (review fix, 2026-10-02): the one reminder, whatever language it went out in.
  reship: norm(`SELECT c.status, c.case_marked_at,
       (SELECT e.actor_role FROM chat_case_events e
         WHERE e.conversation_id = c.id AND e.kind = 'reship' AND e.action = 'mark'
         ORDER BY e.created_at DESC LIMIT 1) AS mark_role,
       EXISTS (SELECT 1 FROM messages m
                WHERE m.conversation_id = c.id AND m.sender = 'agent' AND m.deleted_at IS NULL
                  AND m.created_at > c.case_marked_at) AS team_wrote,
       EXISTS (SELECT 1 FROM messages m
                WHERE m.conversation_id = c.id AND m.sender = 'ai' AND m.deleted_at IS NULL
                  AND m.created_at >= c.case_marked_at AND m.content ILIKE ANY ($2::text[])) AS reminded
  FROM conversations c WHERE c.id = $1 AND c.case_kind = 'reship'`),
};
// Chikki's own Refund mark for a chargeback / court / police threat on a late order (case-auto.ts, owner
// 2026-10-02 18:45): exact, like the Ship again ones.
const REFUND_SQL = {
  state: norm(`SELECT c.site_id, c.customer_key, c.status, c.source, c.verified_order_id, c.verified_via, c.case_kind, c.merged_into,
       s.tracker_business_id,
       EXISTS (SELECT 1 FROM chat_case_events e
                WHERE e.conversation_id = c.id AND e.kind = 'refund' AND e.action = 'remove') AS refund_removed,
       r.id AS other_refund_id
  FROM conversations c
  JOIN sites s ON s.id = c.site_id
  LEFT JOIN LATERAL (
    SELECT o.id FROM conversations o
     WHERE o.site_id = c.site_id AND o.id <> c.id AND o.merged_into IS NULL
       AND o.case_kind = 'refund' AND o.case_order_id = c.verified_order_id
     ORDER BY o.case_marked_at DESC LIMIT 1) r ON true
 WHERE c.id = $1`),
  mark: norm(`UPDATE conversations
          SET case_prev_status = CASE WHEN status = 'agent_handling' THEN 'agent_handling' ELSE 'human_needed' END,
              case_kind = 'refund', case_marked_by = $2, case_marked_at = now(), case_order_id = $3,
              status = CASE WHEN $4::boolean AND status = 'human_needed' THEN 'human_needed' ELSE 'agent_handling' END,
              auto_closed_at = NULL,
              updated_at = now()
        WHERE id = $1 AND case_kind IS NULL
        RETURNING status`),
  switch: norm(`UPDATE conversations
          SET case_prev_status = CASE WHEN case_prev_status = 'agent_handling' THEN 'agent_handling' ELSE 'human_needed' END,
              case_kind = 'refund', case_marked_by = $2, case_marked_at = now(), case_order_id = $3,
              status = CASE WHEN $4::boolean AND status = 'human_needed' THEN 'human_needed' ELSE 'agent_handling' END,
              auto_closed_at = NULL,
              updated_at = now()
        WHERE id = $1 AND case_kind = 'reship'
        RETURNING status`),
  follow: norm(`SELECT c.status, c.case_marked_at, c.case_marked_by,
       (SELECT e.actor_role FROM chat_case_events e
         WHERE e.conversation_id = c.id AND e.kind = 'refund' AND e.action = 'mark'
         ORDER BY e.created_at DESC LIMIT 1) AS mark_role,
       EXISTS (SELECT 1 FROM messages m
                WHERE m.conversation_id = c.id AND m.sender IN ('agent', 'system') AND m.deleted_at IS NULL
                  AND m.created_at > c.case_marked_at) AS team_wrote,
       EXISTS (SELECT 1 FROM messages m
                WHERE m.conversation_id = c.id AND m.sender = 'ai' AND m.deleted_at IS NULL
                  AND m.created_at >= c.case_marked_at AND m.content ILIKE ANY ($2::text[])) AS reminded
  FROM conversations c WHERE c.id = $1 AND c.case_kind = 'refund'`),
  // The one-time move: the customer's own messages of the last N days, newest first.
  said: norm(`SELECT m.content FROM messages m
      WHERE m.conversation_id = $1 AND m.sender = 'visitor' AND m.deleted_at IS NULL
        AND COALESCE(m.metadata->>'hidden', 'false') <> 'true' AND btrim(m.content) <> ''
        AND m.created_at > now() - make_interval(days => $2::int)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 100`),
};
// A red Ship again chat is also in Needs you and the lists (conversations/route.ts OUTSIDE_SECTION).
const OUTSIDE_SECTION = "(c.case_kind IS NULL OR (c.case_kind = 'reship' AND c.status = 'human_needed'))";

async function handle(q, p, tx) {
  let m;
  // ── Transactions ──
  if (q === 'BEGIN') return rows([]);
  if (q === 'COMMIT') {
    if (tx.aborted) throw new Error('fake db: COMMIT of an aborted transaction (an error inside it was swallowed)');
    tx.open = false; releaseLocks(tx); return rows([]);
  }
  if (q === 'ROLLBACK') { while (tx.undo.length) tx.undo.pop()(); tx.open = false; releaseLocks(tx); return rows([]); }
  if ((m = q.match(/^SAVEPOINT (\w+)$/))) { need(tx, q); tx.sp.set(m[1], tx.undo.length); return rows([]); }
  if ((m = q.match(/^RELEASE SAVEPOINT (\w+)$/))) { tx.sp.delete(m[1]); return rows([]); }
  if ((m = q.match(/^ROLLBACK TO SAVEPOINT (\w+)$/))) {
    const mark = tx.sp.get(m[1]);
    if (mark === undefined) throw new Error('fake db: no savepoint ' + m[1]);
    while (tx.undo.length > mark) tx.undo.pop()();
    tx.aborted = false; return rows([]);
  }
  if ((m = q.match(/^SET LOCAL lock_timeout = '(\d+)s'$/))) { need(tx, q); tx.lockTimeoutMs = Number(m[1]) * 1000 * SCALE; return rows([]); }
  if (q === "SELECT set_config('shiptrack.actor', $1, true), set_config('shiptrack.actor_name', $2, true), set_config('shiptrack.reason', $3, true)") {
    need(tx, q); tx.actor = { key: p[0], name: p[1], reason: p[2] }; return rows([{}]);
  }

  // ── Logins and presence (src/lib/auth.ts) ──
  if (q === 'SELECT id, username, display_name, role, is_active, business_ids, permissions, session_version FROM team_users') {
    if (db.teamGate) await db.teamGate;
    return rows(clone(db.team));
  }
  if (q === 'SELECT username, password_hash, session_version, updated_at FROM admin_login WHERE id = 1') return rows(db.admin ? [clone(db.admin)] : []);
  if (q === 'INSERT INTO staff_presence (actor, last_seen_at) SELECT * FROM unnest($1::text[], $2::timestamptz[]) ON CONFLICT (actor) DO UPDATE SET last_seen_at = GREATEST(staff_presence.last_seen_at, EXCLUDED.last_seen_at)') {
    if (db.presenceMissing) throw pgErr('42P01', 'relation "staff_presence" does not exist');
    p[0].forEach((actor, i) => {
      const row = db.presence.find((x) => x.actor === actor);
      if (!row) db.presence.push({ actor, last_seen_at: p[1][i] });
      else if (Date.parse(p[1][i]) > Date.parse(row.last_seen_at)) row.last_seen_at = p[1][i];
    });
    return rows([]);
  }
  if (q === 'SELECT actor, last_seen_at FROM staff_presence') {
    if (db.presenceMissing) throw pgErr('42P01', 'relation "staff_presence" does not exist');
    return rows(clone(db.presence));
  }

  // ── The chat team's locks and events (src/lib/chat/team-routing.ts) ──
  if (q === "SELECT c.id, c.site_id, c.status, c.assigned_to, c.case_kind, c.case_order_id, c.merged_into, c.verified_order_id, c.phone_match_order_id, c.customer_key, c.source FROM conversations c WHERE c.id = $1 OR ($2::text IS NOT NULL AND c.source = 'chat' AND c.site_id = $3 AND c.customer_key = $2 AND c.merged_into IS NULL AND c.status <> 'resolved') ORDER BY c.id FOR NO KEY UPDATE") {
    need(tx, q);
    if (tx.lockTimeoutMs == null) throw new Error('fake db: a chat lock taken before SET LOCAL lock_timeout');
    const [id, key, siteId] = p;
    const match = (c) => c.id === id || (key != null && c.source === 'chat' && c.site_id === siteId && c.customer_key === key && !c.merged_into && c.status !== 'resolved');
    const ids = db.convs.filter(match).map((c) => c.id).sort();
    for (const x of ids) await lockRow(tx, x);
    return rows(db.convs.filter((c) => ids.includes(c.id) && match(c)).sort(byId).map((c) => pick(c, LOCK_COLS)));
  }
  if (q === WAITING_Q) { db.waitingAsked.push(p[0]); return rows(conv(p[0]) ? [{ w: !!db.waiting[p[0]] }] : []); }
  if (q === 'INSERT INTO chat_events (conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner, from_status, to_status, reason, note, message_id, meta) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)') {
    if (db.eventsBroken) throw pgErr('42501', 'permission denied for table chat_events');
    const [conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner, from_status, to_status, reason, note, message_id, meta] = p;
    if (note != null && (Array.from(note).length < 3 || Array.from(note).length > 200)) throw pgErr('23514', 'chat_events_note_check');
    add(tx, db.events, { id: ++seq, conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner, from_status, to_status, reason, note, message_id, meta: meta == null ? null : JSON.parse(meta) });
    return rows([]);
  }
  if (q === 'UPDATE conversations SET assigned_to = $1, assigned_at = now() WHERE id = ANY($2::text[])') {
    need(tx, q);
    for (const id of p[1]) setRow(tx, await rowFor(tx, id), { assigned_to: p[0], assigned_at: nowIso() });
    return rows([]);
  }

  // ── Reply (/api/chat/messages) ──
  if (q === 'SELECT c.id, c.source, s.tracker_business_id, c.site_id, c.customer_key FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = $1') {
    const c = conv(p[0]);
    return rows(c ? [{ id: c.id, source: c.source, tracker_business_id: siteOf(c.site_id).panel, site_id: c.site_id, customer_key: c.customer_key }] : []);
  }
  if (q === 'SELECT id, file_name, mime_type, size_bytes, kind FROM chat_attachments WHERE id = ANY($1::text[]) AND conversation_id = $2 AND message_id IS NULL FOR UPDATE') {
    need(tx, q);
    return rows(db.attachments.filter((a) => p[0].includes(a.id) && a.conversation_id === p[1] && !a.message_id).map((a) => pick(a, ['id', 'file_name', 'mime_type', 'size_bytes', 'kind'])));
  }
  if (q === 'UPDATE chat_attachments SET message_id = $1 WHERE id = ANY($2::text[])') {
    for (const a of db.attachments) if (p[1].includes(a.id)) setRow(tx, a, { message_id: p[0] });
    return rows([]);
  }
  if (q === "INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at) VALUES (gen_random_uuid()::text, $1, 'agent', $2, $3::jsonb, now()) RETURNING id, sender, content, metadata, created_at") {
    need(tx, q);
    const msg = { id: 'msg-' + (++seq), conversation_id: p[0], sender: 'agent', content: p[1], metadata: JSON.parse(p[2]), created_at: nowIso(), deleted_at: null, edited_at: null };
    add(tx, db.messages, msg);
    return rows([pick(msg, ['id', 'sender', 'content', 'metadata', 'created_at'])]);
  }
  if (q === "UPDATE conversations SET status = 'agent_handling', last_message_at = now(), auto_closed_at = NULL, updated_at = now(), assigned_to = CASE WHEN $2::boolean THEN $3::text ELSE assigned_to END, assigned_at = CASE WHEN $2::boolean THEN now() ELSE assigned_at END WHERE id = $1") {
    need(tx, q);
    const c = await rowFor(tx, p[0]);
    setRow(tx, c, { status: 'agent_handling', last_message_at: nowIso(), auto_closed_at: null, ...(p[1] ? { assigned_to: p[2], assigned_at: nowIso() } : {}) });
    return rows([]);
  }
  if (q === "UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('emailed', $2::boolean) WHERE id = $1") {
    const msg = db.messages.find((x) => x.id === p[0]); if (msg) msg.metadata = { ...(msg.metadata || {}), emailed: p[1] };
    return rows([]);
  }

  // ── The thread (/api/chat/conversations/[id]) ──
  if (/^SELECT c\.id, c\.site_id, c\.visitor_name, .* FROM conversations c JOIN sites s ON s\.id = c\.site_id LEFT JOIN businesses b .* WHERE c\.id = \$1$/.test(q)) {
    const c = conv(p[0]);
    if (!c) return rows([]);
    const s = siteOf(c.site_id);
    const r = { ...clone(c), display_name: c.visitor_name, name_from_order: false, site_name: s.name, tracker_business_id: s.panel, panel_name: 'Panel ' + s.panel };
    // Only the columns the SELECT names (an older SELECT without them gives undefined).
    for (const col of ['assigned_to', 'assigned_at', 'merged_into']) if (!q.includes('c.' + col)) delete r[col];
    return rows([r]);
  }
  if (/^SELECT id, sender, content, metadata, created_at, edited_at, edited_by, deleted_at, deleted_by, \(SELECT u\.notes FROM brain_usage u WHERE u\.message_id = messages\.id\) AS brain FROM messages WHERE conversation_id = \$1 AND /.test(q)) {
    return rows(db.messages.filter((x) => x.conversation_id === p[0] && x.sender !== 'tool_result' && !(x.metadata && x.metadata.hidden))
      .map((x) => ({ ...pick(x, ['id', 'sender', 'content', 'metadata', 'created_at', 'edited_at', 'edited_by', 'deleted_at', 'deleted_by']), brain: null })));
  }
  if (/^WITH older AS \( SELECT c\.id, c\.created_at, c\.status, /.test(q)) {
    // The same customer's other chats on the site, with their messages (enough for the authors).
    const [siteId, key, id] = p;
    const others = db.convs.filter((c) => c.site_id === siteId && c.customer_key === key && c.source === 'chat' && c.id !== id && c.older);
    const out = [];
    for (const o of others) {
      const msgs = db.messages.filter((x) => x.conversation_id === o.id);
      for (const x of msgs.length ? msgs : [null]) {
        out.push({ conversation_id: o.id, conv_created_at: o.created_at, conv_status: o.status, older_total: others.length,
          ...(x ? pick(x, ['id', 'sender', 'content', 'metadata', 'created_at', 'edited_at', 'edited_by', 'deleted_at', 'deleted_by']) : { id: null }) });
      }
    }
    return rows(out);
  }
  if (/^SELECT c\.id AS conversation_id, c\.created_at, c\.last_message_at, c\.status FROM conversations c /.test(q)) return rows([]);
  if (q === 'UPDATE conversations SET unread_count = 0, updated_at = now() WHERE id = $1') { const c = conv(p[0]); if (c) c.unread_count = 0; return rows([]); }
  if (q === 'UPDATE conversations SET unread_count = 0, updated_at = now() WHERE id = ANY($1::text[]) AND unread_count > 0') { for (const c of db.convs) if (p[0].includes(c.id)) c.unread_count = 0; return rows([]); }
  if (q === "SELECT id, created_at, kind, actor, actor_name, from_owner, to_owner, reason, note FROM chat_events WHERE conversation_id = $1 AND kind IN ('claim','take','transfer','inherit','merge') ORDER BY id DESC LIMIT 10") {
    return rows(db.events.filter((e) => e.conversation_id === p[0] && ['claim', 'take', 'transfer', 'inherit', 'merge'].includes(e.kind))
      .sort((a, b) => b.id - a.id).slice(0, 10).map((e) => pick(e, ['id', 'created_at', 'kind', 'actor', 'actor_name', 'from_owner', 'to_owner', 'reason', 'note'])));
  }
  // Who wrote each staff reply: its 'reply' event (the writer's key and their name then).
  if (q === "SELECT DISTINCT ON (message_id) message_id, actor, actor_name FROM chat_events WHERE kind = 'reply' AND message_id = ANY($1::text[]) ORDER BY message_id, id") {
    const out = new Map();
    for (const e of [...db.events].sort((a, b) => a.id - b.id)) {
      if (e.kind === 'reply' && e.message_id && p[0].includes(e.message_id) && !out.has(e.message_id)) out.set(e.message_id, pick(e, ['message_id', 'actor', 'actor_name']));
    }
    return rows([...out.values()]);
  }
  // Take over / Take from X / Hand to AI / Close
  if (q === "UPDATE conversations SET status = $1, unread_count = CASE WHEN $1 = 'resolved' THEN 0 ELSE unread_count END, closed_by_name = CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN $3::text ELSE closed_by_name END, closed_at = CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN now() ELSE closed_at END, auto_closed_at = CASE WHEN $1 = 'resolved' AND status = 'resolved' THEN auto_closed_at ELSE NULL END, assigned_to = CASE WHEN $4::text IS NOT NULL THEN $4::text ELSE assigned_to END, assigned_at = CASE WHEN $4::text IS NOT NULL THEN now() ELSE assigned_at END, updated_at = now() WHERE id = $2 RETURNING status, closed_by_name, closed_at, auto_closed_at, assigned_to") {
    need(tx, q);
    const c = await rowFor(tx, p[1]);
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
    const c = await rowFor(tx, p[0]);
    setRow(tx, c, { assigned_to: p[1], assigned_at: p[1] == null ? null : nowIso(), status: p[2], auto_closed_at: null });
    return rows([pick(c, ['status', 'assigned_to'])]);
  }
  if (q === 'UPDATE conversations SET assigned_to = $1::text, assigned_at = CASE WHEN $1::text IS NULL THEN NULL ELSE now() END WHERE id = ANY($2::text[])') {
    need(tx, q);
    for (const id of p[1]) setRow(tx, await rowFor(tx, id), { assigned_to: p[0], assigned_at: p[0] == null ? null : nowIso() });
    return rows([]);
  }
  // Refund / Ship again (byte-identical to before)
  if (q === OLD_CASE_SQL.mark) {
    need(tx, q);
    const c = await rowFor(tx, p[0]);
    setRow(tx, c, {
      case_prev_status: c.case_kind == null ? c.status : c.case_prev_status, case_kind: p[1], case_marked_by: p[2], case_marked_at: nowIso(), case_order_id: p[3],
      status: c.status === 'resolved' ? c.status : 'agent_handling', auto_closed_at: null,
    });
    return rows([pick(c, ['case_kind', 'case_marked_by', 'case_marked_at', 'case_order_id', 'status'])]);
  }
  if (q === OLD_CASE_SQL.remove) {
    need(tx, q);
    const c = await rowFor(tx, p[0]);
    setRow(tx, c, { status: c.status === 'resolved' ? c.status : (c.case_prev_status || 'agent_handling'), case_kind: null, case_marked_by: null, case_marked_at: null, case_order_id: null, case_prev_status: null });
    return rows([pick(c, ['status'])]);
  }
  if (q === OLD_CASE_SQL.eventMark || q === OLD_CASE_SQL.eventRemove) {
    need(tx, q);
    add(tx, db.caseEvents, { id: p[0], conversation_id: p[1], site_id: p[2], kind: p[3], action: q === OLD_CASE_SQL.eventMark ? 'mark' : 'remove', order_id: p[4], actor: p[5], actor_role: p[6] });
    return rows([]);
  }

  // ── Chikki's own Ship again and the red flag (case-auto.ts, owner 2026-10-02) ──
  if (q === AUTO_SQL.state) {
    const c = conv(p[0]);
    if (!c) return rows([]);
    const other = db.convs
      .filter((o) => o.site_id === c.site_id && o.id !== c.id && !o.merged_into && o.case_kind === 'reship' && c.verified_order_id != null && o.case_order_id === c.verified_order_id)
      .sort((a, b) => Date.parse(b.case_marked_at || 0) - Date.parse(a.case_marked_at || 0))[0];
    return rows([{
      ...pick(c, ['site_id', 'customer_key', 'status', 'verified_order_id', 'verified_via', 'case_kind', 'case_marked_by', 'case_marked_at', 'merged_into']),
      reship_removed: db.caseEvents.some((e) => e.conversation_id === c.id && e.kind === 'reship' && e.action === 'remove'),
      other_reship_id: other ? other.id : null, other_reship_status: other ? other.status : null,
    }]);
  }
  if (q === AUTO_SQL.mark) {
    need(tx, q);
    const c = await rowFor(tx, p[0]);
    if (!c || c.case_kind != null) return rows([]);
    if (typeof p[3] !== 'boolean') throw new Error('fake db: the Ship again mark needs $4 (keep Needs you) as a boolean');
    setRow(tx, c, {
      case_prev_status: c.status === 'agent_handling' ? 'agent_handling' : 'human_needed', case_kind: 'reship', case_marked_by: p[1],
      case_marked_at: nowIso(), case_order_id: p[2], status: p[3] && c.status === 'human_needed' ? 'human_needed' : 'agent_handling', auto_closed_at: null,
    });
    return rows([{ status: c.status }]);
  }
  if (q === AUTO_SQL.earlier) {
    const from = conv(p[1]);
    if (!from) return rows([]);
    const since = Date.parse(from.created_at), floor = clock - 24 * 3600_000;
    const hits = db.messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.conversation_id === p[0] && m.sender === 'visitor' && !m.deleted_at && !(m.metadata && m.metadata.hidden)
        && String(m.content || '').trim() !== '' && Date.parse(m.created_at) >= since && Date.parse(m.created_at) > floor)
      .sort((a, b) => Date.parse(b.m.created_at) - Date.parse(a.m.created_at) || b.i - a.i);
    return rows(hits.slice(0, 4).map(({ m }) => ({ content: m.content })));
  }
  if (q === AUTO_SQL.age) {
    need(tx, q);
    const c = conv(p[0]);
    return rows(c ? [{ case_marked_by: c.case_marked_by, age_ms: c.case_marked_at ? clock - Date.parse(c.case_marked_at) : null }] : []);
  }
  if (q === AUTO_SQL.red) {
    need(tx, q);
    if (tx.lockTimeoutMs == null) throw new Error('fake db: the red flag locks before SET LOCAL lock_timeout');
    const c = await rowFor(tx, p[0]);
    if (!c || c.case_kind !== 'reship' || c.status !== 'agent_handling') return rows([]);
    setRow(tx, c, { status: 'human_needed' });
    return { rows: [], rowCount: 1 };
  }
  if (q === AUTO_SQL.reship) {
    const c = conv(p[0]);
    if (!c || c.case_kind !== 'reship') return rows([]);
    const marks = db.caseEvents.filter((e) => e.conversation_id === c.id && e.kind === 'reship' && e.action === 'mark');
    const markedAt = Date.parse(c.case_marked_at);
    // ILIKE '%text%' only (the reminder's first words): anything else is a test failure.
    if (!Array.isArray(p[1]) || !p[1].length || !p[1].every((x) => /^%[^%_]+%$/.test(x))) throw new Error('fake db: reminded wants [\'%text%\', ...]');
    const ilike = (s) => p[1].some((x) => String(s || '').toLowerCase().includes(x.slice(1, -1).toLowerCase()));
    return rows([{
      status: c.status, case_marked_at: c.case_marked_at, mark_role: marks.length ? marks[marks.length - 1].actor_role : null,
      team_wrote: db.messages.some((m) => m.conversation_id === c.id && m.sender === 'agent' && !m.deleted_at && Date.parse(m.created_at) > markedAt),
      reminded: db.messages.some((m) => m.conversation_id === c.id && m.sender === 'ai' && !m.deleted_at && Date.parse(m.created_at) >= markedAt && ilike(m.content)),
    }]);
  }
  // ── Chikki's own Refund mark (case-auto.ts, owner 2026-10-02 18:45) ──
  if (q === REFUND_SQL.state) {
    const c = conv(p[0]);
    if (!c) return rows([]);
    const other = db.convs
      .filter((o) => o.site_id === c.site_id && o.id !== c.id && !o.merged_into && o.case_kind === 'refund' && c.verified_order_id != null && o.case_order_id === c.verified_order_id)
      .sort((a, b) => Date.parse(b.case_marked_at || 0) - Date.parse(a.case_marked_at || 0))[0];
    return rows([{
      ...pick(c, ['site_id', 'customer_key', 'status', 'source', 'verified_order_id', 'verified_via', 'case_kind', 'merged_into']),
      tracker_business_id: siteOf(c.site_id).panel,
      refund_removed: db.caseEvents.some((e) => e.conversation_id === c.id && e.kind === 'refund' && e.action === 'remove'),
      other_refund_id: other ? other.id : null,
    }]);
  }
  if (q === REFUND_SQL.mark || q === REFUND_SQL.switch) {
    need(tx, q);
    const c = await rowFor(tx, p[0]);
    const sw = q === REFUND_SQL.switch;
    if (!c || (sw ? c.case_kind !== 'reship' : c.case_kind != null)) return rows([]);
    if (typeof p[3] !== 'boolean') throw new Error('fake db: the Refund mark needs $4 (keep Needs you) as a boolean');
    setRow(tx, c, {
      case_prev_status: sw ? (c.case_prev_status === 'agent_handling' ? 'agent_handling' : 'human_needed') : (c.status === 'agent_handling' ? 'agent_handling' : 'human_needed'),
      case_kind: 'refund', case_marked_by: p[1], case_marked_at: nowIso(), case_order_id: p[2],
      status: p[3] && c.status === 'human_needed' ? 'human_needed' : 'agent_handling', auto_closed_at: null,
    });
    return { rows: [{ status: c.status }], rowCount: 1 };
  }
  if (q === REFUND_SQL.follow) {
    const c = conv(p[0]);
    if (!c || c.case_kind !== 'refund') return rows([]);
    const marks = db.caseEvents.filter((e) => e.conversation_id === c.id && e.kind === 'refund' && e.action === 'mark');
    const markedAt = Date.parse(c.case_marked_at);
    if (!Array.isArray(p[1]) || !p[1].length || !p[1].every((x) => /^%[^%_]+%$/.test(x))) throw new Error('fake db: reminded wants [\'%text%\', ...]');
    const ilike = (s) => p[1].some((x) => String(s || '').toLowerCase().includes(x.slice(1, -1).toLowerCase()));
    return rows([{
      status: c.status, case_marked_at: c.case_marked_at, case_marked_by: c.case_marked_by,
      mark_role: marks.length ? marks[marks.length - 1].actor_role : null,
      team_wrote: db.messages.some((m) => m.conversation_id === c.id && ['agent', 'system'].includes(m.sender) && !m.deleted_at && Date.parse(m.created_at) > markedAt),
      reminded: db.messages.some((m) => m.conversation_id === c.id && m.sender === 'ai' && !m.deleted_at && Date.parse(m.created_at) >= markedAt && ilike(m.content)),
    }]);
  }
  if (q === REFUND_SQL.said) {
    if (!Number.isInteger(p[1])) throw new Error('fake db: the days must be a whole number');
    const floor = clock - p[1] * 86400_000;
    return rows(db.messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.conversation_id === p[0] && m.sender === 'visitor' && !m.deleted_at && !(m.metadata && m.metadata.hidden)
        && String(m.content || '').trim() !== '' && Date.parse(m.created_at) > floor)
      .sort((a, b) => Date.parse(b.m.created_at) - Date.parse(a.m.created_at) || b.i - a.i)
      .slice(0, 100).map(({ m }) => ({ content: m.content })));
  }
  // The sidebar's Needs you badge (/api/chat/pending): counted by the case condition the route sends.
  if (/^SELECT count\(DISTINCT CASE WHEN c\.customer_key IS NOT NULL AND c\.source = 'chat' THEN 'k:' \|\| c\.site_id \|\| ':' \|\| c\.customer_key ELSE 'c:' \|\| c\.id END\) AS human_needed, /.test(q)) {
    let caseOk;
    if (q.includes("c.status = 'human_needed' AND (c.case_kind IS NULL OR c.case_kind = 'reship')")) caseOk = (c) => c.case_kind == null || c.case_kind === 'reship';
    else if (q.includes("c.status = 'human_needed' AND c.case_kind IS NULL")) caseOk = (c) => c.case_kind == null;
    else throw new Error('fake db: the pending count without its case condition');
    const hits = db.convs.filter((c) => c.status === 'human_needed' && !c.merged_into && caseOk(c));
    db.pending = { sql: q, params: p, ids: hits.map((c) => c.id) };
    const keys = new Set(hits.map((c) => (c.customer_key && c.source === 'chat' ? `k:${c.site_id}:${c.customer_key}` : 'c:' + c.id)));
    return rows([{ human_needed: String(keys.size), email_waiting: String(hits.filter((c) => c.source === 'email').length) }]);
  }

  // ── The Super Admin's release (/api/chat/team/release) ──
  if (q === "SELECT id, site_id, status FROM conversations WHERE assigned_to = $1 AND status <> 'resolved' AND merged_into IS NULL ORDER BY id FOR NO KEY UPDATE") {
    need(tx, q);
    if (tx.lockTimeoutMs == null) throw new Error('fake db: release locks before SET LOCAL lock_timeout');
    const match = (c) => c.assigned_to === p[0] && c.status !== 'resolved' && !c.merged_into;
    const ids = db.convs.filter(match).map((c) => c.id).sort();
    for (const id of ids) await lockRow(tx, id);
    return rows(db.convs.filter((c) => ids.includes(c.id) && match(c)).sort(byId).map((c) => pick(c, ['id', 'site_id', 'status'])));
  }
  if (q === 'UPDATE conversations SET assigned_to = NULL, assigned_at = NULL WHERE id = ANY($1::text[])') {
    need(tx, q);
    for (const id of p[0]) setRow(tx, await rowFor(tx, id), { assigned_to: null, assigned_at: null });
    return rows([]);
  }
  if (q === "INSERT INTO chat_events (conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner, from_status, to_status, reason, note, meta) SELECT x.id, x.site_id, 'transfer', $4, $5, $4, NULL, x.status, x.status, 'transfer', $6, $7::jsonb FROM unnest($1::text[], $2::text[], $3::text[]) AS x(id, site_id, status)") {
    need(tx, q);
    if (db.eventsBroken) throw pgErr('42501', 'permission denied for table chat_events');
    p[0].forEach((id, i) => add(tx, db.events, {
      id: ++seq, conversation_id: id, site_id: p[1][i], kind: 'transfer', actor: p[3], actor_name: p[4], from_owner: p[3], to_owner: null,
      from_status: p[2][i], to_status: p[2][i], reason: 'transfer', note: p[5], message_id: null, meta: JSON.parse(p[6]),
    }));
    return rows([]);
  }

  // ── The inbox list (/api/chat/conversations) ──
  if (/^SELECT count\(DISTINCT x\.gk\) FILTER .* FROM \(SELECT c\.subject_label, c\.health_score, c\.health_signals, /.test(q)) return rows([{}]);
  if (/^SELECT count\(DISTINCT x\.gk\) FILTER \(WHERE x\.waiting_since IS NOT NULL\)::int AS n, /.test(q)) {
    db.list = { ...(db.list || {}), unansweredSql: q, unansweredParams: p };
    return rows([{ ...db.unanswered }]);
  }
  if (/^WITH .*base AS \( SELECT c\.id, c\.visitor_name, /.test(q)) { db.list = { ...(db.list || {}), sql: q, params: p }; return rows([]); }
  if (/^SELECT c\.case_kind, count\(\*\)::int AS total, /.test(q)) return rows([]);
  // The Super Admin's "Give all N": exactly the release's WHERE.
  if (q === "SELECT count(*)::int AS n FROM conversations WHERE assigned_to = $1 AND status <> 'resolved' AND merged_into IS NULL") {
    db.list = { ...(db.list || {}), heldParams: p };
    return rows([{ n: db.convs.filter((c) => c.assigned_to === p[0] && c.status !== 'resolved' && !c.merged_into).length }]);
  }
  if (/^SELECT COALESCE\(c\.case_marked_by, '\?'\) AS marked_by, /.test(q)) return rows([]);

  // ── The widget (/api/widget/messages/[id], /api/widget/message) ──
  if (q === 'SELECT id, name, ai_enabled, system_prompt, tracker_business_id, cod_available FROM sites WHERE widget_key = $1') {
    const s = db.sites.find((x) => x.widget_key === p[0]);
    return rows(s ? [{ id: s.id, name: s.name, ai_enabled: s.ai_enabled, system_prompt: s.system_prompt, tracker_business_id: s.panel, cod_available: s.cod_available }] : []);
  }
  if (q === 'SELECT id, site_id, status, merged_into FROM conversations WHERE id = $1 AND site_id = $2') {
    const c = conv(p[0]);
    return rows(c && c.site_id === p[1] ? [pick(c, ['id', 'site_id', 'status', 'merged_into'])] : []);
  }
  if ((m = q.match(/^SELECT id, conversation_id, sender, CASE WHEN deleted_at IS NULL THEN content ELSE '' END AS content, CASE WHEN deleted_at IS NULL THEN (metadata(?: - 'agent')?) END AS metadata, created_at, edited_at, \(deleted_at IS NOT NULL\) AS deleted, GREATEST\(created_at, edited_at, deleted_at\) AS changed_at FROM messages WHERE conversation_id = \$1 AND (.*) ORDER BY created_at ASC$/))) {
    const stripAgent = m[1] !== 'metadata';
    const visibleOnly = / AND deleted_at IS NULL/.test(m[2]);
    return rows(db.messages
      .filter((x) => x.conversation_id === p[0] && x.sender !== 'tool_result' && !(x.metadata && x.metadata.hidden) && x.content && x.content.trim())
      .filter((x) => !visibleOnly || !x.deleted_at)
      .map((x) => {
        let meta = null;
        if (!x.deleted_at && x.metadata) { meta = clone(x.metadata); if (stripAgent) delete meta.agent; }
        return { id: x.id, conversation_id: x.conversation_id, sender: x.sender, content: x.deleted_at ? '' : x.content, metadata: meta,
          created_at: x.created_at, edited_at: x.edited_at || null, deleted: !!x.deleted_at, changed_at: x.deleted_at || x.created_at };
      }));
  }
  if (q === "INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at) VALUES (gen_random_uuid()::text, $1, 'visitor', $2, $3::jsonb, now()) RETURNING id, conversation_id, sender, content, metadata, created_at") {
    const msg = { id: 'msg-' + (++seq), conversation_id: p[0], sender: 'visitor', content: p[1], metadata: p[2] == null ? null : JSON.parse(p[2]), created_at: nowIso() };
    db.messages.push(msg);
    return rows([clone(msg)]);
  }
  if (/^UPDATE conversations SET unread_count = unread_count \+ 1, last_message_at = now\(\), updated_at = now\(\), status = CASE WHEN status = 'resolved' AND source = 'chat' /.test(q)) {
    const c = conv(p[0]);
    if (c.status === 'resolved' && c.source === 'chat') setRow(null, c, { status: c.case_kind ? 'agent_handling' : p[1] ? 'ai_handling' : 'human_needed' });
    c.unread_count = (c.unread_count || 0) + 1;
    return rows([{ status: c.status, case_kind: c.case_kind }]);
  }
  if (q === 'SELECT (verified_order_id IS NOT NULL OR phone_match_order_id IS NOT NULL) AS v FROM conversations WHERE id = $1') {
    const c = conv(p[0]); return rows(c ? [{ v: !!(c.verified_order_id || c.phone_match_order_id) }] : []);
  }
  if (q === 'SELECT id, site_id, status, unread_count, visitor_id, visitor_name, verified_order_id, verified_via, customer_key, source, merged_into FROM conversations WHERE id = $1') {
    const c = conv(p[0]); return rows(c ? [pick(c, ['id', 'site_id', 'status', 'unread_count', 'visitor_id', 'visitor_name', 'verified_order_id', 'verified_via', 'customer_key', 'source', 'merged_into'])] : []);
  }
  if (/^SELECT content FROM messages WHERE conversation_id = \$1 AND sender = 'ai' AND deleted_at IS NULL /.test(q)) {
    return rows(db.messages.filter((x) => x.conversation_id === p[0] && x.sender === 'ai').reverse().slice(0, 3).map((x) => ({ content: x.content })));
  }
  if (q === "UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1 AND status = 'ai_handling'") {
    const c = conv(p[0]); if (c && c.status === 'ai_handling') setRow(null, c, { status: 'human_needed' });
    return rows([]);
  }
  if (q === "INSERT INTO messages (id, conversation_id, sender, content, created_at) VALUES (gen_random_uuid()::text, $1, 'ai', $2, now()) RETURNING id, conversation_id, sender, content, metadata, created_at") {
    const msg = { id: 'msg-' + (++seq), conversation_id: p[0], sender: 'ai', content: p[1], metadata: null, created_at: nowIso() };
    db.messages.push(msg);
    return rows([clone(msg)]);
  }
  if (q === 'UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1') { const c = conv(p[0]); if (c) c.last_message_at = nowIso(); return rows([]); }

  // ── Merging two chats of one customer (merge-chats.ts) ──
  if (q === 'SELECT to_regclass($1) IS NOT NULL AS ok') return rows([{ ok: true }]);
  if (q === "SELECT id FROM conversations WHERE site_id = $1 AND source = 'chat' AND customer_key = $2 AND verified_order_id = $3 AND verified_via IN ('form', 'chat_phone') AND merged_into IS NULL AND id <> $4 ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT 1") {
    const c = db.convs
      .filter((x) => x.site_id === p[0] && x.source === 'chat' && x.customer_key === p[1] && x.verified_order_id === p[2] && ['form', 'chat_phone'].includes(x.verified_via) && !x.merged_into && x.id !== p[3])
      .sort((a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at))[0];
    return rows(c ? [{ id: c.id }] : []);
  }
  if (q === 'SELECT c.id, c.site_id, c.status, c.unread_count, c.visitor_id, c.visitor_name, c.verified_order_id, c.verified_via, c.customer_key, c.source, c.merged_into, s.ai_enabled, c.assigned_to FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = ANY($1::text[]) ORDER BY c.id FOR UPDATE OF c') {
    need(tx, q);
    const ids = db.convs.filter((c) => p[0].includes(c.id)).map((c) => c.id).sort();
    for (const id of ids) await lockRow(tx, id);
    return rows(ids.map((id) => { const c = conv(id); return { ...pick(c, ['id', 'site_id', 'status', 'unread_count', 'visitor_id', 'visitor_name', 'verified_order_id', 'verified_via', 'customer_key', 'source', 'merged_into', 'assigned_to']), ai_enabled: siteOf(c.site_id).ai_enabled }; }));
  }
  if (q === 'UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2') { for (const x of db.messages) if (x.conversation_id === p[1]) setRow(tx, x, { conversation_id: p[0] }); return rows([]); }
  if (q === 'UPDATE chat_attachments SET conversation_id = $1 WHERE conversation_id = $2' || q === 'UPDATE message_revisions SET conversation_id = $1 WHERE conversation_id = $2') return rows([]);
  if (/^UPDATE conversations SET status = CASE WHEN \$3 = 'human_needed' THEN 'human_needed' .* assigned_to = COALESCE\(assigned_to, \$8\), assigned_at = CASE WHEN assigned_to IS NULL AND \$8::text IS NOT NULL THEN now\(\) ELSE assigned_at END, updated_at = now\(\) WHERE id = \$1 AND id <> \$2$/.test(q)) {
    need(tx, q);
    const c = await rowFor(tx, p[0]);
    const status = p[2] === 'human_needed' ? 'human_needed' : c.status === 'resolved' && c.case_kind ? 'agent_handling' : c.status === 'resolved' ? p[3] : c.status;
    setRow(tx, c, { status, unread_count: (c.unread_count || 0) + p[4], assigned_to: c.assigned_to ?? p[7], assigned_at: c.assigned_to == null && p[7] != null ? nowIso() : c.assigned_at });
    return rows([]);
  }
  if (q === "UPDATE conversations SET merged_into = $1, status = 'resolved', unread_count = 0, updated_at = now() WHERE id = $2") {
    need(tx, q);
    setRow(tx, await rowFor(tx, p[1]), { merged_into: p[0], status: 'resolved', unread_count: 0 });
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
  if (tx && tx.aborted && !/^ROLLBACK/.test(q)) throw new Error('fake db: current transaction is aborted, commands ignored until end of transaction block: ' + q.slice(0, 80));
  try {
    for (const f of db.fail) {
      if (f.re.test(q)) { if (f.once) db.fail.splice(db.fail.indexOf(f), 1); throw pgErr(f.code, f.message || 'injected failure ' + f.code); }
    }
    const out = await handle(q, params || [], tx);
    for (const h of db.after.splice(0)) { if (h.re.test(q)) h.fn(); else db.after.push(h); }
    return out;
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
let mod;
function fresh() {
  // A restart: new module instances and an empty login cache.
  const g = global.__shiptrackTeam;
  if (g && g.timer) clearInterval(g.timer);
  delete global.__shiptrackTeam;
  for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
  const r = (f) => require(path.join(dir, f + '.js'));
  mod = {
    auth: r('auth'), routing: r('team-routing'), rules: r('team-rules'), messages: r('r-messages'), thread: r('r-thread'), list: r('r-list'),
    release: r('r-release'), widgetMessages: r('r-widget-messages'), widgetMessage: r('r-widget-message'), merge: r('merge-chats'),
    pending: r('r-pending'),
  };
  return mod;
}
async function restart() {
  db.presence = [];
  fresh();
  await mod.auth.refreshTeamCache();
}
const tokens = {};
function makeTokens() {
  const a = mod.auth;
  const m = (u) => a.generateToken(u.username, u.role, u.business_ids, { name: u.display_name, perms: u.permissions, sv: u.session_version, uid: u.id });
  tokens.owner = a.generateToken('Owner', 'admin', null, { name: 'Super Admin' });
  for (const u of db.team) tokens[u.username === 'old.agent' ? 'off' : u.username] = m(u);
}
function req(who, body, { method = 'POST', active = false, url = 'http://x/api' } = {}) {
  return {
    method, url,
    headers: { get: (k) => {
      k = k.toLowerCase();
      if (k === 'authorization') return who && tokens[who] ? `Bearer ${tokens[who]}` : null;
      if (k === 'x-st-active') return active ? '1' : null;
      return null;
    } },
    json: async () => { if (body === undefined) throw new Error('no body'); return clone(body); },
  };
}
const reply = (who, id, content = 'Hello, checking this for you', extra = {}) => mod.messages.POST(req(who, { conversationId: id, content, ...extra }));
const patch = (who, id, body) => mod.thread.PATCH(req(who, body, { method: 'PATCH' }), { params: { id } });
const thread = (who, id) => mod.thread.GET(req(who, undefined, { method: 'GET', active: true }), { params: { id } });
const list = (who, qs = '') => mod.list.GET(req(who, undefined, { method: 'GET', url: 'http://x/api/chat/conversations' + qs }));
const release = (who) => mod.release.POST(req(who, {}));
const takeOver = (who, id) => patch(who, id, { status: 'agent_handling' });
const takeFrom = (who, id) => patch(who, id, { status: 'agent_handling', take: true });

// IST wall time -> the instant (India is +5:30 all year).
const ist = (h, m = 0, day = 1) => Date.UTC(2026, 9, day, h, m) - 330 * 60_000;
const realNow = Date.now;
let clock = ist(15, 0);
Date.now = () => clock;
const at = (ms) => { clock = ms; };
// Someone does something in ShipTrack at `ms` (presence is noted by any POST).
function touch(who, ms) {
  const keep = clock; clock = ms;
  assert.ok(mod.auth.getAuthFromRequest(req(who, undefined, { method: 'POST' })), 'touch: login refused for ' + who);
  clock = keep;
}

let convSeq = 0;
function newConv(o = {}) {
  const id = o.id || 'c' + (++convSeq);
  const c = {
    id, site_id: 'S1', source: 'chat', status: 'ai_handling', assigned_to: null, assigned_at: null, customer_key: null, merged_into: null,
    case_kind: null, case_order_id: null, case_prev_status: null, case_marked_by: null, case_marked_at: null,
    verified_order_id: null, verified_via: null, phone_match_order_id: null, unread_count: 0, auto_closed_at: null,
    closed_by_name: null, closed_at: null, visitor_name: 'Visitor', visitor_phone: null, visitor_id: 'v-' + id, category: 'others',
    subject_label: null, subject_summary: null, subject_updated_at: null, health_score: null, health_reason: null, health_updated_at: null,
    created_at: new Date(clock - 3600_000).toISOString(), last_message_at: new Date(clock - 60_000).toISOString(),
    ...o,
  };
  db.convs.push(c);
  return c;
}
// A known customer (verified by the widget form).
const known = (o = {}) => newConv({ verified_order_id: '#' + (o.id || 'x'), verified_via: 'form', ...o });
const C = (id) => conv(id);
const evs = (id, kind) => db.events.filter((e) => e.conversation_id === id && (!kind || e.kind === kind));
const agentMsgs = (id) => db.messages.filter((x) => x.conversation_id === id && x.sender === 'agent');
// The statements sent since position n, and those of each transaction among them (in order).
const since = (n) => db.stmts.slice(n);
const txStmts = (n) => {
  const s = since(n).filter((x) => x.tx !== null);
  const ids = [...new Set(s.map((x) => x.tx))];
  return ids.map((id) => s.filter((x) => x.tx === id).map((x) => x.q));
};

// Console output is kept, and shown only when a test fails (the routes log as they work).
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
const status = (r, want, label = '') => eq(r.status, want, `${label} expected ${want}, got ${r.status}: ${JSON.stringify(r.body)}`);

(async () => {
  at(ist(15, 0));
  await restart();
  makeTokens();

  // ── R1-R2: the first reply on a chat nobody holds ─────────────
  await t('R1 a junior\'s first reply on a known customer\'s free Needs you chat makes it hers', async () => {
    known({ id: 'r1', status: 'human_needed', auto_closed_at: 'x' });
    const s0 = db.stmts.length;
    const r = await reply('anurag', 'r1', 'Hi, I am checking your order now');
    status(r, 200);
    const c = C('r1');
    deq([c.assigned_to, c.status, c.auto_closed_at, !!c.assigned_at], [ANURAG, 'agent_handling', null, true]);
    deq(agentMsgs('r1').map((x) => x.metadata), [{ agent: 'anurag' }]);          // metadata exactly as before
    deq(evs('r1').map((e) => e.kind), ['status', 'claim', 'reply']);
    const [st, claim, rep] = evs('r1');
    // The status trigger saw the person: set_config ran before the status UPDATE, in the same transaction.
    deq([st.actor, st.actor_name, st.reason, st.from_status, st.to_status, st.from_owner, st.to_owner], [ANURAG, 'Anurag', 'reply', 'human_needed', 'agent_handling', null, ANURAG]);
    deq([claim.actor, claim.actor_name, claim.from_owner, claim.to_owner, claim.reason, claim.from_status, claim.to_status], [ANURAG, 'Anurag', null, ANURAG, 'reply', 'human_needed', 'agent_handling']);
    deq(claim.meta, { tier: 'junior', group: [] });
    deq([rep.message_id, rep.to_owner, rep.meta], [agentMsgs('r1')[0].id, ANURAG, { tier: 'junior' }]);
    const [tx] = txStmts(s0);
    eq(tx[0], 'BEGIN'); eq(tx[1], "SET LOCAL lock_timeout = '5s'"); ok(/FOR NO KEY UPDATE$/.test(tx[2]));
    const iSet = tx.findIndex((q) => q.startsWith('SELECT set_config')), iUpd = tx.findIndex((q) => q.startsWith("UPDATE conversations SET status = 'agent_handling'"));
    ok(iSet > 0 && iSet < iUpd, 'set_config before the status UPDATE');
    eq(tx[tx.length - 1], 'COMMIT');
    eq(r.body.emailed, null);
  });

  await t('R1 the chat is locked before its files (the same order as a merge)', async () => {
    known({ id: 'r1f' });
    const fileId = 'a'.repeat(64);
    db.attachments.push({ id: fileId, conversation_id: 'r1f', message_id: null, file_name: 'label.png', mime_type: 'image/png', size_bytes: 1200, kind: 'image' });
    const s0 = db.stmts.length;
    status(await reply('anurag', 'r1f', '', { attachmentIds: [fileId] }), 200);
    const [tx] = txStmts(s0);
    const iLock = tx.findIndex((q) => /FOR NO KEY UPDATE$/.test(q)), iFiles = tx.findIndex((q) => q.startsWith('SELECT id, file_name'));
    ok(iLock >= 0 && iLock < iFiles);
    const meta = agentMsgs('r1f')[0].metadata;
    deq([meta.agent, meta.captionless, meta.attachments.length], ['anurag', true, 1]);
    eq(db.attachments[0].message_id, agentMsgs('r1f')[0].id);
  });

  await t('R1 an email thread: the reply is claimed and saved first, the email goes out after the commit', async () => {
    newConv({ id: 'r1e', source: 'email', status: 'human_needed', verified_order_id: '#r1e' });
    global.__emails.length = 0;
    const r = await reply('anurag', 'r1e', 'We have checked your order.');
    status(r, 200);
    deq([r.body.emailed, C('r1e').assigned_to, global.__emails.length], [true, ANURAG, 1]);
    deq(agentMsgs('r1e')[0].metadata, { agent: 'anurag', emailed: true });
  });

  await t('R2 the customer\'s other open chats nobody holds come along (one claim event); others stay', async () => {
    const K = '9000000002';
    known({ id: 'r2a', customer_key: K, status: 'agent_handling' });
    known({ id: 'r2b', customer_key: K, status: 'ai_handling' });                         // free: moves, status kept
    known({ id: 'r2c', customer_key: K, status: 'human_needed', assigned_to: OFF });      // a switched-off holder holds nothing: moves
    known({ id: 'r2d', customer_key: K, status: 'agent_handling', assigned_to: RAHUL });  // Rahul's: stays
    known({ id: 'r2e', customer_key: K, status: 'resolved' });                            // Closed: not touched
    known({ id: 'r2f', customer_key: K, site_id: 'S2' });                                 // another site
    newConv({ id: 'r2g', customer_key: K, source: 'email' });                             // an email thread
    status(await reply('anurag', 'r2a'), 200);
    deq(['r2a', 'r2b', 'r2c', 'r2d', 'r2e', 'r2f', 'r2g'].map((id) => C(id).assigned_to), [ANURAG, ANURAG, ANURAG, RAHUL, null, null, null]);
    deq(['r2b', 'r2c'].map((id) => C(id).status), ['ai_handling', 'human_needed']);
    deq(evs('r2a', 'claim').map((e) => e.meta.group), [['r2b', 'r2c']]);
    eq(db.events.filter((e) => e.kind === 'claim' && ['r2b', 'r2c'].includes(e.conversation_id)).length, 0);
  });

  await t('R2 a holder who was switched off, removed, lost chat.reply or the panel holds nothing (old id logged)', async () => {
    for (const [id, holder] of [['r2x1', OFF], ['r2x2', GONE], ['r2x3', VIEWER], ['r2x4', PRIYA]]) {
      known({ id, status: 'agent_handling', assigned_to: holder });
      const g = await thread('anurag', id);
      deq([g.body.staff.holder, g.body.staff.can_act, g.body.staff.claims], [null, true, true], id);
      status(await reply('anurag', id), 200, id);
      eq(C(id).assigned_to, ANURAG);
      deq([evs(id, 'claim')[0].from_owner, evs(id, 'claim')[0].to_owner], [holder, ANURAG]);
    }
  });

  await t('R2 a customer key set between the route\'s first read and the lock: 409 "try again", nothing saved, no second lock; the retry claims the group', async () => {
    // The AI's lookup can set customer_key in between (ai.ts). Locking that customer's other chats
    // after this one would break the id order (a deadlock with mergeChats, which locks them in id
    // order and would lose the merge), so the action is refused and the retry reads the new key.
    // r2j sorts before r2k: the chat a second lock would have taken out of order.
    known({ id: 'r2k', status: 'human_needed' });
    known({ id: 'r2j', status: 'ai_handling', customer_key: '9000000022' });
    db.after.push({ re: /^SELECT c\.id, c\.source, s\.tracker_business_id/, fn: () => { C('r2k').customer_key = '9000000022'; } });
    const snapshot = clone(db.convs), m0 = db.messages.length, e0 = db.events.length, s0 = db.stmts.length;
    const r = await reply('anurag', 'r2k');
    status(r, 409);
    eq(r.body.error, 'Someone else is changing this chat right now. Try again.');
    snapshot.find((c) => c.id === 'r2k').customer_key = '9000000022';   // only the lookup's own change
    deq(db.convs, snapshot);
    deq([db.messages.length, db.events.length], [m0, e0]);
    const [tx] = txStmts(s0);
    eq(tx.filter((q) => /FOR NO KEY UPDATE$/.test(q)).length, 1, 'one lock statement only');
    eq(tx[tx.length - 1], 'ROLLBACK');
    // The same on the thread's actions (they share lockChatGroup).
    known({ id: 'r2m', status: 'human_needed' });
    db.after.push({ re: /^SELECT c\.id, c\.site_id, c\.visitor_name, /, fn: () => { C('r2m').customer_key = '9000000022'; } });
    status(await takeOver('anurag', 'r2m'), 409);
    eq(C('r2m').assigned_to, null);
    // Pressed again: the new key is read first, the whole group is locked in id order and claimed.
    status(await reply('anurag', 'r2k'), 200);
    deq(['r2k', 'r2j', 'r2m'].map((id) => C(id).assigned_to), [ANURAG, ANURAG, ANURAG]);
    deq(evs('r2k', 'claim')[0].meta.group, ['r2j', 'r2m']);
  });

  // ── R3-R5: someone else's chat ────────────────────────────────
  await t('R3 a junior on a senior\'s chat: 409 with his name, nothing saved', async () => {
    known({ id: 'r3', status: 'agent_handling', assigned_to: RAHUL });
    const before = clone(C('r3')), s0 = db.stmts.length;
    const r = await reply('anurag', 'r3', 'Let me help');
    status(r, 409);
    eq(r.body.error, 'Rahul has this chat. You can read it; ask Rahul or Super Admin to transfer it to you.');
    deq(C('r3'), before);
    eq(agentMsgs('r3').length, 0);
    eq(evs('r3').length, 0);
    ok(!since(s0).some((x) => /^INSERT INTO messages|^UPDATE conversations/.test(x.q)));
    ok(txStmts(s0)[0].includes('ROLLBACK'));
    for (const body of [{ status: 'resolved' }, { status: 'ai_handling' }, { status: 'agent_handling' }]) {
      const p = await patch('anurag', 'r3', body);
      status(p, 409, JSON.stringify(body));
      eq(p.body.error, 'Rahul has this chat. You can read it; ask Rahul or Super Admin to transfer it to you.');
    }
    deq(C('r3'), before);
  });

  await t('R4 a senior on a junior\'s chat: "Take from Anurag" first, then it is his', async () => {
    const K = '9000000004';
    known({ id: 'r4', status: 'agent_handling', assigned_to: ANURAG, customer_key: K });
    known({ id: 'r4b', status: 'human_needed', assigned_to: ANURAG, customer_key: K });   // Anurag's too: comes along
    known({ id: 'r4c', status: 'ai_handling', customer_key: K });                         // nobody's: stays nobody's
    const r = await reply('rahul', 'r4');
    status(r, 409);
    eq(r.body.error, 'Anurag has this chat. Press "Take from Anurag" first.');
    eq(agentMsgs('r4').length, 0);
    const g = await thread('rahul', 'r4');
    deq([g.body.staff.take, g.body.staff.can_act, g.body.staff.holder.name], ['senior', false, 'Anurag']);
    const w0 = db.waitingAsked.length;
    const tk = await takeFrom('rahul', 'r4');
    status(tk, 200);
    deq([tk.body.assigned_to, tk.body.status], [RAHUL, 'agent_handling']);
    deq(['r4', 'r4b', 'r4c'].map((id) => C(id).assigned_to), [RAHUL, RAHUL, null]);
    eq(C('r4b').status, 'human_needed');
    const ev = evs('r4', 'take')[0];
    deq([ev.actor, ev.from_owner, ev.to_owner, ev.reason, ev.meta], [RAHUL, ANURAG, RAHUL, 'take', { tier: 'senior', take: 'senior', group: ['r4b'] }]);
    eq(db.waitingAsked.length, w0, 'a senior\'s take never asks whether the customer waits');
    status(await reply('rahul', 'r4'), 200);
    eq(evs('r4', 'claim').length, 0);
    status(await reply('anurag', 'r4'), 409);
    // Taking what is already yours, or a chat nobody holds, is refused (Take over is the button there).
    eq((await takeFrom('rahul', 'r4')).body.error, "Nothing to take: this chat is no longer someone else's.");
    known({ id: 'r4d' });
    status(await takeFrom('rahul', 'r4d'), 409);
  });

  await t('R4 a senior cannot take another senior\'s chat', async () => {
    db.team.find((u) => u.id === ANURAG).permissions.push('chat.senior');
    await mod.auth.refreshTeamCache(true);
    known({ id: 'r4s', status: 'agent_handling', assigned_to: ANURAG });
    const r = await takeFrom('rahul', 'r4s');
    status(r, 409);
    eq(r.body.error, "Nothing to take: Anurag's chat cannot be taken by you.");
    eq((await reply('rahul', 'r4s')).body.error, 'Anurag has this chat. You can read it; ask Anurag or Super Admin to transfer it to you.');
    db.team.find((u) => u.id === ANURAG).permissions = [...CHAT_PERMS];
    await mod.auth.refreshTeamCache(true);
  });

  await t('R5 away cover: a waiting customer\'s chat can be taken from a member away 30+ min in office hours only', async () => {
    known({ id: 'r5', status: 'agent_handling', assigned_to: RAHUL });
    db.waiting.r5 = true;
    at(ist(15, 0)); touch('rahul', ist(14, 55));
    let w0 = db.waitingAsked.length;
    let r = await takeFrom('anurag', 'r5');
    status(r, 409);
    eq(r.body.error, "Nothing to take: Rahul's chat cannot be taken by you.");
    eq(db.waitingAsked.length, w0, 'Rahul was around: no need to ask whether the customer waits');
    touch('rahul', ist(14, 15));                       // 45 min away at 15:00
    db.waiting.r5 = false;
    w0 = db.waitingAsked.length;
    status(await takeFrom('anurag', 'r5'), 409);       // the customer is not waiting
    eq(db.waitingAsked.length, w0 + 1);
    let g = await thread('anurag', 'r5');
    deq([g.body.staff.take, g.body.staff.holder.away_min, g.body.staff.can_act], [null, 45, false]);
    eq((await reply('anurag', 'r5')).body.error, 'Rahul has this chat. You can read it; ask Rahul or Super Admin to transfer it to you.');
    db.waiting.r5 = true;
    g = await thread('anurag', 'r5');
    eq(g.body.staff.take, 'holder_away');
    eq((await reply('anurag', 'r5')).body.error, 'Rahul has this chat. Press "Take from Rahul" first.');
    r = await takeFrom('anurag', 'r5');
    status(r, 200);
    eq(C('r5').assigned_to, ANURAG);
    deq(evs('r5', 'take')[0].meta, { tier: 'junior', take: 'holder_away', group: [] });
    // At night nobody is "away": no away cover.
    known({ id: 'r5n', status: 'agent_handling', assigned_to: RAHUL });
    db.waiting.r5n = true;
    at(ist(21, 0));
    w0 = db.waitingAsked.length;
    status(await takeFrom('anurag', 'r5n'), 409);
    eq(db.waitingAsked.length, w0);
    eq((await thread('anurag', 'r5n')).body.staff.take, null);
    // Never for the Super Admin's chats, however long he is away.
    at(ist(15, 0));
    known({ id: 'r5o', status: 'agent_handling', assigned_to: 'owner' });
    db.waiting.r5o = true;
    touch('owner', ist(11, 0));
    for (const who of ['anurag', 'rahul']) {
      const x = await takeFrom(who, 'r5o');
      status(x, 409, who);
      eq(x.body.error, "Nothing to take: Super Admin's chat cannot be taken by you.");
    }
    eq(C('r5o').assigned_to, 'owner');
  });

  // ── R6: the Super Admin (owner answers Q2 and 3) ──────────────
  await t('R6 the Super Admin\'s first reply on a free chat makes it his, with the customer\'s free chats', async () => {
    at(ist(16, 0));
    const K = '9000000006';
    known({ id: 'r6a', customer_key: K, status: 'human_needed' });
    known({ id: 'r6b', customer_key: K, status: 'ai_handling' });
    status(await reply('owner', 'r6a', 'Main dekh raha hoon'), 200);
    deq([C('r6a').assigned_to, C('r6b').assigned_to, C('r6a').status], ['owner', 'owner', 'agent_handling']);
    deq(agentMsgs('r6a').map((x) => x.metadata), [{ agent: 'Owner' }]);
    const claim = evs('r6a', 'claim')[0];
    deq([claim.actor, claim.actor_name, claim.to_owner, claim.reason, claim.meta], ['owner', 'Super Admin', 'owner', 'reply', { tier: 'owner', group: ['r6b'] }]);
    deq([evs('r6a', 'status')[0].actor, evs('r6a', 'reply')[0].actor], ['owner', 'owner']);
    // The team only reads his chats.
    eq((await reply('anurag', 'r6a')).body.error, 'Super Admin has this chat. You can read it; ask Super Admin to transfer it to you.');
    eq((await takeFrom('rahul', 'r6a')).body.error, "Nothing to take: Super Admin's chat cannot be taken by you.");
    const tr = await patch('anurag', 'r6a', { transferTo: RAHUL, note: 'please take this one' });
    status(tr, 409);
    eq(tr.body.error, 'Super Admin has this chat. Only Super Admin can transfer it.');
    status(await patch('rahul', 'r6a', { status: 'resolved' }), 409);
    const g = await thread('rahul', 'r6a');
    deq([g.body.staff.can_act, g.body.staff.take, g.body.staff.transfer_to, g.body.staff.holder], [false, null, [], { key: 'owner', name: 'Super Admin', senior: false, owner: true, away_min: null }]);
  });

  await t('R6 the Super Admin on a member\'s chat: acts without taking it; "Take from" and Take over claim', async () => {
    known({ id: 'r6c', status: 'agent_handling', assigned_to: ANURAG });
    status(await reply('owner', 'r6c'), 200);
    eq(C('r6c').assigned_to, ANURAG);
    eq(evs('r6c', 'claim').length, 0);
    eq(evs('r6c', 'reply')[0].to_owner, ANURAG);
    const g = await thread('owner', 'r6c');
    deq([g.body.staff.can_act, g.body.staff.claims, g.body.staff.take], [true, false, 'owner']);
    status(await takeFrom('owner', 'r6c'), 200);
    eq(C('r6c').assigned_to, 'owner');
    deq(evs('r6c', 'take')[0].meta, { tier: 'owner', take: 'owner', group: [] });
    status(await reply('anurag', 'r6c'), 409);
    // Take over on a chat nobody holds claims too (reason take_over), the AI stops.
    known({ id: 'r6d', status: 'human_needed' });
    const r = await takeOver('owner', 'r6d');
    status(r, 200);
    deq([r.body.assigned_to, C('r6d').status], ['owner', 'agent_handling']);
    const ev = evs('r6d', 'claim')[0];
    deq([ev.reason, ev.meta], ['take_over', { tier: 'owner', group: [] }]);
    eq(evs('r6d', 'status')[0].reason, 'take_over');
  });

  await t('R6 Transfer to "Me (Super Admin)" and to "Nobody (open pool)"', async () => {
    known({ id: 'r6e', status: 'agent_handling', assigned_to: ANURAG });
    const g = await thread('owner', 'r6e');
    deq(g.body.staff.transfer_to.map((x) => [x.key, x.name]), [[RAHUL, 'Rahul'], ['owner', 'Me (Super Admin)'], [null, 'Nobody (open pool)']]);
    const toHolder = await patch('owner', 'r6e', { transferTo: ANURAG, note: 'she already has it' });
    status(toHolder, 400);
    eq(toHolder.body.error, 'Pick someone who can reply in this panel (not you, not the person who has it)');
    let r = await patch('owner', 'r6e', { transferTo: 'owner', note: 'I will handle this one' });
    status(r, 200);
    deq([r.body.assigned_to, r.body.holder_name, r.body.status], ['owner', 'Super Admin', 'human_needed']);   // a known customer: Needs you
    r = await patch('owner', 'r6e', { transferTo: null, note: 'Back to the team please' });
    status(r, 200);
    deq([r.body.assigned_to, r.body.holder_name, r.body.status, C('r6e').assigned_at], [null, null, 'human_needed', null]);   // Nobody keeps the status
    const ev = evs('r6e', 'transfer').pop();
    deq([ev.from_owner, ev.to_owner, ev.note, ev.meta.tier], ['owner', null, 'Back to the team please', 'owner']);
    // Nobody is offered only on a held chat.
    ok(!(await thread('owner', 'r6e')).body.staff.transfer_to.some((x) => x.key === null));
    status(await patch('owner', 'r6e', { transferTo: null, note: 'again to nobody' }), 400);
    // His Close keeps him as the holder.
    status(await takeOver('owner', 'r6e'), 200);
    status(await patch('owner', 'r6e', { status: 'resolved' }), 200);
    deq([C('r6e').assigned_to, C('r6e').status, C('r6e').closed_by_name], ['owner', 'resolved', 'Super Admin']);
  });

  // ── R7: Transfer ──────────────────────────────────────────────
  await t('R7 transfer: refused cleanly when the note, the target or the person is wrong', async () => {
    at(ist(16, 30)); touch('owner', ist(16, 29));
    known({ id: 'r7x', status: 'agent_handling', assigned_to: ANURAG });
    const before = clone(C('r7x')), e0 = db.events.length;
    const bad = [
      [{ transferTo: RAHUL }, 400, 'Write one line for the team: why are you transferring it?'],
      [{ transferTo: RAHUL, note: '   ' }, 400, 'Write one line for the team: why are you transferring it?'],
      [{ transferTo: RAHUL, note: '12!' }, 400, 'Write one line for the team: why are you transferring it?'],
      [{ transferTo: RAHUL, note: 'ab' }, 400, 'Write one line for the team: why are you transferring it?'],
      [{ transferTo: ANURAG, note: 'to myself' }, 400, 'Pick someone who can reply in this panel (not you, not the person who has it)'],
      [{ transferTo: OFF, note: 'switched off' }, 400, 'Pick someone who can reply in this panel (not you, not the person who has it)'],
      [{ transferTo: PRIYA, note: 'not her panel' }, 400, 'Pick someone who can reply in this panel (not you, not the person who has it)'],
      [{ transferTo: VIEWER, note: 'cannot reply' }, 400, 'Pick someone who can reply in this panel (not you, not the person who has it)'],
      [{ transferTo: GONE, note: 'removed member' }, 400, 'Pick someone who can reply in this panel (not you, not the person who has it)'],
      [{ transferTo: 5, note: 'a number' }, 400, 'Pick someone who can reply in this panel (not you, not the person who has it)'],
      [{ transferTo: '', note: 'empty' }, 400, 'Pick someone who can reply in this panel (not you, not the person who has it)'],
      [{ transferTo: null, note: 'to the pool' }, 403, 'Only Super Admin can put a chat back in the open pool'],
    ];
    for (const [body, code, msg] of bad) {
      const r = await patch('anurag', 'r7x', body);
      status(r, code, JSON.stringify(body));
      eq(r.body.error, msg);
    }
    const r = await patch('rahul', 'r7x', { transferTo: 'owner', note: 'not mine to give' });
    status(r, 409);
    eq(r.body.error, 'Anurag has this chat. Only Anurag or Super Admin can transfer it.');
    status(await patch('viewer', 'r7x', { transferTo: RAHUL, note: 'viewer tries' }), 403);
    deq(C('r7x'), before);
    eq(db.events.length, e0);
    // The list offered to the holder: members who can reply in the panel, then the Super Admin.
    const g = await thread('anurag', 'r7x');
    deq(g.body.staff.transfer_to, [{ key: RAHUL, name: 'Rahul', senior: true, away_min: null }, { key: 'owner', name: 'Super Admin', senior: false, away_min: null }]);
  });

  await t('R7 transfer: a known customer goes to Needs you "For Rahul", the same holder\'s other chats move, the note stays staff only', async () => {
    const K = '9000000007';
    known({ id: 'r7', status: 'agent_handling', assigned_to: ANURAG, customer_key: K, auto_closed_at: 'x' });
    known({ id: 'r7b', status: 'agent_handling', assigned_to: ANURAG, customer_key: K });  // same holder: moves, status kept
    known({ id: 'r7c', status: 'ai_handling', customer_key: K });                         // nobody's: stays
    const s0 = db.stmts.length, l0 = logged.length;
    const note = 'Customer angry,\nrefund asked 2nd time \t‮ok';
    const r = await patch('anurag', 'r7', { transferTo: RAHUL, note });
    status(r, 200);
    deq(r.body, { success: true, status: 'human_needed', assigned_to: RAHUL, holder_name: 'Rahul' });
    deq([C('r7').status, C('r7').assigned_to, C('r7').auto_closed_at], ['human_needed', RAHUL, null]);
    deq([C('r7b').assigned_to, C('r7b').status, C('r7c').assigned_to], [RAHUL, 'agent_handling', null]);
    const ev = evs('r7', 'transfer')[0];
    deq([ev.actor, ev.from_owner, ev.to_owner, ev.from_status, ev.to_status, ev.reason, ev.note], [ANURAG, ANURAG, RAHUL, 'agent_handling', 'human_needed', 'transfer', 'Customer angry, refund asked 2nd time ok']);
    deq(ev.meta, { tier: 'junior', status_before: 'agent_handling', group: ['r7b'] });
    deq([evs('r7', 'status')[0].actor, evs('r7', 'status')[0].reason], [ANURAG, 'transfer']);
    ok(!since(s0).some((x) => /INSERT INTO messages/.test(x.q)), 'a transfer writes no message');
    const out = logged.slice(l0).join('\n');
    ok(/transfer conv r7 from .* to .* \(note \d+ chars\)/.test(out) && !/angry|refund asked/.test(out), 'the log line names no note: ' + out);
    ok(!db.messages.some((x) => /angry/.test(x.content)));
    // Rahul now holds it; the team log shows the note to staff.
    status(await reply('anurag', 'r7'), 409);
    const g = await thread('rahul', 'r7');
    deq(pick(g.body.team_log[0], ['kind', 'note', 'from_name', 'to_name', 'actor_name']), { kind: 'transfer', note: 'Customer angry, refund asked 2nd time ok', from_name: 'Anurag', to_name: 'Rahul', actor_name: 'Anurag' });
    deq([g.body.staff.can_act, g.body.staff.holder.key], [true, RAHUL]);
    status(await reply('rahul', 'r7'), 200);
  });

  await t('R7 transfer: long notes are cut to 200 characters, never mid-letter', async () => {
    known({ id: 'r7l', status: 'agent_handling', assigned_to: ANURAG });
    status(await patch('anurag', 'r7l', { transferTo: RAHUL, note: 'a'.repeat(250) }), 200);
    eq(evs('r7l', 'transfer')[0].note, 'a'.repeat(200));
    known({ id: 'r7h', status: 'agent_handling', assigned_to: ANURAG });
    status(await patch('anurag', 'r7h', { transferTo: RAHUL, note: 'ग्राहक नाराज़ है 😡 '.repeat(20) }), 200);
    const note = evs('r7h', 'transfer')[0].note;
    ok(Array.from(note).length <= 200 && !/�/.test(note) && !/[\uD800-\uDBFF]$/.test(note));
  });

  await t('R7 transfer: a visitor never reaches Needs you; a case chat keeps its status; a Closed chat is refused', async () => {
    newConv({ id: 'r7v', status: 'agent_handling', assigned_to: ANURAG });                   // a visitor
    let r = await patch('anurag', 'r7v', { transferTo: 'owner', note: 'visitor asks for the owner' });
    status(r, 200);
    deq([r.body.status, r.body.assigned_to, C('r7v').status], ['agent_handling', 'owner', 'agent_handling']);
    known({ id: 'r7k', status: 'agent_handling', assigned_to: ANURAG, case_kind: 'refund', case_order_id: '#r7k' });
    r = await patch('anurag', 'r7k', { transferTo: RAHUL, note: 'refund case for the senior' });
    status(r, 200);
    deq([C('r7k').status, C('r7k').assigned_to], ['agent_handling', RAHUL]);
    known({ id: 'r7z', status: 'resolved', assigned_to: ANURAG });
    r = await patch('anurag', 'r7z', { transferTo: RAHUL, note: 'closed one' });
    status(r, 400);
    eq(r.body.error, 'This chat is Closed. When the customer writes again it goes to whoever holds it.');
    eq(C('r7z').assigned_to, ANURAG);
    deq((await thread('anurag', 'r7z')).body.staff.transfer_to, []);
    // Anyone may transfer a chat nobody holds (they may act on it).
    known({ id: 'r7u', status: 'human_needed' });
    status(await patch('anurag', 'r7u', { transferTo: RAHUL, note: 'for the senior' }), 200);
    deq([C('r7u').assigned_to, evs('r7u', 'transfer')[0].from_owner], [RAHUL, null]);
    // To someone away: allowed, the list says so.
    at(ist(16, 30)); touch('rahul', ist(15, 40));
    known({ id: 'r7w', status: 'agent_handling', assigned_to: ANURAG });
    const g = await thread('anurag', 'r7w');
    eq(g.body.staff.transfer_to.find((x) => x.key === RAHUL).away_min, 50);
    status(await patch('anurag', 'r7w', { transferTo: RAHUL, note: 'for when he is back' }), 200);
  });

  // ── R8: Close and Hand to AI ──────────────────────────────────
  await t('R8 Close and Hand to AI: the holder only; they keep the holder', async () => {
    known({ id: 'r8', status: 'agent_handling', assigned_to: RAHUL, auto_closed_at: 'x', unread_count: 3 });
    for (const st of ['resolved', 'ai_handling']) status(await patch('anurag', 'r8', { status: st }), 409, st);
    let r = await patch('rahul', 'r8', { status: 'ai_handling' });
    status(r, 200);
    deq([r.body.status, r.body.assigned_to, C('r8').assigned_to, C('r8').auto_closed_at], ['ai_handling', RAHUL, RAHUL, null]);
    deq([evs('r8', 'status')[0].actor, evs('r8', 'status')[0].reason], [RAHUL, 'hand_to_ai']);
    r = await patch('rahul', 'r8', { status: 'resolved' });
    status(r, 200);
    deq([r.body.closed_by_name, r.body.assigned_to, C('r8').unread_count, C('r8').status], ['Rahul', RAHUL, 0, 'resolved']);
    eq(evs('r8', 'status')[1].reason, 'close');
    // Take over on his own Closed chat reopens it; no claim, it is already his.
    r = await takeOver('rahul', 'r8');
    status(r, 200);
    deq([C('r8').status, C('r8').assigned_to, evs('r8', 'claim').length], ['agent_handling', RAHUL, 0]);
    // Take over on his own Needs you chat: the status only.
    known({ id: 'r8n', status: 'human_needed', assigned_to: RAHUL });
    status(await takeOver('rahul', 'r8n'), 200);
    deq([C('r8n').status, evs('r8n', 'claim').length], ['agent_handling', 0]);
    // A Refund / Ship again chat never goes back to the AI.
    known({ id: 'r8k', status: 'agent_handling', assigned_to: RAHUL, case_kind: 'reship', case_order_id: '#r8k' });
    r = await patch('rahul', 'r8k', { status: 'ai_handling' });
    status(r, 409);
    eq(r.body.error, 'Remove the Refund / Ship again mark before handing this chat to the AI');
    eq(C('r8k').status, 'agent_handling');
    status(await patch('rahul', 'r8k', { status: 'bogus' }), 400);
    // Close and Hand to AI on a chat nobody holds: allowed, and still nobody's.
    known({ id: 'r8f', status: 'human_needed' });
    status(await patch('anurag', 'r8f', { status: 'ai_handling' }), 200);
    deq([C('r8f').status, C('r8f').assigned_to, evs('r8f', 'claim').length], ['ai_handling', null, 0]);
    status(await patch('anurag', 'r8f', { status: 'resolved' }), 200);
    deq([C('r8f').status, C('r8f').assigned_to, C('r8f').closed_by_name, evs('r8f', 'claim').length], ['resolved', null, 'Anurag', 0]);
    known({ id: 'r8g', status: 'agent_handling' });
    status(await patch('owner', 'r8g', { status: 'resolved' }), 200);
    eq(C('r8g').assigned_to, null);
    status(await patch('viewer', 'r8k', { status: 'resolved' }), 403);
  });

  // ── R9: Refund / Ship again ───────────────────────────────────
  await t('R9 a senior or the Super Admin marks any chat, without holding it; the SQL and chat_case_events are as before', async () => {
    await restart();                                       // presence starts empty
    at(ist(15, 0));
    known({ id: 'r9', status: 'human_needed' });
    const s0 = db.stmts.length;
    const r = await patch('rahul', 'r9', { caseKind: 'refund' });
    status(r, 200);
    deq(pick(r.body, ['success', 'case_kind', 'case_marked_by', 'case_order_id', 'status']), { success: true, case_kind: 'refund', case_marked_by: 'Rahul', case_order_id: '#r9', status: 'agent_handling' });
    eq(C('r9').assigned_to, null, 'marking never claims');
    const ce = db.caseEvents.filter((e) => e.conversation_id === 'r9');
    deq(ce.map((e) => [e.site_id, e.kind, e.action, e.order_id, e.actor, e.actor_role]), [['S1', 'refund', 'mark', '#r9', 'Rahul', 'manager']]);
    ok(UUID.test(ce[0].id));
    const [tx] = txStmts(s0);
    ok(tx.includes(OLD_CASE_SQL.mark) && tx.includes(OLD_CASE_SQL.eventMark));
    deq(evs('r9', 'case_mark')[0].meta, { tier: 'senior', case: 'refund' });
    deq([evs('r9', 'status')[0].actor, evs('r9', 'status')[0].reason], [RAHUL, 'case']);
    known({ id: 'r9o', status: 'ai_handling' });
    status(await patch('owner', 'r9o', { caseKind: 'reship' }), 200);
    deq(evs('r9o', 'case_mark')[0].meta, { tier: 'owner', case: 'reship' });
    newConv({ id: 'r9v' });
    eq((await patch('rahul', 'r9v', { caseKind: 'refund' })).body.error, 'Only a verified customer can be marked for a refund or to ship again');
  });

  await t('R9 a junior marks only while every senior has been away 30+ min, 10:00-19:30', async () => {
    at(ist(15, 5));                                        // Rahul was seen at 15:00 (his mark)
    let r = await patch('anurag', 'r9', { caseKind: 'reship' });
    status(r, 403);
    eq(r.body.error, 'A senior marks Refund / Ship again. You can mark it while no senior has been in ShipTrack for 30 minutes (10:00-19:30).');
    eq(C('r9').case_kind, 'refund');
    let g = await thread('anurag', 'r9');
    deq([g.body.staff.can_mark_case, g.body.staff.mark_override, g.body.staff.mark_note], [false, false, 'A senior marks this. You can mark it while no senior has been in ShipTrack for 30 minutes (10:00-19:30).']);
    at(ist(15, 31));
    g = await thread('anurag', 'r9');
    deq([g.body.staff.can_mark_case, g.body.staff.mark_override, g.body.staff.mark_note], [true, true, 'Rahul not seen for 31 min: you can mark Refund / Ship again']);
    r = await patch('anurag', 'r9', { caseKind: 'reship' });
    status(r, 200);
    deq(db.caseEvents.filter((e) => e.conversation_id === 'r9').slice(-2).map((e) => [e.kind, e.action, e.actor, e.actor_role]), [['refund', 'remove', 'Anurag', 'agent'], ['reship', 'mark', 'Anurag', 'agent']]);
    deq(evs('r9', 'case_mark').pop().meta, { tier: 'junior', case: 'reship', from_case: 'refund', override: 'senior_away' });
    // Remove: anyone with chat.cases, any time.
    at(ist(21, 0));
    r = await patch('anurag', 'r9', { caseKind: null });
    status(r, 200);
    deq([r.body.case_kind, r.body.status, C('r9').status], [null, 'human_needed', 'human_needed']);
    deq(evs('r9', 'case_remove')[0].meta, { tier: 'junior', case: 'reship' });
    // At night nobody is away: a junior waits for the morning.
    status(await patch('anurag', 'r9', { caseKind: 'refund' }), 403);
    // 10:20 the next day, Rahul not seen since yesterday: 20 minutes is not away yet.
    at(ist(10, 20, 2));
    status(await patch('anurag', 'r9', { caseKind: 'refund' }), 403);
    at(ist(10, 30, 2));
    eq((await thread('anurag', 'r9')).body.staff.mark_note, 'Rahul not seen for 30 min: you can mark Refund / Ship again');
    // Rahul is back and marks; Anurag switching it while he is around is a mark too: 403.
    at(ist(10, 40, 2));
    status(await patch('rahul', 'r9', { caseKind: 'refund' }), 200);
    status(await patch('anurag', 'r9', { caseKind: 'reship' }), 403);
    eq(C('r9').case_kind, 'refund');
    // A junior re-marking the same kind is still the gate's call (the gate runs before the lock).
    status(await patch('anurag', 'r9', { caseKind: 'refund' }), 403);
  });

  await t('R9 while nobody has the Senior tick: today\'s rule, chat.cases is enough, day and night', async () => {
    const rahul = db.team.find((u) => u.id === RAHUL);
    rahul.permissions = rahul.permissions.filter((x) => x !== 'chat.senior');
    await mod.auth.refreshTeamCache(true);
    at(ist(15, 0, 2)); touch('rahul', ist(14, 59, 2));
    let r = await patch('anurag', 'r9', { caseKind: 'reship' });
    status(r, 200);
    deq(evs('r9', 'case_mark').pop().meta, { tier: 'junior', case: 'reship', from_case: 'refund' });
    at(ist(21, 0, 2));
    status(await patch('anurag', 'r9', { caseKind: 'refund' }), 200);
    const g = await thread('anurag', 'r9');
    deq([g.body.staff.can_mark_case, g.body.staff.mark_override, g.body.staff.mark_note], [true, false, null]);
    // And Rahul (no tick now) cannot take Anurag's chat.
    known({ id: 'r9t', status: 'agent_handling', assigned_to: ANURAG });
    status(await takeFrom('rahul', 'r9t'), 409);
    rahul.permissions.push('chat.senior');
    await mod.auth.refreshTeamCache(true);
    eq((await thread('rahul', 'r9t')).body.staff.take, 'senior');
  });

  // ── R10-R12: races, locks, a broken log ───────────────────────
  await t('R10 two replies or two Take overs at once on a free chat: one wins, the other gets 409', async () => {
    at(ist(16, 0, 2));
    known({ id: 'r10', status: 'human_needed' });
    const w0 = db.lockWaits;
    const rs = await Promise.all([reply('anurag', 'r10', 'Reply A'), reply('rahul', 'r10', 'Reply B')]);
    deq(rs.map((r) => r.status).sort(), [200, 409]);
    ok(db.lockWaits > w0, 'the second reply waited for the first one\'s lock');
    const winner = rs[0].status === 200 ? ANURAG : RAHUL;
    eq(C('r10').assigned_to, winner);
    eq(agentMsgs('r10').length, 1);
    eq(evs('r10', 'claim').length, 1);
    known({ id: 'r10b', status: 'human_needed' });
    const ts2 = await Promise.all([takeOver('rahul', 'r10b'), takeOver('anurag', 'r10b')]);
    deq(ts2.map((r) => r.status).sort(), [200, 409]);
    eq(evs('r10b', 'claim').length, 1);
    // The Super Admin and a member at once: whoever locks first claims it; the Super Admin may act on
    // a member's chat, so both may succeed, but the chat gets exactly one holder and one claim.
    known({ id: 'r10c', status: 'human_needed' });
    const ts3 = await Promise.all([reply('owner', 'r10c', 'Owner here'), reply('anurag', 'r10c', 'Anurag here')]);
    eq(evs('r10c', 'claim').length, 1);
    eq(C('r10c').assigned_to, evs('r10c', 'claim')[0].to_owner);
    eq(agentMsgs('r10c').length, ts3.filter((r) => r.status === 200).length);
  });

  await t('R11 a lock held too long (55P03) or a deadlock (40P01): 409 "try again", nothing saved', async () => {
    known({ id: 'r11', status: 'human_needed' });
    const before = clone(C('r11')), e0 = db.events.length, m0 = db.messages.length;
    const let_go = holdLock('r11');
    const busy = 'Someone else is changing this chat right now. Try again.';
    for (const [label, call] of [
      ['reply', () => reply('anurag', 'r11')],
      ['take over', () => takeOver('anurag', 'r11')],
      ['close', () => patch('anurag', 'r11', { status: 'resolved' })],
      ['transfer', () => patch('anurag', 'r11', { transferTo: RAHUL, note: 'for the senior' })],
      ['mark', () => patch('rahul', 'r11', { caseKind: 'refund' })],
    ]) {
      const r = await call();
      status(r, 409, label);
      eq(r.body.error, busy, label);
    }
    let_go();
    deq(C('r11'), before);
    deq([db.events.length, db.messages.length], [e0, m0]);
    db.fail.push({ re: /FOR NO KEY UPDATE$/, code: '40P01', once: true });
    const r = await reply('anurag', 'r11');
    status(r, 409);
    eq(r.body.error, busy);
    deq(C('r11'), before);
    status(await reply('anurag', 'r11'), 200);             // and then it works
  });

  await t('R12 chat_events broken: a reply is still saved; a transfer (its note lives there) is not', async () => {
    known({ id: 'r12', status: 'human_needed' });
    db.eventsBroken = true;
    const l0 = logged.length;
    const r = await reply('anurag', 'r12');
    status(r, 200);
    deq([agentMsgs('r12').length, C('r12').status, C('r12').assigned_to], [1, 'agent_handling', ANURAG]);
    eq(evs('r12').length, 0);
    const secret = 'customer said private things here';
    const t1 = await patch('anurag', 'r12', { transferTo: RAHUL, note: secret });
    status(t1, 500);
    deq([C('r12').assigned_to, C('r12').status], [ANURAG, 'agent_handling']);
    const out = logged.slice(l0).join('\n');
    ok(/claim event not logged/.test(out) && /reply event not logged/.test(out));
    ok(!out.includes(secret), 'a note never reaches the logs');
    db.eventsBroken = false;
    status(await patch('anurag', 'r12', { transferTo: RAHUL, note: secret }), 200);
    eq(C('r12').assigned_to, RAHUL);
  });

  // ── R13: right after a restart ────────────────────────────────
  await t('R13 restart, team list not read: actions answer 503 after the wait; a read shows a stored holder as held', async () => {
    known({ id: 'r13', status: 'agent_handling', assigned_to: RAHUL });
    known({ id: 'r13f', status: 'human_needed' });
    db.messages.push({ id: 'r13m', conversation_id: 'r13', sender: 'agent', content: 'hello', metadata: { agent: 'rahul' }, created_at: nowIso() });
    let open; db.teamGate = new Promise((r) => { open = r; });
    fresh();
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 1000 ? ms / 100 : ms, ...a);   // 3 s = 30 ms
    try {
      const starting = 'ShipTrack is starting. Try again in a moment.';
      for (const [label, call] of [
        ['reply', () => reply('anurag', 'r13f')],
        ['patch', () => takeOver('anurag', 'r13f')],
        ['transfer', () => patch('rahul', 'r13', { transferTo: 'owner', note: 'for the owner' })],
        ['release', () => release('owner')],
      ]) {
        const r = await call();
        status(r, 503, label);
        eq(r.body.error, starting, label);
      }
      eq(C('r13f').assigned_to, null);
      const g = await thread('anurag', 'r13');
      status(g, 200);
      deq(g.body.staff.holder, { key: RAHUL, name: 'a team member', senior: true, owner: false, away_min: null });
      deq([g.body.staff.me, g.body.staff.can_act, g.body.staff.claims, g.body.staff.take, g.body.staff.transfer_to], [ANURAG, false, false, null, []]);
      eq(g.body.messages.find((x) => x.id === 'r13m').author, null);     // "Team" until the names are known
      const l = await list('anurag', '?mine=1');
      status(l, 200);
      deq([l.body.me, l.body.team.map((x) => x.key)], [ANURAG, ['owner']]);
    } finally {
      global.setTimeout = realSetTimeout;
      db.teamGate = null; open();
    }
    await mod.auth.refreshTeamCache();
    status(await reply('anurag', 'r13f'), 200);
    eq(C('r13f').assigned_to, ANURAG);
    eq((await thread('anurag', 'r13')).body.staff.holder.name, 'Rahul');
  });

  await t('R13 restart, logins read but presence not yet: nobody is away (no junior mark, no away take) until it is', async () => {
    // The logins are read first; staff_presence after them, and here it fails (not the "table
    // missing" case). Everyone would look unseen since 10:00, so Rahul, here a minute ago, would
    // look away 5 hours: a restart must give no extra rights.
    known({ id: 'r13p', status: 'agent_handling', assigned_to: RAHUL });
    known({ id: 'r13q', status: 'human_needed' });
    db.waiting.r13p = true;
    at(ist(15, 0, 4));
    const fail = { re: /^SELECT actor, last_seen_at FROM staff_presence$/, code: 'XX000', message: 'server closed the connection' };
    db.fail.push(fail);
    try {
      await restart();
      ok(mod.auth.teamLoaded() && !mod.auth.presenceRead());
      let r = await patch('anurag', 'r13q', { caseKind: 'refund' });
      status(r, 403, 'junior mark');
      eq(r.body.error, 'A senior marks Refund / Ship again. You can mark it while no senior has been in ShipTrack for 30 minutes (10:00-19:30).');
      r = await takeFrom('anurag', 'r13p');
      status(r, 409, 'away take');
      eq(r.body.error, "Nothing to take: Rahul's chat cannot be taken by you.");
      const g = (await thread('anurag', 'r13p')).body.staff;
      deq([g.holder.away_min, g.take, g.can_mark_case, g.mark_override], [null, null, false, false]);
      ok((await list('anurag')).body.team.every((x) => x.away_min === null), 'nobody shown away');
      deq([C('r13p').assigned_to, C('r13q').case_kind], [RAHUL, null]);
    } finally {
      db.fail.splice(db.fail.indexOf(fail), 1);
    }
    // Read once (Rahul really not seen today): the away rules apply again.
    await mod.auth.refreshTeamCache();
    ok(mod.auth.presenceRead());
    status(await takeFrom('anurag', 'r13p'), 200);
    eq(C('r13p').assigned_to, ANURAG);
    eq(evs('r13p', 'take').pop().meta.take, 'holder_away');
    status(await patch('anurag', 'r13q', { caseKind: 'refund' }), 200);
    eq(evs('r13q', 'case_mark').pop().meta.override, 'senior_away');
  });

  // ── R14: presence ─────────────────────────────────────────────
  await t('R14 presence: a POST or an active GET counts, a background GET does not; one upsert per reload', async () => {
    await restart();
    const a = mod.auth;
    at(ist(11, 0, 2));
    const ins = () => db.stmts.filter((x) => x.q.startsWith('INSERT INTO staff_presence')).length;
    const sel = () => db.stmts.filter((x) => x.q === 'SELECT actor, last_seen_at FROM staff_presence').length;
    ok(a.getAuthFromRequest(req('rahul', undefined, { method: 'GET' })));
    eq(a.lastSeenMs(RAHUL), null);
    ok(a.getAuthFromRequest(req('rahul', undefined, { method: 'GET', active: true })));
    eq(a.lastSeenMs(RAHUL), ist(11, 0, 2));
    at(ist(11, 5, 2));
    ok(a.getAuthFromRequest(req('anurag', undefined, { method: 'PATCH' })));
    ok(a.getAuthFromRequest(req('owner', undefined, { method: 'DELETE' })));
    deq([a.lastSeenMs(ANURAG), a.lastSeenMs('owner')], [ist(11, 5, 2), ist(11, 5, 2)]);
    // A token that is no longer good is not anyone's presence.
    const stale = a.generateToken('anurag', 'agent', null, { sv: 1, uid: ANURAG });
    tokens.stale = stale;
    eq(a.getAuthFromRequest(req('stale', undefined, { method: 'POST' })), null);
    let i0 = ins();
    await a.refreshTeamCache(true);
    eq(ins(), i0 + 1, 'one upsert for everyone seen since the last reload');
    deq(db.presence.map((x) => x.actor).sort(), [RAHUL, ANURAG, 'owner'].sort());
    i0 = ins();
    await a.refreshTeamCache(true);
    eq(ins(), i0, 'nothing new: no upsert');
    // Read back: what another process saved counts (the newer of the two).
    db.presence.push({ actor: PRIYA, last_seen_at: new Date(ist(10, 50, 2)).toISOString() });
    await a.refreshTeamCache(true);
    eq(a.lastSeenMs(PRIYA), ist(10, 50, 2));
  });

  await t('R14 staff_presence missing (chat-team.sql not applied): logins still work, asked again only after 10 min', async () => {
    const a = mod.auth;
    db.presenceMissing = true;
    at(ist(12, 0, 2));
    ok(a.getAuthFromRequest(req('anurag', undefined, { method: 'POST' })));
    const s0 = db.stmts.length;
    await a.refreshTeamCache(true);
    ok(a.teamLoaded());
    ok(a.getAuthFromRequest(req('rahul', undefined, { method: 'POST' })));
    const asked = () => since(s0).filter((x) => /staff_presence/.test(x.q)).length;
    eq(asked(), 1);
    at(ist(12, 9, 2));
    await a.refreshTeamCache(true);
    eq(asked(), 1, 'not asked again within 10 minutes');
    db.presenceMissing = false;
    at(ist(12, 11, 2));
    await a.refreshTeamCache(true);
    ok(asked() >= 2);
    ok(Date.parse(db.presence.find((x) => x.actor === ANURAG).last_seen_at) === ist(12, 0, 2), 'the kept presence was saved once the table exists');
  });

  // ── R15: the list ─────────────────────────────────────────────
  await t('R15 the list: My chats, the unanswered count unchanged, the order unchanged, the team directory', async () => {
    at(ist(16, 0, 2));
    let r = await list('anurag', '?mine=1');
    status(r, 200);
    const L = db.list;
    const mineCond = L.sql.match(/c\.assigned_to = \$(\d+) AND c\.status IN \('human_needed', 'agent_handling'\)/);
    ok(mineCond, 'My chats condition');
    eq(L.params[Number(mineCond[1]) - 1], ANURAG);
    ok(L.sql.includes(OUTSIDE_SECTION) && L.sql.includes('c.merged_into IS NULL'));
    ok(/ORDER BY g\.last_message_at DESC NULLS LAST, g\.created_at DESC LIMIT \$\d+$/.test(L.sql), 'newest activity first, as before');
    ok(L.sql.includes('WINDOW w AS (PARTITION BY f.site_id, f.group_key ORDER BY f.last_message_at DESC NULLS LAST, f.created_at DESC, f.id)'));
    ok(L.sql.includes('g.assigned_to, g.assigned_at'));
    eq((L.unansweredSql.match(/count\(DISTINCT x\.gk\) FILTER \(WHERE/g) || []).length, 3);
    ok(!/\) x WHERE/.test(L.unansweredSql), 'no outer WHERE: n is the number it always was');
    ok(L.unansweredSql.includes(`c.status <> 'resolved' AND ${OUTSIDE_SECTION}`));
    eq(L.unansweredParams[L.unansweredParams.length - 1], ANURAG);
    deq([r.body.me, r.body.unanswered_total, r.body.mine, r.body.office_open], [ANURAG, 4, { open: 2, waiting: 1, held: 0 }, true]);
    ok(!db.stmts.some((x) => x.q.startsWith('SELECT count(*)::int AS n FROM conversations WHERE assigned_to')), 'held is asked for the Super Admin only');
    deq(r.body.team.map((x) => [x.key, x.name, x.senior, x.owner]), [[RAHUL, 'Rahul', true, false], [ANURAG, 'Anurag', false, false], [PRIYA, 'Priya', false, false], ['owner', 'Super Admin', false, true]]);
    for (const e of r.body.team) deq(Object.keys(e).sort(), ['away_min', 'key', 'name', 'owner', 'seen_min', 'senior']);
    // Without mine, and in a search, no holder condition.
    r = await list('anurag');
    ok(!/c\.assigned_to = \$/.test(db.list.sql));
    r = await list('anurag', '?mine=1&q=order%201234');
    ok(!/c\.assigned_to = \$/.test(db.list.sql));
    r = await list('owner', '?mine=1');
    deq([r.body.me, db.list.unansweredParams, db.list.heldParams], ['owner', ['owner'], ['owner']]);
    eq(r.body.mine.held, db.convs.filter((c) => c.assigned_to === 'owner' && c.status !== 'resolved' && !c.merged_into).length);
    at(ist(21, 0, 2));
    eq((await list('owner')).body.office_open, false);
    const v = await list('viewer', '?mine=1');
    status(v, 200);
    eq(v.body.me, VIEWER);
  });

  // ── R16: the widget never gets the staff username ─────────────
  await t('R16 the widget\'s messages: no metadata.agent; files and captionless kept; a deleted message carries nothing', async () => {
    newConv({ id: 'r16', status: 'agent_handling' });
    const files = [{ id: 'f'.repeat(64), url: '/api/widget/files/x', name: 'label.png', mimeType: 'image/png', size: 10, kind: 'image', status: 'sent' }];
    db.messages.push(
      { id: 'w1', conversation_id: 'r16', sender: 'visitor', content: 'where is my order', metadata: null, created_at: '2026-10-02T10:00:00.000Z' },
      { id: 'w2', conversation_id: 'r16', sender: 'agent', content: '📎 label.png', metadata: { agent: 'anurag', attachments: files, captionless: true }, created_at: '2026-10-02T10:01:00.000Z' },
      { id: 'w3', conversation_id: 'r16', sender: 'agent', content: 'gone', metadata: { agent: 'rahul' }, created_at: '2026-10-02T10:02:00.000Z', deleted_at: '2026-10-02T10:03:00.000Z' },
      { id: 'w4', conversation_id: 'r16', sender: 'tool_result', content: '{}', metadata: { hidden: true }, created_at: '2026-10-02T10:01:30.000Z' },
    );
    const get = (qs) => mod.widgetMessages.GET(req(null, undefined, { method: 'GET', url: 'http://x/api/widget/messages/r16?siteKey=key-s1' + qs }), { params: { conversationId: 'r16' } });
    let r = await get('');
    status(r, 200);
    deq(Object.keys(r.body).sort(), ['conversationId', 'messages', 'siteName', 'status']);
    deq(r.body.messages.map((x) => x.id), ['w1', 'w2']);
    deq(r.body.messages[1].metadata, { attachments: files, captionless: true });
    ok(r.body.messages.every((x) => !x.metadata || !('agent' in x.metadata)));
    eq(r.headers['Access-Control-Allow-Origin'], '*');
    r = await get('&since=2026-10-02T09:00:00.000Z&changes=1');
    const gone = r.body.messages.find((x) => x.id === 'w3');
    deq([gone.deleted, gone.content, gone.metadata], [true, '', null]);
    eq(db.messages.find((x) => x.id === 'w2').metadata.agent, 'anurag');   // still stored for the team
    status(await mod.widgetMessages.GET(req(null, undefined, { method: 'GET', url: 'http://x/api/widget/messages/r16?siteKey=key-s2' }), { params: { conversationId: 'r16' } }), 403);
  });

  // ── R17: merging two chats of one customer ────────────────────
  await t('R17 a merge: a target nobody holds takes the merged chat\'s holder (merge event); a held target keeps its own', async () => {
    known({ id: 'm-t1', customer_key: 'K17', status: 'resolved' });
    known({ id: 'm-f1', customer_key: 'K17', status: 'agent_handling', assigned_to: ANURAG });
    eq(await mod.merge.mergeChats('m-t1', 'm-f1'), true);
    deq([C('m-t1').assigned_to, !!C('m-t1').assigned_at, C('m-f1').merged_into, C('m-f1').status], [ANURAG, true, 'm-t1', 'resolved']);
    const ev = evs('m-t1', 'merge');
    eq(ev.length, 1);
    deq(pick(ev[0], ['actor', 'actor_name', 'from_owner', 'to_owner', 'reason', 'meta']), { actor: 'system', actor_name: 'System', from_owner: null, to_owner: ANURAG, reason: 'merge', meta: { merged_from: 'm-f1' } });
    known({ id: 'm-t2', customer_key: 'K18', status: 'agent_handling', assigned_to: RAHUL });
    known({ id: 'm-f2', customer_key: 'K18', status: 'agent_handling', assigned_to: ANURAG });
    eq(await mod.merge.mergeChats('m-t2', 'm-f2'), true);
    eq(C('m-t2').assigned_to, RAHUL);
    eq(evs('m-t2', 'merge').length, 0);
    known({ id: 'm-t3', customer_key: 'K19' }); known({ id: 'm-f3', customer_key: 'K19' });
    eq(await mod.merge.mergeChats('m-t3', 'm-f3'), true);
    deq([C('m-t3').assigned_to, evs('m-t3', 'merge').length], [null, 0]);
  });

  // ── R18-R19: what the thread shows ────────────────────────────
  await t('R18 the thread: staff names today ("Super Admin" for his logins, old or new) and the staff block for each person', async () => {
    at(ist(16, 0, 2)); touch('anurag', ist(15, 59, 2));
    known({ id: 'r18', status: 'agent_handling', assigned_to: ANURAG, customer_key: 'K18x', unread_count: 2 });
    known({ id: 'r18old', status: 'resolved', customer_key: 'K18x', older: true });
    db.messages.push(
      { id: 'a1', conversation_id: 'r18', sender: 'agent', content: 'one', metadata: { agent: 'anurag' }, created_at: nowIso() },
      { id: 'a2', conversation_id: 'r18', sender: 'agent', content: 'two', metadata: { agent: 'Owner' }, created_at: nowIso() },
      { id: 'a3', conversation_id: 'r18', sender: 'agent', content: 'three', metadata: { agent: 'Aaditya' }, created_at: nowIso() },
      { id: 'a4', conversation_id: 'r18', sender: 'ai', content: 'ai text', metadata: null, created_at: nowIso() },
      { id: 'a5', conversation_id: 'r18', sender: 'visitor', content: 'hi', metadata: null, created_at: nowIso() },
      { id: 'a6', conversation_id: 'r18old', sender: 'agent', content: 'earlier', metadata: { agent: 'rahul' }, created_at: nowIso() },
    );
    const g = await thread('rahul', 'r18');
    status(g, 200);
    deq(g.body.messages.map((x) => [x.id, x.author]), [['a1', 'Anurag'], ['a2', 'Super Admin'], ['a3', 'Super Admin'], ['a4', undefined], ['a5', undefined]]);
    deq(g.body.earlier[0].messages.map((x) => x.author), ['Rahul']);
    deq(pick(g.body.conversation, ['assigned_to', 'merged_into']), { assigned_to: ANURAG, merged_into: null });
    ok(g.body.conversation.assigned_at !== undefined);
    deq(g.body.staff, {
      me: RAHUL, holder: { key: ANURAG, name: 'Anurag', senior: false, owner: false, away_min: null },
      can_act: false, claims: false, take: 'senior', transfer_to: [], can_mark_case: true, mark_override: false, mark_note: null, office_open: true,
    });
    const ga = (await thread('anurag', 'r18')).body.staff;
    deq([ga.me, ga.can_act, ga.claims, ga.take, ga.transfer_to.map((x) => x.key)], [ANURAG, true, false, null, [RAHUL, 'owner']]);
    const go = (await thread('owner', 'r18')).body.staff;
    deq([go.me, go.can_act, go.claims, go.take, go.transfer_to.map((x) => x.key), go.can_mark_case], ['owner', true, false, 'owner', [RAHUL, 'owner', null], true]);
    const gv = (await thread('viewer', 'r18')).body.staff;
    deq([gv.me, gv.can_act, gv.claims, gv.take, gv.transfer_to, gv.can_mark_case, gv.mark_note], [VIEWER, false, false, null, [], false, null]);
    known({ id: 'r18f' });
    const gf = (await thread('anurag', 'r18f')).body.staff;
    deq([gf.holder, gf.can_act, gf.claims, gf.take], [null, true, true, null]);
    eq(C('r18').unread_count, 0);
  });

  await t('R18 a reply keeps its writer after the owner renames or removes them (named by its reply event, not the username)', async () => {
    at(ist(16, 30, 2));
    known({ id: 'r18n', status: 'human_needed', customer_key: 'K18n' });
    known({ id: 'r18n0', status: 'resolved', customer_key: 'K18n', older: true });
    status(await reply('anurag', 'r18n0'), 200);           // an earlier chat of the customer, shown under "earlier"
    status(await reply('anurag', 'r18n', 'Checking your order'), 200);
    status(await reply('owner', 'r18n', 'I am looking too'), 200);
    const [mA, mO] = agentMsgs('r18n'), [mE] = agentMsgs('r18n0');
    const authors = async () => {
      const b = (await thread('rahul', 'r18n')).body;
      return [...b.earlier.flatMap((c) => c.messages), ...b.messages].filter((x) => x.sender === 'agent').map((x) => [x.id, x.author, x.author_key]);
    };
    deq(await authors(), [[mE.id, 'Anurag', ANURAG], [mA.id, 'Anurag', ANURAG], [mO.id, 'Super Admin', 'owner']]);
    const saved = clone(db.team);
    try {
      // Renamed (login and name): his replies follow him, never "Super Admin".
      Object.assign(db.team.find((u) => u.id === ANURAG), { username: 'anurag.k', display_name: 'Anurag Kumar' });
      await mod.auth.refreshTeamCache();
      deq(await authors(), [[mE.id, 'Anurag Kumar', ANURAG], [mA.id, 'Anurag Kumar', ANURAG], [mO.id, 'Super Admin', 'owner']]);
      // Removed, and a new member later given the old username: the name he had when he wrote them.
      db.team = db.team.filter((u) => u.id !== ANURAG);
      db.team.push(member('77777777-7777-4777-8777-777777777777', 'anurag', 'Naveen', 'agent', [...CHAT_PERMS]));
      await mod.auth.refreshTeamCache();
      deq(await authors(), [[mE.id, 'Anurag', ANURAG], [mA.id, 'Anurag', ANURAG], [mO.id, 'Super Admin', 'owner']]);
    } finally {
      db.team = saved;
      await mod.auth.refreshTeamCache();
    }
    // A reply whose event could not be logged (or from before chat-team.sql): the username, as before.
    db.messages.push({ id: 'r18n-x', conversation_id: 'r18n', sender: 'agent', content: 'x', metadata: { agent: 'rahul' }, created_at: nowIso() });
    deq((await authors()).pop(), ['r18n-x', 'Rahul', null]);
  });

  await t('R19 a merged shell on a stale screen: every action is a 409 "open the other chat"; the thread is read only', async () => {
    known({ id: 'r19', status: 'resolved', merged_into: 'r18' });
    const msg = "This chat was merged into the customer's other chat. Open that one.";
    for (const [label, call] of [
      ['reply', () => reply('anurag', 'r19')],
      ['take over', () => takeOver('anurag', 'r19')],
      ['take from', () => takeFrom('owner', 'r19')],
      ['transfer', () => patch('owner', 'r19', { transferTo: RAHUL, note: 'stale screen' })],
      ['mark', () => patch('rahul', 'r19', { caseKind: 'refund' })],
    ]) {
      const r = await call();
      status(r, 409, label);
      eq(r.body.error, msg, label);
    }
    const s = (await thread('owner', 'r19')).body.staff;
    deq([s.can_act, s.claims, s.take, s.transfer_to], [false, false, null, []]);
    eq(agentMsgs('r19').length, 0);
  });

  // ── R20: the night line in the widget (commit A) ──────────────
  await t('R20 the widget\'s hand-over lines: day exactly as before, night says the morning, visitors and guard texts untouched', async () => {
    known({ id: 'r20' });
    newConv({ id: 'r20v' });
    const send = async (id, said, ai, ms) => {
      at(ms);
      C(id).status = 'ai_handling';
      global.__ai.next = ai;
      const r = await mod.widgetMessage.POST(req(null, { conversationId: id, siteKey: 'key-s1', content: said }));
      status(r, 201);
      return r.body.aiResponse ? r.body.aiResponse.content : null;
    };
    const fraud = 'This is a fraud site, you people are scammers';
    const aiFraud = 'I understand your concern. Your order is In Transit, track it here: https://shiptrack.store/track/abc. Our team will look into this and reply within 1 hour.';
    // 22:00: the hour promise goes, the morning line comes; a person takes it.
    let out = await send('r20', fraud, { content: aiFraud }, ist(22, 0, 2));
    eq(out, 'I understand your concern. Your order is In Transit, track it here: https://shiptrack.store/track/abc.\n\nOur team will reply to you here in this chat tomorrow morning, after 10 AM.');
    ok(!/1 hour/.test(out));
    eq(C('r20').status, 'human_needed');
    // 14:00: exactly what the widget sent before the night line.
    out = await send('r20', fraud, { content: aiFraud }, ist(14, 0, 2));
    eq(out, `${aiFraud}\n\n${esc.teamWillReplyLine(fraud)}`);
    eq(out, `${aiFraud}\n\nOur team will reply to you here in this chat within 1 hour.`);
    // 08:00 refund: "this morning", the line always added, never next to a 24-hour promise.
    const refund = 'I want a refund for my order';
    out = await send('r20', refund, { content: 'Sure, I can help with that.' }, ist(8, 0, 3));
    eq(out, "Sure, I can help with that.\n\nI've noted your refund or cancellation request. Our team will reply to you here in this chat this morning, after 10 AM.");
    out = await send('r20', refund, { content: 'Your refund request is with our team, they will reply within 24 hours.' }, ist(8, 0, 3));
    eq(out, "I've noted your refund or cancellation request. Our team will reply to you here in this chat this morning, after 10 AM.");
    // By day a reply that already says 24 hours stays as it was (before: no line added).
    out = await send('r20', refund, { content: 'Your refund request is with our team, they will reply within 24 hours.' }, ist(14, 0, 3));
    eq(out, 'Your refund request is with our team, they will reply within 24 hours.');
    out = await send('r20', 'mujhe refund chahiye', { content: 'Theek hai.' }, ist(23, 0, 3));
    eq(out, 'Theek hai.\n\nAapki refund ya cancellation ki request maine note kar li hai. Hamari team kal subah 10 baje ke baad isi chat mein aapko jawab degi.');
    // A threat at night: the fixed reply, no AI text, the morning line.
    const calls = global.__ai.calls.length;
    out = await send('r20', 'I will file a police complaint against you', { content: 'should not be used' }, ist(22, 30, 3));
    eq(out, "I'm really sorry for the trouble, and this matters to us. I've passed it to our team right now. Our team will reply to you here in this chat tomorrow morning, after 10 AM.");
    eq(global.__ai.calls.length, calls);
    // A visitor at night: the AI's own words, no team line, nobody moves the chat.
    out = await send('r20v', fraud, { content: aiFraud }, ist(22, 0, 3));
    eq(out, aiFraud);
    eq(C('r20v').status, 'ai_handling');
    // The guard's fixed hand-over texts come back exactly as written, day and night.
    const guard = fs.readFileSync(path.join(SRC, 'lib/chat/lookup-guard.ts'), 'utf8');
    const handOver = Object.values(Function('return ' + guard.match(/const HAND_OVER = (\{[\s\S]*?\n\});/)[1])());
    const oldHandOver = Function('return ' + guard.match(/const OLD_HAND_OVER = (\[[\s\S]*?\n\]);/)[1])();
    for (const text of [...handOver, ...oldHandOver]) {
      eq(await send('r20', 'where is my order', { content: text, escalated: true }, ist(22, 0, 3)), text);
      eq(await send('r20', 'where is my order', { content: text, escalated: true }, ist(14, 0, 3)), text);
    }
    // An AI hand-over that promised an hour, at night: the morning line instead.
    out = await send('r20', 'where is my order', { content: 'I have passed this to our team, they will reply within 1 hour.', escalated: true }, ist(22, 0, 3));
    eq(out, 'Our team will reply to you here in this chat tomorrow morning, after 10 AM.');
  });

  // ── R21: "Give all my open chats to the team" (owner answer 3) ─
  await t('R21 release: Super Admin only; only his open chats go back to the pool, status unchanged, one transfer event each', async () => {
    at(ist(17, 0, 3));
    known({ id: 'rel1', status: 'agent_handling', assigned_to: 'owner' });
    known({ id: 'rel2', status: 'human_needed', assigned_to: 'owner' });
    known({ id: 'rel3', status: 'ai_handling', assigned_to: 'owner' });
    known({ id: 'rel4', status: 'resolved', assigned_to: 'owner' });                                  // Closed: keeps him
    known({ id: 'rel5', status: 'agent_handling', assigned_to: 'owner', merged_into: 'rel1' });       // a merged shell: left alone
    known({ id: 'rel6', status: 'agent_handling', assigned_to: 'owner', case_kind: 'refund', case_order_id: '#rel6' });
    known({ id: 'rel7', status: 'agent_handling', assigned_to: ANURAG });
    known({ id: 'rel8', status: 'human_needed' });
    const mine = () => db.convs.filter((c) => c.assigned_to === 'owner' && c.status !== 'resolved' && !c.merged_into).map((c) => c.id).sort();
    const open = mine();
    ok(open.length >= 4 && ['rel1', 'rel2', 'rel3', 'rel6'].every((id) => open.includes(id)));
    const snapshot = clone(db.convs), e0 = db.events.length;
    for (const who of ['anurag', 'rahul', 'viewer']) {
      const r = await release(who);
      status(r, 403, who);
      eq(r.body.error, 'Only Super Admin can give his chats back to the team');
    }
    status(await release(null), 401);
    // A chat of his busy in another action: 409, nothing freed.
    const let_go = holdLock('rel2');
    let r = await release('owner');
    status(r, 409);
    eq(r.body.error, 'Someone else is changing this chat right now. Try again.');
    let_go();
    db.fail.push({ re: /^SELECT id, site_id, status FROM conversations WHERE assigned_to = \$1/, code: '40P01', once: true });
    status(await release('owner'), 409);
    deq(db.convs, snapshot);
    eq(db.events.length, e0);
    // The button's N ("Give all N to the team") is exactly what the release frees: every open chat he
    // holds, one by one (AI handling and Refund / Ship again too), not the customers in My chats.
    eq((await list('owner', '?mine=1')).body.mine.held, open.length);
    const s0 = db.stmts.length;
    r = await release('owner');
    status(r, 200);
    deq(r.body, { released: open.length });
    eq((await list('owner', '?mine=1')).body.mine.held, 0);
    for (const id of open) deq([C(id).assigned_to, C(id).assigned_at, C(id).status], [null, null, snapshot.find((c) => c.id === id).status], id);
    deq(['rel4', 'rel5', 'rel7', 'rel8'].map((id) => C(id).assigned_to), ['owner', 'owner', ANURAG, null]);
    const ev = db.events.slice(e0);
    eq(ev.length, open.length);
    for (const e of ev) {
      const was = snapshot.find((c) => c.id === e.conversation_id);
      deq(pick(e, ['kind', 'actor', 'actor_name', 'from_owner', 'to_owner', 'from_status', 'to_status', 'reason', 'note', 'meta']),
        { kind: 'transfer', actor: 'owner', actor_name: 'Super Admin', from_owner: 'owner', to_owner: null, from_status: was.status, to_status: was.status, reason: 'transfer', note: 'Released by Super Admin', meta: { tier: 'owner', bulk: true } });
    }
    deq(ev.map((e) => e.conversation_id).sort(), open);
    const tx = txStmts(s0);
    eq(tx.length, 1, 'one transaction');
    deq(tx[0].slice(0, 2), ['BEGIN', "SET LOCAL lock_timeout = '5s'"]);
    // Nothing left: 0. The team can now answer them; the history shows the release.
    deq((await release('owner')).body, { released: 0 });
    status(await reply('anurag', 'rel1'), 200);
    eq(C('rel1').assigned_to, ANURAG);
    const log = (await thread('rahul', 'rel2')).body.team_log[0];
    deq(pick(log, ['kind', 'note', 'from_name', 'to_name']), { kind: 'transfer', note: 'Released by Super Admin', from_name: 'Super Admin', to_name: null });
  });

  // ── R22: put back in the open pool on purpose stays there (trg_chat_inherit_owner) ─
  await t('R22 a released or "Nobody" chat is logged so the inherit trigger leaves it in the open pool', async () => {
    // The trigger itself is checked on the server (rolled-back trial). Here: (1) it keys on what the
    // routes write: every chat whose holder was cleared has a transfer to nobody naming it, by its
    // own id (release) or in meta.group (a "Nobody" transfer's other chats); (2) the SQL has the guard.
    at(ist(17, 30, 3));
    const K = '9000000222';
    known({ id: 'r22x', status: 'resolved', customer_key: K, assigned_to: 'owner' });           // Closed: keeps him
    known({ id: 'r22y', status: 'ai_handling', customer_key: K, assigned_to: 'owner' });         // his, AI answering
    known({ id: 'r22z', status: 'agent_handling', customer_key: '9000000223', assigned_to: ANURAG });
    known({ id: 'r22z2', status: 'ai_handling', customer_key: '9000000223', assigned_to: ANURAG });
    const emptied = (id) => db.events.some((e) => e.kind === 'transfer' && e.to_owner === null
      && (e.conversation_id === id || (Array.isArray(e.meta && e.meta.group) && e.meta.group.includes(id))));
    deq(['r22x', 'r22y', 'r22z', 'r22z2'].map(emptied), [false, false, false, false]);
    status(await release('owner'), 200);
    status(await patch('owner', 'r22z', { transferTo: null, note: 'Back to the team please' }), 200);
    deq(['r22x', 'r22y', 'r22z', 'r22z2'].map((id) => C(id).assigned_to), ['owner', null, null, null]);
    deq(['r22x', 'r22y', 'r22z', 'r22z2'].map(emptied), [false, true, true, true]);
    // Every chat with no holder that once had one got there this way (nothing else clears a holder).
    for (const c of db.convs) {
      if (c.assigned_to === null && db.events.some((e) => e.conversation_id === c.id && e.to_owner)) ok(emptied(c.id), 'cleared without a transfer to nobody: ' + c.id);
    }
    // The SQL: the guard comes before the sibling lookup, and an emptied latest chat means "nobody".
    const sql = fs.readFileSync(path.resolve(__dirname, '../../chat-team.sql'), 'utf8');
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION chat_inherit_owner()'), sql.indexOf('CREATE OR REPLACE TRIGGER trg_chat_inherit_owner'));
    const sel = fn.indexOf('SELECT o.assigned_to INTO prev');
    ok(sel > 0);
    ok(/IF EXISTS \(SELECT 1 FROM chat_events e\s+WHERE e\.kind = 'transfer' AND e\.to_owner IS NULL\s+AND \(e\.conversation_id = NEW\.id OR e\.meta->'group' \? NEW\.id\)\) THEN\s+RETURN NEW;/.test(fn.slice(0, sel)), 'guard before the lookup');
    ok(/OR \(o\.assigned_to IS NULL\s+AND EXISTS \(SELECT 1 FROM chat_events e\s+WHERE e\.kind = 'transfer' AND e\.to_owner IS NULL\s+AND \(e\.conversation_id = o\.id OR e\.meta->'group' \? o\.id\)\)\)\)/.test(fn.slice(sel)), 'an emptied sibling counts as held by nobody');
    ok(!/o\.assigned_to IS NOT NULL/.test(fn), 'emptied siblings are no longer skipped');
    ok(/CREATE INDEX IF NOT EXISTS chat_events_emptied_idx ON chat_events \(conversation_id\)\s+WHERE kind = 'transfer' AND to_owner IS NULL;/.test(sql));
    ok(/CREATE INDEX IF NOT EXISTS chat_events_message_idx ON chat_events \(message_id\) WHERE message_id IS NOT NULL;/.test(sql));
  });

  // ── R23: the Super Admin's customers go to the team (owner answer A5, 2026-10-02) ─
  // chat-team-owner-back.sql: (1) a returning customer whose latest held chat is his inherits nothing
  // (the SQL, below; the trigger itself runs in the rolled-back server trial); (2) trg_chat_owner_back,
  // played by the fake database: a Closed chat he holds that the CUSTOMER reopens goes to the open
  // pool, with one System transfer to nobody. His own reply / Take over / Hand to AI keeps it his.
  const emptiedChat = (id) => db.events.some((e) => e.kind === 'transfer' && e.to_owner === null
    && (e.conversation_id === id || (Array.isArray(e.meta && e.meta.group) && e.meta.group.includes(id))));
  const BACK_EVENT = (from, to) => ({ kind: 'transfer', actor: 'system', actor_name: 'System', from_owner: 'owner', to_owner: null,
    from_status: from, to_status: to, reason: 'owner_customer_back', note: null, meta: { auto: true } });
  const EV_KEYS = ['kind', 'actor', 'actor_name', 'from_owner', 'to_owner', 'from_status', 'to_status', 'reason', 'note', 'meta'];
  const customerSays = async (id, text, siteKey = 'key-s1') => {
    global.__ai.next = { content: 'Your order is on the way and should reach you in 2 days.' };
    const r = await mod.widgetMessage.POST(req(null, { conversationId: id, siteKey, content: text }));
    status(r, 201, id);
    return r;
  };

  await t('R23 the customer writes again in a Closed chat the Super Admin holds: it goes to the open pool, logged as a System transfer', async () => {
    at(ist(11, 0, 4));
    const old = new Date(clock - 86_400_000).toISOString();
    known({ id: 'r23a', status: 'resolved', assigned_to: 'owner', assigned_at: old, customer_key: '9000000231', closed_by_name: 'Super Admin' });
    const heldBefore = (await list('owner', '?mine=1')).body.mine.held;
    const e0 = db.events.length;
    await customerSays('r23a', 'hello, any update on my order?');
    deq([C('r23a').status, C('r23a').assigned_to, C('r23a').assigned_at], ['ai_handling', null, nowIso()]);
    const ev = db.events.slice(e0).filter((e) => e.conversation_id === 'r23a');
    deq(ev.map((e) => e.kind), ['transfer', 'status']);                       // the BEFORE trigger's row first
    deq(pick(ev[0], EV_KEYS), BACK_EVENT('resolved', 'ai_handling'));
    // The status trigger (AFTER) sees the final row: the customer reopened it, nobody holds it now.
    deq(pick(ev[1], ['actor', 'from_owner', 'to_owner', 'from_status', 'to_status']), { actor: 'customer', from_owner: 'owner', to_owner: null, from_status: 'resolved', to_status: 'ai_handling' });
    // The row trg_chat_inherit_owner keys on: the AI's next hand-off cannot give it back to him.
    ok(emptiedChat('r23a'));
    // His open chats are unchanged ("Give all N" counts the same); the reopened chat was never one of them.
    eq((await list('owner', '?mine=1')).body.mine.held, heldBefore);
    // The team sees why in the chat's history; nobody holds it, so a member may answer.
    const g = await thread('rahul', 'r23a');
    deq(pick(g.body.team_log[0], ['kind', 'actor', 'actor_name', 'from_name', 'to_name', 'reason', 'note']),
      { kind: 'transfer', actor: 'system', actor_name: 'System', from_name: 'Super Admin', to_name: null, reason: 'owner_customer_back', note: null });
    deq([g.body.staff.holder, g.body.staff.can_act], [null, true]);
    // The first member to reply gets it (an ordinary claim from the open pool).
    status(await reply('anurag', 'r23a', 'Hi, I am checking your order now'), 200);
    deq([C('r23a').assigned_to, C('r23a').status], [ANURAG, 'agent_handling']);
    deq(pick(evs('r23a', 'claim')[0], ['actor', 'from_owner', 'to_owner', 'reason']), { actor: ANURAG, from_owner: null, to_owner: ANURAG, reason: 'reply' });
    // Writing again in a chat that is open (not Closed) changes nothing: the trigger is for a reopen only.
    const e1 = db.events.length;
    await customerSays('r23a', 'ok');
    deq([C('r23a').assigned_to, db.events.slice(e1).filter((e) => e.kind === 'transfer').length], [ANURAG, 0]);
  });

  await t('R23 every way a customer reopens his Closed chat sends it to the pool (AI off, Refund / Ship again, merge); members\' and unheld chats are as before', async () => {
    at(ist(12, 0, 4));
    // A site with the AI off: Needs you, nobody holds it.
    siteOf('S1').ai_enabled = false;
    try {
      known({ id: 'r23off', status: 'resolved', assigned_to: 'owner', customer_key: '9000000232' });
      await customerSays('r23off', 'please call me back');
      deq([C('r23off').status, C('r23off').assigned_to], ['human_needed', null]);
      deq(pick(evs('r23off', 'transfer')[0], EV_KEYS), BACK_EVENT('resolved', 'human_needed'));
    } finally { siteOf('S1').ai_enabled = true; }
    // A Refund / Ship again chat of his: With team (no AI), nobody holds it.
    known({ id: 'r23case', status: 'resolved', assigned_to: 'owner', case_kind: 'refund', case_order_id: '#r23case', customer_key: '9000000233' });
    await customerSays('r23case', 'when will I get my refund?');
    deq([C('r23case').status, C('r23case').assigned_to, C('r23case').case_kind], ['agent_handling', null, 'refund']);
    deq(pick(evs('r23case', 'transfer')[0], EV_KEYS), BACK_EVENT('resolved', 'agent_handling'));
    // The customer's own merge (after proving an order) reopens his Closed chat: the pool, no merge event.
    known({ id: 'r23mt', customer_key: 'K23m', status: 'resolved', assigned_to: 'owner' });
    known({ id: 'r23mf', customer_key: 'K23m', status: 'ai_handling' });
    eq(await mod.merge.mergeChats('r23mt', 'r23mf'), true);
    deq([C('r23mt').status, C('r23mt').assigned_to, C('r23mf').merged_into, evs('r23mt', 'merge').length], ['ai_handling', null, 'r23mt', 0]);
    deq(pick(evs('r23mt', 'transfer')[0], EV_KEYS), BACK_EVENT('resolved', 'ai_handling'));
    // His OPEN chat merged into a Closed chat nobody held (review 2026-10-02): the target takes his
    // holder (merge event) and stays his; the trigger only acts on a chat that was his before the update.
    known({ id: 'r23ut', customer_key: 'K23u', status: 'resolved' });
    known({ id: 'r23uf', customer_key: 'K23u', status: 'ai_handling', assigned_to: 'owner' });
    eq(await mod.merge.mergeChats('r23ut', 'r23uf'), true);
    deq([C('r23ut').status, C('r23ut').assigned_to, C('r23uf').merged_into, evs('r23ut', 'transfer').length], ['ai_handling', 'owner', 'r23ut', 0]);
    deq(evs('r23ut', 'merge').map((e) => pick(e, ['from_owner', 'to_owner', 'reason'])), [{ from_owner: null, to_owner: 'owner', reason: 'merge' }]);
    deq(evs('r23ut', 'status').map((e) => pick(e, ['from_owner', 'to_owner', 'from_status', 'to_status'])),
      [{ from_owner: null, to_owner: 'owner', from_status: 'resolved', to_status: 'ai_handling' }]);
    // A member's Closed chat goes back to the member (decision 4, unchanged); an unheld one stays unheld.
    known({ id: 'r23m', status: 'resolved', assigned_to: ANURAG, customer_key: '9000000234' });
    known({ id: 'r23n', status: 'resolved', customer_key: '9000000235' });
    await customerSays('r23m', 'hello again');
    await customerSays('r23n', 'hello again');
    deq([C('r23m').status, C('r23m').assigned_to, C('r23n').status, C('r23n').assigned_to], ['ai_handling', ANURAG, 'ai_handling', null]);
    deq([evs('r23m', 'transfer').length, evs('r23n', 'transfer').length], [0, 0]);
    // A merged shell of his is never touched (WHEN ... merged_into IS NULL).
    known({ id: 'r23shell', status: 'resolved', assigned_to: 'owner', merged_into: 'r23a' });
    setRow(null, C('r23shell'), { status: 'ai_handling' });
    deq([C('r23shell').assigned_to, evs('r23shell', 'transfer').length], ['owner', 0]);
    // The event cannot be written (chat_events broken): the customer's message still goes through and
    // the chat stays his (the trigger only warns, it never blocks a reopen).
    known({ id: 'r23broken', status: 'resolved', assigned_to: 'owner', customer_key: '9000000236' });
    db.eventsBroken = true;
    try {
      await customerSays('r23broken', 'any update?');
    } finally { db.eventsBroken = false; }
    deq([C('r23broken').status, C('r23broken').assigned_to, evs('r23broken').length], ['ai_handling', 'owner', 0]);
  });

  await t('R23 his own reply, Take over or Hand to AI on his Closed chat keeps it his: the person is named before the status changes', async () => {
    at(ist(12, 30, 4));
    known({ id: 'r23r', status: 'resolved', assigned_to: 'owner', customer_key: '9000000237' });
    known({ id: 'r23t', status: 'resolved', assigned_to: 'owner', customer_key: '9000000238' });
    known({ id: 'r23h', status: 'resolved', assigned_to: 'owner', customer_key: '9000000239' });
    const s0 = db.stmts.length;
    status(await reply('owner', 'r23r', 'One more thing about your order'), 200);
    status(await takeOver('owner', 'r23t'), 200);
    status(await patch('owner', 'r23h', { status: 'ai_handling' }), 200);
    deq(['r23r', 'r23t', 'r23h'].map((id) => [C(id).status, C(id).assigned_to]),
      [['agent_handling', 'owner'], ['agent_handling', 'owner'], ['ai_handling', 'owner']]);
    deq(['r23r', 'r23t', 'r23h'].map((id) => evs(id, 'transfer').length), [0, 0, 0]);
    // What the trigger keys on (shiptrack.actor): set_config runs before the status UPDATE, in the same transaction.
    const txs = txStmts(s0);
    eq(txs.length, 3);
    for (const tx of txs) {
      const iSet = tx.findIndex((q) => q.startsWith('SELECT set_config')), iUpd = tx.findIndex((q) => q.startsWith('UPDATE conversations SET status'));
      ok(iSet > 0 && iUpd > iSet, 'set_config before the status UPDATE: ' + tx[iUpd]);
    }
    // A member cannot reopen it at all (his chats are read only for them), so no member path reaches the trigger.
    known({ id: 'r23ro', status: 'resolved', assigned_to: 'owner' });
    status(await takeOver('rahul', 'r23ro'), 409);
    status(await reply('anurag', 'r23ro'), 409);
    deq([C('r23ro').status, C('r23ro').assigned_to], ['resolved', 'owner']);
  });

  await t('R23 chat-team-owner-back.sql: additive, safe to run twice, the inherit rule is chat-team.sql\'s plus the owner line, the trigger as built', async () => {
    const file = fs.readFileSync(path.resolve(__dirname, '../../chat-team-owner-back.sql'), 'utf8');
    const base = fs.readFileSync(path.resolve(__dirname, '../../chat-team.sql'), 'utf8');
    const code = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
    const flat = (s) => code(s).replace(/\s+/g, ' ').trim();
    const body = code(file);
    // Header: the owner's answer and how to apply it.
    ok(/owner answer A5, 2026-10-02/.test(file));
    ok(file.includes('sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-team-owner-back.sql'));
    // Statements: lock_timeout, two functions, one trigger. Nothing dropped, altered, granted, updated or
    // deleted, no transaction of its own (the trial runs it inside BEGIN ... ROLLBACK), no messages.
    ok(/^SET lock_timeout = '5s';/m.test(body));
    deq((body.match(/\bCREATE\b[^\n]*/g) || []).map((x) => x.replace(/\(.*$/, '').trim()),
      ['CREATE OR REPLACE FUNCTION chat_inherit_owner', 'CREATE OR REPLACE FUNCTION chat_owner_back', 'CREATE OR REPLACE TRIGGER trg_chat_owner_back']);
    ok(!/\b(DROP|ALTER|TRUNCATE|GRANT|REVOKE|DELETE)\b/i.test(body));
    ok(!/\bUPDATE\s+\w+\s+SET\b/i.test(body));
    ok(!/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im.test(body));
    ok(!/\bmessages\b/i.test(body));
    // Only the holder columns of the row are ever set.
    deq([...new Set((body.match(/NEW\.(\w+) :=/g) || []))].sort(), ['NEW.assigned_at :=', 'NEW.assigned_to :=']);
    // (1) chat_inherit_owner: exactly chat-team.sql's function plus the owner line, placed after the lookup.
    const fnOf = (s) => {
      const i = s.indexOf('CREATE OR REPLACE FUNCTION chat_inherit_owner()');
      return s.slice(i, s.indexOf('END $$;', i) + 'END $$;'.length);
    };
    // A5 (review 2026-10-02): only while none of his chats with that customer is open; else the new
    // chat stays his (one person per customer).
    const A5 = /IF prev = 'owner' AND NOT EXISTS \(\s+SELECT 1 FROM conversations x\s+WHERE x\.site_id = NEW\.site_id AND x\.customer_key = NEW\.customer_key AND x\.source = 'chat'\s+AND x\.id <> NEW\.id AND x\.merged_into IS NULL\s+AND x\.assigned_to = 'owner' AND x\.status <> 'resolved'\) THEN\s+prev := NULL;\s+END IF;/;
    const fnNew = fnOf(file), fnOld = fnOf(base);
    ok(A5.test(fnNew) && !A5.test(fnOld));
    eq(flat(fnNew.replace(A5, '')), flat(fnOld));
    const iLimit = fnNew.indexOf('LIMIT 1;'), iA5 = fnNew.search(A5), iUse = fnNew.indexOf('IF prev IS NOT NULL THEN');
    ok(iLimit > 0 && iLimit < iA5 && iA5 < iUse, 'the owner line sits between the lookup and its use');
    // The candidates still include his chats, so his latest chat means "nobody" (an older member's does not win).
    ok(/AND \(o\.assigned_to = 'owner'\s+OR EXISTS \(SELECT 1 FROM team_users t WHERE t\.id::text = o\.assigned_to AND t\.is_active\)/.test(fnNew));
    // (2) chat_owner_back: a staff person named => keep; else the event row first, then the holder.
    const ob = file.slice(file.indexOf('CREATE OR REPLACE FUNCTION chat_owner_back()'), file.indexOf('CREATE OR REPLACE TRIGGER trg_chat_owner_back'));
    const iGuard = ob.indexOf("IF NULLIF(current_setting('shiptrack.actor', true), '') IS NOT NULL THEN");
    const iIns = ob.indexOf('INSERT INTO chat_events'), iClear = ob.indexOf('NEW.assigned_to := NULL;');
    ok(iGuard > 0 && iGuard < iIns && iIns < iClear, 'guard, then the event, then the holder');
    ok(/IS NOT NULL THEN\s+RETURN NEW;/.test(ob));
    ok(/INSERT INTO chat_events \(conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner,\s+from_status, to_status, reason, meta\)\s+VALUES \(NEW\.id, NEW\.site_id, 'transfer', 'system', 'System', 'owner', NULL,\s+OLD\.status, NEW\.status, 'owner_customer_back', '\{"auto":true\}'::jsonb\);/.test(ob));
    ok(/NEW\.assigned_to := NULL;[^\n]*\n\s+NEW\.assigned_at := now\(\);/.test(ob));
    ok(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'chat_owner_back skipped for %: %', NEW\.id, SQLERRM;\s+END;\s+RETURN NEW;\s+END \$\$;/.test(ob));
    // The event is the one the inherit guard reads as "put back in the pool on purpose".
    ok(/WHERE e\.kind = 'transfer' AND e\.to_owner IS NULL\s+AND \(e\.conversation_id = NEW\.id OR e\.meta->'group' \? NEW\.id\)\) THEN\s+RETURN NEW;/.test(fnNew));
    // The trigger: BEFORE UPDATE OF status, a reopen of a chat that was already his (OLD), never a merged shell.
    ok(/CREATE OR REPLACE TRIGGER trg_chat_owner_back\s+BEFORE UPDATE OF status ON conversations\s+FOR EACH ROW\s+WHEN \(OLD\.status = 'resolved' AND NEW\.status <> 'resolved' AND OLD\.assigned_to = 'owner' AND NEW\.assigned_to = 'owner' AND NEW\.merged_into IS NULL\)\s+EXECUTE FUNCTION chat_owner_back\(\);/.test(file));
    // BEFORE triggers fire in name order: inherit first (it only fills an EMPTY holder; one it fills
    // with 'owner' was not his BEFORE the update, so trg_chat_owner_back leaves it alone).
    ok('trg_chat_inherit_owner' < 'trg_chat_owner_back');
    ok(/CREATE OR REPLACE TRIGGER trg_chat_inherit_owner\s+BEFORE UPDATE OF status, customer_key ON conversations\s+FOR EACH ROW\s+WHEN \(NEW\.assigned_to IS NULL /.test(base));
    // The app user may write the event (chat-team.sql's grants; no new grant needed).
    ok(/GRANT SELECT, INSERT ON chat_events TO tracker_user;/.test(base) && /GRANT USAGE, SELECT ON SEQUENCE chat_events_id_seq TO tracker_user;/.test(base));
    // Part 4 (team-score.sql, when present): the holder log has no column list, so it logs this
    // trigger's 'owner' -> NULL; its one-time backfill reads transfer events too.
    const scorePath = path.resolve(__dirname, '../../team-score.sql');
    if (fs.existsSync(scorePath)) {
      const score = fs.readFileSync(scorePath, 'utf8');
      ok(/CREATE OR REPLACE TRIGGER trg_team_holder_log\s+AFTER UPDATE ON conversations\s+FOR EACH ROW WHEN \(OLD\.assigned_to IS DISTINCT FROM NEW\.assigned_to\)/.test(score));
      ok(/WHERE e\.kind IN \('claim', 'take', 'transfer', 'inherit', 'merge'\)/.test(score));
    }
  });

  // ── R24-R41: fake / invalid tracking claims (owner 2026-10-02; case-auto.ts, tracking-claim.ts) ─
  // The REAL widget route with the real detector and texts; the model is scripted, so every reply
  // below is the code's fixed text (the model's own words must never show). Texts exactly as the
  // spec (2.3); the courier is never named in them.
  const PROMISE = {
    en: 'Sorry for the trouble. We will send a new tracking link for your order here in this chat within 24-48 hours.',
    hinglish: 'Pareshani ke liye sorry. Aapke order ka naya tracking link 24-48 ghante me isi chat me bhej denge.',
  };
  const REMINDER = {
    en: 'Our team is preparing your new tracking link, and you will get it right here in this chat within 24-48 hours.',
    hinglish: 'Hamari team aapka naya tracking link bana rahi hai, 24-48 ghante me yahin isi chat me milega.',
  };
  const HANDOFF = {
    en: "Sorry to keep you waiting. I've passed your message to our team, and they will reply to you here in this chat.",
    hinglish: 'Sorry ki aapko wait karna pad raha hai. Maine aapki baat hamari team ko de di hai, team isi chat mein aapko jawab degi.',
  };
  const TEAM_LINE_EN = "I've passed this to our team, and they will reply to you here in this chat.";
  const AI_SAYS = 'I have raised this with our team and they will get back to you.';
  const CLAIM = 'Valmo website shows trecking id invalid';
  const order = (id, stage, extra = {}) => {
    global.__orders[id] = {
      order_id: id, customer_name: 'Test Customer', status: stage, tracking_id: 'STAB12CD34EF',
      tracking_link: `https://shiptrack.store/track/tok-${id.slice(1)}`, courier: 'Valmo', estimated_delivery: null,
      total: 999, products: [], placed_on: '2026-09-25T10:00:00.000Z', store: 'Vastora', cancelled: false, payment: 'Prepaid', ...extra,
    };
  };
  const say = async (id, text, ai = { content: AI_SAYS }) => {
    global.__ai.next = ai;
    const r = await mod.widgetMessage.POST(req(null, { conversationId: id, siteKey: 'key-s1', content: text }));
    status(r, 201, id);
    return r;
  };
  const textOf = (r) => (r.body.aiResponse ? r.body.aiResponse.content : null);
  const ce = (id) => db.caseEvents.filter((e) => e.conversation_id === id).map((e) => [e.site_id, e.kind, e.action, e.order_id, e.actor, e.actor_role]);
  const caseWrites = (n) => since(n).filter((x) => x.q === AUTO_SQL.mark || x.q === AUTO_SQL.red || x.q.startsWith('INSERT INTO chat_case_events') || /FOR NO KEY UPDATE$/.test(x.q) || x.q.startsWith('SELECT set_config'));
  const lastAi = (id) => db.messages.filter((m) => m.conversation_id === id && m.sender === 'ai').pop();
  // A chat already in Ship again: by Chikki (actor_role 'system') or by a person.
  const marked = (o, by = 'Chikki (auto)', role = 'system') => {
    const c = known({ status: 'agent_handling', case_kind: 'reship', case_marked_by: by, case_marked_at: nowIso(), case_prev_status: 'human_needed', ...o });
    c.case_order_id = c.verified_order_id;
    db.caseEvents.push({ id: crypto.randomUUID(), conversation_id: c.id, site_id: c.site_id, kind: 'reship', action: 'mark', order_id: c.verified_order_id, actor: by, actor_role: role });
    return c;
  };
  const STATE_HOOK = /^SELECT c\.site_id, c\.customer_key, c\.status, c\.verified_order_id, c\.verified_via, /;
  const URGENT_HI = 'Aapko jo pareshani hui, uske liye hamein sach mein afsos hai, aur ye baat hamare liye bahut zaroori hai. Maine ise abhi hamari team ko de diya hai. Hamari team isi chat mein 1 ghante ke andar aapko jawab degi.';
  // A message the customer wrote earlier in this chat (minutes ago), stored as the widget route stores it.
  const visitorSaid = (id, content, minsAgo) => db.messages.push({
    id: 'msg-' + (++seq), conversation_id: id, sender: 'visitor', content, metadata: null,
    created_at: new Date(clock - minsAgo * 60_000).toISOString(), deleted_at: null,
  });
  // Spec 3.6: WAITING_SINCE_SQL (waiting-sql.ts) played over the stored messages with its own regexes
  // (team-score rules.ts waitingSince is the same port): is the customer still owed an answer?
  ok(wsql.WAITING_SINCE_SQL.includes(waitingMod.AI_NOT_AN_ANSWER_REGEX) && wsql.WAITING_SINCE_SQL.includes(waitingMod.NO_REPLY_NEEDED_REGEX));
  const NO_REPLY = new RegExp(waitingMod.NO_REPLY_NEEDED_REGEX.replace(/\[:space:\]/g, '\\s'), 'i');   // POSIX class -> JS
  const NOT_ANSWER = new RegExp(waitingMod.AI_NOT_AN_ANSWER_REGEX, 'i');
  const waitingNow = (id) => {
    const c = C(id);
    const ms = db.messages.filter((m) => m.conversation_id === id && m.sender !== 'tool_result' && !(m.metadata && (m.metadata.hidden || m.metadata.withheld))
      && String(m.content || '').trim() !== '' && !m.deleted_at);
    const of = (who) => ms.filter((m) => m.sender === who).pop();
    const v = of('visitor'), a = of('agent'), ai = of('ai'), last = ms[ms.length - 1];
    if (c.status === 'resolved' || !v) return false;
    if (a && Date.parse(a.created_at) > Date.parse(v.created_at)) return false;
    if (c.status === 'human_needed' && !a) return true;
    if (NO_REPLY.test(v.content)) return false;
    return c.status === 'human_needed' || last.sender === 'visitor' || (last.sender === 'ai' && !!ai && NOT_ANSWER.test(ai.content));
  };
  assert.ok(NO_REPLY.test('ok thanks') && !NO_REPLY.test('link kab milega?'));

  await t('R24 verified (form), In Transit, "Valmo website shows trecking id invalid": the fixed promise and Chikki\'s own Ship again mark, one transaction', async () => {
    at(ist(14, 0, 6));
    known({ id: 'r24' });
    order('#r24', 'In Transit');
    global.__recentSaid = [];
    const s0 = db.stmts.length, calls = global.__ai.calls.length;
    const r = await say('r24', CLAIM);
    eq(textOf(r), PROMISE.en);
    ok(!textOf(r).includes(AI_SAYS), 'the model text is replaced');
    eq(global.__ai.calls.length, calls + 1);
    eq(r.body.message.metadata, null);
    deq(pick(C('r24'), ['status', 'case_kind', 'case_marked_by', 'case_order_id', 'case_prev_status', 'assigned_to']),
      { status: 'agent_handling', case_kind: 'reship', case_marked_by: 'Chikki (auto)', case_order_id: '#r24', case_prev_status: 'human_needed', assigned_to: null });
    deq(ce('r24'), [['S1', 'reship', 'mark', '#r24', 'Chikki (auto)', 'system']]);
    ok(UUID.test(db.caseEvents.find((e) => e.conversation_id === 'r24').id));
    const cm = evs('r24', 'case_mark');
    eq(cm.length, 1);
    deq(pick(cm[0], ['actor', 'actor_name', 'from_status', 'to_status', 'reason', 'meta']),
      { actor: 'system', actor_name: 'System', from_status: 'ai_handling', to_status: 'agent_handling', reason: 'case_auto', meta: { case: 'reship', auto: true, trigger: 'invalid' } });
    deq(evs('r24', 'status').map((e) => pick(e, ['actor', 'actor_name', 'reason', 'from_status', 'to_status'])),
      [{ actor: 'system', actor_name: 'Chikki (auto)', reason: 'case_auto', from_status: 'ai_handling', to_status: 'agent_handling' }]);
    // Every write in ONE transaction: lock_timeout, the lock, the actor, the mark, its event, the log.
    const txs = txStmts(s0);
    eq(txs.length, 1, 'one transaction');
    const [tx] = txs;
    eq(tx[0], 'BEGIN'); eq(tx[1], "SET LOCAL lock_timeout = '5s'"); ok(/FOR NO KEY UPDATE$/.test(tx[2]));
    const iSet = tx.findIndex((q) => q.startsWith('SELECT set_config')), iUpd = tx.indexOf(AUTO_SQL.mark), iEv = tx.indexOf(OLD_CASE_SQL.eventMark);
    ok(iSet > 2 && iSet < iUpd && iUpd < iEv, 'actor, then the mark, then its event');
    eq(tx[tx.length - 1], 'COMMIT');
    // The mark is saved before the customer is told.
    const all = since(s0).map((x) => x.q);
    ok(all.indexOf('COMMIT') < all.findIndex((q) => q.startsWith("INSERT INTO messages (id, conversation_id, sender, content, created_at) VALUES (gen_random_uuid()::text, $1, 'ai'")));
    eq(lastAi('r24').content, PROMISE.en);
    // Spec 3.6: after the promise the customer still waits for the team (the Ship again badge and the
    // auto-close count them): the promise is not an answer.
    ok(waitingNow('r24'), 'still waiting after the promise');
    // 22:00: the same promise (24-48 hours is the new link, not the team's reply time).
    at(ist(22, 0, 6));
    known({ id: 'r24n' });
    order('#r24n', 'Out for Delivery');
    eq(textOf(await say('r24n', CLAIM)), PROMISE.en);
    deq([C('r24n').case_kind, C('r24n').status], ['reship', 'agent_handling']);
  });

  await t('R25 the model escalated in the same turn: still the promise and Ship again (prev Needs you)', async () => {
    at(ist(14, 10, 6));
    known({ id: 'r25' });
    order('#r25', 'Shipped');
    const r = await say('r25', 'tracking link is not working', {
      content: 'I have passed this to our team, they will reply within 1 hour.', escalated: true,
      onCall: () => setRow(null, C('r25'), { status: 'human_needed' }),
    });
    eq(textOf(r), PROMISE.en);
    deq(pick(C('r25'), ['status', 'case_kind', 'case_prev_status']), { status: 'agent_handling', case_kind: 'reship', case_prev_status: 'human_needed' });
    deq(pick(evs('r25', 'case_mark')[0], ['from_status', 'meta']), { from_status: 'human_needed', meta: { case: 'reship', auto: true, trigger: 'fake' } });
  });

  await t('R26 a visitor: the AI\'s own reply, nothing read, nothing moved', async () => {
    at(ist(14, 20, 6));
    newConv({ id: 'r26' });
    order('#r26', 'In Transit');
    const s0 = db.stmts.length, l0 = global.__orderLookups.length;
    const r = await say('r26', CLAIM, { content: 'Please share your order ID and the phone number on the order.' });
    eq(textOf(r), 'Please share your order ID and the phone number on the order.');
    deq([C('r26').status, C('r26').case_kind], ['ai_handling', null]);
    ok(!since(s0).some((x) => Object.values(AUTO_SQL).includes(x.q) || x.q.includes('chat_case_events')), 'no case SQL at all');
    eq(caseWrites(s0).length, 0);
    eq(global.__orderLookups.length, l0);
  });

  await t('R27 an old proof (last 4), a phone match only, or another order named: today\'s path, no mark', async () => {
    at(ist(14, 30, 6));
    known({ id: 'r27', verified_via: 'chat' });
    newConv({ id: 'r27p', phone_match_order_id: '#r27p' });
    known({ id: 'r27o', verified_order_id: '#4715' });
    order('#r27', 'In Transit'); order('#r27p', 'In Transit'); order('#4715', 'In Transit');
    for (const [id, said] of [['r27', CLAIM], ['r27p', CLAIM], ['r27o', '#4716 ka tracking fake hai']]) {
      const s0 = db.stmts.length, l0 = global.__orderLookups.length;
      const r = await say(id, said);
      eq(textOf(r), AI_SAYS, id);
      deq([C(id).status, C(id).case_kind, ce(id).length], ['ai_handling', null, 0], id);
      eq(caseWrites(s0).length, 0, id);
      eq(since(s0).filter((x) => x.q === AUTO_SQL.state).length, 1, id);    // one read, to know the proof
      eq(global.__orderLookups.length, l0, id);
    }
  });

  await t('R28 not dispatched yet (Packed): the fixed explanation with the tracking link, nothing moves; asked again: Needs you', async () => {
    at(ist(15, 0, 6));
    known({ id: 'r28' });
    order('#r28', 'Packed');
    const explain = "Your order has not been dispatched yet, so the courier's website will not show it for now. Courier tracking starts once the order is dispatched. You can follow your order here:\nhttps://shiptrack.store/track/tok-r28";
    let r = await say('r28', CLAIM);
    eq(textOf(r), explain);
    deq([C('r28').status, C('r28').case_kind, ce('r28').length], ['ai_handling', null, 0]);
    at(ist(15, 5, 6));
    r = await say('r28', CLAIM);
    eq(textOf(r), HANDOFF.en);
    deq([C('r28').status, C('r28').case_kind, ce('r28').length], ['human_needed', null, 0]);
  });

  await t('R29 Delivered + "fake, not received": the delivered line + the check-around line, Needs you, no mark; with "fraud": the 1-hour line', async () => {
    at(ist(15, 30, 6));
    const AROUND = 'Kabhi-kabhi delivered parcel ghar ke kisi member, padosi, security guard ya reception ke paas aa jata hai. Please ek baar unse check kar lijiye.';
    known({ id: 'r29' });
    order('#r29', 'Delivered');
    let r = await say('r29', 'tracking pe delivered dikha raha hai par mila nahi, fake hai');
    eq(textOf(r), `Iske liye hamein sach mein afsos hai. Maine ise abhi hamari team ko de diya hai, team isi chat mein aapko jawab degi.\n\n${AROUND}`);
    deq([C('r29').status, C('r29').case_kind, ce('r29').length], ['human_needed', null, 0]);
    known({ id: 'r29f' });
    order('#r29f', 'Delivered');
    r = await say('r29f', 'tracking pe delivered dikha raha hai par mila nahi, fake hai, fraud ho tum log');
    eq(textOf(r), `Aapko jo pareshani hui, uske liye hamein sach mein afsos hai, aur ye baat hamare liye bahut zaroori hai. Maine ise abhi hamari team ko de diya hai. Hamari team isi chat mein 1 ghante ke andar aapko jawab degi.\n\n${AROUND}`);
    eq(r.body.message.metadata.urgent, 'accusation');
    deq([C('r29f').status, C('r29f').case_kind, ce('r29f').length], ['human_needed', null, 0]);
  });

  await t('R30 Return to Origin, cancelled, or the order not loadable: the team line (no hours), Needs you, no mark', async () => {
    at(ist(15, 40, 6));
    known({ id: 'r30' }); order('#r30', 'Return to Origin');
    known({ id: 'r30c' }); order('#r30c', 'In Transit', { cancelled: true });
    known({ id: 'r30x' });                                  // no such order
    for (const id of ['r30', 'r30c', 'r30x']) {
      const r = await say(id, CLAIM);
      eq(textOf(r), TEAM_LINE_EN, id);
      deq([C(id).status, C(id).case_kind, ce(id).length], ['human_needed', null, 0], id);
    }
    // Not loadable and the AI escalated: its own hand-over text stands (the night line as today).
    known({ id: 'r30e' });
    const r = await say('r30e', CLAIM, { content: AI_SAYS, escalated: true, onCall: () => setRow(null, C('r30e'), { status: 'human_needed' }) });
    eq(textOf(r), AI_SAYS);
    deq([C('r30e').status, C('r30e').case_kind], ['human_needed', null]);
  });

  await t('R31 "fraud hai, fake tracking diya" on a dispatched order: the promise and Ship again; the message keeps its urgent marker', async () => {
    at(ist(16, 0, 6));
    known({ id: 'r31' });
    order('#r31', 'Reached City');
    const r = await say('r31', 'fraud hai, fake tracking diya');
    eq(textOf(r), PROMISE.hinglish);
    ok(!/1 ghante|1 hour|10 AM|10 baje/.test(textOf(r)));
    eq(r.body.message.metadata.urgent, 'accusation');
    deq([C('r31').status, C('r31').case_kind], ['agent_handling', 'reship']);
    deq(evs('r31', 'case_mark')[0].meta, { case: 'reship', auto: true, trigger: 'fake', fraud: true });
  });

  await t('R32 a threat with the claim: the threat wins (fixed reply, Needs you, no AI call, no mark)', async () => {
    at(ist(16, 10, 6));
    known({ id: 'r32' });
    order('#r32', 'In Transit');
    const calls = global.__ai.calls.length, s0 = db.stmts.length;
    const r = await say('r32', 'chargeback karunga, tracking fake hai');
    eq(textOf(r), 'Aapko jo pareshani hui, uske liye hamein sach mein afsos hai, aur ye baat hamare liye bahut zaroori hai. Maine ise abhi hamari team ko de diya hai. Hamari team isi chat mein 1 ghante ke andar aapko jawab degi.');
    eq(global.__ai.calls.length, calls);
    deq([C('r32').status, C('r32').case_kind, ce('r32').length], ['human_needed', null, 0]);
    ok(!since(s0).some((x) => x.q === AUTO_SQL.state));
  });

  await t('R33 a visitor complains, then proves the order in the chat: the promise and the mark on the verifying turn', async () => {
    at(ist(16, 20, 6));
    newConv({ id: 'r33' });
    order('#4733', 'In Transit');
    visitorSaid('r33', CLAIM, 2);
    const s0 = db.stmts.length;
    let r = await say('r33', 'order 4733, phone 9000000033', {
      content: 'Thanks, I found your order. It is In Transit.',
      onCall: () => Object.assign(C('r33'), { verified_order_id: '#4733', verified_via: 'chat_phone', customer_key: '9000000033' }),
    });
    eq(textOf(r), PROMISE.en);
    deq(pick(C('r33'), ['status', 'case_kind', 'case_order_id']), { status: 'agent_handling', case_kind: 'reship', case_order_id: '#4733' });
    deq(evs('r33', 'case_mark')[0].meta, { case: 'reship', auto: true, trigger: 'invalid' });
    // The look-back reads this conversation only (the id before any merge), its last 24 hours.
    deq(since(s0).filter((x) => x.q === AUTO_SQL.earlier).length, 1);
    // The earlier message was a threat: the threat wins (owner Q2): the 1-hour line, Needs you, no promise, no mark.
    newConv({ id: 'r33t' });
    order('#4734', 'In Transit');
    visitorSaid('r33t', 'chargeback karunga, tracking fake hai', 2);
    r = await say('r33t', 'order 4734, phone 9000000034', {
      content: 'Thanks, I found your order. It is In Transit.',
      onCall: () => Object.assign(C('r33t'), { verified_order_id: '#4734', verified_via: 'chat_phone', customer_key: '9000000034' }),
    });
    eq(textOf(r), URGENT_HI);
    deq([C('r33t').status, C('r33t').case_kind, ce('r33t').length], ['human_needed', null, 0]);
  });

  await t('R34 after Chikki\'s mark: one reminder (no AI call), then red: in Ship again AND in Needs you, the lists and the badge', async () => {
    at(ist(17, 0, 6));
    const calls = global.__ai.calls.length;
    global.__recentSaid = ['link kab milega?', CLAIM];
    let r = await say('r24', 'link kab milega?');
    eq(textOf(r), REMINDER.hinglish);
    eq(global.__ai.calls.length, calls, 'the AI stays off');
    deq([C('r24').status, C('r24').case_kind], ['agent_handling', 'reship']);
    ok(waitingNow('r24'), 'still waiting after the reminder (spec 3.6)');
    at(ist(17, 5, 6));
    global.__recentSaid = ['??', 'link kab milega?', CLAIM];
    const s0 = db.stmts.length;
    r = await say('r24', '??');
    global.__recentSaid = [];
    eq(textOf(r), HANDOFF.en);
    deq([C('r24').status, C('r24').case_kind, C('r24').case_marked_by], ['human_needed', 'reship', 'Chikki (auto)']);
    deq(pick(evs('r24', 'status').pop(), ['actor', 'actor_name', 'reason', 'from_status', 'to_status']),
      { actor: 'system', actor_name: 'Chikki (auto)', reason: 'case_alert', from_status: 'agent_handling', to_status: 'human_needed' });
    // Red first (its own short transaction), then the text.
    const all = since(s0).map((x) => x.q);
    ok(all.indexOf(AUTO_SQL.red) >= 0 && all.indexOf(AUTO_SQL.red) < all.findIndex((q) => q.startsWith("INSERT INTO messages (id, conversation_id, sender, content, created_at)")));
    const [tx] = txStmts(s0);
    deq(tx.slice(0, 3), ['BEGIN', "SET LOCAL lock_timeout = '5s'", "SELECT set_config('shiptrack.actor', $1, true), set_config('shiptrack.actor_name', $2, true), set_config('shiptrack.reason', $3, true)"]);
    eq(global.__ai.calls.length, calls);
    // It stays in its section and shows in Needs you, the lists' counts and the sidebar badge.
    await list('owner', '?status=human_needed');
    ok(db.list.sql.includes(OUTSIDE_SECTION) && db.list.sql.includes('c.status = $'));
    ok(db.list.unansweredSql.includes(OUTSIDE_SECTION));
    await list('owner', '?case=reship');
    ok(db.list.sql.includes('c.case_kind = $') && !db.list.sql.includes(OUTSIDE_SECTION));
    const pr = await mod.pending.GET(req('owner', undefined, { method: 'GET', url: 'http://x/api/chat/pending' }));
    status(pr, 200);
    ok(db.pending.sql.includes("c.status = 'human_needed' AND (c.case_kind IS NULL OR c.case_kind = 'reship')"));
    ok(db.pending.ids.includes('r24') && !db.pending.ids.includes('r24n'));
    eq(pr.headers['Cache-Control'], 'no-store');
    // Red: a person is on it, nothing more is sent.
    r = await say('r24', 'hello??');
    eq(textOf(r), null);
    eq(C('r24').status, 'human_needed');
    // A person replies: the red clears (With team), the chat stays in Ship again.
    status(await reply('rahul', 'r24', 'Here is your new tracking link: https://example.test/new'), 200);
    deq([C('r24').status, C('r24').case_kind], ['agent_handling', 'reship']);
  });

  await t('R35 in a Chikki-marked chat: a new claim, a refund, a threat, another subject, 48 hours: red with the line for each; "ok": nothing', async () => {
    at(ist(11, 0, 7));
    const cases = [
      ['r35a', 'tracking link abhi bhi fake hai', REMINDER.hinglish],
      ['r35b', 'mujhe refund chahiye', 'Aapki refund ya cancellation ki request maine note kar li hai. Hamari team 24 ghante ke andar isi chat mein aapko jawab degi.'],
      ['r35c', 'I will file a police complaint', "I'm really sorry for the trouble, and this matters to us. I've passed it to our team right now. Our team will reply to you here in this chat within 1 hour."],
      ['r35d', 'address change karna hai', HANDOFF.hinglish],
      ['r35g', 'tracking link fake hai, fraud', `${REMINDER.hinglish}\n\nHamari team isi chat mein 1 ghante ke andar aapko jawab degi.`],
    ];
    for (const [id, said, want] of cases) {
      marked({ id });
      at(clock + 60_000);
      global.__recentSaid = [said];
      const r = await say(id, said);
      eq(textOf(r), want, id);
      deq([C(id).status, C(id).case_kind], ['human_needed', 'reship'], id);
    }
    marked({ id: 'r35e' });
    global.__recentSaid = ['ok'];
    let r = await say('r35e', 'ok');
    eq(textOf(r), null);
    eq(C('r35e').status, 'agent_handling');
    marked({ id: 'r35f' });
    at(clock + 49 * 3600_000);
    global.__recentSaid = ['link?'];
    r = await say('r35f', 'link?');
    global.__recentSaid = [];
    eq(textOf(r), HANDOFF.en);
    eq(C('r35f').status, 'human_needed');
  });

  await t('R36 a chat the team marked Ship again: a new tracking claim turns it red with NO message; anything else: nothing', async () => {
    at(ist(12, 0, 8));
    marked({ id: 'r36' }, 'Rahul', 'manager');
    let r = await say('r36', 'tracking abhi bhi fake hai');
    eq(textOf(r), null);
    deq([C('r36').status, C('r36').case_kind], ['human_needed', 'reship']);
    marked({ id: 'r36b' }, 'Rahul', 'manager');
    for (const said of ['link?', 'mujhe refund chahiye', 'I will file a police complaint']) {
      r = await say('r36b', said);
      eq(textOf(r), null, said);
      eq(C('r36b').status, 'agent_handling', said);
    }
    eq(db.messages.filter((m) => ['r36', 'r36b'].includes(m.conversation_id) && m.sender === 'ai').length, 0);
  });

  await t('R37 a team member wrote after Chikki\'s mark: "link?" gets nothing; a claim turns it red, no message', async () => {
    at(ist(12, 30, 8));
    marked({ id: 'r37' });
    at(clock + 60_000);
    db.messages.push({ id: 'r37-a', conversation_id: 'r37', sender: 'agent', content: 'Here is your new tracking link: https://example.test/x', metadata: { agent: 'rahul' }, created_at: nowIso(), deleted_at: null });
    at(clock + 60_000);
    let r = await say('r37', 'link?');
    eq(textOf(r), null);
    eq(C('r37').status, 'agent_handling');
    r = await say('r37', 'tracking link not working');
    eq(textOf(r), null);
    eq(C('r37').status, 'human_needed');
  });

  await t('R38 Remove on a Chikki mark sends it to Needs you; handed to the AI, the same claim is never marked again by itself', async () => {
    at(ist(13, 0, 8));
    known({ id: 'r38' });
    order('#r38', 'In Transit');
    eq(textOf(await say('r38', CLAIM)), PROMISE.en);
    let p = await patch('rahul', 'r38', { caseKind: null });
    status(p, 200);
    deq([C('r38').status, C('r38').case_kind], ['human_needed', null]);
    status(await patch('rahul', 'r38', { status: 'ai_handling' }), 200);
    eq(C('r38').status, 'ai_handling');
    at(clock + 60_000);
    const s0 = db.stmts.length;
    const r = await say('r38', CLAIM);
    eq(textOf(r), HANDOFF.en);
    deq([C('r38').status, C('r38').case_kind], ['human_needed', null]);
    ok(!since(s0).some((x) => x.q === AUTO_SQL.mark));
    deq(ce('r38').map((e) => [e[1], e[2], e[4]]), [['reship', 'mark', 'Chikki (auto)'], ['reship', 'remove', 'Rahul']]);
  });

  await t('R39 a new chat proves the order in the chat and is merged into a Chikki-marked chat: red + the hand-off there', async () => {
    at(ist(13, 30, 8));
    marked({ id: 'r39t', customer_key: '9000000039' });
    order('#r39t', 'In Transit');
    newConv({ id: 'r39n' });
    at(clock + 60_000);
    const r = await say('r39n', CLAIM, {
      content: AI_SAYS,
      onCall: () => Object.assign(C('r39n'), { verified_order_id: '#r39t', verified_via: 'chat_phone', customer_key: '9000000039' }),
    });
    eq(r.body.conversationId, 'r39t');
    eq(textOf(r), HANDOFF.en);
    deq([C('r39t').status, C('r39t').case_kind, C('r39n').merged_into], ['human_needed', 'reship', 'r39t']);
    eq(lastAi('r39t').content, HANDOFF.en);
    eq(ce('r39t').length, 1, 'no second mark');
  });

  await t('R40 races: the chat locked elsewhere (55P03): hand-off + Needs you, no promise, no case row; a mark found on the locked row', async () => {
    at(ist(14, 0, 8));
    known({ id: 'r40' });
    order('#r40', 'In Transit');
    const free = holdLock('r40');
    let r;
    try { r = await say('r40', CLAIM); } finally { free(); }
    eq(textOf(r), HANDOFF.en);
    deq([C('r40').status, C('r40').case_kind, ce('r40').length, evs('r40', 'case_mark').length], ['human_needed', null, 0, 0]);
    // A Refund mark found on the locked row: stays in Refund (unread there), the hand-off.
    known({ id: 'r40r' });
    order('#r40r', 'In Transit');
    db.after.push({ re: STATE_HOOK, fn: () => Object.assign(C('r40r'), { case_kind: 'refund', case_marked_by: 'Rahul', case_marked_at: nowIso(), case_order_id: '#r40r', status: 'agent_handling' }) });
    r = await say('r40r', CLAIM);
    eq(textOf(r), HANDOFF.en);
    deq([C('r40r').status, C('r40r').case_kind, ce('r40r').length], ['agent_handling', 'refund', 0]);
    // Chikki marked it a minute ago (the same claim from another tab): the reminder, nothing else.
    known({ id: 'r40t' });
    order('#r40t', 'In Transit');
    db.after.push({ re: STATE_HOOK, fn: () => Object.assign(C('r40t'), { case_kind: 'reship', case_marked_by: 'Chikki (auto)', case_marked_at: new Date(clock - 60_000).toISOString(), case_order_id: '#r40t', status: 'agent_handling' }) });
    r = await say('r40t', CLAIM);
    eq(textOf(r), REMINDER.en);
    eq(C('r40t').status, 'agent_handling');
    // A person's Ship again mark (or Chikki's older than 10 minutes): red + the hand-off.
    known({ id: 'r40s' });
    order('#r40s', 'In Transit');
    db.after.push({ re: STATE_HOOK, fn: () => Object.assign(C('r40s'), { case_kind: 'reship', case_marked_by: 'Rahul', case_marked_at: nowIso(), case_order_id: '#r40s', status: 'agent_handling' }) });
    r = await say('r40s', CLAIM);
    eq(textOf(r), HANDOFF.en);
    deq([C('r40s').status, C('r40s').case_kind], ['human_needed', 'reship']);
    known({ id: 'r40o' });
    order('#r40o', 'In Transit');
    db.after.push({ re: STATE_HOOK, fn: () => Object.assign(C('r40o'), { case_kind: 'reship', case_marked_by: 'Chikki (auto)', case_marked_at: new Date(clock - 11 * 60_000).toISOString(), case_order_id: '#r40o', status: 'agent_handling' }) });
    r = await say('r40o', CLAIM);
    eq(textOf(r), HANDOFF.en);
    deq([C('r40o').status, C('r40o').case_kind], ['human_needed', 'reship']);
    // Closed meanwhile: refused, the hand-off, never the promise.
    known({ id: 'r40c' });
    order('#r40c', 'In Transit');
    db.after.push({ re: STATE_HOOK, fn: () => setRow(null, C('r40c'), { status: 'resolved' }) });
    r = await say('r40c', CLAIM);
    eq(textOf(r), HANDOFF.en);
    deq([C('r40c').status, C('r40c').case_kind, ce('r40c').length], ['resolved', null, 0]);
  });

  await t('R41 the same order already in Ship again in another chat: this chat to Needs you with the hand-off, the other chat red', async () => {
    at(ist(14, 30, 8));
    known({ id: 'r41a', verified_order_id: '#r41' });
    marked({ id: 'r41b', verified_order_id: '#r41' }, 'Rahul', 'manager');
    order('#r41', 'In Transit');
    const r = await say('r41a', CLAIM);
    eq(textOf(r), HANDOFF.en);
    deq([C('r41a').status, C('r41a').case_kind, ce('r41a').length], ['human_needed', null, 0]);
    deq([C('r41b').status, C('r41b').case_kind], ['human_needed', 'reship']);
  });

  // ── R42-R47: review fixes (2026-10-02, second run) ──────────────────────────────────────
  const FOUND = 'Thanks, I found your order. It is In Transit.';
  // Since the owner's Refund rule (2026-10-02 18:45) a chargeback threat on an order past its estimated
  // date goes to Refund (R54-R64). The threat-wins tests below keep testing the claim with a threat on an
  // order that is NOT late yet (placed 25 Sep, estimated 31 Oct): there the threat path is unchanged.
  const NOT_LATE = { estimated_delivery: '2026-10-31' };
  const verifiesAs = (id, orderId, key) => () => Object.assign(C(id), { verified_order_id: orderId, verified_via: 'chat_phone', customer_key: key });

  await t('R42 a refund, cancel or payment request with the claim reaches the team: the AI text + its line, Needs you, no promise, no mark', async () => {
    at(ist(15, 0, 9));
    makeTokens();   // fresh logins for the later days (R45, R47 use the staff routes)
    const REFUND_HI = 'Aapki refund ya cancellation ki request maine note kar li hai. Hamari team 24 ghante ke andar isi chat mein aapko jawab degi.';
    const PAY_HI = 'Maine ise hamari team ko de diya hai, team isi chat mein aapko jawab degi.';
    for (const [id, said, line] of [
      ['r42a', 'tracking id invalid hai, mujhe refund chahiye', REFUND_HI],
      ['r42b', 'tracking link fake hai, order cancel kar do', REFUND_HI],
      ['r42c', 'payment kat gaya aur tracking link kaam nahi kar raha', PAY_HI],
    ]) {
      known({ id }); order('#' + id, 'In Transit');
      ok(tc.trackingClaimKind(said) && esc.routineHandOverKind(said), said);
      const s0 = db.stmts.length;
      const r = await say(id, said);
      eq(textOf(r), `${AI_SAYS}\n\n${line}`, id);
      deq([C(id).status, C(id).case_kind, ce(id).length], ['human_needed', null, 0], id);
      eq(caseWrites(s0).length, 0, id);
      eq(r.body.message.metadata.routine, esc.routineHandOverKind(said), id);
    }
    // At night: the refund line says the morning (today's night line, unchanged).
    at(ist(21, 0, 9));
    known({ id: 'r42n' }); order('#r42n', 'In Transit');
    eq(textOf(await say('r42n', 'tracking id invalid hai, mujhe refund chahiye')),
      `${AI_SAYS}\n\nAapki refund ya cancellation ki request maine note kar li hai. Hamari team kal subah 10 baje ke baad isi chat mein aapko jawab degi.`);
    // The refund request was in the earlier message that carried the claim (complained, then verified):
    // today's path would not see it, so its line is sent here and the chat goes to Needs you.
    at(ist(15, 30, 9));
    newConv({ id: 'r42v' }); order('#4742', 'In Transit');
    visitorSaid('r42v', 'tracking link fake hai, mujhe refund chahiye', 3);
    const r = await say('r42v', 'order 4742, phone 9000000042', { content: FOUND, onCall: verifiesAs('r42v', '#4742', '9000000042') });
    eq(textOf(r), REFUND_HI);
    deq([C('r42v').status, C('r42v').case_kind, ce('r42v').length], ['human_needed', null, 0]);
  });

  await t('R43 a threat in the verifying message, the claim earlier or in the same message: the threat wins (1-hour line, Needs you, no mark)', async () => {
    at(ist(16, 0, 9));
    newConv({ id: 'r43' }); order('#4743', 'In Transit', NOT_LATE);
    visitorSaid('r43', CLAIM, 3);
    const verifying = 'order 4743, phone 9000000043, link nahi diya to chargeback karunga';
    eq(tc.trackingClaimKind(verifying), null, 'the claim is only in the earlier message');
    let r = await say('r43', verifying, { content: FOUND, onCall: verifiesAs('r43', '#4743', '9000000043') });
    eq(textOf(r), URGENT_HI);
    eq(r.body.message.metadata.urgent, 'threat');
    deq([C('r43').status, C('r43').case_kind, ce('r43').length], ['human_needed', null, 0]);
    newConv({ id: 'r43b' }); order('#4744', 'In Transit', NOT_LATE);
    r = await say('r43b', 'order 4744 phone 9000000044, tracking fake hai, chargeback karunga', { content: FOUND, onCall: verifiesAs('r43b', '#4744', '9000000044') });
    eq(textOf(r), URGENT_HI);
    deq([C('r43b').status, C('r43b').case_kind, ce('r43b').length], ['human_needed', null, 0]);
    // Night: the morning line, still no mark.
    at(ist(22, 30, 9));
    newConv({ id: 'r43n' }); order('#4745', 'In Transit', NOT_LATE);
    visitorSaid('r43n', CLAIM, 3);
    r = await say('r43n', 'order 4745, phone 9000000045, warna chargeback karunga', { content: FOUND, onCall: verifiesAs('r43n', '#4745', '9000000045') });
    eq(textOf(r), 'Aapko jo pareshani hui, uske liye hamein sach mein afsos hai, aur ye baat hamare liye bahut zaroori hai. Maine ise abhi hamari team ko de diya hai. Hamari team kal subah 10 baje ke baad isi chat mein aapko jawab degi.');
    deq([C('r43n').status, C('r43n').case_kind], ['human_needed', null]);
  });

  await t('R44 the look-back reads only this conversation\'s last 24 hours: an old complaint in the older merged chat fires nothing', async () => {
    at(ist(11, 0, 10));
    // The customer's older chat (form-verified) holds a tracking complaint from 3 days ago.
    known({ id: 'r44t', customer_key: '9000000146', created_at: new Date(clock - 5 * 86400_000).toISOString(), last_message_at: new Date(clock - 3 * 86400_000).toISOString() });
    order('#r44t', 'In Transit');
    visitorSaid('r44t', CLAIM, 3 * 24 * 60);
    // A new chat, opened 5 minutes ago; the customer proves the order in it and complains about nothing.
    newConv({ id: 'r44n', created_at: new Date(clock - 5 * 60_000).toISOString() });
    let s0 = db.stmts.length;
    let r = await say('r44n', 'order r44t, phone 9000000146', { content: FOUND, onCall: verifiesAs('r44n', '#r44t', '9000000146') });
    eq(r.body.conversationId, 'r44t');
    eq(textOf(r), FOUND);
    deq([C('r44t').status, C('r44t').case_kind, ce('r44t').length], ['ai_handling', null, 0]);
    const look = since(s0).filter((x) => x.q === AUTO_SQL.earlier);
    eq(look.length, 1, 'the look-back ran once');
    ok(!since(s0).some((x) => x.q === AUTO_SQL.state), 'no claim, so nothing else was read');
    // The complaint written in the new chat before verifying: the promise and the mark, in the merged chat.
    at(clock + 3600_000);
    known({ id: 'r44u', customer_key: '9000000147', created_at: new Date(clock - 5 * 86400_000).toISOString() });
    order('#r44u', 'In Transit');
    visitorSaid('r44u', 'tracking link fake hai', 4 * 24 * 60);      // old, already answered
    newConv({ id: 'r44m', created_at: new Date(clock - 5 * 60_000).toISOString() });
    visitorSaid('r44m', CLAIM, 2);
    r = await say('r44m', 'order r44u, phone 9000000147', { content: FOUND, onCall: verifiesAs('r44m', '#r44u', '9000000147') });
    eq(r.body.conversationId, 'r44u');
    eq(textOf(r), PROMISE.en, 'the new chat\'s English complaint, not the old Hinglish one');
    deq([C('r44u').case_kind, C('r44u').status], ['reship', 'agent_handling']);
    deq(evs('r44u', 'case_mark')[0].meta, { case: 'reship', auto: true, trigger: 'invalid' });
    // No merge, but the complaint is older than 24 hours: nothing.
    newConv({ id: 'r44o', created_at: new Date(clock - 3 * 86400_000).toISOString() });
    order('#4746', 'In Transit');
    visitorSaid('r44o', CLAIM, 30 * 60);
    r = await say('r44o', 'order 4746, phone 9000000046', { content: FOUND, onCall: verifiesAs('r44o', '#4746', '9000000046') });
    eq(textOf(r), FOUND);
    deq([C('r44o').status, C('r44o').case_kind], ['ai_handling', null]);
  });

  await t('R45 a chat already in Needs you (a merge target waiting on a person): the promise and Ship again, but it stays in Needs you, red', async () => {
    at(ist(12, 0, 10));
    known({ id: 'r45t', status: 'human_needed', customer_key: '9000000148', created_at: new Date(clock - 2 * 86400_000).toISOString() });
    order('#r45t', 'In Transit');
    newConv({ id: 'r45n', created_at: new Date(clock - 5 * 60_000).toISOString() });
    const r = await say('r45n', CLAIM, { content: AI_SAYS, onCall: verifiesAs('r45n', '#r45t', '9000000148') });
    eq(r.body.conversationId, 'r45t');
    eq(textOf(r), PROMISE.en);
    deq(pick(C('r45t'), ['status', 'case_kind', 'case_marked_by', 'case_prev_status']),
      { status: 'human_needed', case_kind: 'reship', case_marked_by: 'Chikki (auto)', case_prev_status: 'human_needed' });
    deq(pick(evs('r45t', 'case_mark')[0], ['from_status', 'to_status']), { from_status: 'human_needed', to_status: 'human_needed' });
    eq(evs('r45t', 'status').filter((e) => e.reason === 'case_auto').length, 0, 'no status change');
    ok(waitingNow('r45t'));
    const pr = await mod.pending.GET(req('owner', undefined, { method: 'GET', url: 'http://x/api/chat/pending' }));
    status(pr, 200);
    ok(db.pending.ids.includes('r45t'), 'still counted in Needs you');
    // Its next message: red already, a person is on it: nothing more is sent.
    at(clock + 60_000);
    eq(textOf(await say('r45t', 'link kab milega?')), null);
    eq(C('r45t').status, 'human_needed');
  });

  await t('R46 the red flag cannot be saved: never "the team will reply"; today\'s path instead (rows 4 and 13b); already red: the hand-off', async () => {
    at(ist(13, 0, 10));
    const RED_RE = /^UPDATE conversations SET status = 'human_needed', updated_at = now\(\) WHERE id = \$1 AND case_kind = 'reship'/;
    const failRedTwice = () => db.fail.push({ re: RED_RE, code: '55P03', once: true }, { re: RED_RE, code: '55P03', once: true });
    // Row 4: merged into a Chikki-marked chat.
    marked({ id: 'r46t', customer_key: '9000000149' });
    order('#r46t', 'In Transit');
    newConv({ id: 'r46n' });
    at(clock + 60_000);
    failRedTwice();
    let r = await say('r46n', CLAIM, { content: AI_SAYS, onCall: verifiesAs('r46n', '#r46t', '9000000149') });
    eq(db.fail.length, 0, 'both tries failed');
    eq(r.body.conversationId, 'r46t');
    eq(textOf(r), AI_SAYS);
    deq([C('r46t').status, C('r46t').case_kind], ['agent_handling', 'reship']);
    // 13b: a person's Ship again mark found on the locked row.
    known({ id: 'r46s' }); order('#r46s', 'In Transit');
    db.after.push({ re: STATE_HOOK, fn: () => Object.assign(C('r46s'), { case_kind: 'reship', case_marked_by: 'Rahul', case_marked_at: nowIso(), case_order_id: '#r46s', status: 'agent_handling' }) });
    failRedTwice();
    r = await say('r46s', CLAIM);
    eq(db.fail.length, 0);
    eq(textOf(r), AI_SAYS);
    deq([C('r46s').status, C('r46s').case_kind], ['agent_handling', 'reship']);
    // Row 4, the Ship again chat is red already (in Needs you): the hand-off is true; no second flag.
    marked({ id: 'r46r', customer_key: '9000000150', status: 'human_needed' });
    order('#r46r', 'In Transit');
    newConv({ id: 'r46m' });
    const s0 = db.stmts.length;
    r = await say('r46m', CLAIM, { content: AI_SAYS, onCall: verifiesAs('r46m', '#r46r', '9000000150') });
    eq(r.body.conversationId, 'r46r');
    eq(textOf(r), HANDOFF.en);
    eq(C('r46r').status, 'human_needed');
    ok(!since(s0).some((x) => x.q === AUTO_SQL.red));
    // A threat merged into a Ship again chat: red + the 1-hour line.
    marked({ id: 'r46x', customer_key: '9000000151' });
    order('#r46x', 'In Transit', NOT_LATE);
    newConv({ id: 'r46y' });
    r = await say('r46y', 'tracking fake hai, chargeback karunga', { content: AI_SAYS, onCall: verifiesAs('r46y', '#r46x', '9000000151') });
    eq(r.body.conversationId, 'r46x');
    eq(textOf(r), URGENT_HI);
    deq([C('r46x').status, C('r46x').case_kind], ['human_needed', 'reship']);
  });

  await t('R47 the one-time move: a moved AI chat goes to Needs you on Remove or undo (never back to the AI), and the inbox never says a moved chat was promised', async () => {
    const root = path.resolve(__dirname, '../..');
    const flat = (f) => norm(fs.readFileSync(path.join(root, f), 'utf8').replace(/--.*$/gm, ''));
    const move = flat('chat-tracking-reship-move.sql'), undo = flat('chat-tracking-reship-move-undo.sql');
    ok(move.includes("SET case_prev_status = CASE WHEN b.status = 'agent_handling' THEN 'agent_handling' ELSE 'human_needed' END,"));
    ok(!/case_prev_status = b\.status/.test(move));
    ok(move.includes("status = CASE WHEN b.status = 'human_needed' THEN 'human_needed' ELSE 'agent_handling' END"));
    ok(move.includes("'Chikki (auto)', 'backfill' FROM moved") && !/INSERT INTO messages/i.test(move), 'no message to anyone');
    ok(undo.includes("SET status = CASE WHEN c.status = 'resolved' THEN c.status WHEN c.case_prev_status = 'agent_handling' THEN 'agent_handling' ELSE 'human_needed' END,"));
    ok(!move.includes("'ai_handling'") && !undo.includes("'ai_handling'"), 'nothing goes back to the AI');
    // A moved chat (the AI was answering it, so prev = Needs you): the customer's next question gets
    // the one reminder; Remove sends it to Needs you.
    at(ist(14, 0, 10));
    marked({ id: 'r47', case_prev_status: 'human_needed' }, 'Chikki (auto)', 'backfill');
    global.__recentSaid = ['link kab milega?'];
    const r = await say('r47', 'link kab milega?');
    global.__recentSaid = [];
    eq(textOf(r), REMINDER.hinglish);
    eq(C('r47').status, 'agent_handling');
    status(await patch('rahul', 'r47', { caseKind: null }), 200);
    deq([C('r47').status, C('r47').case_kind], ['human_needed', null]);
    // The inbox can tell a moved chat (actor_role 'backfill') from a live promise: the list and the
    // thread carry case_mark_role, and the texts differ.
    await list('owner', '?case=reship');
    ok(/ AS case_mark_role,/.test(db.list.sql) && db.list.sql.includes('g.case_mark_role'));
    marked({ id: 'r47b' }, 'Chikki (auto)', 'backfill');
    status(await thread('owner', 'r47b'), 200);
    ok(/ AS case_mark_role,/.test(fs.readFileSync(path.join(SRC, 'app/api/chat/conversations/[id]/route.ts'), 'utf8')));
    const page = fs.readFileSync(path.join(SRC, 'app/admin/chat/page.tsx'), 'utf8');
    ok(page.includes("role === 'backfill'") && page.includes('the move sent the customer no message'));
  });

  // ── R48-R53: review fixes (2026-10-02, third run) ──────────────────────────────────────
  const REFUND_LINE = 'Aapki refund ya cancellation ki request maine note kar li hai. Hamari team 24 ghante ke andar isi chat mein aapko jawab degi.';
  const aiSaid = (id, content, minsAgo) => db.messages.push({
    id: 'msg-' + (++seq), conversation_id: id, sender: 'ai', content, metadata: null,
    created_at: new Date(clock - minsAgo * 60_000).toISOString(), deleted_at: null,
  });
  const isRedAt = (n) => {
    const all = since(n).map((x) => x.q);
    const iRed = all.indexOf(AUTO_SQL.red), iText = all.findIndex((q) => q.startsWith('INSERT INTO messages (id, conversation_id, sender, content, created_at)'));
    return iRed >= 0 && (iText < 0 || iRed < iText);
  };
  // Chikki marks the chat while this turn's model is answering (the customer's first claim, sent a
  // moment before from the same chat).
  const markedMeanwhile = (id, agoMs = 5000) => () => {
    Object.assign(C(id), { case_kind: 'reship', case_marked_by: 'Chikki (auto)', case_marked_at: new Date(clock - agoMs).toISOString(), case_order_id: C(id).verified_order_id, case_prev_status: 'human_needed', status: 'agent_handling' });
    db.caseEvents.push({ id: crypto.randomUUID(), conversation_id: id, site_id: 'S1', kind: 'reship', action: 'mark', order_id: C(id).verified_order_id, actor: 'Chikki (auto)', actor_role: 'system' });
  };

  await t('R48 no tracking claim, but the turn ends in a Ship again chat (merged into one, or Chikki marked it meanwhile): the model\'s text is dropped, red with the line for the case, or the one reminder', async () => {
    at(ist(13, 0, 12));
    const MODEL = 'Aapka order In Transit hai. Aap yahan dekh sakte hain:\nhttps://shiptrack.store/track/tok-x';
    // The promise in r48t 20 hours ago; a refund request from another device, proved in the chat, merged.
    marked({ id: 'r48t', customer_key: '9000000481', case_marked_at: new Date(clock - 20 * 3600e3).toISOString() });
    order('#r48t', 'In Transit');
    visitorSaid('r48t', CLAIM, 20 * 60);
    aiSaid('r48t', PROMISE.en, 20 * 60 - 1);
    newConv({ id: 'r48n' });
    at(clock + 60_000);
    let said = 'order r48t, phone 9000000481, mujhe refund chahiye';
    ok(!tc.trackingClaimKind(said) && esc.routineHandOverKind(said) === 'refund');
    let s0 = db.stmts.length;
    let r = await say('r48n', said, { content: MODEL, onCall: verifiesAs('r48n', '#r48t', '9000000481') });
    eq(r.body.conversationId, 'r48t');
    eq(textOf(r), REFUND_LINE, 'the refund line alone, never the model\'s text');
    deq([C('r48t').status, C('r48t').case_kind, C('r48n').merged_into], ['human_needed', 'reship', 'r48t']);
    ok(isRedAt(s0), 'red before the text');
    ok(waitingNow('r48t'), 'the team owes an answer');
    eq(ce('r48t').length, 1, 'no new mark');
    // A link question from another device: the one reminder (no model text about the link), not red.
    marked({ id: 'r48u', customer_key: '9000000482', case_marked_at: new Date(clock - 3 * 3600e3).toISOString() });
    order('#r48u', 'In Transit');
    aiSaid('r48u', PROMISE.hinglish, 3 * 60);
    newConv({ id: 'r48m' });
    said = 'order r48u, phone 9000000482, naya link kab milega?';
    ok(!tc.trackingClaimKind(said));
    global.__recentSaid = [said];
    r = await say('r48m', said, { content: MODEL, onCall: verifiesAs('r48m', '#r48u', '9000000482') });
    global.__recentSaid = [];
    eq(textOf(r), REMINDER.hinglish);
    deq([C('r48u').status, C('r48u').case_kind], ['agent_handling', 'reship']);
    ok(waitingNow('r48u'));
    // Merged into a chat that is red already: the line, no second flag.
    marked({ id: 'r48x', customer_key: '9000000484', status: 'human_needed' });
    order('#r48x', 'In Transit');
    newConv({ id: 'r48y' });
    s0 = db.stmts.length;
    r = await say('r48y', 'order r48x, phone 9000000484, mujhe refund chahiye', { content: MODEL, onCall: verifiesAs('r48y', '#r48x', '9000000484') });
    eq(textOf(r), REFUND_LINE);
    eq(C('r48x').status, 'human_needed');
    ok(!since(s0).some((x) => x.q === AUTO_SQL.red));
    // Merged into a chat a person marked: no message at all (rule 9.2), the model's text dropped; unread
    // and waiting in its section.
    marked({ id: 'r48s', customer_key: '9000000483' }, 'Rahul', 'manager');
    order('#r48s', 'In Transit');
    newConv({ id: 'r48p' });
    r = await say('r48p', 'order r48s, phone 9000000483, mujhe refund chahiye', { content: MODEL, onCall: verifiesAs('r48p', '#r48s', '9000000483') });
    eq(r.body.conversationId, 'r48s');
    eq(textOf(r), null);
    eq(C('r48s').status, 'agent_handling');
    eq(db.messages.filter((m) => m.conversation_id === 'r48s' && m.sender === 'ai' && String(m.content || '').trim()).length, 0);
    ok(waitingNow('r48s'));
    // Not merged: Chikki marked the chat while the model answered (the claim sent a moment before).
    known({ id: 'r48r' }); order('#r48r', 'In Transit');
    r = await say('r48r', 'mujhe refund chahiye', { content: AI_SAYS, onCall: markedMeanwhile('r48r') });
    eq(textOf(r), REFUND_LINE);
    deq([C('r48r').status, C('r48r').case_kind], ['human_needed', 'reship']);
    // An ordinary verified chat: the model's text, one cheap read, nothing else.
    known({ id: 'r48z' }); order('#r48z', 'In Transit');
    s0 = db.stmts.length;
    r = await say('r48z', 'mujhe refund chahiye', { content: AI_SAYS });
    eq(textOf(r), `${AI_SAYS}\n\n${REFUND_LINE}`);
    deq([C('r48z').status, C('r48z').case_kind], ['human_needed', null]);
    eq(since(s0).filter((x) => x.q === AUTO_SQL.reship).length, 1);
    // The read fails: today's path (the model's text and its line), never an error for the customer.
    known({ id: 'r48f' }); order('#r48f', 'In Transit');
    db.fail.push({ re: /^SELECT c\.status, c\.case_marked_at,/, code: '57014', once: true });
    r = await say('r48f', 'mujhe refund chahiye', { content: AI_SAYS });
    eq(db.fail.length, 0);
    eq(textOf(r), `${AI_SAYS}\n\n${REFUND_LINE}`);
  });

  await t('R49 after the 48 hours: a claim, anger or a fraud claim is red with the team line, never the 24-48 h reminder again', async () => {
    at(ist(13, 0, 13));
    const RED_FRAUD = URGENT_HI;
    for (const [id, said, want] of [
      ['r49a', '3 din ho gaye, tracking abhi bhi invalid aa raha hai valmo pe', HANDOFF.hinglish],
      ['r49b', 'BHAI 3 DIN HO GAYE LINK KAHAN HAI', HANDOFF.hinglish],
      ['r49c', 'ye fraud hai, 3 din se link ka wait kar raha hu', RED_FRAUD],
      ['r49d', '4 days and the tracking is still not updating', HANDOFF.en],
    ]) {
      marked({ id, case_marked_at: new Date(clock - 72 * 3600e3).toISOString() });
      order('#' + id, 'In Transit');
      visitorSaid(id, 'valmo pe tracking id invalid bata raha hai', 72 * 60);
      aiSaid(id, PROMISE.hinglish, 72 * 60 - 1);
      global.__recentSaid = [said, 'valmo pe tracking id invalid bata raha hai'];
      const r = await say(id, said);
      global.__recentSaid = [];
      eq(textOf(r), want, id);
      ok(!/24-48/.test(textOf(r)), `${id}: no new 24-48 hours`);
      deq([C(id).status, C(id).case_kind], ['human_needed', 'reship'], id);
    }
    // The red flag cannot be saved after the 48 hours: nothing is sent (not even the reminder).
    const RED_RE = /^UPDATE conversations SET status = 'human_needed', updated_at = now\(\) WHERE id = \$1 AND case_kind = 'reship'/;
    marked({ id: 'r49e', case_marked_at: new Date(clock - 72 * 3600e3).toISOString() });
    db.fail.push({ re: RED_RE, code: '55P03', once: true }, { re: RED_RE, code: '55P03', once: true });
    global.__recentSaid = ['tracking abhi bhi fake hai'];
    const r = await say('r49e', 'tracking abhi bhi fake hai');
    global.__recentSaid = [];
    eq(db.fail.length, 0);
    eq(textOf(r), null);
    eq(C('r49e').status, 'agent_handling');
  });

  await t('R50 one reminder whatever the language: English then Hinglish, or a Take over without a reply after the red reminder, turns it red with the hand-off', async () => {
    at(ist(13, 0, 14));
    marked({ id: 'r50', case_marked_at: new Date(clock - 2 * 3600e3).toISOString() });
    order('#r50', 'In Transit');
    visitorSaid('r50', CLAIM, 120);
    aiSaid('r50', PROMISE.en, 119);
    global.__recentSaid = ['When will I get the new link?', CLAIM];
    let r = await say('r50', 'When will I get the new link?');
    eq(textOf(r), REMINDER.en);
    eq(C('r50').status, 'agent_handling');
    at(clock + 10 * 60_000);
    global.__recentSaid = ['bhai link kab milega', 'When will I get the new link?', CLAIM];
    r = await say('r50', 'bhai link kab milega');
    global.__recentSaid = [];
    eq(textOf(r), HANDOFF.hinglish, 'never a second reminder');
    eq(C('r50').status, 'human_needed');
    eq(db.messages.filter((m) => m.conversation_id === 'r50' && m.sender === 'ai' && /naya tracking link bana rahi|preparing your new tracking link/.test(m.content)).length, 1);
    // The fraud line went out with the reminder (red); a person presses Take over and writes nothing;
    // the customer asks again: the hand-off, not the reminder again.
    marked({ id: 'r50b', case_marked_at: new Date(clock - 2 * 3600e3).toISOString() });
    order('#r50b', 'In Transit');
    aiSaid('r50b', PROMISE.hinglish, 119);
    global.__recentSaid = ['ye sab fraud hai, link kab aayega'];
    r = await say('r50b', 'ye sab fraud hai, link kab aayega');
    eq(textOf(r), `${REMINDER.hinglish}\n\nHamari team isi chat mein 1 ghante ke andar aapko jawab degi.`);
    eq(C('r50b').status, 'human_needed');
    at(clock + 5 * 60_000);
    status(await takeOver('rahul', 'r50b'), 200);
    eq(C('r50b').status, 'agent_handling');
    at(clock + 5 * 60_000);
    global.__recentSaid = ['link kab milega?', 'ye sab fraud hai, link kab aayega'];
    r = await say('r50b', 'link kab milega?');
    global.__recentSaid = [];
    eq(textOf(r), HANDOFF.hinglish);
    eq(C('r50b').status, 'human_needed');
    // The reminder that went out with the sensitive-data warning in front still counts.
    marked({ id: 'r50c', case_marked_at: new Date(clock - 2 * 3600e3).toISOString() });
    aiSaid('r50c', `Please do not share card details here.\n\n${REMINDER.en}`, 30);
    global.__recentSaid = ['link?'];
    r = await say('r50c', 'link?');
    global.__recentSaid = [];
    eq(textOf(r), HANDOFF.en);
    eq(C('r50c').status, 'human_needed');
  });

  await t('R51 a question on another subject in a Chikki-marked chat is red with the hand-off; "?" alone and a link question get the reminder', async () => {
    at(ist(13, 0, 15));
    for (const [id, said] of [['r51a', 'address change karna hai?'], ['r51b', 'Can I change my delivery address?'], ['r51c', 'COD available hai?'], ['r51d', 'mujhe exchange chahiye?']]) {
      marked({ id });
      at(clock + 60_000);
      global.__recentSaid = [said];
      const r = await say(id, said);
      eq(textOf(r), esc.handoffReply(said), id);
      deq([C(id).status, C(id).case_kind], ['human_needed', 'reship'], id);
    }
    for (const [id, said, want] of [['r51e', '?', REMINDER.en], ['r51f', 'new link kab tak aayega?', REMINDER.hinglish]]) {
      marked({ id });
      at(clock + 60_000);
      global.__recentSaid = [said];
      const r = await say(id, said);
      eq(textOf(r), want, id);
      eq(C(id).status, 'agent_handling', id);
    }
    global.__recentSaid = [];
  });

  await t('R52 the same claim sent twice at once: the second turn sees Chikki\'s fresh mark and gets the reminder, not red (13a); a threat or a refund with it still goes red', async () => {
    at(ist(13, 0, 16));
    known({ id: 'r52' });
    order('#r52', 'In Transit');
    const said = 'valmo pe tracking id galat bata raha hai';
    global.__recentSaid = [said, CLAIM];
    let r = await say('r52', said, { content: AI_SAYS, onCall: markedMeanwhile('r52') });
    eq(textOf(r), REMINDER.hinglish);
    deq([C('r52').status, C('r52').case_kind, ce('r52').length], ['agent_handling', 'reship', 1]);
    // Older than 10 minutes, or a person's mark: red + the hand-off, as before.
    known({ id: 'r52o' }); order('#r52o', 'In Transit');
    r = await say('r52o', said, { content: AI_SAYS, onCall: markedMeanwhile('r52o', 11 * 60_000) });
    eq(textOf(r), HANDOFF.hinglish);
    eq(C('r52o').status, 'human_needed');
    // A threat with the claim: red + the 1-hour line.
    known({ id: 'r52t' }); order('#r52t', 'In Transit', NOT_LATE);
    r = await say('r52t', 'tracking fake hai, chargeback karunga', { content: AI_SAYS, onCall: markedMeanwhile('r52t') });
    eq(textOf(r), URGENT_HI);
    eq(C('r52t').status, 'human_needed');
    // A refund request with the claim: red + the hand-off (it reaches the team).
    known({ id: 'r52r' }); order('#r52r', 'In Transit');
    r = await say('r52r', 'tracking id invalid hai, mujhe refund chahiye', { content: AI_SAYS, onCall: markedMeanwhile('r52r') });
    eq(textOf(r), HANDOFF.hinglish);
    eq(C('r52r').status, 'human_needed');
    global.__recentSaid = [];
  });

  await t('R53 the one-time move\'s candidate list leaves out a claim that also asks for a refund, cancel or payment (the live route would not mark it) and counts it', async () => {
    const cand = require(path.resolve(__dirname, '../tracking-reship-candidates.js'));
    const now = Date.now();
    const chat = (id) => ({ id, site_id: 'S1', status: 'agent_handling', held: true, verified_order_id: '#' + id, subject_label: null, tracker_business_id: 'P1', order_in_ship_again: false });
    const said = { k1: ['tracking link fake hai, mujhe refund chahiye'], k2: ['tracking link fake hai'], k3: ['tracking link fake hai, mujhe refund chahiye', 'tracking id invalid hai'] };
    const client = { query: async (sql, p) => {
      if (/FROM conversations c JOIN sites s/.test(sql)) return { rows: ['k1', 'k2', 'k3'].map(chat) };
      if (/sender = 'visitor'/.test(sql)) return { rows: p[0].flatMap((id) => said[id].map((content, i) => ({ conversation_id: id, content, t: now - (10 - i) * 60_000 }))) };
      if (/sender = 'agent'/.test(sql)) return { rows: [] };
      if (/FROM orders o/.test(sql)) return { rows: [{ tracking_status: 'In Transit', is_cancelled: false, created_at: new Date(now - 6 * 86400e3), status_updated_at: null, estimated_delivery: null, delivered_at: null, state: null, city: null, origin_city: null }] };
      throw new Error('candidates: unexpected SQL');
    } };
    const out = await cand.run(client);
    deq(out.rows.map((x) => x.id), ['k2', 'k3']);
    deq([out.withClaim, out.noUsable, out.routineOnly, out.threatOnly, out.otherOrderOnly], [3, 1, 1, 0, 0]);
    eq(out.rows.find((x) => x.id === 'k3').hits, 1, 'only the claim without a refund counts');
    const printed = [];
    const log = console.log;
    console.log = (...a) => printed.push(a.join(' '));
    try { cand.report(out); } finally { console.log = log; }
    ok(printed.some((l) => l.includes('only with a refund / payment request with the claim: 1')));
  });

  // ── R54-R64: chargeback / court / police threats on a late order -> Refund (owner 2026-10-02 18:45) ─
  // The REAL widget route, case-auto.ts and refund-threat.ts. Orders are placed 25 Sep with no estimated
  // date, so the day-13 end (8 Oct) is the estimated date and it has passed on these days; NOT_LATE is not.
  const RPROMISE = {
    en: "We're sorry for the trouble. We are processing your refund, and our team will send you a refund form here in this chat to collect your UPI / bank details.",
    hinglish: 'Pareshani ke liye sorry. Hum aapka refund process kar rahe hain, hamari team isi chat me aapko refund form bhejegi jisme aap apni UPI / bank details de payenge.',
    hi: 'परेशानी के लिए माफ़ी चाहते हैं। हम आपका रिफंड प्रोसेस कर रहे हैं, हमारी टीम इसी चैट में आपको रिफंड फॉर्म भेजेगी जिसमें आप अपनी UPI / बैंक डिटेल्स दे पाएँगे।',
  };
  const RREMINDER = {
    en: 'Our team is processing your refund, and they will share the refund proof with you both here in this chat and on your email.',
    hinglish: 'Hamari team aapka refund process kar rahi hai, refund ka proof aapko isi chat aur aapke Gmail / email dono pe de degi.',
    hi: 'हमारी टीम आपका रिफंड प्रोसेस कर रही है, रिफंड का प्रूफ आपको इसी चैट और आपके ईमेल दोनों पर दे देगी।',
  };
  // The owner's own example (a chat of 2 Oct, 18:30 IST).
  const OWNER_EXAMPLE = 'I have raised the complaint against u in consumer department and also at instagram team against u';
  const URGENT_EN = "I'm really sorry for the trouble, and this matters to us. I've passed it to our team right now. Our team will reply to you here in this chat within 1 hour.";
  const refundWrites = (n) => since(n).filter((x) => x.q === REFUND_SQL.mark || x.q === REFUND_SQL.switch || x.q.startsWith('INSERT INTO chat_case_events'));
  const REFUND_STATE_HOOK = /^SELECT c\.site_id, c\.customer_key, c\.status, c\.source, /;
  for (const lang of ['en', 'hinglish', 'hi']) { eq(rt.refundPromiseReply(lang), RPROMISE[lang]); eq(rt.refundReminderReply(lang), RREMINDER[lang]); }

  await t('R54 the owner\'s own example (verified, In Transit, estimated date passed): the fixed promise and Chikki\'s Refund mark in one transaction, no AI call; Hinglish, Hindi, at night the same', async () => {
    at(ist(14, 0, 17));
    makeTokens();
    known({ id: 'r54' });
    order('#r54', 'In Transit');
    global.__recentSaid = [];
    const s0 = db.stmts.length, calls = global.__ai.calls.length;
    const r = await say('r54', OWNER_EXAMPLE);
    eq(textOf(r), RPROMISE.en);
    eq(global.__ai.calls.length, calls, 'no AI call');
    eq(r.body.message.metadata.urgent, 'threat', 'the message is still marked a threat (escalation.ts addition)');
    deq(pick(C('r54'), ['status', 'case_kind', 'case_marked_by', 'case_order_id', 'case_prev_status', 'assigned_to']),
      { status: 'agent_handling', case_kind: 'refund', case_marked_by: 'Chikki (auto)', case_order_id: '#r54', case_prev_status: 'human_needed', assigned_to: null });
    deq(ce('r54'), [['S1', 'refund', 'mark', '#r54', 'Chikki (auto)', 'system']]);
    deq(pick(evs('r54', 'case_mark')[0], ['actor', 'actor_name', 'from_status', 'to_status', 'reason', 'meta']),
      { actor: 'system', actor_name: 'System', from_status: 'ai_handling', to_status: 'agent_handling', reason: 'case_auto', meta: { case: 'refund', auto: true, trigger: 'consumer' } });
    deq(evs('r54', 'status').map((e) => pick(e, ['actor', 'actor_name', 'reason', 'from_status', 'to_status'])),
      [{ actor: 'system', actor_name: 'Chikki (auto)', reason: 'case_auto', from_status: 'ai_handling', to_status: 'agent_handling' }]);
    const txs = txStmts(s0);
    eq(txs.length, 1, 'one transaction');
    const [tx] = txs;
    eq(tx[0], 'BEGIN'); eq(tx[1], "SET LOCAL lock_timeout = '5s'"); ok(/FOR NO KEY UPDATE$/.test(tx[2]));
    const iSet = tx.findIndex((q) => q.startsWith('SELECT set_config')), iUpd = tx.indexOf(REFUND_SQL.mark), iEv = tx.indexOf(OLD_CASE_SQL.eventMark);
    ok(iSet > 2 && iSet < iUpd && iUpd < iEv, 'actor, then the mark, then its event');
    eq(tx[tx.length - 1], 'COMMIT');
    const all = since(s0).map((x) => x.q);
    ok(all.indexOf('COMMIT') < all.findIndex((q) => q.startsWith("INSERT INTO messages (id, conversation_id, sender, content, created_at) VALUES (gen_random_uuid()::text, $1, 'ai'")), 'marked before the customer is told');
    eq(lastAi('r54').content, RPROMISE.en);
    ok(waitingNow('r54'), 'still waiting after the promise: the team owes the refund form');
    // At night: the same promise (no time in it); Hinglish and Hindi in the customer's language.
    at(ist(22, 30, 17));
    for (const [id, said, want, trigger] of [
      ['r54h', 'order bahut late hai, ab chargeback karungi', RPROMISE.hinglish, 'chargeback'],
      ['r54d', 'मैं पुलिस में शिकायत करूँगी', RPROMISE.hi, 'police'],
      ['r54l', 'I will send you a legal notice', RPROMISE.en, 'legal'],
    ]) {
      known({ id }); order('#' + id, 'Out for Delivery');
      eq(textOf(await say(id, said)), want, id);
      deq([C(id).status, C(id).case_kind], ['agent_handling', 'refund'], id);
      deq(evs(id, 'case_mark')[0].meta, { case: 'refund', auto: true, trigger }, id);
    }
  });

  await t('R55 a threat that is not for Refund (estimated date not passed or today, delivered, cancelled, returned, failed, not loadable, old proof, phone match, another order): the 1-hour line, Needs you, no mark', async () => {
    at(ist(11, 0, 18));
    for (const [id, stage, extra] of [
      ['r55a', 'In Transit', NOT_LATE], ['r55b', 'Out for Delivery', { estimated_delivery: '2026-10-18' }],
      ['r55c', 'Delivered', {}], ['r55d', 'In Transit', { cancelled: true }], ['r55e', 'Return to Origin', {}], ['r55f', 'Delivery Exception', {}],
    ]) { known({ id }); order('#' + id, stage, extra); }
    known({ id: 'r55x' });                                                          // the order cannot be loaded
    known({ id: 'r55o', verified_via: 'chat' }); order('#r55o', 'In Transit');      // an old proof (last 4)
    newConv({ id: 'r55p', phone_match_order_id: '#r55p' }); order('#r55p', 'In Transit');   // an old phone match only
    for (const id of ['r55a', 'r55b', 'r55c', 'r55d', 'r55e', 'r55f', 'r55x', 'r55o', 'r55p']) {
      const s0 = db.stmts.length;
      const r = await say(id, 'I will go to consumer court');
      eq(textOf(r), URGENT_EN, id);
      deq([C(id).status, C(id).case_kind, ce(id).length], ['human_needed', null, 0], id);
      eq(refundWrites(s0).length, 0, id);
    }
    known({ id: 'r55q', verified_order_id: '#4755' }); order('#4755', 'In Transit');
    eq(textOf(await say('r55q', 'order #4756 ke liye consumer court jaungi')), URGENT_HI);
    deq([C('r55q').status, C('r55q').case_kind, ce('r55q').length], ['human_needed', null, 0]);
  });

  await t('R56 a social-media threat, a fraud claim or anger alone on a late order: today\'s paths, no Refund (owner)', async () => {
    at(ist(12, 0, 18));
    known({ id: 'r56a' }); order('#r56a', 'In Transit');
    let s0 = db.stmts.length;
    let r = await say('r56a', 'I will post about your company on instagram');
    eq(textOf(r), URGENT_EN);
    deq([C('r56a').status, C('r56a').case_kind], ['human_needed', null]);
    ok(!since(s0).some((x) => x.q === REFUND_SQL.state), 'not even read');
    known({ id: 'r56d' }); order('#r56d', 'In Transit');
    r = await say('r56d', 'complaint against you on instagram');
    eq(textOf(r), URGENT_EN);
    eq(r.body.message.metadata.urgent, 'threat');
    deq([C('r56d').status, C('r56d').case_kind], ['human_needed', null]);
    known({ id: 'r56b' }); order('#r56b', 'In Transit');
    s0 = db.stmts.length;
    r = await say('r56b', 'fraud company ho tum log');
    eq(textOf(r), `${AI_SAYS}\n\nHamari team isi chat mein 1 ghante ke andar aapko jawab degi.`);
    deq([C('r56b').status, C('r56b').case_kind], ['human_needed', null]);
    ok(!since(s0).some((x) => x.q === REFUND_SQL.state));
    known({ id: 'r56c' }); order('#r56c', 'In Transit');
    r = await say('r56c', 'WORST SERVICE EVER, WHERE IS MY ORDER');
    eq(textOf(r), AI_SAYS);
    deq([C('r56c').status, C('r56c').case_kind], ['ai_handling', null]);
  });

  await t('R57 complained first, verified next: a threat in an earlier message or in the verifying one moves it to Refund (it wins over a tracking claim); not late: the threat path; not late and only earlier, or older than 24 hours: as today', async () => {
    at(ist(11, 0, 19));
    newConv({ id: 'r57' }); order('#4757', 'In Transit');
    visitorSaid('r57', 'order nahi aaya to consumer court jaungi', 3);
    let r = await say('r57', 'order 4757, phone 9000000057', { content: FOUND, onCall: verifiesAs('r57', '#4757', '9000000057') });
    eq(textOf(r), RPROMISE.hinglish);
    deq([C('r57').status, C('r57').case_kind, C('r57').case_marked_by], ['agent_handling', 'refund', 'Chikki (auto)']);
    deq(evs('r57', 'case_mark')[0].meta, { case: 'refund', auto: true, trigger: 'consumer' });
    newConv({ id: 'r57b' }); order('#4758', 'In Transit');
    r = await say('r57b', 'order 4758 phone 9000000058, warna chargeback karungi', { content: FOUND, onCall: verifiesAs('r57b', '#4758', '9000000058') });
    eq(textOf(r), RPROMISE.hinglish);
    eq(C('r57b').case_kind, 'refund');
    newConv({ id: 'r57c' }); order('#4759', 'In Transit');
    r = await say('r57c', 'order 4759 phone 9000000059, tracking fake hai, chargeback karungi', { content: FOUND, onCall: verifiesAs('r57c', '#4759', '9000000059') });
    eq(textOf(r), RPROMISE.hinglish);
    deq(ce('r57c').map((e) => [e[1], e[2]]), [['refund', 'mark']], 'Refund, never Ship again');
    newConv({ id: 'r57d' }); order('#4760', 'In Transit', NOT_LATE);
    r = await say('r57d', 'order 4760 phone 9000000060, warna chargeback karungi', { content: FOUND, onCall: verifiesAs('r57d', '#4760', '9000000060') });
    eq(textOf(r), URGENT_HI, 'the threat path, as for a customer verified before');
    deq([C('r57d').status, C('r57d').case_kind, ce('r57d').length], ['human_needed', null, 0]);
    newConv({ id: 'r57e' }); order('#4761', 'In Transit', NOT_LATE);
    visitorSaid('r57e', 'consumer court jaungi', 3);
    r = await say('r57e', 'order 4761, phone 9000000061', { content: FOUND, onCall: verifiesAs('r57e', '#4761', '9000000061') });
    eq(textOf(r), FOUND);
    deq([C('r57e').status, C('r57e').case_kind], ['ai_handling', null]);
    newConv({ id: 'r57f', created_at: new Date(clock - 3 * 86400_000).toISOString() }); order('#4762', 'In Transit');
    visitorSaid('r57f', 'consumer court jaungi', 30 * 60);
    r = await say('r57f', 'order 4762, phone 9000000062', { content: FOUND, onCall: verifiesAs('r57f', '#4762', '9000000062') });
    eq(textOf(r), FOUND);
    deq([C('r57f').status, C('r57f').case_kind], ['ai_handling', null]);
  });

  await t('R58 a Ship again chat with such a threat moves to Refund (remove + mark, the promise; a person\'s mark too); not late: the Ship again rules as before; merged into one: switched there', async () => {
    at(ist(15, 0, 19));
    marked({ id: 'r58' });
    order('#r58', 'In Transit');
    aiSaid('r58', PROMISE.en, 60);
    const calls = global.__ai.calls.length, s0 = db.stmts.length;
    let r = await say('r58', 'link nahi aaya, ab chargeback karungi');
    eq(textOf(r), RPROMISE.hinglish);
    eq(global.__ai.calls.length, calls, 'the AI stays off');
    deq(pick(C('r58'), ['status', 'case_kind', 'case_marked_by', 'case_order_id', 'case_prev_status']),
      { status: 'agent_handling', case_kind: 'refund', case_marked_by: 'Chikki (auto)', case_order_id: '#r58', case_prev_status: 'human_needed' });
    deq(ce('r58').map((e) => [e[1], e[2], e[4], e[5]]),
      [['reship', 'mark', 'Chikki (auto)', 'system'], ['reship', 'remove', 'Chikki (auto)', 'system'], ['refund', 'mark', 'Chikki (auto)', 'system']]);
    deq(evs('r58', 'case_mark').pop().meta, { case: 'refund', auto: true, trigger: 'chargeback', from_case: 'reship' });
    const [tx] = txStmts(s0);
    const iSw = tx.indexOf(REFUND_SQL.switch), iRm = tx.indexOf(OLD_CASE_SQL.eventRemove), iMk = tx.indexOf(OLD_CASE_SQL.eventMark);
    ok(iSw > 0 && iSw < iRm && iRm < iMk, 'the switch, its remove, then the mark, in one transaction');
    ok(waitingNow('r58'));
    // A Ship again chat a person marked: the owner's rule moves it too, and keeps its earlier status for Remove.
    marked({ id: 'r58s', case_prev_status: 'agent_handling' }, 'Rahul', 'manager');
    order('#r58s', 'In Transit');
    r = await say('r58s', 'I will go to consumer court');
    eq(textOf(r), RPROMISE.en);
    deq(pick(C('r58s'), ['status', 'case_kind', 'case_marked_by', 'case_prev_status']), { status: 'agent_handling', case_kind: 'refund', case_marked_by: 'Chikki (auto)', case_prev_status: 'agent_handling' });
    // Not late: as before (Chikki's Ship again: red + the 1-hour line; a person's: nothing).
    marked({ id: 'r58n' }); order('#r58n', 'In Transit', NOT_LATE);
    global.__recentSaid = ['ab chargeback karungi'];
    r = await say('r58n', 'ab chargeback karungi');
    global.__recentSaid = [];
    eq(textOf(r), URGENT_HI);
    deq([C('r58n').status, C('r58n').case_kind], ['human_needed', 'reship']);
    marked({ id: 'r58p' }, 'Rahul', 'manager'); order('#r58p', 'In Transit', NOT_LATE);
    r = await say('r58p', 'ab chargeback karungi');
    eq(textOf(r), null);
    deq([C('r58p').status, C('r58p').case_kind], ['agent_handling', 'reship']);
    // A new chat proves the order and is merged into a Ship again chat: switched there, the model's text dropped.
    marked({ id: 'r58t', customer_key: '9000000580' }); order('#r58t', 'In Transit');
    newConv({ id: 'r58m' });
    r = await say('r58m', 'order r58t phone 9000000580, police complaint karungi', { content: AI_SAYS, onCall: verifiesAs('r58m', '#r58t', '9000000580') });
    eq(r.body.conversationId, 'r58t');
    eq(textOf(r), RPROMISE.hinglish);
    deq([C('r58t').case_kind, C('r58t').status, C('r58m').merged_into], ['refund', 'agent_handling', 'r58t']);
  });

  await t('R58r review fix: a RED Ship again chat (Needs you) with such a threat on a late order is switched to Refund, stays in Needs you and gets the promise; not late, or no threat: nothing is sent, as before', async () => {
    at(ist(15, 0, 24));
    global.__recentSaid = [];
    // Chikki's Ship again chat, flagged red earlier (the customer asked for a refund): status human_needed.
    marked({ id: 'r58r', status: 'human_needed' }); order('#r58r', 'In Transit');
    aiSaid('r58r', PROMISE.en, 120);
    const calls = global.__ai.calls.length, s0 = db.stmts.length;
    let r = await say('r58r', 'refund nahi diya to consumer court jaungi');
    eq(textOf(r), RPROMISE.hinglish);
    eq(global.__ai.calls.length, calls, 'the AI stays off');
    deq(pick(C('r58r'), ['status', 'case_kind', 'case_marked_by', 'case_order_id', 'case_prev_status']),
      { status: 'human_needed', case_kind: 'refund', case_marked_by: 'Chikki (auto)', case_order_id: '#r58r', case_prev_status: 'human_needed' });
    deq(ce('r58r').map((e) => [e[1], e[2], e[4], e[5]]),
      [['reship', 'mark', 'Chikki (auto)', 'system'], ['reship', 'remove', 'Chikki (auto)', 'system'], ['refund', 'mark', 'Chikki (auto)', 'system']]);
    deq(evs('r58r', 'case_mark').pop().meta, { case: 'refund', auto: true, trigger: 'consumer', from_case: 'reship' });
    const [tx] = txStmts(s0);
    ok(tx.indexOf(REFUND_SQL.switch) > 0, 'the switch, in its own transaction');
    const all = since(s0).map((x) => x.q);
    ok(all.indexOf('COMMIT') < all.findIndex((q) => q.startsWith("INSERT INTO messages (id, conversation_id, sender, content, created_at) VALUES (gen_random_uuid()::text, $1, 'ai'")), 'marked before the customer is told');
    ok(waitingNow('r58r'));
    // A person's red Ship again chat: the owner's rule moves it too.
    marked({ id: 'r58q', status: 'human_needed', case_prev_status: 'agent_handling' }, 'Rahul', 'manager'); order('#r58q', 'In Transit');
    eq(textOf(await say('r58q', 'I will go to consumer court')), RPROMISE.en);
    deq([C('r58q').status, C('r58q').case_kind, C('r58q').case_marked_by], ['human_needed', 'refund', 'Chikki (auto)']);
    // Not late: a red chat sends nothing and keeps its mark (today's behaviour).
    marked({ id: 'r58o', status: 'human_needed' }); order('#r58o', 'In Transit', NOT_LATE);
    let s1 = db.stmts.length;
    r = await say('r58o', 'ab chargeback karungi');
    eq(textOf(r), null);
    deq([C('r58o').status, C('r58o').case_kind, ce('r58o').length], ['human_needed', 'reship', 1]);
    eq(refundWrites(s1).length, 0);
    // No such threat in a red chat: nothing is read for the rule, nothing is sent.
    marked({ id: 'r58w', status: 'human_needed' }); order('#r58w', 'In Transit');
    s1 = db.stmts.length;
    r = await say('r58w', 'link kab aayega?');
    eq(textOf(r), null);
    deq([C('r58w').status, C('r58w').case_kind], ['human_needed', 'reship']);
    ok(!since(s1).some((x) => REFUND_STATE_HOOK.test(x.q)), 'the Refund rule never reads the chat');
  });

  await t('R59 after Chikki\'s Refund mark: ONE reminder (proof in this chat and on email) in any language, then nothing; "ok": nothing; the team or the Super Admin\'s form wrote: nothing; a person\'s mark: nothing; kept in Needs you; merged into one', async () => {
    at(ist(11, 0, 20));
    known({ id: 'r59' }); order('#r59', 'In Transit');
    eq(textOf(await say('r59', 'chargeback karungi')), RPROMISE.hinglish);
    at(clock + 3600_000);
    const calls = global.__ai.calls.length;
    global.__recentSaid = ['refund kab milega?', 'chargeback karungi'];
    let r = await say('r59', 'refund kab milega?');
    eq(textOf(r), RREMINDER.hinglish);
    eq(global.__ai.calls.length, calls, 'the AI stays off');
    eq(C('r59').status, 'agent_handling');
    ok(waitingNow('r59'), 'still waiting after the reminder');
    at(clock + 600_000);
    global.__recentSaid = ['hello??', 'refund kab milega?', 'chargeback karungi'];
    eq(textOf(await say('r59', 'hello??')), null, 'one reminder only');
    global.__recentSaid = ['When will I get my refund?'];
    eq(textOf(await say('r59', 'When will I get my refund?')), null, 'not again in another language');
    eq(db.messages.filter((m) => m.conversation_id === 'r59' && m.sender === 'ai' && /refund ka proof|refund proof/.test(m.content)).length, 1);
    ok(waitingNow('r59'));
    // "ok thanks" after the promise: nothing; the reminder stays for a real question.
    known({ id: 'r59k' }); order('#r59k', 'In Transit');
    global.__recentSaid = [];
    eq(textOf(await say('r59k', 'I will file a police complaint')), RPROMISE.en);
    at(clock + 60_000);
    global.__recentSaid = ['ok thanks'];
    eq(textOf(await say('r59k', 'ok thanks')), null);
    global.__recentSaid = ['where is my refund?'];
    eq(textOf(await say('r59k', 'where is my refund?')), RREMINDER.en);
    // Hindi.
    known({ id: 'r59h' }); order('#r59h', 'In Transit');
    global.__recentSaid = [];
    eq(textOf(await say('r59h', 'मैं कंज्यूमर कोर्ट जाऊँगी')), RPROMISE.hi);
    at(clock + 60_000);
    global.__recentSaid = ['रिफंड कब मिलेगा?'];
    eq(textOf(await say('r59h', 'रिफंड कब मिलेगा?')), RREMINDER.hi);
    // The Super Admin's refund form message (sender 'system') counts as the team writing: nothing.
    known({ id: 'r59t' }); order('#r59t', 'In Transit');
    global.__recentSaid = [];
    eq(textOf(await say('r59t', 'chargeback karungi')), RPROMISE.hinglish);
    at(clock + 60_000);
    db.messages.push({ id: 'r59t-s', conversation_id: 'r59t', sender: 'system', content: 'Aapke order ki refund request ke liye ye form bhariye: [refund form link]', metadata: { system: 'refund', step: 'form', lang: 'hinglish' }, created_at: nowIso(), deleted_at: null });
    at(clock + 60_000);
    global.__recentSaid = ['form kaise bharu?'];
    eq(textOf(await say('r59t', 'form kaise bharu?')), null);
    // A person's Refund mark: nothing, as before.
    known({ id: 'r59p', status: 'agent_handling', case_kind: 'refund', case_marked_by: 'Rahul', case_marked_at: nowIso(), case_order_id: '#r59p', case_prev_status: 'human_needed' });
    db.caseEvents.push({ id: crypto.randomUUID(), conversation_id: 'r59p', site_id: 'S1', kind: 'refund', action: 'mark', order_id: '#r59p', actor: 'Rahul', actor_role: 'manager' });
    at(clock + 60_000);
    eq(textOf(await say('r59p', 'refund kab milega?')), null);
    eq(C('r59p').status, 'agent_handling');
    // A chat waiting in Needs you (merged into): Refund AND it stays in Needs you; its next message gets the reminder once.
    known({ id: 'r59w', status: 'human_needed', customer_key: '9000000591', created_at: new Date(clock - 2 * 86400_000).toISOString() });
    order('#r59w', 'In Transit');
    newConv({ id: 'r59x', created_at: new Date(clock - 5 * 60_000).toISOString() });
    global.__recentSaid = [];
    r = await say('r59x', 'order r59w phone 9000000591, consumer court jaungi', { content: AI_SAYS, onCall: verifiesAs('r59x', '#r59w', '9000000591') });
    eq(r.body.conversationId, 'r59w');
    eq(textOf(r), RPROMISE.hinglish);
    deq(pick(C('r59w'), ['status', 'case_kind', 'case_prev_status']), { status: 'human_needed', case_kind: 'refund', case_prev_status: 'human_needed' });
    deq(pick(evs('r59w', 'case_mark')[0], ['from_status', 'to_status']), { from_status: 'human_needed', to_status: 'human_needed' });
    at(clock + 60_000);
    global.__recentSaid = ['refund kab?'];
    eq(textOf(await say('r59w', 'refund kab?')), RREMINDER.hinglish);
    eq(C('r59w').status, 'human_needed');
    // A new chat proves the order and is merged into Chikki's Refund chat: the model's text dropped, the reminder.
    known({ id: 'r59m', customer_key: '9000000590' }); order('#r59m', 'In Transit');
    global.__recentSaid = [];
    eq(textOf(await say('r59m', 'chargeback karungi')), RPROMISE.hinglish);
    newConv({ id: 'r59n' });
    at(clock + 60_000);
    global.__recentSaid = ['order r59m phone 9000000590, refund kab?'];
    r = await say('r59n', 'order r59m phone 9000000590, refund kab?', { content: AI_SAYS, onCall: verifiesAs('r59n', '#r59m', '9000000590') });
    global.__recentSaid = [];
    eq(r.body.conversationId, 'r59m');
    eq(textOf(r), RREMINDER.hinglish);
    ok(!db.messages.some((m) => m.conversation_id === 'r59m' && m.content === AI_SAYS), 'the model\'s text never sent');
  });

  await t('R60 races: the chat locked elsewhere: the 1-hour line, Needs you, no mark; a Refund mark found on the locked row: the reminder (Chikki, a moment ago) or the hand-off (a person); Ship again meanwhile: switched; Closed meanwhile: no mark', async () => {
    at(ist(15, 0, 20));
    global.__recentSaid = [];
    known({ id: 'r60' }); order('#r60', 'In Transit');
    const free = holdLock('r60');
    let r;
    try { r = await say('r60', 'chargeback karungi'); } finally { free(); }
    eq(textOf(r), URGENT_HI);
    deq([C('r60').status, C('r60').case_kind, ce('r60').length], ['human_needed', null, 0]);
    known({ id: 'r60a' }); order('#r60a', 'In Transit');
    db.after.push({ re: REFUND_STATE_HOOK, fn: () => Object.assign(C('r60a'), { case_kind: 'refund', case_marked_by: 'Chikki (auto)', case_marked_at: new Date(clock - 60_000).toISOString(), case_order_id: '#r60a', status: 'agent_handling' }) });
    r = await say('r60a', 'chargeback karungi');
    eq(textOf(r), RREMINDER.hinglish);
    deq([C('r60a').status, ce('r60a').length], ['agent_handling', 0]);
    known({ id: 'r60b' }); order('#r60b', 'In Transit');
    db.after.push({ re: REFUND_STATE_HOOK, fn: () => Object.assign(C('r60b'), { case_kind: 'refund', case_marked_by: 'Rahul', case_marked_at: nowIso(), case_order_id: '#r60b', status: 'agent_handling' }) });
    r = await say('r60b', 'chargeback karungi');
    eq(textOf(r), HANDOFF.hinglish);
    deq([C('r60b').status, C('r60b').case_kind, C('r60b').case_marked_by], ['agent_handling', 'refund', 'Rahul']);
    known({ id: 'r60c' }); order('#r60c', 'In Transit');
    db.after.push({ re: REFUND_STATE_HOOK, fn: () => Object.assign(C('r60c'), { case_kind: 'reship', case_marked_by: 'Chikki (auto)', case_marked_at: nowIso(), case_order_id: '#r60c', case_prev_status: 'human_needed', status: 'agent_handling' }) });
    r = await say('r60c', 'chargeback karungi');
    eq(textOf(r), RPROMISE.hinglish);
    deq([C('r60c').case_kind, C('r60c').status], ['refund', 'agent_handling']);
    deq(ce('r60c').map((e) => [e[1], e[2]]), [['reship', 'remove'], ['refund', 'mark']]);
    known({ id: 'r60d' }); order('#r60d', 'In Transit');
    db.after.push({ re: REFUND_STATE_HOOK, fn: () => setRow(null, C('r60d'), { status: 'resolved' }) });
    r = await say('r60d', 'chargeback karungi');
    ok(textOf(r) !== RPROMISE.hinglish, 'never the promise without the mark');
    deq([C('r60d').status, C('r60d').case_kind, ce('r60d').length], ['resolved', null, 0]);
  });

  await t('R61 Remove on Chikki\'s Refund mark sends the chat to Needs you; it is never marked Refund by itself again; the same order in Refund in another chat: the threat path', async () => {
    at(ist(11, 0, 21));
    makeTokens();
    global.__recentSaid = [];
    known({ id: 'r61' }); order('#r61', 'In Transit');
    eq(textOf(await say('r61', 'chargeback karungi')), RPROMISE.hinglish);
    status(await patch('owner', 'r61', { caseKind: null }), 200);
    deq([C('r61').status, C('r61').case_kind], ['human_needed', null]);
    status(await patch('owner', 'r61', { status: 'ai_handling' }), 200);
    at(clock + 60_000);
    const s0 = db.stmts.length;
    eq(textOf(await say('r61', 'consumer court jaungi')), URGENT_HI);
    deq([C('r61').status, C('r61').case_kind], ['human_needed', null]);
    ok(!since(s0).some((x) => x.q === REFUND_SQL.mark || x.q === REFUND_SQL.switch));
    deq(ce('r61').map((e) => [e[1], e[2]]), [['refund', 'mark'], ['refund', 'remove']]);
    known({ id: 'r61a', verified_order_id: '#r61o' });
    known({ id: 'r61b', verified_order_id: '#r61o', status: 'agent_handling', case_kind: 'refund', case_marked_by: 'Rahul', case_marked_at: nowIso(), case_order_id: '#r61o' });
    order('#r61o', 'In Transit');
    eq(textOf(await say('r61a', 'chargeback karungi')), URGENT_HI);
    deq([C('r61a').status, C('r61a').case_kind, ce('r61a').length], ['human_needed', null, 0]);
    deq([C('r61b').status, C('r61b').case_kind], ['agent_handling', 'refund']);
  });

  await t('R62 the one-time move (--apply <ids> after the owner\'s OK): the same rule, mark and promise; a Closed chat opens in Refund, Needs you stays, Ship again is switched; anything else is refused and nothing is written', async () => {
    at(ist(11, 0, 22));
    global.__recentSaid = [];
    const auto = require(path.join(dir, 'case-auto.js'));
    // A chat staff Closed right after the customer's threat (the chat that started this).
    known({ id: 'r62', status: 'resolved', closed_by_name: 'Rahul', closed_at: nowIso() }); order('#r62', 'In Transit');
    visitorSaid('r62', OWNER_EXAMPLE, 2 * 24 * 60);
    let s0 = db.stmts.length;
    let res = await auto.applyRefundThreatMove('r62', 7);
    deq(res, { done: 'marked', from: null, keptInNeedsYou: false, posted: true, trigger: 'consumer' });
    deq(pick(C('r62'), ['status', 'case_kind', 'case_marked_by', 'case_prev_status']),
      { status: 'agent_handling', case_kind: 'refund', case_marked_by: 'Chikki (auto)', case_prev_status: 'human_needed' });
    eq(lastAi('r62').content, RPROMISE.en);
    deq(evs('r62', 'case_mark')[0].meta, { case: 'refund', auto: true, trigger: 'consumer', move: true });
    deq(ce('r62'), [['S1', 'refund', 'mark', '#r62', 'Chikki (auto)', 'system']]);
    const all = since(s0).map((x) => x.q);
    ok(all.indexOf('COMMIT') < all.findIndex((q) => q.startsWith('INSERT INTO messages (id, conversation_id, sender, content, created_at)')), 'marked before the promise');
    ok(waitingNow('r62'));
    known({ id: 'r62n', status: 'human_needed' }); order('#r62n', 'In Transit');
    visitorSaid('r62n', 'chargeback karungi', 60);
    res = await auto.applyRefundThreatMove('r62n', 7);
    deq([res.done, res.keptInNeedsYou, C('r62n').status, C('r62n').case_kind], ['marked', true, 'human_needed', 'refund']);
    eq(lastAi('r62n').content, RPROMISE.hinglish);
    marked({ id: 'r62s' }); order('#r62s', 'In Transit');
    visitorSaid('r62s', 'police complaint karungi', 60);
    res = await auto.applyRefundThreatMove('r62s', 7);
    deq([res.done, res.from, C('r62s').case_kind], ['marked', 'reship', 'refund']);
    // Refused, nothing written.
    known({ id: 'r62a' }); order('#r62a', 'In Transit'); visitorSaid('r62a', OWNER_EXAMPLE, 9 * 24 * 60);
    known({ id: 'r62b' }); order('#r62b', 'In Transit', NOT_LATE); visitorSaid('r62b', OWNER_EXAMPLE, 60);
    known({ id: 'r62c' }); order('#r62c', 'Delivered'); visitorSaid('r62c', OWNER_EXAMPLE, 60);
    newConv({ id: 'r62d' }); visitorSaid('r62d', OWNER_EXAMPLE, 60);
    known({ id: 'r62e', status: 'agent_handling', case_kind: 'refund', case_marked_by: 'Rahul', case_marked_at: nowIso(), case_order_id: '#r62e' }); order('#r62e', 'In Transit'); visitorSaid('r62e', OWNER_EXAMPLE, 60);
    known({ id: 'r62f', merged_into: 'r62' }); visitorSaid('r62f', OWNER_EXAMPLE, 60);
    known({ id: 'r62g', verified_order_id: '#4763' }); order('#4763', 'In Transit'); visitorSaid('r62g', 'order #4799 ke liye consumer court jaungi', 60);
    const before = db.messages.length;
    s0 = db.stmts.length;
    const why = {};
    for (const id of ['r62a', 'r62b', 'r62c', 'r62d', 'r62e', 'r62f', 'r62g', 'r62zz']) {
      const out = await auto.applyRefundThreatMove(id, 7);
      eq(out.done, 'refused', id);
      why[id] = out.why;
    }
    deq(why, {
      r62a: 'no such threat from the customer in the last 7 days', r62b: 'estimated date not passed', r62c: 'delivered order',
      r62d: 'not verified by order ID + full phone', r62e: 'already in Refund', r62f: 'merged into another chat',
      r62g: 'no such threat from the customer in the last 7 days', r62zz: 'no such chat',
    });
    eq(db.messages.length, before, 'no message posted');
    eq(refundWrites(s0).length, 0, 'no mark written');
  });

  await t('R63 the read-only list (scripts/refund-threat-candidates.js) uses the same rule and prints no customer words; --apply never runs without ids', async () => {
    const cand = require(path.resolve(__dirname, '../refund-threat-candidates.js'));
    deq(cand.parseArgs([]), { mode: 'list', ids: [], days: 7 });
    ok(cand.parseArgs(['--apply']).error && cand.parseArgs(['abc']).error && cand.parseArgs(['--days', '0']).error);
    ok(cand.parseArgs(['--apply', "x'; drop table"]).error);
    deq(cand.parseArgs(['--apply', 'a1,b2', 'c3', 'a1', '--days', '10']), { mode: 'apply', ids: ['a1', 'b2', 'c3'], days: 10 });
    const now = ist(12, 0, 22);
    const chat = (id, o = {}) => ({ id, site_id: 'S1', status: 'agent_handling', case_kind: null, held: false, verified_order_id: '#' + id, verified_via: 'form',
      subject_label: null, health_score: 77, tracker_business_id: 'P1', refund_removed: false, order_in_refund: false, ...o });
    const said = { k1: [OWNER_EXAMPLE], k2: ['tracking link fake hai'], k3: ['chargeback karungi'], k4: ['police complaint karungi'], k5: ['order #9999 pe consumer court jaungi'], k6: ['I will post on instagram'], k7: ['consumer court jaungi'],
      // Review fixes 2026-10-02: an amount is not another order; a COD order stays out.
      k8: ['I paid 1499 and got nothing, chargeback karungi'], k9: ['consumer court jaungi'] };
    const late = { k1: true, k4: true, k7: true, k8: true, k9: true };
    const client = { query: async (sql, p) => {
      if (/FROM conversations c JOIN sites s/.test(sql)) { eq(p[0], 7); return { rows: [chat('k1', { status: 'resolved' }), chat('k2'), chat('k3'), chat('k4', { case_kind: 'reship' }), chat('k5'), chat('k6'), chat('k7', { refund_removed: true }), chat('k8'), chat('k9')] }; }
      if (/sender = 'visitor'/.test(sql)) { eq(p[1], 7); return { rows: p[0].flatMap((id) => (said[id] || []).map((content, i) => ({ conversation_id: id, content, t: now - (10 - i) * 60_000 }))) }; }
      if (/sender IN \('agent', 'system'\)/.test(sql)) return { rows: [{ conversation_id: 'k4', t: now }] };
      if (/FROM orders o/.test(sql)) {
        return { rows: [{ tracking_status: 'In Transit', is_cancelled: false, created_at: new Date(now - 6 * 86400e3), status_updated_at: null,
          estimated_delivery: late[p[0].slice(1)] ? '2026-10-12' : '2026-10-30', delivered_at: null, state: null, city: null, origin_city: null,
          payment_method: p[0] === '#k9' ? 'COD' : 'prepaid' }] };
      }
      throw new Error('candidates: unexpected SQL');
    } };
    const out = await cand.run(client, { days: 7, now });
    deq(out.rows.map((x) => [x.id, x.from, x.threat, x.status, x.days_late]), [['k1', '-', 'consumer', 'resolved', 10], ['k4', 'Ship again', 'police', 'agent_handling', 10], ['k8', '-', 'chargeback', 'agent_handling', 10]]);
    eq(out.rows[1].team_replied_after_last_hit, true);
    deq(out.why, { 'estimated date not passed': 1, 'Refund removed before': 1, 'COD order, nothing paid': 1 });
    deq([out.withThreat, out.otherOrderOnly], [7, 1]);
    const printed = [];
    const log = console.log;
    console.log = (...a) => printed.push(a.join(' '));
    try { cand.report(out); } finally { console.log = log; }
    ok(printed.some((l) => l.includes('node scripts/refund-threat-candidates.js --apply k1 k4 k8')));
    ok(!printed.some((l) => /consumer department|chargeback karungi|instagram|#k1|#k4/i.test(l)), 'no customer words or order IDs');
    // The move runs the app's own server function (case-auto.ts), never a copy of it.
    const src = fs.readFileSync(path.resolve(__dirname, '../refund-threat-candidates.js'), 'utf8');
    ok(/auto\.applyRefundThreatMove/.test(src) && !/INSERT INTO|UPDATE conversations/.test(src), 'no write SQL of its own');
  });

  await t('R64 owner 19:20: a Hinglish "fir" (= phir), the store\'s "consumer care", an address with a court or police station on a late order never go to Refund (today\'s path); FIR in capitals among lower-case words, or F.I.R., does', async () => {
    at(ist(12, 0, 23));
    global.__recentSaid = [];
    const promises = Object.values(RPROMISE);
    for (const [id, said] of [
      ['r64a', 'order nahi aaya to fir complaint karungi'],   // "then I will complain": a threat today, never Refund
      ['r64b', 'fir kab aayega mera order'], ['r64c', 'fir se tracking link bhejo'], ['r64d', 'FIR KAB AAYEGA ORDER'],
      ['r64e', 'consumer care number do'], ['r64f', 'mera address: Opp. District Court, Raipur'], ['r64g', 'papa police me hai, unke liye XL size'],
    ]) {
      known({ id }); order('#' + id, 'In Transit');
      const s0 = db.stmts.length;
      const r = await say(id, said);
      ok(!promises.includes(textOf(r)), `${id}: no refund promise`);
      deq([C(id).case_kind, ce(id).length], [null, 0], id);
      ok(!since(s0).some((x) => x.q === REFUND_SQL.state), `${id}: the Refund rule never even reads the chat`);
      if (id === 'r64b' || id === 'r64c') eq(textOf(r), AI_SAYS, `${id}: not a threat at all, the AI answers`);
    }
    // The police report itself.
    for (const [id, said] of [['r64p', 'Mai FIR karwa dungi, order bahut late hai'], ['r64q', 'F.I.R. karungi main, order nahi aaya']]) {
      known({ id }); order('#' + id, 'In Transit');
      eq(textOf(await say(id, said)), RPROMISE.hinglish, id);
      deq([C(id).case_kind, C(id).case_marked_by], ['refund', 'Chikki (auto)'], id);
      deq(evs(id, 'case_mark')[0].meta, { case: 'refund', auto: true, trigger: 'police' }, id);
    }
  });

  await t('R65 review fixes: an amount or a date in the threat is not another order; a COD order, a complaint to the store\'s own staff, a "not" in Hinglish, a money-back question, or the refund form switched off: never Refund', async () => {
    at(ist(12, 0, 24));
    global.__recentSaid = [];
    const promises = Object.values(RPROMISE);
    // The amount paid, a date: still the verified order (scen. S10, S11).
    known({ id: 'r65a', verified_order_id: '#4801' }); order('#4801', 'In Transit');
    eq(textOf(await say('r65a', 'I paid 1499 and got nothing, I will file a chargeback')), RPROMISE.en);
    deq([C('r65a').case_kind, C('r65a').case_marked_by], ['refund', 'Chikki (auto)']);
    known({ id: 'r65b', verified_order_id: '#4802' }); order('#4802', 'In Transit');
    eq(textOf(await say('r65b', 'ordered on 25/09/2026, still nothing. chargeback karungi')), RPROMISE.hinglish);
    eq(C('r65b').case_kind, 'refund');
    // A Cash on Delivery order that is not delivered: nothing was paid, today's threat path (scen. S2).
    known({ id: 'r65c' }); order('#r65c', 'In Transit', { payment: 'Cash on Delivery (COD)' });
    let s0 = db.stmts.length;
    eq(textOf(await say('r65c', 'order nahi aaya, consumer court jaungi')), URGENT_HI);
    deq([C('r65c').status, C('r65c').case_kind, ce('r65c').length], ['human_needed', null, 0]);
    eq(refundWrites(s0).length, 0);
    // Not this rule at all: a complaint to the store's own staff, a Hinglish "I will NOT ...", a money-back question.
    for (const [id, said] of [
      ['r65d', 'Can I raise a complaint against you here?'], ['r65e', 'I will complain against you to your manager'],
      ['r65g', 'legal action nahi lena chahti, bas order bhej do'], ['r65h', 'police me complaint nahi karungi, bas order bhejo'],
      ['r65i', 'bank se paise wapas kab aayenge'], ['r65j', 'aap courier pe case file kar do na please'],
    ]) {
      known({ id }); order('#' + id, 'In Transit');
      s0 = db.stmts.length;
      const r = await say(id, said);
      ok(!promises.includes(textOf(r)), `${id}: no refund promise`);
      deq([C(id).case_kind, ce(id).length], [null, 0], id);
      eq(refundWrites(s0).length, 0, id);
    }
    ok(!(db.messages.find((m) => m.conversation_id === 'r65i' && m.sender === 'visitor').metadata || {}).urgent, 'a money-back question is not a threat');
    ok(!(db.messages.find((m) => m.conversation_id === 'r65j' && m.sender === 'visitor').metadata || {}).urgent, 'asking the store to chase the courier is not a threat');
    // REFUND_FORMS=off (the owner's kill switch): no refund form can be sent, so none is promised.
    process.env.REFUND_FORMS = 'off';
    try {
      known({ id: 'r65k' }); order('#r65k', 'In Transit');
      s0 = db.stmts.length;
      eq(textOf(await say('r65k', 'I will go to consumer court')), URGENT_EN);
      deq([C('r65k').status, C('r65k').case_kind, ce('r65k').length], ['human_needed', null, 0]);
      eq(refundWrites(s0).length, 0);
      const auto = require(path.join(dir, 'case-auto.js'));
      known({ id: 'r65m' }); order('#r65m', 'In Transit'); visitorSaid('r65m', OWNER_EXAMPLE, 60);
      deq(await auto.applyRefundThreatMove('r65m', 7), { done: 'refused', why: 'refund form switched off' });
      eq(C('r65m').case_kind, null);
    } finally { delete process.env.REFUND_FORMS; }
    known({ id: 'r65n' }); order('#r65n', 'In Transit');
    eq(textOf(await say('r65n', 'I will go to consumer court')), RPROMISE.en, 'switched on again');
  });

  Object.assign(console, realConsole);
  Date.now = realNow;
  console.log(`TEAM-ROUTING: ${n} groups passed`);
  process.exit(0);
})().catch((e) => { Object.assign(console, realConsole); console.error(e); process.exit(1); });
