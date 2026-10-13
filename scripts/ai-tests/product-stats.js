// Shopify tab (owner 2026-10-13, "collection wise order ... 4-5 product list karke unka count"): the pure rules in
// src/lib/product-stats.ts and the REAL route /api/product-stats + product-stats-server.ts on a fake database.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);
const { NextRequest } = require('next/server');
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;

const P1 = '11111111-1111-1111-1111-111111111111', P2 = '22222222-2222-2222-2222-222222222222';
const S = { user: null, settings: {}, lines: [], cancelled: 2, sql: [] };
const db = {
  query: async (q, p = []) => {
    S.sql.push(q.replace(/\s+/g, ' ').trim());
    if (/FROM orders o JOIN order_items oi ON oi\.order_id = o\.order_id AND oi\.business_id IS NOT DISTINCT FROM o\.business_id/.test(q.replace(/\s+/g, ' '))) {
      ok(/COALESCE\(o\.is_cancelled, false\) = false/.test(q), 'cancelled orders are left out');
      return { rows: S.lines.filter((l) => l.panel === p[0]).map(({ panel, ...l }) => l) };
    }
    if (/^INSERT INTO chat_settings/.test(q.trim())) { S.settings[p[0]] = p[1]; return { rows: [] }; }
    throw new Error('fake db: ' + q.slice(0, 80));
  },
  queryOne: async (q, p = []) => {
    if (/SELECT value FROM chat_settings WHERE key = \$1/.test(q)) return S.settings[p[0]] ? { value: S.settings[p[0]] } : null;
    if (/count\(\*\)::int AS n FROM orders o/.test(q.replace(/\s+/g, ' '))) return { n: S.cancelled };
    throw new Error('fake db one: ' + q.slice(0, 80));
  },
};
const fakes = { '@/lib/db': db, '@/lib/auth': { getAuthFromRequest: () => S.user } };
const oR = Module._resolveFilename;
Module._resolveFilename = function (r, parent, ...x) { if (fakes[r]) return r; if (r.startsWith('@/')) return oR.call(this, path.join(SRC, r.slice(2)), parent, ...x); return oR.call(this, r, parent, ...x); };
const oL = Module._load; Module._load = function (r, ...x) { return fakes[r] || oL.call(this, r, ...x); };
const R = require(path.join(SRC, 'lib/product-stats.ts'));
const route = require(path.join(SRC, 'app/api/product-stats/route.ts'));

const USERS = {
  owner: { role: 'admin', username: 'owner', businessIds: null, permissions: [] },
  sunny: { role: 'manager', id: 'u-s', username: 'sunny', businessIds: null, permissions: null },
  sunnyP2: { role: 'manager', id: 'u-s2', username: 'sunny2', businessIds: [P2], permissions: null },
  rahul: { role: 'agent', id: 'u-r', username: 'rahul', businessIds: null, permissions: ['chat.view', 'chat.reply', 'orders.view'] },
};
const get = async (who, qs) => { S.user = USERS[who] || null; const r = await route.GET(new NextRequest('http://x/api/product-stats' + qs)); return { status: r.status, body: await r.json() }; };
const post = async (who, body) => { S.user = USERS[who] || null; const r = await route.POST(new NextRequest('http://x/api/product-stats', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })); return { status: r.status, body: await r.json() }; };

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 3).join('\n       ')); } }

(async () => {
  await t('splitName: Shopify\'s "Title - Variant" -> the product and its colour / size; a long tail stays in the name', () => {
    deq(R.splitName('Jhumka box - Silver / pack-of-3'), { base: 'Jhumka box', variant: 'Silver / pack-of-3' });
    deq(R.splitName('Classic Bag'), { base: 'Classic Bag', variant: '' });
    deq(R.splitName('Kurti - Red'), { base: 'Kurti', variant: 'Red' });
    deq(R.splitName('Earrings - the most loved festive collection of the season'), { base: 'Earrings - the most loved festive collection of the season', variant: '' });
  });
  const L = (order, name, quantity, price, cod) => ({ order, product_name: name, quantity, price, cod });
  const rows = [
    L('o1', 'Jhumka box - Silver', 1, 100, true), L('o1', 'Jhumka box - Gold', 2, 100, true),   // one order, two colours
    L('o2', 'Jhumka box - Silver', 1, 100, false), L('o2', 'Golden Lantern Jhumka Earrings', 1, 300, false),
    L('o3', 'Classic Bag', 1, 500, true),
  ];
  await t('an order counts ONCE (two colours of one product, two products of one collection); pieces and money add up; COD / prepaid apart', () => {
    const p = R.productLines(rows);
    const box = p.find((x) => x.name === 'Jhumka box');
    deq([box.orders, box.pieces, box.revenue, box.codOrders, box.prepaidOrders, box.variants.length], [2, 4, 400, 1, 1, 2]);
    deq(box.variants.map((v) => [v.variant, v.orders, v.pieces]), [['Silver', 2, 2], ['Gold', 1, 2]]);
    const g = R.groupLines([{ id: 'g1', name: 'Jhumka', products: [], words: ['jhumka'] }, { id: 'g2', name: 'Bags', products: ['Classic Bag'], words: [] }], rows, p);
    deq([g[0].orders, g[0].pieces, g[0].revenue, g[0].products.length], [2, 5, 700, 2], 'the jhumka collection: orders o1 + o2 once each');
    deq([g[1].orders, g[1].revenue, g[1].codRevenue], [1, 500, 500]);
    const tot = R.totalsOf(rows);
    deq([tot.orders, tot.pieces, tot.revenue, tot.codOrders, tot.prepaidOrders], [3, 6, 1200, 2, 1]);
    deq(R.watchLines(['classic bag', 'Not sold'], p).map((x) => [x.name, x.orders]), [['Classic Bag', 1], ['Not sold', 0]], 'watch list in the chosen order; an unsold one is zero');
  });
  await t('cleaning: a collection needs a name and a product or a word; at most 12; no two with the same name; the watch list at most 12; no "<"', () => {
    ok('error' in R.cleanGroups([{ name: 'x' }]));
    ok('error' in R.cleanGroups([{ name: 'Jhumka' }]), 'nothing picked');
    ok('error' in R.cleanGroups([{ name: 'Jhumka', words: ['j'] }]), 'a one-letter word is not enough');
    ok('error' in R.cleanGroups([{ name: 'A1', words: ['aa'] }, { name: 'a1', words: ['bb'] }]), 'same name');
    ok('error' in R.cleanGroups(Array.from({ length: 13 }, (_, i) => ({ name: 'G' + i, words: ['ab'] }))));
    const g = R.cleanGroups([{ name: ' <b>Jhumka</b> ', words: ['jhumka', 'Jhumka', 'earring'], products: ['A', 'a'] }]);
    deq([g.groups[0].name, g.groups[0].words, g.groups[0].products], ['bJhumka/b', ['jhumka', 'earring'], ['A']]);
    ok('error' in R.cleanWatch(Array.from({ length: 13 }, (_, i) => 'P' + i)));
    deq(R.parseSetup('not json'), { groups: [], watch: [] });
  });
  await t('ranges in India days: today, yesterday, 7 / 30 days, custom dates (both counted, never the future, at most 92 days)', () => {
    const now = Date.parse('2026-10-13T06:30:00Z');   // 12:00 IST
    const day = (ms) => R.istDate(ms);
    const r1 = R.rangeOf('today', now); eq(day(r1.from), '2026-10-13'); eq(r1.to - r1.from, 86400000);
    const r2 = R.rangeOf('7d', now); eq(day(r2.from), '2026-10-07');
    const r3 = R.rangeOf('custom', now, '2026-10-10', '2026-10-01'); deq([day(r3.from), day(r3.to - 1), r3.range], ['2026-10-01', '2026-10-10', 'custom']);
    const r4 = R.rangeOf('custom', now, '2026-10-01', '2026-12-31'); eq(day(r4.to - 1), '2026-10-13', 'never past today');
    const r5 = R.rangeOf('custom', now, '2026-01-01', '2026-10-13'); eq((r5.to - r5.from) / 86400000, 92);
    eq(R.rangeOf('nonsense', now).range, 'today');
  });
  await t('route: the Super Admin and the Manager only, inside their panels; a panel is needed; the lines are the panel\'s own; collections and the watch list are saved per panel', async () => {
    S.lines = [
      { panel: P1, order: 'o1', product_name: 'Jhumka box - Silver', quantity: 1, price: '100.00', cod: true },
      { panel: P2, order: 'o9', product_name: 'Kurti - Red', quantity: 1, price: '50.00', cod: false },
    ];
    eq((await get(null, `?businessId=${P1}`)).status, 401);
    eq((await get('rahul', `?businessId=${P1}`)).status, 403, 'a team member does not see it');
    eq((await get('owner', '')).status, 400, 'no panel');
    eq((await get('sunnyP2', `?businessId=${P1}`)).status, 404, 'a Manager limited to another panel');
    let r = await get('sunny', `?businessId=${P1}&range=7d`);
    eq(r.status, 200);
    deq(r.body.products.map((p) => p.name), ['Jhumka box']);
    deq([r.body.totals.orders, r.body.cancelled, r.body.range.range], [1, 2, '7d']);
    eq((await post('rahul', { businessId: P1, watch: ['Jhumka box'] })).status, 403);
    eq((await post('owner', { businessId: P1, groups: [{ name: 'J' }] })).status, 400);
    r = await post('owner', { businessId: P1, groups: [{ name: 'Jhumka', words: ['jhumka'] }], watch: ['Jhumka box'] });
    eq(r.status, 200);
    ok(S.settings[`product_setup:${P1}`] && !S.settings[`product_setup:${P2}`], 'saved for this panel only');
    r = await post('sunny', { businessId: P1, watch: [] });
    deq([r.body.setup.groups.length, r.body.setup.watch.length], [1, 0], 'saving the watch list keeps the collections');
    r = await get('owner', `?businessId=${P1}`);
    deq([r.body.groups[0].name, r.body.groups[0].orders], ['Jhumka', 1]);
    ok(S.sql.every((q) => !/DELETE|UPDATE orders|UPDATE order_items/i.test(q)), 'never changes an order');
  });
  await t('dates (owner 13 Oct, "kitna purana data ha"): first / last order of a collection, India dates and times, the range days', async () => {
    const at = (iso) => Date.parse(iso);
    const rows = [
      { order: 'a', product_name: 'Kurti - Red', quantity: 1, price: 10, cod: false, at: at('2026-10-07T04:30:00Z') },   // 7 Oct 10:00 IST
      { order: 'b', product_name: 'Kurti - Blue', quantity: 1, price: 10, cod: false, at: at('2026-10-13T03:10:00Z') },  // 13 Oct 8:40 IST
      { order: 'c', product_name: 'Jhumka', quantity: 1, price: 10, cod: false, at: at('2026-10-12T20:00:00Z') },        // 13 Oct 1:30 IST
    ];
    const p = R.productLines(rows);
    const g = R.groupLines([{ id: 'g1', name: 'Kurti', products: [], words: ['kurti'] }], rows, p)[0];
    deq([g.first, g.last], [rows[0].at, rows[1].at]);
    deq([R.dayText(g.first), R.timeText(g.last), R.timeText(rows[2].at)], ['7 Oct', '13 Oct, 8:40 AM', '13 Oct, 1:30 AM']);
    eq(R.timeText(at('2026-10-13T06:45:00Z')), '13 Oct, 12:15 PM');
    deq([R.totalsOf([]).first, R.totalsOf([]).last], [null, null]);
    deq([R.totalsOf([{ order: 'x', product_name: 'A', quantity: 1, price: 1, cod: false }]).first], [null], 'a row without a time');
    const now = Date.parse('2026-10-13T03:30:00Z');
    const r7 = R.rangeOf('7d', now), r1 = R.rangeOf('today', now);
    deq([R.rangeDays(r7.from, r7.to), R.rangeDays(r1.from, r1.to)], ['7 Oct – 13 Oct', '13 Oct']);
  });
  await t('Copy from panel (owner 13 Oct, "asa same kurtiya ma bhi karde"): the other panel\'s collections are ADDED, a name already here stays, nothing is deleted, only panels the login sees', async () => {
    const m = R.mergeGroups([{ id: 'mine1', name: 'Kurti', products: ['X'], words: [] }],
      [{ id: 'th1', name: 'kurti', products: [], words: ['kurti'] }, { id: 'th2', name: 'Jewellery', products: [], words: ['jhumka'] }], 1);
    deq(m.groups.map((g) => [g.name, g.words, g.products]), [['Kurti', [], ['X']], ['Jewellery', ['jhumka'], []]]);
    deq([m.added, m.skipped], [['Jewellery'], ['kurti']]);
    ok(m.groups[1].id !== 'th2', 'a new id');
    S.settings = {};
    S.settings[`product_setup:${P1}`] = JSON.stringify({ groups: [{ id: 'g-kurti', name: 'Kurti', products: [], words: ['kurti', 'palazzo'] }, { id: 'g-jew', name: 'Jewellery', products: [], words: ['jhumka'] }], watch: ['A'] });
    S.settings[`product_setup:${P2}`] = JSON.stringify({ groups: [{ id: 'g-old', name: 'Jewellery', products: ['Old'], words: [] }], watch: ['B'] });
    eq((await post('rahul', { businessId: P2, copyFrom: P1 })).status, 403);
    eq((await post('sunnyP2', { businessId: P2, copyFrom: P1 })).status, 404, 'a Manager limited to P2 cannot copy from P1');
    eq((await post('owner', { businessId: P2, copyFrom: P2 })).status, 400, 'not from itself');
    eq((await post('owner', { businessId: P2, copyFrom: 'x' })).status, 400);
    let r = await post('sunny', { businessId: P2, copyFrom: P1 });
    eq(r.status, 200);
    deq([r.body.copied.added, r.body.copied.skipped], [['Kurti'], ['Jewellery']]);
    const saved = JSON.parse(S.settings[`product_setup:${P2}`]);
    deq(saved.groups.map((g) => [g.name, g.words, g.products]), [['Jewellery', [], ['Old']], ['Kurti', ['kurti', 'palazzo'], []]], 'P2 keeps its own Jewellery');
    deq(saved.watch, ['B'], 'the watch list is not copied');
    deq(JSON.parse(S.settings[`product_setup:${P1}`]).groups.length, 2, 'the source is untouched');
    S.settings[`product_setup:${P1}`] = JSON.stringify({ groups: [], watch: [] });
    eq((await post('owner', { businessId: P2, copyFrom: P1 })).status, 400, 'nothing to copy');
  });
  console.log(`PRODUCT-STATS: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  if (fail) process.exit(1);
})();
