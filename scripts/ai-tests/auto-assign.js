// Chats go to the team by themselves (owner 2026-10-10, step 3): the REAL rules (auto-assign-rules.ts) and worker
// (auto-assign.ts) against a fake database, team list and presence. 12 Oct 2026 is a Monday (India).
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

const IST = (d, h, m = 0) => Date.UTC(2026, 9, d, h, m) - 330 * 60000;
const eq = assert.strictEqual, deq = assert.deepStrictEqual;
const AGENT = ['orders.view', 'chat.view', 'chat.reply', 'chat.cases'];
const S = {};
function reset() {
  Object.assign(S, {
    team: [
      { id: 'u-rahul', username: 'rahul', name: 'Rahul', active: true, role: 'agent', permissions: AGENT, businessIds: null },
      { id: 'u-anurag', username: 'anurag', name: 'Anurag', active: true, role: 'agent', permissions: AGENT, businessIds: null },
      { id: 'u-priya', username: 'priya', name: 'Priya', active: true, role: 'agent', permissions: AGENT, businessIds: ['P2'] },
      { id: 'u-sunny', username: 'sunny', name: 'Sunny', active: true, role: 'manager', permissions: null, businessIds: null },
      { id: 'u-off', username: 'old', name: 'Old', active: false, role: 'agent', permissions: AGENT, businessIds: null },
    ],
    seen: {}, presence: true, loaded: true, convs: [], events: [], actors: [], stealNext: false,
  });
}
reset();
const conv = (o) => { const c = { id: 'c' + (S.convs.length + 1), site_id: 'S1', panel: 'P1', source: 'chat', customer_key: null, status: 'human_needed', assigned_to: null, merged_into: null, case_kind: null, waiting: true, last: S.convs.length, ...o }; S.convs.push(c); return c; };
const norm = (q) => q.replace(/\s+/g, ' ').trim();
const client = {
  query: async (raw, p = []) => {
    const q = norm(raw);
    if (/^SELECT set_config\('shiptrack\.actor'/.test(q)) { S.actors.push(p); return { rows: [], rowCount: 0 }; }
    if (/^UPDATE conversations SET assigned_to = \$2::text, assigned_at = now\(\) WHERE assigned_to IS NULL/.test(q)) {
      const main = S.convs.find((c) => c.id === p[0]);
      if (S.stealNext) { S.stealNext = false; main.assigned_to = 'u-other-process'; }
      if (!main || main.assigned_to !== null) return { rows: [], rowCount: 0 };
      const hit = S.convs.filter((c) => c.assigned_to === null && !c.merged_into && (c.id === p[0] || (p[2] != null && c.source === 'chat' && c.site_id === p[3] && c.customer_key === p[2] && c.status !== 'resolved')));
      for (const c of hit) c.assigned_to = p[1];
      return { rows: hit.map((c) => ({ id: c.id })), rowCount: hit.length };
    }
    throw new Error('fake client: ' + q.slice(0, 100));
  },
};
const db = {
  query: async (raw, p = []) => {
    const q = norm(raw);
    if (/WHERE c\.assigned_to IS NULL AND c\.merged_into IS NULL AND c\.case_kind IS NULL/.test(q)) {
      assert.ok(/LIMIT 40$/.test(q));
      const rows = S.convs.filter((c) => c.assigned_to === null && !c.merged_into && !c.case_kind && (c.status === 'human_needed' || (c.status === 'agent_handling' && c.waiting)))
        .sort((a, b) => a.last - b.last).map((c) => ({ id: c.id, site_id: c.site_id, customer_key: c.customer_key, source: c.source, panel: c.panel, status: c.status }));
      return { rows, rowCount: rows.length };
    }
    if (/^SELECT assigned_to, count\(\*\)::int AS n FROM conversations WHERE assigned_to IS NOT NULL/.test(q)) {
      const by = {}; for (const c of S.convs) if (c.assigned_to && c.status !== 'resolved' && !c.merged_into) by[c.assigned_to] = (by[c.assigned_to] || 0) + 1;
      return { rows: Object.entries(by).map(([assigned_to, n]) => ({ assigned_to, n })), rowCount: 1 };
    }
    throw new Error('fake db: ' + q.slice(0, 100));
  },
  withTransaction: async (fn) => fn(client),
};
const fakes = {
  '@/lib/db': db,
  '@/lib/auth': {
    teamEntries: () => S.team.map((e) => ({ ...e })),
    teamLoaded: () => S.loaded, presenceRead: () => S.presence,
    lastSeenMs: (k) => (S.seen[k] ?? null),
  },
  './holidays': { loadHolidays: async () => [], cachedHolidays: () => [] },
  './team-routing': {
    setSystemActor: async (c, name, reason) => c.query(`SELECT set_config('shiptrack.actor', $1, true)`, ['system', name, reason]),
    logChatEvent: async (c, who, ev) => { S.events.push({ who, ...ev }); return true; },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (fakes[request]) return request;
  if (request.startsWith('@/')) return origResolve.call(this, path.join(SRC, request.slice(2)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) { if (fakes[request]) return fakes[request]; return origLoad.call(this, request, parent, ...rest); };

const rules = require(path.join(SRC, 'lib/chat/auto-assign-rules.ts'));
const auto = require(path.join(SRC, 'lib/chat/auto-assign.ts'));
const realLog = console.log; const logs = [];

let pass = 0, fail = 0;
async function t(name, fn) {
  reset(); delete global.__autoAssignBusy; delete global.__autoAssignLast; logs.length = 0;
  console.log = (...a) => logs.push(a.join(' '));
  try { await fn(); console.log = realLog; pass++; console.log('  ok  ' + name); }
  catch (e) { console.log = realLog; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')); }
}
const here = (key, ms) => { S.seen[key] = ms; };

(async () => {
  console.log('auto-assign: the rules');
  await t('onDuty: logged in today since 10:00 and around, office open; the Manager, a switched-off login, another panel, absent or away 30+ min never', () => {
    const base = { active: true, canReply: true, lead: false, panelOk: true, officeOpen: true, seenTodayMs: IST(12, 10, 5), openedTodayMs: IST(12, 10), awayMin: 5 };
    eq(rules.onDuty(base), true);
    for (const [k, v] of [['lead', true], ['active', false], ['canReply', false], ['panelOk', false], ['officeOpen', false]]) eq(rules.onDuty({ ...base, [k]: v }), false, k);
    eq(rules.onDuty({ ...base, seenTodayMs: null }), false, 'never logged in');
    eq(rules.onDuty({ ...base, seenTodayMs: IST(11, 18) }), false, 'seen only yesterday = absent today');
    eq(rules.onDuty({ ...base, awayMin: 30 }), false, 'away 30 min');
    eq(rules.onDuty({ ...base, awayMin: 29 }), true);
  });
  await t('pickAssignee: the fewest open chats; on a tie the one given a chat longest ago; then by name', () => {
    eq(rules.pickAssignee([]), null);
    eq(rules.pickAssignee([{ key: 'a', name: 'A', load: 3, lastAssignedMs: 0 }, { key: 'b', name: 'B', load: 1, lastAssignedMs: 9 }]).key, 'b');
    eq(rules.pickAssignee([{ key: 'a', name: 'A', load: 1, lastAssignedMs: 9 }, { key: 'b', name: 'B', load: 1, lastAssignedMs: 2 }]).key, 'b');
    eq(rules.pickAssignee([{ key: 'b', name: 'Zed', load: 0, lastAssignedMs: 0 }, { key: 'a', name: 'Amy', load: 0, lastAssignedMs: 0 }]).key, 'a');
  });

  console.log('auto-assign: the worker');
  await t('chats that need a person go to the members on duty, the least busy first, spread one by one; Chikki\'s chats, Refund / Ship again and held chats never', async () => {
    const now = IST(12, 11);
    here('u-rahul', IST(12, 10, 40)); here('u-anurag', IST(12, 10, 50)); here('u-sunny', IST(12, 10, 55));
    conv({ assigned_to: 'u-rahul', status: 'agent_handling', waiting: false });          // Rahul already holds one
    const a = conv({}); const b = conv({ status: 'agent_handling' }); const c = conv({});
    const ai = conv({ status: 'ai_handling' }); const answered = conv({ status: 'agent_handling', waiting: false });
    const refund = conv({ case_kind: 'refund' }); const held = conv({ assigned_to: 'u-anurag' });
    const r = await auto.runAutoAssign(now);
    deq([r.given, r.idle], [3, undefined]);
    // Rahul already holds one, Anurag none: a -> Anurag (load 0); then both hold one: b -> Rahul (given a chat longer ago); c -> Anurag.
    deq([a.assigned_to, b.assigned_to, c.assigned_to], ['u-anurag', 'u-rahul', 'u-anurag']);
    eq(new Set([a.assigned_to, b.assigned_to, c.assigned_to]).size, 2, 'spread over the two members on duty');
    ok([a, b, c].every((x) => ['u-rahul', 'u-anurag'].includes(x.assigned_to)), 'never the Manager, never someone off duty');
    deq([ai.assigned_to, answered.assigned_to, refund.assigned_to, held.assigned_to], [null, null, null, 'u-anurag']);
    deq(S.events.map((e) => [e.who, e.kind, e.reason]), [['system', 'claim', 'auto_assign'], ['system', 'claim', 'auto_assign'], ['system', 'claim', 'auto_assign']]);
    ok(S.actors.every((p) => p[0] === 'system' && p[2] === 'auto_assign'));
  });
  await t('nobody logged in today, the office closed, or right after a restart: nothing is given out (chats stay in the open pool)', async () => {
    conv({});
    here('u-rahul', IST(11, 18));                                       // only yesterday
    deq([(await auto.runAutoAssign(IST(12, 11))).idle, S.convs[0].assigned_to], ['nobody_on_duty', null]);
    here('u-rahul', IST(12, 10, 45));
    eq((await auto.runAutoAssign(IST(12, 20))).idle, 'office_closed', 'after 19:30');
    eq((await auto.runAutoAssign(IST(11, 12))).idle, 'office_closed', 'Sunday');
    S.presence = false;
    eq((await auto.runAutoAssign(IST(12, 11))).idle, 'starting');
    S.presence = true;
    eq((await auto.runAutoAssign(IST(12, 11))).given, 1);
    eq(S.convs[0].assigned_to, 'u-rahul');
  });
  await t('a member away 30+ min gets nothing; a member limited to another panel gets only that panel\'s chats', async () => {
    here('u-rahul', IST(12, 10, 5));                                    // away 55 min at 11:00
    here('u-priya', IST(12, 10, 58));
    const p1 = conv({}); const p2 = conv({ panel: 'P2', site_id: 'S2' });
    const r = await auto.runAutoAssign(IST(12, 11));
    deq([r.given, p1.assigned_to, p2.assigned_to], [1, null, 'u-priya']);
  });
  await t('the customer\'s other open chats nobody holds go with it; a chat the other process took first is skipped', async () => {
    here('u-anurag', IST(12, 10, 50));
    const first = conv({ customer_key: '9876543210' }); const second = conv({ customer_key: '9876543210', status: 'agent_handling', waiting: false });
    const third = conv({});
    S.stealNext = true;                                                   // the other PM2 process claims `first` meanwhile
    let r = await auto.runAutoAssign(IST(12, 11));
    deq([first.assigned_to, second.assigned_to, third.assigned_to, r.given], ['u-other-process', null, 'u-anurag', 1]);
    first.assigned_to = null; second.assigned_to = null; third.assigned_to = 'x';
    r = await auto.runAutoAssign(IST(12, 11, 1));
    deq([first.assigned_to, second.assigned_to, r.given], ['u-anurag', 'u-anurag', 1]);
    deq(S.events.pop().meta.group, [second.id]);
  });
  await t('one run at a time per process; a database error never throws', async () => {
    here('u-anurag', IST(12, 10, 50)); conv({});
    global.__autoAssignBusy = true;
    eq((await auto.runAutoAssign(IST(12, 11))).idle, 'busy');
    delete global.__autoAssignBusy;
    const keep = db.query; db.query = async () => { throw new Error('db down'); };
    try { eq((await auto.runAutoAssign(IST(12, 11))).idle, 'error'); } finally { db.query = keep; }
    eq(global.__autoAssignBusy, false);
  });
  await t('the minute cron starts it, not awaited, and again 30 seconds later', () => {
    const src = fs.readFileSync(path.join(SRC, 'app/api/cron/chat-email-poll/route.ts'), 'utf8');
    ok(/void runLateEscalation\(\)\.then\(\(\) => runAutoAssign\(\)\)\.catch/.test(src) && /setTimeout\(\(\) => \{ void runAutoAssign\(\)/.test(src), 'the 30-minute move first, then the queue');
  });

  console.log(`AUTO-ASSIGN: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
function ok(v, m) { assert.ok(v, m); }
