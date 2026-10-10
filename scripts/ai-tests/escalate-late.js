// 30 minutes without a reply: the chat goes to the Manager (owner 2026-10-10, step 4). The REAL escalate-late.ts
// against a fake database and team. 12 Oct 2026 is a Monday (India).
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

const IST = (d, h, m = 0) => Date.UTC(2026, 9, d, h, m) - 330 * 60000;
const iso = (ms) => new Date(ms).toISOString();
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;
const S = {};
function reset() {
  Object.assign(S, {
    team: [
      { id: 'u-rahul', name: 'Rahul', active: true, role: 'agent', permissions: ['chat.view', 'chat.reply'], businessIds: null },
      { id: 'u-sunny', name: 'Sunny', active: true, role: 'manager', permissions: null, businessIds: null },
    ],
    convs: [], events: [], actors: [], manager: 'u-sunny', sqlSeen: null, alertsRows: [],
  });
}
reset();
const norm = (q) => q.replace(/\s+/g, ' ').trim();
const client = {
  query: async (raw, p = []) => {
    const q = norm(raw);
    if (/^SELECT set_config\('shiptrack\.actor'/.test(q)) { S.actors.push(p); return { rows: [] }; }
    if (/^UPDATE conversations SET assigned_to = \$3::text, assigned_at = now\(\), status = \$4/.test(q)) {
      const c = S.convs.find((x) => x.id === p[0] && x.assigned_to === p[1] && x.status !== 'resolved');
      if (!c) return { rows: [] };
      c.assigned_to = p[2]; c.status = p[3]; return { rows: [{ id: c.id }] };
    }
    throw new Error('fake client: ' + q.slice(0, 100));
  },
};
const db = {
  query: async (raw, p = []) => {
    const q = norm(raw);
    if (/WHERE x\.waiting_since IS NOT NULL AND x\.waited_from <= \$1::timestamptz/.test(q)) {
      S.sqlSeen = q;
      const cutoff = Date.parse(p[0]), opened = Date.parse(p[1]);
      const rows = S.convs.filter((c) => c.assigned_to && c.assigned_to !== 'owner' && c.status !== 'resolved' && !c.merged_into && !c.case_kind && c.waiting_since)
        .map((c) => ({ ...c, waited_from: iso(Math.max(Date.parse(c.waiting_since), Date.parse(c.assigned_at || 0), opened)) }))
        .filter((c) => Date.parse(c.waited_from) <= cutoff);
      return { rows };
    }
    if (/FROM chat_events e JOIN conversations c ON c\.id = e\.conversation_id/.test(q)) { S.alertArgs = p; return { rows: S.alertsRows }; }
    throw new Error('fake db: ' + q.slice(0, 100));
  },
  withTransaction: async (fn) => fn(client),
};
const fakes = {
  '@/lib/db': db,
  '@/lib/auth': { teamEntries: () => S.team.map((e) => ({ ...e })) },
  './holidays': { loadHolidays: async () => [] },
  './team-routing': {
    isKnownCustomer: (c) => !!(c.verified_order_id || c.phone_match_order_id),
    nameOfKey: (k) => (S.team.find((e) => e.id === k) || {}).name || null,
    pickManager: async () => S.manager,
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
const late = require(path.join(SRC, 'lib/chat/escalate-late.ts'));

const conv = (o) => { const c = { id: 'c' + (S.convs.length + 1), site_id: 'S1', panel: 'P1', status: 'human_needed', case_kind: null, assigned_to: 'u-rahul', assigned_at: iso(IST(12, 10, 0)), merged_into: null, verified_order_id: '#1', phone_match_order_id: null, waiting_since: iso(IST(12, 10, 20)), ...o }; S.convs.push(c); return c; };
const realLog = console.log; const realErr = console.error;
let pass = 0, fail = 0;
async function t(name, fn) {
  reset(); delete global.__lateBusy;
  console.log = () => {}; console.error = () => {};
  try { await fn(); console.log = realLog; console.error = realErr; pass++; console.log('  ok  ' + name); }
  catch (e) { console.log = realLog; console.error = realErr; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')); }
}

(async () => {
  console.log('escalate-late: 30 minutes without a reply');
  await t('a member\'s chat waiting 30+ min goes to the Manager (Needs you for a verified customer); 29 min, a replied chat, the Manager\'s own, Closed and Refund chats stay', async () => {
    const late30 = conv({});                                                        // waiting since 10:20
    const early = conv({ waiting_since: iso(IST(12, 10, 31)) });                   // 29 min at 11:00
    const replied = conv({ waiting_since: null });
    const sunnys = conv({ assigned_to: 'u-sunny' });
    const closed = conv({ status: 'resolved' });
    const refund = conv({ case_kind: 'refund' });
    const visitor = conv({ status: 'agent_handling', verified_order_id: null });
    const r = await late.runLateEscalation(IST(12, 11));
    eq(r.moved, 2);
    deq([late30.assigned_to, late30.status], ['u-sunny', 'human_needed']);
    deq([visitor.assigned_to, visitor.status], ['u-sunny', 'agent_handling'], 'a visitor never goes to Needs you');
    deq([early.assigned_to, replied.assigned_to, sunnys.assigned_to, closed.assigned_to, refund.assigned_to], ['u-rahul', 'u-rahul', 'u-sunny', 'u-rahul', 'u-rahul']);
    const e = S.events.find((x) => x.conversationId === late30.id);
    deq([e.who, e.kind, e.reason, e.fromOwner, e.toOwner, e.meta.from_name, e.meta.to_name, e.meta.waited_min], ['system', 'transfer', 'no_reply_30', 'u-rahul', 'u-sunny', 'Rahul', 'Sunny', 40]);
    ok(S.actors.every((p) => p[0] === 'system' && p[2] === 'no_reply_30'));
    ok(/c\.assigned_to <> 'owner'/.test(S.sqlSeen) && /c\.case_kind IS NULL/.test(S.sqlSeen), 'the Super Admin\'s and marked chats are never picked');
  });
  await t('the clock starts at the latest of the customer\'s message, the member getting the chat and 10:00 today; never outside office hours', async () => {
    const overnight = conv({ waiting_since: iso(IST(11, 21)) });                    // Sunday night message
    const fresh = conv({ assigned_at: iso(IST(12, 10, 45)) });                     // got it 15 min ago
    eq((await late.runLateEscalation(IST(12, 10, 20))).moved, 0, 'Monday 10:20: only 20 office minutes');
    eq((await late.runLateEscalation(IST(12, 11))).moved, 1);
    deq([overnight.assigned_to, fresh.assigned_to], ['u-sunny', 'u-rahul']);
    conv({ waiting_since: iso(IST(12, 18)) });
    eq((await late.runLateEscalation(IST(12, 20))).idle, 'office_closed');
    eq((await late.runLateEscalation(IST(11, 12))).idle, 'office_closed', 'Sunday');
  });
  await t('no Manager login: the chat goes to the Super Admin; a chat whose holder changed meanwhile is not moved', async () => {
    S.manager = 'owner';
    const a = conv({});
    eq((await late.runLateEscalation(IST(12, 11))).moved, 1);
    eq(a.assigned_to, 'owner'); eq(S.events[0].meta.to_name, 'Super Admin');
    S.manager = 'u-sunny';
    const b = conv({});
    const realQuery = client.query;
    client.query = async (raw, p) => { if (/^UPDATE/.test(norm(raw))) b.assigned_to = 'u-anurag'; return realQuery(raw, p); };   // someone took it
    try { eq((await late.runLateEscalation(IST(12, 11))).moved, 0); } finally { client.query = realQuery; }
    eq(b.assigned_to, 'u-anurag');
  });
  await t('the red bar: the last 2 hours of these moves in the login\'s panels, with who had it, who got it and how long', async () => {
    S.alertsRows = [{ id: '7', conversation_id: 'c9', at: new Date(IST(12, 11)), meta: { from_name: 'Rahul', to_name: 'Sunny', waited_min: 34 }, customer: 'Asmita' }];
    deq(await late.lateAlerts(['P1']), [{ id: '7', conversation_id: 'c9', at: iso(IST(12, 11)), from_name: 'Rahul', to_name: 'Sunny', waited_min: 34, customer: 'Asmita' }]);
    deq(S.alertArgs, [['P1']]);
    db.query = (q => async (raw, p) => { throw Object.assign(new Error('x'), { code: '42P01' }); })(db.query);
    deq(await late.lateAlerts(null), [], 'a failure is no bar, never an error');
  });
  await t('the minute cron runs it before handing out the queue; the list route returns the alerts', () => {
    const cron = fs.readFileSync(path.join(SRC, 'app/api/cron/chat-email-poll/route.ts'), 'utf8');
    ok(/runLateEscalation\(\)\.then\(\(\) => runAutoAssign\(\)\)/.test(cron));
    const list = fs.readFileSync(path.join(SRC, 'app/api/chat/conversations/route.ts'), 'utf8');
    ok(/const alerts = await lateAlerts\(panelScope\(user\)\);/.test(list) && /alerts,/.test(list));
  });

  console.log(`ESCALATE-LATE: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
