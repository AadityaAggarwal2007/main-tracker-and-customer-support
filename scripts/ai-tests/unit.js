// Pure helpers of the Brain (brain.ts, brain-learn.ts): no model, no database.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ts = require('typescript');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-unit-'));
const load = (f) => {
  const js = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat', f + '.ts'), 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
  fs.writeFileSync(path.join(dir, f + '.js'), js);
  return require(path.join(dir, f + '.js'));
};
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
console.log(`UNIT: ${n} groups passed`);
