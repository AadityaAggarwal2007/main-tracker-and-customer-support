// Copy one panel's AI setup to another (owner 2026-10-08): the REAL panel-copy.ts rules and panel-copy-server.ts
// against a fake database, and the REAL route's login check. Nothing here touches a real database.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);

const S = { writes: [], panels: {}, sites: {}, faqs: {}, notes: {} };
function reset() {
  S.writes = [];
  S.panels = { A: { id: 'A', name: 'Vastora', default_courier: 'Valmo' }, B: { id: 'B', name: 'VASTRIKA', default_courier: null }, C: { id: 'C', name: 'kurtiya', default_courier: 'Delhivery' } };
  S.sites = {
    A: { id: 'sA', system_prompt: "You are Karry of Vastora. Vastora's store is in Surat.", cod_available: false, cod_states: 'Gujarat', chikki_effort: { frustrated: 'high' } },
    B: { id: 'sB', system_prompt: null, cod_available: null, cod_states: null, chikki_effort: null },
    C: { id: 'sC', system_prompt: 'kurtiya own prompt', cod_available: true, cod_states: null, chikki_effort: null },
  };
  S.faqs = {
    sA: [{ question: 'Do you have COD?', answer: 'Vastora COD only in Gujarat.', sort_order: 0, is_enabled: true }, { question: 'Return policy', answer: 'No returns at Vastora.', sort_order: 1, is_enabled: false }],
    sB: [], sC: [{ question: 'return POLICY', answer: 'kurtiya own', sort_order: 4, is_enabled: true }],
  };
  S.notes = {
    sA: [{ kind: 'fact', title: 'Vastora delivery', body: 'Vastora ships in 13 days', topics: ['delivery'], always: false, is_enabled: true, source: 'prompt', sort_order: -20, audience: 'all' }],
    sB: [], sC: [],
  };
}
reset();
const siteOf = (id) => Object.values(S.sites).find((s) => s.id === id);
const bizKey = (id) => Object.keys(S.sites).find((k) => S.sites[k].id === id);
const rows = (rs) => ({ rows: rs, rowCount: rs.length });
const run = async (sql, p) => {
  if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) S.writes.push({ sql, p });
  return rows([]);
};
const db = {
  query: async (sql, p) => {
    if (/FROM site_faqs WHERE site_id/.test(sql)) return rows(S.faqs[p[0]] || []);
    if (/FROM brain_notes WHERE site_id/.test(sql)) return rows(S.notes[p[0]] || []);
    return run(sql, p);
  },
  queryOne: async (sql, p) => {
    if (/FROM businesses WHERE id::text/.test(sql)) return S.panels[p[0]] || null;
    if (/FROM sites WHERE tracker_business_id/.test(sql)) return S.sites[p[0]] || null;
    return null;
  },
  withTransaction: async (fn) => fn({ query: run }),
};
const STUBS = {
  'lib/db.ts': db,
  'lib/chat/site.ts': { ensureSiteForPanel: async (id) => { S.sites[id] = { id: 's' + id, system_prompt: null, cod_available: null, cod_states: null, chikki_effort: null }; return { id: 's' + id }; } },
  'lib/auth.ts': { getAuthFromRequest: (req) => (req.headers.get('x-user') ? JSON.parse(req.headers.get('x-user')) : null) },
};
const origLoad = Module._load, origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) { if (request.startsWith('@/')) request = path.join(SRC, request.slice(2)); return origResolve.call(this, request, parent, ...rest); };
Module._load = function (request, parent, isMain) {
  let file = null; try { file = Module._resolveFilename(request, parent); } catch { /* a package */ }
  if (file && file.startsWith(SRC)) { const rel = path.relative(SRC, file); if (STUBS[rel]) return STUBS[rel]; }
  return origLoad.call(this, request, parent, isMain);
};
const pc = require(path.join(SRC, 'lib/panel-copy.ts'));
const server = require(path.join(SRC, 'lib/panel-copy-server.ts'));
const route = require(path.join(SRC, 'app/api/panel-copy/route.ts'));
const { NextRequest } = require('next/server');

let ok = 0, bad = 0;
async function t(name, fn) { reset(); try { await fn(); ok++; } catch (e) { bad++; console.log('  FAIL ' + name + ': ' + e.message); } }
const ALL = pc.ALL_PARTS;
const post = (body, user) => route.POST(new NextRequest('http://x/api/panel-copy', { method: 'POST', body: JSON.stringify(body), headers: user ? { 'x-user': JSON.stringify(user) } : {} }));

(async () => {
  await t('replaceBrand whole words, any capitals, counts', () => {
    const r = pc.replaceBrand("Vastora's VASTORA support. Vastorain stays. vastora", 'Vastora', 'VASTRIKA');
    assert.strictEqual(r.text, "VASTRIKA's VASTRIKA support. Vastorain stays. VASTRIKA"); assert.strictEqual(r.hits, 3);
    assert.strictEqual(pc.replaceBrand('x', '', 'y').hits, 0); assert.strictEqual(pc.replaceBrand('Vastora', 'vastora', 'Vastora').hits, 0);
    assert.strictEqual(pc.replaceBrand('a.b (x)', 'a.b', 'Z').text, 'Z (x)');
  });
  await t('cleanParts defaults to everything, takes only booleans', () => {
    assert.deepStrictEqual(pc.cleanParts(undefined), ALL);
    assert.strictEqual(pc.cleanParts({ prompt: false, notes: 'no' }).prompt, false);
    assert.strictEqual(pc.cleanParts({ prompt: false, notes: 'no' }).notes, true);
  });
  await t('plan to an EMPTY panel copies everything with the name changed', async () => {
    const a = await server.loadSetup('A'), b = await server.loadSetup('B');
    const p = pc.planCopy(a.setup, b.setup, ALL, false);
    assert.strictEqual(p.prompt.action, 'copy'); assert.ok(p.prompt.value.includes("VASTRIKA's store") && !/Vastora/i.test(p.prompt.value));
    assert.strictEqual(p.cod.action, 'copy'); assert.strictEqual(p.cod.codStates, 'Gujarat'); assert.strictEqual(p.cod.codAvailable, false);
    assert.strictEqual(p.courier.value, 'Valmo'); assert.strictEqual(p.effort.action, 'copy');
    assert.strictEqual(p.answers.add.length, 2); assert.strictEqual(p.answers.add[0].answer, 'VASTRIKA COD only in Gujarat.');
    assert.strictEqual(p.answers.add[1].is_enabled, false, 'a switched-off answer stays off');
    assert.strictEqual(p.notes.add[0].title, 'VASTRIKA delivery'); assert.strictEqual(p.notes.add[0].body, 'VASTRIKA ships in 13 days');
  });
  await t('a panel that already has things keeps them; answers/notes only added', async () => {
    const a = await server.loadSetup('A'), c = await server.loadSetup('C');
    const p = pc.planCopy(a.setup, c.setup, ALL, false);
    assert.strictEqual(p.prompt.action, 'keep'); assert.strictEqual(p.cod.action, 'keep'); assert.strictEqual(p.courier.action, 'keep');
    assert.strictEqual(p.effort.action, 'copy');
    assert.strictEqual(p.answers.add.length, 1, '"return POLICY" is the same question: skipped'); assert.strictEqual(p.answers.skip, 1);
    assert.ok(p.answers.add[0].sort_order > 4, 'added after the existing ones');
    const o = pc.planCopy(a.setup, c.setup, ALL, true);
    assert.strictEqual(o.prompt.action, 'overwrite'); assert.strictEqual(o.courier.action, 'overwrite');
  });
  await t('parts switched off do nothing; the lines read plainly', async () => {
    const a = await server.loadSetup('A'), b = await server.loadSetup('B');
    const p = pc.planCopy(a.setup, b.setup, { ...ALL, prompt: false, answers: false, notes: false, cod: false, courier: false, effort: false }, false);
    assert.ok(pc.planIsEmpty(p)); assert.deepStrictEqual(pc.describePlan(p).filter((l) => /will be/.test(l)), []);
    const full = pc.describePlan(pc.planCopy(a.setup, b.setup, ALL, false));
    assert.ok(full.some((l) => /Saved answers: 2 will be added/.test(l)) && full.some((l) => /only in Gujarat/.test(l)));
  });
  await t('dry run writes nothing', async () => {
    const r = await server.copyPanelSetup('A', 'B', ALL, false, true, 'owner');
    assert.ok(r.ok && !r.applied && r.added.answers === 2); assert.strictEqual(S.writes.length, 0);
  });
  await t('real copy: panel settings, answers, notes and the way-back row, nothing deleted', async () => {
    const r = await server.copyPanelSetup('A', 'B', ALL, false, false, 'owner');
    assert.ok(r.ok && r.applied);
    const sqls = S.writes.map((w) => w.sql);
    assert.ok(!sqls.some((s) => /DELETE/i.test(s)), 'no DELETE');
    const up = S.writes.find((w) => /UPDATE sites SET system_prompt/.test(w.sql)); assert.ok(up.p[0].includes('VASTRIKA') && up.p[1] === 'sB');
    assert.ok(S.writes.find((w) => /UPDATE businesses SET default_courier/.test(w.sql)).p[0] === 'Valmo');
    assert.strictEqual(sqls.filter((s) => /INSERT INTO site_faqs/.test(s)).length, 2);
    const note = S.writes.find((w) => /INSERT INTO brain_notes/.test(w.sql)); assert.ok(note.sql.includes('audience') && note.p[1] === 'sB');
    const back = S.writes.find((w) => /INSERT INTO chat_settings/.test(w.sql));
    assert.ok(/^panel_copy:/.test(back.p[0]) && back.p[0].endsWith(':B')); assert.strictEqual(JSON.parse(back.p[1]).addedFaqIds.length, 2);
    assert.ok(!sqls.some((s) => /orders|conversations|site_emails|logo|tracking_domain|whatsapp/i.test(s)), 'only the setup is touched');
  });
  await t('guards: same panel, unknown panel, a panel with no chat site gets one', async () => {
    assert.strictEqual((await server.copyPanelSetup('A', 'A', ALL, false, true, 'o')).status, 400);
    assert.strictEqual((await server.copyPanelSetup('A', 'Z', ALL, false, true, 'o')).status, 404);
    delete S.sites.B; S.panels.B = { id: 'B', name: 'VASTRIKA', default_courier: null };
    const r = await server.copyPanelSetup('A', 'B', ALL, false, false, 'o'); assert.ok(r.ok && r.applied);
    assert.ok(S.writes.some((w) => /INSERT INTO site_faqs/.test(w.sql) && w.p[1] === 'sB'));
  });
  await t('route: Super Admin only; dry run answers lines and samples', async () => {
    assert.strictEqual((await post({ source: 'A', target: 'B' }, null)).status, 401);
    assert.strictEqual((await post({ source: 'A', target: 'B' }, { role: 'panel_admin', username: 'rahul' })).status, 401);
    const res = await post({ source: 'A', target: 'B', dryRun: true }, { role: 'admin', username: 'owner' });
    assert.strictEqual(res.status, 200); const j = await res.json();
    assert.strictEqual(j.applied, false); assert.ok(j.lines.length >= 5 && j.samples.answers.includes('Do you have COD?')); assert.strictEqual(S.writes.length, 0);
    assert.strictEqual((await post({ source: 'A', target: 'A' }, { role: 'admin', username: 'owner' })).status, 400);
    const done = await (await post({ source: 'A', target: 'B' }, { role: 'admin', username: 'owner' })).json();
    assert.strictEqual(done.applied, true); assert.strictEqual(done.added.answers, 2);
  });
  console.log(`panel-copy: ${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
