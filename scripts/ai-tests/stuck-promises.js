// Promises waiting 2+ days (owner 2026-10-14: "Refund aur Ship again ka vaada atak jaata hai ... iska kya solution";
// answer: ShipTrack + WhatsApp alert). The pure rules, loadStuck and the once-a-day WhatsApp on a fake database and a
// fake WhatsApp, the Today board lines, and the wiring. Customers are told nothing. Made-up panel ids.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const S = {};
function reset() {
  Object.assign(S, { sql: [], settings: new Map(), chats: [], requests: [], sent: [], holidays: [], numbers: ['919000000001'], extra: ['919000000002'],
    tpl: { name: 'shiptrack_alert', language: 'en_US', status: 'APPROVED' }, waOn: true, missing: false });
}
reset();
const fakes = {
  '@/lib/db': {
    query: async (sql, p = []) => {
      S.sql.push(sql);
      if (S.missing) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      if (/FROM conversations c JOIN sites s/.test(sql)) return { rows: S.chats };
      if (/FROM refund_requests/.test(sql)) return { rows: S.requests };
      if (/FROM businesses/.test(sql)) return { rows: [{ id: 'pA1', name: 'PanelOne' }, { id: 'pB2', name: 'PanelTwo' }].filter((b) => p[0].includes(b.id)) };
      throw new Error('fake: ' + sql.slice(0, 60));
    },
    queryOne: async (sql, p = []) => {
      if (/SELECT key FROM chat_settings WHERE key = \$1/.test(sql)) return S.settings.has(p[0]) ? { key: p[0] } : null;
      if (/INSERT INTO chat_settings .* ON CONFLICT \(key\) DO NOTHING RETURNING key/s.test(sql)) { if (S.settings.has(p[0])) return null; S.settings.set(p[0], p[1]); return { key: p[0] }; }
      throw new Error('fake one: ' + sql.slice(0, 60));
    },
  },
  '@/lib/chat/holidays': { loadHolidays: async () => S.holidays },
  '@/lib/chat/whatsapp': { waConfigured: () => S.waOn, sendWhatsAppTemplate: async (to, name, lang, params) => { S.sent.push({ to, name, params }); return { ok: true }; } },
  '@/lib/chat/whatsapp-templates': { listTemplates: async () => ({ ok: true, value: S.tpl ? [S.tpl] : [] }) },
  '@/lib/chat/whatsapp-settings': { alertTo: async () => S.numbers[0] || '', extraAlertTo: async () => S.extra, templatesAccount: async () => 'acct1' },
};
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const R = require(path.join(SRC, 'lib/refund/stuck-rules.ts'));
const St = require(path.join(SRC, 'lib/refund/stuck.ts'));
const B = require(path.join(SRC, 'lib/panel-board.ts'));

// India times: Wednesday 14 Oct 2026; 10:00 IST = 04:30 UTC
const IST = (d, hm) => Date.parse(`${d}T${hm}:00+05:30`);

let pass = 0, fail = 0;
async function t(name, fn) {
  reset();
  const err = console.error, log = console.log; console.error = () => {}; console.log = () => {};
  try { await fn(); console.error = err; console.log = log; pass++; log('  ok  ' + name); }
  catch (e) { console.error = err; console.log = log; fail++; log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')); }
}

(async () => {
  console.log('stuck-promises: Refund / Ship again promises waiting 2+ days');

  await t('rules: the words, one WhatsApp line (no breaks, at most 600 characters), nothing stuck = no text, the time window', () => {
    deq(R.stuckParts({ refundNoForm: 1, refundWaiting: 2, reshipNotSent: 3 }), ['3 Ship again parcels not sent', '1 refund form not sent', '2 refund requests not decided / paid']);
    eq(R.stuckAlertText([{ name: 'A', counts: R.emptyStuck() }]), null);
    const text = R.stuckAlertText([{ name: 'PanelOne', counts: { refundNoForm: 0, refundWaiting: 0, reshipNotSent: 1 } }, { name: 'Two\nLines', counts: R.emptyStuck() }]);
    eq(text, 'Promises waiting 2+ days. PanelOne: 1 Ship again parcel not sent. Please clear them today (ShipTrack > Today).');
    const long = R.stuckAlertText(Array.from({ length: 40 }, (_, i) => ({ name: `Panel number ${i}`, counts: { refundNoForm: 1, refundWaiting: 1, reshipNotSent: 1 } })));
    ok(long.length <= 600 && !/[\n\t]/.test(long) && !/ {2}/.test(long));
    eq(R.istDay(IST('2026-10-14', '23:59')), '2026-10-14');
    deq([R.alertTimeOk(IST('2026-10-14', '10:29')), R.alertTimeOk(IST('2026-10-14', '10:30')), R.alertTimeOk(IST('2026-10-14', '21:59')), R.alertTimeOk(IST('2026-10-14', '22:00'))], [false, true, true, false]);
  });

  await t('loadStuck: Refund chats with no form / request, Ship again not sent, requests New / Approved, all older than 2 days, open, never WhatsApp; per panel; scope passed; a missing table = 0', async () => {
    S.chats = [{ panel: 'pA1', no_form: '2', reship: '1' }];
    S.requests = [{ panel: 'pA1', n: '1' }, { panel: 'pB2', n: '3' }];
    const m = await St.loadStuck(['pA1', 'pB2']);
    deq(m, { pA1: { refundNoForm: 2, refundWaiting: 1, reshipNotSent: 1 }, pB2: { refundNoForm: 0, refundWaiting: 3, reshipNotSent: 0 } });
    const chatSql = S.sql.find((q) => /FROM conversations c JOIN sites s/.test(q));
    for (const must of ["c.case_marked_at < now() - interval '2 days'", "c.status <> 'resolved'", 'c.merged_into IS NULL', "c.source <> 'whatsapp'", 'c.reshipped_at IS NULL',
      'NOT EXISTS (SELECT 1 FROM refund_links l', 'NOT EXISTS (SELECT 1 FROM refund_requests q']) ok(chatSql.includes(must), must);
    ok(S.sql.some((q) => /status IN \('new', 'approved'\) AND status_at < now\(\) - interval '2 days'/.test(q)));
    S.missing = true;
    deq(await St.loadStuck(null), {});
  });

  await t('the WhatsApp: once a working day from 10:30, to the alert numbers, through the approved shiptrack_alert; claimed so two processes send once', async () => {
    S.chats = [{ panel: 'pA1', no_form: '0', reship: '2' }];
    eq(await St.runStuckAlert(IST('2026-10-14', '10:00')), 0, 'before 10:30 nothing');
    eq(S.sent.length, 0);
    eq(await St.runStuckAlert(IST('2026-10-14', '10:31')), 2, 'both numbers');
    deq(S.sent.map((x) => [x.to, x.name]), [['919000000001', 'shiptrack_alert'], ['919000000002', 'shiptrack_alert']]);
    ok(/PanelOne: 2 Ship again parcels not sent/.test(S.sent[0].params[0]));
    ok(S.settings.has('stuck_alert:2026-10-14'));
    eq(await St.runStuckAlert(IST('2026-10-14', '15:00')), 0, 'never twice a day');
    eq(S.sent.length, 2);
  });

  await t('the WhatsApp: nothing stuck, Sunday, a holiday, no numbers, template not approved or WhatsApp not set up = nothing sent and the day not claimed', async () => {
    eq(await St.runStuckAlert(IST('2026-10-14', '11:00')), 0, 'nothing stuck'); eq(S.settings.size, 0);
    S.chats = [{ panel: 'pA1', no_form: '1', reship: '0' }];
    eq(await St.runStuckAlert(IST('2026-10-18', '11:00')), 0, 'Sunday 18 Oct');
    S.holidays = ['2026-10-14']; eq(await St.runStuckAlert(IST('2026-10-14', '11:00')), 0, 'holiday'); S.holidays = [];
    S.numbers = []; S.extra = []; eq(await St.runStuckAlert(IST('2026-10-14', '11:00')), 0); S.numbers = ['919000000001'];
    S.tpl = { name: 'shiptrack_alert', language: 'en_US', status: 'PENDING' }; eq(await St.runStuckAlert(IST('2026-10-14', '11:00')), 0);
    S.tpl = { name: 'shiptrack_alert', language: 'en_US', status: 'APPROVED' }; S.waOn = false; eq(await St.runStuckAlert(IST('2026-10-14', '11:00')), 0);
    eq(S.sent.length, 0); eq(S.settings.size, 0, 'a later minute can still send');
    S.waOn = true; eq(await St.runStuckAlert(IST('2026-10-14', '11:00')), 1);
  });

  await t('Today board: red lines per panel, the panel moves up, the morning routine step; a login without refunds sees none', () => {
    const base = { id: 'pA1', name: 'PanelOne', needsYou: 0, waiting: 0, overdue: 0, emailWaiting: 0, refundCases: 0, reshipToShip: 0, chargebacksOpen: null, refundRequestsNew: null,
      chatsToday: 0, teamRepliesToday: 0, chikkiToday: 0, ordersToday: 0, lateOrders: 0, aiOn: true, hasPrompt: true, supportGmail: true, chargebackGmail: true, whatsapp: true,
      supportGmailStatus: 'ok', supportGmailError: null, chargebackGmailStatus: 'ok', chargebackGmailError: null };
    const stuck = { ...base, promisesStuck: { refundNoForm: 1, refundWaiting: 2, reshipNotSent: 1 } };
    const lines = B.panelNeeds(stuck).map((x) => [x.tone, x.text, x.go]);
    deq(lines.slice(0, 3), [
      ['danger', '1 Ship again parcel promised 2+ days ago, not sent yet', 'chats'],
      ['danger', '1 Refund chat 2+ days old with no refund form sent', 'chats'],
      ['danger', '2 refund requests waiting 2+ days to be decided / paid', 'refunds']]);
    ok(B.urgency(stuck) > B.urgency(base));
    eq(B.panelNeeds(base)[0].text, 'All clear: nothing waiting');
    const sum = B.summarize([stuck, { ...base, id: 'pB2' }]);
    eq(sum.promisesStuck, 4);
    const step = B.morningRoutine(sum).find((x) => /promise/.test(x.text));
    deq([step.count, step.done], [4, false]);
    eq(B.summarize([base]).promisesStuck, null);
    ok(!B.morningRoutine(B.summarize([base])).some((x) => /promise/.test(x.text)), 'not shown to a login that does not see refunds');
  });

  await t('wiring: the counts route ?stuck=1 (refunds rights), the minute cron, the Today board fetch, the Chat Support bar (Super Admin / Manager only)', () => {
    const route = read('app/api/refunds/counts/route.ts');
    ok(/canRefunds\(user\)/.test(route) && /sp\.get\('stuck'\) === '1'/.test(route) && /loadStuck\(panelScope\(user\)\)/.test(route));
    ok(/void runStuckAlert\(\)/.test(read('app/api/cron/chat-email-poll/route.ts')));
    ok(/\/api\/refunds\/counts\?byPanel=1&stuck=1/.test(read('components/PanelBoard.tsx')));
    const page = read('app/admin/chat/page.tsx');
    ok(/const seesStuck = !!user && canRefunds\(user\)/.test(page) && /\/api\/refunds\/counts\?stuck=1/.test(page) && /stuck=\{stuck\}/.test(page));
    ok(/Promises waiting 2\+ days:/.test(read('app/admin/chat/_components/TeamAlerts.tsx')));
    ok(!/sendWhatsAppText|messages \(/.test(read('lib/refund/stuck.ts')), 'nothing is ever sent to a customer');
  });

  console.log(`stuck-promises: ${pass} passed, ${fail} failed`);
  console.log(fail ? 'STUCK-PROMISES: FAILED' : `STUCK-PROMISES: ${pass} groups passed`);
  process.exit(fail ? 1 : 0);
})();
