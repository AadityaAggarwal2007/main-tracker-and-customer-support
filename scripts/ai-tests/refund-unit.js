// Refund form (owner, 2026-10-02), slice A: the pure modules, the crypto, the SQL files and the
// re-key script. No database, no routes, no network. Spec refund_form_spec.md 11.1 (U1-U11), plus:
//   U1  validators (UPI, account, IFSC, holder, details, reason x sub-reason, checked_around Q12, submit)
//   U2  masks          U3  refund-link mask, FORM_LINK_RE (Q7: every Google Form), dropFormMentions
//   U4  chat texts byte for byte (Q2 / Q3 applied: no destination number, no "agar ye aapka nahi"),
//       no time promise, page texts in English + Devanagari (Q8)
//   U5  status moves = the SQL trigger; admin validators (UTR, amount, date, note, prepaid tick)
//   U6  crypto (AES-256-GCM, AAD, rotation, fail closed, fingerprints, file parts: refund-rekey.js only)
//   U7  link tokens    U8  namesMatch    U9  no photo / video upload (owner change 2026-10-02 ~15:00)
//   U10 device, ref code, COD
//   U11 computeFlags   U12 link state + status view (Q4: 90 days)  U13 rate limits (own map)
//   U14 refund-forms.sql: additive, guarded, granted, CHECKs = the code's constants
//   U15 scripts/refund-sql-trial.sql   U16 slice-A isolation + .env.example   U17 owner answers
//   U18 scripts/refund-rekey.js on a fake database
// Nothing here prints a token, a key, a UPI ID, an account or a phone: a failing check prints its
// name and a message with long digit runs and anything@handle blanked. Every value is made up.
// refund-mutate.js (run by hand) runs this file on mutated copies of the code.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), nodeCrypto = require('crypto');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');
const MODULES = ['rules', 'texts', 'link-mask', 'crypto', 'limits'];   // files.ts is gone: no upload (owner change)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-unit-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
for (const name of MODULES) {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/refund', `${name}.ts`), 'utf8');
  fs.writeFileSync(path.join(dir, `${name}.js`), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText);
}
const load = (name) => require(path.join(dir, `${name}.js`));
const rules = load('rules'), texts = load('texts'), lm = load('link-mask'), rc = load('crypto'), limits = load('limits');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

for (const k of ['REFUND_DATA_KEY', 'REFUND_DATA_KEY_OLD', 'REFUND_FORMS']) delete process.env[k];
const K1 = nodeCrypto.randomBytes(32).toString('base64');
const K2 = nodeCrypto.randomBytes(32).toString('hex');
const setKeys = (cur, old, forms) => {
  for (const [k, v] of [['REFUND_DATA_KEY', cur], ['REFUND_DATA_KEY_OLD', old], ['REFUND_FORMS', forms]]) {
    if (v === undefined || v === null) delete process.env[k]; else process.env[k] = v;
  }
};

let n = 0;
const failed = [];
const clean = (s) => String(s).replace(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+/g, '[x@y]').replace(/[A-Za-z0-9_-]{40,}/g, '[long]').replace(/\d{5,}/g, '[digits]');
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { failed.push(name.split(' ')[0]); console.log(`FAIL ${name}: ${clean(String(e && e.message).split('\n')[0]).slice(0, 300)}`); }
};
const tAsync = [];
const ta = (name, fn) => tAsync.push([name, fn]);
const eq = (a, b, msg) => assert.strictEqual(a, b, msg);
const deq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);
const code = (r) => (r.ok ? 'ok' : r.code);
const throwsCode = (fn, c, msg) => {
  let got = 'no error';
  try { fn(); } catch (e) { got = e && e.code ? e.code : 'other'; }
  eq(got, c, msg);
};
const sqlLines = (rel) => read(rel).split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const sqlList = (s) => s.split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
const TOKEN = 'Ab3_dE9-'.repeat(5) + 'xyz';   // 43 characters, made up
const LINK = `https://shiptrack.store/refund#${TOKEN}`;
const NONCE = '3f0c2a4e-8b1d-4c3a-9e2f-1a2b3c4d5e6f';
const UUID = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

// ── U1. validators ─────────────────────────────────────────────
t('U1 UPI: accepted, normalised, refused', () => {
  eq(rules.checkUpi('rahul.s@okaxis').value, 'rahul.s@okaxis', 'plain');
  eq(rules.checkUpi('9876543210@ybl').value, '9876543210@ybl', 'digits');
  eq(rules.checkUpi(' Rahul@OKAXIS ').value, 'rahul@okaxis', 'trim + lower');
  for (const [i, v] of ['rahul', 'rahul@', '@ybl', 'ra hul@ybl', 'rahul@1bl', 'r@ybl', '', null, 42, 'a@b'].entries()) {
    eq(code(rules.checkUpi(v)), 'upi_format', `case ${i}`);
  }
});
t('U1 account: 9-18 digits, not one repeated digit; the confirm must match', () => {
  eq(code(rules.checkAccount('12345678')), 'account_format', '8 digits');
  eq(code(rules.checkAccount('123456789')), 'ok', '9 digits');
  eq(code(rules.checkAccount('123456789012345678')), 'ok', '18 digits');
  eq(code(rules.checkAccount('1234567890123456789')), 'account_format', '19 digits');
  eq(code(rules.checkAccount('000000000')), 'account_format', 'zeros');
  eq(code(rules.checkAccount('1111 1111 1111')), 'account_format', 'one digit repeated');
  eq(rules.checkAccount('1234-5678 9012').value, '123456789012', 'spaces and dashes removed');
  eq(code(rules.checkAccount('12345678901a')), 'account_format', 'a letter');
  eq(code(rules.checkAccountConfirm('123456789012', '1234 5678 9012')), 'ok', 'same after normalising');
  eq(code(rules.checkAccountConfirm('123456789012', '123456789013')), 'account_mismatch', 'differs');
  eq(code(rules.checkAccountConfirm('123456789012', '')), 'account_mismatch', 'empty confirm');
});
t('U1 IFSC: upper-cased, O in 5th place becomes 0 (with a note), else refused', () => {
  deq(rules.checkIfsc('hdfc0001234'), { ok: true, value: 'HDFC0001234' });
  deq(rules.checkIfsc('HDFCO001234'), { ok: true, value: 'HDFC0001234', warn: 'ifsc_o_fixed' });
  eq(rules.checkIfsc(' sbin 0001234 ').value, 'SBIN0001234', 'spaces');
  eq(code(rules.checkIfsc('HDFC1001234')), 'ifsc_format', '5th is 1');
  eq(code(rules.checkIfsc('HDFC000123')), 'ifsc_format', '10 characters');
  eq(code(rules.checkIfsc('HDF00001234')), 'ifsc_format', '3 letters');
  eq(code(rules.checkIfsc('')), 'ifsc_format', 'empty');
});
t('U1 holder: Latin letters, upper case; Devanagari refused', () => {
  eq(code(rules.checkHolder('राहुल शर्मा')), 'holder_format', 'Devanagari');
  eq(rules.checkHolder('MD. AKRAM').value, 'MD. AKRAM');
  eq(rules.checkHolder("D'SOUZA").value, "D'SOUZA");
  eq(rules.checkHolder('D’souza').value, "D'SOUZA", 'curly apostrophe');
  eq(rules.checkHolder('  test   user ').value, 'TEST USER', 'spaces collapsed');
  eq(code(rules.checkHolder('A')), 'holder_format', 'one letter');
  eq(code(rules.checkHolder('1TEST')), 'holder_format', 'starts with a digit');
  eq(code(rules.checkHolder('A'.repeat(81))), 'holder_format', '81 characters');
  eq(code(rules.checkHolder('')), 'holder_format', 'empty');
});
t('U1 details: OPTIONAL (owner 2026-10-02), at most 1000 characters after cleaning; control characters removed', () => {
  eq(rules.DETAILS_MIN, 0, 'no minimum: the details text is optional');
  deq(rules.checkDetails(''), { ok: true, value: '' }, 'empty is accepted');
  deq(rules.checkDetails(undefined), { ok: true, value: '' }, 'missing is accepted');
  deq(rules.checkDetails(null), { ok: true, value: '' }, 'null is accepted');
  deq(rules.checkDetails(' \n\t \u0007 '), { ok: true, value: '' }, 'only spaces / control characters become empty');
  eq(code(rules.checkDetails('a')), 'ok', 'one letter');
  eq(code(rules.checkDetails('a'.repeat(9))), 'ok');
  eq(code(rules.checkDetails('a'.repeat(10))), 'ok');
  eq(code(rules.checkDetails('a'.repeat(1000))), 'ok');
  eq(code(rules.checkDetails('a'.repeat(1001))), 'details_long');
  eq(rules.checkDetails('   a b c d   ').value, 'a b c d', 'trimmed first');
  let masked = 0;
  eq(rules.checkDetails('', () => { masked++; return 'x'; }).value, '', 'an empty text is not passed to the mask');
  eq(masked, 0);
  eq(rules.checkDetails('Torn\u0000 sleeve\u0007 x\u001F!').value, 'Torn sleeve x!', 'control characters');
  eq(rules.checkDetails('Line one\n\n\n\nLine two').value, 'Line one\n\nLine two', '3+ newlines become 2');
  eq(rules.checkDetails('Tab\tkept here').value, 'Tab\tkept here', 'a tab stays');
  eq(code(rules.checkDetails('😀'.repeat(10))), 'ok', 'counted like char_length');
  eq(code(rules.checkDetails('😀'.repeat(1001))), 'details_long', 'code points');
  const mask = (s) => s.replace(/\d{12,19}/g, '[card number removed]');
  eq(rules.checkDetails('My card 4111111111111111 was charged', mask).value, 'My card [card number removed] was charged', 'masked by the server');
  eq(code(rules.checkDetails('a'.repeat(980) + ' 4111111111111111', mask)), 'details_long', 'checked again after the mask');
});
t('U1 reason x sub-reason matrix; damaged has none', () => {
  const allSubs = Object.values(rules.SUB_REASONS).flat();
  deq(rules.REASONS, ['damaged', 'wrong_missing', 'not_received', 'quality']);
  for (const reason of rules.REASONS) {
    for (const sub of [null, undefined, '', 'x', ...allSubs]) {
      const r = rules.checkSubReason(reason, sub);
      if (reason === 'damaged') { eq(r.ok && r.value, null, `damaged ${sub}`); continue; }
      eq(r.ok, rules.SUB_REASONS[reason].includes(sub), `${reason} ${sub}`);
      if (!r.ok) eq(r.code, 'sub_reason_required');
    }
  }
  eq(code(rules.checkReason('other')), 'reason_required');
  eq(code(rules.checkReason(undefined)), 'reason_required');
  deq(rules.SUB_REASONS.quality, ['poor_quality', 'not_as_shown', 'did_not_like'], 'Q13');
});
t('U1 checked_around (Q12): required only for not_received + shows_delivered, else forced false', () => {
  deq(rules.checkCheckedAround('not_received', 'shows_delivered', true), { ok: true, value: true });
  eq(code(rules.checkCheckedAround('not_received', 'shows_delivered', false)), 'checked_around_required');
  eq(code(rules.checkCheckedAround('not_received', 'shows_delivered', 'true')), 'checked_around_required', 'a string is not a tick');
  eq(code(rules.checkCheckedAround('not_received', 'shows_delivered', undefined)), 'checked_around_required');
  deq(rules.checkCheckedAround('not_received', 'never_came', true), { ok: true, value: false });
  deq(rules.checkCheckedAround('damaged', null, true), { ok: true, value: false });
  deq(rules.checkCheckedAround('wrong_missing', 'wrong_size', true), { ok: true, value: false });
});
const upiBody = (over = {}) => ({
  token: TOKEN, client_nonce: NONCE, reason: 'wrong_missing', sub_reason: 'wrong_size', checked_around: false,
  details: 'I ordered size M but got L.', method: 'upi', upi: ' Test.User@OKAXIS ', holder: 'test user',
  account: null, account_confirm: null, ifsc: null, consent: true, ...over,
});
t('U1 validateSubmit: a good UPI form; other keys (order, name, phone, an old page\'s file_ids) ignored', () => {
  const r = rules.validateSubmit(upiBody({ order_id: '#9999', name: 'Someone Else', phone: '9000000000', total: 1, file_ids: ['nope', 42] }));
  ok(r.ok, JSON.stringify(r.errors || {}));
  deq(r.value.payout, { v: 1, method: 'upi', upi: 'test.user@okaxis', holder: 'TEST USER' });
  eq(r.value.payout_mask, 'te•••er@okaxis');
  eq(r.value.client_nonce, NONCE);
  for (const k of ['order_id', 'name', 'phone', 'total', 'token', 'upi', 'holder', 'file_ids']) ok(!(k in r.value), `${k} not in the value`);
  eq(r.value.checked_around, false);
  eq(r.value.sub_reason, 'wrong_size');
});
t('U1 validateSubmit: a good bank form; the O-to-0 note travels', () => {
  const r = rules.validateSubmit(upiBody({ method: 'bank', upi: null, holder: 'Test User', account: '1234 5678 9012', account_confirm: '123456789012', ifsc: 'hdfcO001234' }));
  ok(r.ok, JSON.stringify(r.errors || {}));
  deq(r.value.payout, { v: 1, method: 'bank', account: '123456789012', ifsc: 'HDFC0001234', holder: 'TEST USER' });
  eq(r.value.payout_mask, 'HDFC ••••9012');
  eq(r.value.ifsc_fixed, true);
});
t('U1 validateSubmit: every field error at once', () => {
  const e = rules.validateSubmit({}).errors;
  deq(Object.keys(e).sort(), ['client_nonce', 'consent', 'method', 'reason'], 'details is optional (owner 2026-10-02)');
  const empty = rules.validateSubmit(upiBody({ details: '' }));
  ok(empty.ok, JSON.stringify(empty.errors || {}));
  eq(empty.value.details, '', 'an empty details text is stored as an empty string');
  ok(rules.validateSubmit(upiBody({ details: undefined })).ok, 'no details key at all');
  eq(rules.validateSubmit(upiBody({ details: 'a'.repeat(1001) })).errors.details, 'details_long');
  eq(e.client_nonce, 'bad_request');
  const b = rules.validateSubmit(upiBody({ method: 'bank', holder: 'राहुल', account: '12345', account_confirm: '12345', ifsc: 'X', consent: 'true', file_ids: ['nope'] })).errors;
  deq(b, { holder: 'holder_format', account: 'account_format', ifsc: 'ifsc_format', consent: 'consent_required' }, 'file_ids is not a field any more');
  eq(rules.validateSubmit(upiBody({ method: 'bank', upi: null, account: '123456789012', account_confirm: '123456789011', ifsc: 'HDFC0001234' })).errors.account_confirm, 'account_mismatch');
  eq(rules.validateSubmit(upiBody({ reason: 'not_received', sub_reason: 'shows_delivered' })).errors.checked_around, 'checked_around_required', 'Q12');
  ok(rules.validateSubmit(upiBody({ reason: 'not_received', sub_reason: 'shows_delivered', checked_around: true })).ok, 'Q12 ticked');
  eq(rules.validateSubmit(upiBody({ reason: 'wrong_missing', sub_reason: null })).errors.sub_reason, 'sub_reason_required');
  eq(rules.validateSubmit(upiBody({ method: 'cash' })).errors.method, 'method_required');
  eq(rules.validateSubmit(upiBody({ client_nonce: '3f0c2a4e-8b1d-1c3a-9e2f-1a2b3c4d5e6f' })).errors.client_nonce, 'bad_request', 'not v4');
  eq(rules.validateSubmit(null).ok, false);
});
t('U1 consent: only a real tick', () => {
  eq(code(rules.checkConsent(true)), 'ok');
  eq(code(rules.checkConsent('true')), 'consent_required');
  eq(code(rules.checkConsent(1)), 'consent_required');
});

// ── U2. masks ──────────────────────────────────────────────────
t('U2 maskUpi (2-, 4-, 7- and 10-character local parts), maskBank, last4FromMask', () => {
  eq(rules.maskUpi('ab@ybl'), 'a•••@ybl');
  eq(rules.maskUpi('abcd@ybl'), 'a•••@ybl');
  eq(rules.maskUpi('rahul.s@okaxis'), 'ra•••.s@okaxis');
  eq(rules.maskUpi('9876543210@ybl'), '98•••10@ybl');
  ok(rules.maskUpi('x'.repeat(256) + '@' + 'h'.repeat(63)).length <= 60, 'fits the column');
  eq(rules.maskBank('123456784321', 'HDFC0001234'), 'HDFC ••••4321');
  eq(rules.last4FromMask('HDFC ••••4321'), '4321');
  eq(rules.payoutMask({ v: 1, method: 'upi', upi: 'test.user@okaxis', holder: 'X' }), 'te•••er@okaxis');
  eq(rules.payoutMask({ v: 1, method: 'bank', account: '123456789012', ifsc: 'SBIN0001234', holder: 'X' }), 'SBIN ••••9012');
  for (const m of [rules.maskUpi('ab@cd'), rules.maskUpi('a'.repeat(300) + '@ybl'), rules.maskBank('123456789', 'SBIN0001234')]) {
    ok(Array.from(m).length >= 4 && Array.from(m).length <= 60, 'refund_requests.payout_mask CHECK');
  }
  ok(!rules.maskUpi('secretname@ybl').includes('secretname'), 'the local part is hidden');
  deq(rules.payoutFpInput({ v: 1, method: 'bank', account: '123456789012', ifsc: 'SBIN0001234', holder: 'X' }), { kind: 'bank', value: 'SBIN0001234:123456789012' });
});

// ── U3. link mask, form links, AI guard ───────────────────────
t('U3 maskRefundLinks: http / https, a full stop stays outside, two links, short #x untouched', () => {
  eq(lm.maskRefundLinks(`Open ${LINK}.`), 'Open [refund form link].');
  eq(lm.maskRefundLinks(`Open ${LINK.replace('https', 'http')} now`), 'Open [refund form link] now');
  eq(lm.maskRefundLinks(`${LINK} and ${LINK}\nbye`), '[refund form link] and [refund form link]\nbye');
  eq(lm.maskRefundLinks(`${LINK}\nnext line`), '[refund form link]\nnext line');
  eq(lm.maskRefundLinks('https://x.com/refund#abc'), 'https://x.com/refund#abc', 'short');
  eq(lm.maskRefundLinks('https://shiptrack.store/refund'), 'https://shiptrack.store/refund', 'no token');
  eq(lm.maskRefundLinks(''), '');
  eq(lm.REFUND_LINK_MASK, '[refund form link]');
  ok(!lm.maskRefundLinks(texts.chatMessage('form', 'hinglish', { order: '#1234', link: LINK })).includes(TOKEN), 'the form message masks fully');
});
// Review fix 2026-10-02: the token is matched, not the URL's shape. A mail gateway (Outlook Safe Links)
// percent-encodes the link it rewrites; a customer pastes that back, or a link without its scheme.
const SAFE_LINKS = `https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fshiptrack.store%2Frefund%23${TOKEN}&data=05%7C02%7C&reserved=0`;
const ENCODED_SAMPLES = [
  [`link nahi khul raha: ${SAFE_LINKS}`, 'link nahi khul raha: [refund form link]&data=05%7C02%7C&reserved=0', 'Safe Links (%2F, %23)'],
  [`see https%3a%2f%2fshiptrack.store%2frefund%23${TOKEN} ok`, 'see [refund form link] ok', 'lowercase %2f / %23'],
  [`shiptrack.store/refund#${TOKEN}`, '[refund form link]', 'no scheme'],
  [`Open HTTPS://SHIPTRACK.STORE/REFUND#${TOKEN}.`, 'Open [refund form link].', 'upper case'],
  [`https://shiptrack.store/refund%23${TOKEN}`, '[refund form link]', 'only the # encoded'],
];
t('U3 maskRefundLinks: Safe Links / percent-encoded, scheme-less and upper-case copies lose the token (review fix)', () => {
  for (const [s, want, name] of ENCODED_SAMPLES) {
    eq(lm.maskRefundLinks(s), want, name);
    ok(!lm.maskRefundLinks(s).includes(TOKEN), `${name}: token gone`);
  }
  // Still untouched: no token, a short one, the plain word.
  for (const s of ['https://shiptrack.store/refund', 'https://shiptrack.store/refund#short', 'shiptrack.store%2Frefund%23abc', 'refund chahiye']) eq(lm.maskRefundLinks(s), s, s);
});
t('U3 REFUND_LINK_SQL behaves like REFUND_LINK_RE (JS translation, 11 samples, flags gi) and is safe to interpolate', () => {
  ok(!/['\\$`]/.test(lm.REFUND_LINK_SQL), 'no quote, backslash, $ or backtick');
  eq(lm.REFUND_LINK_RE.flags, 'gi', 'the JS pattern ignores case (the SQL call passes gi)');
  const js = new RegExp(lm.REFUND_LINK_SQL.replace('[^[:space:]]', '[^\\s]'), 'gi');
  const samples = [
    `see ${LINK}`, `see ${LINK.replace('https', 'http')}.`, `${LINK}\nIsme problem`, `a ${LINK} b ${LINK}`,
    'https://x.com/refund#abc', `https://sub.shiptrack.store/a/b/refund#${TOKEN.slice(0, 20)} done`,
    ...ENCODED_SAMPLES.map((x) => x[0]),
  ];
  for (const [i, s] of samples.entries()) eq(s.replace(js, '[refund form link]'), lm.maskRefundLinks(s), `sample ${i}`);
});
t('U3 FORM_LINK_RE / hasFormLink: every Google Form (Q7) and refund links, not the word "refund"', () => {
  ok(lm.hasFormLink('fill https://docs.google.com/forms/d/e/1FAIpQLSc-made-up/viewform please'), 'docs.google.com/forms');
  ok(lm.hasFormLink('https://forms.gle/AbC123'), 'forms.gle');
  ok(lm.hasFormLink('FORMS.GLE/AbC'), 'any case');
  ok(lm.hasFormLink(`/refund#${TOKEN}`), 'refund link');
  ok(lm.hasFormLink(texts.chatMessage('form', 'en', { order: '#1', link: LINK })), 'the system message itself');
  ok(!lm.hasFormLink('refund'), 'the word');
  ok(!lm.hasFormLink('Please refund my order, I filled the verify form'), 'words only');
  ok(!lm.hasFormLink('https://shiptrack.store/refund'), 'no token');
  ok(!lm.hasFormLink('https://docs.google.com/document/d/x'), 'a Google Doc is not a form');
  ok(!lm.hasFormLink(null) && !lm.hasFormLink(''), 'empty');
  // Review fixes 2026-10-02: the Workspace form URL and the old goo.gl/forms short link (Q7: every
  // Google Form), and a percent-encoded or scheme-less refund link.
  ok(lm.hasFormLink('Fill https://docs.google.com/a/vastora.in/forms/d/e/1FAIpQLSf/viewform'), 'Workspace form URL');
  ok(lm.hasFormLink('https://goo.gl/forms/AbC123'), 'goo.gl/forms');
  ok(lm.hasFormLink(SAFE_LINKS) && lm.hasFormLink(`shiptrack.store/refund#${TOKEN}`), 'encoded / scheme-less refund link');
  ok(!lm.hasFormLink('https://docs.google.com/a/vastora.in/document/d/x') && !lm.hasFormLink('https://goo.gl/maps/AbC'), 'other Google links stay allowed');
});
t('U3 dropFormMentions: link sentences and form mentions go; the rest stays; fallback per language; emptied says so', () => {
  deq(lm.dropFormMentions('Your order is on the way. Fill this: https://forms.gle/AbC123', false), { text: 'Your order is on the way.', changed: true, emptied: false });
  deq(lm.dropFormMentions('Aapko refund form bhej denge.', true), { text: 'Iske liye hamari team isi chat me aapse baat karegi.', changed: true, emptied: true });
  deq(lm.dropFormMentions('Aapko refund form bhej denge.', false), { text: 'Our team will help you with this here in this chat.', changed: true, emptied: true });
  deq(lm.dropFormMentions('Aapko refund form bhej denge. Aapka order deliver ho gaya hai.', true), { text: 'Aapka order deliver ho gaya hai.', changed: true, emptied: false });
  deq(lm.dropFormMentions('Please use the Verify form to continue.', false), { text: 'Please use the Verify form to continue.', changed: false, emptied: false });
  deq(lm.dropFormMentions('Your order was delivered.', false), { text: 'Your order was delivered.', changed: false, emptied: false });
  // Review fix: a Workspace Google Form link sentence goes too (Q7).
  deq(lm.dropFormMentions('Order shipped hai. Ye bhariye: https://docs.google.com/a/vastora.in/forms/d/e/x/viewform', true), { text: 'Order shipped hai.', changed: true, emptied: false });
  eq(lm.dropFormMentions('Return form ke liye pehle apna Order ID aur order wala phone number bhejiye.', true).emptied, true, 'an all-form reply is emptied');
  // The visitor's ask (ai.ts sends it in place of the team line): no form, no team promise, asks for both.
  for (const l of ['en', 'hinglish']) {
    const ask = lm.FORM_VERIFY_ASK[l];
    eq(lm.dropFormMentions(ask, l === 'hinglish').changed, false, `${l}: the ask is not itself a form mention`);
    ok(/order id/i.test(ask) && /phone/i.test(ask), `${l}: asks for the order ID and the phone`);
    ok(!/team|baat karegi|will (help|reply)/i.test(ask), `${l}: no team promise`);
  }
  eq(lm.dropFormMentions('Please fill https://docs.google.com/forms/d/e/x/viewform and we will check.', false).text, 'Our team will help you with this here in this chat.');
  eq(lm.dropFormMentions(`Hi!\n\nUse this link: ${LINK}\n\nThanks for waiting.`, false).text, 'Hi!\n\nThanks for waiting.');
  eq(lm.dropFormMentions('आपका ऑर्डर आ गया है। refund form भरें।', true).text, 'आपका ऑर्डर आ गया है।');
  eq(lm.dropFormMentions('Fill the return form please. Size M is in stock.', false).text, 'Size M is in stock.');
  eq(lm.dropFormMentions('Google Form me details bhejiye. Order shipped hai.', true).text, 'Order shipped hai.');
  const same = 'Line one.\n\n\n\nLine two.';
  eq(lm.dropFormMentions(same, false).text, same, 'unchanged text is returned byte for byte');
  deq(lm.FORM_FALLBACK, { hinglish: 'Iske liye hamari team isi chat me aapse baat karegi.', en: 'Our team will help you with this here in this chat.' });
});

// ── U4. texts ──────────────────────────────────────────────────
const V = { order: '#1234', link: LINK, utr: '427812345678', amount: 1299, date: '2026-10-03' };
const GOLD = {
  form: {
    hinglish: `Aapke order #1234 ki refund request ke liye ye form bhariye: ${LINK}\nIsme problem aur refund ke liye aapka UPI ID ya bank account bharna hai. Ye link sirf aapke is order ke liye hai, 7 din tak chalega aur ek hi baar submit hoga.\nBank ya UPI details yahan na bhejein, sirf form me bharein. Hum kabhi OTP, UPI PIN ya password nahi maangte.`,
    en: `Please fill in this form for the refund request on your order #1234: ${LINK}\nIt asks what went wrong and your UPI ID or bank account for the refund. This link is only for this order, works for 7 days and can be submitted once.\nPlease do not send bank or UPI details here; enter them only in the form. We never ask for an OTP, UPI PIN or password.`,
  },
  received: {
    hinglish: 'Aapka refund form mil gaya hai. Team check karke isi chat me update degi.',
    en: 'We have received your refund form. Our team will check it and update you here in this chat.',
  },
  approved: {
    hinglish: 'Aapka refund approve ho gaya hai. Refund hote hi isi chat me reference number bhej denge.',
    en: 'Your refund has been approved. As soon as the refund is sent, we will share the reference number here in this chat.',
  },
  rejected: {
    hinglish: 'Aapki refund request abhi approve nahi ho payi. Team isi chat me aapse baat karegi.',
    en: 'Your refund request could not be approved right now. Our team will talk to you here in this chat.',
  },
  refunded: {
    hinglish: 'Aapka refund bhej diya gaya hai. Reference number: 427812345678\nAmount: ₹1,299 · Date: 3 Oct 2026 · Kahan bheja: aapke diye hue UPI / bank account me\nIs reference number se aap apne bank / UPI app me refund check kar sakte hain.',
    en: 'Your refund has been sent. Reference number: 427812345678\nAmount: ₹1,299 · Date: 3 Oct 2026 · Sent to: the UPI ID / bank account you gave\nYou can use this reference number to check the refund in your bank / UPI app.',
  },
  return: {
    hinglish: 'Is order ka return pickup hoga. Pickup ki details team isi chat me degi. Tab tak product ko uske packet aur tag ke saath sambhaal kar rakhiye.',
    en: 'This order needs a return pickup. Our team will share the pickup details here in this chat. Until then, please keep the product safe with its packet and tags.',
  },
};
t('U4 every step x language matches its golden text byte for byte', () => {
  deq(texts.STEPS, ['form', 'received', 'approved', 'rejected', 'refunded', 'return']);
  for (const step of texts.STEPS) for (const lang of ['hinglish', 'en']) eq(texts.chatMessage(step, lang, V), GOLD[step][lang], `${step} ${lang}`);
  eq(texts.chatMessage('refunded', 'hinglish', { ...V, method: 'upi' }), GOLD.refunded.hinglish.replace('UPI / bank account me', 'UPI ID me'));
  eq(texts.chatMessage('refunded', 'hinglish', { ...V, method: 'bank' }), GOLD.refunded.hinglish.replace('UPI / bank account me', 'bank account me'));
  eq(texts.chatMessage('refunded', 'en', { ...V, method: 'upi' }), GOLD.refunded.en.replace('the UPI ID / bank account you gave', 'the UPI ID you gave'));
  eq(texts.chatMessage('refunded', 'en', { ...V, method: 'bank' }), GOLD.refunded.en.replace('the UPI ID / bank account you gave', 'the bank account you gave'));
  eq(texts.chatMessage('approved', 'xx', V), GOLD.approved.en, 'an unknown language is English');
  eq(texts.messageLang(true), 'hinglish');
  eq(texts.messageLang(false), 'en');
});
t('U4 no placeholder left; values are never expanded again; missing values throw', () => {
  for (const step of texts.STEPS) for (const lang of ['hinglish', 'en']) {
    for (const method of [undefined, 'upi', 'bank']) ok(!/[{}]/.test(texts.chatMessage(step, lang, { ...V, method })), `${step} ${lang}`);
  }
  ok(texts.chatMessage('form', 'en', { order: '{amount}', link: LINK }).includes('order {amount}:'), 'a value is put in once');
  assert.throws(() => texts.chatMessage('refunded', 'en', { amount: 1, date: '2026-10-03' }), /missing utr/);
  assert.throws(() => texts.chatMessage('refunded', 'en', { utr: 'X', date: '2026-10-03' }), /missing amount/);
  assert.throws(() => texts.chatMessage('form', 'en', { order: '#1' }), /missing link/);
  assert.throws(() => texts.chatMessage('form', 'en', { order: '#1', link: '  ' }), /missing link/);
  assert.throws(() => texts.chatMessage('nope', 'en', V), /unknown step/);
  ok(GOLD.form.en.includes(`${LINK}\n`), 'the link is followed by a newline (ends at whitespace)');
});
t('U4 rejected never carries the note; refunded carries amount, date, where and the UTR', () => {
  for (const lang of ['hinglish', 'en']) {
    const r = texts.chatMessage('rejected', lang, { ...V, note: 'INTERNAL-NOTE-77 fake photos' });
    ok(!r.includes('INTERNAL-NOTE-77') && !/fake photos/.test(r), `rejected ${lang}`);
    const f = texts.chatMessage('refunded', lang, { ...V, amount: 1299.5, method: 'upi' });
    for (const part of ['₹1,299.50', '3 Oct 2026', '427812345678', lang === 'en' ? 'Sent to: the UPI ID you gave' : 'Kahan bheja: aapke diye hue UPI ID me']) {
      ok(f.includes(part), `refunded ${lang} has ${part.slice(0, 12)}`);
    }
  }
  eq(texts.chatMessage('refunded', 'en', { ...V, amount: '₹500' }).split('\n')[1].slice(0, 15), 'Amount: ₹500 · ', 'a formatted amount is kept');
});
t('U4 Q3: no message carries a masked UPI / account or "if this is not yours"', () => {
  for (const step of texts.STEPS) for (const lang of ['hinglish', 'en']) {
    const m = texts.chatMessage(step, lang, { ...V, method: 'bank', mask: 'HDFC ••••4521', dest: 'x', destBare: 'x' });
    ok(!/•|xxxx|4521|ending|last 4|agar ye aapka nahi|not yours/i.test(m), `${step} ${lang}`);
  }
  for (const lang of ['hinglish', 'en']) ok(!/[•@]|\d{4}/.test(texts.WHERE[lang].any + texts.WHERE[lang].upi + texts.WHERE[lang].bank), `WHERE ${lang}`);
  eq(texts.WHERE.hinglish.any, 'aapke diye hue UPI / bank account me', 'the owner\'s words');
});
t('U4 no time promise anywhere; "7 din / 7 days" only in the form message', () => {
  const TIME = /\b(aaj|kal|today|tomorrow|ghante|hours?|minutes?|turant)\b/i;
  for (const step of texts.STEPS) for (const lang of ['hinglish', 'en']) {
    const m = texts.chatMessage(step, lang, V);
    ok(!TIME.test(m), `${step} ${lang}`);
    eq(/\b7 (din|days)\b/.test(m), step === 'form', `7 days ${step} ${lang}`);
  }
});
t('U4 formatAmount / formatDate / IST date-times / phone', () => {
  eq(texts.formatAmount(1299), '₹1,299');
  eq(texts.formatAmount(123456.5), '₹1,23,456.50');
  eq(texts.formatAmount(1299.5), '₹1,299.50');
  eq(texts.formatAmount(100000), '₹1,00,000');
  eq(texts.formatAmount(12345678), '₹1,23,45,678');
  eq(texts.formatAmount(999), '₹999');
  eq(texts.formatAmount(0.5), '₹0.50');
  eq(texts.formatAmount(1299.999), '₹1,300');
  eq(texts.formatDate('2026-10-02'), '2 Oct 2026');
  eq(texts.formatDate('2026-01-31'), '31 Jan 2026');
  eq(texts.formatDate('2 Oct'), '');
  eq(texts.formatDayMonth('2026-10-09T05:50:00.000Z'), '9 Oct');
  eq(texts.formatDayMonth('2026-10-08T18:30:00Z'), '9 Oct', 'IST midnight');
  eq(texts.formatDateTime('2026-10-02T06:12:00Z'), '2 Oct, 11:42 AM');
  eq(texts.formatDateTime('2026-10-02T06:30:00Z'), '2 Oct, 12:00 PM');
  eq(texts.formatDateTime('2026-10-02T18:30:00Z'), '3 Oct, 12:00 AM');
  eq(texts.formatDateTime('nope'), '');
  eq(texts.maskedPhone('4321'), '+91 •••••• 4321', 'Q9');
  eq(texts.maskedPhone(null), '');
  eq(texts.payoutLabel('upi', 'ra•••.s@okaxis'), 'UPI ID ra•••.s@okaxis');
  eq(texts.payoutLabel('bank', 'HDFC ••••4321'), 'bank account ending 4321');
  eq(texts.bankName('HDFC0001234'), 'HDFC Bank');
  eq(texts.bankName('HDFC ••••4321'), 'HDFC Bank');
  eq(texts.bankName('ZZZZ0001234'), null);
  ok(texts.upiHandleKnown('a@okaxis') && texts.upiHandleKnown('a@YBL') && !texts.upiHandleKnown('a@madeuphandle'), 'handles');
  eq(Object.keys(texts.BANK_NAMES).length, 36);
  eq(texts.UPI_HANDLES.length, 36);
});
t('U4 page texts: English + a Devanagari line (Q8); every error code has its text', () => {
  const DEV = /[\u0900-\u097F]/;
  const walk = (o, where) => {
    if (o && typeof o === 'object' && typeof o.en === 'string' && typeof o.hi === 'string') {
      if (/[A-Za-z]{3,}/.test(o.en) && !/^\{n\}/.test(o.en)) ok(DEV.test(o.hi), `${where} has a Devanagari line`);
      ok(o.en.trim() && o.hi.trim(), `${where} not empty`);
      return;
    }
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${where}.${k}`);
  };
  for (const name of ['PAGE', 'STATUS_VIEW', 'SCREENS', 'ERRORS', 'REASON_TEXT', 'SUB_REASON_TEXT', 'CONSENT_TEXT']) walk(texts[name], name);
  const codes = ['bad_request', 'reason_required', 'sub_reason_required', 'checked_around_required', 'details_long',
    'method_required', 'upi_format', 'holder_format', 'account_format', 'account_mismatch', 'ifsc_format', 'consent_required', 'network'];
  for (const c of codes) ok(texts.ERRORS[c], `ERRORS.${c}`);
  ok(!texts.ERRORS.details_short && !/at least|कम से कम/i.test(texts.PAGE.detailsHint.en + texts.PAGE.detailsHint.hi), 'details optional: no minimum-length text (owner 2026-10-02)');
  for (const r of rules.REASONS) ok(texts.REASON_TEXT[r] && texts.DETAILS_PLACEHOLDER[r], r);
  for (const s of Object.values(rules.SUB_REASONS).flat()) ok(texts.SUB_REASON_TEXT[s], s);
  for (const s of ['invalid', 'expired', 'replaced', 'cancelled', 'used', 'closed', 'slow_down']) ok(texts.SCREENS[s], s);
  eq(texts.CONSENT_TEXT.version, rules.CONSENT_VERSION);
  ok(/own name/.test(texts.CONSENT_TEXT.en) && /अपने नाम/.test(texts.CONSENT_TEXT.hi), 'Q10 option A');
  ok(/family, neighbours and the building security/.test(texts.PAGE.checkedAround.en), 'Q12 tick text');
  eq(texts.fill('Request number: {ref}', { ref: 'RF-7K2QXM' }), 'Request number: RF-7K2QXM');
  eq(texts.fill('{a} {b}', { a: 1 }), '1 {b}', 'unknown placeholders stay');
});

// ── U5. moves and admin validators ─────────────────────────────
const sqlMoves = () => {
  const body = sqlLines('refund-forms.sql').split('CREATE OR REPLACE FUNCTION refund_request_guard()')[1].split('END $$;')[0];
  const out = new Set();
  for (const m of body.matchAll(/\(OLD\.status = '(\w+)'\s+AND NEW\.status (?:IN \(([^)]*)\)|= '(\w+)')\)/g)) {
    for (const to of m[2] ? sqlList(m[2]) : [m[3]]) out.add(`${m[1]}>${to}`);
  }
  return out;
};
t('U5 every (from, to) pair: MOVES = canMove = the SQL trigger', () => {
  const sql = sqlMoves();
  deq([...sql].sort(), ['approved>cancelled', 'approved>refunded', 'approved>rejected', 'new>approved', 'new>cancelled', 'new>rejected', 'rejected>approved']);
  for (const from of rules.STATUSES) for (const to of rules.STATUSES) {
    if (from === to) continue;
    eq(rules.canMove(from, to), sql.has(`${from}>${to}`), `${from} -> ${to}`);
  }
  deq(rules.actionsFor('new'), ['approve', 'reject', 'cancel']);
  deq(rules.actionsFor('approved'), ['reject', 'refunded', 'cancel']);
  deq(rules.actionsFor('rejected'), ['approve']);
  deq(rules.actionsFor('refunded'), []);
  deq(rules.actionsFor('cancelled'), []);
  eq(rules.MOVES.reject.noteRequired, true);
  eq(rules.MOVES.cancel.noteRequired, true);
  eq(rules.MOVES.approve.noteRequired, false);
  eq(rules.MOVES.refunded.noteRequired, false);
  eq(rules.MOVES.cancel.message, null, 'Q5: no customer message');
  deq(rules.PUBLIC_STATUS, { new: 'received', approved: 'approved', rejected: 'not_approved', refunded: 'refunded', cancelled: 'closed' });
  ok(!rules.isMoveAction('toString') && !rules.isMoveAction('note') && rules.isMoveAction('cancel'), 'isMoveAction');
});
t('U5 UTR', () => {
  deq(rules.checkUtr('4278 1234 5678', 'upi'), { ok: true, value: '427812345678' });
  deq(rules.checkUtr('abc-1234-5678', 'upi'), { ok: true, value: 'ABC12345678', warn: 'utr_not_upi' });
  deq(rules.checkUtr('ABC12345678', 'bank'), { ok: true, value: 'ABC12345678' });
  eq(code(rules.checkUtr('1234567')), 'utr_format', '7');
  eq(code(rules.checkUtr('A'.repeat(31))), 'utr_format', '31');
  eq(code(rules.checkUtr('UTR#12345678')), 'utr_format', '#');
  eq(code(rules.checkUtr('')), 'utr_format', 'empty');
});
t('U5 amount: never over the total; capped when the total is 0 / unknown; partial warns', () => {
  deq(rules.checkAmount('1299', 1299), { ok: true, value: 1299 });
  eq(code(rules.checkAmount('1300', 1299)), 'amount_over_total');
  eq(code(rules.checkAmount('1299.01', '1299')), 'amount_over_total');
  deq(rules.checkAmount('1000', 1299), { ok: true, value: 1000, warn: 'partial' });
  deq(rules.checkAmount('1299.50', '1299.5'), { ok: true, value: 1299.5 });
  deq(rules.checkAmount(1299, 1299), { ok: true, value: 1299 });
  for (const [i, v] of ['0', '-5', '12.345', '12345678', 'abc', '', '1e3', '0.00'].entries()) eq(code(rules.checkAmount(v, 0)), 'amount_format', `case ${i}`);
  deq(rules.checkAmount('100000', 0), { ok: true, value: 100000 });
  eq(code(rules.checkAmount('100000.01', 0)), 'amount_high');
  eq(code(rules.checkAmount('100001', null)), 'amount_high');
  deq(rules.checkAmount(' 500 ', undefined), { ok: true, value: 500 });
  eq(rules.AMOUNT_CAP, 100000);
});
t('U5 refund date: from the submit day (IST) to today (IST)', () => {
  const sub = '2026-10-02T18:40:00Z';   // 3 Oct 00:10 IST
  const late = Date.parse('2026-10-05T18:29:59Z');   // 5 Oct 23:59:59 IST
  eq(code(rules.checkRefundDate('2026-10-02', sub, late)), 'date_range', 'before the submit day');
  eq(code(rules.checkRefundDate('2026-10-03', sub, late)), 'ok');
  eq(code(rules.checkRefundDate('2026-10-05', sub, late)), 'ok');
  eq(code(rules.checkRefundDate('2026-10-06', sub, late)), 'date_range', 'tomorrow');
  eq(code(rules.checkRefundDate('2026-10-06', sub, Date.parse('2026-10-05T18:30:00Z'))), 'ok', 'IST midnight');
  for (const [i, v] of ['2026-02-30', '2026-10-3', '03-10-2026', '', 'today'].entries()) eq(code(rules.checkRefundDate(v, sub, late)), 'date_range', `case ${i}`);
  eq(rules.istDay('2026-10-02T18:29:59Z'), '2026-10-02');
  eq(rules.istDay('2026-10-02T18:30:00Z'), '2026-10-03');
});
t('U5 notes, return note, the prepaid tick, validateMove', () => {
  eq(code(rules.checkNote('', true)), 'note_required');
  deq(rules.checkNote('  ', false), { ok: true, value: null });
  eq(code(rules.checkNote('x'.repeat(501), true)), 'note_long');
  eq(rules.checkNote('x'.repeat(500), true).value.length, 500);
  eq(code(rules.checkReturnNote('x'.repeat(301))), 'return_note_long');
  deq(rules.checkReturnNote(''), { ok: true, value: null });
  eq(code(rules.checkGatewayTick('razorpay', false)), 'gateway_tick');
  eq(code(rules.checkGatewayTick('Prepaid', undefined)), 'gateway_tick');
  eq(code(rules.checkGatewayTick('razorpay', true)), 'ok');
  eq(code(rules.checkGatewayTick('COD', false)), 'ok');
  const base = { utr: '427812345678', amount: '1299', refund_date: '2026-10-03', gateway_checked: false, method: 'upi', payment_raw: 'COD',
    order_total: 1299, submitted_at: '2026-10-02T06:00:00Z', now: Date.parse('2026-10-03T10:00:00Z') };
  deq(rules.validateMove('refunded', { ...base, status: 'approved' }), { ok: true, value: {
    to: 'refunded', message: 'refunded', note: null, utr: '427812345678', amount: 1299, refund_date: '2026-10-03', gateway_checked: false, warnings: [] } });
  eq(rules.validateMove('refunded', { ...base, status: 'approved', payment_raw: 'razorpay' }).errors.gateway_checked, 'gateway_tick', 'prepaid');
  ok(rules.validateMove('refunded', { ...base, status: 'approved', payment_raw: 'razorpay', gateway_checked: true }).ok, 'prepaid ticked');
  deq(rules.validateMove('refunded', { ...base, status: 'approved', amount: '1000', utr: 'ABC12345678' }).value.warnings, ['utr_not_upi', 'partial']);
  eq(rules.validateMove('refunded', { ...base, status: 'new' }).errors.status, 'move_not_allowed');
  eq(rules.validateMove('refunded', { ...base, status: 'rejected' }).errors.status, 'move_not_allowed');
  deq(rules.validateMove('refunded', { ...base, status: 'approved', utr: '', amount: '2000', refund_date: '2026-10-09' }).errors,
    { utr: 'utr_format', amount: 'amount_over_total', refund_date: 'date_range' });
  eq(rules.validateMove('reject', { status: 'new', note: '', now: 0, submitted_at: 0 }).errors.note, 'note_required');
  const rj = rules.validateMove('reject', { status: 'approved', note: ' wrong photos ', now: 0, submitted_at: 0 });
  deq([rj.value.to, rj.value.message, rj.value.note, rj.value.utr], ['rejected', 'rejected', 'wrong photos', null]);
  deq([rules.validateMove('cancel', { status: 'new', note: 'test request', now: 0, submitted_at: 0 }).value.message], [null]);
  eq(rules.validateMove('cancel', { status: 'new', now: 0, submitted_at: 0 }).errors.note, 'note_required');
  eq(rules.validateMove('approve', { status: 'rejected', now: 0, submitted_at: 0 }).value.message, 'approved');
  eq(rules.validateMove('approve', { status: 'cancelled', now: 0, submitted_at: 0 }).errors.status, 'move_not_allowed');
  eq(rules.validateMove('bogus', { status: 'new' }).errors.action, 'bad_action');
});

// ── U6. crypto ─────────────────────────────────────────────────
const flip = (blob, idx) => {
  const p = blob.split('.');
  const b = Buffer.from(p[idx], 'base64url');
  b[0] ^= 1;
  p[idx] = b.toString('base64url');
  return p.join('.');
};
const PAY = { v: 1, method: 'bank', account: '123456789012', ifsc: 'HDFC0001234', holder: 'TEST USER' };
t('U6 round trip; a fresh IV every time; the blob fits the SQL CHECKs', () => {
  setKeys(K1);
  const s = rc.sealJson(PAY, rc.payoutAad(UUID(1)));
  deq(rc.openJson(s.blob, rc.payoutAad(UUID(1))), PAY);
  eq(s.keyId, rc.currentKeyId());
  eq(rc.blobKeyId(s.blob), s.keyId);
  const s2 = rc.sealJson(PAY, rc.payoutAad(UUID(1)));
  ok(s.blob !== s2.blob && s.blob.split('.')[2] !== s2.blob.split('.')[2], 'two seals differ (fresh IV)');
  ok(!s.blob.includes('123456789012') && !Buffer.from(s.blob.split('.')[4], 'base64url').toString('latin1').includes('123456789012'), 'no plaintext');
  const sql = read('refund-forms.sql');
  const enc = new RegExp(sql.match(/payout_enc ~ '([^']+)'/)[1]);
  const kid = new RegExp(sql.match(/payout_key_id ~ '([^']+)'/)[1]);
  ok(enc.test(s.blob), 'payout_enc CHECK');
  ok(kid.test(s.keyId), 'payout_key_id CHECK');
  eq(rc.payoutAad('abc'), 'refund:abc:payout');
});
t('U6 tampering: a flipped byte in iv, tag or ct, another row\'s AAD, a bad blob', () => {
  setKeys(K1);
  const s = rc.sealJson(PAY, rc.payoutAad(UUID(1)));
  for (const idx of [2, 3, 4]) throwsCode(() => rc.openJson(flip(s.blob, idx), rc.payoutAad(UUID(1))), 'auth_failed', `part ${idx}`);
  throwsCode(() => rc.openJson(s.blob, rc.payoutAad(UUID(2))), 'auth_failed', 'request B\'s AAD');
  for (const [i, b] of ['', 'v2.0123abcd.a.b.c', 'v1.0123abcd.a.b', 'v1.XYZ.a.b.c', 'v1.0123abcd.a!.b.c', null].entries()) {
    throwsCode(() => rc.openJson(b, 'x'), 'bad_blob', `case ${i}`);
  }
  const p = s.blob.split('.');
  p[1] = p[1] === 'deadbeef' ? 'feedbeef' : 'deadbeef';
  throwsCode(() => rc.openJson(p.join('.'), rc.payoutAad(UUID(1))), 'unknown_key', 'unknown key id');
  let msg = '';
  try { rc.openJson(s.blob, rc.payoutAad(UUID(2))); } catch (e) { msg = `${e.message} ${e.stack}`; }
  ok(!msg.includes('123456789012') && !msg.includes('TEST USER'), 'the error carries no plaintext');
  eq(new rc.RefundCryptoError('no_key').message, 'no_key');
});
t('U6 rotation: OLD decrypts, new seals use the current key; without OLD unknown_key', () => {
  setKeys(K1);
  const id1 = rc.currentKeyId();
  const s = rc.sealJson(PAY, 'a');
  const part = rc.sealPart(Buffer.from('photo bytes'), UUID(5), 0);
  setKeys(K2, K1);
  const id2 = rc.currentKeyId();
  ok(id1 !== id2 && /^[0-9a-f]{8}$/.test(id2), 'another key id');
  eq(rc.oldKeyId(), id1);
  deq(rc.openJson(s.blob, 'a'), PAY, 'OLD decrypts');
  eq(rc.openPart(part, UUID(5), 0, id1).toString(), 'photo bytes', 'OLD decrypts a part');
  eq(rc.blobKeyId(rc.sealJson(PAY, 'a').blob), id2, 'new seals: the current key');
  setKeys(K2);
  eq(rc.oldKeyId(), null);
  throwsCode(() => rc.openJson(s.blob, 'a'), 'unknown_key', 'OLD removed');
  throwsCode(() => rc.openPart(part, UUID(5), 0, id1), 'unknown_key', 'OLD removed (part)');
  setKeys(undefined);
  throwsCode(() => rc.openJson(s.blob, 'a'), 'no_key', 'no key at all');
});
t('U6 fail closed: missing, 31 / 33 bytes, garbage = not ready; base64, base64url and hex = ready', () => {
  process.env.AUTH_TOKEN_SECRET = 'x'.repeat(64);   // never a fallback (J5)
  for (const [i, k] of [undefined, '', '   ', nodeCrypto.randomBytes(31).toString('base64'), nodeCrypto.randomBytes(33).toString('base64'),
    'garbage!!', 'not a key at all', nodeCrypto.randomBytes(32).toString('hex').slice(1), nodeCrypto.randomBytes(16).toString('hex')].entries()) {
    setKeys(k);
    eq(rc.refundCryptoReady(), false, `case ${i}`);
    eq(rc.refundFormsState(), 'key_missing', `state ${i}`);
    throwsCode(() => rc.sealJson({}, 'a'), 'no_key', `seal ${i}`);
    throwsCode(() => rc.currentKeyId(), 'no_key', `key id ${i}`);
    throwsCode(() => rc.fingerprint('upi', 'a@b'), 'no_key', `fp ${i}`);
  }
  delete process.env.AUTH_TOKEN_SECRET;
  for (const [i, k] of [nodeCrypto.randomBytes(32).toString('base64'), nodeCrypto.randomBytes(32).toString('base64url'),
    nodeCrypto.randomBytes(32).toString('hex'), nodeCrypto.randomBytes(32).toString('hex').toUpperCase(), ` ${K1} `].entries()) {
    setKeys(k);
    eq(rc.refundCryptoReady(), true, `ready ${i}`);
    eq(rc.refundFormsState(), 'on', `on ${i}`);
  }
  setKeys(K1, undefined, 'off');
  eq(rc.refundFormsState(), 'off', 'the kill switch');
  setKeys(K1, undefined, ' OFF ');
  eq(rc.refundFormsState(), 'off', 'any case');
  setKeys(undefined, undefined, 'off');
  eq(rc.refundFormsState(), 'off', 'off wins');
  setKeys(K1, undefined, 'on');
  eq(rc.refundFormsState(), 'on');
});
t('U6 fingerprints: keyed, 32 characters, normalised per kind', () => {
  setKeys(K1);
  const a = rc.fingerprint('upi', 'test.user@okaxis');
  ok(/^[A-Za-z0-9_-]{32}$/.test(a), 'shape');
  ok(new RegExp(read('refund-forms.sql').match(/payout_fp ~ '([^']+)'/)[1]).test(a), 'payout_fp CHECK');
  eq(rc.fingerprint('upi', ' Test.User@OKAXIS '), a, 'UPI case / spaces');
  ok(rc.fingerprint('upi', 'other@okaxis') !== a, 'another UPI');
  ok(rc.fingerprint('bank', 'test.user@okaxis') !== a, 'another kind');
  ok(rc.fingerprint('ip', 'test.user@okaxis') !== a && rc.fingerprint('ip', '9876543210') !== rc.fingerprint('phone', '9876543210'),
    'the kind is part of the HMAC input (same normalised text, other kind)');
  eq(rc.fingerprint('phone', '+91 98765-43210'), rc.fingerprint('phone', '9876543210'), 'last 10 digits');
  eq(rc.fingerprint('bank', 'hdfc0001234:123456789012'), rc.fingerprint('bank', 'HDFC0001234:123456789012'));
  eq(rc.ipHash('203.0.113.9').length, 24);
  eq(rc.ipHash('203.0.113.9'), rc.ipHash('203.0.113.9'));
  setKeys(K2);
  ok(rc.fingerprint('upi', 'test.user@okaxis') !== a, 'depends on the key');
  setKeys(K1);
});
// sealPart / openPart stay in crypto.ts only for scripts/refund-rekey.js (the file tables are kept empty).
t('U6 file parts (refund-rekey.js only): round trip; a swapped part number or file id throws', () => {
  setKeys(K1);
  const big = nodeCrypto.randomBytes(2 * 1024 * 1024);
  const sealed = rc.sealPart(big, UUID(7), 3);
  eq(sealed.length, big.length + 28, 'iv | tag | ct');
  ok(sealed.length <= 2097180, 'refund_file_parts.data CHECK');
  ok(rc.openPart(sealed, UUID(7), 3, rc.currentKeyId()).equals(big), 'round trip');
  throwsCode(() => rc.openPart(sealed, UUID(7), 2, rc.currentKeyId()), 'auth_failed', 'part number');
  throwsCode(() => rc.openPart(sealed, UUID(8), 3, rc.currentKeyId()), 'auth_failed', 'file id');
  const bad = Buffer.from(sealed); bad[40] ^= 1;
  throwsCode(() => rc.openPart(bad, UUID(7), 3, rc.currentKeyId()), 'auth_failed', 'a flipped byte');
  throwsCode(() => rc.openPart(Buffer.alloc(28), UUID(7), 3, rc.currentKeyId()), 'bad_blob', 'too short');
  throwsCode(() => rc.openPart(sealed, UUID(7), 3, 'deadbee0'), 'unknown_key', 'unknown key id');
  const tiny = rc.sealPart(Buffer.from([1]), UUID(7), 0);
  eq(tiny.length, 29, 'the smallest part is 29 bytes (CHECK BETWEEN 29 AND ...)');
  ok(!rc.sealPart(Buffer.from([1]), UUID(7), 0).equals(tiny), 'fresh IV');
});

// ── U7. tokens ─────────────────────────────────────────────────
t('U7 tokens: 43 base64url characters, SHA-256 hex at rest, strict format', () => {
  const a = rc.newToken(), b = rc.newToken();
  ok(rc.TOKEN_RE.test(a.token) && a.token.length === 43, 'token shape');
  ok(/^[0-9a-f]{64}$/.test(a.hash), 'hash shape');
  ok(new RegExp(read('refund-forms.sql').match(/token_hash ~ '([^']+)'/)[1]).test(a.hash), 'token_hash CHECK');
  eq(rc.tokenHash(a.token), a.hash, 'stable');
  eq(a.hash, nodeCrypto.createHash('sha256').update(a.token).digest('hex'), 'sha256');
  ok(a.token !== b.token && a.hash !== b.hash, 'random');
  ok(Buffer.from(a.token, 'base64url').length === 32, '32 bytes');
  for (const [i, x] of ['x', a.token.slice(0, 42), a.token + 'A', a.token.slice(0, 42) + '+', a.token.slice(0, 42) + '=', null, 42, undefined, ` ${a.token}`].entries()) {
    eq(rc.tokenHash(x), null, `case ${i}`);
  }
});

// ── U8. names ──────────────────────────────────────────────────
t('U8 namesMatch', () => {
  eq(rules.namesMatch('RAHUL SHARMA', 'Rahul Sharma'), true);
  eq(rules.namesMatch('MR R SHARMA', 'Rahul Sharma'), true);
  eq(rules.namesMatch('PRIYA', 'Rahul Sharma'), false);
  eq(rules.namesMatch('', 'x'), null);
  eq(rules.namesMatch('SMT PRIYA', 'Smt Kavita Rao'), false, 'a title alone is not a match');
  eq(rules.namesMatch('KUMARI ANJALI', 'Kumari Neha Verma'), false, 'KUMARI');
  eq(rules.namesMatch('SHRI MOHAN', 'Shri Ram'), false, 'SHRI');
  eq(rules.namesMatch('DR AMIT', 'Dr. Amit Jain'), true);
  eq(rules.namesMatch('RAHUL', 'राहुल शर्मा'), null, 'order name not in Latin letters');
  eq(rules.namesMatch('R K', 'Rahul'), null, 'only short words');
  eq(rules.namesMatch("D'SOUZA MARIA", 'Maria D\'Souza'), true);
});

// ── U9. no photo / video upload (owner change 2026-10-02 ~15:00) ──
// "upload yeh sab mat bana, humein sirf bank details mil jaye bahut hai": no file module, no file route,
// no file field, limit or text, and no route under src/app/api/refund* that takes a file body.
const walkFiles = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walkFiles(path.join(rel, d.name)) : [path.join(rel, d.name)]));
};
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
t('U9 no upload: no file module, field, limit or customer text', () => {
  for (const rel of ['src/lib/refund/files.ts', 'src/app/api/refund/files', 'src/app/api/refunds/files']) ok(!fs.existsSync(path.join(ROOT, rel)), `${rel} is gone`);
  for (const k of ['MB', 'PHOTO_MAX', 'PHOTO_BYTES', 'VIDEO_MAX', 'VIDEO_BYTES', 'PART_BYTES', 'STAGED_FILE_HOURS', 'MAX_FILE_IDS', 'checkFileIds']) ok(!(k in rules), `rules.${k} is gone`);
  ok(!Object.keys(limits.REFUND_LIMITS).some((k) => /^(file|part)_/.test(k)), 'no file / part rate limits');
  const v = rules.validateSubmit(upiBody({ file_ids: [UUID(1), 'nope'] }));
  ok(v.ok && !('file_ids' in v.value), 'file_ids from an old page is ignored, never an error');
  for (const k of ['PHOTO_TIP']) ok(!(k in texts), `texts.${k} is gone`);
  for (const k of ['step2', 'photosIntro', 'photosLimits', 'addPhotos', 'addVideo', 'uploadingFiles']) ok(!(k in texts.PAGE), `PAGE.${k} is gone`);
  ok(!('photos' in texts.PAGE.progress), 'no Photos step in the progress bar');
  for (const k of ['uploading', 'file_type', 'photo_big', 'video_big', 'too_many_photos', 'one_video', 'files_bad']) ok(!(k in texts.ERRORS), `ERRORS.${k} is gone`);
  // Every customer string (page + chat messages): nothing asks for a photo, a video or a file.
  const ASK = /\b(photos?|videos?|files?|upload\w*|attach\w*)\b|फ़ोटो|फोटो|वीडियो|अपलोड/i;
  const strings = [];
  const walk = (o) => { if (typeof o === 'string') strings.push(o); else if (o && typeof o === 'object') for (const x of Object.values(o)) walk(x); };
  for (const name of ['MESSAGES', 'PAGE', 'STATUS_VIEW', 'SCREENS', 'ERRORS', 'REASON_TEXT', 'SUB_REASON_TEXT', 'DETAILS_PLACEHOLDER', 'CONSENT_TEXT']) walk(texts[name]);
  ok(strings.length > 100, `${strings.length} strings`);
  for (const str of strings) ok(!ASK.test(str), `a customer text mentions a photo / video / file: ${str.slice(0, 50)}`);
  for (const step of texts.STEPS) for (const lang of ['hinglish', 'en']) ok(!ASK.test(texts.chatMessage(step, lang, V)), `${step} ${lang}`);
});
t('U9 no route under src/app/api/refund* takes a file, multipart or raw-bytes body; server.ts has no file code', () => {
  const routes = [...walkFiles('src/app/api/refund'), ...walkFiles('src/app/api/refunds')].filter((f) => /route\.(ts|tsx|js)$/.test(f));
  ok(routes.length >= 6, routes.join(', '));   // open, submit, refunds, counts, [id], [id]/reveal
  deq(walkFiles('src/app/api/refund').filter((f) => /route\./.test(f)).map((f) => path.basename(path.dirname(f))).sort(), ['open', 'submit'],
    'the public routes are open and submit only');
  const RAW = /octet-stream|'octet'|multipart|form-data|formData\s*\(|\.arrayBuffer\s*\(|\.blob\s*\(|request\.body\b|getReader\s*\(|tokenFromHeader|x-refund-token|readCapped/i;
  for (const rel of routes) {
    const src = noComments(read(rel));
    ok(!RAW.test(src), `${rel} reads a raw / file / multipart body`);
    ok(!/export\s+(async\s+)?function\s+PUT\b|export\s+const\s+PUT\b/.test(src), `${rel} has no PUT`);
    for (const m of src.matchAll(/publicGuard\(\s*\w+\s*,\s*\{\s*kind:\s*'(\w+)'/g)) eq(m[1], 'json', `${rel}: a public route takes JSON only`);
    if (rel.startsWith(path.join('src', 'app', 'api', 'refund') + path.sep)) ok(/publicGuard\(\s*\w+\s*,\s*\{\s*kind:\s*'json'/.test(src), `${rel} goes through the JSON guard`);
  }
  const server = noComments(read('src/lib/refund/server.ts'));
  ok(!/refund_files?\b|refund_file_parts|file_ids|sealPart|openPart|sniff|\bPART_BYTES\b/.test(server), 'server.ts never touches files');
  for (const fn of ['createFile', 'putPart', 'deleteFile', 'readRefundFile', 'sweepStaged']) ok(!new RegExp(`\\b${fn}\\b`).test(server), `server.ts has no ${fn}`);
});

// ── U10. device, ref code, COD ─────────────────────────────────
t('U10 deviceLabel: OS + browser, never the full user agent', () => {
  const UA = [
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 'Android · Chrome'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 'iPhone · Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1', 'iPhone · Chrome'],
    ['Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 WhatsApp/2.24.1', 'Android · WhatsApp'],
    ['Mozilla/5.0 (Linux; Android 13; RMX3363) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 Instagram 300.0.0.29.110 Android', 'Android · Instagram/Facebook app'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]', 'iPhone · Instagram/Facebook app'],
    ['Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36', 'Android · Samsung Internet'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 'Windows · Edge'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0', 'Mac · Firefox'],
    ['Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 'iPad · Safari'],
    ['curl/8.4.0', 'Other · Browser'], ['', 'Other · Browser'], [undefined, 'Other · Browser'],
  ];
  const max = Number(read('refund-forms.sql').match(/char_length\(submit_device\) <= (\d+)/)[1]);
  for (const [i, [ua, want]] of UA.entries()) {
    const got = rules.deviceLabel(ua);
    eq(got, want, `ua ${i}`);
    ok(got.length <= 40 && got.length <= max && !/Mozilla|\d/.test(got), `short ${i}`);
  }
});
t('U10 newRefCode: RF- + 6 of the 32-letter alphabet (no I, L, O, U); matches the SQL CHECK', () => {
  eq(rules.newRefCode(Uint8Array.from([0, 1, 2, 3, 4, 5])), 'RF-012345');
  eq(rules.newRefCode(Uint8Array.from([31, 30, 29, 28, 27, 26])), 'RF-ZYXWVT');
  eq(rules.newRefCode(Uint8Array.from([255, 32, 64, 96, 128, 160, 7])), 'RF-Z00000');
  assert.throws(() => rules.newRefCode(Uint8Array.from([1, 2, 3, 4, 5])));
  eq(rules.REF_ALPHABET.length, 32);
  eq(new Set(rules.REF_ALPHABET).size, 32);
  ok(!/[ILOU]/.test(rules.REF_ALPHABET), 'no I L O U');
  const sqlRe = new RegExp(read('refund-forms.sql').match(/ref_code ~ '([^']+)'/)[1]);
  eq(sqlRe.source, rules.REF_RE.source, 'same regex as the SQL');
  for (let i = 0; i < 2000; i++) {
    const c = rules.newRefCode(nodeCrypto.randomBytes(6));
    ok(sqlRe.test(c) && rules.REF_RE.test(c), 'random code fits');
  }
});
t('U10 isCod = the AI\'s test (orders.ts); paymentLabel; isDelivered', () => {
  for (const v of ['COD', 'cod', 'Cash on Delivery (COD)', 'cash on delivery']) eq(rules.isCod(v), true, v);
  for (const v of ['razorpay', 'Prepaid', '', null, undefined, 'cards']) eq(rules.isCod(v), false, String(v));
  eq(rules.paymentLabel('COD'), 'COD');
  eq(rules.paymentLabel('razorpay'), 'Prepaid');
  ok(read('src/lib/chat/orders.ts').includes("rawPay === 'cod' || rawPay.includes('cash on delivery')"), 'orders.ts changed its COD test: update rules.ts isCod');
  eq(rules.isDelivered({ tracking_status: 'Delivered' }), true);
  eq(rules.isDelivered({ tracking_status: ' delivered ' }), true);
  eq(rules.isDelivered({ delivered_at: '2026-10-01T10:00:00Z', tracking_status: 'In Transit' }), true);
  eq(rules.isDelivered({ tracking_status: 'Out for Delivery' }), false);
  eq(rules.isDelivered(null), false);
});

// ── U11. flags ─────────────────────────────────────────────────
t('U11 computeFlags: each flag on and off; red, then amber, then grey', () => {
  const codes = (i) => rules.computeFlags(i).map((f) => f.code);
  const now = Date.parse('2026-10-03T10:00:00Z');
  deq(codes({}), [], 'nothing known');
  deq(codes({ paymentRaw: 'razorpay' }), ['prepaid']);
  // Owner answer Q1 changed rule 18: the flag asks for the gateway check only; it no longer points at rule 18.
  const pre = rules.computeFlags({ paymentRaw: 'razorpay' })[0].text;
  ok(/payment gateway/.test(pre) && !/rule 18/i.test(pre), 'prepaid flag: gateway check, no "Master rule 18"');
  deq(codes({ paymentRaw: 'COD' }), []);
  deq(codes({ paymentRaw: 'COD', delivered: false }), ['cod_not_delivered']);
  deq(codes({ paymentRaw: 'COD', delivered: true }), []);
  deq(codes({ paymentRaw: 'razorpay', delivered: false }), ['prepaid'], 'not delivered matters for COD only');
  deq(codes({ paymentRaw: 'COD', delivered: true, reason: 'not_received' }), ['cod_not_received']);
  deq(codes({ paymentRaw: 'COD', delivered: true, reason: 'damaged' }), []);
  const reused = rules.computeFlags({ payoutReusedRefs: ['RF-AAAAAA', 'RF-BBBBBB'] })[0];
  deq([reused.code, reused.level, reused.refs], ['payout_reused', 'red', ['RF-AAAAAA', 'RF-BBBBBB']]);
  ok(reused.text.includes('RF-AAAAAA, RF-BBBBBB'), 'refs in the text');
  deq(codes({ payoutReusedRefs: [] }), []);
  deq(codes({ ackPosted: false, createdAtMs: now - 3 * 60_000, nowMs: now }), ['ack_failed']);
  deq(codes({ ackPosted: false, createdAtMs: now - 60_000, nowMs: now }), [], 'within 2 minutes');
  deq(codes({ ackPosted: true, createdAtMs: now - 3_600_000, nowMs: now }), []);
  deq(codes({ emailFailed: true }), ['email_failed']);
  deq(codes({ emailFailed: false }), []);
  deq(codes({ isCancelled: true }), ['order_cancelled']);
  deq(codes({ isCancelled: false }), []);
  const nd = rules.computeFlags({ holderMatches: false, orderName: 'Test Name' })[0];
  deq([nd.code, nd.level], ['name_differs', 'amber']);
  ok(nd.text.includes('(Test Name)'), 'the order name');
  deq(codes({ holderMatches: true }), []);
  deq(codes({ holderMatches: null }), [], 'could not compare');
  deq(codes({ phoneRequests90d: 2 }), ['repeat_customer']);
  deq(codes({ phoneRequests90d: 1 }), []);
  deq(codes({ orderChanged: true }), ['order_changed']);
  deq(codes({ orderChanged: false }), []);
  deq(codes({ openNetworks: 3 }), ['opened_by_many']);
  deq(codes({ openNetworks: 2 }), []);
  deq(codes({ caseKind: 'reship' }), ['not_refund_case']);
  deq(codes({ caseKind: null }), ['not_refund_case'], 'Remove');
  deq(codes({ caseKind: 'refund' }), []);
  const all = rules.computeFlags({ caseKind: null, isCancelled: true, paymentRaw: 'COD', delivered: false, reason: 'not_received', emailFailed: true });
  deq(all.map((f) => f.level), ['red', 'red', 'red', 'amber', 'grey']);
  deq(rules.FLAG_LEVEL, { prepaid: 'red', cod_not_delivered: 'red', cod_not_received: 'red', payout_reused: 'red', ack_failed: 'red', email_failed: 'red',
    order_cancelled: 'amber', name_differs: 'amber', repeat_customer: 'amber', order_changed: 'amber', opened_by_many: 'amber', not_refund_case: 'grey' });
});

// ── U12. link state + status view ──────────────────────────────
t('U12 linkState in the spec\'s order; the status view lasts 90 days (Q4)', () => {
  const now = Date.parse('2026-10-05T10:00:00Z');
  const future = '2026-10-09T10:00:00Z', past = '2026-10-01T10:00:00Z';
  eq(rules.linkState({ status: 'submitted', expires_at: past }, now), 'submitted', 'submitted beats expired');
  eq(rules.linkState({ status: 'revoked', revoked_reason: 'reissued', expires_at: future }, now), 'replaced');
  eq(rules.linkState({ status: 'revoked', revoked_reason: 'cancelled', expires_at: future }, now), 'cancelled');
  eq(rules.linkState({ status: 'active', expires_at: past }, now), 'expired');
  eq(rules.linkState({ status: 'active', expires_at: new Date(now).toISOString() }, now), 'expired', 'expires_at <= now');
  eq(rules.linkState({ status: 'active', expires_at: new Date(now + 1).toISOString() }, now), 'open');
  eq(rules.linkState({ status: 'active', expires_at: 'garbage' }, now), 'expired', 'unreadable = expired');
  eq(rules.statusViewOpen('2026-07-08T10:00:00Z', now), true, '89 days');
  eq(rules.statusViewOpen('2026-07-07T10:00:00Z', now), false, '90 days');
  eq(rules.STATUS_VIEW_DAYS, 90);
  eq(rules.LINK_DAYS, 7);
  ok(read('refund-forms.sql').includes("expires_at <= created_at + interval '7 days 1 minute'"), 'link life in SQL');
});

// ── U13. limits ────────────────────────────────────────────────
t('U13 rate limits: count then check; own globalThis map, 5,000 entries, oldest out', () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    limits.resetRefundLimits();
    ok(globalThis.__shiptrackRefundLimits instanceof Map, 'own map');
    ok(globalThis.__shiptrackRefundLimits !== globalThis.__shiptrackLookupFailures, 'not the verify-form map');
    deq([1, 2, 3, 4].map(() => limits.hit('k', 3, 1000)), [false, false, false, true]);
    eq(limits.limited('k', 4), true);
    eq(limits.limited('k', 5), false);
    eq(limits.limited('nobody', 1), false);
    for (let i = 0; i < 19; i++) limits.hit('rf:bad:ip', 20, 3_600_000);
    eq(limits.limited('rf:bad:ip', 20), false, '19 bad tokens');
    limits.hit('rf:bad:ip', 20, 3_600_000);
    eq(limits.limited('rf:bad:ip', 20), true, 'the 21st request gets 429');
    now += 3_600_001;
    eq(limits.limited('rf:bad:ip', 20), false, 'the window passed');
    eq(limits.hit('k', 3, 1000), false, 'a new window');
    limits.resetRefundLimits();
    for (let i = 0; i < 5001; i++) limits.hit(`ip:${i}`, 1, 60_000);
    ok(limits.refundLimitEntries() <= 5000, 'capped');
    eq(limits.limited('ip:0', 1), false, 'the oldest went first');
    eq(limits.limited('ip:5000', 1), true, 'the newest stays');
    deq(limits.REFUND_LIMITS.bad, { max: 20, windowMs: 3_600_000 });
    deq(limits.REFUND_LIMITS.open_ip, { max: 30, windowMs: 600_000 });
    deq(limits.REFUND_LIMITS.open_tok, { max: 60, windowMs: 86_400_000 });
    deq([limits.REFUND_LIMITS.submit_tok.max, limits.REFUND_LIMITS.submit_ip.max, limits.REFUND_LIMITS.reveal.max], [10, 20, 30]);
    deq(Object.keys(limits.REFUND_LIMITS).sort(), ['bad', 'open_ip', 'open_tok', 'reveal', 'submit_ip', 'submit_tok'], 'no file / part limits (no upload)');
    eq(limits.hash8('0123456789abcdef'), '01234567');
  } finally {
    Date.now = realNow;
    limits.resetRefundLimits();
  }
});

// ── U14. refund-forms.sql ──────────────────────────────────────
t('U14 refund-forms.sql: additive, idempotent, guarded and granted; CHECKs = the code', () => {
  const sql = sqlLines('refund-forms.sql');
  ok(!/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b/i.test(sql), 'destructive statement outside comments');
  ok(!/^\s*UPDATE\s+\w+\s+SET/im.test(sql), 'UPDATE ... SET');
  ok(/SET lock_timeout = '5s'/.test(sql), 'lock_timeout');
  const creates = sql.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\b[^\n]*/gi) || [];
  ok(creates.length >= 20, String(creates.length));
  for (const c of creates) ok(/IF NOT EXISTS/i.test(c), c.slice(0, 60));
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();
  deq(tables, ['refund_events', 'refund_file_parts', 'refund_files', 'refund_links', 'refund_requests']);
  const fns = sql.match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+\w+/gi) || [];
  eq(fns.length, 4);
  for (const m of fns) ok(/OR REPLACE/i.test(m), m);
  const trg = (sql.match(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+(\w+)/gi) || []).map((x) => x.split(/\s+/).pop()).sort();
  deq(trg, ['trg_refund_file_guard', 'trg_refund_link_guard', 'trg_refund_part_guard', 'trg_refund_request_guard']);
  const grant = (tb) => (sql.match(new RegExp(`GRANT ([A-Z, ]+?)\\s+ON ${tb}\\s+TO tracker_user`)) || [])[1];
  deq(sqlList(grant('refund_links')), ['SELECT', 'INSERT', 'UPDATE'], 'links: no DELETE');
  deq(sqlList(grant('refund_requests')), ['SELECT', 'INSERT', 'UPDATE'], 'requests: no DELETE');
  deq(sqlList(grant('refund_files')), ['SELECT'], 'files: read-only, no upload (owner change 2026-10-02 ~15:00)');
  deq(sqlList(grant('refund_file_parts')), ['SELECT'], 'file parts: read-only, no upload');
  ok(/refund_files\s+NOT USED/.test(read('refund-forms.sql')), 'the header says the file tables are not used');
  deq(sqlList(grant('refund_events')), ['SELECT', 'INSERT'], 'events: append-only');
  ok(/GRANT USAGE, SELECT ON SEQUENCE refund_events_id_seq\s+TO tracker_user/.test(sql), 'sequence');
  ok(!/REFERENCES\s+(conversations|orders|sites|businesses)\b/.test(sql), 'no foreign key to chat / order tables');
  deq(sqlList(sql.match(/reason\s+text NOT NULL CHECK \(reason IN \(([^)]*)\)\)/)[1]), rules.REASONS);
  for (const m of sql.matchAll(/\(reason = '(\w+)' AND sub_reason IN \(([^)]*)\)\)/g)) deq(sqlList(m[2]), rules.SUB_REASONS[m[1]], m[1]);
  ok(/\(reason = 'damaged' AND sub_reason IS NULL\)/.test(sql), 'damaged');
  ok(/NOT checked_around OR \(reason = 'not_received' AND sub_reason = 'shows_delivered'\)/.test(sql), 'Q12 in SQL');
  deq(sqlList(sql.match(/status\s+text NOT NULL DEFAULT 'new' CHECK \(status IN \(([^)]*)\)\)/)[1]), rules.STATUSES);
  ok(sql.includes(`char_length(details) BETWEEN ${rules.DETAILS_MIN} AND ${rules.DETAILS_MAX}`), 'details');
  ok(sql.includes(`char_length(note) <= ${rules.NOTE_MAX}`), 'note');
  ok(sql.includes(`char_length(return_note) <= ${rules.RETURN_NOTE_MAX}`), 'return note');
  ok(sql.includes("utr ~ '^[A-Z0-9]{8,30}$'") && rules.UTR_RE.source === '^[A-Z0-9]{8,30}$', 'UTR');
  ok(sql.includes("CHECK (created_by = 'owner')") && sql.includes("status_by IS NULL OR status_by = 'owner'"), 'only the owner');
  ok(/refund_requests_one_open ON refund_requests \(business_id, order_id\) WHERE status IN \('new', 'approved', 'refunded'\)/.test(sql), 'one open request');
  ok(/refund_links_one_active ON refund_links \(business_id, order_id\) WHERE status = 'active'/.test(sql), 'one active link');
  const kinds = sqlList(sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS refund_events')).match(/kind\s+text NOT NULL CHECK \(kind IN \(([^)]*)\)\)/)[1].replace(/\s+/g, ' '));
  ok(kinds.includes('rekey') && kinds.includes('submitted') && kinds.length === 19, 'event kinds');
  ok(/current_setting\('shiptrack\.refund_rekey', true\)/.test(sql), 'the re-key switch');
  eq((sql.match(/ERRCODE = '23514'/g) || []).length, 12, 'every guard raises check_violation');
});

// ── U15. the rolled-back trial ─────────────────────────────────
t('U15 refund-sql-trial.sql: refuses to run outside a transaction, runs as tracker_user, T1-T11', () => {
  const raw = read('scripts/refund-sql-trial.sql');
  const sql = raw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  ok(sql.indexOf('txid_current_if_assigned() IS NULL') < sql.indexOf('SET LOCAL ROLE tracker_user'), 'the guard comes first');
  ok(/SET LOCAL ROLE tracker_user;/.test(sql), 'grants are tested');
  for (let i = 1; i <= 11; i++) ok(new RegExp(`RAISE NOTICE 'T${i} PASS`).test(sql), `T${i}`);
  ok(!/WHEN OTHERS/i.test(sql), 'only the expected SQLSTATEs are caught');
  ok(!/^\s*(COMMIT|ROLLBACK|BEGIN)\s*;/im.test(sql), 'no BEGIN / COMMIT / ROLLBACK inside (the caller wraps it)');
  ok(!/\bFROM\s+(orders|conversations|messages|sites)\b/i.test(sql), 'never reads customer tables');
  ok(/'RF-000001'/.test(sql) && /'RF-000002'/.test(sql), 'the spec\'s refs');
  const refs = [...sql.matchAll(/'(RF-[^']*)'/g)].map((m) => m[1]);
  ok(refs.includes('RF-00000I'), 'a ref with I is tried and refused');
  const t8 = sql.slice(sql.indexOf("RAISE NOTICE 'T7 PASS: tracker_user cannot DELETE refund_events'"), sql.indexOf("RAISE NOTICE 'T8 PASS"));
  for (const stmt of [/INSERT INTO refund_files /, /INSERT INTO refund_file_parts /, /UPDATE refund_files SET/, /DELETE FROM refund_files /]) {
    ok(stmt.test(t8), `T8 tries ${stmt.source}`);
  }
  eq((t8.match(/EXCEPTION WHEN insufficient_privilege THEN NULL;/g) || []).length, 4, 'T8: every file write is refused by the grants (no upload)');
});

// ── U16. slice-A isolation, logs, .env.example ─────────────────
t('U16 imports, secrets and logs in src/lib/refund (slice A files)', () => {
  const src = Object.fromEntries(MODULES.map((m) => [m, read(`src/lib/refund/${m}.ts`)]));
  const imports = (s) => [...s.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  deq(imports(src.rules), [], 'rules.ts has no imports');
  deq(imports(src['link-mask']), [], 'link-mask.ts has no imports');
  deq(imports(src.texts), ['./rules']);
  deq(imports(src.limits), []);
  deq(imports(src.crypto), ['crypto']);
  for (const [m, s] of Object.entries(src)) {
    ok(!/console\./.test(s), `${m}.ts logs nothing`);
    ok(!/AUTH_TOKEN_SECRET/.test(s.replace(/\/\/.*$/gm, '')), `${m}.ts never reads AUTH_TOKEN_SECRET`);
    if (m !== 'crypto') ok(!/REFUND_DATA_KEY/.test(s), `${m}.ts never reads the key`);
    ok(!/require\(|process\.env\.(?!REFUND_)/.test(s), `${m}.ts: no require / other env`);
  }
  ok(!/\.(log|info|warn|error)\(/.test(src.crypto), 'crypto.ts never logs');
  const env = read('.env.example');
  for (const k of ['REFUND_DATA_KEY', 'REFUND_DATA_KEY_OLD', 'REFUND_FORMS']) ok(new RegExp(`^${k}=$`, 'm').test(env), `${k}= (empty) in .env.example`);
  ok(env.indexOf('REFUND_DATA_KEY=') > env.indexOf('AUTH_TOKEN_SECRET='), 'after the AUTH block');
  for (const k of (src.crypto.match(/process\.env\.(\w+)/g) || [])) ok(env.includes(`${k.split('.').pop()}=`), `${k} listed`);
});

// ── U17. owner answers 2026-10-02 ──────────────────────────────
t('U17 owner answers: Q1 every order, Q3 no number, Q7 every Google Form, Q12 tick', () => {
  eq(rules.PREPAID_PAYOUT_ALLOWED, true, 'Q1: UPI / bank for every order (COD and prepaid)');
  eq(rules.needsCheckedAround('not_received', 'shows_delivered'), true, 'Q12');
  eq(rules.needsCheckedAround('not_received', 'never_came'), false);
  ok(lm.hasFormLink('https://docs.google.com/forms/d/e/OTHER-FORM/viewform') && lm.hasFormLink('forms.gle/x'), 'Q7: not only the refund form');
  ok(!/destBare|DEST_LINE|agar ye aapka nahi/i.test(read('src/lib/refund/texts.ts').replace(/\/\/.*$/gm, '')), 'Q3: no destination line in texts.ts');
  ok(!('PHOTO_MAX' in rules) && !('VIDEO_MAX' in rules), 'owner change ~15:00: no photo / video upload, so no limits for them');
  eq(rules.CONSENT_VERSION, 'v1-2026-10-02');
});

// ── U18. scripts/refund-rekey.js on a fake database ────────────
function fakeDb(state) {
  const log = { params: [], setConfigBeforeWrite: true, statements: [] };
  let inTx = false, rekeyOn = false, snap = null;
  const snapshot = () => ({
    requests: new Map([...state.requests].map(([k, v]) => [k, { ...v }])),
    files: new Map([...state.files].map(([k, v]) => [k, { ...v }])),
    parts: new Map(state.parts), events: state.events.length,
  });
  const guard = () => { if (!rekeyOn) { const e = new Error('refund guard'); e.code = '23514'; throw e; } };
  const query = async (text, params = []) => {
    const q = text.replace(/\s+/g, ' ').trim();
    log.statements.push(q);
    log.params.push(...params.map((p) => (Buffer.isBuffer(p) ? p.toString('latin1') : String(p))));
    const rows = (r) => ({ rows: r, rowCount: r.length });
    if (q === 'BEGIN') { inTx = true; rekeyOn = false; snap = snapshot(); return rows([]); }
    if (q === 'COMMIT') { inTx = false; rekeyOn = false; return rows([]); }
    if (q === 'ROLLBACK') {
      if (snap) { state.requests = snap.requests; state.files = snap.files; state.parts = snap.parts; state.events.length = snap.events; }
      inTx = false; rekeyOn = false; return rows([]);
    }
    if (q === "SET LOCAL lock_timeout = '5s'") return rows([]);
    if (q === "SELECT set_config('shiptrack.refund_rekey', 'on', true)") { if (inTx) rekeyOn = true; return rows([{ set_config: 'on' }]); }
    if (q === 'SELECT id FROM refund_requests WHERE payout_key_id <> $1 ORDER BY created_at, id') {
      return rows([...state.requests.values()].filter((r) => r.payout_key_id !== params[0]).map((r) => ({ id: r.id })));
    }
    if (q === 'SELECT id, payout_enc FROM refund_requests WHERE id = $1') return rows(state.requests.has(params[0]) ? [{ ...state.requests.get(params[0]) }] : []);
    if (q.startsWith('SELECT id, conversation_id, business_id, order_id, payout_enc, payout_key_id FROM refund_requests WHERE id = $1 FOR UPDATE')) {
      return rows(state.requests.has(params[0]) ? [{ ...state.requests.get(params[0]) }] : []);
    }
    if (q === 'SELECT customer_mobile FROM orders WHERE order_id = $1 AND business_id::text = $2::text LIMIT 2') {
      return rows(state.orders.filter((o) => o.order_id === params[0] && String(o.business_id) === String(params[1])).slice(0, 2).map((o) => ({ customer_mobile: o.customer_mobile })));
    }
    if (q.startsWith('UPDATE refund_requests SET payout_enc = $2, payout_key_id = $3, payout_fp = $4, phone_fp = $5 WHERE id = $1 AND payout_key_id = $6')) {
      guard();
      const r = state.requests.get(params[0]);
      if (!r || r.payout_key_id !== params[5]) return { rows: [], rowCount: 0 };
      Object.assign(r, { payout_enc: params[1], payout_key_id: params[2], payout_fp: params[3], phone_fp: params[4] });
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith('INSERT INTO refund_events')) {
      const meta = JSON.parse(params[2]);
      state.events.push(q.includes('(request_id, conversation_id') ? { request_id: params[0], conversation_id: params[1], meta } : { link_id: params[0], request_id: params[1], meta });
      return { rows: [], rowCount: 1 };
    }
    if (q === 'SELECT id FROM refund_files WHERE key_id <> $1 ORDER BY created_at, id') {
      return rows([...state.files.values()].filter((f) => f.key_id !== params[0]).map((f) => ({ id: f.id })));
    }
    if (q === 'SELECT id, key_id FROM refund_files WHERE id = $1') return rows(state.files.has(params[0]) ? [{ ...state.files.get(params[0]) }] : []);
    if (q === 'SELECT id, link_id, request_id, key_id FROM refund_files WHERE id = $1 FOR UPDATE') return rows(state.files.has(params[0]) ? [{ ...state.files.get(params[0]) }] : []);
    if (q === 'SELECT part FROM refund_file_parts WHERE file_id = $1 ORDER BY part') {
      return rows([...state.parts.keys()].filter((k) => k.startsWith(`${params[0]}:`)).map((k) => ({ part: Number(k.split(':')[1]) })).sort((a, b) => a.part - b.part));
    }
    if (q === 'SELECT data FROM refund_file_parts WHERE file_id = $1 AND part = $2') return rows([{ data: state.parts.get(`${params[0]}:${params[1]}`) }]);
    if (q === 'UPDATE refund_file_parts SET data = $3 WHERE file_id = $1 AND part = $2') {
      guard(); state.parts.set(`${params[0]}:${params[1]}`, params[2]); return { rows: [], rowCount: 1 };
    }
    if (q === 'UPDATE refund_files SET key_id = $2 WHERE id = $1') { guard(); state.files.get(params[0]).key_id = params[1]; return { rows: [], rowCount: 1 }; }
    if (q.startsWith('SELECT (SELECT count(*) FROM refund_requests WHERE payout_key_id <> $1) AS requests')) {
      return rows([{ requests: String([...state.requests.values()].filter((r) => r.payout_key_id !== params[0]).length),
        files: String([...state.files.values()].filter((f) => f.key_id !== params[0]).length) }]);
    }
    throw new Error(`unknown SQL: ${q.slice(0, 80)}`);
  };
  return { query, log };
}
ta('U18 refund-rekey.js: re-seals payouts and parts under the new key, fingerprints again, logs counts only', async () => {
  const { rekey } = require(path.join(ROOT, 'scripts/refund-rekey.js'));
  setKeys(K1);
  const k1 = rc.currentKeyId();
  const upi = { v: 1, method: 'upi', upi: 'test.user@okaxis', holder: 'TEST USER' };
  const mk = (id, payout, order) => {
    const s = rc.sealJson(payout, rc.payoutAad(id));
    const fpIn = rules.payoutFpInput(payout);
    return { id, conversation_id: `conv-${id.slice(-2)}`, business_id: 'biz-1', order_id: order, payout_enc: s.blob, payout_key_id: s.keyId,
      payout_fp: rc.fingerprint(fpIn.kind, fpIn.value), phone_fp: rc.fingerprint('phone', '9000000001'), created_at: id };
  };
  const state = { requests: new Map(), files: new Map(), parts: new Map(), events: [], orders: [{ order_id: '#T1', business_id: 'biz-1', customer_mobile: '+91 90000 00001' }] };
  state.requests.set(UUID(1), mk(UUID(1), upi, '#T1'));
  state.requests.set(UUID(2), mk(UUID(2), PAY, '#GONE'));
  const broken = mk(UUID(3), upi, '#T1');
  broken.payout_enc = flip(broken.payout_enc, 4);
  state.requests.set(UUID(3), broken);
  const plain = [nodeCrypto.randomBytes(2 * 1024 * 1024), Buffer.from('last part')];   // the script still handles parts (the tables stay empty)
  state.files.set(UUID(9), { id: UUID(9), link_id: UUID(20), request_id: UUID(1), key_id: k1, created_at: 1 });
  plain.forEach((p, i) => state.parts.set(`${UUID(9)}:${i}`, rc.sealPart(p, UUID(9), i)));

  setKeys(K2, K1);
  const k2 = rc.currentKeyId();
  const lines = [];
  const before = JSON.stringify([...state.requests.values()]);
  const dry = await rekey(fakeDb(state), { crypto: rc, rules }, { dry: true, log: (s) => lines.push(s) });
  eq(JSON.stringify([...state.requests.values()]), before, 'a dry run writes nothing');
  deq([dry.requests, dry.requestsFailed, dry.files, dry.parts, dry.left.requests, dry.left.files], [2, 1, 1, 2, 3, 1]);

  lines.length = 0;
  const db = fakeDb(state);
  const c = await rekey(db, { crypto: rc, rules }, { log: (s) => lines.push(s) });
  deq([c.requests, c.requestsFailed, c.files, c.parts, c.filesFailed, c.left.requests, c.left.files], [2, 1, 1, 2, 0, 1, 0]);
  deq(lines, [`[refund] rekey failed request ${UUID(3)} auth_failed`], 'one line: id + code');

  setKeys(K2);   // OLD removed: everything re-keyed reads with the new key alone
  const r1 = state.requests.get(UUID(1)), r2 = state.requests.get(UUID(2));
  deq(rc.openJson(r1.payout_enc, rc.payoutAad(UUID(1))), upi);
  deq(rc.openJson(r2.payout_enc, rc.payoutAad(UUID(2))), PAY);
  eq(r1.payout_key_id, k2);
  eq(r1.payout_fp, rc.fingerprint('upi', 'test.user@okaxis'), 'payout_fp with the new key');
  eq(r2.payout_fp, rc.fingerprint('bank', 'HDFC0001234:123456789012'));
  eq(r1.phone_fp, rc.fingerprint('phone', '9000000001'), 'phone_fp from the order now');
  eq(r2.phone_fp, null, 'order gone: NULL, as at submit');
  eq(state.requests.get(UUID(3)).payout_key_id, k1, 'the broken one is left as it was');
  eq(state.files.get(UUID(9)).key_id, k2);
  plain.forEach((p, i) => ok(rc.openPart(state.parts.get(`${UUID(9)}:${i}`), UUID(9), i, k2).equals(p), `part ${i}`));
  eq(state.events.length, 3);
  for (const e of state.events) ok(e.meta.from_key === k1 && e.meta.to_key === k2 && !JSON.stringify(e.meta).match(/okaxis|123456789012|TEST USER|9000000001/), 'event meta: ids only');
  for (const p of db.log.params) ok(!/test\.user@okaxis|123456789012|TEST USER|HDFC0001234/.test(p), 'no payout value in any SQL parameter');
  const writes = db.log.statements.filter((s) => /^UPDATE /.test(s)).length;
  eq(writes, 5, '2 requests + 2 parts + 1 file');

  setKeys(K2, K1);
  const again = await rekey(fakeDb(state), { crypto: rc, rules }, { log: () => {} });
  deq([again.requests, again.files, again.requestsFailed], [0, 0, 1], 'a second run only retries the broken row');

  const script = read('scripts/refund-rekey.js');
  for (const l of script.split('\n').filter((x) => /console\.(log|error)\(/.test(x))) {
    for (const m of l.matchAll(/\$\{([^}]*)\}/g)) ok(/^(c\.[\w.]+|verb|codeOf\(e\))$/.test(m[1].trim()), 'a console line prints counts / codes only');
  }
  ok(/set_config\('shiptrack\.refund_rekey', 'on', true\)/.test(script), 'the re-key switch is per transaction (is_local = true)');
  setKeys(K1);
});

(async () => {
  for (const [name, fn] of tAsync) {
    try { await fn(); n++; } catch (e) { failed.push(name.split(' ')[0]); console.log(`FAIL ${name}: ${clean(String(e && e.message).split('\n')[0]).slice(0, 300)}`); }
  }
  setKeys(undefined);
  if (failed.length) {
    console.log(`REFUND UNIT: ${failed.length} failed (${failed.join(', ')}), ${n} passed`);
    process.exit(1);
  }
  console.log(`REFUND UNIT: ${n} groups passed`);
})();
