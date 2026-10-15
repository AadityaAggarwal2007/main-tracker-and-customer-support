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
    nowMs: IST(13, 12), noTable: false, slotBusy: false, slots: 0, sendFail: null, sendThrow: false, stealClaims: false, trackingFlags: [], reports: [], fetches: [], seq: 0,
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
const msgAt = (r) => new Date(r.sent_at || (r.status === 'pending' ? r.due_at : (r.updated_at || r.due_at))).getTime();
const orderOf = (r) => S.orders.find((o) => o.business_id === r.business_id && o.order_id === r.order_id);
const db = {
  query: async (rawSql, p = []) => {
    const sql = norm(rawSql);
    if (S.noTable && /wa_auto_sends/.test(sql)) { const e = new Error('relation "wa_auto_sends" does not exist'); e.code = '42P01'; throw e; }
    if (/^SELECT key, value FROM chat_settings WHERE key LIKE 'wa_auto:%'/.test(sql)) { const rows = Object.keys(S.settings).filter((k) => k.startsWith('wa_auto:')).map((k) => ({ key: k, value: S.settings[k] })); return { rows, rowCount: rows.length }; }
    if (/FROM chat_settings WHERE key LIKE 'wa_brand:%'/.test(sql)) { const rows = Object.keys(S.settings).filter((k) => k.startsWith('wa_brand:')).map((k) => ({ key: k, value: S.settings[k] })); return { rows, rowCount: rows.length }; }
    // owner 15 Oct: the send slot (one order message per 30 s) and the 130429 handling
    if (/^INSERT INTO chat_settings \(key, value, updated_at\) VALUES \(\$1, \$2, now\(\)\) ON CONFLICT \(key\) DO NOTHING$/.test(sql)) { if (!(p[0] in S.settings)) S.settings[p[0]] = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE chat_settings SET value = to_char\(clock_timestamp\(\)/.test(sql)) { S.slotEvery = p[1]; if (S.slotBusy) return { rows: [], rowCount: 0 }; S.slots++; return { rows: [{ key: p[0] }], rowCount: 1 }; }
    if (/^INSERT INTO chat_settings/.test(sql)) { S.settings[p[0]] = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^SELECT key FROM chat_settings WHERE key LIKE \$1 AND \(CASE/.test(sql)) { const pre = p[0].replace('%', ''); const rows = Object.keys(S.settings).filter((k) => k.startsWith(pre) && !JSON.parse(S.settings[k]).done).map((key) => ({ key })); return { rows, rowCount: rows.length }; }
    if (/^SELECT value FROM chat_settings WHERE key LIKE \$1 AND \(CASE/.test(sql)) { const pre = p[0].replace('%', ''); const rows = Object.keys(S.settings).filter((k) => k.startsWith(pre) && !JSON.parse(S.settings[k]).done).map((key) => ({ value: S.settings[key] })); return { rows, rowCount: rows.length }; }
    if (/^UPDATE chat_settings SET value = \(value::jsonb \|\| '\{"done":true\}'::jsonb\)::text/.test(sql)) { const v = S.settings[p[0]]; if (!v || JSON.parse(v).done) return { rows: [], rowCount: 0 }; S.settings[p[0]] = JSON.stringify({ ...JSON.parse(v), done: true }); return { rows: [{ value: S.settings[p[0]] }], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET status = 'pending', due_at = now\(\), updated_at = now\(\) WHERE status = 'failed' AND \(code = \$1 OR error LIKE '130429%'\)/.test(sql)) { let n = 0; for (const r of S.rows) if (r.status === 'failed' && (r.code === p[0] || /^130429/.test(r.error || '')) && r.attempts < p[1]) { Object.assign(r, { status: 'pending', due_at: new Date(S.nowMs) }); n++; } return { rows: [], rowCount: n }; }
    if (/^UPDATE wa_auto_sends SET status = \$5, attempts = attempts \+ 1, error = \$2, code = \$3, due_at = \$4/.test(sql)) { const r = S.rows.find((x) => x.id === p[0]); Object.assign(r, { status: p[4], attempts: r.attempts + 1, error: p[1], code: p[2], due_at: p[3] }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET status = CASE WHEN attempts >= \$3/.test(sql)) { const r = S.rows.find((x) => x.wa_id === p[0] && ['pending', 'sent'].includes(x.status)); if (r) Object.assign(r, { status: r.attempts >= p[2] ? 'failed' : 'pending', due_at: new Date(S.nowMs + p[3]), error: p[1], code: 130429 }); return { rows: [], rowCount: r ? 1 : 0 }; }
    if (/^UPDATE wa_auto_sends SET status = 'skipped', error = \$3, updated_at = now\(\) WHERE business_id = \$1 AND order_id = \$2 AND kind = 'tracking'/.test(sql)) { let n = 0; for (const r of S.rows) if (r.business_id === p[0] && r.order_id === p[1] && r.kind === 'tracking' && r.status === 'pending') { r.status = 'skipped'; r.error = p[2]; n++; } return { rows: [], rowCount: n }; }
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
      S.rows.push({ id: String(++S.seq), business_id: p[0], order_id: p[1], kind, status: p[2], to_number: p[3], error: p[4], code: null, attempts: 0, due_at: kind === 'placed' ? new Date(S.nowMs) : p[5], sent_at: null, wa_id: null, updated_at: new Date(S.nowMs) });
      return { rows: [], rowCount: 1 };
    }
    if (/ORDER BY at DESC LIMIT 4001/.test(sql)) {
      const inR = (r) => { const t = msgAt(r); return t >= p[0].getTime() && t < p[1].getTime(); };
      const hit = new Set(S.rows.filter(inR).map((r) => r.business_id + '|' + r.order_id));
      const rows = S.rows.filter((r) => hit.has(r.business_id + '|' + r.order_id)).sort((a, b) => msgAt(b) - msgAt(a))
        .map((r) => ({ ...r, at: new Date(msgAt(r)), in_range: inR(r), customer_name: (orderOf(r) || {}).customer_name || null, order_at: (orderOf(r) || {}).created_at || null }));
      return { rows, rowCount: rows.length };
    }
    if (/FROM orders o LEFT JOIN wa_auto_sends w ON w\.business_id = o\.business_id::text AND w\.order_id = o\.order_id AND w\.kind = 'placed' WHERE o\.created_at >= \$1 AND o\.created_at < \$2 GROUP BY 1/.test(sql)) {
      const since = JSON.parse(p[2]); const m = {};
      for (const o of S.orders.filter((x) => new Date(x.created_at) >= p[0] && new Date(x.created_at) < p[1])) {
        const x = m[o.business_id] || (m[o.business_id] = { business_id: o.business_id, total: 0, cancelled: 0, queued: 0, before_on: 0 });
        const q = S.rows.some((r) => r.business_id === o.business_id && r.order_id === o.order_id && r.kind === 'placed');
        x.total++; if (o.is_cancelled) x.cancelled++; if (q) x.queued++;
        if (!q && !o.is_cancelled && since[o.business_id] && new Date(o.created_at) < new Date(since[o.business_id])) x.before_on++;
      }
      return { rows: Object.values(m), rowCount: Object.keys(m).length };
    }
    if (/FROM wa_auto_sends w LEFT JOIN orders o/.test(sql)) {
      S.trackingFlags = (S.trackingFlags || []).concat([p[1]]);
      const rows = S.rows.filter((r) => r.business_id === p[0] && r.status === 'pending' && new Date(r.due_at).getTime() <= S.nowMs && (r.kind === 'placed' || p[1])).sort((a, b) => (a.kind === 'placed' ? 0 : 1) - (b.kind === 'placed' ? 0 : 1)).slice(0, 40).map((r) => {
        const o = orderOf(r);
        const placed = S.rows.find((x) => x.business_id === r.business_id && x.order_id === r.order_id && x.kind === 'placed');
        return { id: r.id, order_id: r.order_id, kind: r.kind, attempts: r.attempts, due_at: r.due_at, placed_template: placed ? placed.template || null : null, gone: !o, customer_name: o && o.customer_name, customer_mobile: o && o.customer_mobile, created_at: o && o.created_at, is_cancelled: o && o.is_cancelled, tracking_status: o && o.tracking_status, delivered_at: o && o.delivered_at, tracking_token: o && o.tracking_token, tracking_domain: null };
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
    if (/^SELECT w\.kind, w\.status, count\(\*\)::int AS n FROM wa_auto_sends w WHERE COALESCE/.test(sql)) {
      // the India day of S.nowMs
      const from = Math.floor((S.nowMs + 330 * 60000) / 86400000) * 86400000 - 330 * 60000;
      const m = {}; for (const r of S.rows) { const t = msgAt(r); if (t >= from && t < from + 86400000) { const k = r.kind + '|' + r.status; m[k] = (m[k] || 0) + 1; } }
      const rows = Object.keys(m).map((k) => ({ kind: k.split('|')[0], status: k.split('|')[1], n: m[k] }));
      return { rows, rowCount: rows.length };
    }
    if (/count\(DISTINCT x\.digits\)::int AS n, \(count\(DISTINCT x\.digits\) FILTER \(WHERE x\.at >= /.test(sql)) return { rows: [{ n: 613, today: 311 }], rowCount: 1 };
    if (/AS failed, \(count\(\*\) FILTER \(WHERE status = 'pending'\)\)::int AS waiting FROM wa_auto_sends/.test(sql)) return { rows: [{ failed: 0, waiting: S.rows.filter((r) => r.status === 'pending').length }], rowCount: 1 };
    if (/FROM wa_auto_sends GROUP BY 1, 2, 3|FROM wa_auto_sends w GROUP BY 1, 2, 3/.test(sql)) {
      const m = {}, mi = {}; for (const r of S.rows) { const k = r.business_id + '|' + r.kind + '|' + r.status; m[k] = (m[k] || 0) + 1; const t = msgAt(r); if (t >= p[0].getTime() && t < p[1].getTime()) mi[k] = (mi[k] || 0) + 1; }
      const rows = Object.keys(m).map((k) => { const [business_id, kind, status] = k.split('|'); return { business_id, kind, status, n: m[k], nin: mi[k] || 0 }; });
      return { rows, rowCount: rows.length };
    }
    if (/FROM orders o LEFT JOIN businesses b ON b\.id = o\.business_id WHERE o\.business_id::text = \$1 ORDER BY o\.created_at DESC LIMIT 1/.test(sql)) { const o = S.orders.filter((x) => x.business_id === p[0]).sort((a, b) => b.created_at - a.created_at)[0]; return o ? { rows: [{ order_id: o.order_id, tracking_token: o.tracking_token, tracking_domain: null }], rowCount: 1 } : { rows: [], rowCount: 0 }; }
    if (/^SELECT 1 FROM businesses WHERE id::text = \$1/.test(sql)) return S.panels.some((x) => x.id === p[0]) ? { rows: [{ x: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/^SELECT count\(\*\)::text AS n FROM chat_settings WHERE key LIKE \$1/.test(sql)) { const pre = p[0].replace('%', ''); const n = String(Object.keys(S.settings).filter((k) => k.startsWith(pre) && !JSON.parse(S.settings[k]).done).length); return { rows: [{ n }], rowCount: 1 }; }
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
    const realNow = Date.now; Date.now = () => S.nowMs;
    let g; try { g = await route.GET(jreq(OWNER, {})); } finally { Date.now = realNow; }
    deq([g.status, g.body.installed, g.body.configured, g.body.templates.placed, g.body.templates.tracking], [200, true, true, 'APPROVED', 'APPROVED']);
    const p = g.body.panels.find((x) => x.id === 'b1');
    deq([p.enabled, p.placed.sent, p.tracking.pending, p.replied], [true, 1, 1, 2]);
    deq([p.placedIn.sent, p.trackingIn.pending, p.orders.total, p.orders.queued], [1, 0, 1, 1]);   // the tracking link is due on the 15th
    eq(g.body.range.day, 'today'); eq(g.body.recent.length, 2);
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


  await t('the date filter (owner 11 Oct): India days, night hours, per-hour counts, why not sent, the list per day', async () => {
    const now = IST(11, 15, 30);
    const r0 = view.dayRange(null, now); deq([r0.day, r0.from, r0.to], ['today', IST(11, 0), IST(12, 0)]);
    const y = view.dayRange('yesterday', now); deq([y.from, y.to], [IST(10, 0), IST(11, 0)]);
    const w = view.dayRange('7d', now); deq([w.from, w.to], [IST(5, 0), IST(12, 0)]);
    const d = view.dayRange('2026-10-09', now); deq([d.day, d.from, d.to], ['2026-10-09', IST(9, 0), IST(10, 0)]);
    eq(view.dayRange('2026-10-20', now).day, 'today'); eq(view.dayRange('junk', now).day, 'today');
    eq(view.dayRange(null, IST(11, 0, 10)).from, IST(11, 0));                  // just after India midnight = the new day
    eq(view.istDate(IST(11, 23, 59)), '2026-10-11'); eq(view.istDate(IST(12, 0, 1)), '2026-10-12');
    deq([IST(11, 9, 59), IST(11, 10), IST(11, 19, 29), IST(11, 19, 30), IST(11, 23)].map(view.isNight), [true, false, false, true, true]);

    const R = (id, order_id, kind, status, atMs, extra = {}) => ({ id, panel: 'VASTRIKA', panel_id: 'v', order_id, name: null, kind, status, to: '••••3210', error: null, code: null, attempts: 0, due_at: new Date(atMs).toISOString(), sent_at: null, at: new Date(atMs).toISOString(), in_range: true, ...extra });
    const rows = [
      R('1', '#1', 'placed', 'read', IST(11, 23, 10), { order_at: new Date(IST(11, 23, 9)).toISOString() }),
      R('2', '#2', 'placed', 'delivered', IST(11, 11, 5)), R('3', '#2', 'tracking', 'pending', IST(13, 11, 5), { in_range: false }),
      R('4', '#3', 'placed', 'failed', IST(11, 11, 40), { error: 'Not a WhatsApp number', code: 131026 }),
      R('5', '#4', 'placed', 'failed', IST(11, 11, 50), { error: 'Not a WhatsApp number', code: 131026 }),
      R('6', '#5', 'placed', 'skipped', IST(11, 2, 0), { error: 'The order has no phone number' }),
      R('7', '#6', 'tracking', 'sent', IST(11, 12, 0)), R('8', '#6', 'placed', 'read', IST(9, 22, 0), { in_range: false }),
    ];
    const rg = { from: IST(11, 0), to: IST(12, 0) };
    const hb = view.hourBuckets(rows, rg);
    deq([hb[23], hb[11], hb[2], hb[12]].map((h) => [h.went, h.failed, h.skipped]), [[1, 0, 0], [1, 2, 0], [0, 0, 1], [1, 0, 0]]);
    eq(hb.reduce((n, h) => n + h.went + h.failed + h.skipped, 0), 6);             // the out-of-range rows never count
    deq(view.reasonCounts(rows, rg), [{ status: 'failed', reason: 'Not a WhatsApp number [131026]', n: 2 }, { status: 'skipped', reason: 'The order has no phone number', n: 1 }]);
    const lines = view.groupOrders(rows);
    const f = (time) => view.filterOrders(lines, { panel: 'all', show: 'all', q: '', time }).map((l) => l.orderId).sort();
    deq(f('night'), ['#1', '#5']);                // order #6's night message was on the 9th: not this day
    deq(f('day'), ['#2', '#3', '#4', '#6']); eq(f('all').length, 6);
    deq(view.countByTime(lines, { panel: 'all', show: 'all', q: '' }), { all: 6, night: 2, day: 4 });
    eq(lines.find((l) => l.orderId === '#1').orderAt, new Date(IST(11, 23, 9)).toISOString());
    assert.match(view.whyLine(rows[0], rows[0].order_at), /the order came in 11 Oct, 11:09 pm/i);
    assert.match(view.whyLine(rows[6], null), /48 hours old/);
  });
  await t('the overview for a chosen day: counts of that day, the orders that came in and why some got nothing, every message of that day', async () => {
    turnOn('b1', IST(13, 10, 30));
    S.orders = [order({ order_id: '#1', created_at: new Date(IST(13, 10)) }), order({ order_id: '#2', created_at: new Date(IST(13, 11)) }),
      order({ order_id: '#3', created_at: new Date(IST(13, 11, 5)), is_cancelled: true }), order({ order_id: '#9', created_at: new Date(IST(12, 11)) })];
    await run(IST(13, 12));
    const o = await auto.automationOverview('2026-10-13', IST(13, 18));
    const p = o.panels.find((x) => x.id === 'b1');
    deq([p.orders.total, p.orders.cancelled, p.orders.queued, p.orders.beforeOn], [3, 1, 1, 1]);   // #1 came before ON, #3 cancelled
    deq([p.placedIn.sent, p.placed.sent], [1, 1]);
    deq(o.recent.map((r) => [r.order_id, r.kind, r.in_range]).sort(), [['#2', 'placed', true], ['#2', 'tracking', false]]);
    eq(o.recent[0].order_at !== undefined, true); eq(o.capped, false); eq(o.range.day, '2026-10-13');
    const y = await auto.automationOverview('2026-10-12', IST(13, 18));
    deq([y.recent.length, y.panels.find((x) => x.id === 'b1').orders.total, y.panels.find((x) => x.id === 'b1').placedIn.sent], [0, 1, 0]);
  });
  await t('the Today board: today\'s automation (India day): sent / read per message, failed, skipped, still to go today', async () => {
    const wh = require(path.join(SRC, 'lib/chat/whatsapp-health.ts'));
    turnOn(); S.orders = [order(), order({ order_id: '#1554', customer_mobile: '' })]; await run(IST(13, 12));
    const realNow = Date.now; Date.now = () => S.nowMs;
    let h; try { wh.resetWaPhoneCache(); h = await wh.loadWaHealth(S.nowMs); } finally { Date.now = realNow; }
    deq(h.today, { placedWent: 1, placedRead: 0, trackingWent: 0, trackingRead: 0, failed: 0, skipped: 2, dueLater: 0 });   // #1554 has no number: both skipped
    eq(h.waitingToday, 1);   // #1553's tracking link, due on the 15th
    deq([h.usedToday, h.used24h], [311, 613]);   // today first (the limit is a day's), Meta's rolling 24 h beside it
  });

  // ── owner 15 Oct: ONE message with the tracking link; Meta's 130429 rate limit; 2 messages a minute ──
  const pause = require(path.join(SRC, 'lib/chat/whatsapp-pause.ts'));
  const LINK = { id: 't3', name: 'order_placed_link', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} with {{3}} has been placed successfully. Track it here: {{4}} . For any confusion, please email us at {{5}} and our team will help you.' }] };
  const tplOf = (f) => f.body.template.name;
  const valuesOf = (f) => f.body.template.components[0].parameters.map((x) => x.text);
  await t('one message (owner 15 Oct, "pehle hi message mein tracking link"): once order_placed_link is approved the first message carries the link and the 48-hour message is skipped; without it, or without a link, the old two', async () => {
    const brand = require(path.join(SRC, 'lib/chat/whatsapp-brand-rules.ts'));
    eq(brand.ORDER_LINK_PRESET.name, rules.LINK_TEMPLATE); eq((brand.ORDER_LINK_PRESET.body.match(/\{\{\d\}\}/g) || []).length, 5);
    pause.forgetPauseCache();
    S.metaTemplates.push(LINK); turnOn();
    S.orders = [order(), order({ order_id: '#1554', tracking_token: null })];
    await run(IST(13, 12));
    const f = sends();
    deq(f.map(tplOf), ['order_placed_link', 'order_placed']);                       // #1554 has no link yet: the old message
    deq(valuesOf(f[0]), ['Aaditya', '#1553', 'Vastora', 'https://shiptrack.store/track/tok-1553', 'help@vastora.test']);
    const tr = S.rows.find((r) => r.order_id === '#1553' && r.kind === 'tracking');
    deq([tr.status, tr.error], ['skipped', rules.SKIP.inFirst]);
    eq(S.rows.find((r) => r.order_id === '#1554' && r.kind === 'tracking').status, 'pending');
    // a tracking row whose order already got the link is skipped when its turn comes
    S.rows.find((r) => r.order_id === '#1553' && r.kind === 'tracking').status = 'pending';
    S.rows.forEach((r) => { if (r.kind === 'tracking') r.due_at = new Date(IST(15, 12)); });
    S.fetches = []; await run(IST(15, 12));
    deq(sends().map(tplOf), []);                                                    // #1553's went in the first message; #1554 still has no link
    eq(S.rows.find((r) => r.order_id === '#1554' && r.kind === 'tracking').error, rules.SKIP.noLink);
    eq(S.rows.find((r) => r.order_id === '#1553' && r.kind === 'tracking').status, 'skipped');
  });
  await t('slow and steady (owner 15 Oct, "har minute 1 ya 2 msg"): no send slot = nothing goes and nothing is claimed; the slot is one per 30 s', async () => {
    eq(rules.SEND_EVERY_MS, 30000);
    pause.forgetPauseCache(); turnOn(); S.orders = [order()]; S.slotBusy = true;
    await run(IST(13, 12));
    eq(sends().length, 0);
    const placed = S.rows.find((r) => r.kind === 'placed');
    deq([placed.status, new Date(placed.due_at).getTime()], ['pending', IST(13, 12)]);   // not claimed: goes on the next run
    S.slotBusy = false; await run(IST(13, 12, 1));
    eq(sends().length, 1);
    const src = fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-auto.ts'), 'utf8');
    assert.ok(src.indexOf('takeSendSlot(every)') > 0 && src.indexOf('takeSendSlot(every)') < src.indexOf("SET due_at = now() + interval '30 minutes'"), 'the slot is taken before the row is claimed');
  });
  await t('130429 at once (owner 15 Oct): the number pauses 15 min, the row waits (not Failed), nothing more goes that run or while paused; after the pause it goes', async () => {
    pause.forgetPauseCache(); turnOn(); S.orders = [order(), order({ order_id: '#1554' })];
    S.sendFail = { code: 130429, message: 'Rate limit hit' };
    const r1 = await run(IST(13, 12));
    eq(sends().length, 1); eq(r1.paused, true);
    const row = S.rows.find((r) => r.order_id === '#1553' && r.kind === 'placed');
    deq([row.status, row.attempts, row.code], ['pending', 1, 130429]);
    eq(new Date(row.due_at).getTime(), IST(13, 12) + rules.PAUSE_MS);
    assert.ok(JSON.parse(S.settings.wa_pause).until, 'paused for both processes');
    S.sendFail = null; S.fetches = []; pause.forgetPauseCache();
    await run(IST(13, 12, 5));
    eq(sends().length, 0);                                                          // still paused
    pause.forgetPauseCache(); await run(IST(13, 12, 16));
    eq(sends().length, 2);
  });
  await t('130429 later, in Meta\'s delivery report: the row goes back to waiting and the number pauses; the old failed ones go again after the pause (at most 6 tries)', async () => {
    pause.forgetPauseCache(); turnOn(); S.orders = [order()];
    await run(IST(13, 12));
    const row = S.rows.find((r) => r.kind === 'placed');
    eq(row.status, 'sent');
    await status.noteAutoStatus(row.wa_id, 'failed', '130429 · Rate limit hit · Message failed to send because there were too many messages sent from this phone number in a short period of time.');
    deq([row.status, row.code], ['pending', 130429]);
    assert.ok(S.settings.wa_pause, 'the report paused the number');
    // a row that already sits in Failed with 130429 (before this fix) waits in line again once not paused
    S.rows.push({ id: 'old', business_id: 'b1', order_id: '#1553', kind: 'tracking', status: 'failed', to_number: '919876543210', error: '130429 · Rate limit hit', code: null, attempts: 1, due_at: new Date(IST(13, 9)), sent_at: null, wa_id: null, updated_at: new Date(IST(13, 9)) });
    delete S.settings.wa_pause; pause.forgetPauseCache();
    await run(IST(13, 12, 20));
    eq(S.rows.find((r) => r.id === 'old').status, 'sent');                          // back in line, and it was due: it went
    S.rows.push({ id: 'many', business_id: 'b1', order_id: '#1553', kind: 'placed', status: 'failed', error: '130429 · Rate limit hit', code: 130429, attempts: 6, due_at: new Date(IST(13, 9)), updated_at: new Date(IST(13, 9)) });
    await run(IST(13, 12, 21));
    eq(S.rows.find((r) => r.id === 'many').status, 'failed');                      // tried enough
  });
  await t('ShipTrack\'s own alerts go FIRST (owner 15 Oct, "chargeback aur test sabse pehle"): sent at once even while paused; a 130429 queues it and the queue is tried every minute pause or not; order messages wait while an alert waits; a later 130429 report puts one back in line', async () => {
    const q = require(path.join(SRC, 'lib/chat/whatsapp-alert-queue.ts'));
    q.setAlertGap(0);
    pause.forgetPauseCache();
    await pause.pauseWhatsApp('130429 test', Date.now());
    let r = await q.sendAlert({ to: '919876500001', name: 'shiptrack_alert', language: 'en_US', text: 'CHARGEBACK mail on VASTRIKA', chargebackId: 'cb1' });
    eq(sends().length, 1); eq(sends()[0].body.template.name, 'shiptrack_alert'); assert.ok(r.id, 'sent through the pause');
    // Meta refuses it now: queued, and order messages hold while it waits
    S.fetches = []; S.sendFail = { code: 130429, message: 'Rate limit hit' };
    r = await q.sendAlert({ to: '919876500001', name: 'shiptrack_alert', language: 'en_US', text: 'CHARGEBACK mail on kurtiya', chargebackId: 'cb2' });
    deq(['error' in r, r.id], [false, null]);
    eq(await q.alertsWaiting(), 1);
    delete S.settings.wa_pause; pause.forgetPauseCache(); S.sendFail = null;
    turnOn(); S.orders = [order()]; S.fetches = [];
    await run(IST(13, 12));
    eq(sends().filter((x) => x.body.template.name !== 'shiptrack_alert').length, 0);    // the alert first
    // the next minute's queue run: sent even though the number is paused again
    await pause.pauseWhatsApp('130429 again', Date.now()); S.fetches = [];
    eq(await q.runAlertQueue(), 1);
    eq(sends().length, 1); eq(sends()[0].body.template.name, 'shiptrack_alert');
    eq(await q.runAlertQueue(), 0);                                                 // claimed once
    eq(await q.alertsWaiting(), 0);
    const wamid = Object.keys(S.settings).filter((k) => k.startsWith('wa_alert_sent:')).pop().slice('wa_alert_sent:'.length);
    eq(await q.noteAlertStatus(wamid, 'failed', '130429 · Rate limit hit'), true);
    eq(Object.keys(S.settings).filter((k) => k.startsWith('wa_alert_q:') && !JSON.parse(S.settings[k]).done).length, 1);   // in line again
    assert.ok(!('done' in JSON.parse(S.settings[Object.keys(S.settings).find((k) => k.startsWith('wa_alert_sent:'))])), 'the sent record never carries the queue\'s done mark');
    eq(await q.noteAlertStatus('wamid.unknown', 'failed', '130429'), false);
    for (const k of Object.keys(S.settings)) if (k.startsWith('wa_alert_q:')) delete S.settings[k];
    delete S.settings.wa_pause; pause.forgetPauseCache();
  });
  await t('130429 again and again (owner 15 Oct, live: refused at one message a minute after a burst): a new strike after the pause ends and within 2 h doubles the pause (15, 30, 60, 120 min) and order messages go 1 a minute instead of 2 (never slower); a 130429 WHILE the pause runs is the same burst (no strike, no extension); strikes stop at 10; 2 quiet hours = back to normal', async () => {
    const P = rules.PAUSE_MS, m = 60000, t0 = IST(13, 13);
    eq(rules.nextPause(null, t0).until - t0, P);
    let st = { until: t0 + P, at: t0, strikes: 1, reason: '' };
    eq(rules.nextPause(st, t0 + m), null);                                          // the same burst
    eq(rules.nextPause(st, t0 + 10 * m), null);                                     // still paused 10 min later: the same burst, not a strike
    eq(rules.nextPause(st, t0 + P - 1), null);                                      // up to the pause's last moment
    const n2 = rules.nextPause(st, t0 + 20 * m); deq([n2.strikes, n2.until - (t0 + 20 * m)], [2, 2 * P]);   // after it ends, within 2 h: the next strike
    st = { until: n2.until, at: t0 + 20 * m, strikes: 2, reason: '' };
    eq(rules.nextPause(st, t0 + 40 * m), null);                                     // the 30-minute pause runs: same burst
    const n3 = rules.nextPause(st, t0 + 60 * m); deq([n3.strikes, n3.until - (t0 + 60 * m)], [3, 4 * P]);
    const n9 = rules.nextPause({ until: 0, at: t0, strikes: 9, reason: '' }, t0 + 10 * m); eq(n9.until - (t0 + 10 * m), rules.MAX_PAUSE_MS);
    eq(rules.nextPause({ until: 0, at: t0, strikes: 10, reason: '' }, t0 + 10 * m).strikes, 10);   // never past 10
    eq(rules.MAX_STRIKES, 10); eq(rules.SAME_STRIKE_MS, undefined, 'the old 2-minute window is gone');
    eq(rules.nextPause({ until: 0, at: t0, strikes: 3, reason: '' }, t0 + 3 * 60 * m).strikes, 1);   // quiet for 3 h: a fresh start
    eq(rules.sendEveryFor(null, t0), rules.SEND_EVERY_MS);
    deq([1, 2, 3, 4].map((k) => rules.sendEveryFor({ until: 0, at: t0, strikes: k, reason: '' }, t0 + 30 * m)), [60000, 60000, 60000, 60000]);
    eq(rules.sendEveryFor({ until: 0, at: t0, strikes: 4, reason: '' }, t0 + 2 * 60 * m), rules.SEND_EVERY_MS);
    // the stored pause: strikes kept, the worker passes the wider gap to the slot
    pause.forgetPauseCache(); delete S.settings.wa_pause;
    await pause.pauseWhatsApp('130429 a', t0);
    await pause.pauseWhatsApp('130429 b', t0 + m);                                  // same burst: unchanged
    eq(JSON.parse(S.settings.wa_pause).strikes, 1);
    const u2 = await pause.pauseWhatsApp('130429 c', t0 + 20 * m);
    deq([JSON.parse(S.settings.wa_pause).strikes, u2 - (t0 + 20 * m)], [2, 2 * P]);
    turnOn(); S.orders = [order()]; pause.forgetPauseCache();
    await run(t0 + 20 * m + 2 * P + m);
    eq(sends().length, 1); eq(S.slotEvery, 60000);                                  // after the pause, one a minute
    delete S.settings.wa_pause; pause.forgetPauseCache();
  });
  await t('one alert Meta keeps refusing never pushes the pause up (review 15 Oct): sendAlert pauses on its FIRST refusal only (strikes stays 1 over 3 tries); a report on a retried alert does not pause either; a queued job older than 12 h is not counted as waiting', async () => {
    const q = require(path.join(SRC, 'lib/chat/whatsapp-alert-queue.ts'));
    q.setAlertGap(0);
    for (const k of Object.keys(S.settings)) if (k.startsWith('wa_alert_q:') || k.startsWith('wa_alert_sent:')) delete S.settings[k];
    delete S.settings.wa_pause; pause.forgetPauseCache();
    S.fetches = []; S.sendFail = { code: 130429, message: 'Rate limit hit' };
    const job = { to: '919876500001', name: 'shiptrack_alert', language: 'en_US', text: 'CHARGEBACK mail on VASTRIKA', chargebackId: 'cb1' };
    deq(await q.sendAlert(job), { ok: true, id: null });                            // try 1: refused, queued, the number paused
    eq(JSON.parse(S.settings.wa_pause).strikes, 1);
    // the pause runs out (at stays recent, so a second pauseWhatsApp WOULD be strike 2); the queue tries again, twice
    const expired = (strikes) => { const j = JSON.parse(S.settings.wa_pause); S.settings.wa_pause = JSON.stringify({ ...j, until: new Date(Date.now() - 1000).toISOString(), at: new Date(Date.now() - 5 * 60000).toISOString(), strikes }); pause.forgetPauseCache(); };
    expired(1);
    eq(await q.runAlertQueue(), 0);                                                 // try 2: refused again, queued again
    eq(JSON.parse(S.settings.wa_pause).strikes, 1); assert.ok(Date.parse(JSON.parse(S.settings.wa_pause).until) < Date.now(), 'no new pause');
    expired(1);
    eq(await q.runAlertQueue(), 0);                                                 // try 3
    eq(JSON.parse(S.settings.wa_pause).strikes, 1);
    const waiting = Object.keys(S.settings).filter((k) => k.startsWith('wa_alert_q:') && !JSON.parse(S.settings[k]).done);
    eq(waiting.length, 1); eq(JSON.parse(S.settings[waiting[0]]).tries, 3);
    eq(await q.alertsWaiting(), 1);
    // Meta's later failed report on a retried alert: back in line, no pause
    S.sendFail = null; S.fetches = []; expired(1);
    eq(await q.runAlertQueue(), 1);                                                 // try 4: sent
    const wamid = Object.keys(S.settings).filter((k) => k.startsWith('wa_alert_sent:')).pop().slice('wa_alert_sent:'.length);
    eq(JSON.parse(S.settings['wa_alert_sent:' + wamid]).tries, 4);
    eq(await q.noteAlertStatus(wamid, 'failed', '130429 · Rate limit hit'), true);
    eq(JSON.parse(S.settings.wa_pause).strikes, 1); assert.ok(Date.parse(JSON.parse(S.settings.wa_pause).until) < Date.now(), 'a retried alert\'s report never pauses');
    eq(await q.alertsWaiting(), 1);
    // a job older than 12 hours is dropped on the next run: it does not hold order messages meanwhile
    for (const k of Object.keys(S.settings)) if (k.startsWith('wa_alert_q:')) S.settings[k] = JSON.stringify({ ...JSON.parse(S.settings[k]), first: new Date(Date.now() - q.ALERT_KEEP_MS - 60000).toISOString() });
    eq(await q.alertsWaiting(), 0);
    eq(await q.runAlertQueue(), 0);
    eq(Object.keys(S.settings).filter((k) => k.startsWith('wa_alert_q:') && !JSON.parse(S.settings[k]).done).length, 0, 'dropped');
    for (const k of Object.keys(S.settings)) if (k.startsWith('wa_alert_q:') || k.startsWith('wa_alert_sent:')) delete S.settings[k];
    delete S.settings.wa_pause; pause.forgetPauseCache();
  });
  await t('while paused: the test send still goes at once (owner: "test sabse pehle"), and a customer\'s message gets no auto reply now (nothing claimed)', async () => {
    pause.forgetPauseCache(); turnOn(); S.orders = [order()]; S.fetches = [];
    await pause.pauseWhatsApp('130429 test', Date.now());
    const r = await auto.sendAutomationTest('b1', '9876500001', 'Test');
    assert.ok(!('error' in r)); assert.ok(sends().length >= 1);
    const ar = fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-autoreply.ts'), 'utf8');
    assert.ok(ar.indexOf("return 'paused'") > 0 && ar.indexOf("return 'paused'") < ar.indexOf('INSERT INTO messages'), 'checked before the claim');
    delete S.settings.wa_pause; pause.forgetPauseCache();
  });

  await t('Number status + Pause now / Resume now (owner 15 Oct, "pause ka option, pata chal jaee kab tak resume"): the view says paused / slow / normal, until when, Meta\'s last refusal and the next pause; a pause by hand never counts as Meta\'s refusal; Resume ends any pause', async () => {
    const m = 60000, t0 = IST(13, 14);
    // the pure view
    deq(rules.pauseView(null, t0).state, 'normal'); eq(rules.pauseView(null, t0).nextPauseMin, 15); eq(rules.pauseView(null, t0).strikes, 0);
    let v = rules.pauseView({ until: t0 + 30 * m, at: t0, strikes: 2, reason: '130429 · Rate limit hit' }, t0 + 5 * m);
    deq([v.state, v.until, v.manual, v.strikes, v.nextPauseMin, v.reason], ['paused', new Date(t0 + 30 * m).toISOString(), false, 2, 60, '130429 · Rate limit hit']);
    eq(v.lastRefusalAt, new Date(t0).toISOString());
    v = rules.pauseView({ until: t0 + 30 * m, at: t0, strikes: 2, reason: 'x' }, t0 + 40 * m);
    deq([v.state, v.until, v.sendEveryMs, v.slowUntil], ['slow', null, 60000, new Date(t0 + 120 * m).toISOString()]);
    v = rules.pauseView({ until: t0 + 30 * m, at: t0, strikes: 2, reason: 'x' }, t0 + 130 * m);
    deq([v.state, v.strikes, v.lastRefusalAt, v.nextPauseMin], ['normal', 0, null, 15]);
    eq(rules.pauseView({ until: 0, at: t0, strikes: 9, reason: '' }, t0 + m).nextPauseMin, 120);
    // the route: pause by hand, never a strike; only 15 / 30 / 60 / 120; Super Admin only
    pause.forgetPauseCache(); delete S.settings.wa_pause;
    eq((await route.POST(jreq(AGENT, { action: 'pause', minutes: 30 }))).status, 401);
    eq((await route.POST(jreq(OWNER, { action: 'pause', minutes: 7 }))).status, 400);
    eq((await route.POST(jreq(OWNER, { action: 'resume' }))).status, 409);                // nothing paused
    let r = await route.POST(jreq(OWNER, { action: 'pause', minutes: 30 }));
    eq(r.status, 200);
    let st = rules.parsePauseState(S.settings.wa_pause);
    deq([st.manual, st.by, Math.round((st.until - Date.now()) / m)], [true, 'owner', 30]);
    v = rules.pauseView(st, Date.now());
    deq([v.state, v.manual, v.by, v.strikes, v.lastRefusalAt, v.sendEveryMs], ['paused', true, 'owner', 0, null, 30000]);   // not Meta's
    pause.forgetPauseCache(); assert.ok(await pause.whatsAppPause(), 'order messages wait');
    // the overview carries it
    const ov = (await route.GET(jreq(OWNER, {}))).body;
    eq(ov.pauseInfo.state, 'paused'); eq(ov.pauseInfo.manual, true); eq(typeof ov.ordersDue, 'number');
    // Resume now: ends it; after a Meta pause the strikes stay (still slow, the next pause still longer)
    r = await route.POST(jreq(OWNER, { action: 'resume' }));
    eq(r.status, 200); pause.forgetPauseCache();
    eq(await pause.whatsAppPause(), null);
    eq(rules.parsePauseState(S.settings.wa_pause).resumedBy, 'owner');
    delete S.settings.wa_pause; pause.forgetPauseCache();
    await pause.pauseWhatsApp('130429 Rate limit hit', Date.now());
    await pause.pauseWhatsApp('130429 Rate limit hit', Date.now() + 16 * m);         // a 2nd strike after the first ended
    eq((await route.POST(jreq(OWNER, { action: 'resume' }))).status, 200);
    st = rules.parsePauseState(S.settings.wa_pause);
    deq([st.strikes, st.until <= Date.now() + 16 * m + 1000], [2, true]);
    eq(rules.pauseView(st, Date.now() + 17 * m).state, 'slow');
    delete S.settings.wa_pause; pause.forgetPauseCache();
  });

  console.log(`WHATSAPP AUTOMATION: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
