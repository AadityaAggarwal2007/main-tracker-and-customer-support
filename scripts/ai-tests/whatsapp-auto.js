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
    nowMs: IST(13, 12), noTable: false, slotBusy: false, slots: 0, sendFail: null, sendThrow: false, stealClaims: false, trackingFlags: [], reports: [], fetches: [], seq: 0, stopAlertClaims: 0,
    // owner 15 Oct: Meta's side of the number (the Number status box) and a template list that Meta pages
    phone: { display_phone_number: '+91 98765 00001', verified_name: 'ShipTrack', name_status: 'APPROVED', quality_rating: 'GREEN', status: 'CONNECTED', messaging_limit_tier: 'TIER_2K', code_verification_status: 'VERIFIED' },
    metaPages: null,
    // owner 15 Oct: the customers we started a conversation with in the last 24 h (the daily limit guard); knownExtra =
    // numbers messaged by the team's templates (not in wa_auto_sends)
    used: { n: 613, today: 311, oldest: null }, knownExtra: [],
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
    // the one owner alert per stop (whatsapp-alert-queue.ts alertStopped): claimed by the stop's time, one UPDATE wins
    if (/^INSERT INTO chat_settings \(key, value, updated_at\) VALUES \(\$1, \$2, now\(\)\) ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value, updated_at = now\(\) WHERE chat_settings\.value IS DISTINCT FROM EXCLUDED\.value RETURNING key$/.test(sql)) { if (S.settings[p[0]] === p[1]) return { rows: [], rowCount: 0 }; S.settings[p[0]] = p[1]; S.stopAlertClaims = (S.stopAlertClaims || 0) + 1; return { rows: [{ key: p[0] }], rowCount: 1 }; }
    if (/^INSERT INTO chat_settings/.test(sql)) { S.settings[p[0]] = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^SELECT key FROM chat_settings WHERE key LIKE \$1 AND \(CASE/.test(sql)) { const pre = p[0].replace('%', ''); const rows = Object.keys(S.settings).filter((k) => k.startsWith(pre) && !JSON.parse(S.settings[k]).done).map((key) => ({ key })); return { rows, rowCount: rows.length }; }
    if (/^SELECT value FROM chat_settings WHERE key LIKE \$1 AND \(CASE/.test(sql)) { const pre = p[0].replace('%', ''); const rows = Object.keys(S.settings).filter((k) => k.startsWith(pre) && !JSON.parse(S.settings[k]).done).map((key) => ({ value: S.settings[key] })); return { rows, rowCount: rows.length }; }
    if (/^UPDATE chat_settings SET value = \(value::jsonb \|\| '\{"done":true\}'::jsonb\)::text/.test(sql)) { const v = S.settings[p[0]]; if (!v || JSON.parse(v).done) return { rows: [], rowCount: 0 }; S.settings[p[0]] = JSON.stringify({ ...JSON.parse(v), done: true }); return { rows: [{ value: S.settings[p[0]] }], rowCount: 1 }; }
    if (/^UPDATE wa_auto_sends SET status = 'pending', due_at = now\(\), updated_at = now\(\) WHERE status = 'failed' AND \(code = \$1 OR error LIKE '130429%'\)/.test(sql)) { let n = 0; for (const r of S.rows) if (r.status === 'failed' && (r.code === p[0] || /^130429/.test(r.error || '')) && r.attempts < p[1]) { Object.assign(r, { status: 'pending', due_at: new Date(S.nowMs) }); n++; } return { rows: [], rowCount: n }; }
    if (/^UPDATE wa_auto_sends SET status = \$5, attempts = attempts \+ 1, error = \$2, code = \$3, due_at = \$4/.test(sql)) { const r = S.rows.find((x) => x.id === p[0]); Object.assign(r, { status: p[4], attempts: r.attempts + 1, error: p[1], code: p[2], due_at: p[3] }); return { rows: [], rowCount: 1 }; }
    // owner 15 Oct: was any order message sent in the 10 minutes before the refused one? (whatsapp-auto-status.ts quietBefore)
    if (/^SELECT 1 FROM wa_auto_sends WHERE sent_at > \$1::timestamptz - \$2 \* interval '1 millisecond' AND sent_at < \$1::timestamptz/.test(sql)) {
      const at = p[0].getTime(); const rows = S.rows.filter((r) => r.sent_at && new Date(r.sent_at).getTime() > at - p[1] && new Date(r.sent_at).getTime() < at && (p[2] == null || r.wa_id !== p[2]));
      return { rows: rows.slice(0, 1).map(() => ({ '?column?': 1 })), rowCount: Math.min(rows.length, 1) };
    }
    // owner 15 Oct night: a Meta-side failed report puts the row back in line (due now, the report's code), the stop follows
    if (/^UPDATE wa_auto_sends SET status = CASE WHEN attempts >= \$3/.test(sql)) { const r = S.rows.find((x) => x.wa_id === p[0] && ['pending', 'sent'].includes(x.status)); if (r) Object.assign(r, { status: r.attempts >= p[2] ? 'failed' : 'pending', due_at: new Date(S.nowMs), error: p[1], code: p[3] }); return { rows: r ? [{ sent_at: r.sent_at || null, order_id: r.order_id, kind: r.kind }] : [], rowCount: r ? 1 : 0 }; }
    if (/^SELECT value FROM chat_settings WHERE key LIKE \$1 ORDER BY updated_at DESC LIMIT 20$/.test(sql)) { const pre = p[0].replace('%', ''); const rows = Object.keys(S.settings).filter((k) => k.startsWith(pre)).map((k) => ({ value: S.settings[k] })); return { rows, rowCount: rows.length }; }
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
    if (/^UPDATE wa_auto_sends SET status = CASE/.test(sql)) {
      S.reports = (S.reports || []).concat([p]); const r = S.rows.find((x) => x.wa_id === p[0]);
      if (r) { const st = p[1]; if (st === 'failed') { r.status = 'failed'; r.error = p[2]; } else if (st === 'read') r.status = 'read'; else if (st === 'delivered' && ['pending', 'sent'].includes(r.status)) r.status = 'delivered'; else if (st === 'sent' && r.status === 'pending') r.status = 'sent'; }
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (/count\(DISTINCT w\.to_number\)::int AS replied/.test(sql)) return { rows: [{ business_id: 'b1', replied: 2 }], rowCount: 1 };
    if (/^SELECT w\.kind, w\.status, count\(\*\)::int AS n FROM wa_auto_sends w WHERE COALESCE/.test(sql)) {
      // the India day of S.nowMs
      const from = Math.floor((S.nowMs + 330 * 60000) / 86400000) * 86400000 - 330 * 60000;
      const m = {}; for (const r of S.rows) { const t = msgAt(r); if (t >= from && t < from + 86400000) { const k = r.kind + '|' + r.status; m[k] = (m[k] || 0) + 1; } }
      const rows = Object.keys(m).map((k) => ({ kind: k.split('|')[0], status: k.split('|')[1], n: m[k] }));
      return { rows, rowCount: rows.length };
    }
    if (/count\(DISTINCT x\.digits\)::int AS n, \(count\(DISTINCT x\.digits\) FILTER \(WHERE x\.at >= /.test(sql)) return { rows: [{ n: S.used.n, today: S.used.today, oldest: S.used.oldest }], rowCount: 1 };
    // the numbers of the last 24 hours' customers (whatsapp-health.ts knownNumbers24h): the automation's sends + the team's
    if (/^SELECT DISTINCT x\.digits FROM \(/.test(sql)) {
      const digits = new Set(S.knownExtra);
      for (const r of S.rows) if (r.sent_at && ['sent', 'delivered', 'read'].includes(r.status) && S.nowMs - new Date(r.sent_at).getTime() < 24 * 3600 * 1000 && r.to_number) digits.add(r.to_number);
      const rows = [...digits].map((d) => ({ digits: d })); return { rows, rowCount: rows.length };
    }
    if (/AS failed, \(count\(\*\) FILTER \(WHERE status = 'pending'\)\)::int AS waiting FROM wa_auto_sends/.test(sql)) return { rows: [{ failed: 0, waiting: S.rows.filter((r) => r.status === 'pending').length }], rowCount: 1 };
    if (/FROM wa_auto_sends GROUP BY 1, 2, 3|FROM wa_auto_sends w GROUP BY 1, 2, 3/.test(sql)) {
      const m = {}, mi = {}; for (const r of S.rows) { const k = r.business_id + '|' + r.kind + '|' + r.status; m[k] = (m[k] || 0) + 1; const t = msgAt(r); if (t >= p[0].getTime() && t < p[1].getTime()) mi[k] = (mi[k] || 0) + 1; }
      const rows = Object.keys(m).map((k) => { const [business_id, kind, status] = k.split('|'); return { business_id, kind, status, n: m[k], nin: mi[k] || 0 }; });
      return { rows, rowCount: rows.length };
    }
    if (/FROM orders o LEFT JOIN businesses b ON b\.id = o\.business_id WHERE o\.business_id::text = \$1 ORDER BY o\.created_at DESC LIMIT 1/.test(sql)) { const o = S.orders.filter((x) => x.business_id === p[0]).sort((a, b) => b.created_at - a.created_at)[0]; return o ? { rows: [{ order_id: o.order_id, tracking_token: o.tracking_token, tracking_domain: null }], rowCount: 1 } : { rows: [], rowCount: 0 }; }
    if (/^SELECT 1 FROM businesses WHERE id::text = \$1/.test(sql)) return S.panels.some((x) => x.id === p[0]) ? { rows: [{ x: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/^SELECT name FROM businesses WHERE id::text = \$1/.test(sql)) { const b = S.panels.find((x) => x.id === p[0]); return b ? { rows: [{ name: b.name }], rowCount: 1 } : { rows: [], rowCount: 0 }; }
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
  if (/message_templates/.test(url)) {
    // Meta pages the list: S.metaPages = [[page 1 templates], [page 2 templates]] gives a paging.next on page 1 (owner 15 Oct)
    if (S.metaPages) {
      const n = Number((url.match(/[?&]after=p(\d+)/) || [])[1] || 1);
      const next = n < S.metaPages.length ? `https://graph.facebook.com/v25.0/28873951022288651/message_templates?fields=name,status&limit=100&after=p${n + 1}` : null;
      return { ok: true, status: 200, json: async () => ({ data: S.metaPages[n - 1].map((t) => ({ ...t })), paging: next ? { cursors: { after: `p${n + 1}` }, next } : {} }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: S.metaTemplates.map((t) => ({ ...t })) }) };
  }
  if (/\/1335396902996145\?fields=/.test(url)) return { ok: true, status: 200, json: async () => S.phone };
  if (/\/messages$/.test(url)) {
    if (S.sendThrow) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (S.sendFail) return { ok: false, status: 400, json: async () => ({ error: { code: S.sendFail.code, message: S.sendFail.message } }) };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.' + (++S.seq) }] }) };
  }
  throw new Error('fake fetch: ' + url);
};
process.env.WHATSAPP_CLOUD_TOKEN = 'tok-secret'; process.env.WHATSAPP_PHONE_NUMBER_ID = '1335396902996145';

const rules = require(path.join(SRC, 'lib/chat/whatsapp-auto-rules.ts'));
const pause = require(path.join(SRC, 'lib/chat/whatsapp-pause.ts'));
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
  reset(); auto.resetTemplateCache(); auto.forgetLinkModeCache(); pause.forgetPauseCache(); pause.forgetSendRateCache(); delete global.__waAutoBusy; delete require('child_process').__x;
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
  await t('a refusal that cannot change (not on WhatsApp) fails at once and nothing stops; a Meta-side hiccup (131056) is no longer retried by itself: the row waits and the number STOPS until Resume (owner 15 Oct night); Send again queues a Failed row', async () => {
    turnOn(); S.orders = [order()];
    S.sendFail = { code: 131026, message: 'Message undeliverable' };
    await run(IST(13, 12)); deq([S.rows[0].status, S.rows[0].code, S.rows[0].attempts], ['failed', 131026, 1]);
    eq(S.settings.wa_pause, undefined, 'a customer-side failure never stops the number');
    reset(); auto.resetTemplateCache(); pause.forgetPauseCache(); turnOn(); S.orders = [order()]; S.sendFail = { code: 131056, message: 'Pair rate limit hit' };
    await run(IST(13, 12)); deq([S.rows[0].status, S.rows[0].attempts], ['pending', 1]);
    assert.ok(JSON.parse(S.settings.wa_pause).stopped, 'stopped');
    await run(IST(13, 12, 5)); eq(sends().length, 1);                          // stopped: nothing more
    await run(IST(13, 12, 22)); deq([S.rows[0].status, S.rows[0].attempts], ['pending', 1]);   // still waiting, never failed by itself
    S.sendFail = null; await pause.resumeNow('owner', IST(13, 12, 29));
    await run(IST(13, 12, 30)); eq(S.rows[0].status, 'sent');
    S.rows[0].status = 'failed';
    eq(await auto.retryFailed('1'), true); eq(await auto.retryFailed('1'), false);
    await run(IST(13, 12, 31)); eq(S.rows[0].status, 'sent');
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
  await t('review fixes: a timeout is never sent again by itself (Meta may have taken it); since 15 Oct night it also stops the number (a lost answer is Meta\'s side)', async () => {
    turnOn(); S.orders = [order()]; S.sendThrow = true;
    await run(IST(13, 12)); deq([S.rows[0].status, /may still have been delivered/.test(S.rows[0].error)], ['failed', true]);
    assert.ok(JSON.parse(S.settings.wa_pause).stopped, 'stopped: the owner looks before anything else goes');
    S.sendThrow = false; await run(IST(13, 12, 15)); eq(sends().length, 1);
    await pause.resumeNow('owner', IST(13, 12, 16)); await run(IST(13, 12, 17)); eq(sends().length, 1, 'the timed-out row is not resent after Resume either');
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
  const LINK = { id: 't3', name: 'order_placed_link', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} with {{3}} has been placed successfully. Track it here: {{4}} . For any confusion, please email us at {{5}} and our team will help you.' }] };
  const tplOf = (f) => f.body.template.name;
  const valuesOf = (f) => f.body.template.components[0].parameters.map((x) => x.text);
  await t('one message (owner 15 Oct, "pehle hi message mein tracking link"): once order_placed_link is approved the first message carries the link and the 48-hour message is skipped; without the template the old two; without a link the message WAITS (since the evening: never order_placed in this mode)', async () => {
    const brand = require(path.join(SRC, 'lib/chat/whatsapp-brand-rules.ts'));
    eq(brand.ORDER_LINK_PRESET.name, rules.LINK_TEMPLATE); eq((brand.ORDER_LINK_PRESET.body.match(/\{\{\d\}\}/g) || []).length, 5);
    pause.forgetPauseCache();
    S.metaTemplates.push(LINK); turnOn();
    S.orders = [order(), order({ order_id: '#1554', tracking_token: null })];
    const r1 = await run(IST(13, 12));
    const f = sends();
    deq(f.map(tplOf), ['order_placed_link']);                                       // #1554 has no link yet: it waits (was: order_placed)
    deq([r1.sent, r1.waitingLink], [1, 1]);
    deq(valuesOf(f[0]), ['Aaditya', '#1553', 'Vastora', 'https://shiptrack.store/track/tok-1553', 'help@vastora.test']);
    const tr = S.rows.find((r) => r.order_id === '#1553' && r.kind === 'tracking');
    deq([tr.status, tr.error], ['skipped', rules.SKIP.inFirst]);
    deq(S.rows.filter((r) => r.order_id === '#1554').map((r) => [r.kind, r.status, r.error]), [['placed', 'pending', null], ['tracking', 'pending', null]]);
    // a tracking row whose order already got the link is skipped when its turn comes; #1554's placed row is over 24 h old by then
    S.rows.find((r) => r.order_id === '#1553' && r.kind === 'tracking').status = 'pending';
    S.rows.forEach((r) => { if (r.kind === 'tracking') r.due_at = new Date(IST(15, 12)); });
    S.fetches = []; await run(IST(15, 12));
    deq(sends().map(tplOf), []);                                                    // #1553's went in the first message; #1554 still has no link
    eq(S.rows.find((r) => r.order_id === '#1554' && r.kind === 'tracking').error, rules.SKIP.noLink);
    eq(S.rows.find((r) => r.order_id === '#1554' && r.kind === 'placed').error, rules.SKIP.tooOld);
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
  await t('130429 at once (owner 15 Oct; since 15 Oct night a STOP until Resume, no 15-minute pause): the row waits due now (not Failed), nothing more goes that run, 5 or 16 minutes later; after Resume it goes', async () => {
    pause.forgetPauseCache(); turnOn(); S.orders = [order(), order({ order_id: '#1554' })];
    S.sendFail = { code: 130429, message: 'Rate limit hit' };
    const r1 = await run(IST(13, 12));
    eq(sends().length, 1); deq([r1.paused, r1.stopped], [true, true]);
    const row = S.rows.find((r) => r.order_id === '#1553' && r.kind === 'placed');
    deq([row.status, row.attempts, row.code], ['pending', 1, 130429]);
    eq(new Date(row.due_at).getTime(), IST(13, 12));                             // due now: it goes the moment Resume is pressed
    const st = JSON.parse(S.settings.wa_pause);
    deq([st.stopped, st.by, st.order, st.kind, st.code], [true, 'Meta failure', '#1553', 'placed', 130429]);
    eq(Date.parse(st.until) - IST(13, 12), rules.STOP_MS, 'stopped for both processes, 30 days: never ends by itself');
    S.sendFail = null; S.fetches = []; pause.forgetPauseCache();
    await run(IST(13, 12, 5));
    eq(sends().length, 0);                                                          // still stopped
    pause.forgetPauseCache(); await run(IST(13, 12, 16));
    eq(sends().length, 0);                                                          // 16 minutes later too (no timed pause any more)
    await pause.resumeNow('owner', IST(13, 12, 17)); await run(IST(13, 12, 18));
    eq(sends().length, 2);
  });
  await t('130429 later, in Meta\'s delivery report: the row goes back to waiting and the number STOPS (15 Oct night); the old failed ones go again after Resume (at most 6 tries)', async () => {
    pause.forgetPauseCache(); turnOn(); S.orders = [order()];
    await run(IST(13, 12));
    const row = S.rows.find((r) => r.kind === 'placed');
    eq(row.status, 'sent');
    await status.noteAutoStatus(row.wa_id, 'failed', '130429 · Rate limit hit · Message failed to send because there were too many messages sent from this phone number in a short period of time.');
    deq([row.status, row.code], ['pending', 130429]);
    assert.ok(S.settings.wa_pause && JSON.parse(S.settings.wa_pause).stopped, 'the report stopped the number');
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

  await t('a LATE 130429 report (owner 15 Oct, "is baar theek se kaam nahi kiya"): a refusal for a message sent before the last pause ended is the old burst: no new strike, no longer pause; one sent after it is a real new refusal', async () => {
    const m = 60000, t0 = Date.now() - 60 * m;
    eq(rules.nextPause({ until: t0 + 30 * m, at: t0, strikes: 2, reason: '' }, t0 + 31 * m, rules.PAUSE_MS, t0 - 5 * m), null);
    eq(rules.nextPause({ until: t0 + 30 * m, at: t0, strikes: 2, reason: '' }, t0 + 31 * m, rules.PAUSE_MS, t0 + 30 * m + 10000).strikes, 3);
    eq(rules.nextPause({ until: t0 + 30 * m, at: t0, strikes: 2, reason: '' }, t0 + 31 * m).strikes, 3);   // no time known: as before
    // through the delivery report of an automation row
    pause.forgetPauseCache(); delete S.settings.wa_pause;
    S.settings.wa_pause = JSON.stringify({ until: new Date(Date.now() - m).toISOString(), reason: '130429', at: new Date(Date.now() - 31 * m).toISOString(), strikes: 2 });
    S.rows.push({ id: 'late1', business_id: 'b1', order_id: '#1553', kind: 'placed', status: 'sent', wa_id: 'wamid.late1', attempts: 1, sent_at: new Date(Date.now() - 40 * m), due_at: new Date(), updated_at: new Date() });
    await status.noteAutoStatus('wamid.late1', 'failed', '130429 · Rate limit hit');
    let st = rules.parsePauseState(S.settings.wa_pause);
    deq([st.strikes, st.until < Date.now()], [2, true]);                          // not paused again
    eq(S.rows.find((r) => r.id === 'late1').status, 'pending');                   // the message still waits to go again
    S.rows.push({ id: 'new1', business_id: 'b1', order_id: '#1554', kind: 'placed', status: 'sent', wa_id: 'wamid.new1', attempts: 1, sent_at: new Date(), due_at: new Date(), updated_at: new Date() });
    await status.noteAutoStatus('wamid.new1', 'failed', '130429 · Rate limit hit');
    st = rules.parsePauseState(S.settings.wa_pause);
    deq([st.strikes, st.until > Date.now()], [3, true]);                          // a real new refusal
    delete S.settings.wa_pause; pause.forgetPauseCache();
  });

  // ── owner 15 Oct afternoon: the one-message mode never ran in production although the tab said it was on ──
  const captureLog = () => { const lines = []; const o = { log: console.log, warn: console.warn }; console.log = (...a) => lines.push(a.join(' ')); console.warn = (...a) => lines.push(a.join(' ')); return { lines, restore: () => { console.log = o.log; console.warn = o.warn; } }; };
  await t('the switch "One message per order" (owner 15 Oct, "switch ya jo bhi banana h bana"): route 401 / 400; OFF = order_placed + the tracking row kept although the link template is approved; ON = the link message and the tracking row skipped; the test send follows it', async () => {
    pause.forgetPauseCache(); S.metaTemplates.push(LINK); turnOn();
    eq((await route.POST(jreq(AGENT, { action: 'link_mode', on: false }))).status, 401);
    eq((await route.POST(jreq(null, { action: 'link_mode', on: false }))).status, 401);
    eq((await route.POST(jreq(OWNER, { action: 'link_mode', on: 'no' }))).status, 400);
    eq((await route.POST(jreq(OWNER, { action: 'link_mode' }))).status, 400);
    // no row = ON when the template is approved
    deq(rules.parseLinkMode(undefined), { on: null, by: null, at: null }); deq(rules.parseLinkMode('junk').on, null);
    let m = rules.linkModeOf(null, { name: 'order_placed_link', language: 'en_US' }, 'APPROVED', null);
    deq([m.on, m.approved, m.active], [true, true, true]); assert.match(m.reason, /^one message: order_placed_link \(en_US\)/);
    m = rules.linkModeOf(null, null, 'PENDING', null); deq([m.on, m.approved, m.active], [true, false, false]); assert.match(m.reason, /^two messages: order_placed_link is pending on Meta/);
    m = rules.linkModeOf(null, null, 'MISSING', null); assert.match(m.reason, /not made yet/);
    m = rules.linkModeOf(null, null, 'UNKNOWN', 'The WhatsApp token was refused'); assert.match(m.reason, /could not be read from Meta: The WhatsApp token was refused/);
    m = rules.linkModeOf({ on: false, by: 'owner', at: 'x' }, { name: 'order_placed_link', language: 'en_US' }, 'APPROVED', null);
    deq([m.on, m.approved, m.active], [false, true, false]); assert.match(m.reason, /^two messages: the switch "One message per order" is OFF \(by owner\)/);
    // OFF: the two old messages exactly as before
    let r = await route.POST(jreq(OWNER, { action: 'link_mode', on: false }));
    deq([r.status, r.body.on, r.body.linkMode.active], [200, false, false]);
    const saved = JSON.parse(S.settings.wa_link_mode); deq([saved.on, saved.by, typeof saved.at], [false, 'owner', 'string']);
    S.orders = [order()];
    await run(IST(13, 12));
    deq(sends().map(tplOf), ['order_placed']);
    deq(S.rows.map((x) => [x.kind, x.status]), [['placed', 'sent'], ['tracking', 'pending']]);
    await run(IST(15, 11, 5));
    deq(sends().map(tplOf), ['order_placed', 'order_tracking']);                  // the 48-hour message still goes
    let ov = (await route.GET(jreq(OWNER, {}))).body;
    deq([ov.linkMode.on, ov.linkMode.approved, ov.linkMode.active], [false, true, false]); assert.match(ov.linkMode.reason, /switch .* is OFF/);
    eq(ov.templates.link, 'APPROVED');
    // the test send: OFF = both messages
    S.fetches = []; let ts = await auto.sendAutomationTest('b1', '9876500001', 'Test');
    deq(ts.results.map((x) => x.kind), ['placed', 'tracking']); assert.match(ts.mode, /^two messages/); eq(tplOf(sends()[0]), 'order_placed');
    // ON: one message, the tracking row skipped
    r = await route.POST(jreq(OWNER, { action: 'link_mode', on: true }));
    deq([r.status, r.body.on, r.body.linkMode.active], [200, true, true]);
    S.orders.push(order({ order_id: '#1554', customer_mobile: '9811122233' })); S.fetches = [];
    await run(IST(13, 12, 1));
    deq(sends().map(tplOf), ['order_placed_link']);
    const tr = S.rows.find((x) => x.order_id === '#1554' && x.kind === 'tracking'); deq([tr.status, tr.error], ['skipped', rules.SKIP.inFirst]);
    ov = (await route.GET(jreq(OWNER, {}))).body; deq([ov.linkMode.on, ov.linkMode.active], [true, true]);
    S.fetches = []; ts = await auto.sendAutomationTest('b1', '9876500001', 'Test');
    deq(ts.results.map((x) => x.kind), ['placed']); assert.match(ts.mode, /^one message/); eq(tplOf(sends()[0]), 'order_placed_link');
    // OFF again drops the waiting messages of nobody: a row already skipped stays, new orders get two
    delete S.settings.wa_link_mode; auto.forgetLinkModeCache();
    ov = (await route.GET(jreq(OWNER, {}))).body; eq(ov.linkMode.on, true);         // no row = ON
  });
  await t('why order_placed_link was never picked (owner 15 Oct): the mode is decided ONCE per run and logged with its reason; a template on Meta\'s second page is read (before, only page 1 was); a placed row with no tracking link waits and the log says so once; a stray capital or space in the name never hides it', async () => {
    pause.forgetPauseCache(); turnOn();
    // page 2 of Meta's list: the old code read only the first 100 templates, so a template past them looked MISSING
    S.metaPages = [S.metaTemplates.map((x) => ({ ...x })), [{ ...LINK, name: ' Order_Placed_Link ' }]];
    S.orders = [order(), order({ order_id: '#1554', tracking_token: null, customer_mobile: '9811122233' })];
    const cap = captureLog();
    try { await run(IST(13, 12)); } finally { cap.restore(); }
    eq(S.fetches.filter((f) => /message_templates/.test(f.url)).length, 2, 'both pages read');
    assert.match(S.fetches.filter((f) => /message_templates/.test(f.url))[1].url, /after=p2/);
    deq(sends().map(tplOf), ['order_placed_link']);                                 // the name read clean (readTemplates), so the send takes it; #1554 waits for its link
    eq(cap.lines.filter((l) => /^\[wa-auto\] one message: /.test(l)).length, 1, 'said once per run');
    assert.match(cap.lines.find((l) => /^\[wa-auto\] one message: /.test(l)), /is approved and the switch is ON/);
    eq(cap.lines.filter((l) => /wait.* for the order's tracking link/.test(l)).length, 1, 'once per run, with the count');
    assert.ok(cap.lines.some((l) => l === rules.waitingLinkLine(1, 'order_placed_link')), cap.lines.join('\n'));
    assert.ok(!cap.lines.some((l) => /order_placed goes instead/.test(l)), 'the old fallback line is gone');
    eq(S.rows.find((r) => r.order_id === '#1554' && r.kind === 'placed').status, 'pending');
    const ov = await auto.automationOverview(null, IST(13, 12));
    eq(ov.templates.link, 'APPROVED'); eq(ov.linkMode.active, true);
    // a later page that cannot be read keeps what page 1 gave (two messages, never nothing)
    auto.resetTemplateCache();
    const realFetch = global.fetch;
    global.fetch = async (url, init) => (/after=p2/.test(url) ? { ok: false, status: 500, json: async () => ({ error: { message: 'An unknown error occurred', code: 1 } }) } : realFetch(url, init));
    try { const { list, error } = await auto.templateStates(IST(13, 13), true); eq(error, null); eq(list.length, 2); } finally { global.fetch = realFetch; }
    // the templates module itself: paging.next is followed, never past Meta's own API, at most 5 pages
    eq(tpl.nextPageOf({ paging: { next: 'https://graph.facebook.com/v25.0/x?after=1' } }), 'https://graph.facebook.com/v25.0/x?after=1'); eq(tpl.nextPageOf({ data: [] }), null);
    eq(tpl.TEMPLATE_PAGES_MAX, 5);
    S.metaPages = null; S.fetches = []; auto.resetTemplateCache();
    const r = await tpl.listTemplates('28873951022288651', process.env, async () => ({ ok: true, status: 200, json: async () => ({ data: [], paging: { next: 'https://evil.example/steal?token' } }) }));
    deq([r.ok, r.value.length], [true, 0]);
  });
  await t('firstAfterQuiet (owner 15 Oct, 130429 eight seconds after the FIRST message of a 15 / 30 min pause): a refusal of the first order message after 10 quiet minutes, or within 2 minutes of the previous pause\'s end, flags the pause; the view and the overview carry it; a pause by hand / Resume keep it; a refusal in a run of messages never', async () => {
    const m = 60000, t0 = IST(13, 14);
    eq(rules.QUIET_MS, 10 * m); eq(rules.AFTER_PAUSE_MS, 2 * m);
    assert.match(rules.FIRST_AFTER_QUIET_TEXT, /not our speed/); assert.match(rules.FIRST_AFTER_QUIET_TEXT, /WhatsApp Manager/);
    // the pure rule
    eq(rules.firstAfterQuietOf(null, t0, true), true);
    eq(rules.firstAfterQuietOf(null, t0, false), false);
    eq(rules.firstAfterQuietOf({ until: t0, at: t0 - 15 * m, strikes: 1, reason: '' }, t0 + 90 * 1000, false), true);    // 90 s after the pause ended
    eq(rules.firstAfterQuietOf({ until: t0, at: t0 - 15 * m, strikes: 1, reason: '' }, t0 + 5 * m, false), false);
    eq(rules.firstAfterQuietOf({ until: t0, at: t0 - 15 * m, strikes: 1, reason: '' }, t0 - m, false), false);          // sent before it ended: the old burst
    // the view: shown while the refusal counts (paused or within 2 h), gone after
    let v = rules.pauseView({ until: t0 + 15 * m, at: t0, strikes: 1, reason: '130429', firstAfterQuiet: true }, t0 + m);
    deq([v.state, v.firstAfterQuiet], ['paused', true]);
    eq(rules.pauseView({ until: t0 + 15 * m, at: t0, strikes: 1, reason: '130429', firstAfterQuiet: true }, t0 + 130 * m).firstAfterQuiet, false);
    eq(rules.pauseView({ until: t0 + 15 * m, at: t0, strikes: 1, reason: '130429' }, t0 + m).firstAfterQuiet, false);
    eq(rules.parsePauseState(JSON.stringify({ until: new Date(t0).toISOString(), at: new Date(t0).toISOString(), strikes: 1, firstAfterQuiet: true })).firstAfterQuiet, true);
    eq(rules.parsePauseState(JSON.stringify({ until: new Date(t0).toISOString(), at: new Date(t0).toISOString(), strikes: 1, firstAfterQuiet: 'yes' })).firstAfterQuiet, undefined);
    // through Meta's delivery report: the first message after 10 quiet minutes
    pause.forgetPauseCache(); delete S.settings.wa_pause;
    const now = Date.now();
    S.rows.push({ id: 'q1', business_id: 'b1', order_id: '#1553', kind: 'placed', status: 'sent', wa_id: 'wamid.q1', attempts: 1, sent_at: new Date(now - 8000), due_at: new Date(), updated_at: new Date() });
    await status.noteAutoStatus('wamid.q1', 'failed', '130429 · Rate limit hit');
    let st = rules.parsePauseState(S.settings.wa_pause);
    deq([st.strikes, st.firstAfterQuiet], [1, true]);
    eq(rules.pauseView(st, Date.now()).firstAfterQuiet, true);
    const ov = (await route.GET(jreq(OWNER, {}))).body;
    eq(ov.pauseInfo.firstAfterQuiet, true);
    // a pause by hand and Resume now keep what Meta's refusal told
    eq((await route.POST(jreq(OWNER, { action: 'resume' }))).status, 200);
    eq(rules.parsePauseState(S.settings.wa_pause).firstAfterQuiet, true);
    eq((await route.POST(jreq(OWNER, { action: 'pause', minutes: 15 }))).status, 200);
    eq(rules.parsePauseState(S.settings.wa_pause).firstAfterQuiet, true);
    // a refusal in the middle of a run of messages (one went 3 minutes before): no flag
    pause.forgetPauseCache(); delete S.settings.wa_pause; S.rows.length = 0;
    S.rows.push({ id: 'q2', business_id: 'b1', order_id: '#1554', kind: 'placed', status: 'sent', wa_id: 'wamid.q2', attempts: 1, sent_at: new Date(now - 3 * m), due_at: new Date(), updated_at: new Date() });
    S.rows.push({ id: 'q3', business_id: 'b1', order_id: '#1555', kind: 'placed', status: 'sent', wa_id: 'wamid.q3', attempts: 1, sent_at: new Date(now - 8000), due_at: new Date(), updated_at: new Date() });
    await status.noteAutoStatus('wamid.q3', 'failed', '130429 · Rate limit hit');
    st = rules.parsePauseState(S.settings.wa_pause);
    deq([st.strikes, st.firstAfterQuiet], [1, undefined]);
    eq((await route.GET(jreq(OWNER, {}))).body.pauseInfo.firstAfterQuiet, false);
    // at send time: Meta refuses the first message after a quiet stretch at once
    pause.forgetPauseCache(); delete S.settings.wa_pause; S.rows.length = 0; S.fetches = [];
    turnOn(); S.orders = [order()]; S.sendFail = { code: 130429, message: 'Rate limit hit' };
    await run(IST(13, 12));
    st = rules.parsePauseState(S.settings.wa_pause);
    deq([st.strikes, st.firstAfterQuiet], [1, true]);
    S.sendFail = null; delete S.settings.wa_pause; pause.forgetPauseCache();
  });
  await t('Meta\'s side in the Number status box (owner 15 Oct): the overview carries the number\'s quality, status and messaging limit (read at most every 5 min, never throws); nothing when WhatsApp is not set up', async () => {
    const wh = require(path.join(SRC, 'lib/chat/whatsapp-health.ts'));
    wh.resetWaPhoneCache(); S.settings.whatsapp_daily_limit = '2000';
    let ov = await auto.automationOverview(null, IST(13, 12));
    const h = ov.numberHealth;
    deq([h.quality, h.status, h.tier, h.limit, h.limitFrom, h.used24h, h.usedToday, h.error], ['GREEN', 'CONNECTED', 'TIER_2K', 2000, 'meta', 613, 311, null]);
    deq(h.lines, []);
    // Meta says the number is restricted and RED: the lines say so
    wh.resetWaPhoneCache(); S.phone = { ...S.phone, quality_rating: 'RED', status: 'RESTRICTED' };
    ov = await auto.automationOverview(null, IST(13, 12));
    deq(ov.numberHealth.lines.map((l) => l.tone), ['danger', 'danger']); assert.match(ov.numberHealth.lines[0].text, /RESTRICTED/);
    // Meta unreadable: the box still has our own numbers, with the reason
    wh.resetWaPhoneCache(); S.phone = null;
    ov = await auto.automationOverview(null, IST(13, 12));
    deq([ov.numberHealth.quality, typeof ov.numberHealth.error], ['UNKNOWN', 'string']);
    const keep = process.env.WHATSAPP_CLOUD_TOKEN; delete process.env.WHATSAPP_CLOUD_TOKEN;
    try { eq((await auto.automationOverview(null, IST(13, 12))).numberHealth, null); } finally { process.env.WHATSAPP_CLOUD_TOKEN = keep; }
    wh.resetWaPhoneCache();
  });

  // ── owner 15 Oct, live: the PM2 log said "order_placed_link is not made yet" while the Templates tab showed it APPROVED ──
  const LINK2 = { ...LINK, id: 't4', name: 'order_placed_link_2', language: 'en' };                         // remade: Meta kept the old name
  const LINK4 = { ...LINK, id: 't5', name: 'order_placed_link_v2', components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} with {{3}} is placed. Track: {{4}} .' }] };
  await t('findLinkTemplate (owner 15 Oct, "not made yet" while the tab said APPROVED): the exact name wins over a prefix; an APPROVED order_placed_link_* with 5 values is used; one with 4 values never; nothing = MISSING; the state follows the exact one, else the best prefix match', () => {
    const T = (name, status, vars = 5, language = 'en_US') => ({ name, status, vars, language });
    eq(rules.LINK_VARS, 5);
    deq([rules.isLinkTemplateName('order_placed_link'), rules.isLinkTemplateName(' Order_Placed_Link_2 '), rules.isLinkTemplateName('order_placed'), rules.isLinkTemplateName(null)], [true, true, false, false]);
    // the exact name wins, whatever Meta lists first
    let f = rules.findLinkTemplate([T('order_placed_link_2', 'APPROVED'), T('order_placed_link', 'APPROVED')]);
    deq([f.template.name, f.state, f.note], ['order_placed_link', 'APPROVED', null]);
    // a stray capital / space never hides the exact one
    eq(rules.findLinkTemplate([T(' Order_Placed_Link ', 'APPROVED')]).template.name, ' Order_Placed_Link ');
    // no exact one: the first APPROVED prefix match with 5 values, deterministic (Meta's order)
    f = rules.findLinkTemplate([T('order_placed', 'APPROVED', 4), T('order_placed_link_v2', 'APPROVED', 4), T('order_placed_link_2', 'APPROVED'), T('order_placed_link_3', 'APPROVED')]);
    deq([f.template.name, f.template.language, f.state], ['order_placed_link_2', 'en_US', 'APPROVED']);
    // a prefix match with 4 values is never picked (Meta would refuse the send): the state says why
    f = rules.findLinkTemplate([T('order_placed', 'APPROVED', 4), T('order_placed_link_v2', 'APPROVED', 4)]);
    deq([f.template, f.state], [null, 'APPROVED']); assert.match(f.note, /order_placed_link_v2 is approved on Meta but has 4 values, the automation fills 5/);
    assert.match(rules.linkModeOf(null, null, f.state, null, f.note).reason, /^two messages: order_placed_link_v2 is approved on Meta but has 4 values/);
    // the exact one PENDING: its status, as before; a pending prefix match: its status with its name
    f = rules.findLinkTemplate([T('order_placed_link', 'PENDING'), T('order_placed_link_2', 'APPROVED')]);
    deq([f.template.name, f.state], ['order_placed_link_2', 'APPROVED']);                               // an approved remake beats the pending exact one
    f = rules.findLinkTemplate([T('order_placed_link', 'PENDING')]); deq([f.template, f.state, f.note], [null, 'PENDING', null]);
    assert.match(rules.linkModeOf(null, null, f.state, null, f.note).reason, /order_placed_link is pending on Meta, not approved/);
    f = rules.findLinkTemplate([T('order_placed_link_2', 'REJECTED')]); deq([f.template, f.state], [null, 'REJECTED']); assert.match(f.note, /order_placed_link_2 is rejected on Meta/);
    // the exact one REJECTED and a 5-value remake PENDING: the exact one's status is what the screen says
    eq(rules.findLinkTemplate([T('order_placed_link', 'REJECTED'), T('order_placed_link_2', 'PENDING')]).state, 'REJECTED');
    // nothing: MISSING; no list: UNKNOWN
    deq(rules.findLinkTemplate([T('order_placed', 'APPROVED', 4), T('order_tracking', 'APPROVED')]), { template: null, state: 'MISSING', note: null });
    deq(rules.findLinkTemplate(null), { template: null, state: 'UNKNOWN', note: null });
    // what the worker read, for the log: count, masked account, the order_* names with their status, at most 8
    eq(rules.templatesReadNote([T('order_placed', 'APPROVED', 4), T('order_tracking', 'APPROVED'), T('Order_Placed_Link_v2 ', 'PENDING'), T('shiptrack_alert', 'APPROVED', 1)], '…8651'),
      '(read 4 templates from account …8651: order_placed APPROVED, order_tracking APPROVED, order_placed_link_v2 PENDING)');
    eq(rules.templatesReadNote([T('shiptrack_alert', 'APPROVED', 1)], null), '(read 1 template: none named order_…)');
    const many = Array.from({ length: 10 }, (_, i) => T(`order_x${i}`, 'APPROVED'));
    assert.match(rules.templatesReadNote(many, '…8651'), /order_x7 APPROVED, \+2 more\)$/);
    eq(rules.templatesReadNote(null, '…8651'), '');
    eq(rules.MODE_LOG_EVERY_MS, 10 * 60000);
  });
  await t('a remade order_placed_link_2 (owner 15 Oct): the worker sends it under its real name and language, the tracking row is skipped now and when its turn comes (placed_template = the real name); the overview and the test send carry the name', async () => {
    pause.forgetPauseCache(); auto.resetModeLog(); turnOn();
    S.metaTemplates.push(LINK4, LINK2);                                             // the 4-value one first: never picked
    S.orders = [order(), order({ order_id: '#1554', customer_mobile: '9811122233' })];
    const cap = captureLog();
    try { await run(IST(13, 12)); } finally { cap.restore(); }
    const f = sends(); eq(f.length, 2);
    deq(f.map(tplOf), ['order_placed_link_2', 'order_placed_link_2']);
    deq(f.map((x) => x.body.template.language.code), ['en', 'en']);
    deq(valuesOf(f[0]), ['Aaditya', '#1553', 'Vastora', 'https://shiptrack.store/track/tok-1553', 'help@vastora.test']);
    assert.match(cap.lines.find((l) => /^\[wa-auto\] one message/.test(l)), /^\[wa-auto\] one message: order_placed_link_2 \(en\) is approved and the switch is ON$/);
    assert.ok(!cap.lines.some((l) => /read \d+ templates/.test(l)), 'no "what was read" note while the mode is one message');
    for (const id of ['#1553', '#1554']) {
      const placed = S.rows.find((r) => r.order_id === id && r.kind === 'placed'); deq([placed.status, placed.template], ['sent', 'order_placed_link_2']);
      const tr = S.rows.find((r) => r.order_id === id && r.kind === 'tracking'); deq([tr.status, tr.error], ['skipped', rules.SKIP.inFirst]);
    }
    // a tracking row of such an order that is somehow still pending is skipped when its turn comes (the prefix check)
    const tr = S.rows.find((r) => r.order_id === '#1553' && r.kind === 'tracking'); tr.status = 'pending'; tr.error = null; tr.due_at = new Date(IST(15, 12));
    S.fetches = []; await run(IST(15, 12));
    deq(sends().map(tplOf), []); deq([tr.status, tr.error], ['skipped', rules.SKIP.inFirst]);
    // the overview: the state and the real name; the switch line names it
    const ov = await auto.automationOverview(null, IST(13, 12));
    deq([ov.templates.link, ov.templates.linkName, ov.linkMode.active, ov.linkMode.template.name, ov.linkMode.template.language], ['APPROVED', 'order_placed_link_2', true, 'order_placed_link_2', 'en']);
    // the exact name present and approved: linkName stays null (nothing to add on the screen)
    S.metaTemplates.push(LINK); auto.resetTemplateCache();
    const ov2 = await auto.automationOverview(null, IST(13, 13));
    deq([ov2.templates.link, ov2.templates.linkName, ov2.linkMode.template.name], ['APPROVED', null, 'order_placed_link']);
    S.metaTemplates.pop(); auto.resetTemplateCache();
    // the test send: one message, the remade template
    S.fetches = [];
    const ts = await auto.sendAutomationTest('b1', '9876500001', 'Test');
    deq(ts.results.map((x) => [x.kind, x.ok]), [['placed', true]]); eq(tplOf(sends()[0]), 'order_placed_link_2'); assert.match(ts.mode, /^one message: order_placed_link_2 \(en\)/);
  });
  await t('the mode line says what the worker read (owner 15 Oct): "not made yet" carries the account\'s last 4 digits, the count and the order_* names with their status; a 4-value remake is named with why; the line is logged again after 10 minutes even when nothing changed, not before; never the token', async () => {
    pause.forgetPauseCache(); auto.resetModeLog(); turnOn(); S.orders = [order()];
    let cap = captureLog();
    try { await run(IST(13, 12)); await run(IST(13, 12, 1)); await run(IST(13, 21)); } finally { cap.restore(); }
    let modeLines = cap.lines.filter((l) => /^\[wa-auto\] two messages/.test(l));
    eq(modeLines.length, 2, 'once at first, once more after 10 minutes (the run a minute later said nothing new)');
    eq(modeLines[0], '[wa-auto] two messages: order_placed_link is not made yet (read 2 templates from account …8651: order_placed APPROVED, order_tracking APPROVED)');
    eq(modeLines[1], modeLines[0]);
    assert.ok(!cap.lines.some((l) => /tok-secret/.test(l)), 'the token never reaches the log');
    deq(sends().map(tplOf), ['order_placed']);                                      // the old message still goes
    // a remade template with 4 values: the line names it and says why it is not used
    S.metaTemplates.push(LINK4); auto.resetTemplateCache(); S.orders.push(order({ order_id: '#1554', customer_mobile: '9811122233' })); S.fetches = [];
    cap = captureLog();
    try { await run(IST(13, 12, 2)); } finally { cap.restore(); }
    modeLines = cap.lines.filter((l) => /^\[wa-auto\] two messages/.test(l)); eq(modeLines.length, 1, 'the reason changed: logged at once');
    eq(modeLines[0], '[wa-auto] two messages: order_placed_link_v2 is approved on Meta but has 4 values, the automation fills 5: make it again from its preset button (read 3 templates from account …8651: order_placed APPROVED, order_tracking APPROVED, order_placed_link_v2 APPROVED)');
    deq(sends().map(tplOf), ['order_placed']);
    const ov = await auto.automationOverview(null, IST(13, 12, 2));
    deq([ov.templates.link, ov.templates.linkName, ov.linkMode.active], ['APPROVED', 'order_placed_link_v2', false]); assert.match(ov.linkMode.reason, /has 4 values/);
    // the switch OFF: no "what was read" note (the switch is the reason, not the template)
    S.settings.wa_link_mode = JSON.stringify({ on: false, by: 'owner', at: 'x' }); auto.forgetLinkModeCache();
    cap = captureLog();
    try { await run(IST(13, 12, 3)); } finally { cap.restore(); }
    const off = cap.lines.find((l) => /^\[wa-auto\] two messages/.test(l)); assert.match(off, /switch .* is OFF \(by owner\)$/); assert.ok(!/read \d+ templates/.test(off));
    delete S.settings.wa_link_mode; auto.forgetLinkModeCache(); auto.resetModeLog();
  });

  // ── owner 15 Oct, evening: the speed setting, the daily limit guard, "refused near the limit", template usage chips ──
  const wh = require(path.join(SRC, 'lib/chat/whatsapp-health.ts'));
  await t('the speed setting (owner 15 Oct, "har minute 2, 3, 4 message"): 1-4 a minute from chat_settings wa_send_rate (no row / junk = 2); after a 130429 the gap is the slower of 60 s and the chosen one, never faster than chosen; the view says "slow" only against the chosen gap', () => {
    const m = 60000, t0 = IST(13, 14);
    eq(rules.SEND_RATE_KEY, 'wa_send_rate'); deq([...rules.SEND_RATES], [1, 2, 3, 4]); eq(rules.DEFAULT_PER_MINUTE, 2);
    deq([null, '', 'junk', JSON.stringify({ perMinute: 5 }), JSON.stringify({ perMinute: 0 }), JSON.stringify({ perMinute: '2.5' })].map((v) => rules.parseSendRate(v).perMinute), [2, 2, 2, 2, 2, 2]);
    deq(rules.parseSendRate(rules.sendRateValue(3, 'owner', t0)), { perMinute: 3, by: 'owner', at: new Date(t0).toISOString() });
    deq([1, 2, 3, 4, 7].map(rules.gapFor), [60000, 30000, 20000, 15000, 30000]);
    eq(rules.gapFor(2), rules.SEND_EVERY_MS);
    // the gap: chosen when calm; the slower of 60 s and chosen for two hours after a refusal
    deq([15000, 20000, 30000, 60000].map((b) => rules.sendEveryFor(null, t0, b)), [15000, 20000, 30000, 60000]);
    const strike = { until: t0 + 15 * m, at: t0, strikes: 1, reason: '' };
    deq([15000, 20000, 30000, 60000].map((b) => rules.sendEveryFor(strike, t0 + 20 * m, b)), [60000, 60000, 60000, 60000]);
    deq([15000, 60000].map((b) => rules.sendEveryFor({ ...strike, strikes: 4 }, t0 + 20 * m, b)), [60000, 60000]);   // never slower than 1 a minute, whatever the strikes
    deq([15000, 60000].map((b) => rules.sendEveryFor(strike, t0 + 2 * 60 * m, b)), [15000, 60000]);               // two quiet hours: the chosen gap again
    eq(rules.sendEveryFor(strike, t0 + 20 * m), 60000, 'the old default is unchanged');
    // the view: 4 a minute with a fresh strike = slow (1 a minute until the window ends); 1 a minute with a strike = normal (nothing to slow)
    let v = rules.pauseView(strike, t0 + 20 * m, 15000); deq([v.state, v.sendEveryMs, v.perMinute, v.slowUntil], ['slow', 60000, 4, new Date(t0 + 120 * m).toISOString()]);
    v = rules.pauseView(strike, t0 + 20 * m, 60000); deq([v.state, v.sendEveryMs, v.perMinute, v.slowUntil], ['normal', 60000, 1, null]);
    v = rules.pauseView(null, t0, 20000); deq([v.state, v.sendEveryMs, v.perMinute], ['normal', 20000, 3]);
    eq(rules.pauseView(null, t0).perMinute, 2);
  });
  await t('the speed setting: the route (Super Admin; 1, 2, 3 or 4, anything else 400), the worker takes the chosen gap to the send slot, the overview carries it; a strike makes it 1 a minute whatever was chosen', async () => {
    pause.forgetPauseCache(); pause.forgetSendRateCache(); delete S.settings.wa_send_rate;
    eq((await route.POST(jreq(AGENT, { action: 'rate', perMinute: 3 }))).status, 401);
    eq((await route.POST(jreq(null, { action: 'rate', perMinute: 3 }))).status, 401);
    for (const bad of [5, 0, -1, 2.5, 'x', '', null, undefined, true, [3]]) { const r = await route.POST(jreq(OWNER, { action: 'rate', perMinute: bad })); eq(r.status, 400, `perMinute ${JSON.stringify(bad)}`); }
    eq(S.settings.wa_send_rate, undefined, 'nothing saved by a refused call');
    let r = await route.POST(jreq(OWNER, { action: 'rate', perMinute: '3' }));           // a number as a string is fine (a form field)
    deq([r.status, r.body.perMinute, r.body.sendRate.by], [200, 3, 'owner']);
    deq(rules.parseSendRate(S.settings.wa_send_rate).perMinute, 3);
    // the worker: the slot is asked for 20 s (3 a minute)
    turnOn(); S.orders = [order()]; pause.forgetSendRateCache();
    await run(IST(13, 12)); eq(sends().length, 1); eq(S.slotEvery, 20000);
    // the overview says so
    let ov = (await route.GET(jreq(OWNER, {}))).body;
    deq([ov.sendRate.perMinute, ov.sendRate.by, ov.sendEveryMs, ov.pauseInfo.perMinute, ov.pauseInfo.state], [3, 'owner', 20000, 3, 'normal']);
    // 4 a minute, then a 130429 within the last 2 hours: 1 a minute (the slower of 60 s and 15 s), the view says slow
    r = await route.POST(jreq(OWNER, { action: 'rate', perMinute: 4 })); eq(r.status, 200); pause.forgetSendRateCache();
    S.settings.wa_pause = JSON.stringify({ until: new Date(IST(13, 12, 10)).toISOString(), reason: '130429', at: new Date(IST(13, 12, 10) - 15 * 60000).toISOString(), strikes: 1 }); pause.forgetPauseCache();
    S.orders.push(order({ order_id: '#1554', customer_mobile: '9811122233' }));
    await run(IST(13, 12, 30)); eq(sends().length, 2); eq(S.slotEvery, 60000);
    ov = await auto.automationOverview(null, IST(13, 12, 30)); deq([ov.sendRate.perMinute, ov.pauseInfo.state, ov.pauseInfo.sendEveryMs], [4, 'slow', 60000]);   // at the worker's time (the strike is 15 min old)
    // 1 a minute chosen: a strike changes nothing and the view stays normal (never faster than chosen, never slower than 1)
    r = await route.POST(jreq(OWNER, { action: 'rate', perMinute: 1 })); eq(r.status, 200); pause.forgetSendRateCache();
    S.orders.push(order({ order_id: '#1555', customer_mobile: '9811122244' }));
    await run(IST(13, 12, 31)); eq(sends().length, 3); eq(S.slotEvery, 60000);
    ov = await auto.automationOverview(null, IST(13, 12, 31)); deq([ov.sendRate.perMinute, ov.pauseInfo.state, ov.pauseInfo.sendEveryMs, ov.pauseInfo.perMinute], [1, 'normal', 60000, 1]);
    // the screens: the select in the Number status box, the Automation paragraph names the chosen speed, the card is wired
    const card = fs.readFileSync(path.join(SRC, 'components/whatsapp/PauseStatusCard.tsx'), 'utf8');
    assert.match(card, /Order messages per minute:/); assert.match(card, /SEND_RATES\.map/); assert.match(card, /onRate\(pick\)/);
    const panel = fs.readFileSync(path.join(SRC, 'components/whatsapp/AutomationPanel.tsx'), 'utf8');
    assert.match(panel, /action: 'rate', perMinute: n/); assert.match(panel, /o\.sendRate\?\.perMinute \?\? 2\} a minute/); assert.ok(!/one every 30 seconds \(2 a minute/.test(panel), 'the fixed "30 seconds" sentence is gone');
    delete S.settings.wa_send_rate; delete S.settings.wa_pause; pause.forgetSendRateCache(); pause.forgetPauseCache();
  });
  await t('the daily limit guard (owner 15 Oct, 130429 at ~250 customers in 24 h whatever the speed): at the typed limit a NEW customer waits (pending, not failed / skipped) and one messaged in the last 24 h still goes; said once per run; alerts and the test send are never held; one more goes when the count drops; the count is kept within a run', async () => {
    const captured = captureLog();
    try {
      pause.forgetPauseCache(); pause.forgetSendRateCache(); wh.resetWaPhoneCache();
      S.phone = { ...S.phone, messaging_limit_tier: '' };                     // Meta gives no tier: the typed limit counts
      S.settings.whatsapp_daily_limit = '250';
      S.used = { n: 250, today: 242, oldest: new Date(IST(12, 13, 5)) };
      // one customer was messaged yesterday evening (known to Meta's window), one is new
      S.rows.push({ id: 'k1', business_id: 'b1', order_id: '#1400', kind: 'placed', status: 'sent', to_number: '919811122233', attempts: 1, due_at: new Date(IST(12, 20)), sent_at: new Date(IST(12, 20)), wa_id: 'wamid.k1', updated_at: new Date(IST(12, 20)) });
      S.rows.push({ id: 'k2', business_id: 'b1', order_id: '#1400', kind: 'tracking', status: 'skipped', to_number: '919811122233', attempts: 0, due_at: new Date(IST(12, 20)), sent_at: null, wa_id: null, updated_at: new Date(IST(12, 20)) });
      turnOn(); S.orders = [order(), order({ order_id: '#1554', customer_mobile: '9811122233' })];
      const r1 = await run(IST(13, 12));
      deq([r1.sent, r1.limited, r1.failed, r1.skipped], [1, 1, 0, 0]);
      deq(sends().map((f) => f.body.to), ['919811122233']);                 // the known customer went, the new one waits
      const waiting = S.rows.find((r) => r.order_id === '#1553' && r.kind === 'placed');
      deq([waiting.status, waiting.attempts, waiting.error, new Date(waiting.due_at).getTime()], ['pending', 0, null, IST(13, 12)]);   // not claimed, not failed, not skipped
      const line = '[wa-auto] daily limit reached: 250 of 250 customers in the last 24 h; new customers wait';
      eq(captured.lines.filter((l) => l === line).length, 1, 'once per run');
      await run(IST(13, 12, 1));
      eq(captured.lines.filter((l) => l === line).length, 2, 'once per run, every run it holds');
      eq(sends().length, 1);
      // ShipTrack's own alerts and the test send never pass through the guard
      const q = require(path.join(SRC, 'lib/chat/whatsapp-alert-queue.ts'));
      const a = await q.sendAlert({ to: '919876500001', name: 'shiptrack_alert', language: 'en_US', text: 'CHARGEBACK mail on VASTRIKA' });
      assert.ok(a.id, 'the alert went'); eq(sends().length, 2);
      const ts = await auto.sendAutomationTest('b1', '9876500002', 'Test');
      deq(ts.results.map((x) => x.ok), [true, true]); eq(sends().length, 4);
      for (const k of Object.keys(S.settings)) if (k.startsWith('wa_alert_sent:')) delete S.settings[k];
      // the Number status box: reached, when the oldest drops out (24 h after it), the line
      let ov = await auto.automationOverview(null, IST(13, 12, 2));
      deq([ov.numberHealth.limitReached, ov.numberHealth.limitFreeAt, ov.numberHealth.limit, ov.numberHealth.used24h], [true, new Date(IST(13, 13, 5)).toISOString(), 250, 250]);
      assert.match(ov.numberHealth.lines.find((l) => /Daily limit reached/.test(l.text)).text, /^Daily limit reached: 250 \/ 250 in the last 24 h — new customers wait until the oldest drops out \(about 1:05 pm\); customers messaged in the last 24 h still get theirs$/);
      eq(ov.numberHealth.lines.find((l) => /Daily limit reached/.test(l.text)).tone, 'danger');
      eq('refusedNearLimit' in ov.numberHealth, false, 'the "Meta refused near the limit" field is gone');
      // the oldest dropped out: 249 in the window, so ONE new customer goes; a second new one in the same run waits (the run counts its own sends)
      S.used = { n: 249, today: 241, oldest: new Date(IST(12, 13, 30)) };
      S.orders.push(order({ order_id: '#1555', customer_mobile: '9811122299' })); S.fetches = [];
      const r3 = await run(IST(13, 13, 6));
      deq([r3.sent, r3.limited], [1, 1]);
      deq(sends().map((f) => f.body.to), ['919876543210']);                 // the older waiting one first (due_at order)
      eq(S.rows.find((r) => r.order_id === '#1555' && r.kind === 'placed').status, 'pending');
      ov = await auto.automationOverview(null, IST(13, 13, 6));
      eq(ov.numberHealth.limitReached, false);                              // the count says 249: the box is calm again (the next count will say 250)
      // a known customer still goes at the limit even when the count is far above it
      S.used = { n: 400, today: 300, oldest: new Date(IST(12, 14)) }; S.fetches = [];
      S.orders.push(order({ order_id: '#1556', customer_mobile: '9811122233' }));
      const r4 = await run(IST(13, 13, 7)); deq([r4.sent, r4.limited], [1, 1]); deq(sends().map((f) => f.body.to), ['919811122233']);
      // no limit typed and no tier from Meta: nothing waits, whatever the count
      delete S.settings.whatsapp_daily_limit; S.fetches = [];
      const r5 = await run(IST(13, 13, 8)); deq([r5.sent, r5.limited], [1, 0]); deq(sends().map((f) => f.body.to), ['919811122299']);
      ov = await auto.automationOverview(null, IST(13, 13, 8)); deq([ov.numberHealth.limit, ov.numberHealth.limitReached], [null, false]);
      // the guard reads the numbers only near the limit: one count query per run, the numbers only when within a batch of it
      const src = fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-auto.ts'), 'utf8');
      assert.match(src, /used24h \+ BATCH >= limit \? await knownNumbers24h\(\) : null/);
      assert.ok(src.indexOf('newCustomer(guard, digits) && guard.used >= guard.limit') < src.indexOf('takeSendSlot(every)'), 'checked before the slot and the claim');
      assert.ok(!/dailyGuard|knownNumbers24h|limitNow/.test(fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-alert-queue.ts'), 'utf8')), 'alerts never pass through the guard');
    } finally { captured.restore(); }
    S.phone = { ...S.phone, messaging_limit_tier: 'TIER_2K' }; wh.resetWaPhoneCache(); S.used = { n: 613, today: 311, oldest: null }; delete S.settings.whatsapp_daily_limit;
  });
  await t('the daily limit lines (owner 15 Oct): reached / free at / the health line; the "Meta refused near the limit, type 250" line is GONE (the evening\'s live data disproved it: 343 messages in 4 hours the day before with no refusal), cleanly, from the rules, the overview, the card and this suite', async () => {
    eq(health.refusedNearLimit, undefined); eq(health.METAS_STARTING_LIMIT, undefined); eq(health.REFUSED_ABOVE, undefined); eq(health.REFUSED_NEAR_LIMIT_PCT, undefined);
    for (const f of ['lib/chat/whatsapp-health-rules.ts', 'lib/chat/whatsapp-auto.ts', 'components/whatsapp/PauseStatusCard.tsx', 'components/whatsapp/AutomationPanel.tsx', 'lib/chat/whatsapp-health.ts', 'components/PanelBoard.tsx']) {
      assert.ok(!/refusedNearLimit|METAS_STARTING_LIMIT|REFUSED_ABOVE|Type 250/.test(fs.readFileSync(path.join(SRC, f), 'utf8')), `gone from ${f}`);
    }
    // the limit lines: reached / free at / the health line (the Today board shows the same line)
    deq([health.limitReached({ used24h: 250, limit: 250 }), health.limitReached({ used24h: 249, limit: 250 }), health.limitReached({ used24h: 999, limit: null }), health.limitReached({ used24h: 1, limit: 0 })], [true, false, false, false]);
    eq(health.limitFreeAt({ oldest24h: new Date(IST(12, 13, 5)).toISOString() }), new Date(IST(13, 13, 5)).toISOString()); eq(health.limitFreeAt({ oldest24h: null }), null); eq(health.limitFreeAt({}), null);
    eq(health.dailyLimitLine({ used24h: 249, limit: 250 }), null);
    eq(health.dailyLimitLine({ used24h: 251, limit: 250, oldest24h: null }), 'Daily limit reached: 251 / 250 in the last 24 h — new customers wait until the oldest drops out; customers messaged in the last 24 h still get theirs');
    const base = { quality: 'GREEN', status: 'CONNECTED', tier: 'UNKNOWN', limit: 250, limitFrom: 'saved', used24h: 250, failedToday: 0, waitingToday: 0, stopped: 0, phoneError: null, oldest24h: new Date(IST(12, 13, 5)).toISOString() };
    const lines = health.waHealthLines(base); eq(lines.length, 1); eq(lines[0].tone, 'danger'); assert.match(lines[0].text, /^Daily limit reached: 250 \/ 250 .* \(about 1:05 pm\)/);
    assert.match(health.waHealthLines({ ...base, used24h: 230 })[0].text, /^Daily limit almost used: 230 of 250/);
    // through the overview: a refusal in the last 2 hours + the count near the typed limit says nothing beyond the limit guard itself
    pause.forgetPauseCache(); wh.resetWaPhoneCache();
    S.settings.whatsapp_daily_limit = '2000'; S.phone = { ...S.phone, messaging_limit_tier: '' }; S.used = { n: 242, today: 242, oldest: new Date(IST(12, 13)) };
    S.settings.wa_pause = JSON.stringify({ until: new Date(IST(13, 12, 15)).toISOString(), reason: '130429 Rate limit hit', at: new Date(IST(13, 12)).toISOString(), strikes: 1 });
    const ov = await auto.automationOverview(null, IST(13, 12, 5));
    deq([ov.numberHealth.limitReached, ov.numberHealth.limit, ov.numberHealth.used24h, 'refusedNearLimit' in ov.numberHealth], [false, 2000, 242, false]);
    deq(ov.numberHealth.lines, []);                                                 // 242 of 2,000: nothing to say
    const card = fs.readFileSync(path.join(SRC, 'components/whatsapp/PauseStatusCard.tsx'), 'utf8');
    assert.match(card, /health\?\.limitReached/);
    delete S.settings.wa_pause; delete S.settings.whatsapp_daily_limit; pause.forgetPauseCache(); S.phone = { ...S.phone, messaging_limit_tier: 'TIER_2K' }; wh.resetWaPhoneCache(); S.used = { n: 613, today: 311, oldest: null };
  });
  await t('template usage chips (owner 15 Oct, "ye wala working hai baaki nahi"): which template ShipTrack sends for what, from the automation\'s mode; the link card carries the one-message switch', () => {
    eq(rules.ALERT_TEMPLATE, brandRules.SHIPTRACK_ALERT_PRESET.name);
    const link = { name: 'order_placed_link', language: 'en_US' };
    const active = rules.linkModeOf(null, link, 'APPROVED', null);
    const off = rules.linkModeOf({ on: false, by: 'owner', at: 'x' }, link, 'APPROVED', null);
    const pending = rules.linkModeOf(null, null, 'PENDING', null);
    const fourVals = rules.linkModeOf(null, null, 'APPROVED', null, 'order_placed_link_v2 is approved on Meta but has 4 values, the automation fills 5: make it again from its preset button');
    const T = (name, status = 'APPROVED') => ({ name, status });
    const u = (t, m) => { const r = rules.templateUsage(t, m); return [r.text, r.tone]; };
    const IN_USE = 'In use: every order (new orders, and the 48-hour link for older ones)';
    deq(u(T('order_placed_link'), active), [IN_USE, 'ok']);
    deq(u(T(' Order_Placed_Link '), active), [IN_USE, 'ok']);
    deq(u(T('order_placed_link'), off), ['Not in use (switch OFF)', 'warn']);
    deq(u(T('order_placed_link', 'PENDING'), off), ['Not in use (switch OFF)', 'warn']);
    deq(u(T('order_placed_link', 'PENDING'), pending), ['Waiting for approval', 'warn']);
    deq(u(T('order_placed_link', 'REJECTED'), rules.linkModeOf(null, null, 'REJECTED', null)), ['Not in use (not approved (rejected))', 'warn']);
    deq(u(T('order_placed_link_v2'), fourVals), ['Not in use: order_placed_link_v2 is approved on Meta but has 4 values, the automation fills 5: make it again from its preset button', 'warn']);
    // a remade order_placed_link_2 is the one sent: the old exact one says so
    const remade = rules.linkModeOf(null, { name: 'order_placed_link_2', language: 'en' }, 'APPROVED', null);
    deq(u(T('order_placed_link_2'), remade), [IN_USE, 'ok']);
    deq(u(T('order_placed_link'), remade), ['Not in use (order_placed_link_2 is the one sent)', 'muted']);
    // the old two (owner 15 Oct evening, deleted on Meta): never sent in the one-message mode, whatever their status
    deq(u(T('order_placed'), active), ['Not used (one message mode)', 'muted']);
    deq(u(T('order_placed', 'MISSING'), active), ['Not used (one message mode)', 'muted']);
    deq(u(T('order_tracking', 'PENDING'), remade), ['Not used (one message mode)', 'muted']);
    deq(u(T('order_placed'), off), ['In use: every new order', 'ok']);
    deq(u(T('order_placed'), pending), ['In use: every new order', 'ok']);
    deq(u(T('order_placed', 'PENDING'), off), ['In use: every new order — but waiting for approval', 'warn']);
    deq(u(T('order_placed', 'REJECTED'), off), ['In use: every new order — but not approved (rejected)', 'warn']);
    deq(u(T('order_tracking'), active), ['Not used (one message mode)', 'muted']);
    deq(u(T('order_tracking'), off), ['In use: every order, 48 hours later', 'ok']);
    deq(u(T('shiptrack_alert'), active), ['In use: ShipTrack alerts (chargeback, AI credit, chargeback risk, stuck promises)', 'ok']);
    deq(u(T('shiptrack_alert', 'PENDING'), active), ['In use: ShipTrack alerts (chargeback, AI credit, chargeback risk, stuck promises) — but waiting for approval', 'warn']);
    deq(u(T('hello_world'), active), ['Not used by ShipTrack', 'muted']);
    deq(u(T('order_update_v1'), off), ['Not used by ShipTrack', 'muted']);
    // the screen: the chip on every card, the switch only on a link template, the same POST as the Automation tab, read from the overview
    const src = fs.readFileSync(path.join(SRC, 'components/whatsapp/TemplatesPanel.tsx'), 'utf8');
    assert.match(src, /templateUsage\(t, mode\)/); assert.match(src, /isLinkTemplateName\(t\.name\) && \(/); assert.match(src, /action: 'link_mode', on/);
    assert.match(src, /fetch\('\/api\/whatsapp\/automation', \{ headers: auth, cache: 'no-store' \}\)/);
    assert.ok(!/model/i.test(src), 'no model names');
  });

  // ── owner 15 Oct evening: he DELETED order_placed and order_tracking on Meta; only order_placed_link is left ("jo atka ha
  // unka new template sa bhejio, mix mat kario" = everything waiting goes with the new template, never mixed with the old) ──
  console.log('whatsapp automation: only order_placed_link (owner 15 Oct evening)');
  const oldSent = (id, mobile, createdMs, extra = {}) => ({ id: 'p' + id.replace('#', ''), business_id: 'b1', order_id: id, kind: 'placed', status: 'sent', template: 'order_placed', to_number: '91' + mobile, attempts: 1, due_at: new Date(createdMs), sent_at: new Date(createdMs), wa_id: 'wamid.' + id, updated_at: new Date(createdMs), ...extra });
  const trackingDue = (id, mobile, dueMs) => ({ id: 't' + id.replace('#', ''), business_id: 'b1', order_id: id, kind: 'tracking', status: 'pending', to_number: '91' + mobile, attempts: 0, due_at: new Date(dueMs), sent_at: null, wa_id: null, updated_at: new Date(dueMs) });
  await t('a placed row WITHOUT a tracking link waits in the one-message mode: pending, not order_placed, not failed, nothing written; one log line per run with the count; it goes with the link template once the link is there; 24 h without one = the tooOld skip; the pure pick', async () => {
    pause.forgetPauseCache(); auto.resetModeLog(); turnOn();
    S.metaTemplates = [LINK, { id: 't9', name: 'shiptrack_alert', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: '{{1}}' }] }];   // the owner's Meta account now
    S.orders = [order({ order_id: '#1554', tracking_token: null, customer_mobile: '9811122233' }), order({ order_id: '#1555', tracking_token: null, customer_mobile: '9811122244' }), order()];
    let cap = captureLog(); let r;
    try { r = await run(IST(13, 12)); } finally { cap.restore(); }
    deq([r.sent, r.waitingLink, r.failed, r.skipped], [1, 2, 0, 0]);
    deq(sends().map(tplOf), ['order_placed_link']);
    for (const id of ['#1554', '#1555']) { const p = S.rows.find((x) => x.order_id === id && x.kind === 'placed'); deq([p.status, p.attempts, p.error, p.template, new Date(p.due_at).getTime()], ['pending', 0, null, undefined, IST(13, 12)]); }
    const line = rules.waitingLinkLine(2, 'order_placed_link');
    eq(line, "[wa-auto] 2 order messages wait for the order's tracking link (one message per order: order_placed_link needs it; order_placed is not sent)");
    eq(rules.waitingLinkLine(1), "[wa-auto] 1 order message waits for the order's tracking link (one message per order: order_placed_link needs it; order_placed is not sent)");
    eq(cap.lines.filter((l) => l === line).length, 1, 'once per run, with the count, not one line per order');
    assert.ok(!cap.lines.some((l) => /order_placed goes instead/.test(l)), 'the old per-order fallback line is gone');
    assert.ok(!cap.lines.some((l) => /#1554|#1555/.test(l)), 'no line per order');
    // the next run says it again (it still holds); the link arrives for #1554: it goes with the link template, its tracking row skipped
    S.orders[0].tracking_token = 'tok-1554'; S.fetches = []; cap = captureLog();
    try { r = await run(IST(13, 12, 1)); } finally { cap.restore(); }
    deq([r.sent, r.waitingLink], [1, 1]);
    eq(cap.lines.filter((l) => l === rules.waitingLinkLine(1, 'order_placed_link')).length, 1);
    deq(sends().map(tplOf), ['order_placed_link']);
    deq(valuesOf(sends()[0]), ['Aaditya', '#1554', 'Vastora', 'https://shiptrack.store/track/tok-1554', 'help@vastora.test']);
    const p4 = S.rows.find((x) => x.order_id === '#1554' && x.kind === 'placed'); deq([p4.status, p4.template], ['sent', 'order_placed_link']);
    deq(S.rows.find((x) => x.order_id === '#1554' && x.kind === 'tracking').error, rules.SKIP.inFirst);
    // a quiet run with nothing waiting: no line
    S.orders[1].tracking_token = 'tok-1555'; S.fetches = []; cap = captureLog();
    try { r = await run(IST(13, 12, 2)); } finally { cap.restore(); }
    deq([r.sent, r.waitingLink], [1, 0]); eq(cap.lines.filter((l) => /tracking link/.test(l)).length, 0);
    // 24 hours with no link: tooOld, never order_placed, never failed
    S.orders.push(order({ order_id: '#1556', tracking_token: null, customer_mobile: '9811122255', created_at: new Date(IST(13, 12, 3)) }));
    await run(IST(13, 12, 3)); eq(S.rows.find((x) => x.order_id === '#1556' && x.kind === 'placed').status, 'pending');
    S.fetches = []; await run(IST(14, 12, 4));
    deq([S.rows.find((x) => x.order_id === '#1556' && x.kind === 'placed').status, S.rows.find((x) => x.order_id === '#1556' && x.kind === 'placed').error], ['skipped', rules.SKIP.tooOld]);
    eq(sends().length, 0);
    // the pure pick: the ONE place that says which template a row goes with
    deq(rules.pickTemplate('placed', false, { active: true }, 'L', 'P', 'T'), { template: null, params: null, waits: 'link' });
    deq(rules.pickTemplate('placed', true, { active: true }, 'L', 'P', 'T'), { template: 'L', params: 'tracking', waits: null });
    deq(rules.pickTemplate('tracking', true, { active: true }, 'L', 'P', 'T'), { template: 'L', params: 'tracking', waits: null });
    deq(rules.pickTemplate('placed', false, { active: false }, 'L', 'P', 'T'), { template: 'P', params: 'placed', waits: null });
    deq(rules.pickTemplate('placed', true, { active: false }, 'L', 'P', 'T'), { template: 'P', params: 'placed', waits: null });
    deq(rules.pickTemplate('tracking', true, { active: false }, 'L', 'P', 'T'), { template: 'T', params: 'tracking', waits: null });
    deq(rules.pickTemplate('placed', true, { active: false }, 'L', null, 'T'), { template: null, params: null, waits: 'approval' });
    deq(rules.pickTemplate('tracking', true, { active: false }, null, 'P', null), { template: null, params: null, waits: 'approval' });
    deq(rules.pickTemplate('placed', true, { active: true }, null, 'P', 'T'), { template: 'P', params: 'placed', waits: null });   // active without a template cannot happen; the old one then
  });
  await t('the 48-hour tracking row of an order whose first message went with the old order_placed goes with the LINK template and its 5 values, in office hours only (waits at night), with order_tracking gone from Meta; skipped when delivered / cancelled / no link / too old / the link already went in the first message', async () => {
    pause.forgetPauseCache(); auto.resetModeLog(); turnOn(); S.metaTemplates = [LINK];
    const at = IST(11, 11), due = IST(13, 11);
    S.orders = [
      order({ created_at: new Date(at) }),
      order({ order_id: '#1554', created_at: new Date(at), customer_mobile: '9811122233', tracking_status: 'Delivered' }),
      order({ order_id: '#1555', created_at: new Date(at), customer_mobile: '9811122244', tracking_token: null }),
      order({ order_id: '#1556', created_at: new Date(IST(6, 11)), customer_mobile: '9811122255' }),
      order({ order_id: '#1557', created_at: new Date(at), customer_mobile: '9811122266' }),
      order({ order_id: '#1558', created_at: new Date(at), customer_mobile: '9811122277', is_cancelled: true }),
    ];
    for (const o of S.orders) { S.rows.push(oldSent(o.order_id, o.customer_mobile, at, o.order_id === '#1557' ? { template: 'order_placed_link' } : {}), trackingDue(o.order_id, o.customer_mobile, due)); }
    // the pure gate: the office open AND (order_tracking approved OR the one-message mode)
    deq([rules.trackingCanGo(true, false, true), rules.trackingCanGo(true, true, false), rules.trackingCanGo(true, false, false), rules.trackingCanGo(false, true, true)], [true, true, false, false]);
    // at night: nothing, and the tracking rows are not even asked for
    await run(IST(13, 21)); eq(sends().length, 0); eq(S.trackingFlags.slice(-1)[0], false);
    eq(S.rows.filter((x) => x.kind === 'tracking' && x.status === 'pending').length, 6);
    // in office hours: the one that can go goes with order_placed_link, the rest are skipped with their reasons
    const r = await run(IST(13, 12));
    eq(S.trackingFlags.slice(-1)[0], true);
    deq([r.sent, r.skipped, r.failed], [1, 5, 0]);
    deq(sends().map(tplOf), ['order_placed_link']); eq(sends()[0].body.to, '919876543210');
    deq(valuesOf(sends()[0]), ['Aaditya', '#1553', 'Vastora', 'https://shiptrack.store/track/tok-1553', 'help@vastora.test']);
    const tr = S.rows.find((x) => x.order_id === '#1553' && x.kind === 'tracking'); deq([tr.status, tr.template], ['sent', 'order_placed_link']);
    eq(S.rows.find((x) => x.order_id === '#1553' && x.kind === 'placed').status, 'sent', 'the old placed row is untouched');
    deq(['#1554', '#1555', '#1556', '#1557', '#1558'].map((id) => S.rows.find((x) => x.order_id === id && x.kind === 'tracking').error), [rules.SKIP.delivered, rules.SKIP.noLink, rules.SKIP.tooOld, rules.SKIP.inFirst, rules.SKIP.cancelled]);
    assert.ok(!sends().some((f) => tplOf(f) === 'order_tracking'));
  });
  await t('never the old two in the one-message mode ("mix mat kario"): with order_placed and order_tracking listed APPROVED beside order_placed_link, a placed row with a link, one without and a tracking row go only with order_placed_link (the no-link one waits); the Automation tab greys the old two and hides "Make the missing one"', async () => {
    pause.forgetPauseCache(); auto.resetModeLog(); turnOn(); S.metaTemplates.push(LINK);   // all three approved
    S.orders = [order(), order({ order_id: '#1554', tracking_token: null, customer_mobile: '9811122233' }), order({ order_id: '#1555', created_at: new Date(IST(11, 11)), customer_mobile: '9811122244' })];
    S.rows.push(oldSent('#1555', '9811122244', IST(11, 11)), trackingDue('#1555', '9811122244', IST(13, 11)));
    const r = await run(IST(13, 12));
    deq([r.sent, r.waitingLink, r.failed, r.skipped], [2, 1, 0, 0]);
    deq(sends().map(tplOf), ['order_placed_link', 'order_placed_link']);
    deq(sends().map((f) => f.body.to).sort(), ['919811122244', '919876543210']);
    eq(sends().some((f) => ['order_placed', 'order_tracking'].includes(tplOf(f))), false, 'never mixed');
    eq(S.rows.find((x) => x.order_id === '#1554' && x.kind === 'placed').status, 'pending');
    const ov = await auto.automationOverview(null, IST(13, 12));
    deq([ov.linkMode.active, ov.templates.placed, ov.templates.tracking, ov.templates.link], [true, 'APPROVED', 'APPROVED', 'APPROVED']);
    const panel = fs.readFileSync(path.join(SRC, 'components/whatsapp/AutomationPanel.tsx'), 'utf8');
    assert.match(panel, /o\.linkMode\?\.active \? <span className="chip chip-muted"[^>]*>not needed \(one message mode\)<\/span> : <span className=\{`chip \$\{tplTone\(o\.templates\.placed\)\}`\}>/);
    assert.match(panel, /o\.linkMode\?\.active \? <span className="chip chip-muted"[^>]*>not needed \(one message mode\)<\/span> : <span className=\{`chip \$\{tplTone\(o\.templates\.tracking\)\}`\}>/);
    assert.match(panel, /\{!o\.linkMode\?\.active && \(o\.templates\.placed === 'MISSING' \|\| o\.templates\.tracking === 'MISSING'\) && \(/);
    assert.ok(!/model/i.test(panel), 'no model names');
  });
  await t('the switch OFF while order_placed / order_tracking are gone from Meta: nothing is sent and the rows wait (two-message mode, as today); the Turn OFF confirm warns about it; a panel can still be switched ON while the one-message mode runs', async () => {
    pause.forgetPauseCache(); auto.resetModeLog(); turnOn(); S.metaTemplates = [LINK];
    S.settings.wa_link_mode = JSON.stringify({ on: false, by: 'owner', at: 'x' }); auto.forgetLinkModeCache();
    S.orders = [order()];
    const r = await run(IST(13, 12));
    deq([r.sent, r.waitingLink, r.failed, r.skipped], [0, 0, 0, 0]); eq(sends().length, 0);
    deq(S.rows.map((x) => [x.kind, x.status, x.error]), [['placed', 'pending', null], ['tracking', 'pending', null]]);
    let ov = await auto.automationOverview(null, IST(13, 12));
    deq([ov.templates.placed, ov.templates.tracking, ov.templates.link, ov.linkMode.active], ['MISSING', 'MISSING', 'APPROVED', false]);
    deq([rules.oldTemplatesGone('MISSING', 'APPROVED'), rules.oldTemplatesGone('APPROVED', 'MISSING'), rules.oldTemplatesGone('APPROVED', 'APPROVED'), rules.oldTemplatesGone('PENDING', 'PENDING')], [true, true, false, false]);
    eq(rules.OLD_TEMPLATES_GONE_TEXT, 'order_placed and order_tracking are not on Meta any more: with the switch OFF, no order message will go until they are made again (Meta blocks a deleted name for about 30 days).');
    const panel = fs.readFileSync(path.join(SRC, 'components/whatsapp/AutomationPanel.tsx'), 'utf8');
    assert.match(panel, /oldTemplatesGone\(o\.templates\.placed, o\.templates\.tracking\)/); assert.match(panel, /Turn OFF "One message per order"\?[^`]*\$\{gone \? `\\n\\n\$\{OLD_TEMPLATES_GONE_TEXT\}` : ''\}/);
    // the panel switch: ON is refused while nothing can send (switch OFF, old templates gone) and allowed once the one-message mode runs
    let p = await route.POST(jreq(OWNER, { businessId: 'b2', enabled: true }));
    deq([p.status, /not made yet/.test(p.body.error), /One message per order/.test(p.body.error)], [409, true, true]);
    delete S.settings.wa_link_mode; auto.forgetLinkModeCache();
    p = await route.POST(jreq(OWNER, { businessId: 'b2', enabled: true })); deq([p.status, p.body.enabled], [200, true]);
    // ON again: the waiting rows go with the link template, the tracking row skipped
    await run(IST(13, 12, 1)); deq(sends().map(tplOf), ['order_placed_link']);
    deq(S.rows.map((x) => [x.kind, x.status]), [['placed', 'sent'], ['tracking', 'skipped']]);
    ov = await auto.automationOverview(null, IST(13, 12, 1)); eq(ov.linkMode.active, true);
  });
  await t('the test send follows the same rule: in the one-message mode ONE message with the link template; when the brand\'s latest order has no tracking link it says so and sends nothing (never order_placed); with the switch OFF the two as before', async () => {
    pause.forgetPauseCache(); auto.resetModeLog(); S.metaTemplates = [LINK];
    S.orders = [order({ order_id: '#1560', tracking_token: null, created_at: new Date(IST(13, 11, 30)) }), order()];
    let ts = await auto.sendAutomationTest('b1', '9876500001', 'Test');
    deq([ts.order, ts.results.length, ts.results[0].kind, ts.results[0].ok], ['#1560', 1, 'placed', false]);
    assert.match(ts.results[0].error, /^The latest order #1560 has no tracking link: the one-message template needs it \(order_placed is not sent in this mode\)/);
    assert.match(ts.mode, /^one message/); eq(sends().length, 0, 'nothing sent');
    // the latest order has its link: one message, the link template, the 5 values
    S.orders[0].tracking_token = 'tok-1560'; S.fetches = [];
    ts = await auto.sendAutomationTest('b1', '9876500001', 'Test');
    deq(ts.results.map((x) => [x.kind, x.ok]), [['placed', true]]); eq(tplOf(sends()[0]), 'order_placed_link');
    deq(valuesOf(sends()[0]), ['Test', '#1560', 'Vastora', 'https://shiptrack.store/track/tok-1560', 'help@vastora.test']);
    assert.match(ts.results[0].text, /track\/tok-1560/);
    // no order at all: says so too
    S.orders = []; S.fetches = [];
    ts = await auto.sendAutomationTest('b1', '9876500001', 'Test');
    deq([ts.order, ts.results[0].ok], [null, false]); assert.match(ts.results[0].error, /no order yet/); eq(sends().length, 0);
    // the switch OFF: the two old templates when approved, "not approved" when gone
    S.settings.wa_link_mode = JSON.stringify({ on: false, by: 'owner', at: 'x' }); auto.forgetLinkModeCache();
    S.orders = [order()]; S.fetches = [];
    ts = await auto.sendAutomationTest('b1', '9876500001', 'Test');
    deq(ts.results.map((x) => [x.kind, x.ok, x.error]), [['placed', false, 'Template not approved by Meta yet'], ['tracking', false, 'Template not approved by Meta yet']]); eq(sends().length, 0);
    S.metaTemplates.push({ id: 't1', name: 'order_placed', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, {{2}} {{3}} {{4}}' }] }); auto.resetTemplateCache();
    ts = await auto.sendAutomationTest('b1', '9876500001', 'Test');
    deq(ts.results.map((x) => [x.kind, x.ok]), [['placed', true], ['tracking', false]]); eq(tplOf(sends()[0]), 'order_placed');
    delete S.settings.wa_link_mode; auto.forgetLinkModeCache();
  });

  console.log('whatsapp automation: another app on the number (owner 15 Oct)');
  const fr = require(path.join(SRC, 'lib/chat/whatsapp-foreign-rules.ts'));
  await t('the pure rules: one report -> the fresh row and the atomic add\'s pieces (India hour, 130429 apart, the number masked); a stored row parsed and summed per hour; junk = nothing seen', () => {
    const at = IST(15, 13, 5);
    const a = fr.foreignAdd('failed', '130429 · Rate limit hit · too many messages', '919876500002', at);
    deq([a.key, a.hour, a.status, a.rateLimited], ['wa_foreign:2026-10-15', '13', 'failed', true]);
    deq(JSON.parse(a.fresh), { hours: { 13: { failed: 1, failed130429: 1 } }, lastAt: new Date(at).toISOString(), lastStatus: 'failed', lastTo: '••••0002', lastFailAt: new Date(at).toISOString(), lastError: '130429 · Rate limit hit · too many messages' });
    deq(Object.keys(JSON.parse(a.top)).sort(), ['lastAt', 'lastError', 'lastFailAt', 'lastStatus', 'lastTo']);
    const b = fr.foreignAdd('sent', null, '919876500001', IST(15, 23, 59));
    deq([b.hour, b.rateLimited, JSON.parse(b.fresh).hours, JSON.parse(b.top).lastFailAt], ['23', false, { 23: { sent: 1 } }, undefined]);
    eq(fr.foreignAdd('failed', '131026 · not a WhatsApp user', null, at).rateLimited, false);
    eq(fr.foreignAdd('bogus', null, null, at), null);
    eq(fr.foreignAdd('sent', null, '12', at).fresh.includes('lastTo":null'), true);
    assert.ok(!/9876500002/.test(a.fresh + a.top), 'never the full number');
    // a stored day: hours summed, in order; a 130429 inside failed; the last fields
    const day = fr.parseForeignDay(JSON.stringify({ hours: { 14: { sent: 30, failed: 2, failed130429: 2 }, 13: { sent: 5, delivered: 4, read: 1 }, x: { sent: 9 } }, lastAt: '2026-10-15T09:05:00.000Z', lastStatus: 'failed', lastTo: '••••0002', lastFailAt: '2026-10-15T09:05:00.000Z', lastError: '130429 · Rate limit hit' }));
    const s = fr.foreignSummary(day);
    deq([s.sent, s.delivered, s.read, s.failed, s.failed130429, s.hours.map((h) => h.hour), fr.foreignSeen(s)], [35, 4, 1, 2, 2, [13, 14], 42]);
    deq(fr.foreignSummary(null), { sent: 0, delivered: 0, read: 0, failed: 0, failed130429: 0, lastAt: null, lastStatus: null, lastTo: null, lastFailAt: null, lastError: null, hours: [] });
    deq([fr.parseForeignDay('junk'), fr.parseForeignDay(''), fr.parseForeignDay('[1]')], [null, null, null]);
    eq(fr.foreignSummary(fr.parseForeignDay('{"hours":{"13":{"sent":"3","failed":-2}}}')).sent, 3);
    eq(fr.FOREIGN_RECHECK_MS, 20000);
  });
  await t('the line: another app sent N today (red, where to look in Meta Business Settings) / none seen while Meta refuses us (as far as ShipTrack can see, it lifts on Meta\'s side) / nothing to say', () => {
    const seen = fr.foreignSummary(fr.parseForeignDay(JSON.stringify({ hours: { 13: { sent: 41, failed: 2, failed130429: 1 } }, lastAt: new Date(IST(15, 13, 40)).toISOString(), lastStatus: 'sent', lastTo: '••••0007', lastFailAt: new Date(IST(15, 13, 30)).toISOString(), lastError: '130429 · Rate limit hit' })));
    const l = fr.foreignLine(seen, true);
    eq(l.tone, 'danger');
    assert.match(l.text, /^Another app sent 41 messages from this number today \(Meta's reports for messages ShipTrack never sent\)\. 2 of them failed \(1 with Meta's 130429 rate limit\)\. Last one 1:40 pm to ••••0007\. Two apps on one number share Meta's limit: find it in Meta Business Settings > Accounts > WhatsApp accounts > \(this account\) > Partners, and Business Settings > Integrations > Connected apps \/ System users, and remove what you don't use\.$/);
    eq(fr.foreignLine(seen, false).tone, 'danger');                                   // seen = red, refusing or not
    const one = fr.foreignLine(fr.foreignSummary(fr.parseForeignDay('{"hours":{"9":{"sent":1}}}')), false);
    assert.match(one.text, /^Another app sent 1 message from this number today/); assert.ok(!/failed/.test(one.text));
    // only failures seen: still another app tried to send
    assert.match(fr.foreignLine(fr.foreignSummary(fr.parseForeignDay('{"hours":{"9":{"failed":3,"failed130429":3}}}')), false).text, /^Another app sent 3 messages .* 3 of them failed \(3 with Meta's 130429 rate limit\)/);
    const none = fr.foreignLine(fr.foreignSummary(null), true);
    deq([none.tone, none.text], ['ok', 'No other app\'s messages seen from this number today, as far as ShipTrack can see (an app under another Meta app sends its reports elsewhere): Meta itself is holding the number back after this afternoon\'s burst; it lifts on Meta\'s side.']);
    eq(fr.foreignLine(fr.foreignSummary(null), false), null);
  });
  await t('the overview carries `foreign` (today\'s counts + the line): red with foreign reports; while Meta refuses us (a 130429 in 2 h, or Meta\'s pause) and none seen, the "no other app" line; a pause by hand alone or a quiet number = no line; the Today board gets the red line too', async () => {
    const now = IST(13, 12);
    let o = await auto.automationOverview(null, now);
    deq([o.foreign.sent, o.foreign.failed, o.foreign.line, o.foreign.hours], [0, 0, null, []]);
    // a 130429 of the last 2 hours, none foreign seen
    S.settings.wa_pause = JSON.stringify({ until: new Date(now - 60000).toISOString(), reason: '130429 · Rate limit hit', at: new Date(now - 30 * 60000).toISOString(), strikes: 1 });
    o = await auto.automationOverview(null, now);
    eq(o.foreign.line.tone, 'ok'); assert.match(o.foreign.line.text, /^No other app's messages seen/);
    // Meta's pause still running
    S.settings.wa_pause = JSON.stringify({ until: new Date(now + 10 * 60000).toISOString(), reason: '130429 · Rate limit hit', at: new Date(now - 5 * 60000).toISOString(), strikes: 1 });
    eq((await auto.automationOverview(null, now)).foreign.line.tone, 'ok');
    // a pause by hand with no refusal of Meta's: nothing to say
    S.settings.wa_pause = JSON.stringify({ until: new Date(now + 10 * 60000).toISOString(), reason: 'Paused by owner', at: new Date(now - rules.STRIKE_WINDOW_MS).toISOString(), strikes: 1, manual: true, by: 'owner' });
    eq((await auto.automationOverview(null, now)).foreign.line, null);
    // foreign reports today (the India day of `now`): red, with the hours; yesterday's row never counts
    S.settings['wa_foreign:2026-10-12'] = JSON.stringify({ hours: { 11: { sent: 300 } } });
    S.settings['wa_foreign:2026-10-13'] = JSON.stringify({ hours: { 11: { sent: 12, delivered: 10 }, 12: { sent: 3, failed: 1, failed130429: 1 } }, lastAt: new Date(now - 60000).toISOString(), lastStatus: 'failed', lastTo: '••••0002', lastFailAt: new Date(now - 60000).toISOString(), lastError: '130429 · Rate limit hit' });
    delete S.settings.wa_pause;
    o = await auto.automationOverview(null, now);
    deq([o.foreign.sent, o.foreign.delivered, o.foreign.failed, o.foreign.failed130429, o.foreign.hours.map((h) => [h.hour, h.sent]), o.foreign.line.tone], [15, 10, 1, 1, [[11, 12], [12, 3]], 'danger']);
    assert.match(o.foreign.line.text, /^Another app sent 15 messages from this number today/);
    // the route answers it
    const g = await route.GET(jreq(OWNER, {}, 'http://x/api/whatsapp/automation'));
    eq(g.status, 200); assert.ok('foreign' in g.body && Array.isArray(g.body.foreign.hours));
    // the Today board (whatsapp-health-rules.ts): one red line from WaHealth.foreignToday, filled by whatsapp-health.ts
    const base = { quality: 'GREEN', status: 'CONNECTED', tier: 'TIER_250', limit: 250, limitFrom: 'meta', used24h: 10, failedToday: 0, waitingToday: 0, stopped: 0, phoneError: null };
    deq(health.waHealthLines({ ...base, foreignToday: 0 }), []);
    const lines = health.waHealthLines({ ...base, foreignToday: 15 });
    deq([lines.length, lines[0].tone], [1, 'danger']); assert.match(lines[0].text, /^Another app sent 15 messages from this number today .* Open WhatsApp > Automation > Number status/);
    assert.match(fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-health.ts'), 'utf8'), /h\.foreignToday = foreignSeen\(await loadForeignToday\(now\)\)/);
    // the screen: the Number status box shows the line, red when another app was seen, with the hours; the panel passes it
    const card = fs.readFileSync(path.join(SRC, 'components/whatsapp/PauseStatusCard.tsx'), 'utf8');
    assert.match(card, /foreign\?\.line && \(/); assert.match(card, /foreign\.line\.text/); assert.match(card, /By India hour:/);
    assert.match(fs.readFileSync(path.join(SRC, 'components/whatsapp/AutomationPanel.tsx'), 'utf8'), /foreign=\{o\.foreign \?\? null\}/);
    for (const f of ['lib/chat/whatsapp-foreign-rules.ts', 'lib/chat/whatsapp-foreign.ts', 'components/whatsapp/PauseStatusCard.tsx']) assert.ok(!/model/i.test(fs.readFileSync(path.join(SRC, f), 'utf8')), 'no model names in ' + f);
    assert.ok(!/^import /m.test(fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-foreign-rules.ts'), 'utf8')), 'the rules file is pure');
  });

  // ── owner 15 Oct night: "1 msg bhi dubara drop ya fail ho toh pause ho jae, meta ki limit na kharab ho" (3 order messages were
  // LOST with 132001 while Meta propagated a deleted template; a test said "sent" and never arrived) ──
  console.log('whatsapp automation: the safety stop (owner 15 Oct night)');
  const ALERT_TPL = { id: 't9', name: 'shiptrack_alert', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Alert: {{1}}' }] };
  const stopState = () => (S.settings.wa_pause ? rules.parsePauseState(S.settings.wa_pause) : null);
  const alertSends = () => sends().filter((f) => tplOf(f) === 'shiptrack_alert');
  const orderSends = () => sends().filter((f) => tplOf(f) !== 'shiptrack_alert');
  await t('failureSide: the customer-side list (131026, 131030, 131021, 130472, 131049, an invalid recipient by its words) fails that one message; EVERYTHING else is Meta\'s side (130429, 131048, 131056, 132000-132016 incl. 132001, 131031, 131042, 131045, 368, the token 190 / 0 / 10 / 200-299, our timeout, an unknown code, no code); a report\'s words give the code', () => {
    for (const c of [131026, 131030, 131021, 130472, 131049]) eq(rules.failureSide(c, 'whatever'), 'customer', String(c));
    for (const c of [130429, 131048, 131056, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 131031, 131042, 131045, 368, 190, 0, 10, 200, 230, 299, 100, 4, 80007, 133010, 1, 2, 33, 999999]) eq(rules.failureSide(c, 'whatever'), 'meta', String(c));
    eq(rules.failureSide(null, 'WhatsApp did not answer in time'), 'meta'); eq(rules.failureSide(null, 'Could not reach WhatsApp'), 'meta'); eq(rules.failureSide(null, null), 'meta'); eq(rules.failureSide(undefined, ''), 'meta');
    // the words (our own 'Not a WhatsApp number', Meta's invalid recipient / phone parameter on the generic 100 / 131009)
    eq(rules.failureSide(null, 'Not a WhatsApp number'), 'customer');
    eq(rules.failureSide(100, 'WhatsApp refused the message ((#100) Invalid parameter: phone number is invalid)'), 'customer');
    eq(rules.failureSide(131009, 'Parameter value is not valid: recipient phone number not valid'), 'customer');
    eq(rules.failureSide(100, 'WhatsApp refused the message ((#100) Invalid parameter)'), 'meta');          // a template value, our side: stop and look
    eq(rules.failureSide(131026, 'This number cannot receive WhatsApp messages from us'), 'customer');
    // a delivery report: the code is the number its words start with
    eq(rules.failureSide(null, '131026 · Message undeliverable · Message Undeliverable.'), 'customer');
    eq(rules.failureSide(null, '130429 · Rate limit hit · too many messages'), 'meta');
    eq(rules.failureSide(null, '132001 · Template name does not exist in the translation'), 'meta');
    eq(rules.failureSide(null, '131049 · This message was not delivered to maintain healthy ecosystem engagement'), 'customer');
    deq([rules.codeIn(132001, null), rules.codeIn(null, '131026 · x'), rules.codeIn(null, 'no code here'), rules.codeIn(undefined, undefined)], [132001, 131026, null, null]);
    eq(rules.STOP_MS, 30 * 24 * 3600 * 1000); eq(rules.STOP_BY, 'Meta failure'); eq(rules.STOP_ALERT_KEY, 'wa_stop_alert');
    eq(rules.stopLogLine(132001, 'Template name does not exist', '#1553'), '[whatsapp] order messages STOPPED after a Meta failure (132001 Template name does not exist, order #1553): press Resume in WhatsApp > Automation');
    eq(rules.stopLogLine(null, '130429 · Rate limit hit', null), '[whatsapp] order messages STOPPED after a Meta failure (130429 · Rate limit hit, order —): press Resume in WhatsApp > Automation');
    const txt = rules.stopAlertText(132001, '#1553', IST(15, 20, 12));
    eq(txt, 'WhatsApp order messages STOPPED: Meta refused (132001) on order #1553 at 8:12 pm. Nothing is lost; open WhatsApp > Automation and press Resume when fixed.');
    assert.ok(txt.length <= 600 && !/\n/.test(txt)); assert.match(rules.stopAlertText(130429, null, IST(15, 9, 5), 'test'), /on the test message at 9:05 am/);
    assert.match(rules.stopBoardLine('132001 Template name does not exist', IST(15, 20, 12), '#1553'), /^WhatsApp order messages are STOPPED after a Meta failure since 8:12 pm \(132001 Template name does not exist, order #1553\): nothing is lost/);
    for (const f of ['lib/chat/whatsapp-auto-rules.ts', 'lib/chat/whatsapp-pause.ts', 'lib/chat/whatsapp-safety-stop.ts', 'lib/chat/whatsapp-alert-queue.ts', 'lib/chat/whatsapp-auto-status.ts', 'lib/chat/whatsapp-foreign.ts', 'components/whatsapp/PauseStatusCard.tsx']) assert.ok(!/\bmodel\b/i.test(fs.readFileSync(path.join(SRC, f), 'utf8')), 'no model names in ' + f);
  });
  await t('at send time: a Meta-side refusal (132001, the template gone while Meta propagates) STOPS everything, the row goes back in line (pending, due now, attempts +1, Meta\'s words kept), the other due rows are not touched, nothing goes until Resume; the log line once; one WhatsApp to the owner per stop', async () => {
    S.metaTemplates.push(ALERT_TPL); S.settings.whatsapp_alert_to = '919876500001'; S.settings.whatsapp_alert_extra = '919876500002, 919876500001';
    turnOn(); S.orders = [order(), order({ order_id: '#1554', customer_mobile: '9811122233' }), order({ order_id: '#1555', customer_mobile: '9811122244' })];
    S.sendFail = { code: 132001, message: 'Template name does not exist in the translation' };
    const cap = captureLog(); const errs = console.error; const errLines = []; console.error = (...a) => errLines.push(a.join(' '));
    let r; try { r = await run(IST(13, 12)); } finally { cap.restore(); console.error = errs; }
    deq([r.sent, r.failed, r.retried, r.paused, r.stopped], [0, 0, 1, true, true]);
    eq(orderSends().length, 1, 'the first refused, nothing more this run');
    const p1 = S.rows.find((x) => x.order_id === '#1553' && x.kind === 'placed');
    deq([p1.status, p1.attempts, p1.code, /Template name does not exist/.test(p1.error), new Date(p1.due_at).getTime()], ['pending', 1, 132001, true, IST(13, 12)]);
    for (const id of ['#1554', '#1555']) { const p = S.rows.find((x) => x.order_id === id && x.kind === 'placed'); deq([p.status, p.attempts], ['pending', 0]); }
    const st = stopState(); deq([st.stopped, st.by, st.code, st.order, st.kind, st.strikes], [true, 'Meta failure', 132001, '#1553', 'placed', 1]);
    eq(st.until - IST(13, 12), rules.STOP_MS);
    eq(errLines.filter((l) => l === rules.stopLogLine(132001, 'WhatsApp refused the message (Template name does not exist in the translation)', '#1553')).length, 1, 'the STOPPED line once');
    // the owner's WhatsApp: once, to every alert number, through the queue's sendAlert; the claim keeps the second process out
    const a = alertSends(); eq(a.length, 2); deq(a.map((f) => f.body.to).sort(), ['919876500001', '919876500002']);
    eq(valuesOf(a[0])[0], rules.stopAlertText(132001, '#1553', IST(13, 12)));
    eq(S.settings.wa_stop_alert, new Date(IST(13, 12)).toISOString()); eq(S.stopAlertClaims, 1);
    // stopped: Meta recovered meanwhile, yet nothing goes (5 min, an hour, a day later); new orders are still queued
    S.sendFail = null; S.fetches = []; S.orders.push(order({ order_id: '#1556', customer_mobile: '9811122255', created_at: new Date(IST(13, 12, 30)) }));
    for (const at of [IST(13, 12, 5), IST(13, 13), IST(14, 12)]) { pause.forgetPauseCache(); const rr = await run(at); eq(rr.paused, true); eq(sends().length, 0, 'nothing at ' + at); }
    eq(S.rows.filter((x) => x.order_id === '#1556').length, 2, 'queued while stopped');
    eq(alertSends().length, 0, 'no second alert while the same stop runs');
    // a second Meta-side failure while stopped (a late report of the burst) changes nothing and alerts nobody
    await status.noteAutoStatus('wamid.none', 'failed', '130429 · Rate limit hit');
    deq([stopState().code, S.stopAlertClaims, alertSends().length], [132001, 1, 0]);
    // Resume: the waiting rows go in line at the chosen speed; the stop fields are gone; a NEW failure later stops again with a NEW alert
    eq(await pause.resumeNow('owner', IST(13, 13)), true); pause.forgetPauseCache();          // the route's Resume = this call (proved in the Number status group)
    const st2 = stopState(); deq([st2.stopped, st2.resumedBy, st2.until <= IST(13, 13)], [undefined, 'owner', true]);
    const r2 = await run(IST(13, 13, 1));
    eq(r2.sent, 4); eq(orderSends().length, 4); eq(S.slotEvery, 60000, 'the slot is asked for 1 a minute for 2 hours after a refusal (the fake slot always grants)');
    deq(S.rows.filter((x) => x.kind === 'placed').map((x) => x.status), ['sent', 'sent', 'sent', 'sent']);
    S.fetches = []; S.sendFail = { code: 130429, message: 'Rate limit hit' }; S.orders.push(order({ order_id: '#1557', customer_mobile: '9811122266', created_at: new Date(IST(13, 13, 20)) }));
    await run(IST(13, 13, 30));
    deq([stopState().stopped, stopState().code, stopState().strikes, alertSends().length, S.stopAlertClaims], [true, 130429, 2, 2, 2]);   // the 2nd refusal within 2 hours
    assert.match(valuesOf(alertSends()[0])[0], /^WhatsApp order messages STOPPED: Meta refused \(130429\) on order #1557 at 1:30 pm/);
    S.sendFail = null; delete S.settings.whatsapp_alert_to; delete S.settings.whatsapp_alert_extra; delete S.settings.wa_stop_alert;
  });
  await t('customer-side at send time (131026 not on WhatsApp, 131049 per-user limit, our own "Not a WhatsApp number"): that ONE row fails with the words and code, the rest go on in the same run, nothing stops, no alert', async () => {
    S.metaTemplates.push(ALERT_TPL); S.settings.whatsapp_alert_to = '919876500001';
    turnOn(); S.orders = [order(), order({ order_id: '#1554', customer_mobile: '9811122233' }), order({ order_id: '#1555', customer_mobile: '9811122244' })];
    let n = 0;
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
      if (!/\/messages$/.test(url)) return realFetch(url, init);
      n++; S.fetches.push({ url, method: 'POST', body: JSON.parse(init.body) });
      if (n === 1) return { ok: false, status: 400, json: async () => ({ error: { code: 131026, message: 'Message undeliverable' } }) };
      if (n === 2) return { ok: false, status: 400, json: async () => ({ error: { code: 131049, message: 'This message was not delivered to maintain healthy ecosystem engagement.' } }) };
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.ok' + n }] }) };
    };
    let r; try { r = await run(IST(13, 12)); } finally { global.fetch = realFetch; }
    deq([r.sent, r.failed, r.paused, r.stopped], [1, 2, false, false]);
    deq(S.rows.filter((x) => x.kind === 'placed').map((x) => [x.status, x.code]), [['failed', 131026], ['failed', 131049], ['sent', null]]);
    eq(S.settings.wa_pause, undefined, 'nothing stopped'); eq(alertSends().length, 0);
    delete S.settings.whatsapp_alert_to;
  });
  await t('a later failed delivery report: Meta\'s side (132001 words) = the row back in line (pending, due now, the code from the words) + the STOP; the customer\'s side (131026) = the row Failed, nothing stops; a late report for a message sent before Resume is not a new stop (the row still waits)', async () => {
    turnOn(); S.orders = [order(), order({ order_id: '#1554', customer_mobile: '9811122233' })];
    await run(IST(13, 12)); await run(IST(13, 12, 1));
    const [a, b] = ['#1553', '#1554'].map((id) => S.rows.find((x) => x.order_id === id && x.kind === 'placed'));
    deq([a.status, b.status], ['sent', 'sent']);
    eq(await status.noteAutoStatus(b.wa_id, 'failed', '131026 · Message undeliverable · Message Undeliverable.'), true);
    deq([b.status, S.settings.wa_pause], ['failed', undefined]);
    eq(await status.noteAutoStatus(a.wa_id, 'failed', '132001 · Template name does not exist in the translation'), true);
    deq([a.status, a.code, new Date(a.due_at).getTime()], ['pending', 132001, IST(13, 12, 1)]);
    const st = stopState(); deq([st.stopped, st.code, st.order, st.kind], [true, 132001, '#1553', 'placed']);
    // Resume; then a report for a message sent BEFORE the resume (the old burst): the row waits, no new stop
    await pause.resumeNow('owner', IST(13, 12, 5)); pause.forgetPauseCache();
    S.rows.push({ id: 'old9', business_id: 'b1', order_id: '#1560', kind: 'placed', status: 'sent', wa_id: 'wamid.old9', attempts: 1, sent_at: new Date(IST(13, 11, 50)), due_at: new Date(IST(13, 11, 50)), updated_at: new Date(IST(13, 11, 50)) });
    const warn = console.warn, lines = []; console.warn = (m) => lines.push(String(m));
    try { await status.noteAutoStatus('wamid.old9', 'failed', '130429 · Rate limit hit'); } finally { console.warn = warn; }
    deq([S.rows.find((x) => x.id === 'old9').status, stopState().stopped, stopState().resumedBy], ['pending', undefined, 'owner']);
    assert.ok(lines.some((l) => /late failure report \(130429\)[^]*not a new stop/.test(l)), lines.join('\n'));
    // after RATE_MAX_ATTEMPTS Meta-side tries the row is Failed (as today), the stop still comes
    S.rows.push({ id: 'many9', business_id: 'b1', order_id: '#1561', kind: 'placed', status: 'sent', wa_id: 'wamid.many9', attempts: rules.RATE_MAX_ATTEMPTS, sent_at: new Date(IST(13, 12, 6)), due_at: new Date(), updated_at: new Date() });
    await status.noteAutoStatus('wamid.many9', 'failed', '130429 · Rate limit hit');
    deq([S.rows.find((x) => x.id === 'many9').status, stopState().stopped], ['failed', true]);
    eq(stopState().reason, '130429 · Rate limit hit', 'a report\'s words already carry the code: never doubled');
  });
  await t('while stopped: a ShipTrack alert and the test message still go at once; a failed ALERT on Meta\'s side (190 token) stops the order messages too (its first try only), a customer-side alert failure never; the stop alert\'s own refusal never loops; the pure view and manual pause / timed pause against a stop', async () => {
    const q = require(path.join(SRC, 'lib/chat/whatsapp-alert-queue.ts')); q.setAlertGap(0);
    S.metaTemplates.push(ALERT_TPL); S.settings.whatsapp_alert_to = '919876500001';
    turnOn(); S.orders = [order()];
    await pause.stopWhatsApp({ code: 132001, words: 'Template name does not exist', order: '#1500', kind: 'placed' }, IST(13, 12));
    pause.forgetPauseCache();
    let r = await q.sendAlert({ to: '919876500001', name: 'shiptrack_alert', language: 'en_US', text: 'CHARGEBACK mail on VASTRIKA', chargebackId: 'cb1' });
    assert.ok(r.id, 'the alert went through the stop'); eq(alertSends().length, 1);
    const ts = await auto.sendAutomationTest('b1', '9876500001', 'Test'); deq(ts.results.map((x) => x.ok), [true, true]);
    eq(orderSends().length, 2, 'the two test messages'); eq((await run(IST(13, 12, 1))).paused, true); eq(orderSends().length, 2, 'no order message');
    // the pure view
    const v = rules.pauseView(stopState(), IST(13, 12, 2));
    deq([v.state, v.stopped, v.stopCode, v.stopOrder, v.stopKind, v.stopAt, v.manual, v.reason, v.strikes], ['stopped', true, 132001, '#1500', 'placed', new Date(IST(13, 12)).toISOString(), false, '132001 Template name does not exist', 1]);
    deq([rules.pauseView(null, IST(13, 12)).stopped, rules.pauseView({ until: IST(13, 12) + 60000, at: IST(13, 12), strikes: 1, reason: '130429' }, IST(13, 12)).state], [false, 'paused']);
    eq(rules.pauseView(stopState(), IST(13, 12) + rules.STOP_MS + 1).state, 'normal');   // 30 days on, the row is just old
    const ov = (await route.GET(jreq(OWNER, {}))).body; deq([ov.pauseInfo.state, ov.pauseInfo.stopCode, ov.paused.stopped, ov.foreign.line && ov.foreign.line.tone], ['stopped', 132001, true, 'ok']);
    // Pause now while stopped: the stop holds (nothing rewritten); a timed 130429 pause (another app's report) never shortens it
    eq((await route.POST(jreq(OWNER, { action: 'pause', minutes: 15 }))).status, 200);
    deq([stopState().stopped, stopState().manual, stopState().until - IST(13, 12)], [true, undefined, rules.STOP_MS]);
    await pause.pauseWhatsApp('130429 foreign', IST(13, 12, 3), 15 * 60000); await pause.pauseWhatsApp('130429 foreign', IST(13, 12, 4));
    deq([stopState().stopped, stopState().until - IST(13, 12)], [true, rules.STOP_MS]);
    // the Today board's line
    const wh = require(path.join(SRC, 'lib/chat/whatsapp-health.ts')); wh.resetWaPhoneCache();
    const realNow = Date.now; Date.now = () => IST(13, 12, 5);
    let h; try { h = await wh.loadWaHealth(IST(13, 12, 5)); } finally { Date.now = realNow; }
    deq([h.safetyStop.reason, h.safetyStop.order, h.safetyStop.at], ['132001 Template name does not exist', '#1500', new Date(IST(13, 12)).toISOString()]);
    const lines = health.waHealthLines(h); eq(lines[0].tone, 'danger'); assert.match(lines[0].text, /^WhatsApp order messages are STOPPED after a Meta failure since 12:00 pm \(132001 Template name does not exist, order #1500\)/);
    eq(health.waHealthLines({ ...h, safetyStop: null }).some((l) => /STOPPED/.test(l.text)), false);
    // Resume, then an alert Meta refuses with 190 (the token): the order messages stop again, the alert is answered to its caller as before
    await pause.resumeNow('owner', IST(13, 12, 6)); pause.forgetPauseCache(); S.fetches = []; delete S.settings.wa_stop_alert;
    S.sendFail = { code: 190, message: 'Invalid OAuth access token' };
    r = await q.sendAlert({ to: '919876500001', name: 'shiptrack_alert', language: 'en_US', text: 'CHARGEBACK mail on kurtiya' });
    deq(['error' in r, r.code], [true, 190]);
    deq([stopState().stopped, stopState().kind, stopState().code], [true, 'alert', 190]);
    eq(alertSends().length, 2, 'the chargeback alert tried once, the stop alert tried once (refused too): no loop');
    // the stop alert's refusal (190, tries 1) found the stop already running: one stop, one claim
    eq(S.stopAlertClaims, 1);
    // a customer-side alert failure (the alert number is not on WhatsApp) stops nothing
    await pause.resumeNow('owner', IST(13, 12, 7)); pause.forgetPauseCache(); S.fetches = [];
    S.sendFail = { code: 131026, message: 'Message undeliverable' };
    r = await q.sendAlert({ to: '919876500001', name: 'shiptrack_alert', language: 'en_US', text: 'x' });
    deq(['error' in r, stopState().stopped], [true, undefined]);
    // a failed delivery report on a sent alert (Meta's side, tries 1): stops; on a retried one (tries 2): never
    S.sendFail = null; S.fetches = [];
    r = await q.sendAlert({ to: '919876500001', name: 'shiptrack_alert', language: 'en_US', text: 'y' }); assert.ok(r.id);
    let wamid = Object.keys(S.settings).filter((k) => k.startsWith('wa_alert_sent:')).pop().slice('wa_alert_sent:'.length);
    eq(await q.noteAlertStatus(wamid, 'failed', '131042 · Business eligibility payment issue'), true);
    deq([stopState().stopped, stopState().kind, stopState().code], [true, 'alert', null]);
    await pause.resumeNow('owner', Date.now() + 1000); pause.forgetPauseCache();
    S.settings['wa_alert_sent:wamid.retried'] = JSON.stringify({ to: '919876500001', name: 'shiptrack_alert', language: 'en_US', text: 'z', tries: 2, first: new Date().toISOString() });
    eq(await q.noteAlertStatus('wamid.retried', 'failed', '130429 · Rate limit hit'), true);
    eq(stopState().stopped, undefined, 'a retried alert\'s report never stops');
    for (const k of Object.keys(S.settings)) if (k.startsWith('wa_alert_q:') || k.startsWith('wa_alert_sent:')) delete S.settings[k];
    delete S.settings.whatsapp_alert_to; delete S.settings.wa_pause; delete S.settings.wa_stop_alert; pause.forgetPauseCache();
  });
  await t('the test report (owner 15 Oct night, "sent" but never arrived): the test send records the number (masked), the template, the panel and the order; the overview answers the last 5 newest first; the Automation tab shows them under the test boxes; the screens and the wiring', async () => {
    S.metaTemplates.push(LINK); auto.resetTemplateCache();
    S.orders = [order({ order_id: '#1560', created_at: new Date(IST(13, 11, 30)) })];
    const ff = require(path.join(SRC, 'lib/chat/whatsapp-foreign.ts'));
    const ts = await auto.sendAutomationTest('b1', '9876500001', 'Test'); deq(ts.results.map((x) => x.ok), [true]);
    const key = Object.keys(S.settings).find((k) => k.startsWith('wa_test_sent:')); assert.ok(key);
    const rec = JSON.parse(S.settings[key]);
    deq([rec.to, rec.template, rec.language, rec.panel, rec.panelName, rec.order, rec.status], ['••••0001', 'order_placed_link', 'en_US', 'b1', 'vastora', '#1560', 'sent']);
    assert.ok(!/9876500001/.test(S.settings[key]), 'never the full number');
    // six tests: the overview keeps the newest five, newest first
    for (let i = 0; i < 6; i++) await ff.noteTestSent('wamid.t' + i, '91987650001' + i, { template: 'order_placed_link', panel: 'b2', panelName: 'VASTRIKA' }, IST(13, 10, i));
    const ov = await auto.automationOverview(null, IST(13, 12));
    deq(ov.tests.map((x) => x.to), ['••••0001', '••••0015', '••••0014', '••••0013', '••••0012']); eq(ff.TEST_REPORTS, 5);
    deq([ov.tests[0].panel, ov.tests[1].panel, ov.tests[0].status], ['b1', 'b2', 'sent']);
    const g = await route.GET(jreq(OWNER, {})); eq(g.status, 200); eq(g.body.tests.length, 5);
    // the record follows Meta's report (whatsapp.js proves the webhook path); here the parse never throws
    deq(ff.parseTestRecord('junk'), null); deq(ff.parseTestRecord(JSON.stringify({ to: '••••0001', at: 'x', status: 'bogus' })).status, 'sent');
    // the screens: the Automation tab lists the brand's tests under its test boxes, the Number status box the stop, the Today board the line
    const panel = fs.readFileSync(path.join(SRC, 'components/whatsapp/AutomationPanel.tsx'), 'utf8');
    assert.match(panel, /\(o\.tests \|\| \[\]\)\.filter\(\(t\) => t\.panel === p\.id\)/); assert.match(panel, /Test \{when\(t\.at\)\} to \{t\.to\}/); assert.match(panel, /failed: \$\{t\.words/);
    assert.match(panel, /every order message stops until you press Resume/);
    const card = fs.readFileSync(path.join(SRC, 'components/whatsapp/PauseStatusCard.tsx'), 'utf8');
    assert.match(card, /info\.state === 'stopped'/); assert.match(card, /Stopped after a Meta failure · \$\{info\.reason/); assert.match(card, /STOP_RESUME_CONFIRM\(chosen, ordersDue\)/); assert.match(card, /nothing is lost, \$\{n\(ordersDue\)\} message/);
    assert.ok(!/the number stops for \{info\.nextPauseMin\} min/.test(card), 'the old "stops for N min" words are gone');
    assert.match(fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-health.ts'), 'utf8'), /h\.safetyStop = st\?\.stopped && st\.until > now/);
    assert.match(fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-auto.ts'), 'utf8'), /await safetyStop\(\{ code: res\.code, words: res\.error, order: r\.order_id, kind: r\.kind \}/);
    assert.ok(!/pauseWhatsApp|retryable\(|RETRY_MS|MAX_ATTEMPTS\b/.test(fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-auto.ts'), 'utf8').replace(/RATE_MAX_ATTEMPTS/g, '')), 'the worker no longer pauses for a while or retries by itself');
    assert.match(fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-auto-status.ts'), 'utf8'), /failureSide\(null, error\) === 'meta'/);
    assert.match(fs.readFileSync(path.join(SRC, 'lib/chat/whatsapp-alert-queue.ts'), 'utf8'), /tries === 1 && failureSide\(r\.code, r\.error\) === 'meta'/);
    eq(rules.STOP_RESUME_CONFIRM(2, 3), 'Start sending order messages again, 2 a minute? The 3 that waited go out in line. Make sure the cause (Meta\'s words in the Number status box) is fixed first: if Meta refuses even one again, everything stops again.');
  });

  console.log(`WHATSAPP AUTOMATION: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
