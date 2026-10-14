// Brand managers (owner 2026-10-14: "anurag is handling kurtiya, rahul is handling vastrika"; answers: their brand's chats
// to them first, open on their own brand, staff never see brands mixed). The pure rules, the REAL route on a fake
// chat_settings table and team, and the wiring of auto-assign and the two screens. Made-up panel ids: every panel the same.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, jsx: 'react-jsx' }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const S = { rows: new Map(), user: null, team: [] };
const fakes = {
  '@/lib/db': {
    query: async (sql, p) => {
      if (/SELECT key, value FROM chat_settings WHERE key LIKE/.test(sql)) return { rows: [...S.rows].filter(([k]) => k.startsWith('brand_manager:')).map(([key, value]) => ({ key, value })) };
      if (/INSERT INTO chat_settings/.test(sql)) { S.rows.set(p[0], p[1]); return { rows: [] }; }
      throw new Error('fake: ' + sql.slice(0, 60));
    },
    queryOne: async (sql, p) => (/FROM businesses/.test(sql) ? (['panelA1', 'panelB2', 'panelNew9'].includes(p[0]) ? { id: p[0] } : null) : null),
  },
  '@/lib/auth': { getAuthFromRequest: () => S.user, teamEntries: () => S.team },
};
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const R = require(path.join(SRC, 'lib/chat/brand-managers-rules.ts'));
const route = require(path.join(SRC, 'app/api/team/brand-managers/route.ts'));
const { NextRequest } = require('next/server');
const req = (method, body) => new NextRequest('http://x/api/team/brand-managers', { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });

let pass = 0, fail = 0;
async function t(name, fn) {
  S.rows = new Map(); S.user = { role: 'admin', username: 'owner' };
  S.team = [
    { id: 'm-anu', username: 'anurag', name: 'Anurag', active: true, role: 'panel_admin', permissions: null, businessIds: null },
    { id: 'm-rah', username: 'rahul', name: 'Rahul', active: true, role: 'agent', permissions: null, businessIds: ['panelB2'] },
    { id: 'm-off', username: 'off', name: 'Off', active: false, role: 'agent', permissions: null, businessIds: null },
    { id: 'm-view', username: 'v', name: 'Viewer', active: true, role: 'viewer', permissions: null, businessIds: null },
  ];
  const err = console.error, log = console.log; console.error = () => {}; console.log = () => {};
  try { await fn(); console.error = err; console.log = log; pass++; log('  ok  ' + name); }
  catch (e) { console.error = err; console.log = log; fail++; log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')); }
}

(async () => {
  console.log('brand-managers: one member per brand, their chats first, one brand at a time');

  await t('pure: the stored rows; a cleared one is left out; panelsOf', () => {
    const m = R.parseBrandManagers([
      { key: 'brand_manager:panelA1', value: '{"member":"m-anu"}' }, { key: 'brand_manager:panelB2', value: '{"member":null}' },
      { key: 'brand_manager:x', value: 'not json' }, { key: 'other', value: '{"member":"z"}' }]);
    deq(m, { panelA1: 'm-anu' });
    deq(R.panelsOf('m-anu', { panelA1: 'm-anu', panelB2: 'm-rah', panelNew9: 'm-anu' }), ['panelA1', 'panelNew9']);
    deq(R.panelsOf(null, { panelA1: 'm-anu' }), []);
  });

  await t('pure: auto-assign gives a brand\'s chat to its manager when on duty, else the usual pick among everyone', () => {
    const duty = [{ key: 'm-anu' }, { key: 'm-rah' }];
    deq(R.brandFirst(duty, 'panelA1', { panelA1: 'm-anu' }), [{ key: 'm-anu' }]);
    deq(R.brandFirst([{ key: 'm-rah' }], 'panelA1', { panelA1: 'm-anu' }), [{ key: 'm-rah' }], 'manager away = the others');
    deq(R.brandFirst(duty, 'panelNew9', {}), duty, 'a panel with no manager = as before');
    deq(R.brandFirst(duty, null, { panelA1: 'm-anu' }), duty);
  });

  await t('pure: a member sees ONE brand: the first page of a session opens on their brand, then their own pick stays; the Super Admin / Manager keep All panels', () => {
    eq(R.brandPanelFor('', ['panelA1', 'panelB2'], ['panelB2'], true, true), 'panelB2', 'first visit = their brand');
    eq(R.brandPanelFor('panelA1', ['panelA1', 'panelB2'], ['panelB2'], true, true), 'panelB2', 'first visit wins over a saved pick');
    eq(R.brandPanelFor('panelA1', ['panelA1', 'panelB2'], ['panelB2'], true, false), 'panelA1', 'later: they switched to another brand on purpose');
    eq(R.brandPanelFor('', ['panelA1', 'panelB2'], ['panelB2'], true, false), 'panelB2', 'All panels is never kept for a member');
    eq(R.brandPanelFor('', ['panelA1', 'panelB2'], [], true, false), 'panelA1', 'no brand of their own = the first panel, still one');
    eq(R.brandPanelFor('panelGone', ['panelA1'], [], true, false), 'panelA1', 'a panel they may no longer see');
    eq(R.brandPanelFor('', ['panelA1', 'panelB2'], ['panelB2'], false, true), '', 'Super Admin / Manager: untouched (All panels allowed)');
  });

  await t('route: the Super Admin sets one member per panel (any panel, a new one too); the member must be active, reply to chats and see that panel', async () => {
    let r = await route.POST(req('POST', { panelId: 'panelA1', memberId: 'm-anu' })); eq(r.status, 200);
    r = await route.POST(req('POST', { panelId: 'panelNew9', memberId: 'm-anu' })); eq(r.status, 200, 'a panel added later works the same');
    r = await route.POST(req('POST', { panelId: 'panelA1', memberId: 'm-rah' })); eq(r.status, 400, 'Rahul may not see panelA1');
    r = await route.POST(req('POST', { panelId: 'panelB2', memberId: 'm-off' })); eq(r.status, 400, 'switched off');
    r = await route.POST(req('POST', { panelId: 'panelB2', memberId: 'm-view' })); eq(r.status, 400, 'a viewer cannot reply');
    r = await route.POST(req('POST', { panelId: 'panelZZ9', memberId: 'm-anu' })); eq(r.status, 404);
    r = await route.POST(req('POST', { panelId: 'panelB2', memberId: 'm-rah' })); eq(r.status, 200);
    r = await route.POST(req('POST', { panelId: 'panelNew9', memberId: null })); eq(r.status, 200, 'cleared (an UPDATE, never a DELETE)');
    eq(JSON.parse(S.rows.get('brand_manager:panelNew9')).member, null);
    S.user = { role: 'agent', username: 'rahul', id: 'm-rah', businessIds: ['panelB2'] };
    r = await route.POST(req('POST', { panelId: 'panelB2', memberId: 'm-rah' })); eq(r.status, 403, 'a member cannot set it');
    const g = await (await route.GET(req('GET'))).json();
    deq(Object.keys(g.managers), ['panelB2'], 'a member sees only their own panels');
    deq(g.mine, ['panelB2']); eq(g.managers.panelB2.name, 'Rahul');
  });

  await t('wiring: auto-assign asks brandFirst; both screens use the hook and hide All panels for a member; Team shows the card', () => {
    ok(/pickAssignee\(brandFirst\(cands, c\.panel, managers\)\)/.test(read('lib/chat/auto-assign.ts')));
    ok(/useBrandPanel\(\{ token, separate: !!user && !isTeamLead\(user\)/.test(read('app/admin/page.tsx')));
    ok(/useBrandPanel\(\{ token, separate: !!user && !isTeamLead\(user\)/.test(read('app/admin/chat/page.tsx')));
    ok(/allowAll=\{isTeamLead\(user\)\}/.test(read('app/admin/_components/AdminSidebar.tsx')));
    ok(/allowAll=\{!simple\}/.test(read('app/admin/chat/_components/InboxSidebar.tsx')));
    ok(/<BrandManagersCard /.test(read('components/TeamCard.tsx')));
    for (const f of ['lib/chat/brand-managers-rules.ts', 'lib/chat/brand-managers.ts', 'components/BrandManagersCard.tsx', 'components/brandHome.ts']) ok(!/vastora|vastrika|kurtiya/i.test(read(f).replace(/\/\/.*$/gm, '')), 'no panel name in code: ' + f);
  });

  console.log(`brand-managers: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
