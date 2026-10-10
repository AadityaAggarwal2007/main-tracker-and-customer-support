// WhatsApp automation (owner 2026-10-10): the REAL rules, worker, delivery-report hook and route against a fake
// database and a fake Cloud API. Nothing here touches Meta or a database. India dates: 10 Oct 2026 is a Saturday.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

const IST = (d, h, m = 0) => Date.UTC(2026, 9, d, h, m) - 330 * 60000;   // an India wall-clock time as epoch ms
const S = {};
function reset() {
  Object.assign(S, {
    nowMs: IST(13, 12), noTable: false, sendFail: null, sendThrow: false, stealClaims: false, trackingFlags: [], reports: [], fetches: [], seq: 0,
    settings: { whatsapp_messaging_id: '28873951022288651', 'wa_brand:b1': JSON.stringify({ name: 'Vastora', email: 'help@vastora.test' }) },
    panels: [{ id: 'b1', name: 'vastora' }, { id: 'b2', name: 'VASTRIKA' }],
    orders: [], rows: [],
    metaTemplates: [
      { id: 't1', name: 'order_placed', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'HEADER', format: 'TEXT', text: 'Order Placed Successfully' }, { type: 'BODY', text: 'Hi {{1}}, your order {{2}} with {{3}} has been placed successfully. Your tracking details will be shared with you within 1-2 days. For any confusion, please email us at {{4}} and our team will help you.' }] },
      { id: 't2', name: 'order_tracking', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} from {{3}} is on its way. Track it here: {{4}} . Questions: {{5}} and our team will help.' }] },
    ],
  });
}
reset();
const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const orderOf = (r) => S.orders.find((o) => o.business_id === r.business_id && o.order_id === r.order_id);
const db = {
  query: async (rawSql, p = []) => {
    const sql = norm(rawSql);
    if (S.noTable && /wa_auto_sends/.test(sql)) { const e = new Error('relation "wa_auto_sends" does not exist'); e.code = '42P01'; throw e; }
    if (/^SELECT key, value FROM chat_settings WHERE key LIKE 'wa_auto:%'/.test(sql)) { const rows = Object.keys(S.settings).filter((k) => k.startsWith('wa_auto:')).map((k) => ({ key: k, value: S.settings[k] })); return { rows, rowCount: rows.length }; }
    if (/FROM chat_settings WHERE key LIKE 'wa_brand:%'/.test(sql)) { const rows = Object.keys(S.settings).filter((k) => k.startsWith('wa_brand:')).map((k) => ({ key: k, value: S.settings[k] })); return { rows, rowCount: rows.length }; }
    if (/^INSERT INTO chat_settings/.test(sql)) { S.settings[p[0]] = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^SELECT key, value FROM chat_settings WHERE key LIKE 'wa_stop:%'/.test(sql)) { const rows = Object.keys(S.settings).filter((k) => k.startsWith('wa_stop:')).map((k) => ({ key: k, value: S.settings[k] })); return { rows, rowCount: rows.length }; }
    if (/FROM businesses b ORDER BY b\.is_default DESC, b\.created_at ASC/.test(sql)) return { rows: S.panels.map((x) => ({ ...x })), rowCount: S.panels.length };
    if (/FROM site_emails se JOIN sites s/.test(sql)) return { rows: [], rowCount: 0 };
    if (/^SELECT 1 FROM wa_auto_sends LIMIT 1/.test(sql)) { if (S.noTable) { const e = new Error('relation "wa_auto_sends" does not exist'); e.code = '42P01'; throw e; } return { rows: [{ '?column?': 1 }], rowCount: 1 }; }
    if (/FROM orders o WHERE o\.business_id::text = \$1 AND o\.created_at >= \$2 AND o\.is_cancelled IS NOT TRUE/.test(sql)) {
      const rows = S.orders.filter((o) => o.business_id === p[0] && new Date(o.created_at) >= p[1] && !o.is_cancelled && !(S.rows.some((r) => r.business_id === p[0] && r.order_id === o.order_id && r.kind === 'placed') && S.rows.some((r) => r.business_id === p[0] && r.order_id === o.order_id && r.kind === 'tracking'))).slice(0, 100)
        .map((o) => ({ order_id: o.order_id, customer_mobile: o.customer_mobile, created_at: o.created_at }));
      return { rows, rowCount: rows.length };
    }
    if (/^INSERT INTO wa_auto_sends/.test(sql)) {
      const kind = /'placed'/.test(sql) ? 'placed' : 'tracking';
      if (S.rows.some((r) => r.business_id === p[0] && r.order_id === p[1] && r.kind === kind)) return { rows: [], rowCount: 0 };
      S.rows.push({ id: String(++S.seq), business_id: p[0], order_id: p[1], kind, status: p[2], to_number: p[3], error: p[4], code: null, attempts: 0, due_at: kind === 'placed' ? new Date(S.nowMs) : p[5], sent_at: null, wa_id: null });
      return { rows: [], rowCount: 1 };
    }
    if (/ORDER BY w\.updated_at DESC LIMIT 300/.test(sql)) return { rows: S.rows.slice().reverse().slice(0, 300).map((r) => ({ ...r, customer_name: (orderOf(r) || {}).customer_name || null })), rowCount: S.rows.length };
    if (/FROM wa_auto_sends w LEFT JOIN orders o/.test(sql)) {
      S.trackingFlags = (S.trackingFlags || []).concat([p[1]]);
      const rows = S.rows.filter((r) => r.business_id === p[0] && r.status === 'pending' && new Date(r.due_at).getTime() <= S.nowMs && (r.kind === 'placed' || p[1])).sort((a, b) => (a.kind === 'placed' ? 0 : 1) - (b.kind === 'placed' ? 0 : 1)).slice(0, 40).map((r) => {
        const o = orderOf(r);
        return { id: r.id, order_id: r.order_id, kind: r.kind, attempts: r.attempts, due_at: r.due_at, gone: !o, customer_name: o && o.customer_name, customer_mobile: o && o.customer_mobile, created_at: o && o.created_at, is_cancelled: o && o.is_cancelled, tracking_status: o && o.tracking_status, delivered_at: o && o.delivered_at, tracking_token: o && o.tracking_token, tracking_domain: null };
      });
      return { rows, rowCount: rows.length };
    }
    if (/^UPDATE wa_auto_sends SET due_at = now\(\) \+ interval '30 minutes'/.test(sql)) { const r = S.rows.find((x) => x.id === p[0] && x.status === 'pending' && new Date(x.due_at).getTime() <= S.nowMs); if (!r || S.stealClaims) return { rows: [], rowCount: 0 }; r.due_at = new Date(S.nowMs + 30 * 60000); return { rows: [{ id: r.id }], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET status = 'skipped', error = 'Automation was switched off'/.test(sql)) { let n = 0; for (const r of S.rows) if (r.business_id === p[0] && r.status === 'pending') { r.status = 'skipped'; r.error = 'Automation was switched off'; n++; } return { rows: [], rowCount: n }; }
    if (/^UPDATE wa_auto_sends SET status = 'failed', error = \$2, updated_at = now\(\) WHERE id = \$1/.test(sql)) { const r = S.rows.find((x) => x.id === p[0]); r.status = 'failed'; r.error = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET status = 'failed', error = \$2, code = NULL, attempts = attempts \+ 1/.test(sql)) { const r = S.rows.find((x) => x.id === p[0]); Object.assign(r, { status: 'failed', error: p[1], code: null, attempts: r.attempts + 1 }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET status = 'skipped'/.test(sql)) { const r = S.rows.find((x) => x.id === p[0]); r.status = 'skipped'; r.error = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET status = 'failed', error = \$2, attempts = attempts \+ 1, updated_at/.test(sql)) { const r = S.rows.find((x) => x.id === p[0]); r.status = 'failed'; r.error = p[1]; r.attempts++; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET status = 'sent'/.test(sql)) { const r = S.rows.find((x) => x.id === p[0]); Object.assign(r, { status: 'sent', wa_id: p[1], to_number: p[2], template: p[3], body_text: p[4], error: null, attempts: r.attempts + 1, sent_at: new Date(S.nowMs) }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET attempts = attempts \+ 1, error = \$2, code = \$3, due_at = \$4/.test(sql)) { const r = S.rows.find((x) => x.id === p[0]); Object.assign(r, { attempts: r.attempts + 1, error: p[1], code: p[2], due_at: p[3] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET status = 'failed', error = \$2, code = \$3, attempts = attempts \+ 1/.test(sql)) { const r = S.rows.find((x) => x.id === p[0]); Object.assign(r, { status: 'failed', error: p[1], code: p[2], attempts: r.attempts + 1 }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET status = 'pending', attempts = 0/.test(sql)) { const r = S.rows.find((x) => x.id === p[0] && x.status === 'failed'); if (r) Object.assign(r, { status: 'pending', attempts: 0, error: null, due_at: new Date(S.nowMs) }); return { rows: [], rowCount: r ? 1 : 0 }; }
    if (/^UPDATE wa_auto_sends SET status = CASE/.test(sql)) { S.reports = (S.reports || []).concat([p]); const r = S.rows.find((x) => x.wa_id === p[0]); return { rows: [], rowCount: r ? 1 : 0 }; }
    if (/count\(DISTINCT w\.to_number\)::int AS replied/.test(sql)) return { rows: [{ business_id: 'b1', replied: 2 }], rowCount: 1 };
    if (/FROM wa_auto_sends GROUP BY 1, 2, 3/.test(sql)) {
      const m = {}; for (const r of S.rows) { const k = r.business_id + '|' + r.kind + '|' + r.status; m[k] = (m[k] || 0) + 1; }
      const rows = Object.keys(m).map((k) => { const [business_id, kind, status] = k.split('|'); return { business_id, kind, status, n: m[k], n24: m[k] }; });
      return { rows, rowCount: rows.length };
    }
    if (/FROM orders o LEFT JOIN businesses b ON b\.id = o\.business_id WHERE o\.business_id::text = \$1 ORDER BY o\.created_at DESC LIMIT 1/.test(sql)) { const o = S.orders.filter((x) => x.business_id === p[0]).sort((a, b) => b.created_at - a.created_at)[0]; return o ? { rows: [{ order_id: o.order_id, tracking_token: o.tracking_token, tracking_domain: null }], rowCount: 1 } : { rows: [], rowCount: 0 }; }
    if (/^SELECT 1 FROM businesses WHERE id::text = \$1/.test(sql)) return S.panels.some((x) => x.id === p[0]) ? { rows: [{ x: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/^SELECT value FROM chat_settings WHERE key = \$1/.test(sql)) { const v = S.settings[p[0]]; return v == null ? { rows: [], rowCount: 0 } : { rows: [{ value: v }], rowCount: 1 }; }
    throw new Error('fake db query: ' + sql.slice(0, 120));
  },
  queryOne: async (sql, p = []) => { const r = await db.query(sql, p); return r.rows[0] || null; },
};
const fakes = {
  '@/lib/db': db,
  '@/lib/auth': { getAuthFromRequest: (req) => req.__user || null },
  'next/server': { NextResponse: class NextResponse { constructor(body, init = {}) { this.status = init.status || 200; this.body = body; } static json(body, init = {}) { return new NextResponse(body, init); } }, NextRequest: class {} },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (fakes[request]) return request;
  if (request.startsWith('@/')) return origResolve.call(this, path.join(SRC, request.slice(2)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) { if (fakes[request]) return fakes[request]; return origLoad.call(this, request, parent, ...rest); };
global.fetch = async (url, init = {}) => {
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  S.fetches.push({ url, method: init.method || 'GET', body });
  if (/message_templates/.test(url)) return { ok: true, status: 200, json: async () => ({ data: S.metaTemplates.map((t) => ({ ...t })) }) };
  if (/\/messages$/.test(url)) {
    if (S.sendThrow) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (S.sendFail) return { ok: false, status: 400, json: async () => ({ error: { code: S.sendFail.code, message: S.sendFail.message } }) };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.' + (++S.seq) }] }) };
  }
  throw new Error('fake fetch: ' + url);
};
process.env.WHATSAPP_CLOUD_TOKEN = 'tok-secret'; process.env.WHATSAPP_PHONE_NUMBER_ID = '1335396902996145';

const rules = require(path.join(SRC, 'lib/chat/whatsapp-auto-rules.ts'));
const auto = require(path.join(SRC, 'lib/chat/whatsapp-auto.ts'));
const status = require(path.join(SRC, 'lib/chat/whatsapp-auto-status.ts'));
const route = require(path.join(SRC, 'app/api/whatsapp/automation/route.ts'));
const brandRules = require(path.join(SRC, 'lib/chat/whatsapp-brand-rules.ts'));
const tpl = require(path.join(SRC, 'lib/chat/whatsapp-templates.ts'));
const view = require(path.join(SRC, 'lib/chat/whatsapp-auto-view.ts'));
const stop = require(path.join(SRC, 'lib/chat/whatsapp-stop.ts'));
const health = require(path.join(SRC, 'lib/chat/whatsapp-health-rules.ts'));
const OWNER = { username: 'owner', role: 'admin', businessIds: null, permissions: [] };
const AGENT = { username: 'anurag', role: 'agent', businessIds: null, permissions: ['chat.view', 'chat.reply'] };
const jreq = (user, body, url = 'http://x/api/whatsapp/automation') => ({ __user: user, url, json: async () => body, nextUrl: { searchParams: new URL(url).searchParams } });
const eq = assert.strictEqual, deq = assert.deepStrictEqual;
const order = (o) => ({ business_id: 'b1', order_id: '#1553', customer_name: 'AADITYA SHARMA', customer_mobile: '98765 43210', is_cancelled: false, tracking_status: 'Order Placed', delivered_at: null, tracking_token: 'tok-1553', created_at: new Date(IST(13, 11)), ...o });
const turnOn = (id = 'b1', sinceMs = IST(13, 10)) => { S.settings['wa_auto:' + id] = JSON.stringify({ enabled: true, since: new Date(sinceMs).toISOString() }); };
const sends = () => S.fetches.filter((f) => /\/messages$/.test(f.url));
const run = (ms) => { S.nowMs = ms; return auto.runWaAutomation(ms); };

let pass = 0, fail = 0;
async function t(name, fn) {
  reset(); auto.resetTemplateCache(); delete global.__waAutoBusy; delete require('child_process').__x;
  try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 14).join('\n       ')); }
}

(async () => {
  console.log('whatsapp automation: the rules');
  await t('parseAuto: only an explicit ON with a start time counts; junk is OFF', () => {
    eq(rules.parseAuto(JSON.stringify({ enabled: true, since: '2026-10-13T04:30:00.000Z' })).enabled, true);
    deq([rules.parseAuto('').enabled, rules.parseAuto('x').enabled, rules.parseAuto(JSON.stringify({ enabled: true })).enabled, rules.parseAuto(null).since], [false, false, false, null]);
    eq(rules.parseAuto(rules.autoValue(true, IST(13, 10))).since, IST(13, 10));
  });
  await t('eligibleFrom: after the switch went on, never older than 24 hours', () => {
    eq(rules.eligibleFrom(IST(13, 10), IST(13, 12)), IST(13, 10));
    eq(rules.eligibleFrom(IST(1, 10), IST(13, 12)), IST(13, 12) - 24 * 3600 * 1000);
    eq(rules.eligibleFrom(null, IST(13, 12)), IST(13, 12));
  });
  await t('trackingDueMs: 48 hours after the order inside office hours; a night, Saturday afternoon or Sunday waits for the next opening', () => {
    eq(rules.trackingDueMs(IST(13, 11)), IST(15, 11));             // Tue 11:00 -> Thu 11:00
    eq(rules.trackingDueMs(IST(13, 21)), IST(16, 10));             // Tue 21:00 -> Thu 21:00 is night -> Fri 10:00
    eq(rules.trackingDueMs(IST(8, 14, 30)), IST(12, 10));          // Thu 8 Oct 14:30 -> Sat 10 Oct 14:30 closed -> Monday 12 Oct 10:00
    eq(rules.trackingDueMs(IST(8, 11)), IST(10, 11));              // Thu 11:00 -> Sat 11:00 (open)
    eq(rules.trackingDueMs(IST(9, 12)), IST(12, 10));              // Fri 12:00 -> Sunday -> Monday 10:00
    eq(rules.trackingDueMs(IST(13, 11), ['2026-10-15']), IST(16, 10)); // a holiday on the 48th hour
  });
  await t('dueNow: the placed message goes at any hour, the tracking link only in office hours', () => {
    eq(rules.dueNow('placed', IST(13, 1), IST(13, 23)), true);
    eq(rules.dueNow('tracking', IST(13, 1), IST(13, 23)), false);
    eq(rules.dueNow('tracking', IST(13, 1), IST(13, 12)), true);
    eq(rules.dueNow('tracking', IST(14, 1), IST(13, 12)), false);
  });
  await t('params: first name only, one line, nothing empty; the tracking link is the fourth value', () => {
    deq(rules.placedParams({ orderId: '#1553', customerName: '  aaditya   SHARMA\n', trackingLink: null }, { name: 'Vastora', email: 'help@v.test' }), ['Aaditya', '#1553', 'Vastora', 'help@v.test']);
    deq(rules.placedParams({ orderId: '#1', customerName: '', trackingLink: null }, { name: '', email: '' }), ['there', '#1', 'our store', 'our support team']);
    deq(rules.trackingParams({ orderId: '#1553', customerName: 'Rahul', trackingLink: 'https://shiptrack.store/track/abc' }, { name: 'Vastora', email: 'h@v.test' }), ['Rahul', '#1553', 'Vastora', 'https://shiptrack.store/track/abc', 'h@v.test']);
    eq(rules.cleanParam('a\t\tb\r\nc'), 'a b c');
  });
  await t('retryable: a hiccup or a rate limit is tried again, a number that is not on WhatsApp never', () => {
    deq([null, 131056, 130429, 500, 131026, 131047, 132000].map(rules.retryable), [true, true, true, true, false, false, false]);
  });
  await t('the presets: order_placed (header + 4 values) and order_tracking (header + 5 values, never starting or ending on one) are valid Utility templates', () => {
    for (const [P, n] of [[brandRules.ORDER_PLACED_PRESET, 4], [brandRules.ORDER_TRACKING_PRESET, 5]]) {
      const r = tpl.templateSpec(P); eq(r.ok, true, r.error); deq([r.spec.vars, r.spec.category], [n, 'UTILITY']);
      assert.ok(P.header && P.header.length <= 60);
    }
    eq(brandRules.ORDER_TRACKING_PRESET.name, rules.TRACKING_TEMPLATE); eq(brandRules.ORDER_PLACED_PRESET.name, rules.PLACED_TEMPLATE);
  });

  console.log('whatsapp automation: the worker');
  await t('a new order of a switched-on panel: one placed message with the brand words, a tracking row for 48 hours later; old / cancelled / another panel never', async () => {
    turnOn();
    S.orders = [order(), order({ order_id: '#1500', created_at: new Date(IST(13, 9)) }), order({ order_id: '#1501', is_cancelled: true }), order({ business_id: 'b2', order_id: '#9001' })];
    const r = await run(IST(13, 12));
    deq([r.panels, r.queued, r.sent, r.failed], [1, 1, 1, 0]);
    const s = sends(); eq(s.length, 1);
    deq(s[0].body.to, '919876543210');
    deq(s[0].body.template.name, 'order_placed');
    deq(s[0].body.template.components[0].parameters.map((x) => x.text), ['Aaditya', '#1553', 'Vastora', 'help@vastora.test']);
    deq(S.rows.map((x) => [x.order_id, x.kind, x.status]), [['#1553', 'placed', 'sent'], ['#1553', 'tracking', 'pending']]);
    eq(new Date(S.rows[1].due_at).getTime(), IST(15, 11));
    assert.match(S.rows[0].body_text, /Order Placed Successfully\nHi Aaditya, your order #1553 with Vastora/);
    assert.ok(!S.fetches.some((f) => f.url.includes('tok-secret')));
  });
  await t('never twice: running again, even a minute later, sends nothing new', async () => {
    turnOn(); S.orders = [order()];
    await run(IST(13, 12)); await run(IST(13, 12, 1)); await run(IST(13, 12, 2));
    eq(sends().length, 1); eq(S.rows.length, 2);
  });
  await t('OFF means nothing: no rows, no calls; not set up / table missing = idle, never an error', async () => {
    S.orders = [order()];
    eq((await run(IST(13, 12))).idle, 'all_off'); eq(S.rows.length, 0);
    turnOn(); S.noTable = true;
    eq((await run(IST(13, 12))).idle, 'not_installed'); eq(sends().length, 0);
    S.noTable = false; const keep = process.env.WHATSAPP_CLOUD_TOKEN; delete process.env.WHATSAPP_CLOUD_TOKEN;
    eq((await run(IST(13, 12))).idle, 'not_configured'); process.env.WHATSAPP_CLOUD_TOKEN = keep;
  });
  await t('a template Meta has not approved: the rows wait, nothing is sent, and an old order is never messaged late', async () => {
    turnOn(); S.orders = [order()]; S.metaTemplates[0].status = 'PENDING';
    const r = await run(IST(13, 12)); deq([r.queued, r.sent], [1, 0]); eq(sends().length, 0); eq(S.rows[0].status, 'pending');
    S.metaTemplates[0].status = 'APPROVED'; auto.resetTemplateCache();
    const late = await run(IST(14, 13));                      // the 24 hours are over: skipped, not sent
    eq(late.sent, 0); deq([S.rows[0].status, S.rows[0].error], ['skipped', rules.SKIP.tooOld]); eq(sends().length, 0);
  });
  await t('the tracking link: held until 48 hours, held outside office hours, sent with the order\'s own link', async () => {
    turnOn(); S.orders = [order()];
    await run(IST(13, 12));
    await run(IST(15, 10, 59)); eq(sends().length, 1);                     // not yet
    await run(IST(15, 21));       eq(sends().length, 1);                     // due, but the office is closed
    const r = await run(IST(15, 11, 5));
    eq(r.sent, 1); eq(sends().length, 2);
    const b = sends()[1].body; eq(b.template.name, 'order_tracking');
    deq(b.template.components[0].parameters.map((x) => x.text), ['Aaditya', '#1553', 'Vastora', 'https://shiptrack.store/track/tok-1553', 'help@vastora.test']);
    eq(S.rows[1].status, 'sent');
  });
  await t('the tracking link is skipped when the order was cancelled or delivered meanwhile, or has no link', async () => {
    turnOn(); S.orders = [order(), order({ order_id: '#1554' }), order({ order_id: '#1555' })];
    await run(IST(13, 12));
    S.orders[0].is_cancelled = true; S.orders[1].tracking_status = 'Delivered'; S.orders[2].tracking_token = null;
    const r = await run(IST(15, 11, 5));
    eq(r.skipped, 3); eq(sends().filter((x) => x.body.template.name === 'order_tracking').length, 0);
    deq(S.rows.filter((x) => x.kind === 'tracking').map((x) => x.error), [rules.SKIP.cancelled, rules.SKIP.delivered, rules.SKIP.noLink]);
  });
  await t('a number that is not a number is Skipped with the reason, both rows', async () => {
    turnOn(); S.orders = [order({ customer_mobile: '12345' })];
    await run(IST(13, 12));
    deq(S.rows.map((x) => [x.kind, x.status, x.error]), [['placed', 'skipped', rules.SKIP.noNumber], ['tracking', 'skipped', rules.SKIP.noNumber]]); eq(sends().length, 0);
  });
  await t('STOP: a number that wrote STOP is Skipped with the reason, nobody else is touched; START (stopped:false) messages it again', async () => {
    turnOn(); S.settings['wa_stop:919876543210'] = JSON.stringify({ stopped: true, at: 'x' });
    S.orders = [order(), order({ order_id: '#1554', customer_mobile: '9811122233' })];
    await run(IST(13, 12));
    deq(S.rows.filter((x) => x.kind === 'placed').map((x) => [x.order_id, x.status, x.error]), [['#1553', 'skipped', rules.SKIP.stopped], ['#1554', 'sent', null]]);
    deq(sends().map((x) => x.body.to), ['919811122233']);
    S.settings['wa_stop:919876543210'] = JSON.stringify({ stopped: false, at: 'y' });
    S.orders.push(order({ order_id: '#1555' }));
    await run(IST(13, 13));
    eq(S.rows.find((x) => x.order_id === '#1555' && x.kind === 'placed').status, 'sent');
  });
  await t('waKeyword: only the whole message counts (English, Hinglish, Hindi); a question with "stop" in it never', () => {
    for (const x of ['STOP', 'Stop.', ' stop ', 'Unsubscribe', 'band karo', 'Band kar do!!', 'message mat bhejo', 'Msg mat bhejo', 'बंद करो', 'please stop', "don't message me", 'opt-out']) eq(stop.waKeyword(x), 'stop', x);
    for (const x of ['START', 'Start', 'chalu karo']) eq(stop.waKeyword(x), 'start', x);
    for (const x of ['when will it stop?', 'stop calling me about refund I want my money', 'my order', 'bus stop road delivery', '', null, 'band hai kya shop']) eq(stop.waKeyword(x), null, String(x));
    deq([stop.parseStop('{"stopped":true}'), stop.parseStop('{"stopped":false}'), stop.parseStop('junk')], [true, false, false]);
  });
  await t('number health: what the quality, the status, the daily limit and the failures mean', () => {
    const base = { quality: 'GREEN', status: 'CONNECTED', tier: 'TIER_250', limit: 250, limitFrom: 'meta', used24h: 12, failedToday: 0, waitingToday: 3, stopped: 0, phoneError: null };
    deq([health.tierLimit('TIER_250'), health.tierLimit('tier_1k'), health.tierLimit('TIER_UNLIMITED'), health.tierLimit('junk')], [250, 1000, null, null]);
    deq(health.waHealthLines(base), []);
    deq(health.waHealthLines({ ...base, quality: 'YELLOW' }).map((l) => l.tone), ['warn']);
    deq(health.waHealthLines({ ...base, quality: 'RED', status: 'FLAGGED' }).map((l) => l.tone), ['danger', 'danger']);
    assert.match(health.waHealthLines({ ...base, used24h: 180 })[0].text, /72% used: 180 of 250/);
    eq(health.waHealthLines({ ...base, used24h: 230 })[0].tone, 'danger');
    assert.match(health.waHealthLines({ ...base, failedToday: 2 })[0].text, /2 automation messages failed today/);
    eq(health.waHealthLines({ ...base, limit: null, used24h: 9999 }).length, 0);
    eq(health.waHealthLines({ ...base, phoneError: 'token expired' })[0].tone, 'warn');
  });
  await t('a refusal that cannot change (not on WhatsApp) fails at once; a hiccup is tried again 3 times then fails; Send again queues it', async () => {
    turnOn(); S.orders = [order()];
    S.sendFail = { code: 131026, message: 'Message undeliverable' };
    await run(IST(13, 12)); deq([S.rows[0].status, S.rows[0].code, S.rows[0].attempts], ['failed', 131026, 1]);
    reset(); auto.resetTemplateCache(); turnOn(); S.orders = [order()]; S.sendFail = { code: 131056, message: 'Pair rate limit hit' };
    await run(IST(13, 12)); deq([S.rows[0].status, S.rows[0].attempts], ['pending', 1]);
    await run(IST(13, 12, 5)); eq(sends().length, 1);                          // the 10-minute wait
    await run(IST(13, 12, 11)); deq([S.rows[0].status, S.rows[0].attempts], ['pending', 2]);
    await run(IST(13, 12, 22)); deq([S.rows[0].status, S.rows[0].attempts], ['failed', 3]);
    S.sendFail = null;
    eq(await auto.retryFailed('1'), true); eq(await auto.retryFailed('1'), false);
    await run(IST(13, 12, 30)); eq(S.rows[0].status, 'sent');
  });
  await t('at most 15 sends a minute; the rest go the next minute', async () => {
    turnOn(); S.orders = Array.from({ length: 20 }, (_, i) => order({ order_id: '#2' + String(100 + i), customer_mobile: '98765432' + String(10 + i) }));
    await run(IST(13, 12)); eq(sends().length, 15);
    await run(IST(13, 12, 1)); eq(sends().length, 20);
  });
  await t('every panel the same: a second panel switched on gets its own brand words and only its own orders', async () => {
    turnOn('b1'); turnOn('b2'); S.orders = [order(), order({ business_id: 'b2', order_id: '#9001', customer_mobile: '9811122233' })];
    S.settings['wa_brand:b2'] = JSON.stringify({ name: 'VASTRIKA', email: 'care@vastrika.test' });
    await run(IST(13, 12));
    eq(sends().length, 2);
    const b2 = sends().find((x) => x.body.to === '919811122233');
    deq(b2.body.template.components[0].parameters.map((x) => x.text), ['Aaditya', '#9001', 'VASTRIKA', 'care@vastrika.test']);
  });
  await t('review fixes: a brand with no support email fails loudly instead of "email us at our support team"', async () => {
    turnOn('b2'); S.orders = [order({ business_id: 'b2', order_id: '#9001' })];
    await run(IST(13, 12));
    eq(sends().length, 0); deq([S.rows[0].status, /support email/.test(S.rows[0].error)], ['failed', true]);
  });
  await t('review fixes: a row another server process already claimed is never sent here', async () => {
    turnOn(); S.orders = [order()]; S.stealClaims = true;
    await run(IST(13, 12)); eq(sends().length, 0); eq(S.rows[0].status, 'pending');
  });
  await t('review fixes: a timeout is never sent again by itself (Meta may have taken it)', async () => {
    turnOn(); S.orders = [order()]; S.sendThrow = true;
    await run(IST(13, 12)); deq([S.rows[0].status, /may still have been delivered/.test(S.rows[0].error)], ['failed', true]);
    S.sendThrow = false; await run(IST(13, 12, 15)); eq(sends().length, 1);
  });
  await t('review fixes: 60 waiting tracking rows never hold back a new order-placed message; tracking rows are asked for only when they can go', async () => {
    turnOn(); S.metaTemplates[1].status = 'PENDING';
    S.orders = Array.from({ length: 60 }, (_, i) => order({ order_id: '#3' + String(100 + i), created_at: new Date(IST(11, 11)), customer_mobile: '98765432' + String(10 + (i % 80)) }));
    for (const o of S.orders) { S.rows.push({ id: String(++S.seq), business_id: 'b1', order_id: o.order_id, kind: 'placed', status: 'sent', to_number: '91' + o.customer_mobile, attempts: 1, due_at: new Date(IST(11, 11)) }, { id: String(++S.seq), business_id: 'b1', order_id: o.order_id, kind: 'tracking', status: 'pending', to_number: '91' + o.customer_mobile, attempts: 0, due_at: new Date(IST(13, 11)) }); }
    S.orders.push(order({ order_id: '#4000' }));
    await run(IST(13, 12));
    eq(sends().length, 1); eq(sends()[0].body.template.name, 'order_placed'); eq(S.trackingFlags.slice(-1)[0], false);
    S.metaTemplates[1].status = 'APPROVED'; auto.resetTemplateCache();
    await run(IST(13, 12, 1)); eq(S.trackingFlags.slice(-1)[0], true);
  });
  await t('review fixes: switching OFF drops the waiting messages, so switching ON later sends nothing old', async () => {
    turnOn(); S.orders = [order()]; await run(IST(13, 12));
    eq(S.rows[1].status, 'pending');
    await auto.saveAuto('b1', false, IST(13, 13));
    deq([S.rows[1].status, S.rows[1].error], ['skipped', 'Automation was switched off']);
    await auto.saveAuto('b1', true, IST(14, 10)); await run(IST(15, 11, 5));
    eq(sends().length, 1);
  });
  await t('review fixes: the phone fallback strips every non-digit in SQL (\\D, not the letter D)', () => {
    assert.match(fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-inbound.ts'), 'utf8'), /regexp_replace\(o\.customer_mobile, '\\\\D', '', 'g'\)/);
  });
  await t('a delivery report goes to the row by the message id, never moving it backwards; the webhook path imports only the small status module', async () => {
    turnOn(); S.orders = [order()]; await run(IST(13, 12));
    const id = S.rows[0].wa_id; assert.ok(id);
    eq(await status.noteAutoStatus(id, 'delivered', null), true);
    eq(await status.noteAutoStatus('wamid.none', 'read', null), false);
    eq(await status.noteAutoStatus(id, 'bogus', null), false);
    deq(S.reports[0], [id, 'delivered', null]);
    const src = fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-auto-status.ts'), 'utf8');
    assert.match(src, /WHEN \$2 = 'delivered' AND status IN \('pending', 'sent'\)/); assert.match(src, /WHEN \$2 = 'failed' THEN 'failed'/);
    assert.match(fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-inbound.ts'), 'utf8'), /from '\.\/whatsapp-auto-status'/);
  });

  console.log('whatsapp automation: the route');
  await t('GET: Super Admin only; counts per panel, the templates\' state, masked numbers', async () => {
    eq((await route.GET(jreq(AGENT, {}))).status, 401); eq((await route.GET(jreq(null, {}))).status, 401);
    turnOn(); S.orders = [order()]; await run(IST(13, 12));
    const g = await route.GET(jreq(OWNER, {}));
    deq([g.status, g.body.installed, g.body.configured, g.body.templates.placed, g.body.templates.tracking], [200, true, true, 'APPROVED', 'APPROVED']);
    const p = g.body.panels.find((x) => x.id === 'b1');
    deq([p.enabled, p.placed.sent, p.tracking.pending, p.replied], [true, 1, 1, 2]);
    eq(g.body.recent[0].to, '••••3210'); assert.ok(!JSON.stringify(g.body).includes('9876543210'));
    eq(g.body.recent[0].name, 'AADITYA SHARMA');
  });
  await t('POST: the switch needs the table and an APPROVED order_placed; ON starts the clock; OFF keeps the rows; a viewer is refused', async () => {
    eq((await route.POST(jreq(AGENT, { businessId: 'b1', enabled: true }))).status, 401);
    eq((await route.POST(jreq(OWNER, { businessId: 'nope', enabled: true }))).status, 404);
    eq((await route.POST(jreq(OWNER, { businessId: 'b1' }))).status, 400);
    S.noTable = true; let r = await route.POST(jreq(OWNER, { businessId: 'b1', enabled: true }));
    deq([r.status, /whatsapp-automation\.sql/.test(r.body.error)], [409, true]); S.noTable = false;
    S.metaTemplates[0].status = 'PENDING'; r = await route.POST(jreq(OWNER, { businessId: 'b1', enabled: true }));
    deq([r.status, /pending/.test(r.body.error)], [409, true]); S.metaTemplates[0].status = 'APPROVED';
    r = await route.POST(jreq(OWNER, { businessId: 'b1', enabled: true }));
    deq([r.status, r.body.enabled], [200, true]); assert.ok(r.body.since);
    eq(auto.loadAutoSettings && (await auto.loadAutoSettings()).get('b1').enabled, true);
    r = await route.POST(jreq(OWNER, { businessId: 'b1', enabled: false })); deq([r.status, r.body.enabled], [200, false]);
  });
  await t('POST retry: only a Failed message can go again', async () => {
    turnOn(); S.orders = [order()]; S.sendFail = { code: 131026, message: 'x' }; await run(IST(13, 12)); S.sendFail = null;
    eq((await route.POST(jreq(OWNER, { action: 'retry', id: 'abc' }))).status, 400);
    eq((await route.POST(jreq(OWNER, { action: 'retry', id: '2' }))).status, 409);      // the tracking row is still pending
    const r = await route.POST(jreq(OWNER, { action: 'retry', id: '1' })); eq(r.status, 200); eq(S.rows[0].status, 'pending');
  });
  await t('POST test: both messages of a brand to the owner\'s number, filled from its latest order; nothing recorded; a bad number or panel refused', async () => {
    S.orders = [order(), order({ order_id: '#1560', created_at: new Date(IST(13, 11, 30)) })];
    eq((await route.POST(jreq(AGENT, { action: 'test', businessId: 'b1', to: '9289144767' }))).status, 401);
    eq((await route.POST(jreq(OWNER, { action: 'test', businessId: 'nope', to: '9289144767' }))).status, 404);
    eq((await route.POST(jreq(OWNER, { action: 'test', businessId: 'b1', to: '12' }))).status, 400);
    const r = await route.POST(jreq(OWNER, { action: 'test', businessId: 'b1', to: '92891 44767', name: 'Aaditya\n' }));
    deq([r.status, r.body.order, r.body.results.map((x) => [x.kind, x.ok])], [200, '#1560', [['placed', true], ['tracking', true]]]);
    const s2 = sends(); eq(s2.length, 2); eq(s2[0].body.to, '919289144767');
    deq(s2[0].body.template.components[0].parameters.map((x) => x.text), ['Aaditya', '#1560', 'Vastora', 'help@vastora.test']);
    eq(s2[1].body.template.components[0].parameters[3].text, 'https://shiptrack.store/track/tok-1553');
    eq(S.rows.length, 0);
    S.metaTemplates[1].status = 'PENDING';
    const r2 = await route.POST(jreq(OWNER, { action: 'test', businessId: 'b1', to: '9289144767' }));
    deq(r2.body.results.map((x) => [x.kind, x.ok, x.error]), [['placed', true, null], ['tracking', false, 'Template not approved by Meta yet']]);
  });
  await t('the minute cron route starts the automation, not awaited, before the mailbox sweep', () => {
    const src = fs.readFileSync(path.join(SRC, 'app/api/cron/chat-email-poll/route.ts'), 'utf8');
    assert.match(src, /void runWaAutomation\(\)/); assert.match(src, /setTimeout\(\(\) => \{ void runWaAutomation\(\)[\s\S]*30_000\)/); assert.ok(src.indexOf('runWaAutomation()') < src.indexOf('pollAllMailboxes()'));
  });
  await t('the SQL file is additive: IF NOT EXISTS, a unique key per panel / order / kind, grants without DELETE', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../whatsapp-automation.sql'), 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS wa_auto_sends/); assert.match(sql, /UNIQUE \(business_id, order_id, kind\)/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON wa_auto_sends TO tracker_user/); assert.ok(!/\bDELETE\b/.test(sql.replace(/-- never DELETE[^\n]*/, '')));
    assert.ok(!/DROP |TRUNCATE /i.test(sql));
  });

  await t('the Automation list: one line per order (both messages side by side), brand / filter / search with counts', () => {
    const R = (id, panel_id, order_id, kind, status, due, extra = {}) => ({ id, panel: panel_id === 'v' ? 'VASTRIKA' : 'kurtiya', panel_id, order_id, name: null, kind, status, to: '••••3210', error: null, code: null, attempts: 0, due_at: due, sent_at: null, ...extra });
    const rows = [
      R('1', 'v', '#2473', 'tracking', 'pending', '2026-10-12T10:00:00Z'), R('2', 'v', '#2473', 'placed', 'read', '2026-10-10T13:30:00Z', { name: 'Asmita' }),
      R('3', 'v', '#2468', 'placed', 'delivered', '2026-10-10T09:00:00Z'), R('4', 'v', '#2468', 'tracking', 'read', '2026-10-12T09:00:00Z'),
      R('5', 'k', '#2473', 'placed', 'failed', '2026-10-10T14:00:00Z', { error: 'Not a WhatsApp number', name: 'Ravi' }),
      R('6', 'k', '#2470', 'placed', 'skipped', '2026-10-10T11:00:00Z'),
    ];
    const lines = view.groupOrders(rows);
    deq(lines.map((l) => [l.panelId, l.orderId, l.placed && l.placed.status, l.tracking && l.tracking.status]),
      [['k', '#2473', 'failed', null], ['v', '#2473', 'read', 'pending'], ['k', '#2470', 'skipped', null], ['v', '#2468', 'delivered', 'read']]);
    eq(lines[1].name, 'Asmita');
    const f = (panel, show, q = '') => view.filterOrders(lines, { panel, show, q }).map((l) => l.panelId + l.orderId);
    deq(f('v', 'all'), ['v#2473', 'v#2468']);
    deq(f('all', 'failed'), ['k#2473']); deq(f('all', 'waiting'), ['v#2473']); deq(f('all', 'sent'), ['v#2468']); deq(f('all', 'skipped'), ['k#2470']);
    deq(f('all', 'all', '2473'), ['k#2473', 'v#2473']); deq(f('all', 'all', '#2468'), ['v#2468']); deq(f('all', 'all', 'ravi'), ['k#2473']);
    eq(f('all', 'all', '3210').length, 4); eq(f('all', 'all', '32').length, 0);
    deq(view.countByPanel(lines, { show: 'all', q: '' }), { all: 4, v: 2, k: 2 });
    deq(view.countByShow(lines, { panel: 'k', q: '' }), { all: 2, failed: 1, waiting: 0, sent: 0, skipped: 1 });
  });

  console.log(`WHATSAPP AUTOMATION: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
