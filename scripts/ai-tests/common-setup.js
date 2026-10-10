// One Chikki setup for every panel ("All panels", owner 2026-10-10, step 7). The REAL common-setup-rules.ts,
// common-setup.ts, ai-prompt.ts (brand), and the saved-answers / panel-setup routes against a fake database.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;

// ── fake database ──
const S = {};
function reset() {
  Object.assign(S, {
    sites: [
      { id: 'S1', name: 'vastora', system_prompt: 'You are Karry for Vastora. Vastora sells kurtis.', chikki_effort: { calm: 'normal', uneasy: 'high', frustrated: 'high', critical: 'max' }, tracker_business_id: 'P1' },
      { id: 'S2', name: 'VASTRIKA', system_prompt: 'Own VASTRIKA prompt', chikki_effort: null, tracker_business_id: 'P2' },
      { id: 'S3', name: 'kurtiya', system_prompt: null, chikki_effort: null, tracker_business_id: 'P3' },
    ],
    businesses: [{ id: 'P1', name: 'vastora' }, { id: 'P2', name: 'VASTRIKA' }, { id: 'P3', name: 'kurtiya' }],
    faqs: [
      { id: 'f1', site_id: 'S1', question: 'Is Vastora real?', answer: 'Yes, Vastora is a real store.', sort_order: 0, is_enabled: true },
      { id: 'f2', site_id: 'S1', question: 'COD?', answer: 'Yes.', sort_order: 1, is_enabled: true },
      { id: 'f3', site_id: 'S1', question: 'Old one', answer: 'off', sort_order: 2, is_enabled: false },
      { id: 'f9', site_id: 'S2', question: 'Own Q', answer: 'Own A', sort_order: 0, is_enabled: true },
    ],
    settings: {}, fail: false, writes: [],
  });
}
reset();
const norm = (q) => q.replace(/\s+/g, ' ').trim();
async function run(raw, p = []) {
  const q = norm(raw);
  if (S.fail) throw Object.assign(new Error('down'), { code: 'XX000' });
  if (/^SELECT value FROM chat_settings WHERE key = \$1/.test(q)) { const v = S.settings[p[0]]; return { rows: v === undefined ? [] : [{ value: v }] }; }
  if (/^INSERT INTO chat_settings/.test(q)) { S.settings[p[0]] = p[1]; S.writes.push(p[0]); return { rows: [] }; }
  if (/^SELECT name FROM sites WHERE id = \$1/.test(q)) return { rows: S.sites.filter((s) => s.id === p[0]).map((s) => ({ name: s.name })) };
  if (/^SELECT name, system_prompt FROM sites WHERE id = \$1/.test(q)) return { rows: S.sites.filter((s) => s.id === p[0]) };
  if (/^SELECT id, name, system_prompt FROM sites WHERE id = \$1/.test(q)) return { rows: S.sites.filter((s) => s.id === p[0]) };
  if (/^SELECT chikki_effort FROM sites WHERE id = \$1/.test(q)) return { rows: S.sites.filter((s) => s.id === p[0]) };
  if (/^SELECT question, answer, sort_order FROM site_faqs WHERE site_id = \$1 AND is_enabled = true/.test(q)) return { rows: S.faqs.filter((f) => f.site_id === p[0] && f.is_enabled) };
  if (/^SELECT question FROM site_faqs WHERE site_id = \$1/.test(q)) return { rows: S.faqs.filter((f) => f.site_id === p[0]) };
  if (/^SELECT COALESCE\(MAX\(sort_order\), -1\) \+ 1 AS n FROM site_faqs WHERE site_id = \$1/.test(q)) {
    const m = S.faqs.filter((f) => f.site_id === p[0]); return { rows: [{ n: m.length ? Math.max(...m.map((f) => f.sort_order)) + 1 : 0 }] };
  }
  if (/^INSERT INTO site_faqs \(id, site_id, question, answer, sort_order\) VALUES/.test(q)) {
    const row = { id: p[0], site_id: p[1], question: p[2], answer: p[3], sort_order: p[4], is_enabled: true }; S.faqs.push(row);
    return { rows: [row] };
  }
  if (/^SELECT id, question, answer, sort_order, is_enabled FROM site_faqs WHERE site_id = \$1/.test(q)) return { rows: S.faqs.filter((f) => f.site_id === p[0]) };
  if (/^DELETE FROM site_faqs WHERE id = \$1 AND site_id = \$2/.test(q)) { S.faqs = S.faqs.filter((f) => !(f.id === p[0] && f.site_id === p[1])); return { rows: [] }; }
  if (/^SELECT count\(\*\)::int AS n FROM site_faqs WHERE site_id = \$1/.test(q)) return { rows: [{ n: S.faqs.filter((f) => f.site_id === p[0]).length }] };
  if (/^SELECT s\.id AS site_id, s\.tracker_business_id::text AS business_id, COALESCE\(b\.name, s\.name\) AS name/.test(q)) {
    return { rows: S.sites.map((s) => ({ site_id: s.id, business_id: s.tracker_business_id, name: s.name, system_prompt: s.system_prompt, answers: S.faqs.filter((f) => f.site_id === s.id).length })) };
  }
  if (/^SELECT id FROM businesses WHERE id::text = \$1/.test(q) || /^SELECT id FROM businesses WHERE id = \$1/.test(q)) return { rows: S.businesses.filter((b) => b.id === p[0]).map((b) => ({ id: b.id })) };
  throw new Error('fake db: ' + q.slice(0, 120));
}
const db = {
  query: run,
  queryOne: async (q, p) => (await run(q, p)).rows[0] ?? null,
  withTransaction: async (fn) => { const before = JSON.stringify(S.faqs), set = { ...S.settings }; try { return await fn({ query: run }); } catch (e) { S.faqs = JSON.parse(before); S.settings = set; throw e; } },
};
// ── fake next/server, auth and site ──
class NextResponse { constructor(body, init) { this.body = body; this.status = init?.status ?? 200; this.headers = { set() {} }; } static json(body, init) { return new NextResponse(body, init); } }
const USERS = {
  owner: { username: 'owner', role: 'admin', businessIds: null, permissions: null },
  lead: { username: 'pa', role: 'panel_admin', businessIds: null, permissions: null },
  one: { username: 'one', role: 'panel_admin', businessIds: ['P2'], permissions: null },
};
let me = null;
const fakes = {
  '@/lib/db': db,
  'next/server': { NextResponse, NextRequest: class {} },
  '@/lib/auth': { getAuthFromRequest: () => me },
  '@/lib/chat/site': {
    ensureSiteForPanel: async (b) => S.sites.find((s) => s.tracker_business_id === b),
    siteForPanel: async (b) => S.sites.find((s) => s.tracker_business_id === b) ?? null,
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (fakes[request]) return request;
  if (request.startsWith('@/')) return origResolve.call(this, path.join(SRC, request.slice(2)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) { if (fakes[request]) return fakes[request]; return origLoad.call(this, request, parent, ...rest); };
const R = require(path.join(SRC, 'lib/chat/common-setup-rules.ts'));
const C = require(path.join(SRC, 'lib/chat/common-setup.ts'));
const P = require(path.join(SRC, 'lib/chat/ai-prompt.ts'));
const faqRoute = require(path.join(SRC, 'app/api/panel-faq/route.ts'));
const setupRoute = require(path.join(SRC, 'app/api/panel-setup/route.ts'));
const req = (url, body) => ({ url: 'http://x' + url, json: async () => body });

const realErr = console.error;
let pass = 0, fail = 0;
async function t(name, fn) {
  reset(); me = USERS.owner; delete global.__commonCache; delete global.__modeCache;
  console.error = () => {};
  try { await fn(); console.error = realErr; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = realErr; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')); }
}

(async () => {
  console.log('common-setup: one Chikki for every panel');
  await t('rules: the name customers read, {brand} filled, the source name made {brand}, which setup a panel uses', () => {
    deq(['vastora', 'VASTRIKA', 'kurtiya Support', '  ', null].map(R.brandOf), ['Vastora', 'VASTRIKA', 'Kurtiya', '', '']);
    eq(R.fillBrand('Hi from {brand}, {BRAND} team', 'Kurtiya'), 'Hi from Kurtiya, Kurtiya team');
    deq(R.toCommonText("Vastora's team: VASTORA, vastoraX, Vastora Support", 'vastora'), { text: "{brand}'s team: {brand}, vastoraX, {brand} Support", hits: 3 });
    // No common setup: always the panel's own. With one: a saved mode wins; none = own if it has a prompt, else common.
    eq(R.modeFor('common', 'x', false), 'own');
    deq([R.modeFor(null, 'x', true), R.modeFor(null, '  ', true), R.modeFor(null, null, true), R.modeFor('own', null, true), R.modeFor('common', 'x', true)], ['own', 'common', 'common', 'own', 'common']);
    const common = { prompt: 'Karry of {brand}', effort: { calm: 'high' }, from: 'vastora', at: null, by: null };
    deq(R.panelSetup('S3', 'kurtiya', null, common, null), { mode: 'common', brand: 'Kurtiya', prompt: 'Karry of Kurtiya', faqSite: '*', effort: { calm: 'high' } });
    deq(R.panelSetup('S2', 'VASTRIKA', 'own', common, null), { mode: 'own', brand: 'VASTRIKA', prompt: 'own', faqSite: 'S2', effort: null });
  });
  await t('the built-in words carry each panel\'s name: no "Vastora" in VASTRIKA\'s locked rules; Vastora\'s prompt unchanged', () => {
    const plain = P.buildSystemPrompt(null, true, 'email', [], null, '');
    eq(P.buildSystemPrompt(null, true, 'email', [], null, '', 'Vastora'), plain, 'Vastora: byte for byte');
    eq(P.buildSystemPrompt(null, true, 'email', [], null, '', null), plain);
    const v = P.buildSystemPrompt('Own prompt of VASTRIKA', true, 'email', [], null, '', 'VASTRIKA');
    ok(!/Vastora/.test(v), 'no Vastora anywhere');
    ok(v.includes('I\'m Karry from the VASTRIKA team') && v.includes('"Karry, VASTRIKA Support"') && v.includes('this is VASTRIKA\'s automated support'));
    ok(P.buildSystemPrompt(null, true, 'chat', [], null, '', 'Kurtiya').startsWith('You are Karry, the customer support agent for Kurtiya'), 'the default prompt too');
    ok(P.getLockedRules('Kurtiya').join(' ').includes('Karry from the Kurtiya team') && P.getLockedRules().join(' ').includes('Karry from the Vastora team'));
  });
  await t('setupFor: no common setup = every panel its own (as before); a failure = its own; the reads are cached', async () => {
    deq(await C.setupFor('S1', 'P'), { mode: 'own', brand: 'Vastora', prompt: 'P', faqSite: 'S1', effort: null });
    S.fail = true; delete global.__commonCache; delete global.__modeCache;
    deq(await C.setupFor('S2', 'Own'), { mode: 'own', brand: '', prompt: 'Own', faqSite: 'S2', effort: null });
  });
  await t('Make from a panel: Preview changes nothing; Make = the prompt and enabled answers with {brand}, the effort levels; a second Make keeps the old one as a backup and adds only new questions', async () => {
    const dry = await C.makeCommon('S1', 'owner', true);
    deq(dry, { source: { siteId: 'S1', name: 'vastora' }, prompt: { chars: 'You are Karry for {brand}. {brand} sells kurtis.'.length, hits: 2, replaces: false }, answers: { add: 2, skip: 0, hits: 2 }, effort: true });
    deq([Object.keys(S.settings), S.faqs.filter((f) => f.site_id === '*').length], [[], 0], 'Preview wrote nothing');
    await C.makeCommon('S1', 'owner', false);
    const c = JSON.parse(S.settings.common_setup);
    deq([c.prompt, c.from, c.by, c.effort.critical], ['You are Karry for {brand}. {brand} sells kurtis.', 'vastora', 'owner', 'max']);
    deq(S.faqs.filter((f) => f.site_id === '*').map((f) => [f.question, f.answer]), [['Is {brand} real?', 'Yes, {brand} is a real store.'], ['COD?', 'Yes.']]);
    S.faqs.push({ id: 'f4', site_id: 'S1', question: 'New Q', answer: 'New A', sort_order: 3, is_enabled: true });
    const again = await C.makeCommon('S1', 'owner', false);
    deq([again.prompt.replaces, again.answers.add, again.answers.skip], [true, 1, 2]);
    ok(Object.keys(S.settings).some((k) => k.startsWith('common_setup_backup:')));
    eq((await C.makeCommon('S3', 'owner', true)).error, 'That panel has no Chikki prompt of its own to share');
  });
  await t('once made: kurtiya (no prompt) uses it by itself, VASTRIKA keeps its own until switched; switching reads {brand} as its name', async () => {
    await C.makeCommon('S1', 'owner', false);
    delete global.__commonCache;
    const k = await C.setupFor('S3', null);
    deq([k.mode, k.prompt, k.faqSite], ['common', 'You are Karry for Kurtiya. Kurtiya sells kurtis.', '*']);
    eq((await C.setupFor('S2', 'Own VASTRIKA prompt')).mode, 'own');
    await C.setMode('S2', 'common');
    const v = await C.setupFor('S2', 'Own VASTRIKA prompt');
    deq([v.mode, v.prompt, v.effort.critical], ['common', 'You are Karry for VASTRIKA. VASTRIKA sells kurtis.', 'max']);
    await C.setMode('S2', 'own');
    eq((await C.setupFor('S2', 'Own VASTRIKA prompt')).prompt, 'Own VASTRIKA prompt', 'Own brings its own back; nothing was deleted');
    eq(S.sites[1].system_prompt, 'Own VASTRIKA prompt');
  });
  await t('the panel-setup route: Super Admin only; Preview / Make; a mode needs the common setup first; the overview lists every panel', async () => {
    me = USERS.lead;
    eq((await setupRoute.GET(req('/api/panel-setup'))).status, 403);
    me = USERS.owner;
    eq((await setupRoute.POST(req('/api/panel-setup', { action: 'mode', businessId: 'P2', mode: 'common' }))).status, 409);
    let r = await setupRoute.POST(req('/api/panel-setup', { action: 'make', businessId: 'P1', dryRun: true }));
    deq([r.status, r.body.done, S.settings.common_setup], [200, false, undefined]);
    r = await setupRoute.POST(req('/api/panel-setup', { action: 'make', businessId: 'P1' }));
    deq([r.status, r.body.done], [200, true]);
    r = await setupRoute.POST(req('/api/panel-setup', { action: 'mode', businessId: 'P2', mode: 'common' }));
    deq([r.status, S.settings['setup_mode:S2']], [200, 'common']);
    r = await setupRoute.GET(req('/api/panel-setup'));
    deq(r.body.panels.map((p) => [p.name, p.brand, p.mode]), [['vastora', 'Vastora', 'own'], ['VASTRIKA', 'VASTRIKA', 'common'], ['kurtiya', 'Kurtiya', 'common']]);
    deq([r.body.common.ready, r.body.common.from, r.body.common.answers], [true, 'vastora', 2]);
  });
  await t('saved answers on a panel that uses the All panels setup are the common ones: an admin of all panels changes them for all; an admin of one panel may not', async () => {
    await C.makeCommon('S1', 'owner', false);
    await C.setMode('S2', 'common');
    me = USERS.one;
    let r = await faqRoute.GET(req('/api/panel-faq?businessId=P2'));
    deq([r.body.scope, r.body.faqs.map((f) => f.question)], ['common', ['Is {brand} real?', 'COD?']]);
    r = await faqRoute.POST(req('/api/panel-faq', { businessId: 'P2', question: 'Q', answer: 'A' }));
    deq([r.status, /All panels setup/.test(r.body.error)], [403, true]);
    me = USERS.lead;
    r = await faqRoute.POST(req('/api/panel-faq', { businessId: 'P2', question: 'Size chart?', answer: 'On the {brand} product page.' }));
    eq(r.status, 200);
    ok(S.faqs.some((f) => f.site_id === '*' && f.question === 'Size chart?'), 'saved once, for every panel on it');
    const id = S.faqs.find((f) => f.site_id === '*' && f.question === 'COD?').id;
    eq((await faqRoute.DELETE(req(`/api/panel-faq?businessId=P2&id=${id}`))).status, 200);
    ok(!S.faqs.some((f) => f.id === id));
    // vastora (own) keeps its own answers.
    r = await faqRoute.GET(req('/api/panel-faq?businessId=P1'));
    deq([r.body.scope, r.body.faqs.length], ['panel', 3]);
  });
  await t('Chikki reads it: ai.ts, the suggested replies and the panel screens go through setupFor / setupForSite', () => {
    const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
    const ai = read('lib/chat/ai.ts');
    ok(/const setup = siteId \? await setupFor\(siteId, siteSystemPrompt\) : null;/.test(ai));
    ok(/buildSystemPrompt\(setup \? setup\.prompt : siteSystemPrompt, codAvailable, channel, faqs, codStates, askedNow, setup\?\.brand \?\? null\)/.test(ai));
    ok(/\[setup\?\.faqSite \?\? siteId\]/.test(ai) && /setup\?\.mode === 'common' && setup\.effort/.test(ai));
    ok(/await setupFor\(conv\.site_id, site\?\.system_prompt \|\| null\)/.test(read('lib/chat/suggest-run.ts')));
    ok(/setupForSite/.test(read('app/api/panel-chat/route.ts')) && /saveCommon\(\{ prompt: text \}/.test(read('app/api/panel-chat/route.ts')));
    ok(/saveCommon\(\{ effort: settings \}/.test(read('app/api/panel-brain/effort/route.ts')));
    ok(/getLockedRules\(setup\?\.brand \?\? null\)/.test(read('app/api/panel-brain/route.ts')));
  });

  console.log(`COMMON-SETUP: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
