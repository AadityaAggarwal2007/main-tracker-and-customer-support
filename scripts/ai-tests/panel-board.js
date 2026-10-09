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
    if (/FROM sites s WHERE/.test(sql)) return { rows: [{ business_id: 'A', ai_enabled: true, has_prompt: true, support_gmail: 1, email_ids: ['se1'] }, { business_id: 'B', ai_enabled: false, has_prompt: false, support_gmail: 0, email_ids: null }], rowCount: 2 };
    if (/FROM messages m JOIN conversations c/.test(sql)) return { rows: [{ business_id: 'A', chats: '9', team: '4' }], rowCount: 1 };
    if (/FROM chikki_runs r JOIN sites s/.test(sql)) return { rows: [{ business_id: 'A', n: '6' }], rowCount: 1 };
    if (/FROM staff_presence p LEFT JOIN team_users u/.test(sql)) return { rows: [{ name: 'Rahul' }, { name: 'Super Admin' }], rowCount: 2 };
    if (/FROM conversations c JOIN sites s/.test(sql)) {
      if (S.fail === 'chats') throw new Error('boom');
      return { rows: [{ business_id: 'A', needs_you: '3', email_waiting: '1', waiting: '4', overdue: '2', refund_cases: '1', reship_to_ship: '0' }], rowCount: 1 };
    }
    if (/FROM orders WHERE business_id/.test(sql)) return { rows: [{ business_id: 'A', today: '12', late: '2' }, { business_id: 'B', today: '0', late: '0' }], rowCount: 2 };
    if (/FROM chargeback_mailboxes m WHERE/.test(sql)) return { rows: [{ business_id: 'A', whatsapp: '919876543210', status_id: 'cb1' }, { business_id: 'B', whatsapp: '', status_id: 'cb1' }], rowCount: 2 };
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
const mstat = require(path.join(SRC, 'lib/chat/mailbox-status.ts'));
const server = require(path.join(SRC, 'lib/panel-board-server.ts'));
const { NextRequest } = require('next/server');
const route = require(path.join(SRC, 'app/api/panel-board/route.ts'));
const req = (url) => new NextRequest(`http://localhost${url}`);

const base = { id: 'x', name: 'x', needsYou: 0, waiting: 0, overdue: 0, emailWaiting: 0, refundCases: 0, reshipToShip: 0, chargebacksOpen: 0, refundRequestsNew: 0, chatsToday: 0, teamRepliesToday: 0, chikkiToday: 0, ordersToday: 0, lateOrders: 0, aiOn: true, hasPrompt: true, supportGmail: true, chargebackGmail: true, whatsapp: true, supportGmailStatus: 'ok', supportGmailError: null, chargebackGmailStatus: 'ok', chargebackGmailError: null };
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
    const gm = rules.panelNeeds({ ...base, supportGmailStatus: 'error', supportGmailError: 'Google refused the App Password', chargebackGmailStatus: 'error', chargebackGmailError: null, overdue: 1 });
    assert.ok(/waiting over 2 hours/.test(gm[2].text), 'a Gmail that cannot be read comes before the waiting customers (nothing new arrives while it is down)'); gm.pop();
    assert.deepStrictEqual(gm.map((x) => [x.tone, x.go]), [['danger', 'settings'], ['danger', 'settings']]);
    assert.ok(/Support Gmail cannot be read: Google refused the App Password/.test(gm[0].text)); assert.ok(/Chargeback Gmail cannot be read: sign-in failed/.test(gm[1].text));
    assert.deepStrictEqual(rules.panelNeeds({ ...base, supportGmailStatus: 'unknown', chargebackGmailStatus: null }).map((x) => x.tone), ['ok'], 'unknown (just restarted) is not an error');
  });
  await t('rules: the totals across panels and the morning routine (ticked by itself at 0; the Super Admin steps only when those numbers exist)', () => {
    const t1 = rules.summarize([{ ...base, needsYou: 2, overdue: 1, chargebacksOpen: 1, refundRequestsNew: 2, chatsToday: 5, supportGmailStatus: 'error', hasPrompt: false }, { ...base, needsYou: 1, reshipToShip: 3, chikkiToday: 7, chargebackGmail: false }]);
    assert.strictEqual(t1.panels, 2); assert.strictEqual(t1.needsYou, 3); assert.strictEqual(t1.overdue, 1); assert.strictEqual(t1.chargebacks, 1); assert.strictEqual(t1.refundRequests, 2);
    assert.strictEqual(t1.reshipToShip, 3); assert.strictEqual(t1.chatsToday, 5); assert.strictEqual(t1.chikkiToday, 7); assert.strictEqual(t1.gmailErrors, 1); assert.strictEqual(t1.setupGaps, 2);
    const r1 = rules.morningRoutine(t1);
    assert.deepStrictEqual(r1.map((x) => [x.done, x.count]), [[false, 1], [false, 1], [false, 1], [false, 3], [false, 2], [false, 3], [true, 0], [true, 0], [false, 2]]);
    assert.strictEqual(r1[0].go, 'chargebacks'); assert.strictEqual(r1[1].go, 'settings');
    const t2 = rules.summarize([{ ...base, chargebacksOpen: null, refundRequestsNew: null }]);
    assert.strictEqual(t2.chargebacks, null); assert.strictEqual(t2.refundRequests, null);
    const r2 = rules.morningRoutine(t2);
    assert.ok(!r2.some((x) => x.go === 'chargebacks' || x.go === 'refunds'), 'a team member has no chargeback / refund-request step'); assert.ok(r2.every((x) => x.done));
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
    assert.strictEqual(a.chatsToday, 9); assert.strictEqual(a.teamRepliesToday, 4); assert.strictEqual(a.chikkiToday, 6); assert.strictEqual(b.chatsToday, 0);
    // the Gmail status comes from the pollers' memory: unknown before their first look, then ok / the error
    assert.strictEqual(a.supportGmailStatus, 'unknown'); assert.strictEqual(a.chargebackGmailStatus, 'unknown'); assert.strictEqual(b.supportGmailStatus, null, 'no support Gmail = no status');
    mstat.noteMailboxCheck('se1', { ok: true }); mstat.noteMailboxCheck('cb:cb1', { ok: false, error: 'Google refused the App Password' });
    const r2 = await server.loadPanelBoard(null, true);
    assert.strictEqual(r2[0].supportGmailStatus, 'ok'); assert.strictEqual(r2[0].chargebackGmailStatus, 'error'); assert.strictEqual(r2[0].chargebackGmailError, 'Google refused the App Password');
    assert.strictEqual(r2[1].chargebackGmailStatus, 'error', 'the shared Gmail\'s status is the first row\'s, for both panels');
    assert.ok(/estimated_delivery >= \(now\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date - 14/.test(S.queries.find((q) => /FROM orders/.test(q.sql)).sql), 'late = the estimated date passed in the last 14 days');
    const dayInfo = await server.loadBoardDay();
    assert.deepStrictEqual(dayInfo.online, ['Rahul', 'Super Admin']); assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(dayInfo.date)); assert.strictEqual(typeof dayInfo.officeOpen, 'boolean');
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
    assert.deepStrictEqual(d.day.online, ['Rahul', 'Super Admin']); assert.ok(d.day.date);
    authState.user = { role: 'agent', username: 'rahul', displayName: 'Rahul', businessIds: ['B'], permissions: ['chat.view'] };
    const m = await (await route.GET(req('/api/panel-board'))).json();
    assert.strictEqual(m.superAdmin, false); assert.deepStrictEqual(m.panels.map((p) => p.id), ['B']); assert.strictEqual(m.panels[0].chargebacksOpen, null);
  });
  console.log(`PANEL BOARD: ${n} groups passed`);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
