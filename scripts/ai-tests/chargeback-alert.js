// The chargeback WhatsApp through the shared "shiptrack_alert" template (owner 2026-10-14: "chargeback pa msg bhejna ka
// lia kah rha ha setup nai ha, kar aur template banala"): the REAL alert-send.ts / notify.ts with fake WhatsApp modules,
// the REAL /api/panel-chargeback test action on a fake database, and the card's wiring.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, jsx: 'react-jsx' }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, ok = assert.ok;

const S = { templates: [], sent: [], listCalls: 0, sendFail: null, number: '9876543210' };
const fakes = {
  '@/lib/chat/whatsapp': {
    waConfigured: () => !!(process.env.WHATSAPP_CLOUD_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
    sendWhatsAppTemplate: async (to, name, lang, params) => { S.sent.push({ to, name, lang, params }); return S.sendFail ? { ok: false, error: S.sendFail, code: 131026 } : { ok: true, id: 'wamid.1' }; },
  },
  '@/lib/chat/whatsapp-templates': { listTemplates: async () => { S.listCalls++; return S.listError ? { ok: false, error: S.listError } : { ok: true, value: S.templates }; } },
  '@/lib/chat/whatsapp-settings': { templatesAccount: async () => 'MSG1' },
  '@/lib/auth': { getAuthFromRequest: () => S.user },
  '@/lib/db': {
    query: async () => ({ rows: [] }),
    queryOne: async (sql) => (/FROM businesses/.test(sql) ? { name: 'VASTRIKA' } : null),
  },
  '@/lib/chargeback/store': { panelChargeback: async () => ({ installed: true, mailbox: null, whatsapp: S.number, gateways: {} }), savePanelSettings: async () => ({ ok: true }) },
  '@/lib/chat/mailbox-check': { checkMailbox: async () => ({}), looksLikeEmail: () => true, normalizeAppPassword: (s) => s },
};
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const N = require(path.join(SRC, 'lib/chargeback/notify.ts'));
const A = require(path.join(SRC, 'lib/chargeback/alert-send.ts'));
const route = require(path.join(SRC, 'app/api/panel-chargeback/route.ts'));
const { NextRequest } = require('next/server');
const req = (method, url, body) => new NextRequest('http://x' + url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });

let pass = 0, fail = 0;
async function t(name, fn) {
  S.templates = []; S.sent = []; S.sendFail = null; S.listError = null; S.number = '9876543210'; S.user = { role: 'admin', username: 'owner' };
  process.env.WHATSAPP_CLOUD_TOKEN = 'TOKEN'; process.env.WHATSAPP_PHONE_NUMBER_ID = '555'; delete process.env.WHATSAPP_CHARGEBACK_TEMPLATE;
  const err = console.error; console.error = () => {};
  try { await fn(); console.error = err; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = err; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')); }
}
const approved = { name: 'shiptrack_alert', language: 'en_US', status: 'APPROVED' };

(async () => {
  console.log('chargeback-alert: the chargeback WhatsApp through "shiptrack_alert"');

  await t('the text: panel, gateway, order only, one line, no customer data', () => {
    eq(N.chargebackAlertText({ panel: 'VASTRIKA', gateway: 'PayU', order: '#1091' }),
      'CHARGEBACK mail on VASTRIKA (gateway: PayU, order #1091). Open Chargebacks in ShipTrack and answer the gateway before its deadline.');
    ok(/order not found in the mail/.test(N.chargebackAlertText({ panel: 'kurtiya', gateway: 'PayGlocal', order: 'not found' })));
    ok(!/\n/.test(N.chargebackAlertText({ panel: 'a\nb', gateway: 'g\tx', order: '1' })));
  });

  await t('no own template + shiptrack_alert APPROVED = sent as {{1}}; the setup says ready', async () => {
    S.templates = [{ name: 'order_placed', language: 'en_US', status: 'APPROVED' }, approved];
    const setup = await A.chargebackWhatsAppSetup(true);
    eq(setup.ready, true); eq(setup.template.status, 'APPROVED'); eq(setup.envTemplate, false);
    eq(await A.notifyChargeback('919876543210', { panel: 'VASTRIKA', gateway: 'PayU', order: '#1091' }), 'sent');
    eq(S.sent.length, 1); eq(S.sent[0].name, 'shiptrack_alert'); eq(S.sent[0].lang, 'en_US');
    ok(/CHARGEBACK mail on VASTRIKA/.test(S.sent[0].params[0]) && S.sent[0].params.length === 1);
  });

  await t('template missing / pending / rejected = not sent, the card is told which; Meta unreadable = its words', async () => {
    let s = await A.chargebackWhatsAppSetup(true); eq(s.ready, false); eq(s.template, null); eq(s.token, true);
    eq(await A.notifyChargeback('919876543210', { panel: 'p', gateway: 'g', order: 'o' }), 'not_configured'); eq(S.sent.length, 0);
    S.templates = [{ ...approved, status: 'PENDING' }]; s = await A.chargebackWhatsAppSetup(true); eq(s.ready, false); eq(s.template.status, 'PENDING');
    S.templates = [{ ...approved, status: 'REJECTED' }]; s = await A.chargebackWhatsAppSetup(true); eq(s.template.status, 'REJECTED');
    S.listError = 'Meta said no'; s = await A.chargebackWhatsAppSetup(true); eq(s.error, 'Meta said no'); eq(s.ready, false);
  });

  await t('no token on the server = not set up, Meta never asked; an own .env template still wins (old path)', async () => {
    delete process.env.WHATSAPP_CLOUD_TOKEN; const calls = S.listCalls;
    const s = await A.chargebackWhatsAppSetup(true); eq(s.token, false); eq(s.ready, false); eq(S.listCalls, calls);
    eq(await A.notifyChargeback('919876543210', { panel: 'p', gateway: 'g', order: 'o' }), 'not_configured');
    process.env.WHATSAPP_CLOUD_TOKEN = 'TOKEN'; process.env.WHATSAPP_CHARGEBACK_TEMPLATE = 'chargeback_alert';
    eq((await A.chargebackWhatsAppSetup(true)).envTemplate, true);
  });

  await t('a refused send is recorded in words on the alert', async () => {
    S.templates = [approved]; await A.chargebackWhatsAppSetup(true); S.sendFail = 'Number not on WhatsApp';
    eq(await A.notifyChargeback('919876543210', { panel: 'p', gateway: 'g', order: 'o' }), 'failed: Number not on WhatsApp');
  });

  await t('route: "Send a test" goes to the saved number the real way; no number = 400; not ready = 409; Super Admin only', async () => {
    S.templates = [approved]; await A.chargebackWhatsAppSetup(true);
    let r = await route.PATCH(req('PATCH', '/api/panel-chargeback', { businessId: 'bizVastrika1', action: 'test' }));
    eq(r.status, 200); eq(S.sent[0].to, '919876543210'); ok(/TEST/.test(S.sent[0].params[0]) && /VASTRIKA/.test(S.sent[0].params[0]));
    S.number = ''; r = await route.PATCH(req('PATCH', '/api/panel-chargeback', { businessId: 'bizVastrika1', action: 'test' })); eq(r.status, 400);
    S.number = '9876543210'; S.templates = [{ ...approved, status: 'PENDING' }]; await A.chargebackWhatsAppSetup(true);
    r = await route.PATCH(req('PATCH', '/api/panel-chargeback', { businessId: 'bizVastrika1', action: 'test' })); eq(r.status, 409);
    S.user = { role: 'manager', username: 'sunny' };
    r = await route.PATCH(req('PATCH', '/api/panel-chargeback', { businessId: 'bizVastrika1', action: 'test' })); eq(r.status, 401);
    S.user = { role: 'admin', username: 'owner' }; S.templates = [approved]; await A.chargebackWhatsAppSetup(true);
    const g = await (await route.GET(req('GET', '/api/panel-chargeback?businessId=bizVastrika1&fresh=1'))).json();
    eq(g.whatsappReady, true); eq(g.whatsappSetup.template.name, 'shiptrack_alert');
  });

  await t('several numbers (owner 14 Oct: "1 hi number dal sakta h"): up to 5 with commas, each cleaned, the same once; the test goes to every one', async () => {
    const P = require(path.join(SRC, 'lib/chargeback/parse.ts'));
    assert.deepStrictEqual(P.whatsappNumbers('98765 43210, +91 98123-45678;9876543210\n919999988888'), { numbers: ['919876543210', '919812345678', '919999988888'], bad: [] });
    assert.deepStrictEqual(P.whatsappNumbers('9876543210, 12'), { numbers: ['919876543210'], bad: ['12'] });
    assert.deepStrictEqual(P.whatsappNumbers(''), { numbers: [], bad: [] });
    eq(P.WHATSAPP_NUMBERS_MAX, 5);
    S.templates = [approved]; await A.chargebackWhatsAppSetup(true); S.number = '919911512751, 9876543210';
    const r = await route.PATCH(req('PATCH', '/api/panel-chargeback', { businessId: 'bizVastrika1', action: 'test' }));
    eq(r.status, 200); assert.deepStrictEqual(S.sent.map((x) => x.to), ['919911512751', '919876543210']);
    const store = fs.readFileSync(path.join(SRC, 'lib/chargeback/store.ts'), 'utf8');
    ok(/whatsapp = numbers\.join\(', '\)/.test(store) && /At most \$\{WHATSAPP_NUMBERS_MAX\} numbers/.test(store));
  });

  await t('wiring: the poller sends through alert-send; the card creates the template from the preset and offers a test', () => {
    const poll = fs.readFileSync(path.join(SRC, 'lib/chargeback/poll.ts'), 'utf8');
    ok(/for \(const n of to\) results\.push\(await notifyChargeback\(n,/.test(poll) && /from '\.\/alert-send'/.test(poll) && /whatsappNumbers\(s\?\.whatsapp_number/.test(poll));
    const card = fs.readFileSync(path.join(SRC, 'components/ChargebackSettingsCard.tsx'), 'utf8');
    ok(/SHIPTRACK_ALERT_PRESET/.test(card) && /\/api\/whatsapp\/templates/.test(card) && /Create the alert template/.test(card) && /action: 'test'/.test(card) && /Send a test/.test(card));
  });

  console.log(`chargeback-alert: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
