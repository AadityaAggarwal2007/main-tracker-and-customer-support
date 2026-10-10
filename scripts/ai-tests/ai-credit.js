// The AI's OpenRouter money (owner 2026-10-10, step A): the REAL ai-credit-rules.ts and ai-credit.ts against a fake
// OpenRouter, a fake database and a fake WhatsApp.
const fs = require('fs'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');
const SRC = path.resolve(__dirname, '../../src');
require.extensions['.ts'] = (m, filename) => m._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true }, fileName: filename }).outputText, filename);
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;

const S = { settings: {}, sends: [], templates: [{ name: 'shiptrack_alert', language: 'en_US', status: 'APPROVED' }], to: '919876543210', configured: true };
const db = {
  query: async (q, p) => { if (/INSERT INTO chat_settings/.test(q)) S.settings[p[0]] = p[1]; return { rows: [] }; },
  queryOne: async (q, p) => (S.settings[p[0]] !== undefined ? { value: S.settings[p[0]] } : null),
};
const fakes = {
  '@/lib/db': db,
  './whatsapp': { waConfigured: () => S.configured, sendWhatsAppTemplate: async (to, name, lang, params) => { S.sends.push({ to, name, lang, params }); return { ok: true, id: 'wamid.1' }; } },
  './whatsapp-templates': { listTemplates: async () => ({ ok: true, value: S.templates }) },
  './whatsapp-settings': { alertTo: async () => S.to, templatesAccount: async () => '123456789' },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (fakes[request]) return request;
  if (request.startsWith('@/')) return origResolve.call(this, path.join(SRC, request.slice(2)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) { if (fakes[request]) return fakes[request]; return origLoad.call(this, request, parent, ...rest); };
const R = require(path.join(SRC, 'lib/chat/ai-credit-rules.ts'));
const C = require(path.join(SRC, 'lib/chat/ai-credit.ts'));

// A fake OpenRouter: key + credits answers, and what was asked.
const asked = [];
const openrouter = (key, credits, status = 200) => async (url, init) => {
  asked.push({ url, auth: init.headers.Authorization });
  const body = /\/v1\/key$/.test(url) ? key : credits;
  return { ok: status === 200 && body !== null, status: body === null ? 403 : status, json: async () => body };
};
const ENV = { CODEX_URL: 'https://openrouter.ai/api', AI_API_KEY: 'sk-or-test' };

let pass = 0, fail = 0;
async function t(name, fn) {
  delete global.__aiCredit; delete global.__aiCreditBusy; S.settings = {}; S.sends = []; S.to = '919876543210'; S.configured = true;
  S.templates = [{ name: 'shiptrack_alert', language: 'en_US', status: 'APPROVED' }]; asked.length = 0;
  const err = console.error, log = console.log; console.error = () => {}; console.log = () => {};
  try { await fn(); console.error = err; console.log = log; pass++; console.log('  ok  ' + name); }
  catch (e) { console.error = err; console.log = log; fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 10).join('\n       ')); }
}
const NOW = Date.parse('2026-10-10T12:00:00Z');
const key = (o = {}) => ({ data: { limit: null, limit_remaining: null, limit_reset: null, usage: 120, usage_daily: 2, usage_weekly: 28, usage_monthly: 40, ...o } });
const credits = (total, used) => ({ data: { total_credits: total, total_usage: used } });

(async () => {
  console.log('ai-credit: the AI\'s OpenRouter money');
  await t('rules: the smaller of credits and the key limit, days at last week\'s spend, ok / warn / danger', () => {
    const k = R.parseKey(key());
    eq(R.perDay(k, 10), 4, 'last week / 7');
    eq(R.perDay(R.parseKey(key({ usage_weekly: 0 })), 10), 4, 'else this month / day of month');
    let c = R.assessCredit(k, 100, 10, NOW);
    deq([c.level, c.binding, c.daysLeft, c.lines.length], ['ok', 'credits', 25, 0]);
    c = R.assessCredit(k, 15, 10, NOW);
    deq([c.level, c.daysLeft], ['warn', 3.8]);
    ok(/OpenRouter credits: \$15\.00 left, about 3 days at \$4\.00 a day\. Recharge/.test(c.lines[0].text), c.lines[0].text);
    c = R.assessCredit(k, 5, 10, NOW);
    eq(c.level, 'danger');
    // The key's monthly limit runs out first: it is what the line names.
    c = R.assessCredit(R.parseKey(key({ limit: 100, limit_remaining: 6, limit_reset: 'monthly' })), 300, 10, NOW);
    deq([c.level, c.binding, c.keyLeft], ['danger', 'key', 6]);
    ok(/The AI key's monthly limit: \$6\.00 of \$100\.00 left, about 1 day/.test(c.lines[0].text) && /Keys/.test(c.lines[0].text), c.lines[0].text);
    eq(R.assessCredit(null, null, 10, NOW).level, 'unknown');
    eq(R.parseCredits(credits(50, 42.3)), 7.7);
    eq(R.parseKey({ nope: 1 }), null);
    const a = R.alertText(R.assessCredit(k, 5, 10, NOW));
    ok(a && !/\n|\s{5}/.test(a) && a.length <= 300, 'one line for a template variable');
    eq(R.alertText(R.assessCredit(k, 100, 10, NOW)), null);
  });
  await t('server: asks OpenRouter with the same key for the key and the credits; cached 10 minutes; not OpenRouter or no key = unknown, nothing asked', async () => {
    let c = await C.loadAiCredit(true, NOW, ENV, openrouter(key(), credits(30, 10)));
    deq([c.level, c.balance, asked.map((x) => x.url).sort()], ['ok', 20, ['https://openrouter.ai/api/v1/credits', 'https://openrouter.ai/api/v1/key']]);
    ok(asked.every((x) => x.auth === 'Bearer sk-or-test'));
    await C.loadAiCredit(false, NOW + 60_000, ENV, openrouter(key(), credits(1, 0)));
    eq(asked.length, 2, 'cached');
    c = await C.loadAiCredit(false, NOW + 11 * 60_000, ENV, openrouter(key(), credits(5, 0)));
    eq(c.level, 'danger');
    asked.length = 0;
    c = await C.loadAiCredit(true, NOW, { CODEX_URL: 'http://localhost:9000', AI_API_KEY: 'x' }, openrouter(key(), credits(1, 0)));
    deq([c.level, asked.length], ['unknown', 0]);
    c = await C.loadAiCredit(true, NOW, { CODEX_URL: 'https://openrouter.ai/api' }, openrouter(key(), credits(1, 0)));
    deq([c.level, !!c.error, asked.length], ['unknown', true, 0]);
    // Credits refused (a key without that right): the key alone still answers.
    c = await C.loadAiCredit(true, NOW, ENV, openrouter(key({ limit: 50, limit_remaining: 40 }), null));
    deq([c.level, c.balance, c.keyLeft], ['ok', null, 40]);
  });
  await t('alert: low = one WhatsApp template to the owner\'s number; not again for 12 hours at the same level; a worse level at once; nothing without the number, the template, or when it is fine', async () => {
    // The reading as the cache holds it (fresh at each call, so the fake key is never asked).
    const at = (ms, balance) => { global.__aiCredit = { at: ms, v: R.assessCredit(R.parseKey(key()), balance, 10, ms) }; return ms; };
    let r = await C.aiCreditAlert(at(NOW, 15));   // warn
    deq([r.sent, S.sends.length, S.sends[0].name, S.sends[0].to], [true, 1, 'shiptrack_alert', '919876543210']);
    ok(/OpenRouter credits: \$15\.00 left/.test(S.sends[0].params[0]));
    r = await C.aiCreditAlert(at(NOW + 3_600_000, 15));
    deq([r.sent, r.why], [false, 'already sent']);
    eq((await C.aiCreditAlert(at(NOW + 7_200_000, 3))).sent, true, 'worse (danger): at once');
    eq((await C.aiCreditAlert(at(NOW + 8_000_000, 3))).sent, false);
    eq((await C.aiCreditAlert(at(NOW + 7_200_000 + 13 * 3_600_000, 3))).sent, true, 'after 12 hours again');
    S.settings = {}; S.to = '';
    eq((await C.aiCreditAlert(at(NOW, 15))).why, 'no alert number');
    S.to = '919876543210'; S.templates = [{ name: 'shiptrack_alert', language: 'en_US', status: 'PENDING' }];
    eq((await C.aiCreditAlert(at(NOW, 15))).why, 'template not approved');
    eq((await C.aiCreditAlert(at(NOW, 100))).why, 'ok');
  });
  await t('wiring: the minute cron sends the alert; the Today board carries it for the Super Admin; the alert template preset is valid', () => {
    const cron = fs.readFileSync(path.join(SRC, 'app/api/cron/chat-email-poll/route.ts'), 'utf8');
    ok(/void aiCreditAlert\(\)\.catch\(\(\) => \{\}\);/.test(cron));
    const board = fs.readFileSync(path.join(SRC, 'lib/panel-board-server.ts'), 'utf8');
    ok(/const aiCredit = superAdmin \? await loadAiCredit\(false, now\)/.test(board));
    const brand = require(path.join(SRC, 'lib/chat/whatsapp-brand-rules.ts'));
    const tpl = require(path.join(SRC, 'lib/chat/whatsapp-templates.ts'));
    const spec = tpl.templateSpec(brand.SHIPTRACK_ALERT_PRESET);
    ok(!spec.error, JSON.stringify(spec.error));
    const pb = require(path.join(SRC, 'lib/panel-board.ts'));
    const t0 = { needsYou: 0, overdue: 0, chargebacks: 0, gmailErrors: 0, refundRequests: 0, reshipToShip: 0, refundCases: 0, lateOrders: 0, setupGaps: 0 };
    deq([pb.morningRoutine(t0, false, null, true)[0].done, pb.morningRoutine(t0, false, null, false)[0].done], [false, true]);
  });

  console.log(`AI-CREDIT: ${pass} groups passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
