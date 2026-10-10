// Chargeback Shield (owner 2026-10-10): the REAL risk-rules.ts and risk.ts (and the risk route) against a fake database.
// Which prepaid order is about to become a chargeback, the next step, the chargeback mail -> order match by email /
// phone / amount, and the study of past chargebacks.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, jsx: 'react-jsx' }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, ok = assert.ok, deq = assert.deepStrictEqual;

const NOW = Date.parse('2026-10-10T08:00:00Z');
const H = 3_600_000, D = 24 * H;
const iso = (t) => new Date(t).toISOString();
const S = {};
const order = (o) => ({ panel_name: 'Store A', customer_name: 'Asha K.', tracking_status: 'In Transit', delivered_at: null, total: 1499, email: '', phone10: '', payment_method: 'Prepaid', business_id: 'bizA', ...o });
function reset() {
  Object.assign(S, {
    sql: [],
    orders: [
      order({ order_id: '#2001', created_at: iso(NOW - 15 * D), estimated_delivery: '2026-10-05', phone10: '9811111111', total: 2999 }),
      order({ order_id: '#2002', created_at: iso(NOW - 12 * D), estimated_delivery: '2026-10-06', tracking_status: 'Delivered', delivered_at: iso(NOW - 3 * D), phone10: '9822222222' }),
      order({ order_id: '#2003', created_at: iso(NOW - 2 * D), estimated_delivery: '2026-10-18', email: 'asha@example.com', phone10: '9833333333' }),
      order({ order_id: '#2004', created_at: iso(NOW - 20 * D), estimated_delivery: '2026-10-02', phone10: '9844444444' }),
      order({ order_id: '#2005', created_at: iso(NOW - 15 * D), estimated_delivery: '2026-10-05', payment_method: 'COD', phone10: '9855555555' }),
      order({ order_id: '#2006', created_at: iso(NOW - 15 * D), estimated_delivery: '2026-10-07', phone10: '9866666666' }),
    ],
    chats: [
      { id: 'c1', business_id: 'bizA', source: 'chat', status: 'human_needed', verified_order_id: '#2001', customer_key: '9811111111', visitor_id: 'v1', visitor_phone: null, health_score: 80, case_kind: null, reshipped_at: null, assigned_to: 'u1', last_message_at: iso(NOW - 12 * H) },
      { id: 'c2', business_id: 'bizA', source: 'chat', status: 'ai_handling', verified_order_id: null, customer_key: '9822222222', visitor_id: 'v2', visitor_phone: null, health_score: 40, case_kind: null, reshipped_at: null, assigned_to: null, last_message_at: iso(NOW - 3 * H) },
      { id: 'c3', business_id: 'bizA', source: 'email', status: 'agent_handling', verified_order_id: null, customer_key: null, visitor_id: 'email:asha@example.com', visitor_phone: null, health_score: 30, case_kind: null, reshipped_at: null, assigned_to: null, last_message_at: iso(NOW - 5 * H) },
      { id: 'c6', business_id: 'bizA', source: 'whatsapp', status: 'resolved', verified_order_id: null, customer_key: null, visitor_id: 'wa:919866666666', visitor_phone: '+919866666666', health_score: 20, case_kind: null, reshipped_at: null, assigned_to: null, last_message_at: iso(NOW - 1 * D) },
    ],
    msgs: [
      ['c1', 'visitor', 'where is my order? kab aayega', NOW - 4 * D],
      ['c1', 'ai', 'Your order is in transit, the estimated date is 5 Oct.', NOW - 4 * D + 60_000],
      ['c1', 'visitor', 'the tracking link is fake, it is not opening', NOW - 2 * D],
      ['c1', 'visitor', 'kab aayega??? still not received', NOW - 1 * D],
      ['c1', 'visitor', 'I will raise a chargeback with my bank if I do not get it', NOW - 12 * H],
      ['c2', 'visitor', 'it shows delivered but I did not receive the parcel', NOW - 3 * H],
      ['c3', 'visitor', 'Is this website genuine? Looks like a fraud store to me', NOW - 5 * H],
      ['c6', 'visitor', 'when will it come, it is late', NOW - 2 * D],
      ['c6', 'agent', 'It is on the way, sorry for the delay', NOW - 2 * D + H],
      ['c6', 'visitor', 'mil gaya thanks', NOW - 1 * D],
    ],
    alerts: [
      { id: 'a1', business_id: 'bizA', received_at: iso(NOW - 1 * H), subject: 'Chargeback raised on payment', snippet: 'A chargeback has been raised. Customer: asha@example.com. Amount INR 1,499.', gateway: 'PayU', order_id: null, status: 'new' },
      { id: 'a2', business_id: 'bizA', received_at: iso(NOW - 2 * D), subject: 'Dispute notice', snippet: 'The cardholder has disputed the payment. Phone 98444 44444', gateway: 'PayU', order_id: null, status: 'new' },
      { id: 'a3', business_id: 'bizA', received_at: iso(NOW - 2 * D), subject: 'Payment received', snippet: 'You received INR 999 from asha@example.com', gateway: 'PayU', order_id: null, status: 'new' },
    ],
  });
}
reset();
const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const notCod = (o) => !/^cod$|cash on delivery/i.test(o.payment_method || '');
const db = {
  query: async (sql, p = []) => {
    S.sql.push(sql);
    if (/FROM orders o LEFT JOIN businesses b ON b.id = o.business_id\s+WHERE NOT COALESCE\(o.is_cancelled/.test(sql)) {
      ok(/lower\(COALESCE\(o.payment_method, ''\)\) = 'cod'/.test(sql), 'the list SQL leaves COD out');
      const rows = S.orders.filter((o) => notCod(o) && (!p[0] || p[0].includes(o.business_id)));
      return { rows };
    }
    if (/\(o.business_id::text \|\| '\|' \|\| o.order_id\) = ANY/.test(sql)) return { rows: S.orders.filter((o) => p[0].includes(`${o.business_id}|${o.order_id}`)) };
    if (/FROM conversations c JOIN sites s ON s.id = c.site_id/.test(sql)) {
      const [panels, nums, phones, emails] = p;
      return { rows: S.chats.filter((c) => panels.includes(c.business_id) && (nums.includes(digits(c.verified_order_id)) || phones.includes(c.customer_key) || phones.includes(digits(c.visitor_phone).slice(-10)) || emails.includes(c.visitor_id.toLowerCase()))) };
    }
    if (/FROM messages m\s+WHERE m.conversation_id = ANY/.test(sql)) return { rows: S.msgs.filter(([c]) => p[0].includes(c)).map(([conversation_id, sender, content, at]) => ({ conversation_id, sender, content, created_at: iso(at), hidden: false })) };
    if (/FROM chargeback_alerts a\s+WHERE/.test(sql)) return { rows: S.alerts.filter((a) => !p[0] || p[0].includes(a.business_id)) };
    if (/SELECT DISTINCT ON \(k\) order_id/.test(sql)) {
      const byEmail = /customer_email/.test(sql);
      const rows = S.orders.filter((o) => o.business_id === p[0] && p[1].includes(byEmail ? o.email : o.phone10) && Date.parse(o.created_at) <= Date.parse(p[2]))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const seen = new Set(); const out = [];
      for (const o of rows) { const k = byEmail ? o.email : o.phone10; if (!seen.has(k)) { seen.add(k); out.push({ order_id: o.order_id }); } }
      return { rows: out };
    }
    if (/abs\(o.order_total - \$2\) < 1/.test(sql)) return { rows: S.orders.filter((o) => o.business_id === p[0] && notCod(o) && Math.abs(o.total - p[1]) < 1).slice(0, 2).map((o) => ({ order_id: o.order_id })) };
    if (/SELECT id::text AS id, name FROM businesses/.test(sql)) return { rows: [{ id: 'bizA', name: 'Store A' }] };
    // "Link order" (store.ts setAlertOrder, owner 11 Oct)
    if (/SELECT business_id FROM chargeback_alerts WHERE id = \$1/.test(sql)) { const a = S.alerts.find((x) => x.id === p[0] && (!p[1] || p[1].includes(x.business_id))); return { rows: a ? [{ business_id: a.business_id }] : [] }; }
    if (/SELECT order_id FROM orders WHERE business_id::text = \$1::text AND order_id = ANY\(\$2::text\[\]\)/.test(sql)) return { rows: S.orders.filter((o) => o.business_id === p[0] && p[1].includes(o.order_id)).map((o) => ({ order_id: o.order_id })) };
    if (/UPDATE chargeback_alerts SET order_id = \$2 WHERE id = \$1/.test(sql)) { S.alerts.find((x) => x.id === p[0]).order_id = p[1]; return { rows: [], rowCount: 1 }; }
    if (/UPDATE conversations c SET status = 'human_needed'/.test(sql)) { (S.tagged = S.tagged || []).push(p); return { rows: [], rowCount: 1 }; }
    throw new Error('unexpected SQL: ' + sql.slice(0, 120));
  },
};
db.queryOne = async (sql, p) => (await db.query(sql, p)).rows[0] || null;

const fakes = { '@/lib/db': db };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (fakes[request]) return request;
  if (request.startsWith('@/')) return origResolve.call(this, path.join(SRC, request.slice(2)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) { if (fakes[request]) return fakes[request]; return origLoad.call(this, request, parent, ...rest); };
const R = require(path.join(SRC, 'lib/chargeback/risk-rules.ts'));
const K = require(path.join(SRC, 'lib/chargeback/risk.ts'));

let pass = 0, fail = 0;
async function t(name, fn) {
  reset(); delete global.__riskCache;
  const err = console.error; console.error = () => {};
  try { await fn(); console.error = err; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = err; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 8).join('\n       ')); }
}
const msg = (sender, content, at, channel = 'chat', chatId = 'c') => ({ sender, content, at, channel, chatId });
const facts = (f = {}) => ({ healthMax: 0, caseKind: null, reshipped: false, priorChargebacks: 0, chargedBack: false, ...f });
const ro = (o = {}) => ({ orderId: '#1', businessId: 'b', placedAt: NOW - 15 * D, estimatedDelivery: '2026-10-05', delivered: false, total: 1000, ...o });

(async () => {
  console.log('chargeback-risk: Chargeback Shield');

  await t('rules: a chargeback threat on a late order with a fake-link claim, waiting for us = Critical, next step Refund', () => {
    const r = R.scoreOrder(ro(), [
      msg('visitor', 'tracking link is fake, not opening', NOW - 2 * D),
      msg('visitor', 'I will raise a chargeback with my bank', NOW - 30 * H),
    ], facts({ healthMax: 80 }), NOW);
    eq(r.level, 'critical'); eq(r.action.key, 'refund'); eq(r.daysLate, 5);
    ok(r.signals.some((s) => s.key === 'threat_chargeback') && r.signals.some((s) => s.key === 'fake_link') && r.signals.some((s) => s.key === 'unanswered'));
    ok(r.waitingHours >= 48 && r.waitingHours < 49, 'from the first unanswered message (the fake-link claim)');
  });

  await t('rules: the store called fake / fraud vs the tracking link called fake; a genuine-store doubt is lower', () => {
    const one = (text) => R.scoreOrder(ro({ estimatedDelivery: '2026-10-20' }), [msg('visitor', text, NOW - H)], facts(), NOW).signals.map((s) => s.key);
    ok(one('this website is fake, you people are fraud').includes('fake_site'));
    ok(one('aap log fraud ho, paise wapas karo').includes('fake_site'));
    ok(one('scam store hai yeh').includes('fake_site'));
    const link = one('the tracking link you sent is fake');
    ok(link.includes('fake_link') && !link.includes('fake_site'), 'a link claim is the link, not the store');
    ok(one('is this site genuine? can I trust it').includes('site_doubt'));
    ok(!one('where is my order').some((k) => k === 'fake_site' || k === 'site_doubt'));
  });

  await t('rules: Delivered but not received = family check; delivered with no complaint goes down', () => {
    const r = R.scoreOrder(ro({ delivered: true }), [msg('visitor', 'it shows delivered but I did not receive the parcel', NOW - 3 * H)], facts(), NOW);
    eq(r.action.key, 'family_check'); ok(r.signals.some((s) => s.key === 'not_received')); eq(r.daysLate, 0, 'a delivered order is never late');
    const calm = R.scoreOrder(ro({ delivered: true }), [msg('visitor', 'what is the size chart?', NOW - 3 * H)], facts(), NOW);
    eq(calm.level, 'low');
  });

  await t('rules: "mil gaya thanks" brings it down; the new parcel sent brings it down; silent customers stay off the list', () => {
    const solved = R.scoreOrder(ro(), [msg('visitor', 'kab aayega late ho gaya', NOW - 2 * D), msg('agent', 'on the way', NOW - 2 * D + H), msg('visitor', 'mil gaya thanks', NOW - D)], facts(), NOW);
    eq(solved.level, 'low'); ok(solved.signals.some((s) => s.key === 'calmed'));
    const silent = R.scoreOrder(ro({ estimatedDelivery: '2026-09-28' }), [], facts(), NOW);
    eq(silent.level, 'low', 'never wrote: not on the list'); ok(silent.daysLate >= 10);
    const before = R.scoreOrder(ro({ estimatedDelivery: '2026-09-28' }), [], facts({ priorChargebacks: 1 }), NOW);
    ok(before.level !== 'low', 'a customer who charged back before is watched even when silent');
    const sent = R.scoreOrder(ro(), [msg('visitor', 'tracking is fake', NOW - D)], facts({ reshipped: true, caseKind: 'reship' }), NOW);
    ok(sent.signals.some((s) => s.key === 'reshipped')); eq(sent.action.key, 'reassure');
  });

  await t('rules: the wait: a real answer stops it, "took longer" / "the team will confirm" does not, "ok thanks" never starts it', () => {
    eq(R.waitingSince([msg('visitor', 'where is it', 1), msg('ai', 'It is in transit, estimated 5 Oct.', 2)]), null);
    eq(R.waitingSince([msg('visitor', 'where is it', 1), msg('ai', 'Sorry, that took longer than expected on my end. Could you send that again?', 2)]), 1);
    eq(R.waitingSince([msg('visitor', 'where is it', 1), msg('agent', 'on the way', 2), msg('visitor', 'ok thanks', 3)]), null);
    eq(R.waitingSince([msg('visitor', 'where is it', 1), msg('visitor', 'hello??', 5)]), 1, 'from the first unanswered message');
  });

  await t('rules: the next step follows the existing rules in order', () => {
    const act = (keys, f = {}, daysLate = 0, waiting = false) => R.riskAction({ has: (k) => keys.includes(k), facts: facts(f), daysLate, waiting }).key;
    eq(act([], { chargedBack: true }), 'charged_back');
    eq(act(['threat_legal']), 'refund');
    eq(act(['threat_chargeback', 'delivered']), 'reassure', 'delivered: show the proof, do not refund on a threat');
    eq(act(['not_received']), 'family_check');
    eq(act(['fake_link']), 'reship'); eq(act([], {}, 7), 'reship');
    eq(act(['fake_site']), 'reassure');
    eq(act(['refund_ask'], {}, 2), 'refund');
    eq(act([], {}, 0, true), 'reply'); eq(act([]), 'watch');
  });

  await t('mail -> contacts: the customer email / phone / amount, never the gateway\'s own addresses', () => {
    const c = R.contactCandidates('From disputes@payu.in. Customer asha@example.com, phone +91 98333 33333, amount ₹1,499.00. Write to support@store.com');
    eq(JSON.stringify(c.emails), JSON.stringify(['asha@example.com']));
    eq(JSON.stringify(c.phones), JSON.stringify(['9833333333']));
    eq(JSON.stringify(c.amounts), JSON.stringify([1499]));
  });

  await t('match: the order number first, else ONE order of the email / phone; two orders of one amount = no guess', async () => {
    eq((await K.matchOrder('bizA', 'x', NOW, '#2001')).by, 'order');
    const byMail = await K.matchOrder('bizA', 'customer asha@example.com', NOW, null);
    eq(byMail.orderId, '#2003'); eq(byMail.by, 'email');
    const byPhone = await K.matchOrder('bizA', 'Phone 98444 44444', NOW, null);
    eq(byPhone.orderId, '#2004'); eq(byPhone.by, 'phone');
    eq(await K.matchOrder('bizA', 'Amount INR 1,499', NOW, null), null, 'several prepaid orders of 1499: never a guess');
    eq((await K.matchOrder('bizA', 'Amount INR 2,999', NOW, null)).orderId, '#2001', 'one order of that amount');
    const poll = await K.matchByContact(['bizA'], 'Amount INR 2,999', NOW);
    eq(poll.length, 0, 'the poller never ties a mail to an order by the amount alone');
  });

  await t('list: prepaid only, chats on every channel tied to their order, riskiest first, counts', async () => {
    const L = await K.loadRiskList(null, NOW, true);
    const ids = L.items.map((i) => i.orderId);
    ok(!ids.includes('#2005'), 'COD is never on the list');
    eq(L.items.find((i) => i.orderId === '#2004').action.key, 'charged_back', 'never wrote, but already charged back (by phone): on the list');
    ok(!ids.includes('#2006'), 'said mil gaya: off the list');
    eq(L.items[0].score, 100); eq(L.items.find((i) => i.orderId === '#2003').action.key, 'charged_back', 'charged back (matched by email)');
    const o1 = L.items.find((i) => i.orderId === '#2001');
    eq(o1.level, 'critical'); eq(o1.action.key, 'refund'); eq(o1.chatId, 'c1'); eq(o1.holder, 'u1');
    const o2 = L.items.find((i) => i.orderId === '#2002');
    eq(o2.action.key, 'family_check'); eq(o2.chatId, 'c2', 'tied by the customer key (phone)');
    eq(L.scanned, 5); ok(L.counts.critical >= 2);
    const again = await K.loadRiskList(null, NOW + 1000);
    eq(again, L, 'cached for two minutes');
  });

  await t('study: each real chargeback -> its order (email / phone), wrote first or silent, and the signs before', async () => {
    const St = await K.loadStudy(null);
    eq(St.summary.chargebacks, 2, '"Payment received" is not a chargeback');
    eq(St.summary.matched, 2);
    const a1 = St.rows.find((r) => r.alertId === 'a1');
    eq(a1.orderId, '#2003'); eq(a1.matchedBy, 'email'); eq(a1.contacted, true); ok(a1.channels.includes('email'));
    ok(a1.onDay.signals.some((s) => /fake|fraud/i.test(s)));
    const a2 = St.rows.find((r) => r.alertId === 'a2');
    eq(a2.orderId, '#2004'); eq(a2.contacted, false); eq(St.summary.silent, 1);
    ok(St.summary.signals.length > 0);
  });

  await t('Link order (owner 11 Oct): an order of the alert\'s panel only, "#" or not; the chat goes to the team; the study then finds it', async () => {
    const St = require(path.join(SRC, 'lib/chargeback/store.ts'));
    S.alerts.push({ id: '00000000-0000-4000-8000-0000000000a9', business_id: 'bizA', received_at: iso(NOW - 3 * H), subject: 'PayU Chargeback Notification', snippet: 'A chargeback was raised for INR 999.', gateway: 'PayU', order_id: null, status: 'new' });
    const id = '00000000-0000-4000-8000-0000000000a9';
    eq((await St.setAlertOrder(id, 'abc')).status, 400);
    eq((await St.setAlertOrder(id, '9999')).status, 404, 'not an order of this panel');
    eq((await St.setAlertOrder(id, '2002', ['bizOther'])).status, 404, 'a Manager of another panel cannot');
    const r = await St.setAlertOrder(id, '#2002');
    eq(r.ok, true); eq(r.orderId, '#2002'); eq(S.alerts.find((x) => x.id === id).order_id, '#2002');
    eq(S.tagged.length, 1, 'the customer\'s chat goes to the team');
    const study = await K.loadStudy(null);
    const row = study.rows.find((x) => x.alertId === id);
    eq(row.orderId, '#2002'); eq(row.matchedBy, 'order');
    const un = (await K.loadStudy(null)).rows.find((x) => x.alertId === 'a1');
    deq(un.mailHints, { amounts: [1499], emails: 1, phones: 0 });
  });

  await t('route: Super Admin / Manager with chargebacks.view only; the risk list and the study', async () => {
    const authUser = { current: null };
    fakes['@/lib/auth'] = { getAuthFromRequest: () => authUser.current };
    delete require.cache[path.join(SRC, 'app/api/chargebacks/risk/route.ts')];
    const route = require(path.join(SRC, 'app/api/chargebacks/risk/route.ts'));
    const req = (q = '') => ({ url: `http://x/api/chargebacks/risk${q}`, headers: new Map() });
    eq((await route.GET(req())).status, 401);
    authUser.current = { username: 'rahul', role: 'agent', permissions: ['chat.view', 'chat.reply'], businessIds: null };
    eq((await route.GET(req())).status, 401, 'a team member does not see it');
    authUser.current = { username: 'owner', role: 'admin', permissions: [], businessIds: null };
    const r = await route.GET(req());
    eq(r.status, 200); ok((await r.json()).items.length > 0);
    const s = await route.GET(req('?view=study'));
    eq(s.status, 200); eq((await s.json()).summary.chargebacks, 2);
  });

  console.log(`\nchargeback-risk: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
