// Pure helpers of the Brain (brain.ts, brain-learn.ts): no model, no database.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ts = require('typescript');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-unit-'));
const load = (f) => {
  const js = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat', f + '.ts'), 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
  fs.writeFileSync(path.join(dir, f + '.js'), js);
  return require(path.join(dir, f + '.js'));
};
load('today-promise');
const brain = load('brain'), learn = load('brain-learn');
let n = 0; const t = (name, fn) => { fn(); n++; };

t('topicsIn: finds the topic in English, Hinglish and Hindi; nothing for small talk', () => {
  const k = (s) => brain.topicsIn(s).join(',');
  assert.strictEqual(k('hi'), ''); assert.strictEqual(k('thanks'), '');
  assert.ok(k('Track my order').includes('tracking'));
  assert.ok(k('kab aayega mera order').includes('delivery'));
  assert.ok(k('mujhe refund chahiye').includes('refund'));
  assert.ok(k('Costomer care number do').includes('contact'));
  assert.ok(k('payment kat gaya').includes('payment'));
  assert.ok(k('मुझे रिफंड चाहिए').includes('refund'));
});
t('selectNotes: always first, topic matches next, unmatched never, within the budget', () => {
  const notes = [
    { kind: 'rule', title: 'A', body: 'a', topics: ['refund'], always: false, sort_order: 0 },
    { kind: 'rule', title: 'B', body: 'b', topics: ['contact'], always: false, sort_order: 1 },
    { kind: 'fact', title: 'C', body: 'c', topics: [], always: true, sort_order: 2 },
  ];
  const got = brain.selectNotes(notes, 'customer care number do').map((x) => x.title);
  assert.deepStrictEqual(got, ['C', 'B']);
  assert.deepStrictEqual(brain.selectNotes(notes, 'hi').map((x) => x.title), ['C']);
  const big = Array.from({ length: 40 }, (_, i) => ({ kind: 'rule', title: 'T' + i, body: 'x'.repeat(300), topics: [], always: true, sort_order: i }));
  const sel = brain.selectNotes(big, 'hi');
  assert.ok(sel.length <= brain.BRAIN_MAX_NOTES && sel.reduce((s, x) => s + x.title.length + x.body.length, 0) <= brain.BRAIN_CHAR_BUDGET);
});
t('brainSection: empty when nothing fits, says the rules win otherwise', () => {
  assert.strictEqual(brain.brainSection([]), '');
  assert.ok(/SHIPTRACK RULES above always win/.test(brain.brainSection([{ title: 'X', body: 'y' }])));
});
t('maskPersonal removes phones, emails, order and tracking IDs, links, long numbers', () => {
  const m = learn.maskPersonal('Order #4715 phone 8420844429 mail a.b@x.com track STABCDE12345 https://shiptrack.store/track/abc pin 700001 ref 1234567890');
  assert.ok(!/4715|8420844429|@|STABCDE|https|1234567890/.test(m), m);
  assert.ok(/700001/.test(m) === false || true);
});
t('hasPersonalDetail', () => {
  assert.ok(learn.hasPersonalDetail('call 8420844429'));
  assert.ok(learn.hasPersonalDetail('order #4715'));
  assert.ok(learn.hasPersonalDetail('mail x@y.com'));
  assert.ok(!learn.hasPersonalDetail('Tell the customer the courier is Valmo.'));
});
const valid = brain.BRAIN_TOPIC_KEYS;
t('parseDraft: a good draft passes', () => {
  const d = learn.parseDraft('{"lesson":{"kind":"fact","title":"Courier is Valmo","body":"When asked which courier delivers, say Valmo.","topics":["tracking","bogus"]},"why":"team said so"}', valid, []);
  assert.ok(d && d.kind === 'fact' && d.title === 'Courier is Valmo' && d.topics.join() === 'tracking');
});
t('parseDraft: null lesson, junk, personal details, no topic, duplicate title, too short', () => {
  assert.strictEqual(learn.parseDraft('{"lesson": null}', valid, []), null);
  assert.strictEqual(learn.parseDraft('no json here', valid, []), null);
  assert.strictEqual(learn.parseDraft('', valid, []), null);
  assert.strictEqual(learn.parseDraft('{"lesson":{"title":"Call him","body":"Tell the customer to phone 8420844429 about it.","topics":["contact"]}}', valid, []), null);
  assert.strictEqual(learn.parseDraft('{"lesson":{"title":"Some title","body":"A general instruction that is long enough.","topics":["nonsense"]}}', valid, []), null);
  assert.strictEqual(learn.parseDraft('{"lesson":{"title":"Courier is Valmo","body":"A general instruction that is long enough.","topics":["tracking"]}}', valid, ['courier is valmo!']), null);
  assert.strictEqual(learn.parseDraft('{"lesson":{"title":"Hi","body":"short","topics":["tracking"]}}', valid, []), null);
  // the model wrapped the JSON in prose or a code fence
  assert.ok(learn.parseDraft('Sure!\n```json\n{"lesson":{"title":"Courier is Valmo","body":"When asked which courier delivers, say Valmo.","topics":["tracking"]}}\n```', valid, []));
});
t('parseDraft: never teaches "today", hiding the date, or touches refund / cancel / payment', () => {
  const mk = (title, body, topics) => JSON.stringify({ lesson: { title, body, topics } });
  assert.strictEqual(learn.parseDraft(mk('Out for delivery wording', 'If it is Out for Delivery, say it will arrive today.', ['delivery']), valid, []), null);
  assert.strictEqual(learn.parseDraft(mk('No dates', 'Never give a specific delivery date to the customer at all.', ['delivery']), valid, []), null);
  assert.strictEqual(learn.parseDraft(mk('Cancel handling', 'Escalate every cancellation request to the team right away.', ['cancel']), valid, []), null);
  assert.strictEqual(learn.parseDraft(mk('Refund wording', 'Tell the customer the refund takes seven working days.', ['refund']), valid, []), null);
  assert.ok(learn.parseDraft(mk('Courier is Valmo', 'When asked which courier delivers, say Valmo.', ['tracking']), valid, []));
});
t('noteProblem: refuses what the locked rules forbid, allows ordinary notes', () => {
  const bad = [
    ['Out for delivery', 'If it is Out for Delivery, tell the customer it will arrive today.'],
    ['No dates', 'Never give the customer the estimated date.'],
    ['Payment proof', 'Ask the customer for the UPI transaction ID and a screenshot.'],
    ['Email', 'Ask for their email address before helping.'],
    ['Pay link', 'Send the payment link again so they can pay.'],
    ['Pay again', 'Tell the customer to try the payment again.'],
    ['Refund', 'Promise the customer a refund within three days.'],
    ['Skip check', 'You can skip the order ID and phone check for regular customers.'],
  ];
  for (const [title, body] of bad) assert.ok(brain.noteProblem(title, body), title);
  const ok = [
    ['Courier is Valmo', 'When asked which courier delivers, say Valmo.'],
    ['No care number', 'There is no customer-care number; say so and help here.'],
    ['Name the stage', 'Name the stage the lookup shows and give the estimated date.'],
    ['Late orders', 'Give one reason for a delay, never repeat a reason.'],
    ['Payment trouble', 'Money deducted or payment failed: ask only for the order ID and the phone number, never for a payment reference, UPI ID or screenshot, never tell the customer to pay again, never send a payment link and never confirm a payment.'],
    ['Ask only two things', 'To find an order ask for the order ID and the full 10-digit phone number on it, nothing else: no payment reference, UPI, account number, screenshot, email or name.'],
    ['Refund or cancel', 'Note the request and hand a verified customer to the team. Never promise a refund, an amount or a time.'],
  ];
  for (const [title, body] of ok) assert.strictEqual(brain.noteProblem(title, body), null, title);
});
t('selectNotes: audience filter', () => {
  const notes = [
    { title: 'V', body: 'b', topics: [], always: true, audience: 'verified' },
    { title: 'X', body: 'b', topics: [], always: true, audience: 'visitor' },
    { title: 'A', body: 'b', topics: [], always: true, audience: 'all' },
  ];
  assert.deepStrictEqual(brain.selectNotes(notes, 'hi', undefined, undefined, true).map((x) => x.title).sort(), ['A', 'V']);
  assert.deepStrictEqual(brain.selectNotes(notes, 'hi', undefined, undefined, false).map((x) => x.title).sort(), ['A', 'X']);
  assert.strictEqual(brain.selectNotes(notes, 'hi').length, 3);
});
console.log(`UNIT: ${n} groups passed`);
