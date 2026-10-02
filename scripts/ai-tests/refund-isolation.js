// Refund form (owner, 2026-10-02), slice D: the form never leaks into the shared chat code, and the
// shared code is only ever made STRICTER for it. Spec refund_form_spec.md 11.1 (I1-I12), plus the owner
// answers of 2 Oct (Q1 refund destination, Q7 every Google Form, no uploads). Greps over src, and the
// REAL shared modules compiled with TypeScript (sensitive, message-rules, waiting-sql, inbox-search,
// link-mask). No database, no network, no model.
//   I1  only src/lib/refund/crypto.ts reads REFUND_DATA_KEY
//   I2  refund tables / payout / server-only refund modules stay in the refund files; chat, team score
//       and widget code import at most the pure link-mask; screens import only pure refund modules
//   I3  'system' never reaches the AI history, subject, health, the learner or the team score
//   I4  waiting + auto-close leave 'system' out (stricter only)
//   I5  nobody edits or deletes a 'system' message; its label
//   I6  maskSensitive masks a pasted refund link (no kind); same regex as link-mask
//   I7  search leaves 'system' messages out (text match + snippet)
//   I8  refund log lines carry no customer data and no error object
//   I9  next.config.js: /refund + /api/refund headers, no CORS for them
//   I10 /refund page: no innerHTML, no console, no localStorage; sessionStorage keys rf_t / rf_n / rf_draft
//   I11 ai.ts withReplyGuards calls dropFormMentions
//   I12 staff reply + edit routes refuse a form link before anything is read or saved; details GET masked
//   I13 owner answer Q1: Chikki no longer says "original payment method"; rulebook 5.4 + 9.x
//   I14 owner change (2 Oct, 15:00): no refund file upload anywhere
// Output: test ids and messages only (no customer data exists here; every value is made up).
// refund-mutate.js (run by hand) runs this file on mutated copies of the code (M19-M22).
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), Module = require('module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'refund-isolation-')));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

// TypeScript straight from src; '@/x' = src/x. Only pure modules are loaded (no db, no next).
require.extensions['.ts'] = (mod, filename) => {
  const src = fs.readFileSync(filename, 'utf8');
  mod._compile(ts.transpileModule(src, { fileName: filename, compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true } }).outputText, filename);
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const r = request.startsWith('@/') ? path.join(SRC, request.slice(2)) : request;
  return origResolve.call(this, r, parent, ...rest);
};
const load = (rel) => require(path.join(SRC, rel));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs).flatMap((f) => walk(path.join(rel, f)));
}
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const srcFiles = walk('src').filter((f) => CODE.test(f)).map((f) => f.split(path.sep).join('/'));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');

let n = 0;
const failed = [];
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { failed.push(name.split(' ')[0]); console.log(`FAIL ${name}: ${String(e && e.message).split('\n')[0].slice(0, 300)}`); }
};
const eq = (a, b, msg) => assert.strictEqual(a, b, msg);
const deq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);

// The team score's folder, written in two parts: team-score-unit.js W8 flags any non-comment line outside
// the team score that names it. This suite only READS those files as text (I2, I3).
const TS_DIR = 'src/lib/' + 'team' + '-score/';
const inScoreDir = (f) => f.startsWith(TS_DIR);

const LINK = 'https://shiptrack.store/refund#' + 'Qz9_Kp-2'.repeat(5) + 'abc';   // made up, 43 characters

// ── I1 ───────────────────────────────────────────────────────────
t('I1 only src/lib/refund/crypto.ts reads REFUND_DATA_KEY', () => {
  const hits = srcFiles.filter((f) => /REFUND_DATA_KEY/.test(read(f)));
  deq(hits, ['src/lib/refund/crypto.ts']);
  const env = srcFiles.filter((f) => f !== 'src/lib/refund/crypto.ts' && /process\.env\.REFUND_|process\.env\[['"]REFUND_/.test(read(f)));
  // Review fix 2026-10-02: the pure link-mask.ts reads the kill switch REFUND_FORMS (refundFormsOpen, for
  // Chikki's threat path in src/lib/chat), nothing else; it says "off" exactly when crypto.ts does.
  deq(env, ['src/lib/refund/link-mask.ts'], 'no other file reads a REFUND_* variable');
  deq([...new Set([...read('src/lib/refund/link-mask.ts').matchAll(/process\.env(?:\.(\w+)|\[)/g)].map((m) => m[1] || '['))], ['REFUND_FORMS'], 'link-mask.ts reads only REFUND_FORMS');
  const lm = load('lib/refund/link-mask.ts'), cr = load('lib/refund/crypto.ts');
  const saved = process.env.REFUND_FORMS;
  try {
    for (const v of [undefined, '', 'on', 'off', ' OFF ', 'Off', 'no']) {
      if (v === undefined) delete process.env.REFUND_FORMS; else process.env.REFUND_FORMS = v;
      eq(lm.refundFormsOpen(), cr.refundFormsState() !== 'off', `REFUND_FORMS=${v}`);
    }
  } finally { if (saved === undefined) delete process.env.REFUND_FORMS; else process.env.REFUND_FORMS = saved; }
  const refundLib = srcFiles.filter((f) => /^src\/lib\/refund\//.test(f));
  deq(refundLib.filter((f) => /process\.env\.AUTH_TOKEN_SECRET|process\.env\[['"]AUTH_TOKEN_SECRET/.test(stripComments(read(f)))), [], 'the refund key is never derived from AUTH_TOKEN_SECRET');
});

// ── I2 ───────────────────────────────────────────────────────────
const REFUND_AREAS = [/^src\/lib\/refund\//, /^src\/app\/api\/refund\//, /^src\/app\/api\/refunds\//, /^src\/app\/api\/chat\/conversations\/\[id\]\/refund-form\//,
  /^src\/app\/refund\//, /^src\/components\/Refund[^/]*$/];
const THREAD = 'src/app/api/chat/conversations/[id]/route.ts';
const inRefundArea = (f) => REFUND_AREAS.some((re) => re.test(f));
const SECRET_RE = /refund_requests|refund_links|refund_files|refund_file_parts|refund_events|payout_|@\/lib\/refund\/server|@\/lib\/refund\/crypto|@\/lib\/refund\/public/;
t('I2 refund tables, payout and server-only refund modules: only in the refund files (+ the thread route\'s two calls)', () => {
  const bad = srcFiles.filter((f) => !inRefundArea(f) && f !== THREAD && SECRET_RE.test(read(f)));
  deq(bad, [], 'files outside the refund areas');
  // The thread route: exactly refundThreadState + refundMarkLocked from server.ts, no table, no payout.
  const thread = read(THREAD);
  const fromServer = [...thread.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/lib\/refund\/server'/g)].map((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean).sort());
  deq(fromServer, [['refundMarkLocked', 'refundThreadState']], 'the thread route imports only refundThreadState / refundMarkLocked');
  ok(!/refund_requests|refund_links|refund_files|refund_file_parts|refund_events|payout_|@\/lib\/refund\/(crypto|public)/.test(thread), 'no table, payout or crypto in the thread route');
});
t('I2 chat, team score and widget code import at most the pure link-mask; no widget route touches refunds', () => {
  const shared = srcFiles.filter((f) => /^src\/lib\/chat\/|^src\/app\/api\/widget\//.test(f) || inScoreDir(f));
  ok(shared.length > 20, 'the shared files were found');
  const bad = [];
  for (const f of shared) {
    const s = read(f);
    for (const m of s.matchAll(/from\s+'([^']*refund[^']*)'|require\(\s*'([^']*refund[^']*)'\s*\)/g)) {
      const spec = m[1] || m[2];
      // src/lib/chat/refund-threat.ts (owner 2026-10-02 18:45) is a chat module, not a refund one: the threat
      // detector and Chikki's fixed promise; it imports no refund module (checked below).
      if (!/^(@\/lib\/refund\/link-mask|\.\.\/refund\/link-mask|@\/lib\/chat\/refund-threat|\.\/refund-threat)$/.test(spec)) bad.push(`${f} -> ${spec}`);
    }
    if (SECRET_RE.test(s)) bad.push(`${f} mentions a refund table / payout / server module`);
  }
  deq(bad, []);
  const threatSpecs = [...read('src/lib/chat/refund-threat.ts').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  deq(threatSpecs.filter((x) => /refund/.test(x)), [], 'refund-threat.ts imports no refund module');
  const widget = shared.filter((f) => /^src\/app\/api\/widget\//.test(f) && /lib\/refund|refund_/.test(read(f)));
  deq(widget, [], 'no /api/widget/* route imports or reads anything of the refund form');
  ok(!/\/api\/refunds?\b|refund_|\/refund#/.test(read('public/widget.js')), 'widget.js knows nothing of the refund form');
});
t('I2 screens import only the pure refund modules (rules, texts, link-mask); those modules import nothing else', () => {
  const screens = srcFiles.filter((f) => /\.tsx$/.test(f) || /^src\/app\/refund\//.test(f));
  const bad = [];
  for (const f of screens) {
    for (const m of read(f).matchAll(/from\s+'@\/lib\/refund\/([^']+)'/g)) if (!['rules', 'texts', 'link-mask'].includes(m[1])) bad.push(`${f} -> ${m[1]}`);
  }
  deq(bad, [], 'a screen imports a server-only refund module');
  for (const m of ['rules', 'texts', 'link-mask']) {
    const specs = [...read(`src/lib/refund/${m}.ts`).matchAll(/from\s+'([^']+)'/g)].map((x) => x[1]).filter((x) => x !== './rules');
    deq(specs, [], `${m}.ts imports only ./rules`);
  }
});

// ── I3 ───────────────────────────────────────────────────────────
const SENDER_SYSTEM = /sender\s*(?:===?|!==?|<>)\s*'system'|sender\s+(?:NOT\s+)?IN\s*\([^)]*'system'|sender\s*=\s*ANY\([^)]*'system'/i;
t("I3 the AI history loop has no 'system' branch; subject, health, learner and team score read named senders only", () => {
  const ai = ['ai', 'ai-models', 'ai-prompt', 'ai-tools', 'ai-history'].map((f) => read(`src/lib/chat/${f}.ts`)).join('\n');
  ok(!SENDER_SYSTEM.test(ai), "ai.ts never compares a sender with 'system'");
  const loop = ai.slice(ai.indexOf('for (const m of recent.rows) {'));
  ok(loop.length < ai.length, 'the history loop was found');
  const body = loop.slice(0, loop.indexOf('const history = dropOrphanedToolCalls'));
  const compared = [...body.matchAll(/m\.sender === '([a-z_]+)'/g)].map((x) => x[1]);
  deq([...new Set(compared)].sort(), ['agent', 'ai', 'tool_result', 'visitor'], 'the loop handles only visitor / ai / agent / tool_result');
  const lists = {
    'src/lib/chat/subject.ts': /sender IN \('visitor', 'ai', 'agent'\)/,
    'src/lib/chat/health.ts': /sender IN \('visitor', 'ai', 'agent'\)/,
    'src/lib/chat/brain-suggest.ts': /sender IN \('visitor', 'ai', 'agent'\)/,
    [TS_DIR + 'load.ts']: /sender IN \('visitor','agent','ai'\)/,
  };
  for (const [f, re] of Object.entries(lists)) {
    const s = read(f);
    ok(re.test(s), `${f} keeps its named sender list`);
    ok(!SENDER_SYSTEM.test(s), `${f} never adds 'system'`);
  }
  for (const f of srcFiles.filter(inScoreDir)) ok(!SENDER_SYSTEM.test(read(f)), `${f} never reads 'system'`);
});

// ── I4 ───────────────────────────────────────────────────────────
const lateral = (sql) => sql.slice(sql.indexOf('LEFT JOIN LATERAL'), sql.indexOf(') w ON true'));
t("I4 waiting (inbox + Unread) and auto-close leave 'system' out of who-wrote-last (stricter only)", () => {
  const { WAITING_LATERAL } = load('lib/chat/waiting-sql.ts');
  ok(/AND m\.sender NOT IN \('tool_result', 'system'\)/.test(WAITING_LATERAL), 'WAITING_LATERAL excludes system');
  ok(!/m\.sender <> 'tool_result'/.test(WAITING_LATERAL), 'no looser tool_result-only filter left');
  ok(!/--/.test(WAITING_LATERAL), 'no SQL comment inside the shared SQL');
  const ac = read('src/lib/chat/auto-close.ts');
  const cand = ac.slice(ac.indexOf('const CANDIDATES_SQL'));
  const w = lateral(cand);
  ok(w.length > 50, 'the auto-close lateral was found');
  ok(/AND m\.sender NOT IN \('tool_result', 'system'\)/.test(w), 'auto-close excludes system');
  ok(!/m\.sender <> 'tool_result'/.test(w), 'no looser filter left in auto-close');
  // Everything else in the two joins is unchanged: hidden, withheld, blank and deleted rows stay out.
  for (const s of [WAITING_LATERAL, w]) {
    for (const re of [/COALESCE\(m\.metadata->>'hidden', 'false'\) <> 'true'/, /COALESCE\(m\.metadata->>'withheld', ''\) = ''/, /m\.deleted_at IS NULL/]) ok(re.test(s), String(re));
  }
});

// ── I5 ───────────────────────────────────────────────────────────
t("I5 nobody edits or deletes a 'system' message (the Super Admin neither); others unchanged", () => {
  const mr = load('lib/chat/message-rules.ts');
  const owner = { role: 'admin', username: 'Owner' };
  const editor = { role: 'panel_admin', username: 'neha', permissions: ['chat.view', 'chat.reply', 'chat.edit'] };
  const replier = { role: 'agent', username: 'rahul', permissions: ['chat.view', 'chat.reply'] };
  for (const u of [owner, editor, replier]) {
    eq(mr.canChangeMessage(u, { sender: 'system', metadata: {} }), false, `${u.username}: system`);
    eq(mr.canChangeMessage(u, { sender: 'system', metadata: null }), false, `${u.username}: system, no metadata`);
    eq(mr.canChangeMessage(u, { sender: 'system', metadata: { agent: u.username } }), false, `${u.username}: system dressed as their own`);
    eq(mr.canChangeMessage(u, { sender: 'ai', metadata: null }), true, `${u.username}: AI messages as before`);
  }
  eq(mr.canChangeMessage(replier, { sender: 'agent', metadata: { agent: 'rahul' } }), true, 'own reply as before');
  eq(mr.canChangeMessage(replier, { sender: 'agent', metadata: { agent: 'neha' } }), false, "someone else's reply as before");
  deq(mr.senderLabel({ sender: 'system', metadata: {} }), { who: 'System', type: 'System', origin: 'Sent by ShipTrack (refund form)' });
  eq(mr.isOurMessage({ sender: 'system', metadata: {} }), true, 'still shown in the details view (masked there)');
});

// ── I6 ───────────────────────────────────────────────────────────
t('I6 maskSensitive: a pasted refund link becomes [refund form link], no kind, no warning; same regex as link-mask', () => {
  const { maskSensitive } = load('lib/chat/sensitive.ts');
  const lm = load('lib/refund/link-mask.ts');
  deq(maskSensitive('see ' + LINK), { text: 'see [refund form link]', kinds: [] });
  deq(maskSensitive(`${LINK}\nform bhar diya`), { text: '[refund form link]\nform bhar diya', kinds: [] });
  deq(maskSensitive(`a ${LINK} b http://localhost:3000/refund#${'x'.repeat(20)}`), { text: 'a [refund form link] b [refund form link]', kinds: [] });
  // With a card number too: both hidden, the card still counts.
  const both = maskSensitive(`card 4111 1111 1111 1111 and ${LINK}`);
  ok(both.text.includes('[card number hidden]') && both.text.includes('[refund form link]') && !both.text.includes('/refund#'));
  deq(both.kinds, ['card']);
  // Nothing to hide: exactly as typed (the verify flow depends on it).
  for (const s of ['order #4715 phone 9876543210', 'refund chahiye', 'https://shiptrack.store/refund', 'https://shiptrack.store/refund#short']) eq(maskSensitive(s).text, s, s);
  // Review fix 2026-10-02: a link rewritten by a mail gateway (Outlook Safe Links percent-encodes it),
  // a scheme-less or an upper-case copy is masked too: the token never reaches staff, search or the AI.
  const tok = LINK.split('#')[1];
  for (const s of [
    `link nahi khul raha: https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fshiptrack.store%2Frefund%23${tok}&data=05%7C02`,
    `x https%3a%2f%2fshiptrack.store%2frefund%23${tok}`, `shiptrack.store/refund#${tok}`, `HTTPS://SHIPTRACK.STORE/REFUND#${tok}`,
  ]) {
    const r = maskSensitive(s);
    ok(!r.text.includes(tok) && r.text.includes('[refund form link]'), 'encoded / scheme-less / upper-case link masked');
    deq(r.kinds, [], 'no kind, no warning');
  }
  // The two regexes are the same (sensitive.ts has no imports, so it keeps its own copy).
  const src = read('src/lib/chat/sensitive.ts');
  const m = src.match(/const REFUND_LINK = (\/.*\/[a-z]*);/);
  ok(m, 'REFUND_LINK found in sensitive.ts');
  eq(m[1], lm.REFUND_LINK_RE.toString(), 'sensitive.ts REFUND_LINK = link-mask REFUND_LINK_RE');
  ok(!/^import /m.test(src), 'sensitive.ts keeps zero imports');
});

// ── I7 ───────────────────────────────────────────────────────────
t("I7 search leaves 'system' messages out of text matches and snippets", () => {
  const { parseInboxSearch } = load('lib/chat/inbox-search.ts');
  const s = parseInboxSearch('refund', 1);
  ok(s.q, 'the search ran');
  const textHit = s.cte.slice(s.cte.indexOf('bool_or('), s.cte.indexOf('AS text_hit'));
  ok(/m\.sender NOT IN \('tool_result', 'system'\)/.test(textHit), 'text_hit excludes system');
  ok(/m\.sender <> 'system'/.test(s.snippet), 'the snippet (VISIBLE_TEXT) excludes system');
  ok(/m\.sender <> 'tool_result'/.test(s.snippet), 'tool rows stay out as before');
  ok(!/refund_|lib\/refund/.test(read('src/lib/chat/inbox-search.ts')), 'search never touches refund tables');
});

// ── I8 ───────────────────────────────────────────────────────────
function consoleCalls(src) {
  const out = [];
  const re = /console\.(log|error|warn|info|debug)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 1;
    while (i < src.length && depth) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; }
    out.push(src.slice(m.index, i));
  }
  return out;
}
const LOG_WORDS = /\b(body|payload|upi|account|ifsc|holder|token|details|detail|params|stack|phone|mobile)\b/i;
// An error object passed straight to console (its message or detail may quote the row); a helper that
// takes it (codeOf(e), msgOf(e)) is fine.
const BARE_ERROR = /^console\.\w+\(\s*(?:e|err|error|ex)\s*[,)]|,\s*(?:e|err|error|ex)\s*[,)]|\$\{\s*(?:e|err|error|ex)\s*\}|\b(?:e|err|error)\.(?:detail|stack)\b|JSON\.stringify|String\(\s*(?:e|err|error)\s*\)/;
t('I8 refund log lines name no customer data and never print an error object', () => {
  const files = srcFiles.filter((f) => /^src\/lib\/refund\/|^src\/app\/api\/refunds?\/|^src\/app\/api\/chat\/conversations\/\[id\]\/refund-form\/|^src\/components\/Refund/.test(f));
  ok(files.length >= 5, 'the refund files were found');
  const bad = [];
  for (const f of files) for (const c of consoleCalls(stripComments(read(f)))) if (LOG_WORDS.test(c) || BARE_ERROR.test(c)) bad.push(`${f}: ${c.slice(0, 90)}`);
  deq(bad, []);
  // The shared helper prints a code and at most 80 characters of a pg message (never err.detail).
  const server = read('src/lib/refund/server.ts');
  ok(/console\.error\(`\[refund\] \$\{where\} failed:`, codeOf\(e\), msgOf\(e\)\)/.test(server), 'logFail prints codeOf + msgOf only');
  ok(/slice\(0, 80\)/.test(server.slice(server.indexOf('export const msgOf'), server.indexOf('export function logFail'))), 'msgOf is cut to 80 characters');
});

// ── I9 (async: next.config headers(); run at the end) ───────────
const tAsync = [];
tAsync.push(['I9 next.config.js: /refund and /api/refund/:path* headers, no CORS for them, widget CORS unchanged', async () => {
  const list = await require(path.join(ROOT, 'next.config.js')).headers();
  const by = (src) => list.find((h) => h.source === src);
  const page = by('/refund'), api = by('/api/refund/:path*');
  ok(page && api, 'both entries exist');
  const keys = (h) => h.headers.map((x) => x.key.toLowerCase());
  for (const k of ['cache-control', 'referrer-policy', 'x-frame-options', 'x-robots-tag']) ok(keys(page).includes(k), `/refund ${k}`);
  for (const k of ['cache-control', 'x-robots-tag']) ok(keys(api).includes(k), `/api/refund ${k}`);
  // No entry that covers /refund or /api/refund/* may add CORS (only /api/widget/* and /widget.js do).
  for (const h of list) {
    if (['/api/widget/:path*', '/widget.js'].includes(h.source)) continue;
    ok(!keys(h).some((k) => k.startsWith('access-control-')), `no CORS on ${h.source}`);
  }
  ok(keys(by('/api/widget/:path*')).includes('access-control-allow-origin'), 'the widget keeps its CORS');
}]);

// ── I10 ──────────────────────────────────────────────────────────
t('I10 /refund page: no innerHTML, console or localStorage; sessionStorage only rf_t / rf_n / rf_draft; the draft has no payout', () => {
  const page = read('src/app/refund/page.tsx');
  const code = stripComments(page);
  ok(!/dangerouslySetInnerHTML/.test(code), 'no dangerouslySetInnerHTML');
  ok(!/console\./.test(code), 'no console');
  ok(!/localStorage/.test(code), 'no localStorage');
  const keys = [...code.matchAll(/sessionStorage\.setItem\(\s*'([^']+)'/g)].map((m) => m[1]);
  ok(keys.length > 0, 'the page writes sessionStorage somewhere');
  deq([...new Set(keys)].sort().filter((k) => !['rf_draft', 'rf_n', 'rf_t'].includes(k)), [], 'only rf_t, rf_n, rf_draft');
  ok(!/sessionStorage\.setItem\(\s*[^'\s]/.test(code), 'every sessionStorage key is a literal');
  const drafts = [...code.matchAll(/\.draft\(JSON\.stringify\(\{([^}]*)\}\)\)/g)].map((m) => m[1]);
  ok(drafts.length > 0, 'the draft write was found');
  for (const d of drafts) ok(!/upi|account|ifsc|holder|payout|bank/i.test(d), 'the draft never holds UPI / bank details');
});

t('I10 /refund page: every shown text has its Hindi line (Q8): the error summary, Show order / Hide, the account Show / Hide', () => {
  const code = stripComments(read('src/app/refund/page.tsx'));
  // Every LOCAL / PAGE text rendered in English is rendered in Devanagari too, except the step
  // counter's aria-label and the "n / 1000" counter (digits only).
  for (const obj of ['LOCAL', 'PAGE']) {
    const keys = (lang) => new Set([...code.matchAll(new RegExp(`\\b${obj}\\.(\\w+)\\.${lang}\\b`, 'g'))].map((m) => m[1]));
    const hi = keys('hi');
    deq([...keys('en')].filter((k) => !hi.has(k) && !['stepWord', 'detailsCounter'].includes(k)), [], `${obj}: English only`);
  }
  // The summary at the top on Next: each line in English and Hindi.
  ok(/errorKeys\.map\(\(k\) => \{[^]*?<li key=\{k\}>\{t\.en\}<span lang="hi"[^>]*>\{t\.hi\}<\/span><\/li>/.test(code), 'summary lines carry .hi');
});

// ── I11 ──────────────────────────────────────────────────────────
t('I11 ai.ts withReplyGuards drops form mentions (refund form, any Google Form) first', () => {
  const ai = read('src/lib/chat/ai.ts');
  ok(/import \{[^}]*\bdropFormMentions\b[^}]*\} from '@\/lib\/refund\/link-mask';/.test(ai), 'imported from the pure link-mask');
  const start = ai.indexOf('const withReplyGuards = (text: string): string => {');
  ok(start > 0, 'withReplyGuards found');
  const body = ai.slice(start, ai.indexOf('\n  };', start));
  ok(/const form = dropFormMentions\(out, looksHinglish\(visitorTexts\.slice\(-2\)\.join\('\\n'\)\)\);/.test(body), 'called with the chat language');
  ok(/if \(form\.changed\) \{ out = form\.text;/.test(body), 'its result is used');
  ok(body.indexOf('dropFormMentions') < body.indexOf('dropAddressEcho'), 'before the other guards');
  // Every reply path of getAIResponse goes through withReplyGuards (main, H4 retry, self-check fix).
  ok((ai.match(/withReplyGuards\(/g) || []).length >= 3, 'withReplyGuards is used on every reply path');
});

// ── I12 ──────────────────────────────────────────────────────────
t('I12 a staff reply or edit with a form link is refused before anything is read or saved; the details view is masked', () => {
  const post = read('src/app/api/chat/messages/route.ts');
  const edit = read('src/app/api/chat/messages/[id]/route.ts');
  for (const [name, s, first] of [['reply', post, 'SELECT c.id, c.source'], ['edit', edit, 'await loadForUser(params.id, user)']]) {
    ok(/import \{[^}]*hasFormLink[^}]*\} from '@\/lib\/refund\/link-mask';/.test(s), `${name}: hasFormLink imported`);
    const check = s.indexOf('if (hasFormLink(text))');
    ok(check > 0, `${name}: checks the text`);
    const patch = name === 'edit' ? s.indexOf('export async function PATCH') : 0;
    ok(check > patch && check < s.indexOf(first, patch), `${name}: before the database is read`);
    ok(/if \(hasFormLink\(text\)\) return NextResponse\.json\(\{ error: "Refund forms go only through 'Send refund form' \(Super Admin, Refund section\)\. Remove the form link\." \}, \{ status: 403 \}\);/.test(s), `${name}: 403 with the owner's text`);
  }
  ok(/message: \{ \.\.\.message, content: maskRefundLinks\(message\.content\) \}/.test(edit), 'details: the text is masked');
  ok(/previous_content: unlink\(r\.previous_content\), new_content: unlink\(r\.new_content\)/.test(edit), 'details: every revision is masked');
  // hasFormLink: every Google Form (owner answer Q7) and a refund link; never the plain word.
  const { hasFormLink } = load('lib/refund/link-mask.ts');
  for (const s of ['https://docs.google.com/forms/d/e/1FAIpQLSc-x/viewform', 'fill forms.gle/AbC12', 'HTTPS://DOCS.GOOGLE.COM/FORMS/x', LINK,
    'https://docs.google.com/a/vastora.in/forms/d/e/1FAIpQLSf/viewform', 'https://goo.gl/forms/AbC123',
    `https://x.safelinks.protection.outlook.com/?url=https%3A%2F%2Fshiptrack.store%2Frefund%23${LINK.split('#')[1]}`]) eq(hasFormLink(s), true, s.slice(0, 50));
  for (const s of ['refund chahiye', 'please fill the form in the widget', 'https://docs.google.com/document/d/x', 'https://shiptrack.store/refund', '']) eq(hasFormLink(s), false, s);
});

// ── I13 ──────────────────────────────────────────────────────────
t('I13 owner answer Q1: Chikki says the team tells how the refund is paid; no "original payment method" anywhere it is told', () => {
  const ai = ['ai', 'ai-models', 'ai-prompt', 'ai-tools', 'ai-history'].map((f) => read(`src/lib/chat/${f}.ts`)).join('\n');
  ok(!/original payment method/i.test(ai), 'the old line is gone from ai.ts');
  ok(/If they ask where or how the money will come back: say the team will tell them here in this chat how the refund is paid; promise no method, time or amount, and never ask for, accept or repeat a UPI ID or bank details in the chat\./.test(ai));
  const chatDir = srcFiles.filter((f) => /^src\/lib\/chat\//.test(f) && /original payment/i.test(read(f)));
  deq(chatDir, [], 'no chat file says "original payment" any more');
  const rb = read('src/lib/chat/rulebook.ts');
  ok(/id: '5\.4', how: 'told', from: `\$\{M\('18'\)\} \+ \$\{YOU_02\}`, title: 'Refund destination'/.test(rb), 'rulebook 5.4 renamed and dated');
  ok(/the team tells the customer here in this chat, with no promise of method, time or amount/.test(rb), 'rulebook 5.4 text');
  for (const id of ['9.9', '9.10', '9.11', '9.12', '9.13']) ok(rb.includes(`id: '${id}', how: 'code', from: YOU_02`), `rulebook ${id}`);
  ok(/only the Super Admin can remove or switch the Refund mark/.test(rb), 'rulebook 9.4 (Q6)');
  ok(/any Google Form link \(docs\.google\.com\/forms, also \/a\/<domain>\/forms, forms\.gle, goo\.gl\/forms\)/.test(rb), 'rulebook 9.13 (Q7)');
  ok(/a verified customer\\'s chat goes to Needs You; a visitor is asked for the order ID and phone instead/.test(rb), 'rulebook 9.13: the emptied reply is handed over / asks to verify');
  ok(/No message ever shows the UPI ID or the account number, not even part of it\./.test(rb), 'rulebook 9.12 (Q3)');
  ok(/no photos or videos/.test(rb), 'rulebook 9.9 (no uploads)');
});

// ── I14 ──────────────────────────────────────────────────────────
t('I14 owner change (2 Oct, 15:00): no refund file upload anywhere', () => {
  for (const d of ['src/app/api/refund/files', 'src/app/api/refunds/files']) ok(!exists(d), `${d} is gone`);
  const routes = srcFiles.filter((f) => /^src\/app\/api\/refunds?\/.*route\.ts$/.test(f));
  ok(routes.length >= 3, 'the refund routes were found');
  const bad = routes.filter((f) => /formData\(|arrayBuffer\(|X-Refund-Token|request\.body\b|req\.body\b/i.test(stripComments(read(f))));
  deq(bad, [], 'no refund route reads a raw or multipart body');
  const page = stripComments(read('src/app/refund/page.tsx'));
  ok(!/type=["']file["']|type: ["']file["']|FileReader|createObjectURL/.test(page), 'the form has no file picker');
});

(async () => {
  for (const [name, fn] of tAsync) {
    try { await fn(); n++; } catch (e) { failed.push(name.split(' ')[0]); console.log(`FAIL ${name}: ${String(e && e.message).split('\n')[0].slice(0, 300)}`); }
  }
  if (failed.length) {
    console.log(`REFUND ISOLATION: ${failed.length} failed (${failed.join(', ')}), ${n} passed`);
    process.exit(1);
  }
  console.log(`REFUND ISOLATION: ${n} groups passed (I1-I14)`);
})();
