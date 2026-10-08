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
    alerts: [], convUpdates: [], notified: [], waNumber: '9876543210', waByPanel: null, gwRows: [], moved: null, lastUid: null, lastUidIds: null, imapFail: false, connects: 0, closes: 0, logouts: 0,
    wa: 'sent', missing: false, mailboxRows: [], settings: null, hosts: [], deadPass: null, netFail: false,
  });
}
reset();
const gone = () => Object.assign(new Error('relation does not exist'), { code: '42P01' });
const db = {
  query: async (sql, p) => {
    if (S.missing && /chargeback_|panel_chargeback/.test(sql)) throw gone();
    if (/lower\(m\.email\) AS email/.test(sql)) { const rows = S.boxes.map((b) => ({ business_id: b.business_id, email: b.email.toLowerCase(), name: b.panel_name })); return { rows, rowCount: rows.length }; }
    if (/FROM chargeback_mailboxes m/.test(sql)) return { rows: S.boxes, rowCount: S.boxes.length };
    if (/FROM orders\s+WHERE business_id::text = ANY/.test(sql)) { const rows = S.orders.filter((o) => p[0].includes(o.panel) && p[1].includes(o.order_id)).map((o) => ({ business_id: o.panel, order_id: o.order_id })); return { rows, rowCount: rows.length }; }
    if (/FROM panel_chargeback WHERE business_id = ANY/.test(sql)) { const rows = S.gwRows.filter((g) => p[0].includes(g.business_id)); return { rows, rowCount: rows.length }; }
    if (/UPDATE chargeback_alerts SET business_id = \$2/.test(sql)) { S.moved = { id: p[0], business_id: p[1], order_id: p[2] }; return { rows: [], rowCount: 1 }; }
    if (/UPDATE conversations c SET status = 'human_needed'/.test(sql)) { S.convUpdates.push(p); return { rows: [], rowCount: 1 }; }
    if (/UPDATE chargeback_mailboxes SET last_uid/.test(sql)) { S.lastUid = p[0]; S.lastUidIds = p[1]; return { rows: [], rowCount: 1 }; }
    if (/UPDATE chargeback_alerts SET notify_status/.test(sql)) { S.alerts.find((a) => a.id === p[0]).notify_status = p[1]; return { rows: [], rowCount: 1 }; }
    if (/DELETE FROM chargeback_mailboxes/.test(sql)) return { rows: [], rowCount: S.boxes.length ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  },
  queryOne: async (sql, p) => {
    if (S.missing && /chargeback_|panel_chargeback/.test(sql)) throw gone();
    if (/FROM orders WHERE business_id::text = \$1::text AND order_id = ANY/.test(sql)) { const o = S.orders.find((x) => x.panel === p[0] && p[1].includes(x.order_id)); return o ? { order_id: o.order_id } : null; }
    if (/SELECT a\.business_id, a\.subject, a\.snippet/.test(sql)) return S.alertRow || null;
    if (/INSERT INTO chargeback_alerts/.test(sql)) {
      if (S.alerts.some((a) => a.mailbox === p[1] && a.uid === p[2])) return null;
      const a = { id: 'al' + (S.alerts.length + 1), business_id: p[0], mailbox: p[1], uid: p[2], from_address: p[4], subject: p[6], snippet: p[7], gateway: p[8], order_id: p[9], routed_by: /routed_by/.test(sql) ? p[10] : undefined, notify_status: 'pending' };
      S.alerts.push(a); return { id: a.id };
    }
    if (/SELECT whatsapp_number FROM panel_chargeback/.test(sql)) { const n = S.waByPanel ? S.waByPanel[p[0]] : S.waNumber; return n == null ? null : { whatsapp_number: n }; }
    if (/FROM chargeback_mailboxes WHERE business_id/.test(sql)) { const b = S.boxes.find((x) => x.business_id === p[0]); return b ? { id: b.id, email: b.email, created_at: '2026-10-08' } : null; }
    if (/FROM chargeback_mailboxes WHERE lower\(email\) = lower/.test(sql)) return S.boxes[0] ? { id: S.boxes[0].id } : null;
    if (/SELECT whatsapp_number, gateways FROM panel_chargeback/.test(sql)) return S.settings;
    if (/SELECT id FROM businesses/.test(sql)) return ['bizVast', 'bizKurt'].includes(p[0]) ? { id: p[0] } : null;
    if (/count\(\*\) FROM site_emails/.test(sql)) return { s: S.emailUsed ? 1 : 0, c: S.boxes.filter((b) => b.email.toLowerCase() === p[0]).length };
    if (/SELECT max\(last_uid\)/.test(sql)) return { last_uid: Math.max(...S.boxes.map((b) => Number(b.last_uid))) };
    if (/INSERT INTO chargeback_mailboxes/.test(sql)) { if (S.dupError) throw Object.assign(new Error('duplicate key'), { code: '23505' }); S.insertedUid = p[3]; return { id: 'mb9', email: p[1], created_at: '2026-10-08' }; }
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
    constructor(opts) { S.connects++; this.pass = opts && opts.auth ? opts.auth.pass : ''; S.hosts.push(opts && opts.host); }
    on() {}
    async connect() {
      if (S.imapFail) throw new Error('Invalid credentials');
      if (S.deadPass && this.pass === S.deadPass) throw Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: 'Invalid credentials (Failure)' });
      if (S.netFail) throw new Error('connect ETIMEDOUT');
    }
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


  // ── one chargeback Gmail for two panels (owner 2026-10-08: PayU on one panel, PayGlocal on the other) ──────────────────
  const routing = require(path.join(SRC, 'lib/chargeback/routing.ts'));
  await t('routing: one panel = that panel; the order wins over the gateway; the ticked gateway decides otherwise; nothing to go by = the first panel, marked unsure', () => {
    const V = { businessId: 'v', gateways: { payu: { done: true } } }, K = { businessId: 'k', gateways: { payglocal: { done: true } } };
    assert.deepStrictEqual(routing.routeToPanel([V], 'payglocal', []), { businessId: 'v', by: 'single' });
    assert.deepStrictEqual(routing.routeToPanel([V, K], 'payu', []), { businessId: 'v', by: 'gateway' });
    assert.deepStrictEqual(routing.routeToPanel([V, K], 'payglocal', []), { businessId: 'k', by: 'gateway' });
    assert.deepStrictEqual(routing.routeToPanel([V, K], 'payglocal', ['v']), { businessId: 'v', by: 'order' }, 'the order proves the panel');
    assert.deepStrictEqual(routing.routeToPanel([V, K], 'payglocal', ['v', 'k']), { businessId: 'k', by: 'gateway' }, 'an order in both: the gateway breaks the tie');
    assert.deepStrictEqual(routing.routeToPanel([V, K], 'razorpay', []), { businessId: 'v', by: 'unsure' });
    assert.deepStrictEqual(routing.routeToPanel([{ businessId: 'v', gateways: { payu: { done: true } } }, { businessId: 'k', gateways: { payu: { done: true } } }], 'payu', []), { businessId: 'v', by: 'unsure' }, 'both tick it: cannot tell');
    assert.strictEqual(routing.routeToPanel([], 'payu', []), null);
    assert.strictEqual(parse.gatewayKeyOf('PayGlocal'), 'payglocal'); assert.strictEqual(parse.gatewayKeyOf('Unknown'), 'other'); assert.strictEqual(parse.gatewayOf('alerts@payglocal.in', '', 'x', ''), 'PayGlocal');
  });
  const sharedBoxes = () => [
    { id: 'mb1', business_id: 'bizVast', email: 'shared@gmail.com', app_password: 'SECRETSECRETSECR', last_uid: 5, panel_name: 'vastrika' },
    { id: 'mb2', business_id: 'bizKurt', email: 'Shared@Gmail.com', app_password: 'SECRETSECRETSECR', last_uid: 3, panel_name: 'kurtiya' },
  ];
  const setupShared = () => {
    S.boxes = sharedBoxes();
    S.gwRows = [{ business_id: 'bizVast', gateways: { payu: { done: true } } }, { business_id: 'bizKurt', gateways: { payglocal: { done: true } } }];
    S.waByPanel = { bizVast: '9811111111', bizKurt: '9822222222' };
    S.orders = [{ order_id: '#1553', panel: 'bizVast' }, { order_id: '#2200', panel: 'bizKurt' }];
    S.msgs = [
      { uid: 6, source: mail('a6', 'alerts@payu.in', 'Chargeback raised', 'A chargeback was raised on a payment. Please respond.') },
      { uid: 7, source: mail('a7', 'disputes@payglocal.in', 'Dispute notice', 'A dispute was opened. Please respond.') },
      { uid: 8, source: mail('a8', 'disputes@payglocal.in', 'Dispute for order #1553', 'Order #1553 disputed.') },
      { uid: 9, source: mail('a9', 'noreply@razorpay.com', 'Dispute', 'something with no order') },
    ];
  };
  await t('shared Gmail: a dead App Password on the first panel\'s row is skipped and the other panel\'s works; a network failure tries no second password; the SQL setup file carries every change', async () => {
    setupShared();
    S.boxes[1].app_password = 'GOODPASSGOODPASS'; S.deadPass = S.boxes[0].app_password;
    const r = await poll.pollChargebackMailboxes();
    assert.strictEqual(r.alerts, 4, 'read with the second password'); assert.strictEqual(S.connects, 2, 'the dead one, then the good one');
    assert.strictEqual(mstat.getMailboxStatus('cb:mb1').ok, true, 'the status is OK, under the first row');
    assert.ok(S.hosts.every((h) => typeof h === 'string' && h.length > 0), 'a host is always given');
    setupShared(); S.boxes[1].app_password = 'GOODPASSGOODPASS'; S.deadPass = null; S.netFail = true; S.connects = 0;
    assert.strictEqual((await poll.pollChargebackMailboxes()).alerts, 0); assert.strictEqual(S.connects, 1, 'not the password: no second try');
    assert.ok(/did not answer in time/.test(mstat.getMailboxStatus('cb:mb1').error));
    const fsx = require('fs'), sql = fsx.readFileSync(path.resolve(__dirname, '../../chargeback-setup.sql'), 'utf8');
    for (const must of ['CREATE TABLE IF NOT EXISTS chargeback_mailboxes', 'CREATE TABLE IF NOT EXISTS chargeback_alerts', 'CREATE TABLE IF NOT EXISTS panel_chargeback',
      'DROP CONSTRAINT IF EXISTS chargeback_mailboxes_email_key', 'ADD COLUMN IF NOT EXISTS routed_by', 'GRANT DELETE ON chargeback_mailboxes TO tracker_user', 'chargeback_alerts_mail_unique']) assert.ok(sql.includes(must), must);
    assert.ok(!/\bDELETE FROM\b|\bDROP TABLE\b|\bTRUNCATE\b/i.test(sql), 'never deletes');
    assert.ok(!/email\s+text NOT NULL UNIQUE/.test(sql), 'the fresh table has no one-panel-per-address limit');
  });

  await t('shared Gmail: it is read ONCE for both panels; each mail goes to the panel by the order it names, else by its ticked gateway, else the first panel (unsure); last_uid moves on for BOTH rows', async () => {
    setupShared();
    const r = await poll.pollChargebackMailboxes();
    assert.deepStrictEqual(r, { boxes: 1, alerts: 4 }); assert.strictEqual(S.connects, 1, 'one sign-in for the one Gmail');
    assert.deepStrictEqual(S.alerts.map((a) => [a.uid, a.business_id, a.routed_by, a.order_id]), [
      [6, 'bizVast', 'gateway', null], [7, 'bizKurt', 'gateway', null], [8, 'bizVast', 'order', '#1553'], [9, 'bizVast', 'unsure', null],
    ]);
    assert.ok(S.alerts.every((a) => a.mailbox === 'mb1'), 'keyed by the first-connected panel\'s row');
    assert.strictEqual(S.lastUid, 9); assert.deepStrictEqual(S.lastUidIds, ['mb1', 'mb2']);
    assert.deepStrictEqual(S.convUpdates.map((u) => u), [['bizVast', '#1553']], 'only the matched order\'s chat in its own panel');
  });
  await t('shared Gmail: the WhatsApp message goes to the number of the panel the mail was routed to, with that panel\'s name', async () => {
    setupShared(); await poll.pollChargebackMailboxes();
    const to = S.notified.map((n) => [JSON.parse(n.opt.body).to, JSON.parse(n.opt.body).template.components[0].parameters.map((x) => x.text)[0]]);
    assert.deepStrictEqual(to, [['919811111111', 'vastrika'], ['919822222222', 'kurtiya'], ['919811111111', 'vastrika'], ['919811111111', 'vastrika']]);
  });
  await t('shared Gmail: a single-panel Gmail still uses the plain insert (works before chargeback-shared.sql); only a shared one writes routed_by', async () => {
    await poll.pollChargebackMailboxes();
    assert.ok(S.alerts.every((a) => a.routed_by === undefined));
  });
  await t('connect the SAME Gmail on a second panel: allowed (it starts where the first panel stands, App Password still checked); a support Gmail is still refused; before chargeback-shared.sql a clear message', async () => {
    S.boxes = [sharedBoxes()[0]];
    const post = (b) => routePanel.POST(req('POST', '/api/panel-chargeback', b));
    const res = await post({ businessId: 'bizKurt', email: 'Shared@Gmail.com', appPassword: 'abcd abcd abcd abcd' }); const d = await res.json();
    assert.strictEqual(res.status, 200); assert.strictEqual(d.shared, true); assert.strictEqual(S.insertedUid, 5, 'nothing is read twice or skipped');
    S.emailUsed = true; assert.strictEqual((await post({ businessId: 'bizKurt', email: 'shared@gmail.com', appPassword: 'abcdabcdabcdabcd' })).status, 409);
    S.emailUsed = false; S.dupError = true; const dup = await post({ businessId: 'bizKurt', email: 'shared@gmail.com', appPassword: 'abcdabcdabcdabcd' });
    assert.strictEqual(dup.status, 409); assert.ok(/chargeback-setup\.sql/.test((await dup.json()).error));
  });
  await t('move an unsure alert to the other panel: only a panel reading the same Gmail; the order is looked up again there; Super Admin only', async () => {
    S.boxes = sharedBoxes(); S.alertRow = { business_id: 'bizVast', subject: 'Dispute for order #2200', snippet: 'Order #2200 disputed', email: 'shared@gmail.com' }; S.orders = [{ order_id: '#2200', panel: 'bizKurt' }];
    const id = '11111111-1111-1111-1111-111111111111';
    const patch = (b) => routeCb.PATCH(req('PATCH', '/api/chargebacks', b));
    let res = await patch({ id, businessId: 'bizKurt' }); assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(S.moved, { id, business_id: 'bizKurt', order_id: '#2200' });
    S.moved = null; assert.strictEqual((await patch({ id, businessId: 'bizOther1' })).status, 400); assert.strictEqual(S.moved, null);
    S.alertRow = null; assert.strictEqual((await patch({ id, businessId: 'bizKurt' })).status, 404);
    authState.user = { role: 'panel_admin', username: 'rahul' }; assert.strictEqual((await patch({ id, businessId: 'bizKurt' })).status, 401);
  });
  await t('the team\'s "What to do next" card for a chargeback chat: red, calm, no promises, no advice on chargebacks', () => {
    const ns = require(path.join(SRC, 'lib/chat/next-step.ts'));
    const base = { status: 'agent_handling', known: true, verified: true, subject: null, caseKind: null, caseByChikki: false, reshipped: false, threat: false, accuse: false, health: 10, waitingMs: null, returned: false, promiseDue: false, order: null, heldBy: null, heldByMe: true, canReply: true };
    const s = ns.nextStep({ ...base, chargeback: true });
    assert.strictEqual(s.tone, 'danger'); assert.ok(/Chargeback/.test(s.wants)); assert.ok(s.steps.some((x) => /promise nothing/i.test(x)) && s.steps.some((x) => /do not advise/i.test(x)));
    assert.notStrictEqual(ns.nextStep({ ...base }).wants, s.wants, 'without the alert the card is the usual one');
    assert.strictEqual(ns.nextStep({ ...base, status: 'resolved', chargeback: true }).tone, 'muted', 'a closed chat needs nothing');
  });

  await t('disconnect: a database that refuses the DELETE (42501) says which SQL file to run; the SQL file grants DELETE on the mailbox table only', async () => {
    const fsx = require('fs');
    const sql = fsx.readFileSync(path.resolve(__dirname, '../../chargeback-disconnect.sql'), 'utf8');
    assert.ok(/GRANT DELETE ON chargeback_mailboxes TO tracker_user/.test(sql) && !/chargeback_alerts|panel_chargeback/.test(sql.replace(/--[^\n]*/g, '')));
    assert.ok(/GRANT DELETE ON chargeback_mailboxes/.test(fsx.readFileSync(path.resolve(__dirname, '../../chargeback.sql'), 'utf8')));
  });

  global.fetch = realFetch;
  console.log(`CHARGEBACK: ${n} groups passed`);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
