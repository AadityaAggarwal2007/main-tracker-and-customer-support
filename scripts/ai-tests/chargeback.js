// Chargeback protection (owner 2026-10-08): the REAL parse / notify / store / poll modules and the REAL routes
// against a fake Gmail (IMAP), a fake database, a fake WhatsApp (fetch). Nothing here touches a real mailbox,
// database or WhatsApp.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

const mail = (id, from, subject, body) => `From: ${from}\r\nTo: cb@store.example\r\nSubject: ${subject}\r\nMessage-ID: <${id}@gw.example>\r\nDate: Thu, 08 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
const S = {};
function reset() {
  Object.assign(S, {
    boxes: [{ id: 'mb1', business_id: 'bizVast', email: 'cb.vastora@gmail.com', app_password: 'SECRETSECRETSECR', last_uid: 5, panel_name: 'vastora' }],
    msgs: [
      { uid: 5, source: mail('old', 'alerts@razorpay.com', 'Old dispute', 'order #1553 old') },
      { uid: 6, source: mail('m6', 'Razorpay <disputes@razorpay.com>', 'Chargeback raised on payment pay_Abc', 'A chargeback was raised. Order ID: 1553. Amount INR 1,499. Respond within 5 days.') },
      { uid: 7, source: mail('m7', 'noreply@payu.in', 'Dispute notice', 'Order #7000 disputed.') },
      { uid: 8, source: mail('m8', 'cb.vastora@gmail.com', 'self', 'order #1553') },
    ],
    orders: [{ order_id: '#1553', panel: 'bizVast' }, { order_id: '#7000', panel: 'bizKurt' }],
    alerts: [], convUpdates: [], notified: [], waNumber: '9876543210', lastUid: null, imapFail: false, connects: 0, closes: 0, logouts: 0,
    wa: 'sent', missing: false, mailboxRows: [], settings: null,
  });
}
reset();
const gone = () => Object.assign(new Error('relation does not exist'), { code: '42P01' });
const db = {
  query: async (sql, p) => {
    if (S.missing && /chargeback_|panel_chargeback/.test(sql)) throw gone();
    if (/FROM chargeback_mailboxes m/.test(sql)) return { rows: S.boxes, rowCount: S.boxes.length };
    if (/UPDATE conversations c SET status = 'human_needed'/.test(sql)) { S.convUpdates.push(p); return { rows: [], rowCount: 1 }; }
    if (/UPDATE chargeback_mailboxes SET last_uid/.test(sql)) { S.lastUid = p[0]; return { rows: [], rowCount: 1 }; }
    if (/UPDATE chargeback_alerts SET notify_status/.test(sql)) { S.alerts.find((a) => a.id === p[0]).notify_status = p[1]; return { rows: [], rowCount: 1 }; }
    if (/DELETE FROM chargeback_mailboxes/.test(sql)) return { rows: [], rowCount: S.boxes.length ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  },
  queryOne: async (sql, p) => {
    if (S.missing && /chargeback_|panel_chargeback/.test(sql)) throw gone();
    if (/FROM orders WHERE business_id/.test(sql)) { const o = S.orders.find((x) => x.panel === p[0] && p[1].includes(x.order_id)); return o ? { order_id: o.order_id } : null; }
    if (/INSERT INTO chargeback_alerts/.test(sql)) {
      if (S.alerts.some((a) => a.mailbox === p[1] && a.uid === p[2])) return null;
      const a = { id: 'al' + (S.alerts.length + 1), business_id: p[0], mailbox: p[1], uid: p[2], from_address: p[4], subject: p[6], snippet: p[7], gateway: p[8], order_id: p[9], notify_status: 'pending' };
      S.alerts.push(a); return { id: a.id };
    }
    if (/SELECT whatsapp_number FROM panel_chargeback/.test(sql)) return S.waNumber == null ? null : { whatsapp_number: S.waNumber };
    if (/FROM chargeback_mailboxes WHERE business_id/.test(sql)) return S.boxes[0] ? { id: S.boxes[0].id, email: S.boxes[0].email, created_at: '2026-10-08' } : null;
    if (/SELECT whatsapp_number, gateways FROM panel_chargeback/.test(sql)) return S.settings;
    if (/SELECT id FROM businesses/.test(sql)) return p[0] === 'bizVast' ? { id: 'bizVast' } : null;
    if (/count\(\*\) FROM site_emails/.test(sql)) return { n: S.emailUsed ? 1 : 0 };
    if (/INSERT INTO chargeback_mailboxes/.test(sql)) return { id: 'mb9', email: p[1], created_at: '2026-10-08' };
    return null;
  },
  getPool: () => ({}),
};
const authState = { user: { role: 'admin', username: 'owner', displayName: 'Super Admin' } };
const STUBS = {
  'lib/db.ts': db,
  'lib/auth.ts': { getAuthFromRequest: () => authState.user },
  'lib/chat/mailbox-check.ts': { checkMailbox: async () => ({ lastUid: 42 }), looksLikeEmail: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), normalizeAppPassword: (v) => v.replace(/\s+/g, '') },
};
const PKG_STUBS = {
  imapflow: { ImapFlow: class {
    constructor() { S.connects++; }
    async connect() { if (S.imapFail) throw new Error('Invalid credentials'); }
    async getMailboxLock() { return { release() {} }; }
    async search() { return S.msgs.map((_, i) => i + 1); }
    fetch() { const l = S.msgs; return (async function* () { for (const m of l) yield { uid: m.uid, source: Buffer.from(m.source) }; })(); }
    async logout() { S.logouts++; }
    close() { S.closes++; }
  } },
};
const origLoad = Module._load, origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) { if (request.startsWith('@/')) request = path.join(SRC, request.slice(2)); return origResolve.call(this, request, parent, ...rest); };
Module._load = function (request, parent, isMain) {
  if (PKG_STUBS[request]) return PKG_STUBS[request];
  let file = null; try { file = Module._resolveFilename(request, parent); } catch { /* a package */ }
  if (file && file.startsWith(SRC)) { const rel = path.relative(SRC, file); if (STUBS[rel]) return STUBS[rel]; }
  return origLoad.call(this, request, parent, isMain);
};

const parse = require(path.join(SRC, 'lib/chargeback/parse.ts'));
const notify = require(path.join(SRC, 'lib/chargeback/notify.ts'));
const store = require(path.join(SRC, 'lib/chargeback/store.ts'));
const mstat = require(path.join(SRC, 'lib/chat/mailbox-status.ts'));
let envWa = { WHATSAPP_CLOUD_TOKEN: 'TOKENTOKEN', WHATSAPP_PHONE_NUMBER_ID: '555', WHATSAPP_CHARGEBACK_TEMPLATE: 'chargeback_alert' };
// the poller reads process.env through notify: set it for the run
Object.assign(process.env, envWa);
const realFetch = global.fetch;
global.fetch = async (url, opt) => { S.notified.push({ url, opt }); return { ok: S.wa === 'sent', status: S.wa === 'sent' ? 200 : 401 }; };
const poll = require(path.join(SRC, 'lib/chargeback/poll.ts'));
const { NextRequest } = require('next/server');
const routeCb = require(path.join(SRC, 'app/api/chargebacks/route.ts'));
const routePanel = require(path.join(SRC, 'app/api/panel-chargeback/route.ts'));
const req = (method, url, body) => new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

let n = 0;
const t = async (name, fn) => { reset(); S.wa = 'sent'; authState.user = { role: 'admin', username: 'owner', displayName: 'Super Admin' }; await fn(); n++; console.log('  ok  ' + name); };

(async () => {
  await t('parse: the gateway is read from the sender first, then the text; unknown stays Unknown', () => {
    assert.strictEqual(parse.gatewayOf('disputes@razorpay.com', '', 'x', ''), 'Razorpay');
    assert.strictEqual(parse.gatewayOf('noreply@payu.in', 'PayU Disputes', 'x', ''), 'PayU');
    assert.strictEqual(parse.gatewayOf('a@b.com', '', 'Cashfree dispute', ''), 'Cashfree');
    assert.strictEqual(parse.gatewayOf('a@b.com', '', 'Hello', 'nothing'), 'Unknown');
  });
  await t('parse: order numbers in several shapes; only digits; bounded; forms with and without #', () => {
    assert.deepStrictEqual(parse.orderCandidates('Dispute for Order #1553', 'Order ID: 1553, pay_X'), ['1553']);
    assert.deepStrictEqual(parse.orderCandidates('x', 'order no 2210 and order #3301 and #99'), ['3301', '2210']);
    assert.deepStrictEqual(parse.orderCandidates('Hello', 'amount 1,499 paid on 08/10'), []);
    assert.deepStrictEqual(parse.orderForms(['1553']), ['#1553', '1553']);
    assert.ok(parse.orderCandidates('x', '#1 #2 #3 #1000 #1001 #1002 #1003 #1004 #1005').length <= 6);
  });
  await t('parse: WhatsApp numbers; HTML to text; short text', () => {
    assert.strictEqual(parse.whatsappNumber('98765 43210'), '919876543210'); assert.strictEqual(parse.whatsappNumber('+91 98765-43210'), '919876543210');
    assert.strictEqual(parse.whatsappNumber('12345'), null); assert.strictEqual(parse.whatsappNumber(''), null);
    assert.strictEqual(parse.htmlToText('<style>x{}</style><p>Hello&nbsp;<b>team</b></p><script>bad()</script>'), 'Hello team');
    assert.ok(parse.shortText('a '.repeat(1000)).length <= 700);
  });
  await t('notify: not set up = nothing sent; set up = one template message with only panel / gateway / order, token only in the header; failures are words, never thrown', async () => {
    assert.strictEqual(await notify.sendChargebackWhatsApp('919876543210', { panel: 'p', gateway: 'g', order: 'o' }, {}), 'not_configured');
    assert.strictEqual(S.notified.length, 0);
    const calls = [];
    const ok = await notify.sendChargebackWhatsApp('919876543210', { panel: 'vastora', gateway: 'Razorpay', order: '#1553' }, envWa, async (u, o) => { calls.push([u, o]); return { ok: true, status: 200 }; });
    assert.strictEqual(ok, 'sent'); const [u, o] = calls[0]; const b = JSON.parse(o.body);
    assert.ok(u.includes('/555/messages') && o.headers.Authorization === 'Bearer TOKENTOKEN' && !/TOKENTOKEN/.test(o.body));
    assert.strictEqual(b.type, 'template'); assert.strictEqual(b.template.name, 'chargeback_alert');
    assert.deepStrictEqual(b.template.components[0].parameters.map((x) => x.text), ['vastora', 'Razorpay', '#1553']);
    assert.ok(/failed: WhatsApp answered 401/.test(await notify.sendChargebackWhatsApp('9198', { panel: 'p', gateway: 'g', order: 'o' }, envWa, async () => ({ ok: false, status: 401 }))));
    assert.ok(/failed: could not reach/.test(await notify.sendChargebackWhatsApp('9198', { panel: 'p', gateway: 'g', order: 'o' }, envWa, async () => { throw new Error('boom TOKENTOKEN'); })));
  });

  await t('poll: only mail NEWER than last_uid becomes an alert; our own mail is skipped; the order is matched inside THIS panel only; last_uid moves on', async () => {
    const r = await poll.pollChargebackMailboxes();
    assert.deepStrictEqual(r, { boxes: 1, alerts: 2 });
    assert.deepStrictEqual(S.alerts.map((a) => [a.uid, a.gateway, a.order_id]), [[6, 'Razorpay', '#1553'], [7, 'PayU', null]], 'kurtiya\'s #7000 does not match in vastora');
    assert.strictEqual(S.lastUid, 8);
    assert.strictEqual(S.logouts + S.closes >= 1, true);
  });
  await t('poll: the matched customer\'s chat goes from AI to Needs you (that panel + order only); an unmatched alert moves no chat', async () => {
    await poll.pollChargebackMailboxes();
    assert.strictEqual(S.convUpdates.length, 1); assert.deepStrictEqual(S.convUpdates[0], ['bizVast', '#1553']);
  });
  await t('poll: the WhatsApp message goes once per NEW alert with panel / gateway / order; no number or no setup is recorded on the alert, never an error', async () => {
    await poll.pollChargebackMailboxes();
    assert.strictEqual(S.notified.length, 2);
    const first = JSON.parse(S.notified[0].opt.body); assert.strictEqual(first.to, '919876543210');
    assert.deepStrictEqual(first.template.components[0].parameters.map((x) => x.text), ['vastora', 'Razorpay', '#1553']);
    assert.deepStrictEqual(S.alerts.map((a) => a.notify_status), ['sent', 'sent']);
    S.notified.length = 0; await poll.pollChargebackMailboxes(); assert.strictEqual(S.notified.length, 0, 'the same mail is never alerted twice');
    reset(); S.waNumber = null; await poll.pollChargebackMailboxes(); assert.deepStrictEqual(S.alerts.map((a) => a.notify_status), ['no_number', 'no_number']);
    reset(); S.wa = 'fail'; await poll.pollChargebackMailboxes(); assert.ok(S.alerts.every((a) => /^failed: WhatsApp answered 401/.test(a.notify_status)));
    reset(); delete process.env.WHATSAPP_CLOUD_TOKEN; await poll.pollChargebackMailboxes(); assert.ok(S.alerts.every((a) => a.notify_status === 'not_configured')); process.env.WHATSAPP_CLOUD_TOKEN = 'TOKENTOKEN';
  });
  await t('poll: a Gmail that will not sign in is noted as an error in plain words and does not stop the sweep; the SQL not installed is a quiet no-op', async () => {
    S.imapFail = true; S.boxes.push({ ...S.boxes[0], id: 'mb2', email: 'two@gmail.com' });
    const r = await poll.pollChargebackMailboxes(); assert.strictEqual(r.alerts, 0); assert.strictEqual(S.connects, 2, 'both boxes were tried');
    const st = mstat.getMailboxStatus('cb:mb1'); assert.strictEqual(st.ok, false); assert.ok(/App Password/.test(st.error) && !/SECRET/.test(st.error));
    reset(); S.missing = true; assert.deepStrictEqual(await poll.pollChargebackMailboxes(), { boxes: 0, alerts: 0 });
  });

  await t('routes: Super Admin only (401 for a team member and for nobody), on every chargeback route', async () => {
    for (const u of [{ role: 'panel_admin', username: 'rahul' }, null]) {
      authState.user = u;
      assert.strictEqual((await routeCb.GET(req('GET', '/api/chargebacks?counts=1'))).status, 401);
      assert.strictEqual((await routeCb.PATCH(req('PATCH', '/api/chargebacks', { id: 'x', status: 'done' }))).status, 401);
      assert.strictEqual((await routePanel.GET(req('GET', '/api/panel-chargeback?businessId=bizVast'))).status, 401);
      assert.strictEqual((await routePanel.POST(req('POST', '/api/panel-chargeback', { businessId: 'bizVast', email: 'a@b.com', appPassword: 'abcdabcdabcdabcd' }))).status, 401);
      assert.strictEqual((await routePanel.PATCH(req('PATCH', '/api/panel-chargeback', { businessId: 'bizVast', whatsapp: '9876543210' }))).status, 401);
      assert.strictEqual((await routePanel.DELETE(req('DELETE', '/api/panel-chargeback?businessId=bizVast'))).status, 401);
    }
  });
  await t('routes: counts and list work before the SQL is applied (installed:false, no error), PATCH validates its body', async () => {
    S.missing = true;
    let d = await (await routeCb.GET(req('GET', '/api/chargebacks?counts=1'))).json(); assert.deepStrictEqual(d, { installed: false, new: 0, open: 0 });
    d = await (await routeCb.GET(req('GET', '/api/chargebacks?view=open'))).json(); assert.strictEqual(d.installed, false); assert.deepStrictEqual(d.alerts, []);
    assert.strictEqual((await routeCb.PATCH(req('PATCH', '/api/chargebacks', { id: 'x', status: 'gone' }))).status, 400);
    assert.strictEqual((await routeCb.PATCH(req('PATCH', '/api/chargebacks', { status: 'done' }))).status, 400);
  });
  await t('panel settings: connect checks input and duplicates; the App Password is never answered; WhatsApp number and gateway ticks are validated', async () => {
    const post = (b) => routePanel.POST(req('POST', '/api/panel-chargeback', b));
    assert.strictEqual((await post({ businessId: 'bizVast', email: 'nope', appPassword: 'abcdabcdabcdabcd' })).status, 400);
    assert.strictEqual((await post({ businessId: 'bizVast', email: 'a@b.com', appPassword: 'short' })).status, 400);
    assert.strictEqual((await post({ businessId: 'bizX1234', email: 'a@b.com', appPassword: 'abcdabcdabcdabcd' })).status, 404);
    S.boxes = []; S.emailUsed = true; assert.strictEqual((await post({ businessId: 'bizVast', email: 'a@b.com', appPassword: 'abcdabcdabcdabcd' })).status, 409);
    S.emailUsed = false; let res = await post({ businessId: 'bizVast', email: 'A@B.com', appPassword: 'abcd abcd abcd abcd' }); const text = await res.text();
    assert.strictEqual(res.status, 200); assert.ok(!/abcdabcd/.test(text));
    reset(); S.boxes = [{ ...S.boxes[0] }]; assert.strictEqual((await post({ businessId: 'bizVast', email: 'z@b.com', appPassword: 'abcdabcdabcdabcd' })).status, 409, 'one chargeback Gmail per panel');
    const g = await (await routePanel.GET(req('GET', '/api/panel-chargeback?businessId=bizVast'))).text();
    assert.ok(!/SECRET/.test(g)); const gd = JSON.parse(g); assert.strictEqual(gd.mailbox.email, 'cb.vastora@gmail.com'); assert.strictEqual(gd.whatsappReady, true); assert.ok(gd.gatewayList.some((x) => x.key === 'razorpay'));
    const patch = (b) => routePanel.PATCH(req('PATCH', '/api/panel-chargeback', b));
    assert.strictEqual((await patch({ businessId: 'bizVast', whatsapp: '12' })).status, 400);
    assert.strictEqual((await patch({ businessId: 'bizVast', gateway: { key: 'notagateway', done: true } })).status, 400);
    assert.strictEqual((await patch({ businessId: 'bizVast', gateway: { key: 'razorpay', done: 'yes' } })).status, 400);
    assert.strictEqual((await patch({ businessId: 'bizVast' })).status, 400);
    S.missing = true; assert.strictEqual((await patch({ businessId: 'bizVast', whatsapp: '9876543210' })).status, 503);
  });
  await t('the inbox helper: an open alert on (panel, order) gives the tag key; no table or no order is "none"', async () => {
    assert.strictEqual(store.chargebackKey('bizVast', '#1553'), 'bizVast|#1553');
    assert.strictEqual((await store.openChargebackKeys([{ business_id: 'bizVast', order_id: null }])).size, 0);
    S.missing = true; assert.strictEqual((await store.openChargebackKeys([{ business_id: 'bizVast', order_id: '#1553' }])).size, 0);
  });

  await t('the team\'s "What to do next" card for a chargeback chat: red, calm, no promises, no advice on chargebacks', () => {
    const ns = require(path.join(SRC, 'lib/chat/next-step.ts'));
    const base = { status: 'agent_handling', known: true, verified: true, subject: null, caseKind: null, caseByChikki: false, reshipped: false, threat: false, accuse: false, health: 10, waitingMs: null, returned: false, promiseDue: false, order: null, heldBy: null, heldByMe: true, canReply: true };
    const s = ns.nextStep({ ...base, chargeback: true });
    assert.strictEqual(s.tone, 'danger'); assert.ok(/Chargeback/.test(s.wants)); assert.ok(s.steps.some((x) => /promise nothing/i.test(x)) && s.steps.some((x) => /do not advise/i.test(x)));
    assert.notStrictEqual(ns.nextStep({ ...base }).wants, s.wants, 'without the alert the card is the usual one');
    assert.strictEqual(ns.nextStep({ ...base, status: 'resolved', chargeback: true }).tone, 'muted', 'a closed chat needs nothing');
  });

  global.fetch = realFetch;
  console.log(`CHARGEBACK: ${n} groups passed`);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
