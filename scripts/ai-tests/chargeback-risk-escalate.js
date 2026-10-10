// Chargeback Shield step 2 (owner 2026-10-10): the REAL risk-escalate.ts (+ risk-rules.ts, team-rules.ts, office-hours.ts,
// permissions.ts) with a fake risk list, a fake database, fake team routing and a fake WhatsApp. A Critical chat goes to the
// Manager (office hours), never twice, never from the Manager / Super Admin; one WhatsApp per order to every alert number.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, ok = assert.ok, deq = assert.deepStrictEqual;

const MON_1130 = Date.parse('2026-10-12T06:00:00Z');   // Monday 11:30 IST: office open
const SUN_1130 = Date.parse('2026-10-11T06:00:00Z');   // Sunday: office closed, alerts still go (09-22 IST)
const MON_0500 = Date.parse('2026-10-11T23:30:00Z');   // Monday 05:00 IST: no alerts
const S = {};
const item = (o) => ({ orderId: '#4411', businessId: 'bizA', panelName: 'VASTRIKA', customerName: 'Priya', score: 92, level: 'critical', chatId: 'c1',
  signals: [{ key: 'threat_chargeback', points: 45, text: 'Talked about a chargeback / bank dispute (2 messages)' }, { key: 'late', points: 30, text: '6 days past the delivery date' }],
  action: { key: 'refund', text: 'Chargeback risk: offer the refund (mark Refund, send the form) before they go to the bank.' }, ...o });
function reset() {
  Object.assign(S, {
    items: [item(), item({ orderId: '#1610', chatId: 'c2', level: 'high', score: 55 })],
    chats: { c1: { id: 'c1', site_id: 's1', status: 'agent_handling', case_kind: null, assigned_to: 'u1', panel: 'bizA', verified_order_id: '#4411', phone_match_order_id: null, merged_into: null } },
    events: [], priorEvent: false, updates: [], settings: {}, sends: [], owner: '919000000001', extra: ['919000000002', '919000000001'],
    templates: [{ name: 'shiptrack_alert', language: 'en_US', status: 'APPROVED' }], manager: 'mgr', loaded: true,
  });
  delete global.__riskEscBusy; delete global.__riskEscAt;
}
reset();
const client = {
  query: async (sql, p = []) => {
    if (/FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = \$1 FOR NO KEY UPDATE OF c/.test(sql)) { const c = S.chats[p[0]]; return { rows: c ? [{ ...c }] : [] }; }
    if (/FROM chat_events WHERE conversation_id = \$1 AND reason = \$2/.test(sql)) { eq(p[1], 'chargeback_risk'); return { rows: S.priorEvent ? [{ x: 1 }] : [] }; }
    if (/UPDATE conversations SET assigned_to = \$3::text/.test(sql)) {
      ok(/assigned_to IS NOT DISTINCT FROM \$2::text/.test(sql), 'moved only if the holder is still the same');
      const c = S.chats[p[0]];
      if (!c || c.assigned_to !== p[1]) return { rows: [] };
      S.updates.push({ id: p[0], to: p[2], status: p[3] }); c.assigned_to = p[2]; c.status = p[3];
      return { rows: [{ id: p[0] }] };
    }
    throw new Error('unexpected client SQL: ' + sql.slice(0, 100));
  },
};
const db = {
  withTransaction: async (fn) => fn(client),
  query: async () => ({ rows: [] }),
  queryOne: async (sql, p) => {
    if (/INSERT INTO chat_settings .* ON CONFLICT \(key\) DO NOTHING RETURNING key/s.test(sql)) {
      if (S.settings[p[0]]) return null;
      S.settings[p[0]] = p[1]; return { key: p[0] };
    }
    throw new Error('unexpected SQL: ' + sql.slice(0, 100));
  },
};
const fakes = {
  '@/lib/db': db,
  '@/lib/auth': { teamLoaded: () => S.loaded, teamEntries: () => [{ id: 'u1', role: 'agent', permissions: null, active: true }, { id: 'mgr', role: 'manager', permissions: null, active: true }] },
  '@/lib/chat/holidays': { loadHolidays: async () => [] },
  '@/lib/chat/team-routing': {
    isKnownCustomer: (c) => !!(c.verified_order_id || c.phone_match_order_id),
    logChatEvent: async (_c, who, ev) => { S.events.push({ who, ...ev }); return true; },
    nameOfKey: (k) => ({ u1: 'Rahul', mgr: 'Sunny', owner: 'Super Admin' }[k] || null),
    pickManager: async () => S.manager,
    setSystemActor: async () => {},
  },
  '@/lib/chat/whatsapp': { waConfigured: () => true, sendWhatsAppTemplate: async (to, name, lang, params) => { S.sends.push({ to, name, params }); return { ok: true, id: 'w' }; } },
  '@/lib/chat/whatsapp-templates': { listTemplates: async () => ({ ok: true, value: S.templates }) },
  '@/lib/chat/whatsapp-settings': { alertTo: async () => S.owner, extraAlertTo: async () => S.extra, templatesAccount: async () => '1' },
  './risk': { loadRiskList: async () => ({ items: S.items, counts: {}, scanned: 9, at: '' }) },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (fakes[request]) return request;
  if (request.startsWith('@/')) return origResolve.call(this, path.join(SRC, request.slice(2)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) { if (fakes[request]) return fakes[request]; return origLoad.call(this, request, parent, ...rest); };
const E = require(path.join(SRC, 'lib/chargeback/risk-escalate.ts'));
const R = require(path.join(SRC, 'lib/chargeback/risk-rules.ts'));
const PB = require(path.join(SRC, 'lib/panel-board.ts'));

let pass = 0, fail = 0;
async function t(name, fn) {
  reset();
  const err = console.error, log = console.log; console.error = () => {}; console.log = () => {};
  try { await fn(); console.error = err; console.log = log; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = err; console.log = log; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 8).join('\n       ')); }
}

(async () => {
  console.log('chargeback-risk-escalate: Critical -> the Manager, the red bar, the WhatsApp');

  await t('a member\'s Critical chat goes to the Manager in office hours: Needs you, one chargeback_risk transfer event with the order and reasons', async () => {
    const r = await E.runRiskEscalation(MON_1130, true);
    eq(r.critical, 1, 'only Critical (High stays on the list)'); eq(r.moved, 1);
    deq(S.updates, [{ id: 'c1', to: 'mgr', status: 'human_needed' }]);
    eq(S.events.length, 1); const ev = S.events[0];
    eq(ev.who, 'system'); eq(ev.kind, 'transfer'); eq(ev.reason, 'chargeback_risk'); eq(ev.fromOwner, 'u1'); eq(ev.toOwner, 'mgr');
    eq(ev.meta.order, '#4411'); eq(ev.meta.to_name, 'Sunny'); eq(ev.meta.from_name, 'Rahul'); eq(ev.meta.reasons.length, 2);
  });

  await t('never pulled twice, never from the Manager or the Super Admin, never a Closed / merged chat; a Refund chat keeps its status', async () => {
    S.priorEvent = true; eq((await E.runRiskEscalation(MON_1130, true)).moved, 0, 'moved for this reason in the last 7 days');
    reset(); S.chats.c1.assigned_to = 'mgr'; eq((await E.runRiskEscalation(MON_1130, true)).moved, 0, 'the Manager has it');
    reset(); S.chats.c1.assigned_to = 'owner'; eq((await E.runRiskEscalation(MON_1130, true)).moved, 0, 'the Super Admin has it');
    reset(); S.chats.c1.status = 'resolved'; eq((await E.runRiskEscalation(MON_1130, true)).moved, 0);
    reset(); S.chats.c1.merged_into = 'c0'; eq((await E.runRiskEscalation(MON_1130, true)).moved, 0);
    reset(); S.chats.c1.case_kind = 'refund'; S.chats.c1.assigned_to = null;
    eq((await E.runRiskEscalation(MON_1130, true)).moved, 1, 'nobody held it: it goes too');
    eq(S.updates[0].status, 'agent_handling', 'a Refund chat keeps its status');
  });

  await t('office closed (Sunday): nothing moves, the WhatsApp still goes (09:00-22:00 IST); 05:00 = no WhatsApp', async () => {
    const r = await E.runRiskEscalation(SUN_1130, true);
    eq(r.moved, 0); eq(r.alerted, 2);
    reset(); eq((await E.runRiskEscalation(MON_0500, true)).alerted, 0);
  });

  await t('WhatsApp: one alert per order ever, to the owner + the extra numbers (no duplicate), one line; none without an approved template', async () => {
    await E.runRiskEscalation(MON_1130, true);
    deq(S.sends.map((x) => x.to).sort(), ['919000000001', '919000000002']);
    eq(S.sends[0].name, 'shiptrack_alert');
    ok(!/[\n\t]/.test(S.sends[0].params[0]) && /#4411/.test(S.sends[0].params[0]) && /VASTRIKA/.test(S.sends[0].params[0]));
    S.sends = []; delete global.__riskEscAt;
    await E.runRiskEscalation(MON_1130 + 6 * 60_000, true);
    eq(S.sends.length, 0, 'claimed: never twice');
    reset(); S.templates = [{ name: 'shiptrack_alert', language: 'en_US', status: 'PENDING' }];
    eq((await E.runRiskEscalation(MON_1130, true)).alerted, 0);
  });

  await t('runs at most every 5 minutes per process, not before the team list is read', async () => {
    await E.runRiskEscalation(MON_1130);
    eq((await E.runRiskEscalation(MON_1130 + 60_000)).idle, 'soon');
    reset(); S.loaded = false; eq((await E.runRiskEscalation(MON_1130)).idle, 'starting');
  });

  await t('rules: the alert line and its hours; the Today routine gets the Critical step only for logins who may see it', () => {
    const line = R.riskAlertText({ ...item(), action: { key: 'refund', text: 'a\nb\tc' } });
    ok(/^Chargeback risk CRITICAL \(92\): order #4411 on VASTRIKA, Priya\./.test(line) && !/[\n\t]/.test(line) && line.length <= 600);
    eq(R.alertHourOk(Date.parse('2026-10-12T03:29:00Z')), false); eq(R.alertHourOk(Date.parse('2026-10-12T03:31:00Z')), true);
    eq(R.alertHourOk(Date.parse('2026-10-12T16:29:00Z')), true); eq(R.alertHourOk(Date.parse('2026-10-12T16:31:00Z')), false);
    const tot = { panels: 1, needsYou: 0, overdue: 0, chargebacks: 0, refundRequests: 0, reshipToShip: 0, refundCases: 0, lateOrders: 0, gmailErrors: 0, setupGaps: 0, chatsToday: 0, chikkiToday: 0, waiting: 0 };
    const step = PB.morningRoutine(tot, false, null, false, 2).find((s) => /Critical chargeback risk/.test(s.text));
    eq(step.count, 2); eq(step.done, false); eq(step.go, 'chargebacks');
    ok(!PB.morningRoutine(tot).some((s) => /Critical chargeback risk/.test(s.text)));
  });

  await t('the red bar reads the chargeback_risk moves too (escalate-late.ts lateAlerts)', () => {
    const src = fs.readFileSync(path.join(SRC, 'lib/chat/escalate-late.ts'), 'utf8');
    ok(/e\.reason IN \('no_reply_30', 'chargeback_risk'\)/.test(src));
    ok(/kind: x\.reason === 'chargeback_risk' \? 'risk'/.test(src));
    ok(/runRiskEscalation\(\)/.test(fs.readFileSync(path.join(SRC, 'app/api/cron/chat-email-poll/route.ts'), 'utf8')), 'the minute cron runs it');
  });

  console.log(`\nchargeback-risk-escalate: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
