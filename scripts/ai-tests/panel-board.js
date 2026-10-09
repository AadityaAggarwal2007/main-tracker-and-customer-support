// The panel board (owner 2026-10-09): the pure rules (src/lib/panel-board.ts), the loader (panel-board-server.ts) on
// a fake database and the route's login check. Nothing here touches a real database.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

const S = { queries: [], panels: [{ id: 'A', name: 'vastora' }, { id: 'B', name: 'kurtiya' }], fail: null, missing: new Set() };
const gone = () => Object.assign(new Error('relation does not exist'), { code: '42P01' });
const db = {
  query: async (sql, p) => {
    S.queries.push({ sql, p });
    for (const t of S.missing) if (sql.includes(t)) throw gone();
    if (/FROM businesses WHERE/.test(sql)) { const rows = S.panels.filter((x) => !p[0] || p[0].includes(x.id)); return { rows, rowCount: rows.length }; }
    if (/FROM sites s WHERE/.test(sql)) return { rows: [{ business_id: 'A', ai_enabled: true, has_prompt: true, support_gmail: 1 }, { business_id: 'B', ai_enabled: false, has_prompt: false, support_gmail: 0 }], rowCount: 2 };
    if (/FROM conversations c JOIN sites s/.test(sql)) {
      if (S.fail === 'chats') throw new Error('boom');
      return { rows: [{ business_id: 'A', needs_you: '3', email_waiting: '1', waiting: '4', overdue: '2', refund_cases: '1', reship_to_ship: '0' }], rowCount: 1 };
    }
    if (/FROM orders WHERE business_id/.test(sql)) return { rows: [{ business_id: 'A', today: '12', late: '2' }, { business_id: 'B', today: '0', late: '0' }], rowCount: 2 };
    if (/FROM chargeback_mailboxes m WHERE/.test(sql)) return { rows: [{ business_id: 'A', whatsapp: '919876543210' }, { business_id: 'B', whatsapp: '' }], rowCount: 2 };
    if (/FROM chargeback_alerts WHERE status <> 'done'/.test(sql)) return { rows: [{ business_id: 'A', subject: 'PayU Chargeback Notification', snippet: '' }, { business_id: 'A', subject: 'Payment received of Rs 100', snippet: 'thanks' }], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  },
  queryOne: async () => null,
  getPool: () => ({}),
};
const authState = { user: { role: 'admin', username: 'owner', displayName: 'Super Admin', businessIds: null, permissions: [] } };
const STUBS = { 'lib/db.ts': db, 'lib/auth.ts': { getAuthFromRequest: () => authState.user } };
const origLoad = Module._load, origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) { if (request.startsWith('@/')) request = path.join(SRC, request.slice(2)); return origResolve.call(this, request, parent, ...rest); };
Module._load = function (request, parent, isMain) {
  let file = null; try { file = Module._resolveFilename(request, parent); } catch { /* a package */ }
  if (file) for (const k of Object.keys(STUBS)) if (file.endsWith(path.sep + k.replace(/\//g, path.sep))) return STUBS[k];
  return origLoad.call(this, request, parent, isMain);
};

const rules = require(path.join(SRC, 'lib/panel-board.ts'));
const server = require(path.join(SRC, 'lib/panel-board-server.ts'));
const { NextRequest } = require('next/server');
const route = require(path.join(SRC, 'app/api/panel-board/route.ts'));
const req = (url) => new NextRequest(`http://localhost${url}`);

const base = { id: 'x', name: 'x', needsYou: 0, waiting: 0, overdue: 0, emailWaiting: 0, refundCases: 0, reshipToShip: 0, chargebacksOpen: 0, refundRequestsNew: 0, ordersToday: 0, lateOrders: 0, aiOn: true, hasPrompt: true, supportGmail: true, chargebackGmail: true, whatsapp: true };
let n = 0;
const t = async (name, fn) => { S.queries = []; S.fail = null; S.missing = new Set(); authState.user = { role: 'admin', username: 'owner', displayName: 'Super Admin', businessIds: null, permissions: [] }; await fn(); n++; console.log('  ok  ' + name); };

(async () => {
  await t('rules: a panel with nothing waiting says "All clear"; every number and gap gives one line, the most urgent first', () => {
    const clear = rules.panelNeeds(base);
    assert.deepStrictEqual(clear.map((x) => x.tone), ['ok']); assert.ok(/All clear/.test(clear[0].text));
    const busy = rules.panelNeeds({ ...base, chargebacksOpen: 1, overdue: 2, needsYou: 3, emailWaiting: 1, waiting: 4, refundRequestsNew: 2, refundCases: 1, reshipToShip: 1, lateOrders: 5 });
    assert.deepStrictEqual(busy.map((x) => x.go), ['chargebacks', 'chats', 'chats', 'chats', 'refunds', 'chats', 'chats', 'orders']);
    assert.strictEqual(busy[0].tone, 'danger'); assert.ok(/1 chargeback open/.test(busy[0].text));
    assert.ok(/2 customers waiting over 2 hours/.test(busy[1].text));
    assert.ok(/3 chats need you \(1 held email\)/.test(busy[2].text));
    assert.ok(/2 customers waiting under 2 hours/.test(busy[3].text), 'waiting minus overdue');
    assert.ok(/5 orders past the estimated date/.test(busy[7].text));
    const gaps = rules.panelNeeds({ ...base, aiOn: false, hasPrompt: false, supportGmail: false, chargebackGmail: false });
    assert.deepStrictEqual(gaps.map((x) => x.text), ['Chikki is OFF: every chat waits for a person', 'Chikki has no prompt yet: use Settings > Copy setup', 'No customer-support Gmail connected', 'No chargeback Gmail connected']);
    assert.ok(gaps.every((x) => x.go === 'settings' && x.tone === 'warn'));
    assert.ok(/WhatsApp number not set/.test(rules.panelNeeds({ ...base, whatsapp: false }).map((x) => x.text).join()), 'the WhatsApp gap shows only once the chargeback Gmail is there');
    assert.ok(!/WhatsApp/.test(rules.panelNeeds({ ...base, chargebackGmail: false, whatsapp: false }).map((x) => x.text).join()));
    assert.deepStrictEqual(rules.panelNeeds({ ...base, chargebacksOpen: null, refundRequestsNew: null }).map((x) => x.tone), ['ok'], 'a team member sees no Super Admin numbers');
    assert.ok(/no chat yet|All clear/.test(rules.panelNeeds({ ...base, aiOn: null }).map((x) => x.text).join()), 'a panel with no chat site is not called OFF');
  });
  await t('rules: the panel with the most urgent work comes first; equal panels keep their order', () => {
    const a = { ...base, id: 'a' }, b = { ...base, id: 'b', waiting: 1 }, c = { ...base, id: 'c', chargebacksOpen: 1 }, d = { ...base, id: 'd' };
    assert.deepStrictEqual(rules.sortPanels([a, b, c, d]).map((x) => x.id), ['c', 'b', 'a', 'd']);
  });
  await t('loader: every panel in scope, the chat / order / setup numbers joined by panel; chargebacks counted by their words; a failed read zeroes only its own numbers', async () => {
    const r = await server.loadPanelBoard(null, true);
    assert.deepStrictEqual(r.map((x) => x.name), ['vastora', 'kurtiya']);
    const [a, b] = r;
    assert.strictEqual(a.needsYou, 3); assert.strictEqual(a.waiting, 4); assert.strictEqual(a.overdue, 2); assert.strictEqual(a.emailWaiting, 1); assert.strictEqual(a.refundCases, 1);
    assert.strictEqual(a.chargebacksOpen, 1, 'the Rs 100 payment mail is not a chargeback'); assert.strictEqual(a.refundRequestsNew, null, 'the refund area answers that over its own route');
    assert.strictEqual(a.ordersToday, 12); assert.strictEqual(a.lateOrders, 2); assert.strictEqual(a.aiOn, true); assert.strictEqual(a.supportGmail, true); assert.strictEqual(a.chargebackGmail, true); assert.strictEqual(a.whatsapp, true);
    assert.strictEqual(b.needsYou, 0); assert.strictEqual(b.aiOn, false); assert.strictEqual(b.hasPrompt, false); assert.strictEqual(b.supportGmail, false); assert.strictEqual(b.whatsapp, false);
    // a team member limited to one panel: only that panel, no Super Admin numbers
    S.queries = []; const m = await server.loadPanelBoard(['B'], false);
    assert.deepStrictEqual(m.map((x) => x.id), ['B']); assert.strictEqual(m[0].chargebacksOpen, null); assert.strictEqual(m[0].refundRequestsNew, null);
    assert.ok(!S.queries.some((q) => /chargeback_alerts/.test(q.sql)), 'a member never reads that table');
    assert.ok(!S.queries.some((q) => /FROM refund|refund_requests|refund_links/.test(q.sql)), 'the board never reads a refund table (refund-isolation I2)');
    S.fail = 'chats'; const f = await server.loadPanelBoard(null, true);
    assert.strictEqual(f[0].needsYou, 0); assert.strictEqual(f[0].ordersToday, 12, 'the other numbers still come');
    S.fail = null; S.missing = new Set(['chargeback_alerts']); const g = await server.loadPanelBoard(null, true);
    assert.strictEqual(g[0].chargebacksOpen, 0, 'no table = 0, never an error');
  });
  await t('route: login needed; the answer carries every panel\'s numbers and whether this is the Super Admin (the screen adds the refund numbers and the lines)', async () => {
    authState.user = null; assert.strictEqual((await route.GET(req('/api/panel-board'))).status, 401);
    authState.user = { role: 'admin', username: 'owner', displayName: 'Super Admin', businessIds: null, permissions: [] };
    const res = await route.GET(req('/api/panel-board')); assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.deepStrictEqual(d.panels.map((p) => p.name), ['vastora', 'kurtiya']); assert.strictEqual(d.superAdmin, true);
    assert.strictEqual(d.panels[0].chargebacksOpen, 1); assert.strictEqual(d.panels[0].refundRequestsNew, null);
    authState.user = { role: 'agent', username: 'rahul', displayName: 'Rahul', businessIds: ['B'], permissions: ['chat.view'] };
    const m = await (await route.GET(req('/api/panel-board'))).json();
    assert.strictEqual(m.superAdmin, false); assert.deepStrictEqual(m.panels.map((p) => p.id), ['B']); assert.strictEqual(m.panels[0].chargebacksOpen, null);
  });
  console.log(`PANEL BOARD: ${n} groups passed`);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
