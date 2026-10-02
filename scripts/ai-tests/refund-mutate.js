// Refund form (owner, 2026-10-02): mutation checks (spec refund_form_spec.md 11.3). Run by hand, NOT in
// `npm run test:ai`:   node scripts/ai-tests/refund-mutate.js [--only M1,M7] [--strict]   (about a minute
// for slice A; MR1-MR8 run refund-route.js and take about 2 minutes more)
// The repo is copied ONCE into a temp folder (node_modules linked, never copied); for each mutation one
// file of that COPY is changed, the named suite runs there in a child process, and the file is put
// back. The repo itself is never written. The suite must FAIL, and at least one failing case must be
// one of those named for the mutation ("by"). Exit 1 if any mutation survives, is caught only by other
// cases, or its target text is not found exactly as expected (BROKEN: fix the anchor here).
// A mutation whose suite or target file does not exist yet (slices B and D build them) is PENDING: it
// is listed, and fails the run only with --strict. Run with --strict once every slice has landed.
//   M1-M25   spec 11.3 (M19-M22 live in slice D's files and are caught by refund-isolation.js; M17 / M18
//            went with files.ts: the owner dropped photo / video upload, 2026-10-02 ~15:00)
//   M26-M42  extra: owner answers 2026-10-02 (Q1, Q3, Q12), fail closed, the re-key script, the SQL
//   M43-M45, MR9-MR10  review fixes 2026-10-02: encoded / scheme-less link masks, the Workspace Google
//            Form URL, the chip's Retry email for a failed form email
//   MU1-MU6  owner change 2026-10-02 ~15:00, NO upload: a file body, route, column, grant or text coming back
//   MD1-MD3  owner 2026-10-02: the details text is optional (a minimum coming back in the rule or the SQL)
//   MR1-MR8  spec 11.3, slice B (refund-route.js); their anchors follow the spec's wording and are
//            checked when slice B lands (a missing anchor is BROKEN, not skipped)
// Output: ids, verdicts and case names only. The suites themselves never print secrets.
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const UNIT = 'refund-unit.js', ISO = 'refund-isolation.js', ROUTE = 'refund-route.js';
const R = 'src/lib/refund/';

const MUTATIONS = [
  // ── Spec 11.3 ──
  { id: 'M1', file: R + 'crypto.ts', what: 'crypto: setAAD removed', re: /\s*[cd]\.setAAD\([^;]*\);/g, to: '', suite: UNIT, by: ['U6'] },
  { id: 'M2', file: R + 'crypto.ts', what: 'crypto: IV = Buffer.alloc(12)', find: 'const iv = randomBytes(12);', all: true, to: 'const iv = Buffer.alloc(12);', suite: UNIT, by: ['U6'] },
  { id: 'M3', file: R + 'crypto.ts', what: 'crypto: OLD key ignored', find: '  const o = old();\n  if (o && o.id === id) return o;\n', to: '', suite: UNIT, by: ['U6'] },
  { id: 'M4', file: R + 'crypto.ts', what: 'crypto: ready for a 31-byte key', find: 'return b.length === 32 ? b : null;', to: 'return b.length === 32 || b.length === 31 ? b : null;', suite: UNIT, by: ['U6'] },
  { id: 'M5', file: R + 'crypto.ts', what: 'token: randomBytes(16)', find: "randomBytes(32).toString('base64url')", to: "randomBytes(16).toString('base64url')", suite: UNIT, by: ['U7'] },
  { id: 'M6', file: R + 'crypto.ts', what: 'TOKEN_RE {43} -> {42,43}', find: 'export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;', to: 'export const TOKEN_RE = /^[A-Za-z0-9_-]{42,43}$/;', suite: UNIT, by: ['U7'] },
  { id: 'M7', file: R + 'rules.ts', what: 'IFSC O -> 0 fix removed', find: "if (s.length === 11 && s[4] === 'O') { s = s.slice(0, 4) + '0' + s.slice(5); fixedO = true; }", to: '', suite: UNIT, by: ['U1'] },
  { id: 'M8', file: R + 'rules.ts', what: 'account_mismatch check removed', find: "return c === a ? ok(c) : no('account_mismatch');", to: 'return ok(c);', suite: UNIT, by: ['U1'] },
  { id: 'M9', file: R + 'rules.ts', what: 'UPI regex without @', find: 'export const UPI_RE = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/;', to: 'export const UPI_RE = /^[a-z0-9._-]{2,256}@?[a-z][a-z0-9.-]{1,63}$/;', suite: UNIT, by: ['U1'] },
  { id: 'M10', file: R + 'rules.ts', what: 'sub_reason optional for wrong_missing', find: '  if (!list.length) return ok(null);', to: "  if (!list.length || (reason === 'wrong_missing' && v == null)) return ok(null);", suite: UNIT, by: ['U1'] },
  { id: 'M11', file: R + 'rules.ts', what: 'MOVES: rejected -> refunded allowed', find: "refunded: { from: ['approved'],", to: "refunded: { from: ['approved', 'rejected'],", suite: UNIT, by: ['U5'] },
  { id: 'M12', file: R + 'texts.ts', what: 'texts: the rejected message includes the note',
    find: 'return tpl.replace(/\\{(order|link|utr|amount|date|where)\\}/g, (_m, k: string) => values[k]);',
    to: "return tpl.replace(/\\{(order|link|utr|amount|date|where)\\}/g, (_m, k: string) => values[k]) + (step === 'rejected' && (vars as any).note ? '\\n' + (vars as any).note : '');",
    suite: UNIT, by: ['U4'] },
  { id: 'M13', file: R + 'texts.ts', what: 'texts: the refunded message drops the amount', find: "'Amount: {amount} · Date: {date} · Kahan bheja: {where}'", to: "'Date: {date} · Kahan bheja: {where}'", suite: UNIT, by: ['U4'] },
  { id: 'M14', file: R + 'link-mask.ts', what: 'link mask {16,} -> {50,}', find: 'export const REFUND_LINK_RE = /[^\\s]*?(?:\\/|%2F)refund(?:#|%23)[A-Za-z0-9_-]{16,}/gi;',
    to: 'export const REFUND_LINK_RE = /[^\\s]*?(?:\\/|%2F)refund(?:#|%23)[A-Za-z0-9_-]{50,}/gi;', suite: UNIT, by: ['U3'] },
  { id: 'M43', file: R + 'link-mask.ts', what: 'link mask: only a literal https://…/refund# again (Safe Links / encoded copies kept)',
    find: 'export const REFUND_LINK_RE = /[^\\s]*?(?:\\/|%2F)refund(?:#|%23)[A-Za-z0-9_-]{16,}/gi;',
    to: 'export const REFUND_LINK_RE = /https?:\\/\\/[^\\s]*?\\/refund#[A-Za-z0-9_-]{16,}/g;', suite: UNIT, by: ['U3'] },
  { id: 'M44', file: R + 'link-mask.ts', what: 'FORM_LINK_RE without the Workspace form URL', find: 'docs\\.google\\.com\\/(?:a\\/[^\\/\\s]+\\/)?forms', to: 'docs\\.google\\.com\\/forms', suite: UNIT, by: ['U3'] },
  { id: 'M45', file: 'src/lib/chat/sensitive.ts', what: 'sensitive: encoded refund link not masked (old pattern)',
    find: 'const REFUND_LINK = /[^\\s]*?(?:\\/|%2F)refund(?:#|%23)[A-Za-z0-9_-]{16,}/gi;', to: 'const REFUND_LINK = /https?:\\/\\/[^\\s]*?\\/refund#[A-Za-z0-9_-]{16,}/g;', suite: ISO, by: ['I6'] },
  { id: 'M15', file: R + 'link-mask.ts', what: 'FORM_LINK_RE without forms.gle', find: '|forms\\.gle\\/|', to: '|', suite: UNIT, by: ['U3'] },
  { id: 'M16', file: R + 'link-mask.ts', what: 'dropFormMentions keeps link sentences', find: 'const mentionsForm = (s: string) => FORM_LINK_RE.test(s) || FORM_WORDS_RE.test(s);',
    to: 'const mentionsForm = (s: string) => FORM_WORDS_RE.test(s);', suite: UNIT, by: ['U3', 'A2'] },
  { id: 'M19', file: 'src/lib/chat/message-rules.ts', what: "canChangeMessage lets 'system' through", find: "if (m.sender === 'system') return false;", to: '', suite: ISO, by: ['I5'] },
  { id: 'M20', file: 'src/lib/chat/waiting-sql.ts', what: "waiting-sql: 'system' not excluded", find: "NOT IN ('tool_result', 'system')", all: true, to: "<> 'tool_result'", suite: ISO, by: ['I4'] },
  { id: 'M21', file: 'src/lib/chat/auto-close.ts', what: "auto-close: 'system' not excluded", find: "NOT IN ('tool_result', 'system')", all: true, to: "<> 'tool_result'", suite: ISO, by: ['I4'] },
  { id: 'M22', file: 'src/lib/chat/sensitive.ts', what: 'sensitive: refund link not masked', find: "base.replace(REFUND_LINK, '[refund form link]')", to: 'base', suite: ISO, by: ['I6'] },
  { id: 'M23', file: R + 'rules.ts', what: 'namesMatch keeps titles', find: '.filter((w) => w && !TITLES.has(w) && w.length >= 3);', to: '.filter((w) => w && w.length >= 3);', suite: UNIT, by: ['U8'] },
  { id: 'M24', file: R + 'rules.ts', what: 'maskUpi shows the whole local part', find: '`${L.slice(0, 2)}•••${L.slice(-2)}@${H}`', to: '`${L}@${H}`', suite: UNIT, by: ['U2'] },
  { id: 'M25', file: R + 'rules.ts', what: 'amount over total accepted', find: "    if (paise(amount) > paise(total)) return no('amount_over_total');\n", to: '', suite: UNIT, by: ['U5'] },
  // ── Extra: owner answers 2026-10-02, fail closed, re-key, SQL ──
  { id: 'M26', file: R + 'texts.ts', what: 'Q3: the "form received" message gets the destination + "agar ye aapka nahi" line back',
    find: "hinglish: 'Aapka refund form mil gaya hai. Team check karke isi chat me update degi.',",
    to: "hinglish: 'Aapka refund form mil gaya hai. Team check karke isi chat me update degi.\\nRefund ke liye aapne ye diya hai: {where}. Agar ye aapka nahi hai, to isi chat me turant batayein.',",
    suite: UNIT, by: ['U4'] },
  { id: 'M27', file: R + 'rules.ts', what: 'Q12: "shows delivered" no longer needs the checked-around tick',
    find: 'reason === NEEDS_CHECKED_AROUND.reason && sub === NEEDS_CHECKED_AROUND.sub;', to: 'false && reason === NEEDS_CHECKED_AROUND.reason && sub === NEEDS_CHECKED_AROUND.sub;', suite: UNIT, by: ['U1', 'U17'] },
  { id: 'M28', file: R + 'crypto.ts', what: 'J5: a missing key falls back to one derived from AUTH_TOKEN_SECRET',
    find: 'const current = (): Keyset | null => keysetFor(process.env.REFUND_DATA_KEY);',
    to: "const current = (): Keyset | null => keysetFor(process.env.REFUND_DATA_KEY) || keysetFor(createHash('sha256').update(String(process.env.AUTH_TOKEN_SECRET || '')).digest('hex'));",
    suite: UNIT, by: ['U6', 'U16'] },
  { id: 'M29', file: R + 'rules.ts', what: 'Q1: prepaid orders blocked again', find: 'export const PREPAID_PAYOUT_ALLOWED = true;', to: 'export const PREPAID_PAYOUT_ALLOWED = false;', suite: UNIT, by: ['U17'] },
  { id: 'M30', file: R + 'link-mask.ts', what: 'AI guard: an all-form reply becomes empty (no fallback line)',
    find: 'return { text: text || (hinglish ? FORM_FALLBACK.hinglish : FORM_FALLBACK.en), changed: true, emptied: !text };', to: 'return { text, changed: true, emptied: !text };', suite: UNIT, by: ['U3'] },
  { id: 'M31', file: R + 'rules.ts', what: 'details: control characters kept', find: "return str(v).replace(CTRL, '').replace(/\\n{3,}/g, '\\n\\n').trim();",
    to: "return str(v).replace(/\\n{3,}/g, '\\n\\n').trim();", suite: UNIT, by: ['U1'] },
  { id: 'M32', file: R + 'rules.ts', what: 'linkState: an expired link is still open', find: "  if (!(toMs(row.expires_at) > nowMs)) return 'expired';\n", to: '', suite: UNIT, by: ['U12'] },
  { id: 'M33', file: R + 'rules.ts', what: 'Q4: the status view never ends (90 days ignored)', find: 'nowMs - toMs(submittedAt) < STATUS_VIEW_DAYS * DAY_MS', to: 'true', suite: UNIT, by: ['U12'] },
  { id: 'M34', file: R + 'limits.ts', what: 'limits share the verify-form map', find: '__shiptrackRefundLimits', all: true, to: '__shiptrackLookupFailures', suite: UNIT, by: ['U13'] },
  { id: 'M35', file: R + 'limits.ts', what: 'limits: no 5,000-entry cap', find: '    if (counters.size > MAX_ENTRIES) prune(now);\n', to: '', suite: UNIT, by: ['U13'] },
  { id: 'M36', file: 'scripts/refund-rekey.js', what: 're-key: no set_config switch (the guards refuse every write)',
    find: "    await db.query(\"SELECT set_config('shiptrack.refund_rekey', 'on', true)\");\n", to: '', suite: UNIT, by: ['U18'] },
  { id: 'M37', file: 'scripts/refund-rekey.js', what: 're-key: phone_fp not recomputed with the new key',
    find: 'const pfp = await phoneFp(db, crypto, row.business_id, row.order_id);', to: 'const pfp = row.phone_fp ?? null;', suite: UNIT, by: ['U18'] },
  { id: 'M38', file: 'refund-forms.sql', what: 'SQL trigger: rejected -> refunded allowed',
    find: "OR (OLD.status = 'rejected' AND NEW.status = 'approved')) THEN", to: "OR (OLD.status = 'rejected' AND NEW.status IN ('approved', 'refunded'))) THEN", suite: UNIT, by: ['U5'] },
  { id: 'M39', file: 'refund-forms.sql', what: 'SQL: DELETE granted on refund_requests',
    find: 'GRANT SELECT, INSERT, UPDATE         ON refund_requests', to: 'GRANT SELECT, INSERT, UPDATE, DELETE ON refund_requests', suite: UNIT, by: ['U14'] },
  { id: 'M40', file: R + 'texts.ts', what: 'texts: a time promise in the rejected message',
    find: "'Aapki refund request abhi approve nahi ho payi. Team isi chat me aapse baat karegi.'", to: "'Aapki refund request abhi approve nahi ho payi. Team 24 ghante me isi chat me aapse baat karegi.'", suite: UNIT, by: ['U4'] },
  { id: 'M41', file: R + 'crypto.ts', what: 'tokenHash accepts any string', find: "if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;", to: "if (typeof token !== 'string') return null;", suite: UNIT, by: ['U7'] },
  { id: 'M42', file: R + 'crypto.ts', what: 'fingerprint without the kind (a UPI fp equals a bank fp of the same text)',
    find: '.update(`${kind}:${fpValue(kind, value)}`)', to: '.update(fpValue(kind, value))', suite: UNIT, by: ['U6'] },
  // ── Owner change 2026-10-02 ~15:00: NO photo / video upload (refund-unit.js U9 / U14, refund-route.js R8) ──
  { id: 'MU1', file: 'src/app/api/refund/submit/route.ts', what: 'submit takes a raw-bytes (octet-stream) body',
    find: "publicGuard(request, { kind: 'json', max: SUBMIT_MAX })", to: "publicGuard(request, { kind: 'octet', max: SUBMIT_MAX })", suite: UNIT, by: ['U9'] },
  { id: 'MU2', file: 'src/app/api/refund/submit/route.ts', what: 'submit takes a raw-bytes body (the real route refuses it)',
    find: "publicGuard(request, { kind: 'json', max: SUBMIT_MAX })", to: "publicGuard(request, { kind: request.headers.get('content-type') === 'application/octet-stream' ? 'octet' : 'json', max: SUBMIT_MAX })", suite: ROUTE, by: ['R8'] },
  { id: 'MU3', file: 'src/app/api/refund/open/route.ts', what: 'a PUT (upload) handler on a public refund route',
    find: 'export async function POST(request: NextRequest) {', to: 'export const PUT = (r: NextRequest) => POST(r);\nexport async function POST(request: NextRequest) {', suite: ROUTE, by: ['R8'] },
  { id: 'MU4', file: R + 'server-public.ts', what: 'open lists staged files from refund_files again',
    find: '    limits: { details_min: DETAILS_MIN, details_max: DETAILS_MAX },\n',
    to: "    limits: { details_min: DETAILS_MIN, details_max: DETAILS_MAX },\n    files: (await pool.query('SELECT id FROM refund_files WHERE link_id = $1', [row.id])).rows,\n", suite: ROUTE, by: ['R6', 'R8'] },
  { id: 'MU5', file: 'refund-forms.sql', what: 'SQL: the app may write refund_files again',
    find: 'GRANT SELECT                         ON refund_files ', to: 'GRANT SELECT, INSERT, UPDATE, DELETE ON refund_files ', suite: UNIT, by: ['U14'] },
  { id: 'MU6', file: R + 'texts.ts', what: 'the form message asks for photos / video again',
    find: "'Isme problem aur refund ke liye", to: "'Isme problem, photo / video (agar ho to) aur refund ke liye", suite: UNIT, by: ['U4', 'U9'] },
  // ── Owner 2026-10-02: the details text is OPTIONAL (integration step; rules.ts, refund-forms.sql) ──
  { id: 'MD1', file: R + 'rules.ts', what: 'details: a 10-letter minimum comes back',
    find: "  if (chars(s) > DETAILS_MAX) return no('details_long');\n  if (mask && s) {",
    to: "  if (chars(s) < 10) return no('details_short');\n  if (chars(s) > DETAILS_MAX) return no('details_long');\n  if (mask && s) {", suite: UNIT, by: ['U1'] },
  { id: 'MD2', file: R + 'rules.ts', what: 'details: an empty text is refused (the real routes)',
    find: "  if (chars(s) > DETAILS_MAX) return no('details_long');\n  if (mask && s) {",
    to: "  if (!s) return no('details_long');\n  if (chars(s) > DETAILS_MAX) return no('details_long');\n  if (mask && s) {", suite: ROUTE, by: ['R9'] },
  { id: 'MD3', file: 'refund-forms.sql', what: 'SQL: details need 10 characters again',
    find: 'CHECK (char_length(details) BETWEEN 0 AND 1000)', to: 'CHECK (char_length(details) BETWEEN 10 AND 1000)', suite: UNIT, by: ['U14'] },
  // ── Spec 11.3, slice B (refund-route.js). Anchors from the spec's wording; confirm when slice B lands. ──
  { id: 'MR1', file: 'src/app/api/refunds/[id]/route.ts', what: 'isSuperAdmin check removed in /api/refunds/[id]', re: /!isSuperAdmin\((\w+)\)/g, to: 'false', suite: ROUTE, by: ['R1'] },
  { id: 'MR2', file: R + 'server-admin.ts', what: 'AND status = $expect removed (status compare-and-set)', re: /(WHERE id = \$1) AND status = \$(\d+)/g, to: '$1 AND $$$2::text IS NOT NULL', suite: ROUTE, by: ['R11'] },
  { id: 'MR3', file: R + 'server-shared.ts', what: 'expiry check removed (submit)', re: /linkState\(([^,()]+),\s*([^)]+)\)/g, to: "linkState({ ...$1, expires_at: '9999-12-31T00:00:00Z' }, $2)", suite: ROUTE, by: ['R6', 'R9'] },
  { id: 'MR4', file: 'src/app/api/refund/submit/route.ts', what: 'console.error(err) in submit', re: /catch \((\w+)(?::\s*\w+)?\) \{/, to: 'catch ($1) { console.error($1);', suite: ROUTE, by: ['R13'] },
  { id: 'MR5', file: R + 'public.ts', what: 'sameOrigin removed', re: /function sameOrigin\(([^)]*)\)([^{]*)\{/, to: 'function sameOrigin($1)$2{ return true;', suite: ROUTE, by: ['R7'] },
  { id: 'MR6', file: R + 'server-public.ts', what: 'the "form received" message without a retry path (one try)', find: 'const ACK_ATTEMPTS = 2;', to: 'const ACK_ATTEMPTS = 1;', suite: ROUTE, by: ['R10'] },
  { id: 'MR7', file: R + 'server-public.ts', what: 'payout inserted in clear in place of payout_enc', re: /sealJson\(([^,()]+),/, to: "({ blob: JSON.stringify($1), keyId: '00000000' }) || sealJson($1,", suite: ROUTE, by: ['R9'] },
  { id: 'MR9', file: R + 'server-send.ts', what: 'a failed form email never shows on the chip (no Retry email)', find: "return r.rows[0]?.kind === 'email_failed';", to: 'return false;', suite: ROUTE, by: ['R5'] },
  { id: 'MR10', file: R + 'server-send.ts', what: 'Retry email re-sends an expired link', find: "if (!link || stateOf(link, Date.now()) !== 'open') {", to: 'if (!link) {', suite: ROUTE, by: ['R5'] },
  { id: 'MR8', file: 'src/app/api/chat/conversations/[id]/route.ts', what: 'thread GET returns refund_form to staff',
    find: "isSuperAdmin(user) && conversation.case_kind === 'refund' ? { refund_form:", to: "conversation.case_kind === 'refund' ? { refund_form:", suite: ROUTE, by: ['R14'] },
];

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const onlyArg = args[args.indexOf('--only') + 1];
const only = args.includes('--only') && onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null;
const list = only ? MUTATIONS.filter((m) => only.has(m.id)) : MUTATIONS;

// One copy of the repo (without node_modules / .next / .git); node_modules is linked.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-mutate-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
const mirror = path.join(tmp, 'repo');
const SKIP = new Set(['node_modules', '.next', '.git', 'tsconfig.tsbuildinfo']);
fs.cpSync(ROOT, mirror, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) || path.dirname(src) !== ROOT });
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(mirror, 'node_modules'), 'dir');

const env = { ...process.env };
for (const k of ['REFUND_DATA_KEY', 'REFUND_DATA_KEY_OLD', 'REFUND_FORMS', 'DATABASE_URL']) delete env[k];
function runSuite(suite) {
  const r = spawnSync(process.execPath, [path.join(mirror, 'scripts/ai-tests', suite)], { cwd: mirror, env, encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const fails = [...out.matchAll(/^FAIL (\S+?):?(?:\s|$)/gm)].map((m) => m[1]);
  return { fails, crashed: r.status !== 0 && !fails.length, status: r.status };
}
const exists = (rel) => fs.existsSync(path.join(mirror, rel));

// Sanity: every suite that exists passes on the real code.
const suites = [...new Set(list.map((m) => m.suite))];
const present = new Set();
for (const s of suites) {
  if (!exists(`scripts/ai-tests/${s}`)) continue;
  const b = runSuite(s);
  if (b.fails.length || b.crashed) {
    console.log(`BASELINE FAILS in ${s} (${b.fails.join(', ') || 'crash'}): fix the suite first`);
    process.exit(1);
  }
  present.add(s);
}
console.log(`baseline: ${[...present].join(', ') || 'no suite'} pass on the real code${suites.some((s) => !present.has(s)) ? `; not built yet: ${suites.filter((s) => !present.has(s)).join(', ')}` : ''}`);

const hits = (fails, by) => fails.filter((f) => by.some((b) => f === b || (f.startsWith(b) && !/\d/.test(f[b.length]))));
let bad = 0, pending = 0;
for (const mut of list) {
  const label = `${mut.id.padEnd(4)}`;
  if (!present.has(mut.suite) || !exists(mut.file)) {
    pending++;
    console.log(`${label} PENDING   ${mut.what}  [${!exists(mut.file) ? `${mut.file} not built yet` : `${mut.suite} not built yet`}]`);
    continue;
  }
  const abs = path.join(mirror, mut.file);
  const orig = fs.readFileSync(abs, 'utf8');
  let next = null, why = '';
  if (mut.find !== undefined) {
    const count = orig.split(mut.find).length - 1;
    if (count === 0 || (count > 1 && !mut.all)) why = `target text found ${count} times in ${mut.file}`;
    else next = mut.all ? orig.split(mut.find).join(mut.to) : orig.replace(mut.find, () => mut.to);
  } else if (mut.re) {
    const count = (orig.match(new RegExp(mut.re.source, 'g')) || []).length;
    if (!count) why = `pattern not found in ${mut.file}`;
    else next = orig.replace(mut.re, mut.to);
  } else why = `no anchor yet (${mut.note || 'set it here'})`;
  if (next === null || next === orig) { bad++; console.log(`${label} BROKEN    ${mut.what}: ${why || 'no change'}`); continue; }
  fs.writeFileSync(abs, next);
  let res;
  try { res = runSuite(mut.suite); } finally { fs.writeFileSync(abs, orig); }
  const hit = [...new Set(hits(res.fails, mut.by))];
  let verdict;
  if (hit.length) verdict = 'caught   ';
  else if (res.fails.length || res.crashed) { verdict = 'ELSEWHERE'; bad++; }
  else { verdict = 'SURVIVED '; bad++; }
  const by = hit.length ? hit.join(', ') : res.fails.slice(0, 4).join(', ') || (res.crashed ? 'suite crashed' : '-');
  console.log(`${label} ${verdict} ${mut.what}  [by ${by}${res.fails.length > hit.length ? `; ${res.fails.length} failing in all` : ''}]`);
}
const done = list.length - pending;
console.log(bad
  ? `REFUND MUTATE: ${bad} of ${done} not caught as required${pending ? `, ${pending} pending` : ''}`
  : `REFUND MUTATE: all ${done} mutations caught${pending ? `; ${pending} pending until slices B / D land` : ''}`);
process.exit(bad || (strict && pending) ? 1 : 0);
