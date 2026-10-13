// Chargeback history (owner 2026-10-13: "chargeback ... order ki chat, gmail, whatsapp sa connect toh ho jaee takki tuh
// kuch read kar paee"): the REAL history-rules.ts, history.ts and /api/chargebacks/history against a fake database.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);
const { NextRequest } = require('next/server');
const eq = assert.strictEqual, ok = assert.ok, deq = assert.deepStrictEqual;

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const AL1 = '11111111-0000-0000-0000-000000000001', AL2 = '11111111-0000-0000-0000-000000000002';
const NOW = Date.parse('2026-10-13T06:00:00Z'), H = 3_600_000, D = 24 * H;
const iso = (t) => new Date(t).toISOString();
const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const S = {};
function reset() {
  Object.assign(S, {
    user: null, sql: [],
    orders: [
      { order_id: '#1553', business_id: A, panel_name: 'VASTRIKA', customer_name: 'Ravi Rajput.', created_at: iso(NOW - 12 * D), estimated_delivery: '2026-10-08', tracking_status: 'Out for Delivery', delivered_at: null, total: 1499, email: 'ravi.r@gmail.com', phone10: '9811122233', payment_method: 'PayU', is_cancelled: false, tracking_token: 'tok1', tracking_domain: null },
      { order_id: '#1553', business_id: B, panel_name: 'kurtiya', customer_name: 'Other Person', created_at: iso(NOW - 5 * D), estimated_delivery: null, tracking_status: 'In Transit', delivered_at: null, total: 999, email: 'x@y.com', phone10: '9900000000', payment_method: 'PayU', is_cancelled: false, tracking_token: null, tracking_domain: null },
      { order_id: '#1601', business_id: A, panel_name: 'VASTRIKA', customer_name: 'Meena S', created_at: iso(NOW - 6 * D), estimated_delivery: null, tracking_status: 'In Transit', delivered_at: null, total: 2499, email: 'meena@gmail.com', phone10: '9822200000', payment_method: 'PayU', is_cancelled: false, tracking_token: null, tracking_domain: null },
      { order_id: '#1602', business_id: A, panel_name: 'VASTRIKA', customer_name: 'Kiran P', created_at: iso(NOW - 4 * D), estimated_delivery: null, tracking_status: 'In Transit', delivered_at: null, total: 2499, email: 'kiran@gmail.com', phone10: '9833300000', payment_method: 'PayU', is_cancelled: false, tracking_token: null, tracking_domain: null },
    ],
    chats: [
      { id: 'c-web', business_id: A, source: 'chat', status: 'human_needed', verified_order_id: '#1553', customer_key: '9811122233', visitor_id: 'v1', visitor_phone: null, health_score: 70, case_kind: null, reshipped_at: null, assigned_to: null, last_message_at: iso(NOW - 2 * D) },
      { id: 'c-mail', business_id: A, source: 'email', status: 'agent_handling', verified_order_id: null, customer_key: null, visitor_id: 'email:ravi.r@gmail.com', visitor_phone: null, health_score: 50, case_kind: null, reshipped_at: null, assigned_to: null, last_message_at: iso(NOW - 3 * D) },
      { id: 'c-wa', business_id: A, source: 'whatsapp', status: 'agent_handling', verified_order_id: null, customer_key: null, visitor_id: 'wa:919811122233', visitor_phone: '+919811122233', health_score: 20, case_kind: null, reshipped_at: null, assigned_to: null, last_message_at: iso(NOW - 1 * D) },
      { id: 'c-other', business_id: B, source: 'chat', status: 'ai_handling', verified_order_id: '#1553', customer_key: '9900000000', visitor_id: 'v9', visitor_phone: null, health_score: 0, case_kind: null, reshipped_at: null, assigned_to: null, last_message_at: iso(NOW - D) },
    ],
    msgs: [
      ['c-web', 'visitor', 'kab aayega mera order? Ravi here, call me 98111 22233', NOW - 4 * D, false],
      ['c-web', 'ai', 'Your order is out for delivery.', NOW - 4 * D + 60_000, false],
      ['c-web', 'ai', '', NOW - 4 * D + 30_000, true],
      ['c-web', 'visitor', 'tracking link is fake, I will go to my bank', NOW - 2 * D, false],
      ['c-mail', 'visitor', 'Where is my parcel? It is 5 days late.', NOW - 3 * D, false],
      ['c-wa', 'visitor', 'order nahi aaya', NOW - 1 * D, false],
      ['c-other', 'visitor', 'another panel, never shown', NOW - D, false],
    ],
    mails: [
      { box_id: 'box-a', panel: A, uid: '44', folder: 'inbox', from_addr: 'Ravi.R@gmail.com', to_addrs: ['support@vastrika.in'], subject: 'Order late', sent_at: iso(NOW - 3 * D + 2 * 60_000), body: 'Where is my parcel? It is 5 days late.', gone: false },
      { box_id: 'box-a', panel: A, uid: '9', folder: 'sent', from_addr: 'support@vastrika.in', to_addrs: ['ravi.r@gmail.com'], subject: 'Re: Order late', sent_at: iso(NOW - 3 * D + H), body: 'Hi Ravi, it is on the way: https://shiptrack.store/track/tok1', gone: false },
      { box_id: 'box-b', panel: B, uid: '1', folder: 'inbox', from_addr: 'ravi.r@gmail.com', to_addrs: [], subject: 'other panel', sent_at: iso(NOW - D), body: 'never shown', gone: false },
    ],
    auto: [{ business_id: A, order_id: '#1553', kind: 'placed', status: 'read', body_text: 'Hi Ravi, your order #1553 with VASTRIKA has been placed.', error: null, sent_at: iso(NOW - 12 * D + 60_000), due_at: iso(NOW - 12 * D), updated_at: iso(NOW - 12 * D) }],
    alerts: [
      { id: AL1, business_id: A, received_at: iso(NOW - H), subject: 'Chargeback raised on your payment', snippet: 'A chargeback has been raised by the cardholder for INR 1,499. Customer ravi.r@gmail.com.', gateway: 'PayU', order_id: null, status: 'new', panel_name: 'VASTRIKA' },
      { id: AL2, business_id: A, received_at: iso(NOW - 2 * H), subject: 'Dispute notice', snippet: 'The cardholder has disputed a payment of INR 2,499.', gateway: 'PayU', order_id: null, status: 'new', panel_name: 'VASTRIKA' },
    ],
  });
}
reset();

const db = {
  query: async (sql, p = []) => {
    const q = sql.replace(/\s+/g, ' ');
    S.sql.push(q);
    ok(!/^\s*(UPDATE|INSERT|DELETE)/i.test(sql), 'history never writes: ' + q.slice(0, 60));
    if (/FROM chargeback_alerts a LEFT JOIN businesses b/.test(q)) return { rows: S.alerts.filter((a) => a.id === p[0] && (!p[1] || p[1].includes(a.business_id))) };
    if (/FROM chargeback_alerts a WHERE a.business_id = \$1 AND a.order_id = \$2/.test(q)) return { rows: S.alerts.filter((a) => a.business_id === p[0] && a.order_id === p[1]) };
    if (/SELECT id, subject, snippet FROM chargeback_alerts/.test(q)) return { rows: S.alerts.filter((a) => !p[0] || p[0].includes(a.business_id)).sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at)) };
    if (/SELECT DISTINCT ON \(k\) order_id/.test(q)) {
      const byEmail = /customer_email/.test(q);
      const rows = S.orders.filter((o) => o.business_id === p[0] && p[1].includes(byEmail ? o.email : o.phone10) && Date.parse(o.created_at) <= Date.parse(p[2]));
      return { rows: Array.from(new Set(rows.map((o) => o.order_id))).map((order_id) => ({ order_id })) };
    }
    if (/abs\(o.order_total - \$2\) < 1/.test(q)) return { rows: S.orders.filter((o) => o.business_id === p[0] && Math.abs(o.total - p[1]) < 1).slice(0, 2).map((o) => ({ order_id: o.order_id })) };
    if (/o.is_cancelled, o.tracking_token, b.tracking_domain/.test(q)) return { rows: S.orders.filter((o) => o.business_id === p[0] && p[1].includes(o.order_id)) };
    if (/AS why FROM orders o/.test(q)) {
      const [biz, , emails, phones, amounts] = p;
      return { rows: S.orders.filter((o) => o.business_id === biz && (emails.includes(o.email) || phones.includes(o.phone10) || amounts.some((x) => Math.abs(o.total - x) < 1))).map((o) => ({ ...o, why: emails.includes(o.email) ? 'same email in the mail' : 'same amount as the mail' })) };
    }
    if (/FROM conversations c JOIN sites s ON s.id = c.site_id/.test(q)) {
      const [panels, nums, phones, emails] = p;
      return { rows: S.chats.filter((c) => panels.includes(c.business_id) && (nums.includes(digits(c.verified_order_id)) || phones.includes(c.customer_key) || phones.includes(digits(c.visitor_phone).slice(-10)) || emails.includes(c.visitor_id.toLowerCase()))) };
    }
    if (/FROM messages m WHERE m.conversation_id = ANY/.test(q)) return { rows: S.msgs.filter(([c]) => p[0].includes(c)).map(([conversation_id, sender, content, at, hidden]) => ({ conversation_id, sender, content, created_at: iso(at), hidden })) };
    if (/FROM mail_store m/.test(q)) {
      ok(/s.tracker_business_id::text = \$1::text/.test(q) && /NOT m.gone/.test(q), 'only this panel\'s Gmail, never a gone mail');
      return { rows: S.mails.filter((m) => m.panel === p[0] && !m.gone && ((m.folder === 'inbox' && m.from_addr.toLowerCase() === p[1]) || (m.folder === 'sent' && m.to_addrs.some((x) => x.toLowerCase() === p[1])))) };
    }
    if (/FROM wa_auto_sends/.test(q)) return { rows: S.auto.filter((a) => a.business_id === p[0] && a.order_id === p[1]) };
    if (/SELECT name FROM businesses/.test(q)) return { rows: [{ name: 'VASTRIKA' }] };
    throw new Error('unexpected SQL: ' + q.slice(0, 140));
  },
};
db.queryOne = async (sql, p) => (await db.query(sql, p)).rows[0] || null;
const USERS = {
  owner: { role: 'admin', username: 'owner', businessIds: null, permissions: [] },
  sunny: { role: 'manager', id: 'u-s', username: 'sunny', businessIds: null, permissions: null },
  sunnyB: { role: 'manager', id: 'u-s2', username: 'sunny2', businessIds: [B], permissions: null },
  rahul: { role: 'agent', id: 'u-r', username: 'rahul', businessIds: null, permissions: ['chat.view', 'chat.reply'] },
};
const fakes = { '@/lib/db': db, '@/lib/auth': { getAuthFromRequest: () => S.user } };
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const HR = require(path.join(SRC, 'lib/chargeback/history-rules.ts'));
const route = require(path.join(SRC, 'app/api/chargebacks/history/route.ts'));
const get = async (who, qs) => { S.user = USERS[who] || null; const r = await route.GET(new NextRequest('http://x/api/chargebacks/history' + qs)); return { status: r.status, body: await r.json() }; };

let pass = 0, fail = 0;
async function t(name, fn) {
  reset(); delete global.__riskCache;
  const err = console.error; console.error = () => {};
  try { await fn(); console.error = err; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = err; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')); }
}

(async () => {
  console.log('chargeback-history: the order\'s chats, Gmail and WhatsApp behind a chargeback');

  await t('rules: masking hides name, phone, email, link, order and long numbers; keeps amounts and words', () => {
    const s = HR.maskText('Hi Ravi Rajput, call 98111 22233 or +91-9811122233, mail ravi.r@gmail.com, order #1553, AWB ST12345678, https://x.in/t?a=1, ref 123456789, ₹1,499 paid, Rs 12500 / INR 250000 too', ['Ravi Rajput.']);
    ok(!/Ravi|Rajput|98111|9811122233|ravi\.r|1553|ST1234|https|123456789/.test(s), s);
    ok(/₹1,499/.test(s) && /Rs 12500/.test(s) && /INR 250000/.test(s) && /\[name\]/.test(s) && /\[phone\]/.test(s) && /\[email\]/.test(s) && /\[order\]/.test(s) && /\[link\]/.test(s), s);
    eq(HR.maskText('Ravindra came', ['Ravi']), 'Ravindra came', 'only whole words');
  });

  await t('rules: the timeline is oldest first, long texts cut, the newest 400 kept; an email-chat copy of a Gmail mail is dropped', () => {
    const e = (at, extra = {}) => ({ at: iso(at), channel: 'chat', who: 'customer', text: 'x', ...extra });
    const { timeline, cut } = HR.sortTimeline([e(NOW), e(NOW - D, { text: 'y'.repeat(2000) }), e(NOW - 2 * D, { text: '  ' })]);
    deq([timeline.length, cut, timeline[0].text.length], [2, false, HR.TEXT_MAX + 1]);
    const many = HR.sortTimeline(Array.from({ length: 450 }, (_, i) => e(NOW + i * 1000, { text: String(i) })));
    deq([many.timeline.length, many.cut, many.timeline[0].text], [400, true, '50']);
    const d = HR.dropEmailChatCopies([e(NOW, { channel: 'email' }), e(NOW + 5 * 60_000, { channel: 'gmail' }), e(NOW + D, { channel: 'email' })]);
    deq(d.map((x) => x.channel), ['gmail', 'email']);
  });

  await t('an alert whose mail names no order: matched by the email in it; the website chat, email chat, WhatsApp chat, Gmail (in + sent), automatic WhatsApp and the chargeback all tied; another panel\'s same number never', async () => {
    const r = await get('sunny', `?id=${AL1}`);
    eq(r.status, 200);
    const h = r.body.history;
    deq([h.order.orderId, h.matchedBy, h.order.customerName, h.order.payment, h.order.trackingLink], ['#1553', 'email', 'Ravi Rajput', 'Prepaid', 'https://shiptrack.store/track/tok1']);
    deq(h.sources.chats.map((c) => [c.kind, c.status]).sort(), [['chat', 'Needs you'], ['email', 'With team'], ['whatsapp', 'With team']]);
    deq([h.sources.gmail, h.sources.waAuto, h.sources.chargebacks], [2, 1, 1]);
    const chans = h.timeline.map((e) => `${e.channel}:${e.who}`);
    ok(chans.includes('chat:customer') && chans.includes('chat:chikki') && chans.includes('gmail:customer') && chans.includes('gmail:team') && chans.includes('whatsapp:customer') && chans.includes('wa_auto:system') && chans.includes('chargeback:gateway'), chans.join(' '));
    ok(!chans.includes('email:customer'), 'the email chat copy of the Gmail mail is not shown twice');
    ok(h.timeline.every((e, i, a) => i === 0 || Date.parse(a[i - 1].at) <= Date.parse(e.at)), 'oldest first');
    ok(!JSON.stringify(h).includes('never shown'), 'another panel\'s chat / mail never appears');
    ok(h.timeline.every((e) => e.text.trim()), 'no hidden / empty rows');
    eq(h.timeline[h.timeline.length - 1].channel, 'chargeback');
    const link = h.timeline.find((e) => e.channel === 'gmail' && e.who === 'customer').link;
    eq(link, '/admin?tab=mail&box=box-a&uid=44');
    // The copy for Claude is masked.
    ok(!/Ravi|98111|ravi\.r|tok1|1553/.test(r.body.text), r.body.text);
    ok(/CUSTOMER/.test(r.body.text) && /GATEWAY/.test(r.body.text) && /Gmail/.test(r.body.text) && /₹1499/.test(r.body.text), r.body.text);
  });

  await t('an alert that fits two orders: no order, the candidates listed (never a guess); Stop them order path; who may read it', async () => {
    let r = await get('owner', `?id=${AL2}`);
    eq(r.status, 200);
    eq(r.body.history.order, null);
    deq(r.body.history.candidates.map((c) => c.orderId).sort(), ['#1601', '#1602']);
    eq(r.body.history.timeline.length, 1, 'only the chargeback mail itself');
    ok(/NOT FOUND/.test(r.body.text));
    r = await get('owner', `?businessId=${A}&orderId=%231553`);
    deq([r.status, r.body.history.order.orderId, r.body.history.matchedBy, r.body.history.alert], [200, '#1553', 'typed', null]);
    eq((await get(null, `?id=${AL1}`)).status, 401);
    eq((await get('rahul', `?id=${AL1}`)).status, 403, 'a team member never reads the chargeback history');
    eq((await get('sunnyB', `?id=${AL1}`)).status, 404, 'a Manager of another panel');
    eq((await get('sunnyB', `?businessId=${A}&orderId=1553`)).status, 404);
    eq((await get('owner', '?id=nope')).status, 400);
    eq((await get('owner', `?businessId=${A}`)).status, 400);
  });

  await t('Copy all for Claude: every real chargeback in scope, numbered, masked', async () => {
    const r = await get('sunny', '?all=1');
    eq(r.status, 200);
    eq(r.body.count, 2);
    ok(/=== Chargeback 1/.test(r.body.text) && /=== Chargeback 2/.test(r.body.text));
    ok(!/Ravi|Meena|Kiran|98111|@gmail/.test(r.body.text), r.body.text);
    eq((await get('sunnyB', '?all=1')).body.count, 0, 'a Manager of another panel sees none of these');
  });

  console.log(`CHARGEBACK-HISTORY: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  if (fail) process.exit(1);
})();
