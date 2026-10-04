// Team score, part 4 (owner, 2026-10-01): the server side through the REAL code. load.ts, report.ts,
// judge.ts, the three routes (/api/team/score, /api/team/score/items, /api/cron/team-score), auth.ts
// and permissions.ts run against a fake database that answers each SQL statement by regex (as in
// auth-flow.js) and keeps the Postgres rules that matter here: time bounds exactly as the SQL writes
// them, the one 'auto' row per day, ON CONFLICT, CHECKs, bigint ids as strings, every $n used. The AI
// client and next/server are fakes. No network, no real database, no model, nothing sent.
//   R1  auth: 401 / 403 / 200, the first request waits for the logins; POST is the Super Admin's
//   R2  dates                     R3  answer shape, no phone / customer key anywhere
//   R4  one READ ONLY transaction, 57014 / 42P01 answers
//   R5  frozen days, the 60 s / 10 min cache, Refresh, one load per click
//   R6  drill-down rows: frozen (jsonb_path_query_array) and live, masked, at most 200
//   R7  point weights: forward only     R8  Recompute with a reason
//   R9  cron secret fails closed, dry run writes nothing
//   R10 the AI check: verdict rows, unclear, failures, circuit breaker, caps, budget
//   R11 what the model is sent (attemptOrder()[0] first, temperature 0, no names / points), logs
//   R12 freezing settled days      R13 a day computed after D+2 keeps the numbers it had
//   R15 review fixes 2026-10-02: one AI check run at a time (cron and Check now never ask twice);
//       Recompute only a day the cron already froze
//   R14 owner answer A1 (2026-10-02): a member who can reply sees only their own row and items;
//       the cache holds the full result and is filtered per request (nothing leaks between viewers)
//   R16 review 2026-10-02 (second pass): the Points rules dialog's base is the newest saved weights
//       row (plus today's and the planned ones), never the day on screen; "more than 60 days ahead"
//       has its own message; a frozen pending "Convinced" is counted as not counted
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const ts = require('typescript');

const SRC = path.resolve(__dirname, '../../src');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-score-route-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

process.env.AUTH_TOKEN_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.ADMIN_USERNAME = 'Owner';
process.env.ADMIN_PASSWORD = 'env-pass-123';
delete process.env.CRON_SECRET;
const CRON = 'test-cron-secret-7781';

// India time, and a clock the test moves (every module reads Date.now()).
const ist = (s) => Date.parse(s.replace(' ', 'T') + ':00+05:30');
const isoOf = (s) => new Date(ist(s)).toISOString();
const BASE_NOW = ist('2026-10-08 14:00');
let NOW = BASE_NOW;
const realNow = Date.now;
Date.now = () => NOW;

// ── Fake next/server and AI client ─────────────────────────────
fs.writeFileSync(path.join(dir, 'next-server.js'), `
class NextResponse { static json(body, init = {}) { return { status: init.status || 200, body, headers: init.headers || {}, json: async () => body }; } }
class NextRequest {}
module.exports = { NextResponse, NextRequest };`);
// isRetryable copies ai.ts (401 / 403 stop the chain, anything else moves to the next model).
fs.writeFileSync(path.join(dir, 'ai.js'), `
module.exports = {
  attemptOrder: () => global.__fakeAi.order.slice(),
  sideAttemptOrder: () => global.__fakeAi.order.slice(),
  getClient: () => ({ chat: { completions: { create: (body, opts) => global.__fakeAi.create(body, opts) } } }),
  isRetryable: (err) => { const s = err && err.status; return s !== 401 && s !== 403; },
};`);
const ai = { order: ['fake/primary-model', 'fake/fallback-model'], calls: [], mode: 'yes', onCall: null };
ai.create = async (body, opts) => {
  ai.calls.push({ body: JSON.parse(JSON.stringify(body)), opts: { ...opts } });
  if (ai.onCall) ai.onCall(body);
  const fail = (status) => { const e = new Error('model down'); e.status = status; throw e; };
  if (ai.mode === 'throw') fail(503);
  if (ai.mode === 'throw401') fail(401);
  if (ai.mode === 'garbage') return { choices: [{ message: { content: 'maybe, hard to say' }, finish_reason: 'stop' }] };
  if (ai.mode === 'firstGarbage' && body.model === ai.order[0]) return { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
  if (ai.mode === 'think') return { choices: [{ message: { content: '<think>THANKS=no</think>THANKS=yes CONVINCED=yes' } }] };
  return { choices: [{ message: { content: 'THANKS=yes CONVINCED=no' }, finish_reason: 'stop' }] };
};
global.__fakeAi = ai;

// ── Fake database ──────────────────────────────────────────────
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const pgRe = (re) => new RegExp(re.replace(/\[:space:\]/g, '\\s'), 'i');   // POSIX class -> JS, as Postgres ~* reads it
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';   // Anurag, junior
const R = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';   // Rahul, senior
const N = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';   // Neha, panel admin (junior)
const P = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';   // Pooja, viewer (cannot reply)
const V = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';   // Ravi, removed (only in old events)
const db = { log: [], fail: null, adminGate: null, violations: [] };
let txSeq = 0;
const rows = (r) => ({ rows: r, rowCount: r.length });
const ms = (x) => Date.parse(x);
const isAuthSql = (q) => /FROM team_users$|FROM admin_login|staff_presence(?!_days)/.test(q);

// Postgres refuses a statement that sends a parameter it never reads ("could not determine data type
// of parameter $n") or reads one it was not sent.
function checkParams(q, params) {
  const used = new Set(Array.from(q.matchAll(/\$(\d+)/g), (m) => Number(m[1])));
  for (let i = 1; i <= params.length; i++) if (!used.has(i)) throw new Error(`fake db: $${i} is sent but never used: ${q.slice(0, 90)}`);
  for (const u of used) if (u > params.length) throw new Error(`fake db: $${u} is used but not sent: ${q.slice(0, 90)}`);
}
// Holder / status / case / health rows: the time bound applies only when the SQL has one.
const upperBound = (q, params) => {
  const m = q.match(/AND (?:at|created_at) < \$(\d+)::timestamptz/);
  return m ? ms(params[Number(m[1]) - 1]) : Infinity;
};

async function handle(sql, params = [], tx = null) {
  const q = sql.replace(/\s+/g, ' ').trim();
  db.log.push({ q, params, tx });
  if (/AT TIME ZONE/i.test(q)) db.violations.push('AT TIME ZONE on a column: ' + q.slice(0, 80));
  checkParams(q, params);
  if (db.fail && db.fail.re.test(q)) {
    const f = db.fail; if (!f.keep) db.fail = null;
    const e = new Error(f.code === '57014' ? 'canceling statement due to statement timeout' : f.code === '42P01' ? 'relation does not exist' : 'boom'); e.code = f.code; throw e;
  }
  // ── auth.ts ──
  if (/^SELECT id, username, display_name, role, is_active, business_ids, permissions, session_version FROM team_users$/.test(q)) return rows(db.team.map((u) => ({ ...u })));
  if (/^SELECT username, password_hash, session_version, updated_at FROM admin_login WHERE id = 1$/.test(q)) {
    if (db.adminGate) await db.adminGate;
    return rows(db.admin ? [{ ...db.admin }] : []);
  }
  if (/^INSERT INTO staff_presence \(actor, last_seen_at\) SELECT \* FROM unnest/.test(q)) return rows([]);
  if (/^SELECT actor, last_seen_at FROM staff_presence$/.test(q)) return rows([]);
  // ── load.ts ──
  if (/^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$/.test(q) || /^SET LOCAL statement_timeout = '8s'$/.test(q)) return rows([]);
  if (/^WITH ids AS \( SELECT DISTINCT m\.conversation_id AS id FROM messages m/.test(q)) {
    // The customer key and phone never leave SQL: only md5 refs and "IS NOT NULL" tests.
    const list = q.slice(q.indexOf(') SELECT c.id'), q.indexOf(' FROM conversations c WHERE'));
    if (/customer_key|phone/.test(list.replace(/md5\([^)]*\)/g, '').replace(/c\.(customer_key|verified_order_id|phone_match_order_id) IS NOT NULL/g, ''))) db.violations.push('Q1 selects a raw customer key / phone');
    const lo = ms(params[0]), hi = ms(params[1]);
    const ids = new Set();
    for (const m of db.msgs) if (m.at >= lo && m.at < hi && ['visitor', 'agent', 'ai'].includes(m.sender)) ids.add(m.conv);
    for (const h of db.holders) if (h.at >= lo && h.at < hi) ids.add(h.conv);
    for (const e of db.events) if (e.at >= lo && e.at < hi) ids.add(e.conv);
    for (const c of db.convs) if (c.assigned_to !== null && c.status !== 'resolved') ids.add(c.id);
    const keys = new Set(db.convs.filter((c) => ids.has(c.id) && c.source === 'chat' && c.customer_key).map((c) => c.site_id + '|' + c.customer_key));
    return rows(db.convs.filter((c) => ids.has(c.id) || (c.source === 'chat' && c.customer_key && keys.has(c.site_id + '|' + c.customer_key))).map((c) => ({
      id: c.id, source: c.source, status: c.status, merged_into: c.merged_into, assigned_to: c.assigned_to,
      assigned_ms: c.assigned_at, known: c.known, case_now: c.case_kind !== null,
      cu: c.source === 'chat' && c.customer_key ? 'k' + md5(c.site_id + ':' + c.customer_key) : 'c' + md5(c.id),
    })));
  }
  if (/^SELECT m\.id, m\.conversation_id AS conv, m\.sender, /.test(q)) {
    for (const part of [/COALESCE\(m\.metadata->>'hidden','false'\) <> 'true'/, /COALESCE\(m\.metadata->>'withheld',''\) = ''/,
      /m\.content IS NOT NULL AND btrim\(m\.content\) <> ''/, /\(m\.deleted_at IS NULL OR \(m\.sender = 'agent' AND m\.deleted_by IS DISTINCT FROM m\.metadata->>'agent'\)\)/,
      /m\.created_at >= \$2::timestamptz::timestamp AND m\.created_at < \$3::timestamptz::timestamp/, /left\(m\.content, 500\)/]) {
      if (!part.test(q)) db.violations.push('Q2 lost a rule: ' + part.source.slice(0, 50));
    }
    const [ids, from, to, aiRe, noRe] = params;
    db.lastMsgParams = params;
    const a = pgRe(aiRe), n = pgRe(noRe);
    return rows(db.msgs.filter((m) => ids.includes(m.conv) && m.at >= ms(from) && m.at < ms(to) && ['visitor', 'agent', 'ai'].includes(m.sender)
      && !m.hidden && !m.withheld && m.text && m.text.trim()
      && (m.deleted_at === null || (m.sender === 'agent' && m.deleted_by !== m.agent)))
      .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
      .map((m) => ({ id: m.id, conv: m.conv, sender: m.sender, at: m.at, text: m.sender === 'ai' ? '' : m.text.slice(0, 500),
        ai_not_answer: m.sender === 'ai' && a.test(m.text), no_reply: m.sender === 'visitor' && n.test(m.text),
        login: m.sender === 'agent' && m.agent ? m.agent.toLowerCase() : null })));
  }
  if (/^SELECT message_id, actor FROM chat_events WHERE kind = 'reply' AND message_id = ANY\(\$1::text\[\]\)$/.test(q)) {
    return rows(db.events.filter((e) => e.kind === 'reply' && params[0].includes(e.message_id)).map((e) => ({ message_id: e.message_id, actor: e.actor })));
  }
  if (/^SELECT id, conversation_id AS conv, \(extract\(epoch FROM at\)\*1000\)::float8 AS at, from_owner, to_owner FROM chat_holder_log WHERE conversation_id = ANY\(\$1::text\[\]\)/.test(q)) {
    const hi = upperBound(q, params);
    return rows(db.holders.filter((h) => params[0].includes(h.conv) && h.at < hi).map((h) => ({ id: String(h.id), conv: h.conv, at: h.at, from_owner: h.from, to_owner: h.to })));
  }
  if (/^SELECT id, conversation_id AS conv, \(extract\(epoch FROM created_at\)\*1000\)::float8 AS at, from_status, to_status, reason, actor FROM chat_events WHERE kind = 'status' AND conversation_id = ANY\(\$1::text\[\]\)/.test(q)) {
    const hi = upperBound(q, params);
    return rows(db.events.filter((e) => e.kind === 'status' && params[0].includes(e.conv) && e.at < hi)
      .map((e) => ({ id: String(e.id), conv: e.conv, at: e.at, from_status: e.from_status, to_status: e.to_status, reason: e.reason, actor: e.actor })));
  }
  if (/^SELECT conversation_id AS conv, \(extract\(epoch FROM created_at\)\*1000\)::float8 AS at, action FROM chat_case_events WHERE conversation_id = ANY\(\$1::text\[\]\)/.test(q)) {
    const hi = upperBound(q, params);
    return rows(db.cases.filter((c) => params[0].includes(c.conv) && c.at < hi).map((c) => ({ conv: c.conv, at: c.at, action: c.action })));
  }
  if (/FROM chat_events WHERE kind IN \('claim','take','transfer'\) AND created_at >= \$1::timestamptz AND created_at < \$2::timestamptz ORDER BY id$/.test(q)) {
    return rows(db.events.filter((e) => ['claim', 'take', 'transfer'].includes(e.kind) && e.at >= ms(params[0]) && e.at < ms(params[1])).map((e) => ({
      id: String(e.id), conv: e.conv, at: e.at, kind: e.kind, actor: e.actor, actor_name: e.actor_name ?? null, from_owner: e.from ?? null, to_owner: e.to ?? null,
      reason: e.reason ?? null, take: e.take ?? null, bulk: !!e.bulk, note: e.note ?? null })));
  }
  if (/^SELECT conversation_id AS conv, \(extract\(epoch FROM at\)\*1000\)::float8 AS at, score FROM chat_health_log WHERE conversation_id = ANY\(\$1::text\[\]\)/.test(q)) {
    const hi = upperBound(q, params);
    return rows(db.health.filter((h) => params[0].includes(h.conv) && h.at < hi).map((h) => ({ conv: h.conv, at: h.at, score: h.score })));
  }
  if (/^SELECT actor, day::text, .* FROM staff_presence_days WHERE day BETWEEN \$1::date AND \$2::date$/.test(q)) {
    return rows(db.presence.filter((p) => p.day >= params[0] && p.day <= params[1]).map((p) => ({ actor: p.actor, day: p.day, first: p.first, last: p.last })));
  }
  if (/^SELECT message_id, thanks, convinced, source FROM team_score_verdicts WHERE message_id = ANY\(\$1::text\[\]\)$/.test(q)) {
    return rows(db.verdicts.filter((v) => params[0].includes(v.message_id)).map((v) => ({ message_id: v.message_id, thanks: v.thanks, convinced: v.convinced, source: v.source })));
  }
  if (/^SELECT id, weights, effective_from::text, points_from::text, \(extract\(epoch FROM created_at\)\*1000\)::float8 AS created FROM team_score_settings ORDER BY id$/.test(q)) {
    return rows(db.settings.map((s) => ({ id: String(s.id), weights: JSON.parse(JSON.stringify(s.weights)), effective_from: s.effective_from, points_from: s.points_from, created: s.created_at })));
  }
  if (/^SELECT \(extract\(epoch FROM min\(created_at\)\)\*1000\)::float8 AS t FROM chat_events$/.test(q)) {
    return rows([{ t: db.events.length ? Math.min(...db.events.map((e) => e.at)) : null }]);
  }
  if (/^SELECT id::text AS id, username, display_name, role, is_active, permissions FROM team_users$/.test(q)) {
    return rows(db.team.map((u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, is_active: u.is_active, permissions: u.permissions })));
  }
  // ── report.ts ──
  if (/^SELECT DISTINCT ON \(day\) id, day::text, kind, reason, by_actor, created_at, summary FROM team_score_days WHERE day BETWEEN \$1::date AND \$2::date ORDER BY day, id DESC$/.test(q)) {
    return rows(latestPerDay(params[0], params[1]).map((r) => ({ id: String(r.id), day: r.day, kind: r.kind, reason: r.reason, by_actor: r.by_actor, created_at: new Date(r.created_at), summary: JSON.parse(r.summary) })));
  }
  if (/^SELECT DISTINCT ON \(day\) day::text, jsonb_path_query_array\(items, \$5::jsonpath, jsonb_build_object\('a', \$3::text, 'k', \$4::text\)\) AS items FROM team_score_days WHERE day BETWEEN \$1::date AND \$2::date ORDER BY day, id DESC$/.test(q)) {
    // jsonpath: like_regex takes the literal written in the path itself.
    const m = String(params[4]).match(/^\$\[\*\] \? \(@\.actor == \$a && @\.kind like_regex "([^"]+)"\)$/);
    if (!m) throw new Error('fake db: jsonpath syntax error: ' + params[4]);
    db.itemsQuery = params.slice();
    const re = new RegExp(m[1]);
    return rows(latestPerDay(params[0], params[1]).map((r) => ({ day: r.day, items: JSON.parse(r.items).filter((it) => it.actor === params[2] && re.test(it.kind)) })));
  }
  if (/^SELECT c\.id, c\.status, c\.source, \(c\.verified_order_id IS NOT NULL OR c\.phone_match_order_id IS NOT NULL\) AS known, COALESCE\(oname\.name, NULLIF\(btrim\(c\.visitor_name\), ''\), 'Visitor'\) AS name FROM conversations c JOIN sites s ON s\.id = c\.site_id LEFT JOIN LATERAL/.test(q)) {
    return rows(db.convs.filter((c) => params[0].includes(c.id)).map((c) => ({ id: c.id, status: c.status, source: c.source, known: c.known,
      name: (c.known && c.order_name) || (c.visitor_name && c.visitor_name.trim()) || 'Visitor' })));
  }
  if (/^SELECT id, sender, left\(content, 400\) AS text, \(extract\(epoch FROM created_at::timestamptz\)\*1000\)::float8 AS at FROM messages WHERE id = ANY\(\$1::text\[\]\)$/.test(q)) {
    return rows(db.msgs.filter((m) => params[0].includes(m.id)).map((m) => ({ id: m.id, sender: m.sender, text: m.text.slice(0, 400), at: m.at })));
  }
  if (/^SELECT DISTINCT ON \(actor\) actor, actor_name FROM chat_events WHERE actor = ANY\(\$1::text\[\]\) AND actor_name IS NOT NULL ORDER BY actor, id DESC$/.test(q)) {
    const out = new Map();
    for (const e of [...db.events].sort((x, y) => y.id - x.id)) if (params[0].includes(e.actor) && e.actor_name && !out.has(e.actor)) out.set(e.actor, e.actor_name);
    return rows(Array.from(out, ([actor, actor_name]) => ({ actor, actor_name })));
  }
  if (/^INSERT INTO team_score_days \(day, kind, engine_version, settings_id, summary, items, ai_pending, by_actor, reason\) VALUES \(\$1::date, \$2, \$3, \$4, \$5::jsonb, \$6::jsonb, \$7, \$8, \$9\) ON CONFLICT DO NOTHING RETURNING id$/.test(q)) {
    const [day, kind, ev, sid, summary, items, aip, by, reason] = params;
    // The table's CHECKs and NOT NULLs (team-score.sql section 6).
    assert.ok(['auto', 'recompute'].includes(kind) && ev && sid !== null && sid !== undefined && by && Number.isInteger(aip), 'team_score_days NOT NULL / CHECK');
    assert.ok((kind === 'recompute') === (reason !== null) && (reason === null || (reason.length >= 3 && reason.length <= 200)), 'team_score_days reason CHECK');
    JSON.parse(summary); JSON.parse(items);
    if (kind === 'auto' && db.days.some((d) => d.day === day && d.kind === 'auto')) return rows([]);   // team_score_days_one_auto
    const id = db.nextId++;
    db.days.push({ id, day, kind, engine_version: ev, settings_id: sid, summary, items, ai_pending: aip, by_actor: by, reason, created_at: NOW });
    return rows([{ id: String(id) }]);
  }
  if (/^SELECT 1 FROM team_score_days WHERE day = \$1::date AND kind = 'auto' LIMIT 1$/.test(q)) {
    return rows(db.days.some((d) => d.kind === 'auto' && d.day === params[0]) ? [{ '?column?': 1 }] : []);
  }
  if (/^SELECT day::text AS day FROM team_score_days WHERE kind = 'auto' AND day BETWEEN \$1::date AND \$2::date$/.test(q)) {
    return rows(db.days.filter((d) => d.kind === 'auto' && d.day >= params[0] && d.day <= params[1]).map((d) => ({ day: d.day })));
  }
  if (/^INSERT INTO team_score_settings \(weights, effective_from, points_from, created_by\) VALUES \(\$1::jsonb, \$2::date, \$3::date, \$4\) RETURNING id$/.test(q)) {
    assert.ok(params[3], 'created_by NOT NULL');
    const id = db.nextId++;
    db.settings.push({ id, weights: JSON.parse(params[0]), effective_from: params[1], points_from: params[2], created_at: NOW, created_by: params[3] });
    return rows([{ id: String(id) }]);
  }
  // ── judge.ts ──
  if (/^SELECT message_id FROM team_score_verdicts WHERE message_id = ANY\(\$1\)$/.test(q)) {
    return rows(db.verdicts.filter((v) => params[0].includes(v.message_id)).map((v) => ({ message_id: v.message_id })));
  }
  if (/^SELECT count\(\*\) FROM team_score_verdicts WHERE created_at >= \$1::timestamptz$/.test(q)) {
    return rows([{ count: String(db.verdicts.filter((v) => v.created_at >= ms(params[0])).length) }]);
  }
  if (/^INSERT INTO team_score_verdicts \(message_id, conversation_id, thanks, convinced, source, model\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6\) ON CONFLICT \(message_id\) DO NOTHING$/.test(q)) {
    assert.ok(['ai', 'ai_unclear', 'ai_failed'].includes(params[4]), 'team_score_verdicts source CHECK');
    if (db.verdicts.some((v) => v.message_id === params[0])) return { rows: [], rowCount: 0 };
    db.verdicts.push({ message_id: params[0], conversation_id: params[1], thanks: params[2], convinced: params[3], source: params[4], model: params[5], created_at: NOW });
    return { rows: [], rowCount: 1 };
  }
  throw new Error('fake db: unexpected SQL: ' + q.slice(0, 160));
}
function latestPerDay(from, to) {
  const by = new Map();
  for (const r of db.days.filter((d) => d.day >= from && d.day <= to).sort((a, b) => b.id - a.id)) if (!by.has(r.day)) by.set(r.day, r);
  return Array.from(by.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
}
global.__fakeDb = { handle };
fs.writeFileSync(path.join(dir, 'db.js'), `
const h = (sql, p, tx) => global.__fakeDb.handle(sql, p, tx);
module.exports = {
  query: (sql, p) => h(sql, p, null),
  queryOne: async (sql, p) => (await h(sql, p, null)).rows[0] ?? null,
  withTransaction: async (fn) => { const tx = global.__nextTx(); return fn({ query: (s, p) => h(s, p, tx) }); },
};`);
global.__nextTx = () => ++txSeq;

// ── Compile the real code next to the fakes (never lib/db.ts or chat/ai.ts) ──
const compile = (from, to) => {
  const src = fs.readFileSync(path.join(SRC, from), 'utf8')
    .replace(/from '@\/lib\/team-score\/([\w-]+)'/g, "from './$1'")
    .replace(/from '@\/lib\/chat\/ai'/g, "from './ai'")
    .replace(/from '@\/lib\/chat\/([\w-]+)'/g, "from './$1'")
    .replace(/from '@\/lib\/([\w-]+)'/g, "from './$1'")
    .replace(/from 'next\/server'/g, "from './next-server'");
  fs.writeFileSync(path.join(dir, to + '.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true } }).outputText);
};
for (const f of ['permissions', 'auth', 'office-hours']) compile(`lib/${f}.ts`, f);
for (const f of ['waiting', 'display-name', 'escalation', 'health-rules']) compile(`lib/chat/${f}.ts`, f);
for (const f of ['types', 'clock', 'words', 'rules', 'ctx', 'merge', 'engine', 'load', 'report', 'judge']) compile(`lib/team-score/${f}.ts`, f);
compile('app/api/team/score/route.ts', 'score-route');
compile('app/api/team/score/items/route.ts', 'items-route');
compile('app/api/cron/team-score/route.ts', 'cron-route');
assert.ok(/__fakeDb/.test(fs.readFileSync(path.join(dir, 'db.js'), 'utf8')) && /__fakeAi/.test(fs.readFileSync(path.join(dir, 'ai.js'), 'utf8')));

// Every console line the code writes is kept (and checked: counts only, never customer text).
const logs = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info };
for (const k of ['log', 'error', 'warn', 'info']) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };

const auth = require(path.join(dir, 'auth.js'));
const score = require(path.join(dir, 'score-route.js'));
const items = require(path.join(dir, 'items-route.js'));
const cron = require(path.join(dir, 'cron-route.js'));
const report = require(path.join(dir, 'report.js'));
const judge = require(path.join(dir, 'judge.js'));
const words = require(path.join(dir, 'words.js'));
const waiting = require(path.join(dir, 'waiting.js'));
const fakeAi = require(path.join(dir, 'ai.js'));

// ── The data: one panel (s1), the team, a week of chats ────────
db.admin = { username: 'jatin.owner', password_hash: 'not-used-here', session_version: 2, updated_at: new Date(ist('2026-10-01 18:00')) };
db.team = [
  { id: A, username: 'anurag', display_name: 'Anurag', role: 'agent', is_active: true, business_ids: null, permissions: null, session_version: 1 },
  { id: R, username: 'rahul', display_name: 'Rahul', role: 'agent', is_active: true, business_ids: null, permissions: ['orders.view', 'chat.view', 'chat.reply', 'chat.cases', 'chat.senior'], session_version: 1 },
  { id: N, username: 'neha', display_name: 'Neha', role: 'panel_admin', is_active: true, business_ids: null, permissions: null, session_version: 3 },
  { id: P, username: 'pooja', display_name: 'Pooja', role: 'viewer', is_active: true, business_ids: null, permissions: null, session_version: 1 },
];
db.convs = []; db.msgs = []; db.events = []; db.holders = []; db.cases = []; db.health = []; db.presence = [];
db.nextId = 1000;
let eid = 1, hid = 1, mid = 1;
const conv = (id, o = {}) => db.convs.push({ id, source: 'chat', site_id: 's1', status: 'agent_handling', merged_into: null, assigned_to: null, assigned_at: null,
  known: true, case_kind: null, customer_key: null, visitor_name: null, order_name: null, ...o });
const ev = (o) => { db.events.push({ id: eid++, ...o }); };
const hold = (c, when, from, to) => db.holders.push({ id: hid++, conv: c, at: ist(when), from, to });
// msg: sender visitor / agent / ai; o.by = the reply event's actor (part 3), o.login = metadata.agent.
const msg = (c, sender, when, text, o = {}) => {
  const id = 'm' + (mid++);
  db.msgs.push({ id, conv: c, sender, at: ist(when), text, agent: o.login ?? null, hidden: !!o.hidden, withheld: o.withheld || '',
    deleted_at: o.deletedBy ? ist(when) + 60_000 : null, deleted_by: o.deletedBy ?? null });
  if (o.by) ev({ kind: 'reply', conv: c, at: ist(when), actor: o.by, message_id: id });
  return id;
};
// A row saved before the owner's answers of 2026-10-02 (no closed_waiting key, convinced 0): the
// missing key takes its default (-2), its own convinced 0 stays.
const SETTINGS1 = { id: 1, weights: { thanks: 3, solved: 2, fast_reply: 1, unanswered_2h: -3, angry: -2, convinced: 0, customer_answered: 0 },
  effective_from: '2026-01-01', points_from: '2026-10-03', created_at: ist('2026-10-02 12:00'), created_by: 'system' };
const DEFAULTS = { thanks: 3, solved: 2, fast_reply: 1, unanswered_2h: -3, angry: -2, closed_waiting: -2, convinced: 2, customer_answered: 0 };
db.settings = [SETTINGS1];
// Part 3 went live 2026-10-01 23:22 (the first chat_events row).
conv('c0', { status: 'resolved' });
ev({ kind: 'status', conv: 'c0', at: ist('2026-10-01 23:22'), from_status: 'ai_handling', to_status: 'human_needed', reason: 'handover', actor: 'ai' });
for (const d of ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) {
  for (const k of [A, R, N]) db.presence.push({ actor: k, day: d, first: ist(d + ' 09:55'), last: ist(d + (d === '2026-10-08' ? ' 13:55' : ' 19:10')) });
}

// Today, 2026-10-08 (now 14:00).
// c1: Anurag picks a waiting customer from the open pool, answers at once, the customer thanks him.
conv('c1', { customer_key: '9876543210', assigned_to: A, assigned_at: ist('2026-10-08 11:05'), order_name: 'Priya S.' });
const c1Ask = msg('c1', 'visitor', '2026-10-08 11:00', 'mera order kab aayega, my number 9876543210');
hold('c1', '2026-10-08 11:05', null, A);
ev({ kind: 'claim', conv: 'c1', at: ist('2026-10-08 11:05'), actor: A, actor_name: 'Anurag', to: A, reason: 'reply' });
const c1Reply = msg('c1', 'agent', '2026-10-08 11:05', 'Aapka order kal deliver ho jayega, tracking ST12345678 dekh lijiye', { login: 'anurag', by: A });
const c1Thanks = msg('c1', 'visitor', '2026-10-08 11:10', 'thank you so much');
db.health.push({ conv: 'c1', at: ist('2026-10-08 11:01'), score: 30 });
// c3: inherited by Anurag; an unsure thank-you (the AI check decides); his last reply was deleted by Neha (still his).
conv('c3', { customer_key: '9555555555', assigned_to: A, assigned_at: ist('2026-10-08 12:00') });
msg('c3', 'visitor', '2026-10-08 11:58', 'order status?');
hold('c3', '2026-10-08 12:00', null, A);
const c3Reply = msg('c3', 'agent', '2026-10-08 12:01', 'Your order ships tomorrow from our warehouse', { login: 'anurag', by: A });
const c3Unsure = msg('c3', 'visitor', '2026-10-08 12:05', 'thanks but kab aayega?');
msg('c3', 'agent', '2026-10-08 12:20', 'It will reach you by Friday', { login: 'anurag', by: A, deletedBy: 'neha' });
// c12: inherited by Anurag, transferred to Rahul with a note; Rahul answers in 5 minutes. The name typed is a phone.
conv('c12', { customer_key: '9444000111', known: false, assigned_to: R, assigned_at: ist('2026-10-08 12:45'), visitor_name: '98111 22233' });
msg('c12', 'visitor', '2026-10-08 12:30', 'exchange size M to L please');
hold('c12', '2026-10-08 12:40', null, A);
hold('c12', '2026-10-08 12:45', A, R);
ev({ kind: 'transfer', conv: 'c12', at: ist('2026-10-08 12:45'), actor: A, actor_name: 'Anurag', from: A, to: R, note: 'size exchange, Rahul knows the stock' });
msg('c12', 'agent', '2026-10-08 12:50', 'Sure, I have changed it to size L', { login: 'rahul', by: R });
// c2: Rahul holds a customer in Needs you and never answers (his own deleted reply does not count).
conv('c2', { customer_key: '9123456789', status: 'human_needed', assigned_to: R, assigned_at: ist('2026-10-07 18:00') });
msg('c2', 'visitor', '2026-10-07 17:50', 'size chart?');
hold('c2', '2026-10-07 18:00', null, R);
msg('c2', 'agent', '2026-10-07 18:01', 'Size chart is on the product page', { login: 'rahul', by: R });
msg('c2', 'visitor', '2026-10-08 10:30', 'refund chahiye abhi tak nahi aaya');
msg('c2', 'agent', '2026-10-08 10:45', 'checking', { login: 'rahul', by: R, deletedBy: 'rahul' });
// c10: the Super Admin answers a visitor (no customer key: one chat = one customer).
conv('c10', { known: false });
msg('c10', 'visitor', '2026-10-08 13:00', 'Do you ship to Dubai?');
msg('c10', 'agent', '2026-10-08 13:10', 'Yes, we ship to the UAE in 7 to 10 days', { login: 'jatin.owner', by: 'owner' });
// c11: Needs you, nobody holds it, waiting since 10:40 (a hidden AI line is not an answer).
conv('c11', { customer_key: '9000011111', status: 'human_needed' });
msg('c11', 'visitor', '2026-10-08 10:40', 'hello, need help with exchange');
msg('c11', 'ai', '2026-10-08 10:41', 'Your exchange is booked', { hidden: true });

// Yesterday, 2026-10-07.
// c5: a thank-you after the AI's answer (no person).
conv('c5', { customer_key: '9333333333', status: 'ai_handling' });
msg('c5', 'visitor', '2026-10-07 11:00', 'where is my parcel');
msg('c5', 'ai', '2026-10-07 11:01', 'Your parcel is in transit and will reach you soon');
msg('c5', 'visitor', '2026-10-07 11:05', 'thanks');
// c6: Ravi (since removed from the team) picked a chat and answered.
conv('c6', { customer_key: '9222222222', assigned_to: V, assigned_at: ist('2026-10-07 12:00') });
msg('c6', 'visitor', '2026-10-07 11:59', 'need help with size');
ev({ kind: 'claim', conv: 'c6', at: ist('2026-10-07 12:00'), actor: V, actor_name: 'Ravi', to: V, reason: 'reply' });
hold('c6', '2026-10-07 12:00', null, V);
msg('c6', 'agent', '2026-10-07 12:01', 'Size L is available, I have updated it', { login: 'ravi_old', by: V });

// 2026-10-05 and 2026-10-06: c4 (no holder) - Anurag's replies, a thank-you, an old login, the owner's old login.
conv('c4', { customer_key: '9111122222' });
msg('c4', 'visitor', '2026-10-05 11:50', 'where is my parcel, it says delivered');
msg('c4', 'agent', '2026-10-05 12:00', 'Your parcel was delivered to the security desk', { login: 'anurag', by: A });
msg('c4', 'visitor', '2026-10-05 12:10', 'thank you');
msg('c4', 'agent', '2026-10-05 13:00', 'Old reply from a previous staff account', { login: 'oldstaff' });
msg('c4', 'agent', '2026-10-05 14:00', 'Refund is processed from our side', { login: 'Owner' });
msg('c4', 'agent', '2026-10-06 12:00', 'We have checked it with the courier', { login: 'anurag', by: A });
const c4Unsure = msg('c4', 'visitor', '2026-10-06 12:10', 'thanks but when will it come?');
msg('c4', 'agent', '2026-10-06 12:15', 'It will reach you on Friday', { login: 'anurag', by: A });
// R13: three chats whose only status / case / holder row is written AFTER D+2 00:00 of 2026-10-05.
// The customer waited all of 10-05 on Anurag (c7), Rahul (c8) and Neha (c9) and nobody answered.
conv('c7', { customer_key: '9666600001', status: 'resolved', assigned_to: A, assigned_at: ist('2026-10-03 12:00') });
hold('c7', '2026-10-03 12:00', null, A);
msg('c7', 'visitor', '2026-10-05 11:00', 'mera parcel kahan hai');
ev({ kind: 'status', conv: 'c7', at: ist('2026-10-07 15:00'), from_status: 'human_needed', to_status: 'resolved', reason: 'close', actor: 'owner', actor_name: 'Super Admin' });
conv('c8', { customer_key: '9666600002', status: 'human_needed', assigned_to: R, assigned_at: ist('2026-10-03 12:00'), case_kind: 'refund' });
hold('c8', '2026-10-03 12:00', null, R);
msg('c8', 'visitor', '2026-10-05 11:00', 'paisa wapas karo');
db.cases.push({ conv: 'c8', at: ist('2026-10-07 16:00'), action: 'mark' });
conv('c9', { customer_key: '9666600003', status: 'human_needed' });
msg('c9', 'visitor', '2026-10-05 11:00', 'size exchange kab hoga');
hold('c9', '2026-10-07 17:00', N, null);
ev({ kind: 'transfer', conv: 'c9', at: ist('2026-10-07 17:00'), actor: 'owner', actor_name: 'Super Admin', from: N, to: null, note: 'back to the pool' });
msg('c9', 'agent', '2026-10-07 17:05', 'Sorry for the delay, the exchange is booked', { login: 'jatin.owner', by: 'owner' });

// A frozen day, 2026-10-04 (written by the cron on 10-06 01:15).
const ZERO = { replies: 0, after_hours: 0, chats: 0, customers: 0, thanks: 0, thanks_pending: 0, thanks_not_counted: 0, asked_thanks: 0, convinced: 0, convinced_pending: 0, convinced_not_counted: 0,
  frustrated: 0, unanswered_2h: 0, taken_no_reply: 0, picked: 0, picked_pool: 0, picked_take: 0, sent: 0, sent_to: [], received: 0, taken_from: 0, released: 0,
  fast_reply: 0, solved: 0, solved_pending: 0, closed_waiting: 0, angry: 0, holding_now: null, waiting_now: null, online: null, days_in: 1 };
const COUNT_KEYS = Object.keys(ZERO);
const pday = (key, c, points, parts, cus) => ({ key, counts: { ...ZERO, ...c }, points, parts, cus });
const FROZEN_0410 = { day: '2026-10-04', settingsId: 1, pointsOn: true, eventsOn: true, healthOn: true, aiPending: 0, items: [],
  people: [
    pday(A, { replies: 3, chats: 2, customers: 2, thanks: 2, picked: 1, picked_pool: 1, fast_reply: 1, solved: 1 }, 9,
      { thanks: { n: 2, each: 3, points: 6 }, solved: { n: 1, each: 2, points: 2 }, fast_reply: { n: 1, each: 1, points: 1 } }, ['k' + 'a'.repeat(32), 'k' + 'b'.repeat(32)]),
    pday(R, { replies: 1, chats: 1, customers: 1, thanks: 1 }, 3, { thanks: { n: 1, each: 3, points: 3 } }, ['k' + 'c'.repeat(32)]),
    pday(N, {}, 0, {}, []),
    pday(V, { replies: 1, chats: 1, customers: 1 }, 0, {}, ['k' + 'd'.repeat(32)]),
  ],
  team: { pool_waited_2h: 0, absent_waits: 0, thanks_after_ai: 1, unattributed: [] } };
const frozenItem = (o) => ({ day: '2026-10-04', at: ist('2026-10-04 15:00'), conv: 'c4', cu: 'k' + 'a'.repeat(32), msgs: [], counted: true, pending: false, points: 0, why: 'x', ...o });
const FROZEN_ROW = { id: 1, day: '2026-10-04', kind: 'auto', engine_version: 'ts-1', settings_id: 1, summary: JSON.stringify(FROZEN_0410),
  items: JSON.stringify([frozenItem({ kind: 'thanks', actor: A, points: 3, why: 'Customer said thanks at 15:00.' }), frozenItem({ kind: 'thanks', actor: A, at: ist('2026-10-04 16:00'), points: 3, cu: 'k' + 'b'.repeat(32) }),
    frozenItem({ kind: 'chat', actor: A, n: 2, after: 0 }), frozenItem({ kind: 'thanks', actor: R, points: 3 }), frozenItem({ kind: 'chat', actor: V, n: 1, after: 0 })]),
  ai_pending: 0, by_actor: 'cron', reason: null, created_at: ist('2026-10-06 01:15') };

// ── Helpers ────────────────────────────────────────────────────
function resetState() {
  NOW = BASE_NOW;
  for (const k of ['__teamScoreCache', '__teamScoreSnapCache', '__teamScoreMetaCache', '__teamScoreNames', '__teamScoreFreshAt', '__teamScoreJudge', '__teamScoreJudgeBusy', '__teamScoreActionAt', '__teamScoreCronBusy']) delete globalThis[k];
  db.days = [{ ...FROZEN_ROW }];
  db.verdicts = [];
  db.settings = [{ ...SETTINGS1 }];
  db.fail = null; db.log.length = 0; db.violations.length = 0;
  ai.mode = 'yes'; ai.calls = []; ai.onCall = null;
  process.env.CRON_SECRET = CRON;
}
const reqOf = (token, url, body, method = body === undefined ? 'GET' : 'POST') => ({
  method,
  headers: { get: (k) => (k.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
  json: async () => { if (body === undefined) throw new Error('no body'); return body; },
  url: 'http://localhost:3000' + url,
});
const owner = () => auth.generateToken('jatin.owner', 'admin', null, { name: 'Super Admin', sv: 2 });
const memberA = () => auth.generateToken('anurag', 'agent', null, { name: 'Anurag', uid: A, sv: 1 });
const memberN = () => auth.generateToken('neha', 'panel_admin', null, { name: 'Neha', uid: N, sv: 3 });
const viewerP = () => auth.generateToken('pooja', 'viewer', null, { name: 'Pooja', uid: P, sv: 1 });
const get = async (q = '') => score.GET(reqOf(owner(), '/api/team/score' + q));
const post = async (body, token = owner()) => score.POST(reqOf(token, '/api/team/score', body));
const drill = async (q) => items.GET(reqOf(owner(), '/api/team/score/items?' + q));
const runCron = async (q = '') => cron.GET(reqOf(null, '/api/cron/team-score?secret=' + CRON + q));
const ok200 = (r) => { assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body; };
const person = (body, key) => (key === 'owner' ? body.owner : body.people.find((p) => p.key === key));
const loaderRuns = () => db.log.filter((l) => /^WITH ids AS/.test(l.q)).length;
const scoreSql = (from) => db.log.slice(from).filter((l) => !isAuthSql(l.q));
const inserts = (from, table) => db.log.slice(from).filter((l) => new RegExp('^INSERT INTO ' + table + '\\b').test(l.q));
const tick = () => new Promise((r) => setImmediate(r));
function strings(x, out = [], key = '') {
  if (typeof x === 'string') out.push([key, x]);
  else if (Array.isArray(x)) x.forEach((v) => strings(v, out, key));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (k === 'customer_key') out.push(['customer_key', 'KEY']); strings(v, out, k); }
  return out;
}
const VISITOR_TEXTS = () => db.msgs.filter((m) => m.sender === 'visitor' && m.text.length >= 8).map((m) => m.text);

let n = 0;
const t = async (name, fn) => {
  try { resetState(); await fn(); assert.deepStrictEqual(db.violations, []); n++; } catch (e) { Object.assign(console, realConsole); console.error('FAIL ' + name); throw e; }
};

(async () => {
  resetState();

  await t('R1 auth: the first request waits for the logins; none 401; no chat.reply 403; every POST the Super Admin\'s', async () => {
    // Cold start: the admin_login read is held, so the route must wait for it (authReady).
    let open; db.adminGate = new Promise((r) => { open = r; });
    let done = false;
    const first = get().then((r) => { done = true; return r; });
    for (let i = 0; i < 20; i++) await tick();
    assert.strictEqual(done, false, 'answered before the logins were read');
    open(); db.adminGate = null;
    ok200(await first);
    assert.strictEqual((await score.GET(reqOf(null, '/api/team/score'))).status, 401);
    assert.strictEqual((await score.GET(reqOf('v1.bad.token', '/api/team/score'))).status, 401);
    // The .env owner login stopped counting when the owner saved his own (admin_login row, sv 2).
    assert.strictEqual((await score.GET(reqOf(auth.generateToken('Owner', 'admin', null, { name: 'Super Admin', sv: 1 }), '/api/team/score'))).status, 401);
    assert.strictEqual((await score.GET(reqOf(auth.generateToken('anurag', 'agent', null, { name: 'Anurag', uid: A, sv: 7 }), '/api/team/score'))).status, 401);
    const before = db.log.length, calls = ai.calls.length;
    // A member who cannot reply to chats (Pooja, viewer) has no score: 403 on every route.
    for (const r of [
      await score.GET(reqOf(viewerP(), '/api/team/score')),
      await score.GET(reqOf(viewerP(), '/api/team/score?from=2026-10-04&to=2026-10-04')),
      await items.GET(reqOf(viewerP(), `/api/team/score/items?person=${P}&metric=thanks`)),
      await items.GET(reqOf(viewerP(), `/api/team/score/items?person=${A}&metric=thanks`)),
    ]) assert.deepStrictEqual([r.status, r.body.error], [403, 'Only team members who reply to chats have a score']);
    // Members who can reply: Check now, weights and Recompute stay the Super Admin's.
    for (const tok of [memberA(), memberN(), viewerP()]) {
      for (const r of [
        await score.POST(reqOf(tok, '/api/team/score', { action: 'judge' })),
        await score.POST(reqOf(tok, '/api/team/score', { action: 'settings', weights: { thanks: 9 }, effectiveFrom: '2026-10-08' })),
        await score.POST(reqOf(tok, '/api/team/score', { action: 'recompute', day: '2026-10-05', reason: 'member tries' })),
      ]) assert.deepStrictEqual([r.status, r.body.error], [403, 'Only the Super Admin can change the team score']);
    }
    assert.strictEqual(scoreSql(before).length, 0, 'a refused request read nothing');
    assert.strictEqual(ai.calls.length, calls);
    assert.deepStrictEqual([db.settings.length, db.days.length], [1, 1], 'a member wrote nothing');
    assert.strictEqual((await items.GET(reqOf(null, `/api/team/score/items?person=${A}&metric=thanks`))).status, 401);
    assert.strictEqual((await score.POST(reqOf(null, '/api/team/score', { action: 'judge' }))).status, 401);
  });

  await t('R2 dates: default today; bad, reversed, 32 days, future, before 1 Oct: 400', async () => {
    const b = ok200(await get());
    assert.deepStrictEqual([b.from, b.to], ['2026-10-08', '2026-10-08']);
    assert.deepStrictEqual([ok200(await get('?from=2026-10-05')).from, ok200(await get('?from=2026-10-05')).to], ['2026-10-05', '2026-10-08']);
    for (const u of ['?from=2026-13-01&to=2026-10-08', '?from=2026-02-30', '?from=abc', '?from=2026-10-5&to=2026-10-08', '?from=2026-10-08&to=2026-10-07',
      '?from=2026-10-09&to=2026-10-09', '?to=2026-10-09', '?from=2026-09-30&to=2026-10-01', '?from=2026-10-01T00:00&to=2026-10-02']) {
      const r = await get(u);
      assert.deepStrictEqual([r.status, r.body.error], [400, 'Pick dates as YYYY-MM-DD, up to 31 days, not in the future'], u);
    }
    NOW = ist('2026-11-05 12:00');
    assert.strictEqual((await get('?from=2026-10-05&to=2026-11-05')).status, 400);        // 32 days
    ok200(await get('?from=2026-10-06&to=2026-11-05'));                                    // 31 days
    for (const u of ['?from=2026-11-06&metric=thanks&person=' + A, '?from=2026-10-01&to=2026-11-05&metric=thanks&person=' + A]) {
      assert.strictEqual((await drill(u.slice(1))).status, 400, u);
    }
  });

  let today;
  await t('R3 shape: the TeamScoreResponse keys, counts as the rules give them, no phone or customer key anywhere', async () => {
    today = ok200(await get());
    assert.deepStrictEqual(Object.keys(today).sort(), ['days', 'events_since', 'from', 'health_from', 'judge', 'leader', 'live', 'now', 'owner', 'people', 'points_from', 'team', 'to', 'took_ms', 'view', 'weights',
      'weights_latest', 'weights_today', 'weights_scheduled'].sort());
    assert.strictEqual(today.view, 'team');
    for (const p of [...today.people, today.owner]) {
      assert.deepStrictEqual(Object.keys(p).sort(), ['active', 'counts', 'key', 'name', 'parts', 'points', 'rank', 'ranked', 'tier'].sort());
      assert.deepStrictEqual(Object.keys(p.counts).sort(), COUNT_KEYS.slice().sort());
    }
    for (const [k, s] of strings(today)) {
      assert.ok(!/\d{10}/.test(s), `10-digit run in ${k}: ${s}`);
      assert.ok(k !== 'customer_key' && !/customer_key/.test(s));
    }
    assert.strictEqual(today.now, new Date(BASE_NOW).toISOString());
    assert.strictEqual(today.live, true);
    assert.deepStrictEqual(today.days, [{ day: '2026-10-08', state: 'live', final_at: isoOf('2026-10-10 01:00'), saved_at: null, reason: null }]);
    assert.deepStrictEqual([today.events_since, today.health_from, today.points_from], [isoOf('2026-10-01 23:22'), '2026-10-03', '2026-10-03']);
    assert.deepStrictEqual(today.weights, { id: 1, values: { ...SETTINGS1.weights, closed_waiting: -2 }, effective_from: '2026-01-01' });
    assert.deepStrictEqual([today.weights_latest, today.weights_today, today.weights_scheduled], [today.weights, today.weights, []]);
    assert.deepStrictEqual(today.judge, { pending: 1, model_ok: null });
    const a = person(today, A), r = person(today, R), ne = person(today, N);
    assert.deepStrictEqual(today.people.map((p) => [p.name, p.tier, p.rank, p.points]), [['Anurag', 'junior', 1, 4], ['Neha', 'junior', 2, 0], ['Rahul', 'senior', 3, -2]]);
    assert.ok(!today.people.some((p) => p.key === P), 'a viewer who cannot reply is not listed');
    assert.deepStrictEqual(a.counts, { ...ZERO, replies: 3, chats: 2, customers: 2, thanks: 1, thanks_pending: 1, picked: 1, picked_pool: 1,
      sent: 1, sent_to: [{ key: R, name: 'Rahul', n: 1 }], fast_reply: 1, holding_now: 2, waiting_now: 0, online: { first: '09:55', last: '13:55' } });
    assert.deepStrictEqual([a.parts.thanks, a.parts.fast_reply], [{ n: 1, each: 3, points: 3 }, { n: 1, each: 1, points: 1 }]);
    assert.deepStrictEqual(r.counts, { ...ZERO, replies: 1, chats: 1, customers: 1, received: 1, fast_reply: 1, unanswered_2h: 1,
      holding_now: 2, waiting_now: 1, online: { first: '09:55', last: '13:55' } });
    assert.deepStrictEqual([ne.counts.replies, ne.points, ne.ranked], [0, 0, true]);
    assert.deepStrictEqual([today.owner.key, today.owner.name, today.owner.tier, today.owner.ranked, today.owner.rank, today.owner.counts.replies, today.owner.points],
      ['owner', 'Super Admin', 'owner', false, null, 1, 0]);
    assert.deepStrictEqual(today.team, { pool_waited_2h: 1, absent_waits: 0, thanks_after_ai: 0, unattributed: [] });
    assert.deepStrictEqual(today.leader, { key: A, name: 'Anurag', thanks: 1 });
    assert.ok(typeof today.took_ms === 'number');
    // The drill-down rows: customer refs are md5 refs only, never a key or a phone.
    const all = [];
    for (const [who, m] of [[A, 'chats'], [A, 'thanks'], [A, 'fast_reply'], [A, 'picked'], [A, 'sent'], [R, 'chats'], [R, 'unanswered_2h'], ['owner', 'chats']]) {
      const b = ok200(await drill(`person=${who}&metric=${m}`));
      for (const it of b.items) { assert.ok(/^[kc][0-9a-f]{32}$/.test(it.cu), it.cu); all.push(it); }
      for (const [k, s] of strings(b)) {
        if (k === 'cu') continue;                    // an md5 ref may hold digits; checked above
        assert.ok(!/\d{10}/.test(s), `10-digit run in ${k}: ${s}`);
        assert.ok(k !== 'customer_key' && !/customer_key/.test(s));
      }
    }
    assert.ok(all.some((it) => it.conv === 'c1' && it.cu === 'k' + md5('s1:9876543210')));
    assert.ok(all.some((it) => it.conv === 'c10' && it.cu === 'c' + md5('c10')));
  });

  await t('R4 one REPEATABLE READ READ ONLY transaction; 57014 and 42P01 answer 503', async () => {
    const from = db.log.length;
    ok200(await get('?from=2026-10-07&to=2026-10-07'));
    const mine = db.log.slice(from);
    const tx = mine.find((l) => l.tx !== null).tx;
    const inTx = mine.filter((l) => l.tx === tx).map((l) => l.q);
    assert.strictEqual(inTx[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.strictEqual(inTx[1], "SET LOCAL statement_timeout = '8s'");
    for (const re of [/^WITH ids AS/, /^SELECT m\.id/, /FROM chat_holder_log/, /kind = 'status'/, /FROM chat_case_events/, /kind IN \('claim'/, /FROM chat_health_log/,
      /FROM staff_presence_days/, /FROM team_score_settings/, /min\(created_at\)/, /FROM team_users$/]) {
      assert.ok(inTx.some((q) => re.test(q)), 'in the transaction: ' + re.source);
      assert.ok(!mine.some((l) => l.tx !== tx && re.test(l.q) && !/FROM team_users$/.test(l.q)), 'outside the transaction: ' + re.source);
    }
    // The two inbox regexes are passed as parameters, the very strings of waiting.ts.
    assert.strictEqual(db.lastMsgParams[3], waiting.AI_NOT_AN_ANSWER_REGEX);
    assert.strictEqual(db.lastMsgParams[4], waiting.NO_REPLY_NEEDED_REGEX);
    // Window for one past day: 3 days before it to D+2 00:00; messages 30 days further back.
    db.log.length = 0;
    ok200(await get('?from=2026-10-05&to=2026-10-05'));
    assert.deepStrictEqual(db.log.find((l) => /^WITH ids AS/.test(l.q)).params, [isoOf('2026-10-02 00:00'), isoOf('2026-10-07 00:00')]);
    assert.deepStrictEqual(db.lastMsgParams.slice(1, 3), [new Date(ist('2026-10-02 00:00') - 30 * 86_400_000).toISOString(), isoOf('2026-10-07 00:00')]);
    const fails = [
      [{ re: /^SELECT m\.id/, code: '57014' }, 'GET', 'The report is busy, try again in a minute.'],
      [{ re: /FROM team_score_days/, code: '42P01' }, 'GET', 'Team score is not installed yet (team-score.sql).'],
      [{ re: /FROM chat_holder_log/, code: '42P01' }, 'GET', 'Team score is not installed yet (team-score.sql).'],
      [{ re: /jsonb_path_query_array/, code: '42P01' }, 'ITEMS', 'Team score is not installed yet (team-score.sql).'],
      [{ re: /^SELECT m\.id/, code: '57014' }, 'ITEMS', 'The report is busy, try again in a minute.'],
      [{ re: /FROM team_score_settings/, code: '42P01' }, 'SETTINGS', 'Team score is not installed yet (team-score.sql).'],
    ];
    for (const [fail, where, text] of fails) {
      report.clearScoreCache();
      db.fail = fail;
      const r = where === 'GET' ? await get('?from=2026-10-07&to=2026-10-07')
        : where === 'ITEMS' ? await drill(`from=2026-10-07&to=2026-10-07&person=${A}&metric=thanks`)
          : await post({ action: 'settings', weights: { thanks: 4 }, effectiveFrom: '2026-10-08' });
      assert.deepStrictEqual([r.status, r.body.error], [503, text], where + ' ' + fail.re.source);
      db.fail = null;
    }
    // Another error: a plain 500 that does not quote the database.
    report.clearScoreCache();
    db.fail = { re: /^SELECT m\.id/, code: 'XX000' };
    const r = await get('?from=2026-10-07&to=2026-10-07');
    assert.deepStrictEqual([r.status, r.body.error], [500, 'The team score could not be loaded. Try again in a minute.']);
    // A failed load is not kept: the next click loads again.
    ok200(await get('?from=2026-10-07&to=2026-10-07'));
  });

  await t('R5 frozen days from the summary only; one load per click; 60 s / 10 min cache; Refresh once per 10 s', async () => {
    let from = db.log.length;
    const fz = ok200(await get('?from=2026-10-04&to=2026-10-04'));
    assert.strictEqual(loaderRuns(), 0);
    assert.ok(!db.log.slice(from).some((l) => /FROM messages|chat_holder_log/.test(l.q)), 'no message loader for a frozen day');
    const snapSql = db.log.slice(from).find((l) => /FROM team_score_days WHERE day BETWEEN/.test(l.q)).q;
    assert.ok(/summary FROM/.test(snapSql) && !/\bitems\b/.test(snapSql), 'the list reads summary, never items');
    assert.deepStrictEqual(fz.days, [{ day: '2026-10-04', state: 'final', final_at: null, saved_at: new Date(ist('2026-10-06 01:15')).toISOString(), reason: null }]);
    assert.deepStrictEqual([fz.live, fz.judge.pending, person(fz, A).points, person(fz, A).counts.thanks, person(fz, R).points], [false, 0, 9, 2, 3]);
    const ravi = person(fz, V);
    assert.deepStrictEqual([ravi.name, ravi.ranked, ravi.rank, ravi.active], ['Ravi', false, null, false], 'a removed member is named from his last event');
    assert.deepStrictEqual(fz.people.map((p) => p.key), [A, R, N, V]);
    assert.deepStrictEqual(fz.team.thanks_after_ai, 1);
    // A live day: one load; within 60 s no SQL at all; fresh reloads at most once per 10 s.
    report.clearScoreCache();
    ok200(await get());
    assert.strictEqual(loaderRuns(), 1);
    NOW += 30_000; from = db.log.length;
    ok200(await get());
    assert.deepStrictEqual(scoreSql(from).map((l) => l.q.slice(0, 40)), []);
    ok200(await get('?fresh=1'));
    assert.strictEqual(loaderRuns(), 2);
    ok200(await get('?fresh=1'));
    assert.strictEqual(loaderRuns(), 2, 'a second Refresh within 10 s is served from the cache');
    NOW += 11_000;
    ok200(await get('?fresh=1'));
    assert.strictEqual(loaderRuns(), 3);
    NOW += 61_000;
    ok200(await get());
    assert.strictEqual(loaderRuns(), 4, 'today is cached for 60 s');
    // An older live day is cached for 10 minutes.
    ok200(await get('?from=2026-10-05&to=2026-10-05'));
    assert.strictEqual(loaderRuns(), 5);
    NOW += 5 * 60_000;
    ok200(await get('?from=2026-10-05&to=2026-10-05'));
    assert.strictEqual(loaderRuns(), 5);
    NOW += 6 * 60_000;
    ok200(await get('?from=2026-10-05&to=2026-10-05'));
    assert.strictEqual(loaderRuns(), 6);
    // Two clicks at once load once.
    report.clearScoreCache();
    await Promise.all([get(), get()]);
    assert.strictEqual(loaderRuns(), 7);
    // A range across the frozen day and live days: one load over the live days, numbers summed.
    NOW = BASE_NOW; report.clearScoreCache(); db.log.length = 0;
    const rg = ok200(await get('?from=2026-10-04&to=2026-10-08'));
    assert.strictEqual(loaderRuns(), 1);
    assert.deepStrictEqual(db.log.find((l) => /^WITH ids AS/.test(l.q)).params, [isoOf('2026-10-02 00:00'), new Date(BASE_NOW).toISOString()]);
    assert.deepStrictEqual(rg.days.map((d) => d.state), ['final', 'live', 'live', 'live', 'live']);
    const a = person(rg, A), r = person(rg, R), ne = person(rg, N), ra = person(rg, V);
    // Anurag: 9 frozen; 10-05 thanks +3 and c7 unanswered -3; 10-06 c7 again -3; 10-07 c7 again -3; today +4.
    assert.deepStrictEqual([a.points, a.counts.thanks, a.counts.thanks_pending, a.counts.unanswered_2h, a.counts.customers, a.counts.days_in, a.counts.online],
      [7, 4, 2, 3, 5, 5, null]);
    assert.deepStrictEqual([r.points, r.counts.unanswered_2h, ne.points, ne.counts.unanswered_2h], [-8, 4, -9, 3]);
    assert.deepStrictEqual(rg.people.map((p) => [p.name, p.rank]), [['Anurag', 1], ['Rahul', 2], ['Neha', 3], ['Ravi', null]]);
    assert.deepStrictEqual([ra.points, ra.counts.replies, ra.counts.picked, ra.counts.fast_reply], [1, 2, 1, 1]);
    assert.deepStrictEqual([rg.owner.counts.replies, rg.owner.counts.sent, rg.team.thanks_after_ai, rg.team.unattributed], [3, 1, 2, [{ login: 'oldstaff', replies: 1 }]]);
    assert.deepStrictEqual([rg.judge.pending, rg.live], [2, true]);
  });

  await t('R6 drill-down: frozen days through jsonb_path_query_array, live rows, masked lines, at most 200', async () => {
    let b = ok200(await drill(`from=2026-10-04&to=2026-10-04&person=${A}&metric=thanks`));
    assert.deepStrictEqual(db.itemsQuery.slice(0, 4), ['2026-10-04', '2026-10-04', A, '^(thanks)$']);
    assert.deepStrictEqual([b.person, b.metric, b.total, b.counted, b.items.map((it) => it.at_ist)], [A, 'thanks', 2, 2, ['16:00', '15:00']]);
    ok200(await drill(`from=2026-10-04&to=2026-10-04&person=${A}&metric=sent`));
    assert.strictEqual(db.itemsQuery[3], '^(sent|received|taken_from|released)$');
    ok200(await drill(`from=2026-10-04&to=2026-10-04&person=${A}&metric=solved`));
    assert.strictEqual(db.itemsQuery[3], '^(solved|closed_waiting)$');
    // Live: today's rows for Anurag.
    b = ok200(await drill(`person=${A}&metric=thanks`));
    assert.deepStrictEqual([b.total, b.counted], [2, 1]);
    const th = b.items.find((it) => it.counted);
    assert.deepStrictEqual([th.conv, th.at_ist, th.points, th.by, th.msgs], ['c1', '11:10', 3, 'keyword', [c1Reply, c1Thanks]]);
    assert.strictEqual(th.why, "Customer said thanks at 11:10, 5 min after Anurag's reply (keyword check).");
    assert.deepStrictEqual(th.chat, { id: 'c1', name: 'Priya S.', status: 'agent_handling', known: true, source: 'chat' });
    assert.deepStrictEqual(th.messages, [
      { id: c1Reply, role: 'staff', by: 'Anurag', at_ist: '11:05', text: 'Aapka order kal deliver ho jayega, tracking [tracking id] dekh lijiye' },
      { id: c1Thanks, role: 'customer', by: null, at_ist: '11:10', text: 'thank you so much' }]);
    const pend = b.items.find((it) => !it.counted);
    assert.deepStrictEqual([pend.conv, pend.pending, pend.points, pend.msgs], ['c3', true, 0, [c3Reply, c3Unsure]]);
    // Every line of every row is masked: the customer's typed phone never comes back.
    let lines = [];
    for (const m of ['chats', 'thanks', 'fast_reply', 'picked', 'sent', 'points']) lines = lines.concat(ok200(await drill(`person=${A}&metric=${m}`)).items.flatMap((it) => it.messages));
    assert.ok(lines.length > 0 && lines.every((l) => !/9876543210|ST12345678/.test(l.text)), JSON.stringify(lines));
    assert.ok(lines.some((l) => l.id === c1Ask && l.role === 'customer' && l.text === 'mera order kab aayega, my number [phone]'), 'the typed phone is masked');
    b = ok200(await drill(`person=${A}&metric=sent`));
    assert.deepStrictEqual(b.items.map((it) => [it.kind, it.peer, it.note, it.at_ist]), [['sent', R, 'size exchange, Rahul knows the stock', '12:45']]);
    b = ok200(await drill(`person=${R}&metric=chats`));
    assert.deepStrictEqual([b.total, b.items[0].chat.name, b.items[0].chat.known], [1, '[phone]', false], 'a phone typed as a name is masked');
    b = ok200(await drill(`person=${A}&metric=points`));
    assert.ok(b.items.length === 3 && b.items.every((it) => it.points !== 0 || it.pending), JSON.stringify(b.items.map((it) => [it.kind, it.points])));
    b = ok200(await drill(`person=${A}&metric=chats`));
    assert.deepStrictEqual(b.items.map((it) => [it.conv, it.at_ist, it.n]), [['c3', '12:01', 2], ['c1', '11:05', 1]], 'newest first; a reply deleted by someone else still counts');
    // The AI's thank-yous (team footer) and a removed member's rows.
    b = ok200(await drill(`from=2026-10-07&to=2026-10-07&person=ai&metric=thanks`));
    assert.deepStrictEqual([b.total, b.items[0].messages.map((m) => [m.role, m.by])], [1, [['ai', 'AI'], ['customer', null]]]);
    b = ok200(await drill(`from=2026-10-07&to=2026-10-07&person=${V}&metric=chats`));
    assert.deepStrictEqual(b.items[0].messages.map((m) => [m.role, m.by]), [['staff', 'Ravi']]);
    // 250 frozen rows: the newest 200 come back; total and counted are over all 250.
    db.days.push({ id: 2, day: '2026-10-03', kind: 'auto', engine_version: 'ts-1', settings_id: 1, summary: JSON.stringify({ ...FROZEN_0410, day: '2026-10-03' }), ai_pending: 0, by_actor: 'cron', reason: null, created_at: NOW,
      items: JSON.stringify(Array.from({ length: 250 }, (_, i) => ({ kind: 'chat', actor: A, day: '2026-10-03', at: ist('2026-10-03 10:00') + i * 60_000, conv: 'c4', cu: 'c' + 'f'.repeat(32), msgs: [], counted: true, pending: false, points: 0, why: 'w', n: 1, after: 0 }))) });
    b = ok200(await drill(`from=2026-10-03&to=2026-10-03&person=${A}&metric=chats`));
    assert.deepStrictEqual([b.total, b.counted, b.items.length, b.items[0].at_ist, b.items[199].at_ist], [250, 250, 200, '14:09', '10:50']);
    // Bad input.
    for (const q of [`person=${A}&metric=bogus`, `person=${A}`, `person=${A}'x&metric=thanks`, 'metric=thanks', `person=${'x'.repeat(65)}&metric=thanks`]) {
      assert.strictEqual((await drill(q)).status, 400, q);
    }
  });

  await t('R7 point weights: only known keys, half steps, today or later; a new row clears the cache; past days keep theirs', async () => {
    const bad = [
      [{ weights: { bogus: 1 }, effectiveFrom: '2026-10-08' }, 'Unknown weight: bogus'],
      [{ weights: { thanks: 10.5 }, effectiveFrom: '2026-10-08' }, null],
      [{ weights: { thanks: 0.3 }, effectiveFrom: '2026-10-08' }, null],
      [{ weights: { thanks: '3' }, effectiveFrom: '2026-10-08' }, null],
      [{ weights: { thanks: null }, effectiveFrom: '2026-10-08' }, null],
      [{ weights: [3], effectiveFrom: '2026-10-08' }, null],
      [{ weights: { thanks: 5 }, effectiveFrom: '2026-10-07' }, 'Past days keep their points. Pick today or a later day.'],
      // More than 60 days ahead has its own message (review 2026-10-02: "pick a later day" was wrong there).
      [{ weights: { thanks: 5 }, effectiveFrom: '2026-12-08' }, 'Pick a day within the next 60 days.'],
      [{ weights: { thanks: 5 }, effectiveFrom: '2027-01-15' }, 'Pick a day within the next 60 days.'],
      [{ weights: { thanks: 5 }, effectiveFrom: 'tomorrow' }, 'Past days keep their points. Pick today or a later day.'],
      [{ weights: { thanks: 5 }, effectiveFrom: '2026-10-08', pointsFrom: '2026-09-30' }, null],
    ];
    for (const [body, text] of bad) {
      const r = await post({ action: 'settings', ...body });
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      if (text) assert.strictEqual(r.body.error, text);
    }
    assert.strictEqual(db.settings.length, 1);
    ok200(await get());
    const runs = loaderRuns();
    const r = ok200(await post({ action: 'settings', weights: { thanks: 5 }, effectiveFrom: '2026-10-08' }));
    const row = db.settings[db.settings.length - 1];
    assert.deepStrictEqual(r, { ok: true, id: row.id });
    assert.deepStrictEqual([row.weights, row.effective_from, row.points_from, row.created_by],
      [{ ...DEFAULTS, thanks: 5 }, '2026-10-08', '2026-10-03', 'owner']);
    const b = ok200(await get());
    assert.strictEqual(loaderRuns(), runs + 1, 'the cache was cleared');
    assert.deepStrictEqual([b.weights.id, b.weights.effective_from, person(b, A).points, person(b, A).parts.thanks], [row.id, '2026-10-08', 6, { n: 1, each: 5, points: 5 }]);
    // Master rule 36: a past day keeps the weights of its own day.
    const old = ok200(await get('?from=2026-10-05&to=2026-10-05'));
    assert.deepStrictEqual(person(old, A).parts.thanks, { n: 1, each: 3, points: 3 });
    // A points start day may be moved (from 2026-10-01 on).
    ok200(await post({ action: 'settings', weights: {}, effectiveFrom: '2026-10-09', pointsFrom: '2026-10-01' }));
    assert.deepStrictEqual([db.settings[db.settings.length - 1].weights, db.settings[db.settings.length - 1].points_from], [DEFAULTS, '2026-10-01']);
    // The new key can be saved like the others.
    NOW += 1000;
    ok200(await post({ action: 'settings', weights: { closed_waiting: -4 }, effectiveFrom: '2026-10-09' }));
    assert.strictEqual(db.settings[db.settings.length - 1].weights.closed_waiting, -4);
    assert.strictEqual(ok200(await get()).points_from, '2026-10-01');
    // The 60th day ahead is still fine.
    ok200(await post({ action: 'settings', weights: {}, effectiveFrom: '2026-12-07' }));
    assert.strictEqual(report.FAR_AHEAD_ERROR, 'Pick a day within the next 60 days.');
    assert.strictEqual((await post({ action: 'nope' })).status, 400);
    assert.strictEqual((await score.POST({ ...reqOf(owner(), '/api/team/score', undefined, 'POST') })).status, 400);
  });

  await t('R8 Recompute: only final days, a cleaned 3-200 character reason, at most once per 10 s', async () => {
    const before = db.days.length;
    for (const body of [{ day: '2026-10-08', reason: 'fix it' }, { day: '2026-10-07', reason: 'fix it' }, { day: '2026-09-30', reason: 'fix it' }, { day: 'yesterday', reason: 'fix it' },
      { day: '2026-10-05' }, { day: '2026-10-05', reason: ' a\u0000 ' }, { day: '2026-10-05', reason: 'x'.repeat(201) }, { day: '2026-10-05', reason: 42 }]) {
      assert.strictEqual((await post({ action: 'recompute', ...body })).status, 400, JSON.stringify(body));
    }
    assert.strictEqual((await post({ action: 'recompute', day: '2026-10-07', reason: 'fix it' })).body.error, 'Only days that are already final can be recomputed');
    assert.strictEqual(db.days.length, before);
    // Past D+2 but not frozen by the cron yet (no 'auto' row): refused, nothing saved (review 2026-10-02:
    // the cron's later 'auto' row would have replaced it and lost the reason).
    const notFinal = await post({ action: 'recompute', day: '2026-10-05', reason: 'too early' });
    assert.deepStrictEqual([notFinal.status, notFinal.body.error, db.days.length], [400, 'Only days that are already final can be recomputed', before]);
    assert.strictEqual(await report.snapshotDay('2026-10-05', 'auto', 'cron', null), true);   // the cron freezes it
    NOW += 11_000;
    ok200(await post({ action: 'recompute', day: '2026-10-05', reason: 'Owner checked\nthe old login' }));
    const row = db.days[db.days.length - 1];
    assert.deepStrictEqual([row.day, row.kind, row.reason, row.by_actor, row.engine_version, row.settings_id], ['2026-10-05', 'recompute', 'Owner checked the old login', 'owner', 'ts-1', 1]);
    assert.deepStrictEqual(JSON.parse(row.summary).items, []);
    assert.ok(JSON.parse(row.items).length > 0);
    assert.strictEqual((await post({ action: 'recompute', day: '2026-10-05', reason: 'again quickly' })).status, 429);
    const runs = loaderRuns();
    const b = ok200(await get('?from=2026-10-05&to=2026-10-05'));
    assert.strictEqual(loaderRuns(), runs, 'served from the saved row');
    assert.deepStrictEqual(b.days, [{ day: '2026-10-05', state: 'recomputed', final_at: null, saved_at: new Date(NOW).toISOString(), reason: 'Owner checked the old login' }]);
    // A later recompute of the same day is the one shown; a frozen 'auto' day can be recomputed too.
    NOW += 11_000;
    ok200(await post({ action: 'recompute', day: '2026-10-04', reason: 'second look' }));
    assert.strictEqual(ok200(await get('?from=2026-10-04&to=2026-10-04')).days[0].state, 'recomputed');
  });

  await t('R9 cron: no secret set = refused (no default); wrong secret refused; dry run asks no model and writes nothing', async () => {
    delete process.env.CRON_SECRET;
    for (const q of ['?secret=shiptrack-cron', '', '?secret=', '?secret=undefined']) {
      assert.strictEqual((await cron.GET(reqOf(null, '/api/cron/team-score' + q))).status, 401, q);
    }
    process.env.CRON_SECRET = CRON;
    assert.strictEqual((await cron.GET(reqOf(null, '/api/cron/team-score?secret=wrong'))).status, 401);
    assert.strictEqual((await cron.GET(reqOf(null, '/api/cron/team-score'))).status, 401);
    const from = db.log.length;
    for (const dry of ['1', 'yes', 'true']) {
      const b = ok200(await runCron('&dry=' + dry));
      assert.deepStrictEqual(Object.keys(b).sort(), ['candidates', 'dry', 'success', 'took_ms', 'waiting', 'would_freeze']);
      assert.deepStrictEqual([b.success, b.dry, b.candidates, b.would_freeze, b.waiting],
        [true, true, 2, ['2026-10-01', '2026-10-02', '2026-10-03'], [{ day: '2026-10-06', ai_pending: 1 }]]);
    }
    assert.deepStrictEqual(db.log.slice(from).filter((l) => /^INSERT|^UPDATE|^DELETE/.test(l.q)).map((l) => l.q.slice(0, 30)), []);
    assert.strictEqual(ai.calls.length, 0);
    // dry=0 is a real run.
    const real = ok200(await runCron('&dry=0'));
    assert.ok(real.judged && Array.isArray(real.frozen));
    assert.ok(!logs.some((l) => l.includes(CRON)), 'the secret is never logged');
    // A run already going: the next one is skipped.
    const p1 = runCron('&dry=1');
    assert.deepStrictEqual(ok200(await runCron('&dry=1')), { skipped: 'busy' });
    ok200(await p1);
    ok200(await runCron('&dry=1'));
  });

  await t('R10 AI check: verdict rows (ON CONFLICT, source ai), counted after; unclear; failures; breaker; caps; budget', async () => {
    // A cron run judges today's and 10-06's unsure thank-yous (newest first), then freezes.
    const b = ok200(await runCron());
    assert.deepStrictEqual(b.judged, { asked: 2, thanks_yes: 2, unclear: 0, failed: 0, capped: false, model_ok: true });
    assert.deepStrictEqual(b.frozen, ['2026-10-01', '2026-10-02', '2026-10-03']);
    assert.deepStrictEqual(ai.calls.map((c) => c.body.messages[1].content.split('\nCUSTOMER: ')[1]), ['thanks but kab aayega?', 'thanks but when will it come?']);
    assert.deepStrictEqual(db.verdicts.map((v) => [v.message_id, v.conversation_id, v.thanks, v.convinced, v.source, v.model]).sort(),
      [[c3Unsure, 'c3', true, false, 'ai', fakeAi.attemptOrder()[0]], [c4Unsure, 'c4', true, false, 'ai', fakeAi.attemptOrder()[0]]].sort());
    const rep = ok200(await get());
    assert.deepStrictEqual([person(rep, A).counts.thanks, person(rep, A).counts.thanks_pending, person(rep, A).points, rep.judge.pending, rep.judge.model_ok], [2, 0, 7, 0, true]);
    const th = ok200(await drill(`person=${A}&metric=thanks`)).items.find((it) => it.conv === 'c3');
    assert.deepStrictEqual([th.counted, th.by, th.why], [true, 'ai', "Customer said thanks at 12:05, 4 min after Anurag's reply (AI check)."]);
    // A second run: nothing left to ask; the next settled day freezes.
    ai.calls = [];
    const b2 = ok200(await runCron());
    assert.deepStrictEqual([b2.judged.asked, ai.calls.length, b2.frozen], [0, 0, ['2026-10-05', '2026-10-06']]);

    const cand = (i, text = 'thanks but ok?') => ({ messageId: 'x' + i, conv: 'c9x', teamText: 'Your order ships tomorrow', customerText: text });
    const run = (cands, max = 40, budgetMs = 60_000) => judge.runJudge({ candidates: cands, max, budgetMs });
    // Garbage from every model: recorded once as unclear (counts as no).
    db.verdicts = []; ai.calls = []; ai.mode = 'garbage';
    let r = await run([cand(1)]);
    assert.deepStrictEqual([r.asked, r.unclear, r.thanks_yes, r.failed], [1, 1, 0, 0]);
    assert.deepStrictEqual(ai.calls.map((c) => c.body.model), fakeAi.attemptOrder());
    assert.deepStrictEqual(db.verdicts.map((v) => [v.thanks, v.convinced, v.source, v.model]), [[false, false, 'ai_unclear', fakeAi.attemptOrder()[1]]]);
    // A blank answer moves on to the next model; <think> is ignored.
    ai.mode = 'firstGarbage';
    await run([cand(2)]);
    assert.deepStrictEqual([db.verdicts[1].source, db.verdicts[1].model, db.verdicts[1].thanks], ['ai', fakeAi.attemptOrder()[1], true]);
    ai.mode = 'think';
    await run([cand(3)]);
    assert.deepStrictEqual([db.verdicts[2].thanks, db.verdicts[2].convinced], [true, true]);
    // A thrown error writes no row; the 3rd failure of the same message writes 'ai_failed' (NULL, NULL).
    ai.mode = 'throw'; ai.calls = [];
    for (let i = 1; i <= 3; i++) {
      r = await run([cand(4)]);
      assert.deepStrictEqual([r.asked, r.failed], [1, 1]);
      assert.strictEqual(db.verdicts.some((v) => v.message_id === 'x4'), i === 3, 'run ' + i);
    }
    assert.deepStrictEqual(db.verdicts.filter((v) => v.message_id === 'x4').map((v) => [v.thanks, v.convinced, v.source, v.model]), [[null, null, 'ai_failed', null]]);
    assert.strictEqual(ai.calls.length, 3 * fakeAi.attemptOrder().length, 'a 503 tries the next model');
    assert.strictEqual(judge.modelStatus(), false);
    // Circuit breaker: 3 failures in a row stop the run.
    ai.calls = [];
    r = await run(Array.from({ length: 10 }, (_, i) => cand(100 + i)));
    assert.deepStrictEqual([r.asked, r.failed, r.model_ok], [3, 3, false]);
    // 401: the chain stops at the first model.
    ai.mode = 'throw401'; ai.calls = [];
    r = await run([cand(150)]);
    assert.deepStrictEqual([r.failed, ai.calls.length], [1, 1]);
    // A success: the model is fine again.
    ai.mode = 'yes';
    r = await run([cand(151)]);
    assert.deepStrictEqual([r.model_ok, judge.modelStatus()], [true, true]);
    // Per-run cap (40), newest first, duplicates asked once, a message already judged never sent.
    ai.calls = [];
    const many = Array.from({ length: 60 }, (_, i) => cand(200 + i));
    r = await run([...many, cand(259), cand(151)], 40);
    assert.deepStrictEqual([r.asked, r.capped, ai.calls.length], [40, false, 40]);
    assert.ok(db.verdicts.some((v) => v.message_id === 'x259') && db.verdicts.some((v) => v.message_id === 'x220') && !db.verdicts.some((v) => v.message_id === 'x219'), 'newest first');
    ai.calls = [];
    r = await run([cand(151), cand(259)]);
    assert.deepStrictEqual([r.asked, ai.calls.length], [0, 0]);
    // Daily cap (300 a day: rows written since India midnight + calls that failed today): 295 used leaves 5.
    const used = db.verdicts.filter((v) => v.created_at >= ist('2026-10-08 00:00')).length + globalThis.__teamScoreJudge.failToday;
    assert.strictEqual(globalThis.__teamScoreJudge.failToday, 7);
    for (let i = used; i < 295; i++) db.verdicts.push({ message_id: 'cap' + i, conversation_id: 'z', thanks: false, convinced: false, source: 'ai', model: 'm', created_at: NOW });
    r = await run(Array.from({ length: 20 }, (_, i) => cand(400 + i)));
    assert.deepStrictEqual([r.asked, r.capped], [5, true]);
    r = await run(Array.from({ length: 20 }, (_, i) => cand(500 + i)));
    assert.deepStrictEqual([r.asked, r.capped], [0, true]);
    // Yesterday's rows do not count against today.
    NOW = ist('2026-10-09 10:00');
    r = await run([cand(600)]);
    assert.deepStrictEqual([r.asked, r.capped], [1, false]);
    // Time budget: no new call starts once it is spent (each fake call takes 10 s).
    ai.onCall = () => { NOW += 10_000; };
    r = await run(Array.from({ length: 10 }, (_, i) => cand(700 + i)), 40, 25_000);
    assert.strictEqual(r.asked, 3);
  });

  await t('R10 a message the model never answers: "AI could not decide" after 3 runs, and its day is no longer held back', async () => {
    ai.mode = 'throw';
    const r1 = ok200(await runCron());
    assert.deepStrictEqual([r1.judged.asked, r1.judged.failed, db.verdicts.length, r1.frozen, r1.waiting], [2, 2, 0, ['2026-10-01', '2026-10-02', '2026-10-03'], [{ day: '2026-10-06', ai_pending: 1 }]]);
    const r2 = ok200(await runCron());
    assert.deepStrictEqual([r2.judged.failed, r2.judged.model_ok, db.verdicts.length, r2.frozen], [2, false, 0, ['2026-10-05']]);
    const r3 = ok200(await runCron());
    assert.deepStrictEqual(db.verdicts.map((v) => [v.message_id, v.source, v.thanks]).sort(), [[c3Unsure, 'ai_failed', null], [c4Unsure, 'ai_failed', null]].sort());
    assert.deepStrictEqual(r3.frozen, ['2026-10-06']);
    const rep = ok200(await get());
    assert.deepStrictEqual([person(rep, A).counts.thanks_pending, person(rep, A).counts.thanks_not_counted, rep.judge.pending, rep.judge.model_ok], [0, 1, 0, false]);
    const it = ok200(await drill(`person=${A}&metric=thanks`)).items.find((x) => x.conv === 'c3');
    assert.deepStrictEqual([it.counted, it.pending, it.why], [false, false, 'AI could not decide']);
  });

  await t('R11 what the model gets: attemptOrder()[0] first, temperature 0, no thinking, no retries, no names or points; logs carry counts only', async () => {
    ok200(await runCron());
    ok200(await post({ action: 'judge' }));
    assert.ok(ai.calls.length >= 2);
    const order = fakeAi.attemptOrder();
    for (const c of ai.calls) {
      assert.strictEqual(c.body.model, order[0]);
      assert.strictEqual(c.body.temperature, 0);
      assert.deepStrictEqual(c.body.reasoning, { enabled: false });
      assert.strictEqual(c.body.max_tokens, 800);
      assert.deepStrictEqual(c.opts, { timeout: 20_000, maxRetries: 0 });
      assert.deepStrictEqual(c.body.messages.map((m) => m.role), ['system', 'user']);
      assert.strictEqual(c.body.messages[0].content, words.JUDGE_INSTRUCTION);
      assert.ok(/^TEAM: [^\n]*\nCUSTOMER: [^\n]*$/.test(c.body.messages[1].content));
      for (const m of c.body.messages) assert.ok(!/Anurag|Rahul|Neha|Ravi|Pooja|Super Admin|points|score|\d{10}/i.test(m.content), m.content);
    }
    // A customer text with a phone, an e-mail and a link is masked before it is sent.
    ai.calls = [];
    await judge.runJudge({ candidates: [{ messageId: 'p1', conv: 'c1', teamText: 'Call me on 9876543210 or a@b.com', customerText: 'thanks https://x.y/z #12345 ST1234567 +91 98765 43210' }], max: 1, budgetMs: 10_000 });
    assert.strictEqual(ai.calls[0].body.messages[1].content, 'TEAM: Call me on [phone] or [email]\nCUSTOMER: thanks [link] [order] [tracking id] [phone]');
  });

  await t('R12 freezing: never today or yesterday; at most 3 a run; a day with an AI check pending waits until D+4; once only', async () => {
    // A day settles at D+2 01:00 IST, not a minute before (10-05 at 10-07 01:00).
    NOW = ist('2026-10-07 00:59');
    assert.deepStrictEqual(await report.settledDaysToSnapshot(NOW, 10), ['2026-10-01', '2026-10-02', '2026-10-03']);
    NOW = ist('2026-10-07 01:00'); report.clearScoreCache();
    assert.deepStrictEqual(await report.settledDaysToSnapshot(NOW, 10), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05']);
    NOW = BASE_NOW; report.clearScoreCache();
    // No model money in this group: the daily AI cap is already used up.
    const fillCap = () => { for (let i = 0; i < 300; i++) db.verdicts.push({ message_id: `cap-${NOW}-${i}`, conversation_id: 'z', thanks: false, convinced: false, source: 'ai', model: 'm', created_at: NOW }); };
    fillCap();
    let from = db.log.length;
    const r1 = ok200(await runCron());
    assert.deepStrictEqual([r1.judged.asked, r1.judged.capped, ai.calls.length], [0, true, 0]);
    assert.deepStrictEqual([r1.frozen, r1.waiting], [['2026-10-01', '2026-10-02', '2026-10-03'], [{ day: '2026-10-06', ai_pending: 1 }]]);
    assert.strictEqual(inserts(from, 'team_score_days').length, 3, 'at most 3 a run (4 were ready)');
    const r2 = ok200(await runCron());
    assert.deepStrictEqual([r2.frozen, r2.waiting], [['2026-10-05'], [{ day: '2026-10-06', ai_pending: 1 }]]);
    from = db.log.length;
    const r3 = ok200(await runCron());
    assert.deepStrictEqual([r3.frozen, inserts(from, 'team_score_days').length], [[], 0], 'nothing more to freeze');
    for (const d of db.days.filter((x) => x.id !== 1)) {
      assert.deepStrictEqual([d.kind, d.by_actor, d.reason, d.engine_version, d.settings_id], ['auto', 'cron', null, 'ts-1', 1]);
      assert.deepStrictEqual(JSON.parse(d.summary).items, []);
    }
    assert.ok(!db.days.some((d) => d.day === '2026-10-07' || d.day === '2026-10-08'), 'never today or yesterday');
    // The frozen 10-05 is what the list shows now, with no message loader.
    const runs = loaderRuns();
    const fz = ok200(await get('?from=2026-10-05&to=2026-10-05'));
    assert.deepStrictEqual([loaderRuns(), fz.days[0].state, person(fz, A).counts.thanks], [runs, 'final', 1]);
    // 10-06 still pending one minute before D+4 (10-10 00:00); 10-07 is settled by then.
    NOW = ist('2026-10-09 23:59'); fillCap();
    const r4 = ok200(await runCron());
    assert.deepStrictEqual([r4.frozen, r4.waiting], [['2026-10-07'], [{ day: '2026-10-06', ai_pending: 1 }]]);
    NOW = ist('2026-10-10 00:00'); fillCap();
    const r5 = ok200(await runCron());
    assert.deepStrictEqual([r5.frozen, r5.waiting], [['2026-10-06'], []]);
    const d6 = db.days.find((d) => d.day === '2026-10-06');
    const th = JSON.parse(d6.items).filter((it) => it.kind === 'thanks');
    assert.deepStrictEqual(th.map((it) => [it.actor, it.counted, it.pending, it.points, it.why]), [[A, false, false, 0, 'AI check not done']]);
    assert.strictEqual(d6.ai_pending, 1);
    const sum = JSON.parse(d6.summary);
    assert.deepStrictEqual([sum.aiPending, sum.people.find((p) => p.key === A).counts.thanks_pending, sum.people.find((p) => p.key === A).counts.thanks_not_counted], [1, 0, 1]);
    // Once only: the unique 'auto' day keeps a second insert out.
    assert.strictEqual(await report.snapshotDay('2026-10-06', 'auto', 'cron', null), false);
    assert.deepStrictEqual(await report.settledDaysToSnapshot(NOW, 3), []);
    const autos = db.days.filter((d) => d.kind === 'auto').map((d) => d.day);
    assert.strictEqual(autos.length, new Set(autos).size);
  });

  await t('R13 a day computed after D+2 (live, recomputed, frozen) keeps the numbers it had: later status / case / holder rows', async () => {
    // On 10-05 three customers waited all day on Anurag (c7), Rahul (c8) and Neha (c9). Their chats
    // changed only on 10-07 (closed / marked Refund / given back), after 10-05's load window ends.
    const check = (sum, where) => {
      const pp = (k) => sum.people.find((p) => p.key === k);
      assert.deepStrictEqual([pp(A).counts.unanswered_2h, pp(R).counts.unanswered_2h, pp(N).counts.unanswered_2h, sum.team.pool_waited_2h], [1, 1, 1, 0], where);
      assert.deepStrictEqual([pp(A).points, pp(R).points, pp(N).points], [0, -3, -3], where);
    };
    const live = ok200(await get('?from=2026-10-05&to=2026-10-05'));
    check(live, 'live');
    let b = ok200(await drill(`from=2026-10-05&to=2026-10-05&person=${A}&metric=unanswered_2h`));
    assert.deepStrictEqual(b.items.map((it) => [it.conv, it.at_ist, it.points]), [['c7', '13:00', -3]]);
    b = ok200(await drill(`from=2026-10-05&to=2026-10-05&person=${N}&metric=unanswered_2h`));
    assert.deepStrictEqual(b.items.map((it) => [it.conv, it.at_ist]), [['c9', '13:00']]);
    // The same day inside a longer range (whose window reaches today) gives the same numbers.
    const wide = ok200(await drill(`from=2026-10-05&to=2026-10-08&person=${R}&metric=unanswered_2h`));
    assert.deepStrictEqual(wide.items.filter((it) => it.day === '2026-10-05').map((it) => [it.conv, it.at_ist]), [['c8', '13:00']]);
    // Recompute and the cron's freeze compute the day alone: same numbers (a recompute needs the
    // day frozen first).
    assert.strictEqual(await report.snapshotDay('2026-10-05', 'auto', 'cron', null), true);
    check(JSON.parse(db.days[db.days.length - 1].summary), 'freeze first');
    ok200(await post({ action: 'recompute', day: '2026-10-05', reason: 'check the late rows' }));
    check(JSON.parse(db.days[db.days.length - 1].summary), 'recompute');
    db.days = [{ ...FROZEN_ROW }];
    ok200(await runCron()); ok200(await runCron());
    check(JSON.parse(db.days.find((d) => d.day === '2026-10-05' && d.kind === 'auto').summary), 'freeze');
    // Rows written on 10-08 for another chat change nothing on 10-05.
    const base = JSON.stringify(JSON.parse(db.days.find((d) => d.day === '2026-10-05' && d.kind === 'auto').items));
    const c4 = db.convs.find((c) => c.id === 'c4');
    const saved = { ...c4 };
    hold('c4', '2026-10-08 13:00', null, A);
    ev({ kind: 'status', conv: 'c4', at: ist('2026-10-08 13:30'), from_status: 'agent_handling', to_status: 'resolved', reason: 'close', actor: A, actor_name: 'Anurag' });
    db.cases.push({ conv: 'c4', at: ist('2026-10-08 13:45'), action: 'mark' });
    Object.assign(c4, { status: 'resolved', assigned_to: A, assigned_at: ist('2026-10-08 13:00'), case_kind: 'refund' });
    NOW += 11_000;
    ok200(await post({ action: 'recompute', day: '2026-10-05', reason: 'after the late rows' }));
    assert.strictEqual(JSON.stringify(JSON.parse(db.days[db.days.length - 1].items)), base);
    Object.assign(c4, saved);
    db.holders.pop(); db.events.pop(); db.cases.pop();
  });

  await t('R14 owner A1: a member who can reply sees only their own row and items; the cache is filtered per request', async () => {
    const asA = (q = '') => score.GET(reqOf(memberA(), '/api/team/score' + q));
    const asN = (q = '') => score.GET(reqOf(memberN(), '/api/team/score' + q));
    // Values (not JSON keys) that would name or number someone else.
    const others = (body, me) => strings(body).filter(([k, v]) => k !== 'cu' && [A, R, N, V, P, 'owner', 'Anurag', 'Rahul', 'Neha', 'Ravi', 'Pooja', 'Super Admin']
      .filter((x) => !me.includes(x)).some((x) => v === x || v.includes(x)));
    // 1. The Super Admin loads today first: the full board goes into the 60 s cache.
    const full = ok200(await get());
    assert.deepStrictEqual([full.view, full.people.length, !!full.owner, !!full.leader, full.judge.pending], ['team', 3, true, true, 1]);
    const runs = loaderRuns(), from = db.log.length;
    // 2. Anurag: his own row only, from the same cache (no new load, no score SQL).
    const mine = ok200(await asA());
    assert.deepStrictEqual([loaderRuns(), scoreSql(from).length], [runs, 0], 'served from the cache');
    // The Points rules dialog's rows (newest / today / planned weights) are the Super Admin's only.
    const PLAN = ['weights_latest', 'weights_today', 'weights_scheduled'];
    assert.deepStrictEqual(Object.keys(mine).sort(), Object.keys(full).filter((k) => !PLAN.includes(k)).sort());
    assert.ok(PLAN.every((k) => k in full && !(k in mine)));
    assert.deepStrictEqual([mine.view, mine.owner, mine.leader, mine.people.length], ['self', null, null, 1]);
    const me = mine.people[0], fa = person(full, A);
    assert.deepStrictEqual([me.key, me.name, me.rank, me.ranked, me.points], [A, 'Anurag', null, false, 4]);
    assert.deepStrictEqual({ ...me, rank: fa.rank, ranked: fa.ranked }, fa, 'the same numbers the board shows');
    assert.deepStrictEqual([me.parts.thanks, me.parts.closed_waiting, me.parts.convinced],
      [{ n: 1, each: 3, points: 3 }, { n: 0, each: -2, points: 0 }, { n: 0, each: 0, points: 0 }], 'his parts show the weights');
    assert.deepStrictEqual(mine.team, { pool_waited_2h: null, absent_waits: null, thanks_after_ai: 0, unattributed: [] });
    assert.deepStrictEqual(mine.judge, { pending: 1, model_ok: null });                          // his own AI-pending thanks
    assert.deepStrictEqual([mine.from, mine.to, mine.days, mine.weights, mine.points_from, mine.health_from, mine.events_since],
      [full.from, full.to, full.days, full.weights, full.points_from, full.health_from, full.events_since]);
    // Nobody else anywhere, except whom he himself sent a chat to.
    assert.deepStrictEqual(me.counts.sent_to, [{ key: R, name: 'Rahul', n: 1 }]);
    assert.deepStrictEqual(others({ ...mine, people: [{ ...me, counts: { ...me.counts, sent_to: [] } }] }, [A, 'Anurag']), []);
    // 3. Neha right after: her row from the same cached result, nothing of Anurag's; her AI queue is 0.
    const hers = ok200(await asN());
    assert.deepStrictEqual([hers.view, hers.people.map((p) => p.key), hers.people[0].points, hers.judge.pending, loaderRuns()], ['self', [N], 0, 0, runs]);
    assert.deepStrictEqual(others(hers, [N, 'Neha']), []);
    // 4. The Super Admin again: still everything (no filtered copy was cached), still from the cache.
    const again = ok200(await get());
    assert.deepStrictEqual([again.view, again.people.map((p) => p.key), !!again.owner, again.leader, loaderRuns()],
      ['team', full.people.map((p) => p.key), true, full.leader, runs]);
    // 5. A member first, then the Super Admin, on a cold cache: the same.
    report.clearScoreCache();
    ok200(await asN('?fresh=1'));
    const cold = ok200(await get());
    assert.deepStrictEqual([cold.people.length, !!cold.owner, cold.team.pool_waited_2h], [3, true, 1]);
    // 6. A frozen day and a range: still only his own row.
    const fz = ok200(await asA('?from=2026-10-04&to=2026-10-04'));
    assert.deepStrictEqual([fz.view, fz.people.map((p) => [p.key, p.points, p.rank]), fz.team.thanks_after_ai], ['self', [[A, 9, null]], 0]);
    const rg = ok200(await asA('?from=2026-10-04&to=2026-10-08'));
    assert.deepStrictEqual([rg.people.length, rg.people[0].key, rg.people[0].points, rg.owner, rg.leader], [1, A, person(ok200(await get('?from=2026-10-04&to=2026-10-08')), A).points, null, null]);
    // 7. A Recompute reason is the Super Admin's note: a member sees the day is recomputed, not why.
    await report.snapshotDay('2026-10-05', 'auto', 'cron', null);
    ok200(await post({ action: 'recompute', day: '2026-10-05', reason: 'Rahul disputed this day' }));
    const rc = ok200(await asA('?from=2026-10-05&to=2026-10-05'));
    assert.deepStrictEqual([rc.days[0].state, rc.days[0].reason], ['recomputed', null]);
    assert.strictEqual(ok200(await get('?from=2026-10-05&to=2026-10-05')).days[0].reason, 'Rahul disputed this day');
    // 8. A member with no row in the period (Neha on the frozen 10-03 that lists nobody): an empty list.
    db.days.push({ id: 3, day: '2026-10-03', kind: 'auto', engine_version: 'ts-1', settings_id: 1, ai_pending: 0, by_actor: 'cron', reason: null, created_at: NOW,
      summary: JSON.stringify({ ...FROZEN_0410, day: '2026-10-03', people: [FROZEN_0410.people[0]] }), items: '[]' });
    report.clearScoreCache();
    assert.deepStrictEqual(ok200(await asN('?from=2026-10-03&to=2026-10-03')).people, []);
    // 9. Drill-down: only person = self; anyone else, the Super Admin's row and the AI's thank-yous are 403.
    const own = ok200(await items.GET(reqOf(memberA(), `/api/team/score/items?person=${A}&metric=thanks`)));
    assert.deepStrictEqual([own.person, own.total, own.counted], [A, 2, 1]);
    const ownSent = ok200(await items.GET(reqOf(memberA(), `/api/team/score/items?person=${A}&metric=points`)));
    assert.ok(ownSent.items.every((it) => it.actor === A));
    for (const who of [R, N, V, 'owner', 'ai', 'unattributed']) {
      const r = await items.GET(reqOf(memberA(), `/api/team/score/items?person=${who}&metric=thanks`));
      assert.deepStrictEqual([r.status, r.body.error], [403, 'You can see only your own score'], who);
    }
    assert.strictEqual((await items.GET(reqOf(memberA(), `/api/team/score/items?person=${A}&metric=bogus`))).status, 400);
    // The Super Admin may still open anyone's.
    ok200(await drill(`person=${R}&metric=chats`));
    ok200(await drill('from=2026-10-07&to=2026-10-07&person=ai&metric=thanks'));
  });

  await t('R15 one AI check at a time: Check now during the cron\'s run is refused, the cron during a run asks nothing; a recompute of a day not frozen yet is refused', async () => {
    // The model answers only when the test lets it: the first run is still asking.
    const realCreate = ai.create;
    let open;
    const gate = new Promise((r) => { open = r; });
    ai.create = async (body, opts) => { await gate; return realCreate(body, opts); };
    try {
      const cand = (i) => ({ messageId: 'lk' + i, conv: 'c9x', teamText: 'Your order ships tomorrow', customerText: 'thanks but ok?' });
      const first = judge.runJudge({ candidates: [cand(1), cand(2)], max: 40, budgetMs: 60_000 });
      for (let i = 0; i < 20; i++) await tick();
      assert.strictEqual(judge.judgeBusy(), true);
      const askedBefore = ai.calls.length;
      // Check now: refused before its 30 s slot is used, no model call, no verdict row.
      const r1 = await post({ action: 'judge' });
      assert.deepStrictEqual([r1.status, r1.body.error], [429, 'AI check already running, try again in a minute']);
      // Another run (the cron's) asks nothing and says why (it must not wait on the first one either).
      const r2 = await Promise.race([judge.runJudge({ candidates: [cand(1), cand(2), cand(3)], max: 40, budgetMs: 60_000 }),
        new Promise((r) => setTimeout(() => r('still asking'), 300))]);
      assert.deepStrictEqual(r2, { asked: 0, thanks_yes: 0, unclear: 0, failed: 0, capped: false, model_ok: true, busy: true });
      // The cron itself still freezes its days while the AI check is busy.
      const c = ok200(await runCron());
      assert.deepStrictEqual([c.judged.asked, c.judged.busy, c.frozen], [0, true, ['2026-10-01', '2026-10-02', '2026-10-03']]);
      assert.strictEqual(ai.calls.length, askedBefore);
      open();
      const done = await first;
      assert.deepStrictEqual([done.asked, done.thanks_yes, done.busy], [2, 2, undefined]);
      assert.deepStrictEqual(db.verdicts.map((v) => v.message_id).sort(), ['lk1', 'lk2']);
      assert.strictEqual(judge.judgeBusy(), false);
      // Free again: Check now runs (its 30 s slot was not used by the refused click).
      const r3 = ok200(await post({ action: 'judge' }));
      assert.strictEqual(r3.ok, true);
      // One model call per verdict row (the fake model answers at once): no message was asked twice.
      assert.ok(ai.calls.length >= 4);
      assert.strictEqual(ai.calls.length, db.verdicts.length);
    } finally { ai.create = realCreate; open && open(); }
    // A run that fails still frees the lock.
    db.fail = { re: /^SELECT message_id FROM team_score_verdicts WHERE message_id = ANY/, code: '57014' };
    await assert.rejects(judge.runJudge({ candidates: [{ messageId: 'lk9', conv: 'c9x', teamText: 'x', customerText: 'thanks but ok?' }], max: 5, budgetMs: 10_000 }));
    assert.strictEqual(judge.judgeBusy(), false);
    // Recompute: only a day with its cron 'auto' row (10-05 is past D+2 but not frozen yet).
    const before = db.days.length;
    const no = await post({ action: 'recompute', day: '2026-10-05', reason: 'Rahul disputed this day' });
    assert.deepStrictEqual([no.status, no.body.error, db.days.length], [400, 'Only days that are already final can be recomputed', before]);
    // Once the cron froze it, a recompute is the row shown, with its reason, and a later cron run
    // never replaces it.
    ok200(await runCron()); ok200(await runCron());
    assert.ok(db.days.some((d) => d.day === '2026-10-05' && d.kind === 'auto'));
    NOW += 11_000;
    ok200(await post({ action: 'recompute', day: '2026-10-05', reason: 'Rahul disputed this day' }));
    ok200(await runCron());
    const shown = ok200(await get('?from=2026-10-05&to=2026-10-05')).days[0];
    assert.deepStrictEqual([shown.state, shown.reason], ['recomputed', 'Rahul disputed this day']);
  });

  await t('R16 review 2026-10-02: the Points rules dialog gets the newest, today\'s and planned weights; a frozen pending "Convinced" is counted as not counted', async () => {
    const W1 = { ...SETTINGS1.weights, closed_waiting: -2 };
    const row = (id) => { const r = db.settings.find((x) => x.id === id); return { id, values: r.weights, effective_from: r.effective_from }; };
    let b = ok200(await get());
    assert.deepStrictEqual([b.weights_latest, b.weights_today, b.weights_scheduled], [{ id: 1, values: W1, effective_from: '2026-01-01' }, { id: 1, values: W1, effective_from: '2026-01-01' }, []]);
    // (b) Thanks +5 planned from 10-10. Today's board still shows row 1, but the dialog's base is the new row.
    ok200(await post({ action: 'settings', weights: { ...W1, thanks: 5 }, effectiveFrom: '2026-10-10' }));
    const id2 = db.settings[db.settings.length - 1].id;
    b = ok200(await get());
    assert.deepStrictEqual([b.weights.id, b.weights.values.thanks, b.weights_latest, b.weights_today.id, b.weights_scheduled],
      [1, 3, row(id2), 1, [row(id2)]]);
    assert.deepStrictEqual([b.weights_latest.values.thanks, b.weights_latest.effective_from], [5, '2026-10-10']);
    // (a) A past day on screen: its own weights are row 1, the dialog still starts from the newest row.
    b = ok200(await get('?from=2026-10-05&to=2026-10-05'));
    assert.deepStrictEqual([b.weights.id, b.weights_latest.id, b.weights_latest.values.thanks], [1, id2, 5]);
    // A newer row from an earlier day (10-09) hides the 10-10 one: only the row that will still apply is planned.
    ok200(await post({ action: 'settings', weights: { ...W1, thanks: 5, fast_reply: 2 }, effectiveFrom: '2026-10-09' }));
    const id3 = db.settings[db.settings.length - 1].id;
    b = ok200(await get());
    assert.deepStrictEqual([b.weights_latest, b.weights_today.id, b.weights_scheduled], [row(id3), 1, [row(id3)]]);
    // Once 10-09 has come, nothing is planned and today's row is the newest.
    NOW = ist('2026-10-09 10:00'); report.clearScoreCache();
    b = ok200(await get());
    assert.deepStrictEqual([b.weights_latest, b.weights_today, b.weights_scheduled], [row(id3), row(id3), []]);
    NOW = BASE_NOW; report.clearScoreCache();
    // The pure rule: rows that still apply after today, in day order; the newest row is the base.
    const S = (id, ef, thanks) => ({ id, weights: { ...DEFAULTS, thanks }, effectiveFrom: ef, pointsFrom: '2026-10-02', createdAt: 0 });
    const plan = report.weightsPlan([S(1, '2026-01-01', 3), S(2, '2026-10-10', 4), S(3, '2026-10-12', 5)], '2026-10-08');
    assert.deepStrictEqual([plan.weights_latest.id, plan.weights_today.id, plan.weights_scheduled.map((r) => [r.id, r.effective_from])],
      [3, 1, [[2, '2026-10-10'], [3, '2026-10-12']]]);
    const hidden = report.weightsPlan([S(1, '2026-01-01', 3), S(2, '2026-10-12', 4), S(3, '2026-10-10', 5)], '2026-10-08');
    assert.deepStrictEqual([hidden.weights_latest.id, hidden.weights_scheduled.map((r) => r.id)], [3, [3]]);
    assert.deepStrictEqual(report.weightsPlan([], '2026-10-08').weights_scheduled, []);
    // A member gets none of it.
    const mine = ok200(await score.GET(reqOf(memberA(), '/api/team/score')));
    assert.ok(!('weights_latest' in mine) && !('weights_today' in mine) && !('weights_scheduled' in mine));
    // Freezing a day with a "Convinced" still waiting for the AI: not counted, and counted as such.
    const n0 = { convs: db.convs.length, msgs: db.msgs.length, events: db.events.length };
    try {
      conv('c20', { customer_key: '9777700001', assigned_to: A, assigned_at: ist('2026-10-06 11:00') });
      msg('c20', 'visitor', '2026-10-06 11:00', 'abhi tak nahi aaya');
      msg('c20', 'agent', '2026-10-06 11:10', 'Courier delay hai, kal tak aa jayega', { login: 'anurag', by: A });
      msg('c20', 'visitor', '2026-10-06 11:20', 'Okay I will wait but please make sure it reaches by Monday as it is a gift?');
      const live = person(ok200(await get('?from=2026-10-06&to=2026-10-06')), A).counts;
      assert.deepStrictEqual([live.convinced, live.convinced_pending, live.convinced_not_counted], [0, 1, 0]);
      assert.strictEqual(await report.snapshotDay('2026-10-06', 'auto', 'cron', null), true);
      const d6 = db.days.find((d) => d.day === '2026-10-06' && d.kind === 'auto');
      const sum = JSON.parse(d6.summary).people.find((p) => p.key === A).counts;
      assert.deepStrictEqual([sum.convinced, sum.convinced_pending, sum.convinced_not_counted], [0, 0, 1]);
      assert.deepStrictEqual(JSON.parse(d6.items).filter((it) => it.kind === 'convinced').map((it) => [it.actor, it.counted, it.pending, it.why]),
        [[A, false, false, 'AI check not done']]);
      const fz = person(ok200(await get('?from=2026-10-06&to=2026-10-06')), A).counts;
      assert.deepStrictEqual([fz.convinced, fz.convinced_pending, fz.convinced_not_counted], [0, 0, 1]);
      const open = ok200(await drill(`from=2026-10-06&to=2026-10-06&person=${A}&metric=convinced`));
      assert.deepStrictEqual([open.total, open.counted, open.items[0].why], [1, 0, 'AI check not done']);
    } finally {
      db.convs.length = n0.convs; db.msgs.length = n0.msgs; db.events.length = n0.events;
    }
  });

  await t('POST judge ("Check now"): counts back, at most once per 30 s', async () => {
    const r = ok200(await post({ action: 'judge' }));
    assert.deepStrictEqual(Object.keys(r).sort(), ['judged', 'model_ok', 'ok', 'pending']);
    assert.deepStrictEqual([r.ok, r.judged, r.pending, r.model_ok], [true, 2, 0, true]);
    assert.deepStrictEqual([(await post({ action: 'judge' })).status, (await post({ action: 'judge' })).body.error], [429, 'Wait a moment']);
    NOW += 29_000;
    assert.strictEqual((await post({ action: 'judge' })).status, 429);
    NOW += 2_000;
    assert.deepStrictEqual(ok200(await post({ action: 'judge' })).judged, 0);
  });

  await t('logs: counts only, never a customer text, phone, judge input or the cron secret', async () => {
    assert.ok(logs.some((l) => /^\[team-score\] 2026-10-08\.\.2026-10-08 1 live \d+ ms \(\d+ msgs, 0 frozen\)$/.test(l)), logs.filter((l) => /team-score/.test(l)).slice(0, 3).join(' | '));
    assert.ok(logs.some((l) => /^\[team-score\] judge asked=\d+ yes=\d+ unclear=\d+ failed=\d+ capped=(true|false)$/.test(l)));
    assert.ok(logs.some((l) => /^\[team-score\] cron asked=/.test(l)));
    const texts = VISITOR_TEXTS();
    for (const l of logs) {
      for (const s of texts) assert.ok(!l.includes(s), 'customer text in a log line: ' + l.slice(0, 120));
      assert.ok(!/\d{10}|CUSTOMER:|TEAM:|size exchange, Rahul/.test(l) && !l.includes(CRON), l.slice(0, 120));
    }
  });

  Object.assign(console, realConsole);
  Date.now = realNow;
  console.log(`TEAM-SCORE ROUTE: ${n} groups passed`);
  process.exit(0);
})().catch((e) => { Object.assign(console, realConsole); Date.now = realNow; console.error(e); console.error(logs.slice(-6).join('\n')); process.exit(1); });
