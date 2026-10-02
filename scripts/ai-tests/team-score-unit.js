// Team score, part 4 (owner, 2026-10-01): the pure rules only, no database, no routes, no model.
//   C1  clock.ts: office minutes 10:00-19:30 IST, India days, no Date getters / Intl.
//   W1  words.ts keywordThanks (zero "sure but wrong" allowed)     W2  keywordConvinced
//   W3  the helper words (objection, sign-off, holding reply, asks for thanks, trivial, came back)
//   W4  email quote / sign-off strip                               W5  what the AI judge is sent
//   W6  rules.ts constants, weights, settings rows                 W7  waitingSince = inbox WAITING_SINCE_SQL
//   W8  isolation: nothing outside the team-score files reads the new tables or modules
//   W9  team-score.sql: additive, idempotent, granted, never blocks the app
//   W10 owner answers 2026-10-02: weights (A2), points from the install day (A4), verified = the app's test (A3)
//   W11 review fixes 2026-10-02: a polite "ok thank u" in any spelling, more holding lines, a courtesy
//       nudge after an unanswered question still waits
// The engine (engine.ts) is tested on synthetic chats in team-score-engine.js.
// TEAM_SCORE_JS_DIR (set by team-score-mutate.js only) loads already compiled, mutated modules.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');
const SRC = {
  'office-hours': 'src/lib/office-hours.ts', 'health-rules': 'src/lib/chat/health-rules.ts',
  escalation: 'src/lib/chat/escalation.ts', waiting: 'src/lib/chat/waiting.ts', 'waiting-sql': 'src/lib/chat/waiting-sql.ts',
  types: 'src/lib/team-score/types.ts', clock: 'src/lib/team-score/clock.ts', words: 'src/lib/team-score/words.ts',
  rules: 'src/lib/team-score/rules.ts', engine: 'src/lib/team-score/engine.ts',
};
let dir = process.env.TEAM_SCORE_JS_DIR;
if (!dir) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-score-unit-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  for (const [name, rel] of Object.entries(SRC)) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/'@\/lib\/office-hours'/g, "'./office-hours'").replace(/'@\/lib\/chat\/([\w-]+)'/g, "'./$1'");
    fs.writeFileSync(path.join(dir, name + '.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText);
  }
}
const load = (name) => require(path.join(dir, name + '.js'));
const clock = load('clock'), words = load('words'), rules = load('rules'), hr = load('health-rules'), waiting = load('waiting'), wsql = load('waiting-sql');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let n = 0;
const failed = [];
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { failed.push(name); console.log(`FAIL ${name}: ${String(e && e.message).split('\n')[0].slice(0, 300)}`); }
};
const ist = (s) => Date.parse(s.replace(' ', 'T') + ':00+05:30');
const M = 60_000;
// Every input of a table must give exactly the expected value.
const table = (fn, rows) => { for (const [exp, inputs] of rows) for (const x of inputs) assert.strictEqual(fn(x), exp, JSON.stringify(x)); };

// ── C1. clock ──────────────────────────────────────────────────
t('C1 officeMs: only 10:00-19:30 IST counts', () => {
  const o = clock.officeMs;
  assert.strictEqual(o(ist('2026-10-05 10:00'), ist('2026-10-05 19:30')), 570 * M);
  assert.strictEqual(o(ist('2026-10-05 09:00'), ist('2026-10-05 11:00')), 60 * M);
  assert.strictEqual(o(ist('2026-10-05 19:00'), ist('2026-10-06 10:30')), 60 * M);
  assert.strictEqual(o(ist('2026-10-05 19:30'), ist('2026-10-06 10:00')), 0);
  assert.strictEqual(o(ist('2026-10-05 22:00'), ist('2026-10-06 12:00')), 120 * M);
  assert.strictEqual(o(ist('2026-10-05 00:00'), ist('2026-10-08 00:00')), 1710 * M);
  assert.strictEqual(o(ist('2026-10-06 00:00'), ist('2026-10-05 00:00')), 0);
  assert.strictEqual(o(ist('2026-10-05 12:00'), ist('2026-10-05 12:00')), 0);
  assert.strictEqual(o(ist('2026-10-05 19:29'), ist('2026-10-05 23:59')), 1 * M);       // the 19:30 close
  assert.strictEqual(o(ist('2026-10-05 18:50'), ist('2026-10-06 11:20')), 120 * M);     // 40 + 80 (E5)
  assert.strictEqual(o(ist('2026-10-05 19:00'), ist('2026-10-06 11:29')), 119 * M);     // 30 + 89 (edge case 29)
  assert.strictEqual(o(ist('2026-10-05 19:25'), ist('2026-10-06 10:04')), 9 * M);       // 5 + 4 (E3)
});
t('C1 addOfficeMs: the inverse of officeMs', () => {
  assert.strictEqual(clock.addOfficeMs(ist('2026-10-05 19:25'), 10 * M), ist('2026-10-06 10:05'));
  assert.strictEqual(clock.addOfficeMs(ist('2026-10-05 22:00'), 120 * M), ist('2026-10-06 12:00'));
  assert.strictEqual(clock.addOfficeMs(ist('2026-10-05 08:00'), 30 * M), ist('2026-10-05 10:30'));
  assert.strictEqual(clock.addOfficeMs(ist('2026-10-05 18:50'), 40 * M), ist('2026-10-05 19:30'));
  assert.strictEqual(clock.addOfficeMs(ist('2026-10-05 12:34'), 0), ist('2026-10-05 12:34'));
  assert.strictEqual(clock.addOfficeMs(ist('2026-10-05 12:34'), -5), ist('2026-10-05 12:34'));
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 500; i++) {
    const a = ist('2026-10-01 00:00') + Math.floor(rnd() * 10 * 86_400_000);
    const need = Math.floor(rnd() * 3000) * M + Math.floor(rnd() * 60_000);
    const b = clock.addOfficeMs(a, need);
    assert.strictEqual(clock.officeMs(a, b), need, `pair ${i}`);
    if (need > 0) assert.ok(clock.officeMs(a, b - 1) < need, `pair ${i} not the smallest`);
  }
});
t('C1 India days, labels, and no Date getters / Intl in clock.ts', () => {
  assert.strictEqual(clock.istDay(Date.parse('2026-10-01T18:29:59.999Z')), '2026-10-01');
  assert.strictEqual(clock.istDay(Date.parse('2026-10-01T18:30:00Z')), '2026-10-02');
  assert.strictEqual(clock.istDayStart(ist('2026-10-05 23:59')), ist('2026-10-05 00:00'));
  assert.strictEqual(clock.istDayStart(ist('2026-10-05 00:00')), ist('2026-10-05 00:00'));
  assert.strictEqual(clock.dayStartMs('2026-13-01'), null);
  assert.strictEqual(clock.dayStartMs('abc'), null);
  assert.strictEqual(clock.dayStartMs('2026-02-31'), null);
  assert.strictEqual(clock.dayStartMs('2026-10-5'), null);
  assert.strictEqual(clock.dayStartMs('2026-10-05'), ist('2026-10-05 00:00'));
  assert.strictEqual(clock.openMs('2026-10-05'), ist('2026-10-05 10:00'));
  assert.strictEqual(clock.closeMs('2026-10-05'), ist('2026-10-05 19:30'));
  assert.strictEqual(clock.addDays('2026-10-31', 1), '2026-11-01');
  assert.strictEqual(clock.addDays('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(clock.hhmm(ist('2026-10-05 14:05')), '14:05');
  assert.strictEqual(clock.hhmm(ist('2026-10-05 00:00')), '00:00');
  assert.strictEqual(clock.dayLabel('2026-10-02'), '2 Oct');
  assert.strictEqual(clock.todayIst(Date.parse('2026-10-01T18:30:00Z')), '2026-10-02');
  assert.strictEqual(clock.IST_MS, 330 * M);
  assert.ok(!/getHours|setHours|toLocale|Intl\./.test(read('src/lib/team-score/clock.ts')));
});

// ── W1. keywordThanks ──────────────────────────────────────────
t('W1 keywordThanks: yes / no / unsure (41 rows; no sure-but-wrong)', () => {
  const rows = [
    ['yes', ['Thank you so much', 'thanku bhaiya', 'shukriya ji', 'bahut bahut dhanyavad', 'धन्यवाद', '🙏', 'mil gaya thanks',
      'thx a lot', 'ok thanks', 'ok got it thanks', 'Thanks a lot!', 'thank u', 'tysm', 'thanks bhai', 'Thank you!', 'Thanks, got it',
      'thnx', 'शुक्रिया', 'thank you sir 🙏', 'Thank you for the quick help', 'dhanyawad', 'Okay thanks', 'Thankyou', 'thank you mam']],
    ['no', ['ok', 'kab aayega?', '1234', '', 'thik hai', 'hello', 'where is my order', 'size chart bhejo', 'I want to return this']],
    ['unsure', ['no thanks', 'thanks for nothing', 'thanks a lot fraud company', 'thanks but kab aayega?', 'ok thanks, when will refund come',
      'thank you 🙄', 'thank you for wasting my time', 'wah kya service hai, thanks', 'thanks, but the size is wrong', 'thanks?',
      'thank you 😡', 'thanks, I will file a complaint in consumer court', 'thanks but still not received',
      'Thanks for the update, when will it arrive', 'Thanks. Still waiting for my order']],
  ];
  assert.ok(rows.reduce((s, r) => s + r[1].length, 0) >= 40);
  table(words.keywordThanks, rows);
});
// A thank-you tacked onto a NEW request is the customer still waiting, not a reaction to the answer
// (JUDGE_INSTRUCTION: "not only a polite ok while still waiting"). A sure 'yes' here would pay +3 to
// whoever answered last and stop the 2-hour clock. The keywords may not decide it: 'unsure' (AI).
t('W1 keywordThanks: a request ending in thanks is never a sure thank-you', () => {
  table(words.keywordThanks, [['unsure', [
    'Please share the tracking link. Thank you', 'Please check my order status. Thank you', 'Pls send size chart thanks',
    'Mujhe exchange karna hai thank you', 'I want to return this, thanks', 'share the invoice please, thanks in advance',
    'Size M chahiye thanks', 'Thanks. Also I want to change the size to L', 'Hi, I have not got my order yet. Please check. Thank you',
    'Kindly update me on my refund. Thanks', 'I haven\'t received my order yet. Please check. Thank you',
  ]]]);
});

// ── W2. keywordConvinced ───────────────────────────────────────
t('W2 keywordConvinced', () => {
  const long = 'my brother will come to collect the parcel from the office next week if possible maybe later today';
  assert.strictEqual(long.split(' ').length >= 15, true);
  table(words.keywordConvinced, [
    ['yes', ['ok theek hai wait karunga', 'mil gaya thanks', 'got it', 'samajh gaya bhai', 'cancel mat karo main wait kar lungi', 'ठीक है',
      'koi baat nahi', 'ok', 'refund nahi chahiye, wait kar lunga', 'understood', 'no problem', 'received, thanks']],
    ['no', ['abhi tak nahi aaya', 'refund chahiye', 'kab tak?', '#1234', 'fraud company', 'size L hai?', 'still not received', '']],
    ['unsure', ['Okay I will wait but please make sure it reaches by Monday as it is a gift?', long]],
  ]);
});

// ── W3. Helpers ────────────────────────────────────────────────
t('W3 isObjection', () => table(words.isObjection, [
  [true, ['refund chahiye', 'fraud', 'abhi tak nahi aaya', 'kab tak milega', 'cancel my order', 'still not received', 'wrong size bheja']],
  [false, ['thanks', 'size L hai?', 'where is my order?', 'kab aayega?', 'ok']],
]));
t('W3 isSignOff: a happy last word only', () => table(words.isSignOff, [
  [true, ['ok got it thanks', 'theek hai', '🙏', '👍', 'ok', 'thank you so much', 'samajh gaya', 'bye', 'ok sir']],
  // A nudge ("hello?", "hi", an angry face) is the customer still waiting, the inbox agrees.
  [false, ['ok thanks, kab tak aayega?', 'still not received', 'hello?', 'hello', 'hi', 'hii', 'hello sir??', 'ok?', '😡', 'where is my order',
    'Please check my order status. Thank you']],
]));
t('W3 isHoldingReply', () => table(words.isHoldingReply, [
  [true, ['We will check and update you', 'let me check', 'please wait', 'check karke batata hu', 'team ko forward kar diya',
    "I'll confirm with the courier and get back", 'dekh ke batata hu', 'Issue escalated to the courier']],
  [false, ['Your order will be delivered by 5 Oct', 'Aapka order kal aa jayega', 'Refund processed today', 'thanks for waiting']],
]));
t('W3 asksForThanks', () => table(words.asksForThanks, [
  [true, ['please say thanks if this helped', 'agar help hui to thank you bol dena', 'agar help hui ho to thank you bol dena',
    'kindly rate us 5 stars', 'feedback de do', '5 star dena', 'Thank you likh do please']],
  [false, ['thanks for your patience', 'thank you for waiting', 'thanks for sharing', 'please share your order number', 'Thank you, your order is on the way']],
]));
t('W3 isTrivialReply', () => table(words.isTrivialReply, [
  [true, ['hi', 'ok', '👍', '.', 'ji', 'Hello', 'thanks', '', 'ok sir']],
  [false, ['Order shipped today', 'Kal aayega', 'Refund done']],
]));
t('W3 cameBack', () => {
  for (const x of ['ok', 'thanks', 'mil gaya', 'theek hai', '👍']) assert.strictEqual(words.cameBack(x, false), false, x);
  for (const x of ['still not received', 'do you have size L', 'abhi tak nahi aaya', 'mujhe exchange karna hai']) assert.strictEqual(words.cameBack(x, false), true, x);
  assert.strictEqual(words.cameBack('do you have size L', true), false);   // the SQL no-reply flag wins
});
t('W3 acceptsClose: auto-close counts after thanks / mil gaya / theek hai, not a bare ok', () => {
  table(words.acceptsClose, [[true, ['thanks', 'theek hai', 'mil gaya', 'got it', 'ok thanks']], [false, ['ok', 'okay', 'k', 'kab aayega', '']]]);
});

t('W11 isPoliteAck: "ok thanks" in any common spelling, nothing more', () => table(words.isPoliteAck, [
  [true, ['ok thanks', 'ok thank u', 'ok thanku', 'ok thnx', 'ok tq', 'ok thanks bhaiya', 'ok sir thank u', 'Thank you!', '🙏', 'ok thank you sir 🙏']],
  [false, ['thank you so much mil gaya', 'ok thanks, kab aayega?', 'thanks but when', 'order kab aayega', 'ok thanks please send the bill']],
]));
t('W11 isHoldingReply: "Dekhta hu", "check kar raha hu", "ek minute"; never a bare "checking"', () => table(words.isHoldingReply, [
  [true, ['Dekhta hu', 'ruko check kar raha hu', 'Checking, ek minute', 'dekh raha hu', 'ek min sir', 'Main dekhti hun']],
  [false, ['After checking, your order arrives on 7 Oct', 'Your order arrives in 1 week', 'Aapka order 11 min me nahi, kal aayega', 'We checked: it is out for delivery']],
]));
// ── W4. Email ──────────────────────────────────────────────────
t('W4 stripEmailQuote', () => {
  assert.strictEqual(words.stripEmailQuote('Where is my order?\n\nThanks,\nRam'), 'Where is my order?');
  assert.strictEqual(words.stripEmailQuote('Got it, thank you\n\nOn Mon, 5 Oct 2026 at 10:00, Vastora <a@b.com> wrote:\n> old text\n> more'), 'Got it, thank you');
  assert.strictEqual(words.stripEmailQuote('Fine\n> quoted line\nok'), 'Fine\nok');
  assert.strictEqual(words.stripEmailQuote('Received\n-----Original Message-----\nFrom: x'), 'Received');
  assert.strictEqual(words.stripEmailQuote('Thank you so much, got it'), 'Thank you so much, got it');
  assert.strictEqual(words.stripEmailQuote('Need an exchange\nRegards'), 'Need an exchange');
  assert.strictEqual(words.keywordThanks(words.stripEmailQuote('Where is my order?\n\nThanks,\nRam')), 'no');
});

// ── W5. What the AI judge sees ─────────────────────────────────
t('W5 buildJudgeInput masks personal data and caps each part at 500 code points', () => {
  const s = words.buildJudgeInput('Call +91 98765 43210 or mail a@b.com see https://x.y order #12345 awb ST1234567', '😀'.repeat(900));
  assert.ok(!/98765|43210|a@b\.com|https|#12345|ST1234567/.test(s), s);
  for (const tag of ['[phone]', '[email]', '[link]', '[order]', '[tracking id]']) assert.ok(s.includes(tag), tag);
  assert.ok(s.startsWith('TEAM: '));
  const [team, cust] = s.split('\nCUSTOMER: ');
  assert.ok(Array.from(cust).length <= 500 && Array.from(team.slice(6)).length <= 500);
  assert.strictEqual(Array.from(cust).length, 500);
  assert.strictEqual(words.maskForJudge('a   b\n\nc'), 'a b c');
  assert.strictEqual(words.maskForJudge('9876543210'), '[phone]');
  assert.strictEqual(words.maskForJudge('ref 1234567'), 'ref [number]');
});
t('W5 the judge prompt carries no names, points or scores', () => {
  const s = words.buildJudgeInput('Anurag here, order arrives Monday', 'thanks but kab?');
  for (const w of ['Rahul', 'points', 'score']) assert.ok(!words.JUDGE_INSTRUCTION.includes(w) && !s.includes(w), w);
  assert.ok(!words.JUDGE_INSTRUCTION.includes('Anurag'));
  assert.ok(/THANKS=yes\|no CONVINCED=yes\|no$/.test(words.JUDGE_INSTRUCTION));
});
t('W5 parseJudgeReply', () => {
  assert.deepStrictEqual(words.parseJudgeReply('THANKS=yes CONVINCED=no'), { thanks: true, convinced: false });
  assert.deepStrictEqual(words.parseJudgeReply('convinced: YES thanks: no.'), { thanks: false, convinced: true });
  assert.deepStrictEqual(words.parseJudgeReply('<think>x</think>THANKS=no CONVINCED=yes'), { thanks: false, convinced: true });
  assert.deepStrictEqual(words.parseJudgeReply('<think>THANKS=yes CONVINCED=yes</think>THANKS=no CONVINCED=no'), { thanks: false, convinced: false });
  for (const x of ['', 'maybe', 'THANKS=yes', 'CONVINCED=no', null, undefined]) assert.strictEqual(words.parseJudgeReply(x), null, String(x));
});

// ── W6. Rules ──────────────────────────────────────────────────
t('W6 the owner\'s numbers (Q11) and limits', () => {
  assert.strictEqual(rules.ANGRY_MIN, hr.HEALTH_PIN_MIN);
  assert.strictEqual(rules.ANGRY_MIN, 65);
  assert.deepStrictEqual(
    [rules.FAST_REPLY_MIN, rules.UNANSWERED_MIN, rules.TAKEN_NO_REPLY_MIN, rules.ANGRY_HELD_MIN, rules.MAX_RANGE_DAYS, rules.LOOKBACK_DAYS, rules.MSG_LOOKBACK_DAYS],
    [10, 120, 30, 60, 31, 3, 30]);
  const H = 3_600_000;
  assert.deepStrictEqual(
    [rules.THANKS_WINDOW_MS, rules.SOLVED_QUIET_MS, rules.SOLVED_REPLY_WITHIN_MS, rules.OBJECTION_LOOKBACK_MS, rules.SOLICIT_LOOKBACK_MS, rules.SETTLE_AFTER_MS, rules.AI_GRACE_MS],
    [24 * H, 24 * H, 72 * H, 72 * H, 24 * H, 49 * H, 96 * H]);
  assert.deepStrictEqual([rules.JUDGE_MAX_PER_RUN, rules.JUDGE_MAX_PER_DAY, rules.JUDGE_FAIL_LIMIT, rules.JUDGE_WINDOW_DAYS], [40, 300, 3, 4]);
  assert.strictEqual(rules.OWNER_RANKED, false);
  assert.ok(!('JUDGE_MODELS' in rules));   // lead override: judge.ts uses attemptOrder() from @/lib/chat/ai
});
t('W6 DEFAULT_WEIGHTS equal the SQL seed; keys and labels line up', () => {
  const j = JSON.parse(read('team-score.sql').match(/'(\{"thanks"[^']+\})'::jsonb/)[1]);
  assert.deepStrictEqual(j, rules.DEFAULT_WEIGHTS);
  assert.deepStrictEqual(Object.keys(rules.DEFAULT_WEIGHTS).sort(), [...rules.WEIGHT_KEYS].sort());
  assert.deepStrictEqual(Object.keys(rules.POINT_LABELS).sort(), [...rules.WEIGHT_KEYS].sort());
  const lines = rules.rulesHinglish(rules.DEFAULT_WEIGHTS);
  assert.ok(lines[0].startsWith('+3 ') && lines[1].startsWith('+2 ') && lines[2].startsWith('+1 ') && lines[3].startsWith('-3 ') && lines[4].startsWith('-2 '), lines.join('|'));
  assert.ok(lines.every((l) => !/\{\w+\}/.test(l)));
});
t('W6 validateWeights', () => {
  for (const bad of [{ nope: 1 }, { thanks: 10.5 }, { thanks: 0.3 }, { thanks: '3' }, { thanks: NaN }, { thanks: Infinity }, { angry: -11 }, null, [], 'x', 3]) {
    assert.strictEqual(rules.validateWeights(bad).ok, false, JSON.stringify(bad));
  }
  assert.deepStrictEqual(rules.validateWeights({}), { ok: true, weights: rules.DEFAULT_WEIGHTS });
  const v = rules.validateWeights({ thanks: 5, angry: -2.5, solved: -10, convinced: 10 });
  assert.deepStrictEqual(v, { ok: true, weights: { ...rules.DEFAULT_WEIGHTS, thanks: 5, angry: -2.5, solved: -10, convinced: 10 } });
});
t('W6 settingsForDay / pointsFrom', () => {
  const rows = [
    { id: 1, effectiveFrom: '2026-01-01', pointsFrom: '2026-10-03' },
    { id: 2, effectiveFrom: '2026-10-06', pointsFrom: '2026-10-03' },
    { id: 3, effectiveFrom: '2026-10-05', pointsFrom: '2026-10-04' },
  ];
  assert.strictEqual(rules.settingsForDay(rows, '2026-10-04').id, 1);
  assert.strictEqual(rules.settingsForDay(rows, '2026-10-05').id, 3);
  assert.strictEqual(rules.settingsForDay(rows, '2026-10-06').id, 3);   // max id with effectiveFrom <= day
  assert.strictEqual(rules.settingsForDay(rows, '2025-01-01').id, 1);   // nothing yet: the first row
  assert.strictEqual(rules.settingsForDay([rows[1], rows[0]], '2026-10-05').id, 1);
  assert.strictEqual(rules.pointsFrom(rows), '2026-10-04');
  assert.ok(rules.isHumanStatus('human_needed') && rules.isHumanStatus('agent_handling'));
  assert.ok(!rules.isHumanStatus('ai_handling') && !rules.isHumanStatus('resolved') && !rules.isHumanStatus(null));
});

// ── W7. waitingSince = the inbox's WAITING_SINCE_SQL ───────────
const NOREPLY = new RegExp(waiting.NO_REPLY_NEEDED_REGEX.replace(/\[:space:\]/g, '\\s'), 'i');
const AINOT = new RegExp(waiting.AI_NOT_AN_ANSWER_REGEX, 'i');
t('W7 WAITING_SINCE_SQL still has the shape the port copies', () => {
  const q = wsql.WAITING_SINCE_SQL.replace(/\s+/g, ' ').trim();
  const parts = [
    "CASE WHEN c.status = 'resolved' OR w.last_visitor_at IS NULL THEN NULL",
    'WHEN w.last_agent_at IS NOT NULL AND w.last_agent_at > w.last_visitor_at THEN NULL',
    "WHEN c.status = 'human_needed' AND w.last_agent_at IS NULL THEN w.last_visitor_at",
    `WHEN w.last_visitor_text ~* '${waiting.NO_REPLY_NEEDED_REGEX}' THEN NULL`,
    `WHEN c.status = 'human_needed' OR w.last_sender = 'visitor' OR (w.last_sender = 'ai' AND w.last_ai_text ~* '${waiting.AI_NOT_AN_ANSWER_REGEX}') THEN w.last_visitor_at`,
    'END',
  ];
  assert.strictEqual(q, parts.join(' '));
  for (const x of ['ok', 'Thanks!', 'theek hai', ' ji. ']) assert.ok(NOREPLY.test(x), x);
  for (const x of ['ok got it thanks', 'hello', 'kab aayega']) assert.ok(!NOREPLY.test(x), x);
});
const S = (o) => Object.assign({ lvAt: 100, lvNoReply: false, lvText: 'kab aayega', laAt: null, lastSender: 'visitor', lastAiNotAnswer: false }, o);
t('W7 waitingSince: 22 hand-derived rows', () => {
  const rows = [
    [S({}), 'resolved', null],                                                        // closed
    [S({ lvAt: null }), 'human_needed', null],                                        // no customer message
    [S({ laAt: 200, lastSender: 'agent' }), 'agent_handling', null],                  // agent after visitor
    [S({ laAt: 200, lastSender: 'agent' }), 'human_needed', null],
    [S({ lvNoReply: true, lvText: 'ok' }), 'human_needed', 100],                      // Needs you, no team reply: even "ok" waits
    [S({ lastSender: 'ai' }), 'human_needed', 100],                                   // AI "the team will reply" is no team answer
    [S({ laAt: 50 }), 'human_needed', 100],
    [S({ laAt: 50, lvNoReply: true, lvText: 'ok' }), 'human_needed', null],
    [S({ laAt: 50, lastSender: 'ai' }), 'human_needed', 100],
    [S({ laAt: 50 }), 'agent_handling', 100],
    [S({ laAt: 50, lastSender: 'ai' }), 'agent_handling', null],                      // AI real answer last
    [S({ laAt: 50, lastSender: 'ai', lastAiNotAnswer: true }), 'agent_handling', 100],// AI busy reply last
    [S({}), 'ai_handling', 100],
    [S({ lastSender: 'ai' }), 'ai_handling', null],
    [S({ lastSender: 'ai', lastAiNotAnswer: true }), 'ai_handling', 100],
    [S({ lvNoReply: true, lvText: 'thanks' }), 'ai_handling', null],
    [S({ laAt: 50, lvNoReply: true, lvText: 'thanks' }), 'agent_handling', null],     // "thanks" after an agent message
    [S({ laAt: 100 }), 'agent_handling', 100],                                         // same instant: not "after"
    [S({ laAt: 101, lastSender: 'agent' }), 'human_needed', null],
    [S({}), 'agent_handling', 100],
    [S({ lvAt: null }), 'agent_handling', null],
    [S({}), null, 100],
  ];
  rows.forEach(([s, st, exp], i) => assert.strictEqual(rules.waitingSince(s, st), exp, `row ${i}`));
});
t('W7 waitingSince equals the SQL CASE on 3,000 random chats', () => {
  const sql = (s, st, aiText) => {
    if (st === 'resolved' || s.lvAt === null) return null;
    if (s.laAt !== null && s.laAt > s.lvAt) return null;
    if (st === 'human_needed' && s.laAt === null) return s.lvAt;
    if (NOREPLY.test(s.lvText)) return null;
    if (st === 'human_needed' || s.lastSender === 'visitor' || (s.lastSender === 'ai' && AINOT.test(aiText))) return s.lvAt;
    return null;
  };
  const texts = ['ok', 'thanks', 'kab aayega', 'theek hai', 'hello', 'ok got it thanks', 'refund chahiye', ''];
  const ai = ['Sorry, that took longer than expected. Please try again.', 'Let me get that confirmed by our team.', 'Your order arrives Monday.'];
  const st = ['human_needed', 'agent_handling', 'ai_handling', 'resolved', null];
  let seed = 11;
  const pick = (a) => a[(seed = (seed * 16807) % 2147483647) % a.length];
  for (let i = 0; i < 3000; i++) {
    const lvText = pick(texts), aiText = pick(ai);
    const s = { lvAt: pick([null, 100, 100]), lvText, lvNoReply: NOREPLY.test(lvText), laAt: pick([null, 50, 100, 150]),
      lastSender: pick(['visitor', 'agent', 'ai']), lastAiNotAnswer: AINOT.test(aiText) };
    const status = pick(st);
    assert.strictEqual(rules.waitingSince(s, status), sql(s, status, aiText), JSON.stringify([s, status]));
  }
});
t('W7 scoreWaiting: a happy last word after a team answer is not waiting', () => {
  // "ok got it thanks" is not in NO_REPLY_NEEDED_REGEX: the inbox still waits, the score clock does not.
  assert.strictEqual(rules.waitingSince(S({ laAt: 50, lvText: 'ok got it thanks' }), 'human_needed'), 100);
  assert.strictEqual(rules.scoreWaiting(S({ laAt: 50, lvText: 'ok got it thanks' }), 'human_needed'), null);
  assert.strictEqual(rules.scoreWaiting(S({ laAt: 50, lvText: 'ok got it thanks' }), 'agent_handling'), null);
  // No team answer yet (Needs you after the AI hand-over): the inbox rule stands, even "ok" waits.
  assert.strictEqual(rules.scoreWaiting(S({ lvText: 'ok', lvNoReply: true }), 'human_needed'), 100);
  assert.strictEqual(rules.scoreWaiting(S({ lvText: 'ok got it thanks' }), 'human_needed'), 100);
  // A nudge or a real question still waits.
  for (const x of ['kab aayega', 'hello?', 'hi', '😡', 'Please check my order status. Thank you']) {
    assert.strictEqual(rules.scoreWaiting(S({ laAt: 50, lvText: x }), 'agent_handling'), 100, x);
  }
  assert.strictEqual(rules.scoreWaiting(S({}), 'resolved'), null);
});
t('W11 scoreWaiting: a courtesy nudge after a question nobody answered still waits; a real thank-you does not', () => {
  // lrAt = when the customer last wrote something that is not a sign-off.
  for (const x of ['sir', 'bhai', 'sir ji', 'ok sir']) {
    assert.strictEqual(rules.scoreWaiting(S({ laAt: 50, lvText: x, lrAt: 80 }), 'agent_handling'), 100, x);      // asked at 80, nobody answered
    assert.strictEqual(rules.scoreWaiting(S({ laAt: 50, lvText: x, lrAt: 40 }), 'agent_handling'), null, x);     // answered at 50, then "sir"
    assert.strictEqual(rules.scoreWaiting(S({ laAt: 50, lvText: x, lrAt: null }), 'agent_handling'), null, x);   // nothing but sign-offs
  }
  for (const x of ['got it thanks', 'ok got it thanks', 'theek hai']) {
    assert.strictEqual(rules.scoreWaiting(S({ laAt: 50, lvText: x, lrAt: 80 }), 'agent_handling'), null, x);
  }
  // Callers that do not pass lrAt keep the rule as it was.
  assert.strictEqual(rules.scoreWaiting(S({ laAt: 50, lvText: 'sir' }), 'agent_handling'), null);
});
t('W7 load.ts passes the inbox regexes themselves, not a copy', () => {
  const src = read('src/lib/team-score/load.ts');
  for (const name of ['NO_REPLY_NEEDED_REGEX', 'AI_NOT_AN_ANSWER_REGEX']) {
    assert.ok(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'@/lib/chat/waiting'`).test(src), `${name} imported from @/lib/chat/waiting`);
    assert.ok((src.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length >= 2, `${name} used`);
    assert.ok(!new RegExp(`(const|let|var)\\s+${name}\\b`).test(src), `${name} not redefined`);
  }
});

// ── W8. Isolation ──────────────────────────────────────────────
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'out', 'build', 'coverage']);
function walk(rel, out) {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(r, out); }
    else if (e.isFile() && !/\.(tsbuildinfo|png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf|zip|gz|mp4|mp3)$/i.test(e.name)) out.push(r);
  }
  return out;
}
const MENTION = /team_score_|chat_holder_log|chat_health_log|staff_presence_days|team-score|TeamScore|@\/lib\/team-score/;
const ALLOWED = [
  /^src\/lib\/team-score\//, /^src\/app\/api\/team\/score\//, /^src\/app\/api\/cron\/team-score\//, /^src\/components\/TeamScoreCard\.tsx$/,
  /^scripts\/ai-tests\/team-score-[\w-]+\.js$/, /^team-score\.sql$/, /^AGENTS\.md$/, /^MASTER_RULES_STATUS\.md$/,
];
t('W8 nothing outside the team-score files mentions the new tables or modules', () => {
  const bad = [];
  for (const f of walk('', [])) {
    if (ALLOWED.some((re) => re.test(f))) continue;
    let text;
    try { const st = fs.statSync(path.join(ROOT, f)); if (st.size > 5_000_000) continue; text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (text.includes('\u0000') || !MENTION.test(text)) continue;
    const lines = text.split('\n').filter((l) => MENTION.test(l));
    if (f === 'src/app/admin/page.tsx'
      && lines.every((l) => /^\s*import TeamScoreCard from '@\/components\/TeamScoreCard';\s*$/.test(l) || /<TeamScoreCard\b/.test(l))) continue;
    if (f === 'package.json' && lines.every((l) => /^\s*"test:ai":/.test(l))) continue;   // the suites in test:ai only
    if (/\.sql$/.test(f) && lines.every((l) => /^\s*--/.test(l))) continue;              // a comment in another SQL file only
    // Another suite may read team-score.sql as TEXT to check it still fits its own SQL (team-routing.js).
    if (/^scripts\/ai-tests\/[\w-]+\.js$/.test(f) && lines.every((l) => /^\s*\/\//.test(l) || /'(\.\.\/)*team-score\.sql'/.test(l))) continue;
    bad.push(f);
  }
  assert.deepStrictEqual(bad, []);
});
t('W8 the AI, learner, search and widget never see it; only judge.ts imports the AI client', () => {
  const must = ['src/lib/chat/ai.ts', 'src/lib/chat/inbox-search.ts', 'src/lib/chat/widget-api.ts', 'public/widget.js',
    ...fs.readdirSync(path.join(ROOT, 'src/lib/chat')).filter((f) => /^brain.*\.ts$/.test(f)).map((f) => `src/lib/chat/${f}`),
    ...walk('src/app/api/widget', [])];
  assert.ok(must.length >= 8, must.join());
  for (const f of must) assert.ok(!MENTION.test(read(f)), f);
  const dirTs = fs.readdirSync(path.join(ROOT, 'src/lib/team-score')).filter((f) => f.endsWith('.ts'));
  for (const f of dirTs) {
    const s = read(`src/lib/team-score/${f}`);
    const imports = /from\s+'@\/lib\/chat\/ai'|import\(\s*'@\/lib\/chat\/ai'\s*\)|require\(\s*'@\/lib\/chat\/ai'\s*\)/.test(s);
    if (f !== 'judge.ts') assert.ok(!imports, `${f} imports @/lib/chat/ai`);
  }
  // judge.ts takes only the client, the retry test and the model order (lead override: attemptOrder, like health.ts).
  const judge = read('src/lib/team-score/judge.ts');
  const names = [...judge.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/lib\/chat\/ai'/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean));
  assert.ok(names.length >= 1, 'judge.ts imports nothing from @/lib/chat/ai');
  for (const x of names) assert.ok(['attemptOrder', 'getClient', 'isRetryable'].includes(x), `judge.ts imports ${x}`);
  assert.ok(!/JUDGE_MODELS|deepseek\/deepseek-/.test(judge), 'judge.ts hard-codes a model');
});
t('W8 the pure modules import only each other and the three import-free rule files', () => {
  const ok = new Set(['./types', './clock', './words', './rules', './engine', '@/lib/office-hours', '@/lib/chat/health-rules', '@/lib/chat/escalation']);
  for (const f of ['types', 'clock', 'words', 'rules', 'engine']) {
    const s = read(`src/lib/team-score/${f}.ts`);
    const specs = [...s.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+'([^']+)'/gm), ...s.matchAll(/\bimport\s*\(\s*'([^']+)'/g)].map((m) => m[1]);
    if (f !== 'types') assert.ok(specs.length >= 1, `${f}.ts: no imports found`);
    for (const sp of specs) assert.ok(ok.has(sp), `${f}.ts imports ${sp}`);
    assert.ok(!/require\(|process\.env|Date\.now\(|Math\.random\(/.test(s), `${f}.ts is not pure`);
  }
  assert.ok(!/^import/m.test(read('src/lib/team-score/types.ts')));
  for (const f of ['src/lib/office-hours.ts', 'src/lib/chat/health-rules.ts', 'src/lib/chat/escalation.ts']) assert.ok(!/^import /m.test(read(f)), f);
});

// ── W9. The SQL file ───────────────────────────────────────────
t('W9 team-score.sql: additive, idempotent, granted, never blocks a write', () => {
  const raw = read('team-score.sql');
  const sql = raw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  assert.ok(!/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i.test(sql), 'destructive statement');
  assert.ok(!/^\s*UPDATE\s+\w+\s+SET/im.test(sql), 'UPDATE ... SET');
  assert.ok(!/\bALTER\s+TABLE\b/i.test(sql), 'ALTER TABLE');
  assert.ok(/SET lock_timeout = '5s'/.test(sql));
  const creates = sql.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\b[^\n]*/gi) || [];
  assert.ok(creates.length >= 12, String(creates.length));
  for (const c of creates) assert.ok(/IF NOT EXISTS/i.test(c), c);
  const fns = sql.match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+\w+/gi) || [];
  assert.strictEqual(fns.length, 3);
  for (const m of fns) assert.ok(/OR REPLACE/i.test(m), m);
  const trg = sql.match(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+(\w+)/gi) || [];
  assert.deepStrictEqual(trg.map((x) => x.split(/\s+/).pop()).sort(), ['trg_team_health_log', 'trg_team_holder_log', 'trg_team_holder_log_ins', 'trg_team_presence_day']);
  for (const m of trg) assert.ok(/OR REPLACE/i.test(m), m);
  // Each trigger function only WARNs on a failure, so a reply / close / presence flush is never blocked.
  for (const body of sql.split(/CREATE OR REPLACE FUNCTION/).slice(1)) {
    assert.ok(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/.test(body) && /RETURN NULL;/.test(body), body.slice(0, 40));
  }
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(tables.sort(), ['chat_health_log', 'chat_holder_log', 'staff_presence_days', 'team_score_days', 'team_score_settings', 'team_score_verdicts']);
  for (const tb of tables) {
    assert.ok(new RegExp(`GRANT [^;]+ ON ${tb} TO tracker_user`).test(sql), 'grant ' + tb);
    const body = sql.slice(sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tb}`)).split(/\n\);/)[0];
    if (/bigserial/.test(body)) assert.ok(new RegExp(`ON SEQUENCE ${tb}_id_seq TO tracker_user`).test(sql), 'sequence ' + tb);
  }
  // Frozen days, paid verdicts and the two history logs: insert-only for the app.
  for (const tb of ['team_score_days', 'team_score_verdicts', 'chat_holder_log', 'chat_health_log', 'team_score_settings']) {
    const g = sql.match(new RegExp(`GRANT ([^;]+) ON ${tb} TO tracker_user`))[1];
    assert.ok(!/UPDATE|DELETE|TRUNCATE|ALL/i.test(g), `${tb}: ${g}`);
  }
  // Seeds and the backfill only add what is missing (safe to run twice).
  for (const m of sql.match(/INSERT INTO \w+[\s\S]*?;\s*$/gm) || []) {
    if (/VALUES \(NEW\./.test(m)) continue;                              // inside a trigger
    assert.ok(/WHERE NOT EXISTS|AND NOT EXISTS/.test(m), m.slice(0, 60));
  }
});

// ── W10. Owner answers 2026-10-02 ──────────────────────────────
t('W10 A2 weights: convinced +2, closed while waiting -2 (label, rule line, validation, SQL seed)', () => {
  assert.deepStrictEqual(rules.DEFAULT_WEIGHTS,
    { thanks: 3, solved: 2, fast_reply: 1, unanswered_2h: -3, angry: -2, closed_waiting: -2, convinced: 2, customer_answered: 0 });
  assert.ok(rules.WEIGHT_KEYS.includes('closed_waiting'));
  assert.strictEqual(rules.POINT_LABELS.closed_waiting, 'Closed while customer waiting');
  const lines = rules.rulesHinglish(rules.DEFAULT_WEIGHTS);
  assert.ok(lines.some((l) => /^-2 Customer jawab ka wait kar raha tha aur aapne chat band kar di\.$/.test(l)), lines.join('|'));
  assert.ok(lines.some((l) => l.startsWith('+2 Convinced: ')), lines.join('|'));
  assert.ok(lines.some((l) => /sirf verified customer \(order ID \+ phone\)/.test(l)), 'the verified rule is told');
  assert.ok(rules.rulesHinglish({ ...rules.DEFAULT_WEIGHTS, closed_waiting: -5 }).some((l) => l.startsWith('-5 Customer jawab')));
  assert.deepStrictEqual(rules.validateWeights({ closed_waiting: -4 }), { ok: true, weights: { ...rules.DEFAULT_WEIGHTS, closed_waiting: -4 } });
  assert.strictEqual(rules.validateWeights({ closed_waiting: 0.25 }).ok, false);
  const seed = JSON.parse(read('team-score.sql').match(/'(\{"thanks"[^']+\})'::jsonb/)[1]);
  assert.deepStrictEqual([seed.convinced, seed.closed_waiting], [2, -2]);
});
t('W10 A4 the default settings row starts points on the install day (no + 1)', () => {
  const sql = read('team-score.sql').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const ins = sql.slice(sql.indexOf('INSERT INTO team_score_settings'), sql.indexOf('WHERE NOT EXISTS (SELECT 1 FROM team_score_settings)'));
  assert.ok(/DATE '2026-01-01', \(now\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date, 'system'/.test(ins), ins);
  assert.ok(!/::date\s*\+\s*1/.test(ins), 'points start the day after install');
});
t('W10 A3 verified = the app\'s own test (chatIsVerified), in load.ts and the drill-down', () => {
  const app = read('src/lib/chat/verified.ts').match(/\((verified_order_id IS NOT NULL OR phone_match_order_id IS NOT NULL)\) AS v/);
  assert.ok(app, 'verified.ts changed its test: update load.ts / report.ts');
  assert.ok(read('src/lib/team-score/load.ts').includes('(c.verified_order_id IS NOT NULL OR c.phone_match_order_id IS NOT NULL) AS known'));
  assert.ok(read('src/lib/team-score/report.ts').includes('(c.verified_order_id IS NOT NULL OR c.phone_match_order_id IS NOT NULL) AS known'));
  // Email threads are verified by the same test (email.ts asks chatIsVerified), so no email exception exists.
  assert.ok(/chatIsVerified\(conversation\.id\)/.test(read('src/lib/chat/email.ts')));
});

if (failed.length) {
  console.log(`TEAM-SCORE UNIT: ${failed.length} failed (${failed.join(', ')}), ${n} passed`);
  process.exit(1);
}
console.log(`TEAM-SCORE UNIT: ${n} groups passed`);
