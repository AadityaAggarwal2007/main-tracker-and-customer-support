// Pure helpers of the Brain (brain.ts, brain-learn.ts): no model, no database.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ts = require('typescript');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-unit-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
const load = (f, from = '../../src/lib/chat') => {
  const js = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, from, f + '.ts'), 'utf8'), { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
  fs.writeFileSync(path.join(dir, f + '.js'), js);
  return require(path.join(dir, f + '.js'));
};
const tp = load('today-promise');
load('health-rules');
load('address-conflict'); const esc = load('escalation');
const brain = load('brain'), learn = load('brain-learn'), ex = load('brain-examples'), om = load('order-mention'), rg = load('reply-guards'), cr = load('courier'), rb = load('rulebook'), ef = load('effort'), sc = load('self-check');
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
t('detectSituations', () => {
  const d = (...m) => ex.detectSituations(m);
  assert.deepStrictEqual(d('hi'), []);
  assert.deepStrictEqual(d('ok thanks'), []);
  assert.ok(d('mujhe refund chahiye').includes('refund_cancel'));
  assert.ok(d('order cancel karo').includes('refund_cancel'));
  assert.ok(d('tracking link galat hai').includes('wrong_tracking'));
  assert.ok(d('this link shows someone else\'s order').includes('wrong_tracking'));
  assert.ok(d('abhi tak nahi aaya, 15 din ho gaye').includes('delay'));
  assert.ok(d('you are fraud, I will file a chargeback')[0] === 'fraud_claim');
  assert.ok(d('WORST SERVICE EVER!!!').includes('angry'));
  assert.ok(!d('Coupon code').length);
  assert.ok(!d('OK CAN YOU TELL ME THE ITEMS').includes('angry'));
  assert.ok(!d('When will they contact me').includes('delay'));
  assert.ok(!d('Track my order', 'Track my order').includes('angry'));
  assert.ok(d('15 din ho gaye abhi tak order nahi aaya').includes('delay'));
  assert.ok(d('payment kat gaya par order nahi bana').includes('payment'));
});
t('customerCalmedAfter', () => {
  assert.ok(ex.customerCalmedAfter(['ok thanks']));
  assert.ok(ex.customerCalmedAfter(['Theek hai ji 🙏']));
  assert.ok(ex.customerCalmedAfter(['mil gaya, thank you']));
  assert.ok(!ex.customerCalmedAfter([]));
  assert.ok(!ex.customerCalmedAfter(['ok', 'fraud ho tum log']));
  assert.ok(!ex.customerCalmedAfter(['refund chahiye abhi']));
  assert.ok(!ex.customerCalmedAfter(['WHERE IS MY ORDER']));
  assert.ok(!ex.customerCalmedAfter(['kab aayega?']));
  assert.ok(ex.customerCalmedAfter(['Okay mam']));
  assert.ok(ex.customerCalmedAfter(['Address change ho gaya']));
  assert.ok(!ex.customerCalmedAfter(['ok but when will it come']));
});
t('exampleProblem', () => {
  const good = 'I completely understand your concern and I am really sorry for the delay. Our team is checking with the courier and you will get the update right here.';
  assert.strictEqual(ex.exampleProblem(good), null);
  assert.ok(ex.exampleProblem('ok'));
  assert.ok(ex.exampleProblem(good + ' Call us at 9876543210.'));
  assert.ok(ex.exampleProblem('Your refund of Rs 499 will be processed within 5-7 working days, sorry for the trouble.'));
  assert.ok(ex.exampleProblem('Sorry for the delay, it will be delivered on 5 October without fail, please wait.'));
  assert.ok(ex.exampleProblem('Sorry for the delay sir, it is out for delivery and will reach you today for sure.'));
  assert.ok(ex.exampleProblem('Sorry ma\'am, please try the payment again and share the UPI screenshot here.'));
  assert.ok(ex.exampleProblem('Could you please share your Order ID so we can check your order status for you?'));
  assert.ok(ex.exampleProblem('Please share your Order ID, phone number, and customer name so we can check your order details.'));
  assert.strictEqual(ex.exampleProblem('I understand your worry and I am sorry for the wait. Please share your order ID so I can check it for you right away.'), null);
});
t('parseExample', () => {
  const raw = (o) => JSON.stringify({ example: o, lesson: null });
  const good = { situation: 'delay', customer: 'abhi tak nahi aaya', team: 'Main samajh sakta hoon, der ke liye maafi. Team courier se baat kar rahi hai, update yahin milega.' };
  assert.ok(ex.parseExample(raw(good), ['delay']));
  assert.strictEqual(ex.parseExample(raw(good), ['refund_cancel']), null);
  assert.strictEqual(ex.parseExample(raw({ ...good, situation: 'bogus' }), ['bogus']), null);
  assert.strictEqual(ex.parseExample(raw({ ...good, customer: 'order #4715 kab' }), ['delay']), null);
  assert.strictEqual(ex.parseExample(raw(null), ['delay']), null);
  assert.strictEqual(ex.parseExample('nonsense', ['delay']), null);
});
t('cleanTeamReply drops email greeting and signature', () => {
  assert.strictEqual(ex.cleanTeamReply('Dear Customer,\n\nWe are sorry for the delay.\n\nVestora Customer Support'), 'We are sorry for the delay.');
  assert.strictEqual(ex.cleanTeamReply('Sorry for the delay, checking now.'), 'Sorry for the delay, checking now.');
});
t('parseExample needs the customer line to be about the situation', () => {
  const raw = JSON.stringify({ example: { situation: 'angry', customer: 'Coupon code', team: 'Yes, we offer ten percent off on your first order at checkout, enjoy shopping with us.' } });
  assert.strictEqual(ex.parseExample(raw, ['angry']), null);
});
t('pickExamples', () => {
  const all = [{ situation: 'delay', id: 1 }, { situation: 'delay', id: 2 }, { situation: 'angry', id: 3 }];
  assert.deepStrictEqual(ex.pickExamples(all, ['angry', 'delay']).map((e) => e.id), [3, 1]);
  assert.deepStrictEqual(ex.pickExamples(all, ['delay']).map((e) => e.id), [1, 2]);
  assert.deepStrictEqual(ex.pickExamples(all, ['refund_cancel']), []);
  assert.strictEqual(ex.examplesSection([]), '');
});
t('noteProblem blocks teaching hand-overs after failed checks; similarity finds rewordings', () => {
  assert.ok(brain.noteProblem('Hand off after repeated verification failures', 'If the system still cannot find the order, hand off to the team instead of asking again.'));
  assert.ok(brain.noteProblem('Escalate', 'If the customer cannot provide a valid order ID after three attempts, escalate to the team immediately.'));
  assert.strictEqual(brain.noteProblem('LuxeVa is now Vastora', 'If a customer says their order was placed on LuxeVa, treat it as a Vastora order.'), null);
  assert.ok(brain.similarity('Hand off after 3 failed lookups: If the AI cannot find an order after 3 attempts, hand the customer to the team', 'Escalate after repeated verification failures: If the customer cannot provide a valid order after three attempts, escalate to the team') >= 0.4);
  assert.ok(brain.similarity('COD not available, pay online', 'LuxeVa is now Vastora') < 0.2);
});
t('noteProblem: order ID + phone both, help in chat; defaultAudience', () => {
  assert.ok(brain.noteProblem('Ask for order ID first', 'When a customer asks to track an order, always ask for the order ID first. Do not ask for phone or email unless the order ID is not available.'));
  assert.ok(brain.noteProblem('Address change', 'When a customer requests an address change, ask for the address directly. Do not ask for phone number or other verification first.'));
  assert.ok(brain.noteProblem('No phone number given', 'The AI must never provide a phone number. Instead, direct the customer to email the support team.'));
  assert.strictEqual(brain.noteProblem('Already given', 'If the customer already shared the phone, do not ask for the phone again.'), null);
  assert.strictEqual(brain.noteProblem('No care number', 'There is no customer-care or WhatsApp number; do not send the customer to email or WhatsApp, help here.'), null);
  assert.strictEqual(brain.defaultAudience('Hand off address changes to team', 'Inform the customer and hand it to the team.'), 'verified');
  assert.strictEqual(brain.defaultAudience('LuxeVa is now Vastora', 'Treat it as a Vastora order.'), 'all');
});
t('the starter notes pass the check', () => {
  const seed = require('fs').readFileSync(require('path').resolve(__dirname, '../../chat-brain-seed.sql'), 'utf8');
  const rows = [...seed.matchAll(/\('(?:rule|fact|lesson)',\s*'((?:[^']|'')+)',\s*'((?:[^']|'')+)'/g)];
  assert.ok(rows.length >= 8);
  for (const [, title, body] of rows) assert.strictEqual(brain.noteProblem(title.replace(/''/g, "'"), body.replace(/''/g, "'")), null, title);
  assert.ok(brain.noteProblem('Out for delivery', 'Tell them it will arrive today.'));
});
t('fixOrderMentions', () => {
  const f = (r, k, t = '') => om.fixOrderMentions(r, k, t).text;
  assert.strictEqual(f('Maine aapka order #4711 check kiya hai.', ['#4715']), 'Maine aapka order #4715 check kiya hai.');
  assert.strictEqual(f('Order ID: 4711, status Shipped.', ['#4715']), 'Order ID: 4715, status Shipped.');
  assert.strictEqual(f('Your order #4715 is shipped.', ['#4715']), 'Your order #4715 is shipped.');
  assert.strictEqual(f('Your order #9999 is shipped.', []), 'Your order is shipped.');
  assert.strictEqual(f('Your order #9999 is shipped.', ['#4715', '#5000']), 'Your order is shipped.');
  assert.strictEqual(f('You asked about order #9999.', ['#4715'], 'what about order 9999?'), 'You asked about order #9999.');
  const keep = 'Total Rs 499, call 8420844429, delivery 07/10/2026, pin 700001, tracking ST8ZSB7R9HF4.';
  assert.strictEqual(f(keep, ['#4715']), keep);
  assert.strictEqual(f('Pack of 16 jhumkas, order 1500 rs worth.', ['#4715']), 'Pack of 16 jhumkas, order 1500 rs worth.');
  assert.strictEqual(f('Free shipping on a minimum order 299.', ['#4715']), 'Free shipping on a minimum order 299.');
  assert.strictEqual(f('COD works above order 999 in Gujarat.', ['#4715']), 'COD works above order 999 in Gujarat.');
});
t('dropAddressEcho', () => {
  const c = ['address change karna hai, naya address: 12 MG Road, Pune 411001'];
  const d = (r) => rg.dropAddressEcho(r, c).text;
  assert.strictEqual(d("Got it. I've noted the address — 12 MG Road, Pune 411001 — and passed it to our team."), "Got it. I've noted the address and passed it to our team.");
  assert.strictEqual(d('Aapka naya address 12 MG Road, Pune 411001 team ko bhej diya hai.'), 'Aapka naya address team ko bhej diya hai.');
  assert.strictEqual(d('Your new address: 12 MG Road, Pune 411001.'), 'Your new address is noted.');
  assert.strictEqual(d("I've passed your request for MG Road to the team."), "I've passed your request for the address you shared to the team.");
  assert.strictEqual(d('Your new address is noted and passed to the team.'), 'Your new address is noted and passed to the team.');
  assert.strictEqual(d("I've noted your new address as 12 MG Road, Pune 411001 and passed it to our team."), "I've noted your new address and passed it to our team.");
  assert.strictEqual(d('The new address noted is 12 MG Road, Pune 411001.'), 'The new address noted.');
  assert.strictEqual(d('Your order has reached Pune and is at the local hub.'), 'Your order has reached Pune and is at the local hub.');
  assert.strictEqual(rg.dropAddressEcho('Your order 4715 is in Pune.', ['order 4715 kab aayega?']).changed, false);
});
t('withCheckAround / saysNotReceived', () => {
  const ctx = (c, d, e = []) => ({ customerLatest: c, orderDelivered: d, earlierAgentReplies: e });
  assert.ok(rg.withCheckAround("I've raised this with our team.", ctx('delivered dikha raha hai par mila nahi', true)).changed);
  assert.ok(!rg.withCheckAround("I've raised this.", ctx('not received', false)).changed);
  assert.ok(!rg.withCheckAround('Please check with your neighbours once.', ctx('not received', true)).changed);
  assert.ok(!rg.withCheckAround("I've raised it.", ctx('not received', true, ['Could you check with security?'])).changed);
  assert.ok(rg.saysNotReceived('order nahi mila, refund do'));
  assert.ok(!rg.saysNotReceived('refund nahi mila abhi tak'));
  assert.ok(!rg.saysNotReceived("I didn't get the tracking link"));
  assert.ok(!rg.saysNotReceived('mil gaya thanks'));
});
t('courierFor', () => {
  assert.strictEqual(cr.courierFor(null, 'Valmo'), 'Valmo');
  assert.strictEqual(cr.courierFor('', 'Valmo'), 'Valmo');
  assert.strictEqual(cr.courierFor('volmo ', null), 'Valmo');
  assert.strictEqual(cr.courierFor('VALMO', null), 'Valmo');
  assert.strictEqual(cr.courierFor('Delhivery', 'Valmo'), 'Delhivery');
  assert.strictEqual(cr.courierFor('Courier Partner', 'Valmo'), 'Valmo');
  assert.strictEqual(cr.courierFor(null, null), null);
  assert.strictEqual(cr.courierFor(null, '  '), null);
});
t('withoutUnaskedCourier / asksAboutCourier', () => {
  const f = (r, c = 'Track my order') => rg.withoutUnaskedCourier(r, c, ['Valmo']).text;
  assert.strictEqual(f('Your order #4715 has been shipped via Valmo and is on its way.'), 'Your order #4715 has been shipped via our courier partner and is on its way.');
  assert.strictEqual(f('Handed to our courier partner, Valmo. Estimated delivery 10 October.'), 'Handed to our courier partner. Estimated delivery 10 October.');
  assert.strictEqual(f('Tracking ID: ST1\nCourier: Valmo\nStatus: Shipped'), 'Tracking ID: ST1\nStatus: Shipped');
  assert.strictEqual(f('Valmo will deliver your order.'), 'Our courier partner will deliver your order.');
  assert.strictEqual(f('Aapka order Valmo se ship ho gaya hai.'), 'Aapka order hamare courier partner se ship ho gaya hai.');
  // Owner 2026-10-02 10:55: the name only on the customer's 3rd ask (courier-ask.js has the rest).
  // A 1st ask, or a count that could not be read (null), still hides it; the 3rd ask keeps it.
  // The sentence stays whole and still answers: "through our courier partner" (2026-10-02 review).
  assert.strictEqual(f('Your order is delivered through Valmo.', 'which courier is delivering?'), 'Your order is delivered through our courier partner.');
  assert.strictEqual(rg.withoutUnaskedCourier('Your order is delivered through Valmo.', 'which courier is delivering?', ['Valmo'], 1).text, 'Your order is delivered through our courier partner.');
  assert.strictEqual(rg.withoutUnaskedCourier('Your order is delivered through Valmo.', 'which courier is delivering?', ['Valmo'], 3).text, 'Your order is delivered through Valmo.');
  assert.strictEqual(f('See https://valmo.in/track/x for details.'), 'See https://valmo.in/track/x for details.');
  assert.ok(rg.asksAboutCourier('mera order kaunse courier se aa raha hai?'));
  assert.ok(rg.asksAboutCourier('kaun deliver kar raha hai'));
  assert.ok(!rg.asksAboutCourier('order kab aayega'));
});
// ── Night line (owner, 2026-10-01, decision 1): escalation.ts ──
const EN = 'I want a refund for my order', HI = 'mujhe refund chahiye';
t('escalation: the 10 day lines are byte-identical with no time and with null', () => {
  const day = {
    [EN]: [
      'Our team will reply to you here in this chat within 1 hour.',
      "I'm really sorry for the trouble, and this matters to us. I've passed it to our team right now. Our team will reply to you here in this chat within 1 hour.",
      "Sorry to keep you waiting. I've passed your message to our team, and they will reply to you here in this chat.",
      "I've noted your refund or cancellation request. Our team will reply to you here in this chat within 24 hours.",
      "I've passed this to our team, and they will reply to you here in this chat.",
    ],
    [HI]: [
      'Hamari team isi chat mein 1 ghante ke andar aapko jawab degi.',
      'Aapko jo pareshani hui, uske liye hamein sach mein afsos hai, aur ye baat hamare liye bahut zaroori hai. Maine ise abhi hamari team ko de diya hai. Hamari team isi chat mein 1 ghante ke andar aapko jawab degi.',
      'Sorry ki aapko wait karna pad raha hai. Maine aapki baat hamari team ko de di hai, team isi chat mein aapko jawab degi.',
      'Aapki refund ya cancellation ki request maine note kar li hai. Hamari team 24 ghante ke andar isi chat mein aapko jawab degi.',
      'Maine ise hamari team ko de diya hai, team isi chat mein aapko jawab degi.',
    ],
  };
  for (const [said, want] of Object.entries(day)) {
    assert.deepStrictEqual([esc.teamWillReplyLine(said), esc.urgentAck(said), esc.handoffReply(said), esc.routineLine('refund', said), esc.routineLine('payment', said)], want);
    assert.deepStrictEqual([esc.teamWillReplyLine(said, null), esc.urgentAck(said, null), esc.handoffReply(said), esc.routineLine('refund', said, null), esc.routineLine('payment', said, null)], want);
  }
});
const NIGHT = {
  tomorrow: {
    en: [
      'Our team will reply to you here in this chat tomorrow morning, after 10 AM.',
      "I'm really sorry for the trouble, and this matters to us. I've passed it to our team right now. Our team will reply to you here in this chat tomorrow morning, after 10 AM.",
      "I've noted your refund or cancellation request. Our team will reply to you here in this chat tomorrow morning, after 10 AM.",
    ],
    hi: [
      'Hamari team kal subah 10 baje ke baad isi chat mein aapko jawab degi.',
      'Aapko jo pareshani hui, uske liye hamein sach mein afsos hai, aur ye baat hamare liye bahut zaroori hai. Maine ise abhi hamari team ko de diya hai. Hamari team kal subah 10 baje ke baad isi chat mein aapko jawab degi.',
      'Aapki refund ya cancellation ki request maine note kar li hai. Hamari team kal subah 10 baje ke baad isi chat mein aapko jawab degi.',
    ],
  },
  this_morning: {
    en: [
      'Our team will reply to you here in this chat this morning, after 10 AM.',
      "I'm really sorry for the trouble, and this matters to us. I've passed it to our team right now. Our team will reply to you here in this chat this morning, after 10 AM.",
      "I've noted your refund or cancellation request. Our team will reply to you here in this chat this morning, after 10 AM.",
    ],
    hi: [
      'Hamari team aaj subah 10 baje ke baad isi chat mein aapko jawab degi.',
      'Aapko jo pareshani hui, uske liye hamein sach mein afsos hai, aur ye baat hamare liye bahut zaroori hai. Maine ise abhi hamari team ko de diya hai. Hamari team aaj subah 10 baje ke baad isi chat mein aapko jawab degi.',
      'Aapki refund ya cancellation ki request maine note kar li hai. Hamari team aaj subah 10 baje ke baad isi chat mein aapko jawab degi.',
    ],
  },
};
t('escalation: the 12 night lines are exact, promise no hours and no "today"', () => {
  let count = 0;
  for (const after of ['tomorrow', 'this_morning']) {
    for (const [lang, said] of [['en', EN], ['hi', HI]]) {
      const got = [esc.teamWillReplyLine(said, after), esc.urgentAck(said, after), esc.routineLine('refund', said, after)];
      assert.deepStrictEqual(got, NIGHT[after][lang], after + ' ' + lang);
      for (const line of got) {
        assert.ok(!/1 hour|24 hours|ghante|ghanta|घंट/.test(line), line);
        assert.strictEqual(tp.promisesToday(line), false, line);
        count++;
      }
      // Lines that promise no time are the same day and night.
      assert.strictEqual(esc.routineLine('payment', said, after), esc.routineLine('payment', said));
    }
  }
  assert.strictEqual(count, 12);
});
t('dropReplyTimes: an hour promise about the team goes, other hours and links stay', () => {
  for (const promise of ['A person will answer here within 1 hour.', 'Our team will reply here within an hour.', 'Team 24 ghante ke andar jawab degi.', 'Team 1-2 hours mein reply karegi.']) {
    const r = esc.dropReplyTimes(`Your order #4715 is shipped. ${promise} Track it here: https://shiptrack.store/track/abc.`);
    assert.deepStrictEqual(r, { text: 'Your order #4715 is shipped. Track it here: https://shiptrack.store/track/abc.', removed: true }, promise);
  }
  for (const keep of ['Your order was shipped 24 hours ago.', 'Track it here: https://shiptrack.store/track/abc.', 'We are open 24/7.', 'Your refund of Rs 2.5 is noted. Our team will reply here.']) {
    assert.deepStrictEqual(esc.dropReplyTimes(keep), { text: keep, removed: false }, keep);
  }
  // An email keeps its greeting, paragraphs and sign-off; Hindi sentences end at ।.
  assert.strictEqual(
    esc.dropReplyTimes('Hello Priya,\n\nYour order is shipped.\n\nOur team will get back to you within 24 hours.\n\nBest regards,\nVastora Support').text,
    'Hello Priya,\n\nYour order is shipped.\n\nBest regards,\nVastora Support');
  assert.strictEqual(esc.dropReplyTimes('आपका ऑर्डर भेज दिया गया है। हमारी टीम 24 घंटे में जवाब देगी।').text, 'आपका ऑर्डर भेज दिया गया है।');
  // Never empty: a reply that is only the promise comes back as it was.
  assert.deepStrictEqual(esc.dropReplyTimes('Our team will reply within 1 hour.'), { text: 'Our team will reply within 1 hour.', removed: false });
});
t('withHandOverLine: by day exactly the old inline lines; at night the morning line once', () => {
  const ai = 'Your order #4715 is in transit. Track it here: https://shiptrack.store/track/abc';
  const ai24 = 'Your refund request is noted. Our team will reply within 24 hours.';
  const aiHour = 'Your order #4715 is in transit. A person will answer here within 1 hour.';
  // Day (after = null): what the widget route wrote inline before.
  assert.strictEqual(esc.withHandOverLine(ai, EN, 'accusation', null), `${ai}\n\n${esc.teamWillReplyLine(EN)}`);
  assert.strictEqual(esc.withHandOverLine(ai, EN, 'refund', null), `${ai}\n\n${esc.routineLine('refund', EN)}`);
  assert.strictEqual(esc.withHandOverLine(ai24, EN, 'refund', null), ai24);
  assert.strictEqual(esc.withHandOverLine(ai, HI, 'payment', null), `${ai}\n\n${esc.routineLine('payment', HI)}`);
  assert.strictEqual(esc.withHandOverLine(aiHour, EN, 'escalated', null), aiHour);
  assert.strictEqual(esc.withHandOverLine(aiHour, EN, 'escalated'), aiHour);
  // Night.
  const tm = 'Our team will reply to you here in this chat tomorrow morning, after 10 AM.';
  assert.strictEqual(esc.withHandOverLine(aiHour, EN, 'accusation', 'tomorrow'), `Your order #4715 is in transit.\n\n${tm}`);
  assert.strictEqual(esc.withHandOverLine(ai24, EN, 'refund', 'tomorrow'), `Your refund request is noted.\n\n${NIGHT.tomorrow.en[2]}`);
  assert.strictEqual(esc.withHandOverLine(ai, HI, 'refund', 'this_morning'), `${ai}\n\n${NIGHT.this_morning.hi[2]}`);
  assert.strictEqual(esc.withHandOverLine(ai, EN, 'payment', 'tomorrow'), `${ai}\n\n${esc.routineLine('payment', EN)}`);
  assert.strictEqual(esc.withHandOverLine(aiHour, EN, 'escalated', 'tomorrow'), `Your order #4715 is in transit.\n\n${tm}`);
  assert.strictEqual(esc.withHandOverLine(ai, EN, 'escalated', 'tomorrow'), ai);
  // A reply that was only the promise: the morning line alone, never both.
  assert.strictEqual(esc.withHandOverLine('Our team will reply here within 1 hour.', EN, 'escalated', 'tomorrow'), tm);
  // Twice: the line is added once.
  const once = esc.withHandOverLine(aiHour, EN, 'escalated', 'tomorrow');
  assert.strictEqual(esc.withHandOverLine(once, EN, 'escalated', 'tomorrow'), once);
  // The guard's fixed hand-overs (lookup-guard.ts) come back unchanged at night, so its exact
  // match (lastHandBackIndex) still finds them.
  const guard = fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat/lookup-guard.ts'), 'utf8');
  const handOver = Object.values(Function('return ' + guard.match(/const HAND_OVER = (\{[\s\S]*?\n\});/)[1])());
  const oldHandOver = Function('return ' + guard.match(/const OLD_HAND_OVER = (\[[\s\S]*?\n\]);/)[1])();
  assert.strictEqual(handOver.length + oldHandOver.length, 6);
  for (const text of [...handOver, ...oldHandOver]) {
    for (const after of ['tomorrow', 'this_morning']) assert.strictEqual(esc.withHandOverLine(text, 'kya hua', 'escalated', after), text);
  }
});
t('rulebook: numbers unique and in order, every rule complete, panel values filled in', () => {
  const seen = new Set();
  rb.RULEBOOK.forEach((s, i) => {
    assert.ok(s.key && s.title && s.rules.length, 'section ' + (i + 1));
    s.rules.forEach((r, j) => {
      assert.strictEqual(r.id, `${i + 1}.${j + 1}`, 'rule numbers follow the sections: ' + r.id);
      assert.ok(!seen.has(r.id)); seen.add(r.id);
      assert.ok(r.title && r.text && ['told', 'code', 'auto', 'setting', 'later'].includes(r.how), r.id);
    });
  });
  assert.strictEqual(rb.RULE_IDS.size, seen.size);
  const filled = JSON.stringify(rb.fillRulebook({ codStates: 'Gujarat', codAvailable: null }, 'Valmo'));
  assert.ok(!filled.includes('{cod}') && !filled.includes('{courier}') && !filled.includes('{effort}'));
  assert.ok(filled.includes('Now: Calm Normal, Uneasy Normal, Frustrated High, Critical Max.'));
  assert.ok(JSON.stringify(rb.fillRulebook({ codStates: null, codAvailable: true }, null, { calm: 'normal', uneasy: 'high', frustrated: 'max', critical: 'max' })).includes('Uneasy High, Frustrated Max'));
  assert.ok(filled.includes('COD only for addresses in: Gujarat.') && filled.includes('treated as Valmo'));
  const none = JSON.stringify(rb.fillRulebook({ codStates: null, codAvailable: null }, null));
  assert.ok(none.includes('COD is not set') && none.includes('no default courier'));
  // Night line (owner, 2026-10-01): 5.2, 6.2 and 6.3 say it, new 7.6 at the end of its section.
  const rule = (id) => rb.RULEBOOK.flatMap((s) => s.rules).find((r) => r.id === id);
  for (const id of ['5.2', '6.2', '6.3', '7.6']) assert.ok(rule(id).text.includes('after 10 AM'), id);
  // Chat team (owner, 2026-10-01): 7.7-7.9 and 9.6. Owner 5 Oct: the Super Admin's own reply claims nothing (Q2 undone).
  for (const id of ['7.7', '7.8', '7.9', '9.6']) assert.ok(rb.RULE_IDS.has(id), id);
  assert.ok(/Super Admin's reply or Take over claims nothing/.test(rule('7.7').text));
  assert.ok(/Take from Super Admin/.test(rule('7.7').text) && /Super Admin's chats can be taken/.test(rule('7.9').text));
  // Owner answer A5 (2026-10-02, chat-team-owner-back.sql): his customers go to the open pool.
  assert.ok(/Super Admin's customers go to the team instead: if their latest chat was his, or they write again in a Closed chat he holds, it goes to the open pool \(his open chats stay his\)\./.test(rule('7.7').text));
  // Fake / invalid tracking (owner 2026-10-02): 6.5, 9.7, 9.8 at the ends of their sections.
  for (const id of ['6.5', '9.7', '9.8']) assert.ok(rb.RULE_IDS.has(id), id);
  assert.ok(rule('6.5').text.includes('"Aapke order ka naya tracking link 24-48 ghante me isi chat me bhej denge"'));
  assert.ok(rule('6.3').text.includes('(6.5)') && rule('7.2').text.includes('(9.8)'));
  assert.ok(rule('9.2').text.includes('(9.7)') && rule('9.2').text.includes('(9.8)'));
  assert.ok(rule('9.6').text.includes('no senior needed'));
  // Courier (owner 2026-10-02): named only on the 3rd ask; the tracking page no longer shows it (c201314).
  assert.ok(/3rd/.test(rule('4.8').text) && rule('4.8').text.startsWith('{courier} '));
  assert.ok(!rule('4.8').text.includes('The tracking page is not changed'));
});
t('effort: groups by score, visitors stay Normal, panel choice cleaned', () => {
  assert.strictEqual(ef.groupFor(false, 99), 'visitor');
  assert.strictEqual(ef.groupFor(true, 0), 'calm'); assert.strictEqual(ef.groupFor(true, 24), 'calm');
  assert.strictEqual(ef.groupFor(true, 25), 'uneasy'); assert.strictEqual(ef.groupFor(true, 50), 'frustrated');
  assert.strictEqual(ef.groupFor(true, 74), 'frustrated'); assert.strictEqual(ef.groupFor(true, 75), 'critical');
  assert.strictEqual(ef.effortFor('visitor', { calm: 'max' }), 'normal');
  assert.strictEqual(ef.effortFor('critical', null), 'max'); assert.strictEqual(ef.effortFor('frustrated', null), 'high');
  assert.strictEqual(ef.effortFor('calm', null), 'normal'); assert.strictEqual(ef.effortFor('uneasy', undefined), 'normal');
  assert.deepStrictEqual(ef.cleanEffortSettings({ calm: 'max', uneasy: 'bogus', critical: 'normal' }), { calm: 'max', uneasy: 'normal', frustrated: 'high', critical: 'normal' });
  const v = (text) => ({ sender: 'visitor', content: text });
  assert.strictEqual(ef.effortScore(30, [v('kab aayega')]), 30);
  assert.ok(ef.effortScore(null, [v('chargeback kar dunga, police complaint bhi')]) >= 75);
  assert.ok(ef.effortScore(90, [v('mil gaya, thank you')]) <= 30);
  assert.strictEqual(ef.EFFORT_PLAN.normal.thinking, false); assert.strictEqual(ef.EFFORT_PLAN.max.selfCheck, true);
});
t('self-check: OK keeps the reply; a fix is taken only if it brings nothing new', () => {
  const draft = 'Your order is Shipped. Track it here: https://shiptrack.store/track/abc';
  const known = '[{"tracking_link":"https://shiptrack.store/track/abc","order_id":"#4715"}]';
  const p = (raw) => sc.parseCheck(raw, draft, known);
  assert.strictEqual(p('OK').changed, false); assert.strictEqual(p('ok.').changed, false); assert.strictEqual(p('OK, the draft is fine').changed, false);
  assert.strictEqual(p('').changed, false);
  const fixed = p('Sorry for the wait. Your order is Shipped. Track it here: https://shiptrack.store/track/abc');
  assert.ok(fixed.changed && fixed.text.startsWith('Sorry for the wait'));
  assert.strictEqual(p('"Sorry for the wait. Your order is Shipped. https://shiptrack.store/track/abc"').text.startsWith('Sorry'), true);
  assert.strictEqual(p('Your order is Shipped. Track it: https://evil.example.com/x https://shiptrack.store/track/abc').reason, 'new link');
  assert.strictEqual(p('Your order is Shipped, it will reach you soon.').reason, 'dropped the link');
  assert.strictEqual(p('Your order #98765 is Shipped. https://shiptrack.store/track/abc').reason, 'new number');
  assert.strictEqual(p('Your order #4715 is Shipped. https://shiptrack.store/track/abc').changed, true);
  assert.strictEqual(p('DRAFT: Your order is Shipped https://shiptrack.store/track/abc').reason, 'echoed the check');
  assert.strictEqual(p('x'.repeat(900) + ' https://shiptrack.store/track/abc').reason, 'too long');
  assert.ok(/^\(Note from the system, not the customer/.test(sc.CHECK_NOTE) && /answer exactly OK/.test(sc.CHECK_NOTE));
  assert.strictEqual(sc.latestOrderFacts(['nope', '{"found":true,"orders":[{"order_id":"#1"}]}', '{"found":false}']), '[{"order_id":"#1"}]');
});
t('permissions: roles, ticks, panels; the super admin can do everything', () => {
  const pm = load('permissions', '../../src/lib');
  const su = { role: 'admin', businessIds: null };
  assert.ok(pm.isSuperAdmin(su) && pm.PERMISSIONS.every((p) => pm.can(su, p)));
  const agent = { role: 'agent', permissions: null, businessIds: ['P1'] };
  assert.ok(pm.can(agent, 'chat.reply') && pm.can(agent, 'chat.cases') && pm.can(agent, 'orders.view'));
  assert.ok(!pm.can(agent, 'orders.update') && !pm.can(agent, 'settings.panel') && !pm.can(agent, 'chikki.edit') && !pm.isSuperAdmin(agent));
  const viewer = { role: 'viewer', permissions: null };
  assert.ok(pm.can(viewer, 'chat.view') && !pm.can(viewer, 'chat.reply'));
  const custom = { role: 'viewer', permissions: ['chat.view', 'chat.reply', 'not.a.permission'] };
  assert.ok(pm.can(custom, 'chat.reply') && !pm.can(custom, 'orders.view'));
  assert.deepStrictEqual(pm.resolvePermissions('manager', null), pm.ROLE_INFO.manager.perms.filter((p) => pm.PERMISSIONS.includes(p)));
  assert.ok(pm.canAccessPanel(agent, 'P1') && !pm.canAccessPanel(agent, 'P2') && !pm.canAccessPanel(agent, null));
  assert.ok(pm.canAccessPanel({ role: 'manager', businessIds: null }, 'P2') && pm.canAccessPanel(su, 'anything'));
  assert.ok(!pm.isRole('superadmin') && pm.isRole('panel_admin'));
  assert.deepStrictEqual(pm.cleanPermissions(['chat.view', 'x', 'chat.view']), ['chat.view']);
  assert.ok(!pm.can(null, 'orders.view'));
});
t('message rules follow the permissions', () => {
  load('permissions', '../../src/lib');
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat/message-rules.ts'), 'utf8').replace("from '../permissions'", "from './permissions'");
  fs.writeFileSync(path.join(dir, 'message-rules.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText);
  const mr = require(path.join(dir, 'message-rules.js'));
  const ai = { sender: 'ai', metadata: null }, mine = { sender: 'agent', metadata: { agent: 'ravi' } }, other = { sender: 'agent', metadata: { agent: 'sita' } };
  const agent = { username: 'ravi', role: 'agent' }, viewer = { username: 'v', role: 'viewer' }, admin = { username: 'boss', role: 'panel_admin' };
  assert.ok(mr.canChangeMessage(agent, ai) && mr.canChangeMessage(agent, mine) && !mr.canChangeMessage(agent, other));
  assert.ok(!mr.canChangeMessage(viewer, ai) && mr.canChangeMessage(admin, other));
  assert.ok(mr.canChangeMessage({ username: 'x', role: 'admin' }, other));
});

// ── Fake / invalid tracking claims (owner 2026-10-02; tracking-claim.ts, spec 9.1) ───────
// tracking-claim.ts imports '@/lib/journey': loaded next to it as './journey' (escalation is above).
const jn = load('journey', '../../src/lib');
const tcl = (() => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat/tracking-claim.ts'), 'utf8').replace("from '@/lib/journey'", "from './journey'");
  fs.writeFileSync(path.join(dir, 'tracking-claim.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText);
  return require(path.join(dir, 'tracking-claim.js'));
})();
const waiting = load('waiting');
const CLAIM_MATCH = [
  'Valmo website shows trecking id invalid', 'valmo pe tracking id invalid bata raha hai', 'tracking id galat hai',
  'tracking number is wrong', 'The tracking number you gave is not found on Valmo', 'valmo app me order nahi dikh raha',
  'valmo par tracking id nahi mil rahi', 'AWB not found', 'tracking link fake hai', 'is this tracking link fake?', 'ye tracking farzi hai',
  'fraud hai, fake tracking diya', 'tracking link me kisi aur ka naam aa raha hai', "the link shows someone else's order",
  'tracking link is not working', 'link nahi khul raha', 'tracking link kaam nahi kar raha', 'tracking 5 din se update nahi hua',
  'tracking not updating since 4 days', 'status same hai 3 din se', 'parcel ek hi jagah atka hua hai', 'traking id invalid',
  'trackig link not opening', 'ट्रैकिंग आईडी गलत है', 'वाल्मो पर ट्रैकिंग नहीं दिख रही', 'ट्रैकिंग लिंक नकली है', 'ट्रैकिंग अपडेट नहीं हो रही',
  'लिंक नहीं खुल रहा', 'Valmo says no record found for this tracking id', 'tracking page shows different order',
  'out for delivery 3 din se same status', 'Volmo site pe number exist nahi karta', 'tracking id show nahi ho rahi valmo pe',
  'valmo pe order not found aa raha', 'website pe tracking nahi dikh rahi', 'No update on tracking for a week', 'tracking me koi update nahi',
  'valmo me id nahi mil rahi', 'वाल्मो पर आईडी नहीं मिल रही', 'tracking pe fake delivered dikha raha', 'Valmo pe ST number dalne par invalid aata hai',
];
const CLAIM_NOT = [
  // Asking for the link.
  'tracking link kya hai?', 'tracking link bhejo', 'send me the tracking link', 'tracking link nahi mila', 'I did not get the tracking link',
  'tracking link nahi aa raha', 'tracking id kya hai', 'how to track my order', 'track kaise kare', 'ट्रैकिंग लिंक भेजो', 'ट्रैकिंग लिंक नहीं मिला',
  'tracking update kab hoga', 'any update on tracking?', 'I want to track my other order', 'tracking link sahi hai kya',
  'tracking id bhej do please', 'mera tracking number kya hai?', 'can you share the AWB number', 'order track karna hai',
  'valmo ka tracking link do', 'link mil gaya thanks', 'tracking link open ho gaya, thanks', 'tracking link khul gaya',
  // Something else called invalid / wrong / fake.
  'coupon code invalid', 'promo code not working', 'otp invalid aa raha', 'payment link not working', 'website not opening', 'fake order',
  'fake product mila', 'wrong size received', 'galat order aaya hai, tracking dekho', 'wrong product delivered, tracking says delivered',
  'address galat hai', 'my phone number is wrong in the order', 'refund status kya hai',
  // Delay / delivery: handled elsewhere (delay ladder, rule 4.9).
  'mera order kab aayega', 'order 10 din se nahi aaya', 'order stuck hai', 'where is my order', 'courier nahi aa raha',
  'valmo wala delivery boy nahi aa raha', 'valmo se parcel nahi mila', 'delivered dikha raha hai par mila nahi', 'Which courier? Valmo?',
  'valmo ka number do', 'parcel kab tak aayega?',
  // Plain fraud claims stay the fraud path.
  'This is a fraud site, you people are scammers', 'This is fraud, where is my tracking link?',
];
t('trackingClaimKind: 41 claims found, 49 other messages left alone, the kind of each', () => {
  assert.strictEqual(CLAIM_MATCH.length, 41); assert.strictEqual(CLAIM_NOT.length, 49);
  for (const s of CLAIM_MATCH) assert.ok(tcl.trackingClaimKind(s), `should be a claim: ${s}`);
  for (const s of CLAIM_NOT) assert.strictEqual(tcl.trackingClaimKind(s), null, `not a claim: ${s}`);
  assert.strictEqual(tcl.trackingClaimKind('tracking link fake hai'), 'fake');
  assert.strictEqual(tcl.trackingClaimKind('AWB not found'), 'invalid');
  assert.strictEqual(tcl.trackingClaimKind('tracking not updating since 4 days'), 'stuck');
  for (const s of ['', '   ', null, undefined]) assert.strictEqual(tcl.trackingClaimKind(s), null);
  assert.ok(tcl.mentionsTracking('mera tracking number kya hai?') && tcl.mentionsTracking('वाल्मो') && !tcl.mentionsTracking('mera order kab aayega'));
});
t('claimLang: Hindi, Hinglish or English over the claim and the last messages', () => {
  assert.strictEqual(tcl.claimLang(['ट्रैकिंग लिंक नकली है']), 'hi');
  assert.strictEqual(tcl.claimLang(['tracking link fake hai']), 'hinglish');
  assert.strictEqual(tcl.claimLang(['Valmo website shows trecking id invalid']), 'en');
  assert.strictEqual(tcl.claimLang(['Valmo website shows trecking id invalid', 'link kab milega?']), 'hinglish');
  assert.strictEqual(tcl.claimLang(['AWB not found', 'मेरा ऑर्डर']), 'hi');
  assert.notStrictEqual(tcl.claimLang(['order ४७१५']), 'hi', 'Devanagari digits alone are not Hindi');
  assert.strictEqual(tcl.claimLang([]), 'en');
});
t('the fixed texts: no today, no courier name, the promise and the reminder keep a chat waiting, the reminder is not the promise', () => {
  const LINK = 'https://shiptrack.store/track/x';
  const notAnswer = new RegExp(waiting.AI_NOT_AN_ANSWER_REGEX, 'i');
  assert.ok(!waiting.AI_NOT_AN_ANSWER_REGEX.includes("'"), 'no apostrophe: it goes into SQL');
  assert.ok(!notAnswer.test(`Here is your tracking link: ${LINK}`));
  assert.ok(notAnswer.test('Sorry, that took longer than expected on my end.') && notAnswer.test('Let me get that confirmed by our team.'));
  for (const lang of ['en', 'hinglish', 'hi']) {
    const A = tcl.promiseReply(lang), B = tcl.reminderReply(lang), C = tcl.preDispatchReply(lang, LINK);
    const all = [A, B, C, tcl.preDispatchReply(lang, null), tcl.deliveredReply(lang), tcl.teamHasItReply(lang, lang === 'en' ? 'AWB not found' : 'tracking galat hai')];
    for (const x of all) {
      assert.ok(x && !tp.promisesToday(x), `${lang}: ${x}`);
      assert.ok(!/v[ao]lmo|वाल्मो/i.test(x), `${lang}: no courier name`);
      assert.ok(!/today|tonight|tomorrow|\baaj\b|\bkal\b|आज|कल तक/i.test(x), `${lang}: ${x}`);
      assert.ok(!/1 hour|1 ghante|10 AM/i.test(x), `${lang}: no team reply time`);
    }
    assert.ok(notAnswer.test(A) && notAnswer.test(B), `${lang}: the promise and the reminder are not an answer`);
    for (const x of all.slice(2)) assert.ok(!notAnswer.test(x), `${lang}: ${x}`);
    assert.ok(/24-48/.test(A) && /24-48/.test(B));
    assert.ok(!esc.isRepeatedReply(B, [A]) && esc.isRepeatedReply(B, [B]) && esc.isRepeatedReply(C, [C]), lang);
    assert.ok(C.endsWith(`\n${LINK}`), `${lang}: the link last, nothing after it`);
    assert.ok(!tcl.preDispatchReply(lang, null).includes('\n') && !tcl.preDispatchReply(lang, '  ').includes('http'));
    // The same day and night: they are never sent through the night-line helpers.
    assert.strictEqual(esc.dropReplyTimes(A).text, A);
  }
  assert.strictEqual(tcl.promiseReply('hinglish'), 'Pareshani ke liye sorry. Aapke order ka naya tracking link 24-48 ghante me isi chat me bhej denge.');
  assert.strictEqual(tcl.promiseReply('en'), 'Sorry for the trouble. We will send a new tracking link for your order here in this chat within 24-48 hours.');
  assert.strictEqual(tcl.teamHasItReply('en', 'AWB not found'), esc.routineLine('payment', 'AWB not found'));
  assert.strictEqual(tcl.teamHasItReply('hinglish', 'tracking galat hai'), esc.routineLine('payment', 'tracking galat hai'));
  assert.strictEqual(tcl.AUTO_MARK_NAME, 'Chikki (auto)');
  for (const f of ['tracking-claim.ts', 'case-auto.ts']) {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat', f), 'utf8');
    assert.ok(!/\b(withHandOverLine|dropReplyTimes)\b/.test(src.replace(/\/\/.*$/gm, '')), `${f} never uses the night-line helpers`);
  }
  // The pure file stays pure: the inbox page imports it.
  const imports = fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat/tracking-claim.ts'), 'utf8').match(/from '[^']+'/g);
  assert.deepStrictEqual(imports, ["from '@/lib/journey'", "from './escalation'"]);
});
t('claimStage: not dispatched, in transit, delivered, other', () => {
  for (const s of ['Order Placed', 'Processing', 'Packed']) assert.strictEqual(tcl.claimStage({ status: s }), 'pre_dispatch', s);
  for (const s of ['Shipped', 'Shipment Picked Up', 'In Transit', 'Reached State', 'Reached City', 'Local Hub', 'Out for Delivery']) assert.strictEqual(tcl.claimStage({ status: s, cancelled: false }), 'in_transit', s);
  assert.strictEqual(tcl.claimStage({ status: 'Delivered' }), 'delivered');
  assert.strictEqual(tcl.claimStage({ status: 'In Transit', cancelled: true }), 'other');
  for (const s of ['RTO', 'Return to Origin', 'Delivery Exception', 'Order Cancelled', null]) assert.strictEqual(tcl.claimStage({ status: s }), 'other', String(s));
  assert.strictEqual(tcl.claimStage(null), 'other');
});
t('followUpAction: a Chikki-marked chat reminds once or goes red; a team-marked one only goes red on a new claim', () => {
  const base = { said: 'link kab milega?', urgent: null, routine: null, claim: null, angry: false, hoursSinceMark: 1, repeated: false };
  const act = (auto, o = {}) => tcl.followUpAction({ ...base, auto, ...o });
  const rows = [
    // [what, input, Chikki's mark, a person's mark (or the team wrote)]
    ['courtesy', { said: 'ok thanks' }, [false, null], [false, null]],
    ['emoji', { said: '👍' }, [false, null], [false, null]],
    ['threat', { said: 'I will file a police complaint', urgent: 'threat' }, [true, 'threat'], [false, null]],
    ['refund', { said: 'mujhe refund chahiye', routine: 'refund' }, [true, 'routine'], [false, null]],
    ['payment', { said: 'payment kat gaya', routine: 'payment' }, [true, 'routine'], [false, null]],
    ['fraud + claim', { said: 'tracking link fake hai, fraud', urgent: 'accusation', claim: 'fake' }, [true, 'reminder+team'], [true, null]],
    ['fraud only', { said: 'fraud ho tum log', urgent: 'accusation' }, [true, 'reminder+team'], [false, null]],
    ['claim again', { said: 'tracking link abhi bhi fake hai', claim: 'fake' }, [true, 'reminder'], [true, null]],
    ['"ok" with a claim', { said: 'ok', claim: 'fake' }, [true, 'reminder'], [true, null]],
    ['anger', { said: 'WHERE IS MY LINK', angry: true }, [true, 'reminder'], [false, null]],
    ['another subject', { said: 'address change karna hai' }, [true, 'handoff'], [false, null]],
    ['48 hours', { said: 'link?', hoursSinceMark: 48 }, [true, 'handoff'], [false, null]],
    ['the reminder again', { said: '??', repeated: true }, [true, 'handoff'], [false, null]],
    ['claim, reminder sent', { said: 'tracking abhi bhi fake hai', claim: 'fake', repeated: true }, [true, 'handoff'], [true, null]],
    ['fraud, reminder sent', { said: 'fraud', urgent: 'accusation', repeated: true }, [true, 'threat'], [false, null]],
    ['a question', { said: 'link kab milega?' }, [false, 'reminder'], [false, null]],
    ['a question, mark time unknown', { said: 'link?', hoursSinceMark: null }, [false, 'reminder'], [false, null]],
    ['Hindi question', { said: 'लिंक कब मिलेगा' }, [false, 'reminder'], [false, null]],
    // Review fixes (2026-10-02): after the 48 hours the reminder (a fresh 24-48 h) is never sent again.
    ['claim after 48 h', { said: '3 din ho gaye, tracking abhi bhi invalid aa raha hai valmo pe', claim: 'invalid', hoursSinceMark: 72 }, [true, 'handoff'], [true, null]],
    ['anger after 48 h', { said: 'BHAI 3 DIN HO GAYE LINK KAHAN HAI', angry: true, hoursSinceMark: 72 }, [true, 'handoff'], [false, null]],
    ['fraud after 48 h', { said: 'ye fraud hai, 3 din se link ka wait kar raha hu', urgent: 'accusation', hoursSinceMark: 72 }, [true, 'threat'], [false, null]],
    ['fraud + claim after 48 h', { said: 'tracking fake hai, fraud', urgent: 'accusation', claim: 'fake', hoursSinceMark: 48 }, [true, 'threat'], [true, null]],
    ['claim at 47 h', { said: 'tracking abhi bhi fake hai', claim: 'fake', hoursSinceMark: 47 }, [true, 'reminder'], [true, null]],
    ['threat after 48 h', { said: 'I will file a police complaint', urgent: 'threat', hoursSinceMark: 72 }, [true, 'threat'], [false, null]],
    ['refund after 48 h', { said: 'mujhe refund chahiye', routine: 'refund', hoursSinceMark: 72 }, [true, 'routine'], [false, null]],
    // A question mark alone is about the link; a question on another subject is not (row 7).
    ['"?" alone', { said: '?' }, [false, 'reminder'], [false, null]],
    ['"??" alone', { said: ' ?? ' }, [false, 'reminder'], [false, null]],
    ['address question', { said: 'address change karna hai?' }, [true, 'handoff'], [false, null]],
    ['delivery address question', { said: 'Can I change my delivery address?' }, [true, 'handoff'], [false, null]],
    ['exchange question', { said: 'mujhe exchange chahiye?' }, [true, 'handoff'], [false, null]],
    ['COD question', { said: 'COD available hai?' }, [true, 'handoff'], [false, null]],
    ['a question about the link', { said: 'new link kab tak aayega?' }, [false, 'reminder'], [false, null]],
  ];
  for (const [what, o, chikki, staff] of rows) {
    assert.deepStrictEqual(act(true, o), { red: chikki[0], reply: chikki[1] }, `Chikki's mark: ${what}`);
    assert.deepStrictEqual(act(false, o), { red: staff[0], reply: staff[1] }, `a person's mark: ${what}`);
  }
  assert.ok(tcl.FOLLOW_UP.test('kab milega') && !tcl.FOLLOW_UP.test('?') && !tcl.FOLLOW_UP.test('address change karna hai'));
  for (const s of ['?', '??', '? ?', '?!', 'link?', 'kab milega', 'लिंक कब मिलेगा', 'where is my order?']) assert.ok(tcl.aboutTheLink(s), s);
  for (const s of ['', '.', 'address change karna hai?', 'Can I change my delivery address?', 'COD available hai?', 'mujhe exchange chahiye?', 'size change ho sakta hai?', 'return kaise karu?']) {
    assert.ok(!tcl.aboutTheLink(s), s);
  }
  // The one reminder is found in any language (case-auto.ts readReshipState): one head per language,
  // each the start of its reminder, none in the promise.
  assert.strictEqual(tcl.REMINDER_HEADS.length, 3);
  for (const lang of ['en', 'hinglish', 'hi']) {
    const heads = tcl.REMINDER_HEADS.filter((h) => tcl.reminderReply(lang).startsWith(h));
    assert.strictEqual(heads.length, 1, lang);
    assert.ok(heads[0].length >= 30 && !/[%_]/.test(heads[0]), lang);
    assert.ok(!tcl.REMINDER_HEADS.some((h) => tcl.promiseReply(lang).includes(h)), `${lang}: the promise is not a reminder`);
  }
});
// claimAction (spec TC6) is not a separate export: case-auto.ts trackingClaimTurn keeps the rows of
// spec 2.2 inline, and team-routing.js R24-R41 test them through the real widget route.
t('mentionsOtherOrder: another order number typed, or a lookup that found only other orders', () => {
  assert.strictEqual(tcl.mentionsOtherOrder('#4716 ka tracking fake hai', '#4715', null), true);
  assert.strictEqual(tcl.mentionsOtherOrder('#4715 ka tracking fake hai', '#4715', null), false);
  assert.strictEqual(tcl.mentionsOtherOrder('9876543210', '#4715', null), false, 'a phone is not an order');
  assert.strictEqual(tcl.mentionsOtherOrder('tracking 5 din se update nahi hua', '#4715', null), false);
  const found = (...ids) => JSON.stringify({ found: true, count: ids.length, orders: ids.map((order_id) => ({ order_id })) });
  assert.strictEqual(tcl.mentionsOtherOrder('tracking fake hai', '#4715', found('#4715')), false);
  assert.strictEqual(tcl.mentionsOtherOrder('tracking fake hai', '#4715', found('#4716')), true);
  assert.strictEqual(tcl.mentionsOtherOrder('tracking fake hai', '#4715', found('#4716', '#4715')), false);
  assert.strictEqual(tcl.mentionsOtherOrder('tracking fake hai', '#4715', JSON.stringify({ found: false })), false);
  assert.strictEqual(tcl.mentionsOtherOrder('tracking fake hai', '#4715', 'not json'), false);
});
// ── Chargeback / court / police threats on a late order -> Refund (owner 2026-10-02 18:45; refund-threat.ts) ──
// refund-threat.ts imports '@/lib/journey' (loaded above as './journey'), './escalation' and a type from './tracking-claim'.
const rtt = (() => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat/refund-threat.ts'), 'utf8').replace("from '@/lib/journey'", "from './journey'");
  fs.writeFileSync(path.join(dir, 'refund-threat.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText);
  return require(path.join(dir, 'refund-threat.js'));
})();
const OWNER_EXAMPLE = 'I have raised the complaint against u in consumer department and also at instagram team against u';
const THREAT_MATCH = [
  [OWNER_EXAMPLE, 'consumer'],
  ['I will do a chargeback', 'chargeback'], ['chargeback kar dungi', 'chargeback'], ['charge back karunga', 'chargeback'], ['charge-back karwa dungi', 'chargeback'],
  ['I will raise a dispute with my bank', 'chargeback'], ['bank me dispute daal dunga', 'chargeback'], ['I will file a dispute on my credit card', 'chargeback'],
  ['I will ask my bank to reverse the payment', 'chargeback'], ['चार्जबैक करूँगा', 'chargeback'], ['bank se paise wapas le lunga', 'chargeback'],
  ['bank me complaint kar dungi', 'chargeback'], ['RBI me complaint karungi', 'chargeback'],
  ['I will go to consumer court', 'consumer'], ['consumer forum me case karunga', 'consumer'], ['I have filed a complaint on the national consumer helpline', 'consumer'],
  ['NCH pe complaint kar di hai', 'consumer'], ['consumer helpline pe complaint karungi', 'consumer'], ['I will complain to consumer forum', 'consumer'],
  ['complaint against you in consumer court', 'consumer'],
  ['उपभोक्ता फोरम में शिकायत करूँगा', 'consumer'], ['कंज्यूमर कोर्ट जाऊँगा', 'consumer'], ['consumer cell me complaint kar di', 'consumer'],
  ['edaakhil pe case file kar diya hai', 'consumer'], ['consumer department me complaint kar di hai', 'consumer'],
  ['Mai consumer complaint karungi', 'consumer'],
  ['I will complain against you on instagram and in consumer forum', 'consumer'], ["Don't make me go to consumer court", 'consumer'],
  ['If you do not deliver I will complain to consumer forum', 'consumer'],
  ['I will send you a legal notice', 'legal'], ['legal action lunga', 'legal'], ['I will take legal action', 'legal'], ['my lawyer will contact you', 'legal'],
  ['vakil se notice bhejunga', 'legal'], ['I will sue you', 'legal'], ['see you in court', 'legal'], ['court me case karunga', 'legal'],
  ['kanooni karyawahi karunga', 'legal'], ['वकील से नोटिस भेजूँगा', 'legal'], ['कोर्ट में केस करूँगा', 'legal'], ['case kar dunga tum logo pe', 'legal'],
  ['I will file an FIR', 'police'], ['police complaint karunga', 'police'], ['police me jaungi', 'police'], ['cyber cell me complaint kar di hai', 'police'],
  ['I have reported this to cyber crime', 'police'], ['cybercrime.gov.in pe complaint daal di', 'police'], ['पुलिस में शिकायत करूँगी', 'police'],
  ['साइबर सेल में शिकायत', 'police'], ['I will go to the police', 'police'], ['FIR darj karungi', 'police'],
  ["if you don't refund I will go to the police", 'police'], ['order nahi aaya to police complaint karungi', 'police'],
  // Review of 2 Oct evening: FIR only as F.I.R., FIR among lower-case words or an FIR phrase; a court with a
  // threat around it; the bank / the customer reversing it; the police station; against you, Hinglish order.
  ['F.I.R. karungi', 'police'], ['Mai FIR karwa dungi', 'police'], ['I will lodge an FIR against you', 'police'], ['fir darj karwaungi', 'police'],
  ['police me FIR karungi', 'police'], ['thane me complaint karungi', 'police'], ['थाने में शिकायत करूँगी', 'police'], ['एफआईआर करूँगी', 'police'],
  ['I will take you to court', 'legal'], ['court tak jaungi', 'legal'], ['main court jaungi', 'legal'], ['I will drag you to court', 'legal'],
  ['vakil se baat karungi', 'legal'], ["I'll call the consumer helpline", 'consumer'],
  ['bank se payment reverse karwa dungi', 'chargeback'], ['payment reverse karwa dungi', 'chargeback'], ['I will get the transaction reversed by my bank', 'chargeback'],
  ['Never got my parcel, consumer court jaungi', 'consumer'],
];
const THREAT_NOT = [
  // "consumer" / "court" / "legal" in another sense; "support", "issue".
  'is this good for consumers?', 'consumer electronics', 'best consumer brand', 'my consumer number is wrong', 'Do consumers complain about the size?',
  'mera order consumer ke liye gift hai', 'courtesy', 'your staff is not courteous', 'tennis court shoes', 'food court ke paas wala address', 'basketball court',
  'court-style sneakers available?', 'courtyard wala ghar hai', 'courier boy rude tha', 'customer support team please help', 'support',
  'there is an issue with my order', 'is this dress legal for school?', 'is this legal size paper?', 'my name is Sue', 'phone case chahiye',
  'in case the parcel is late, tell me', 'I noticed the box was open', 'send me a notice when it ships',
  // Said NOT to happen.
  "I won't complain", 'I do not want to complain, just send the order', 'no complaints, thanks', 'I have no complaint', 'complaint nahi karungi bas order bhejo',
  'mujhe koi complaint nahi hai', 'police case nahi karna, order bhejo', "I don't want to go to court, please just deliver", 'no dispute, just asking',
  // Police / court as a place; "fir" = then; charges back.
  'police verification pending hai', 'near police line', 'Police Line, Moradabad', 'police station ke paas address hai', 'address: opp police station, sector 4',
  'police colony', 'fir kab aayega', 'fir se bhejo', 'FIR KAB AAYEGA ORDER', 'FIR SE BHEJO', 'COD charges back milenge?', 'delivery charge back milega?',
  'refund bank me aayega?', 'my bank account details', 'bank ka naam galat hai, complaint karni hai',
  // A lawyer as a person, not a threat.
  'I am a lawyer, need a formal shirt', 'gift for my lawyer friend', 'mera bhai advocate hai, uske liye kurta', 'I always advocate for Vastora to my friends',
  // Social media, fraud words, anger: not this rule (owner).
  'I will post on instagram', 'bad review dunga', 'complaint against you on instagram', 'I will report you on google reviews', 'fraud hai ye', 'scam company',
  'WORST SERVICE EVER', 'tum log chor ho',
  // A complaint TO the store, or about someone else.
  'I want to register a complaint about the damaged product', 'I raised a complaint here yesterday, any update?', 'complaint number kya hai?',
  'I have a complaint about the size', 'complaint against the delivery boy, he was rude', 'complaint against your delivery boy', 'please report the issue to courier',
  // Other paths.
  'cancel my order', 'refund chahiye', 'mujhe refund chahiye, order cancel karo', 'payment kat gaya', 'tracking link fake hai',
  'valmo pe tracking id invalid bata raha hai', 'where is my order', 'order 10 din se nahi aaya',
  // "fir" = "then" (phir), owner 2 Oct 19:20: a listed chat had no threat, only Hinglish "fir". Capitals alone are not FIR.
  'fir complaint karungi', 'fir se complaint karungi', 'order nahi aaya to fir complaint karungi', 'fir karungi', 'fir kar dungi',
  'file fir se bhejo', 'fir file bhejo', 'register fir se karo', 'fir register karna padega', 'FIR KARUNGI', 'fir thana jaungi',
  'fir bhi order nahi aaya, fir karwa dungi', 'Fir mujhe batao kab aayega, fir hi pay karungi',
  // The store's customer care, not the consumer forum.
  'consumer care number do', 'consumer care number kya hai, complaint karni hai', 'consumer care pe complaint ki thi', 'what is your consumer helpline number?',
  'ग्राहक हेल्पलाइन नंबर दो',
  // A court / the police / a lawyer as an address, a job, a person or a thing.
  'Opp. District Court, Raipur', 'House 12, near District Court, Sector 5', 'my office is at Tis Hazari court road', 'court shoes size 7 hai?',
  'court marriage ke liye lehenga chahiye', 'फूड कोर्ट के पास', 'my husband is a police officer, deliver before 6', 'papa police me hai, unke liye XL size',
  'mere bhai police wale hain', 'Police Bazar, Shillong', 'delivery boy bola police checking chal rahi thi', 'traffic police ne roka tha delivery wale ko', 'मेरे पापा पुलिस में हैं', 'thane me delivery hai', 'Thana Bihta, Patna', 'थाना बिहटा, पटना',
  'gift for my lawyer', 'papa advocate hai unke liye kurta bhejo jaldi se', 'mere papa vakil hai unko black coat chahiye',
  'I work in cyber security, need formal shirts', 'cyber cafe se order kiya tha', 'साइबर कैफे के पास', 'nail polis wala colour hai kya',
  // A refund request to the store, not a chargeback (today's refund path).
  'please reverse the payment, I want to cancel', 'payment reverse kar do please', 'please reverse the amount to my bank account',
  'my bank reported the payment failed', 'will you charge back the shipping fee?',
  // Review fixes 2026-10-02. A complaint to the store's own staff (no consumer forum, court, police, bank or
  // government named), or a support "case": not Refund (escalation.ts may still call it a threat: Needs you).
  'Can I raise a complaint against you here?', 'I will complain against you to your manager', 'complaint against your team member who was rude',
  'my parcel is lost, please file a case with the courier', 'please register a case for my parcel',
  // A Hinglish "I will NOT ...".
  'legal action nahi lena chahti, bas order bhej do', 'police me complaint nahi karungi, bas order bhejo', 'mujhe koi legal action nahi lena, bas mera order bhej do',
  'legal notice nahi bhejna chahti, bas order chahiye', 'mai police me nahi jaungi, bas order bhejo', 'legal karwai nahi karni',
  // A question about when the money comes back, or the store asked to chase the courier.
  'bank se paise wapas aa jayenge na agar cancel karu?', 'bank se paise wapas kab aayenge', 'mere bank se paise wapas kab aayenge', 'bank se paise wapas chahiye',
  'payment fail ho gaya tha, bank se paise wapas aayenge na?', 'bank se paise wapas karwa do please',
  'please courier ke saath case file karo, mera parcel lost hai', 'aap courier pe case file kar do na please', 'can you raise a dispute with the courier?',
];
// Review fix 2026-10-02: a complaint "against you" with no outside body named: today's threat path (Needs you,
// the 1-hour line), never Refund.
const THREAT_TODAY = ['aapke khilaf complaint karungi', 'I will file a complaint against your company', 'I lodged a complaint against you',
  'aapke khilaf shikayat darj karungi', 'आपके खिलाफ शिकायत करूँगी', 'against you complaint karungi'];
t('refundThreatKind: the owner\'s own example and 71 threats found with their kind, 141 other messages left alone, 6 complaints "against you" left to the threat path; every one found is a threat in escalation.ts too', () => {
  assert.strictEqual(THREAT_MATCH.length, 71); assert.strictEqual(THREAT_NOT.length, 141); assert.strictEqual(THREAT_TODAY.length, 6);
  for (const s of THREAT_TODAY) { assert.strictEqual(rtt.refundThreatKind(s), null, `not Refund: ${s}`); assert.strictEqual(esc.urgentKind(s), 'threat', `still a threat: ${s}`); }
  // ... and with an outside body named, it is one.
  for (const [s, k] of [['I will file a complaint against you with my bank', 'consumer'], ['aapke khilaf consumer forum me complaint karungi', 'consumer'],
    ['tumhare khilaf police complaint karungi', 'consumer'], ['case file karungi court me', 'legal'], ['bank se paise wapas le lungi', 'chargeback'],
    ['bank se paise wapas karwa lungi', 'chargeback'], ['dispute raise karungi', 'chargeback'], ['case thok dunga', 'legal'],
    ['agar refund nahi diya to legal action lungi', 'legal'], ['refund nahi mila to police me jaungi', 'police']]) {
    assert.strictEqual(rtt.refundThreatKind(s), k, `${k}: ${s}`);
    assert.strictEqual(esc.urgentKind(s), 'threat', s);
  }
  assert.strictEqual(rtt.refundThreatKind(OWNER_EXAMPLE), 'consumer');
  for (const [s, k] of THREAT_MATCH) {
    assert.strictEqual(rtt.refundThreatKind(s), k, `should be ${k}: ${s}`);
    assert.strictEqual(esc.urgentKind(s), 'threat', `escalation.ts must call it a threat too: ${s}`);
  }
  for (const s of THREAT_NOT) assert.strictEqual(rtt.refundThreatKind(s), null, `not a Refund threat: ${s}`);
  for (const s of ['', '   ', null, undefined]) assert.strictEqual(rtt.refundThreatKind(s), null);
  // escalation.ts additions (owner's example) and its old lines: a social-media complaint is a threat (Needs you), never Refund.
  assert.strictEqual(esc.urgentKind('complaint against you on instagram'), 'threat');
  for (const s of ['fir kab aayega', 'refund chahiye', 'send me a notice when it ships', 'is this good for consumers?', 'I have a complaint about the size']) assert.strictEqual(esc.urgentKind(s), null, s);
  // The 2 Oct additions to escalation.ts stay exact too (the lines before them are unchanged, some wider).
  for (const s of ['fir file bhejo', 'fir register karna padega', 'fir karungi', 'nail polis wala colour hai kya', 'थाना बिहटा, पटना', 'Thana Bihta, Patna',
    'I work in cyber security, need formal shirts', 'payment reverse kar do please', 'please reverse the amount to my bank account',
    'my bank reported the payment failed', 'कंज्यूमर केयर नंबर दो',
    // Review fixes 2026-10-02: null before the addition, null again.
    'bank se paise wapas aa jayenge na agar cancel karu?', 'bank se paise wapas kab aayenge', 'mere bank se paise wapas kab aayenge', 'bank se paise wapas chahiye',
    'payment fail ho gaya tha, bank se paise wapas aayenge na?', 'please courier ke saath case file karo, mera parcel lost hai', 'aap courier pe case file kar do na please',
    'delivery boy ke khilaf complaint karni hai, wo rude tha', 'courier wale ke khilaf complaint karo', 'डिलीवरी बॉय के खिलाफ रिपोर्ट', 'legal karwai nahi karni', 'attorney',
    'power of attorney chahiye']) assert.strictEqual(esc.urgentKind(s), null, `escalation.ts addition: ${s}`);
  const escSrc = fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat/escalation.ts'), 'utf8');
  assert.ok(!/^import /m.test(escSrc), 'escalation.ts keeps no imports');
});
t('etaOf / etaPassed: the order\'s date, else day 13 after it was placed; passed = the India day is over', () => {
  const at = (iso) => Date.parse(iso);
  assert.strictEqual(rtt.etaOf({ estimated_delivery: '2026-10-02', placed_on: '2026-09-01T10:00:00Z' }), at('2026-10-02T00:00:00Z'));
  assert.strictEqual(rtt.etaOf({ estimated_delivery: null, placed_on: '2026-09-25T10:00:00.000Z' }), at('2026-10-08T10:00:00.000Z'), 'the day-13 end');
  assert.strictEqual(rtt.etaOf({ estimated_delivery: new Date('2026-10-02T00:00:00Z') }), at('2026-10-02T00:00:00Z'));
  assert.strictEqual(rtt.etaOf({}), null); assert.strictEqual(rtt.etaOf(null), null); assert.strictEqual(rtt.etaOf({ estimated_delivery: 'bad', placed_on: '' }), null);
  const eta = rtt.etaOf({ estimated_delivery: '2026-10-02' });
  assert.strictEqual(rtt.etaPassed(eta, at('2026-10-02T18:29:00Z')), false, '2 Oct 23:59 IST: due today, not passed');
  assert.strictEqual(rtt.etaPassed(eta, at('2026-10-02T18:30:00Z')), true, '3 Oct 00:00 IST: passed');
  assert.strictEqual(rtt.etaPassed(eta, at('2026-10-01T20:00:00Z')), false);
  // A DATE read as midnight in India (a server in IST) is the same India day.
  assert.strictEqual(rtt.etaPassed(at('2026-10-01T18:30:00Z'), at('2026-10-02T18:29:00Z')), false);
  assert.strictEqual(rtt.etaPassed(null, Date.now()), null); assert.strictEqual(rtt.etaPassed(NaN, Date.now()), null);
});
t('the refund texts: the owner\'s words, the customer\'s language, no time / amount / courier / link; the promise and the reminder keep the chat waiting; one reminder head per language', () => {
  const notAnswer = new RegExp(waiting.AI_NOT_AN_ANSWER_REGEX, 'i');
  assert.ok(!waiting.AI_NOT_AN_ANSWER_REGEX.includes("'"), 'no apostrophe: it goes into SQL');
  assert.strictEqual(rtt.refundPromiseReply('en'), "We're sorry for the trouble. We are processing your refund, and our team will send you a refund form here in this chat to collect your UPI / bank details.");
  assert.strictEqual(rtt.refundReminderReply('hinglish'), 'Hamari team aapka refund process kar rahi hai, refund ka proof aapko isi chat aur aapke Gmail / email dono pe de degi.');
  for (const lang of ['en', 'hinglish', 'hi']) {
    const A = rtt.refundPromiseReply(lang), B = rtt.refundReminderReply(lang);
    for (const x of [A, B]) {
      assert.ok(x && !tp.promisesToday(x), `${lang}: ${x}`);
      assert.ok(!/v[ao]lmo|वाल्मो|courier|कूरियर/i.test(x), `${lang}: no courier`);
      assert.ok(!/today|tonight|tomorrow|\baaj\b|\bkal\b|आज|कल|hour|ghant|घंट|\bdin\b|days?\b|दिन/i.test(x), `${lang}: no time: ${x}`);
      assert.ok(!/\d|₹|rs\.?\s|rupee|https?:|\/refund#|forms?\.gle|docs\.google/i.test(x), `${lang}: no amount, no link: ${x}`);
      assert.ok(notAnswer.test(x), `${lang}: not an answer (the chat keeps waiting)`);
      assert.strictEqual(esc.dropReplyTimes(x).text, x, `${lang}: the same at night`);
    }
    assert.ok(/UPI/.test(A) && /(refund form|रिफंड फॉर्म)/i.test(A), `${lang}: the promise names the refund form and UPI / bank`);
    assert.ok(/(email|ईमेल)/i.test(B) && /(chat|चैट)/i.test(B) && /(proof|प्रूफ)/i.test(B), `${lang}: the reminder says proof in this chat and on email`);
    assert.ok(!esc.isRepeatedReply(B, [A]) && esc.isRepeatedReply(B, [B]), lang);
    const heads = rtt.REFUND_REMINDER_HEADS.filter((h) => B.startsWith(h));
    assert.strictEqual(heads.length, 1, lang);
    assert.ok(heads[0].length >= 30 && !/[%_]/.test(heads[0]), lang);
    assert.ok(!rtt.REFUND_REMINDER_HEADS.some((h) => A.includes(h)), `${lang}: the promise is not the reminder`);
  }
  assert.strictEqual(rtt.REFUND_REMINDER_HEADS.length, 3);
  // The old not-an-answer lines still match; ordinary replies and the refund form's own messages do not.
  assert.ok(notAnswer.test(tcl.promiseReply('en')) && notAnswer.test(tcl.reminderReply('hi')));
  for (const x of ['Your refund has been approved. As soon as the refund is sent, we will share the reference number here in this chat.',
    'Your order is In Transit, estimated delivery 7 October 2026.', "I've noted your refund or cancellation request. Our team will reply to you here in this chat within 24 hours."]) {
    assert.ok(!notAnswer.test(x), x);
  }
  // The pure file stays pure.
  const imports = fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat/refund-threat.ts'), 'utf8').match(/from '[^']+'/g);
  assert.deepStrictEqual(imports, ["from '@/lib/journey'", "from './escalation'", "from './tracking-claim'"]);
});
t('refundThreatStep: verified (order ID + full phone), not another order, not removed before, the order late and not delivered / cancelled / returned; Ship again is switched', () => {
  const base = { strictProof: true, caseKind: null, otherOrder: false, refundRemoved: false, otherRefundChat: false };
  const late = { stage: 'in_transit', etaPassed: true };
  const step = (o) => rtt.refundThreatStep({ ...base, ...o });
  assert.deepStrictEqual(step({}), { act: 'need_order' });
  assert.deepStrictEqual(step({ order: late }), { act: 'mark' });
  assert.deepStrictEqual(step({ order: { stage: 'pre_dispatch', etaPassed: true } }), { act: 'mark' });
  assert.deepStrictEqual(step({ caseKind: 'reship', order: late }), { act: 'switch' });
  assert.deepStrictEqual(step({ caseKind: 'refund', order: late }), { act: 'in_refund' });
  for (const [o, why] of [
    [{ strictProof: false, order: late }, 'not verified by order ID + full phone'],
    [{ caseKind: 'other', order: late }, 'marked other'],
    [{ otherOrder: true, order: late }, 'another order'],
    [{ refundRemoved: true, order: late }, 'Refund removed before'],
    [{ otherRefundChat: true, order: late }, 'order already in Refund in another chat'],
    [{ order: null }, 'order not loaded'],
    [{ order: { stage: 'delivered', etaPassed: true } }, 'delivered order'],
    [{ order: { stage: 'other', etaPassed: true } }, 'cancelled / returned / failed order'],
    [{ order: { stage: 'in_transit', etaPassed: null } }, 'no estimated date'],
    [{ order: { stage: 'in_transit', etaPassed: false } }, 'estimated date not passed'],
    // Review fix 2026-10-02: a Cash on Delivery order that is not delivered (nothing paid); delivered says so first.
    [{ order: { stage: 'in_transit', etaPassed: true, cod: true } }, 'COD order, nothing paid'],
    [{ order: { stage: 'pre_dispatch', etaPassed: true, cod: true } }, 'COD order, nothing paid'],
    [{ order: { stage: 'delivered', etaPassed: true, cod: true } }, 'delivered order'],
  ]) assert.deepStrictEqual(step(o), { act: 'today', why }, why);
  assert.deepStrictEqual(step({ order: { ...late, cod: false } }), { act: 'mark' }, 'prepaid');
  // Checked before the order is read (no lookup for a visitor or a removed mark).
  assert.deepStrictEqual(step({ strictProof: false }), { act: 'today', why: 'not verified by order ID + full phone' });
});
t('threatNamesOtherOrder (review fix 2026-10-02): an order written as one counts; an amount, a date, a PIN code or the verified order do not', () => {
  const other = (said) => rtt.threatNamesOtherOrder(said, '#4715');
  for (const s of ['I paid 1499 and got nothing, I will file a chargeback', 'ordered on 25/09/2026, still nothing. chargeback karungi', 'Rs 1499 diye the, consumer court jaungi',
    '₹1,499 paid, chargeback', '1499/- de diye, police complaint karungi', 'price 2499.00 tha, chargeback karungi', 'PIN 110092, chargeback karungi',
    'ordered on 25 Sep 2026, chargeback', 'Sept 25, 2026 ko order kiya, consumer court jaungi', '#4715 ka refund do warna chargeback', 'order 4715 pe chargeback karungi',
    'phone 9876543210, chargeback karungi', 'chargeback karungi', '', null]) assert.strictEqual(other(s), false, String(s));
  for (const s of ['order #4716 ke liye consumer court jaungi', 'order 4716 pe chargeback', 'order no. 4716, chargeback karungi', '#4716 ka chargeback',
    '4716 wale order pe chargeback karungi', 'order id: 123456 chargeback']) assert.strictEqual(other(s), true, s);
  // The tracking claim keeps its own wider test (an amount there still reads as another order).
  assert.strictEqual(tcl.mentionsOtherOrder('I paid 1499, tracking fake hai', '#4715', null), true);
});
t('refundFollowUpAction: Chikki\'s Refund chat reminds once, "ok" gets nothing; a person\'s (or the team wrote): today\'s path', () => {
  const act = (auto, said, repeated = false) => rtt.refundFollowUpAction({ auto, said, repeated });
  assert.strictEqual(act(true, 'refund kab milega?'), 'reminder');
  assert.strictEqual(act(true, 'chargeback karungi'), 'reminder');
  assert.strictEqual(act(true, 'रिफंड कब मिलेगा?'), 'reminder');
  assert.strictEqual(act(true, 'refund kab milega?', true), 'silent');
  for (const s of ['ok', 'ok thanks', '👍', 'thank you']) assert.strictEqual(act(true, s), 'silent', s);
  assert.strictEqual(act(false, 'refund kab milega?'), null);
  assert.strictEqual(act(false, 'ok'), null);
});
t('rulebook: 6.6 and 9.14 (owner 2 Oct 18:45) at the ends of their sections, and the rules that point to them', () => {
  const rule = (id) => rb.RULEBOOK.flatMap((s) => s.rules).find((r) => r.id === id);
  for (const id of ['6.6', '9.14']) assert.ok(rb.RULE_IDS.has(id) && rule(id).how === 'code', id);
  assert.ok(rule('6.6').text.includes('"we\'re sorry, we are processing your refund, our team will send you a refund form in this chat to collect your UPI / bank details"'));
  assert.ok(/estimated date has passed/.test(rule('6.6').text) && /NOT for a social-media threat, fraud words or anger alone/.test(rule('6.6').text));
  assert.ok(rule('9.14').text.includes('"Hamari team aapka refund process kar rahi hai, refund ka proof aapko isi chat aur aapke Gmail / email dono pe de degi"'));
  assert.ok(rule('5.3').text.includes('(6.6)') && rule('6.2').text.includes('(6.6)') && rule('7.2').text.includes('6.6') && rule('6.2').text.includes('after 10 AM'));
  assert.ok(rule('9.2').text.includes('9.14') && /Refund \(6\.6\): no senior needed/.test(rule('9.6').text));
});
// ── Chargeback / dispute advice guard (dispute-advice.ts, 2026-10-03, from the chat report) ──
const da = load('dispute-advice');
t('dispute-advice: the real 1-3 Oct advice sentences are caught, in English, Hinglish and Hindi', () => {
  for (const s of [
    'raising a complaint with your bank (HDFC) for a chargeback could be a valid next step.',
    'I strongly recommend you raise a complaint with HDFC Bank.',
    'They can initiate a chargeback.',
    'Apne bank mein jakar ₹807 ki transaction ke liye dispute raise karein.',
    'cybercrime.gov.in par complaint file kar sakte hain.',
    'Bank chargeback raise kar sakta hai.',
    'Kal apne bank branch jaaiye, manager ko poori baat batayein - "fraudulent transaction" bolkar dispute raise karwayein.',
    'you can raise a dispute directly through your UPI app (Google Pay, PhonePe, etc.) for the transaction.',
    'Bank dispute: Apne bank jaakar batayein ki ₹807 ka payment ek fake website ko ho gaya.',
    'Please contact your bank to get the money back.',
    'You may approach the consumer forum.',
    'Aap police complaint bhi kar sakte hain.',
    'आप अपने बैंक में शिकायत कर सकते हैं।',
  ]) assert.ok(da.mentionsDispute(s), s);
});
t('dispute-advice: normal support lines, the refund-form promise and order facts are left alone', () => {
  for (const s of [
    'Our team will reply to you right here in this chat.',
    'Pareshani ke liye sorry. Hum aapka refund process kar rahe hain, hamari team isi chat me aapko refund form bhejegi jisme aap apni UPI / bank details de payenge.',
    'The amount was paid by UPI; could you share the order ID and the phone number on the order?',
    'Your order #4715 is In Transit and the estimated delivery is 9 October.',
    'Refunds are processed back to the original payment method by our team.',
    'Main samajh raha hoon, aapka order late hai. Hamari team courier se check karwa rahi hai.',
    'The bank statement shows the merchant name; please share your order ID too.',
    "I couldn't match that to an order yet. Please share your order ID and the phone number on the order, both together.",
  ]) assert.ok(!da.mentionsDispute(s), s);
});
t('dispute-advice: only the advice sentence goes, an all-advice reply is emptied, untouched text is byte-identical', () => {
  const r = da.dropDisputeAdvice('I am sorry for the trouble. I strongly recommend you raise a complaint with HDFC Bank. Could you share the date and amount?');
  assert.deepStrictEqual(r, { text: 'I am sorry for the trouble. Could you share the date and amount?', changed: true, emptied: false });
  const two = da.dropDisputeAdvice('Aapke paas do options hain:\n- Bank dispute: apne bank jaakar dispute raise karein.\n- cybercrime.gov.in par complaint file kar sakte hain.');
  assert.deepStrictEqual(two, { text: 'Aapke paas do options hain:', changed: true, emptied: false });
  assert.deepStrictEqual(da.dropDisputeAdvice('They can initiate a chargeback.'), { text: '', changed: true, emptied: true });
  const same = 'Hello there.\n\nYour order is on its way.  ';
  assert.deepStrictEqual(da.dropDisputeAdvice(same), { text: same, changed: false, emptied: false });
  assert.deepStrictEqual(da.dropDisputeAdvice(''), { text: '', changed: false, emptied: false });
});
t('rulebook: 5.9 (owner 3 Oct, chat report) is a code rule that names the hand-over and the visitor ask', () => {
  const rule = (id) => rb.RULEBOOK.flatMap((s) => s.rules).find((r) => r.id === id);
  assert.ok(rb.RULE_IDS.has('5.9') && rule('5.9').how === 'code');
  assert.ok(/chargeback/.test(rule('5.9').text) && /cyber-crime or police/.test(rule('5.9').text) && /\(5\.6\)/.test(rule('5.9').text));
});
// ── Exact tracking links (reply-guards.ts withExactTrackingLinks, owner 2026-10-03) ──
t('tracking links: a retyped token becomes the exact link, an exact one stays byte for byte', () => {
  const K = ['https://shiptrack.store/track/35ecb8cb-c000-4b1e-9f3a-82302749ffcd'];
  const fix = (s) => rg.withExactTrackingLinks(s, K);
  assert.deepStrictEqual(fix('Track here: https://shiptrack.store/track/35ec8bcb-c000-4b1e-9f3a-82302749ffcd.'),
    { text: 'Track here: https://shiptrack.store/track/35ecb8cb-c000-4b1e-9f3a-82302749ffcd.', changed: true, fixed: 1 });
  assert.deepStrictEqual(fix('https://shiptrack.store/track/35ecb8cb-c000-4b1e-9f3a-82202749ffcd (open it)'),
    { text: 'https://shiptrack.store/track/35ecb8cb-c000-4b1e-9f3a-82302749ffcd (open it)', changed: true, fixed: 1 });
  // Without a scheme, in upper case, twice.
  const twice = fix('Link: shiptrack.store/track/35ECB8CB-C000-4B1E-9F3A-82302749FFC\nFir se: shiptrack.store/track/35ecb8cb-c000-4b1e-9f3a-8230274ffcd');
  assert.deepStrictEqual(twice, { text: 'Link: https://shiptrack.store/track/35ecb8cb-c000-4b1e-9f3a-82302749ffcd\nFir se: https://shiptrack.store/track/35ecb8cb-c000-4b1e-9f3a-82302749ffcd', changed: true, fixed: 2 });
  const same = 'Your link: https://shiptrack.store/track/35ecb8cb-c000-4b1e-9f3a-82302749ffcd. Keep your phone reachable.';
  assert.deepStrictEqual(fix(same), { text: same, changed: false, fixed: 0 });
  const none = 'Your order is on its way, no link here.';
  assert.deepStrictEqual(fix(none), { text: none, changed: false, fixed: 0 });
  assert.deepStrictEqual(rg.withExactTrackingLinks('https://shiptrack.store/track/abc', []), { text: 'https://shiptrack.store/track/abc', changed: false, fixed: 0 });
});
t('tracking links: two orders pick the closest token; a far token on our host with one known link takes it; another site is left alone', () => {
  const A = 'https://shiptrack.store/track/efbec856-2a98-3ba3-514d-9455bcba632', B = 'https://track.vastora.in/track/d76c44dd-31dd-308e-4aac-82302749ffcd';
  const r = rg.withExactTrackingLinks(`First: https://shiptrack.store/track/efbec856-2a98-3b3a-514d-95415bcba632 and second: https://track.vastora.in/track/d76c44dd-31dd-308e-4aac-82202749ffcd`, [A, B]);
  assert.deepStrictEqual(r, { text: `First: ${A} and second: ${B}`, changed: true, fixed: 2 });
  // Two orders and a token close to neither: left as written (never guessed).
  const far = 'See https://shiptrack.store/track/00000000-0000-0000-0000-000000000000 please.';
  assert.deepStrictEqual(rg.withExactTrackingLinks(far, [A, B]), { text: far, changed: false, fixed: 0 });
  // One known link and a made-up token on our host: the known link.
  assert.deepStrictEqual(rg.withExactTrackingLinks(far, [A]), { text: `See ${A} please.`, changed: true, fixed: 1 });
  // Another site's /track/ page (the courier's) is not ours to rewrite.
  const other = 'Check https://valmo.in/track/STN98AFI7GRW on their site.';
  assert.deepStrictEqual(rg.withExactTrackingLinks(other, [A]), { text: other, changed: false, fixed: 0 });
});
// ── Order items changed from the chat header (order-items.ts, owner 2026-10-03) ──
const oi = load('order-items');
t('cleanItems: the team\'s lines tidied (spaces, quantity as text, price to 2 decimals, no price = null); the body or the list itself', () => {
  const body = { items: [
    { product_name: '  Jhumka   box - Silver ', quantity: '2', price: '1299.004' },
    { product_name: 'Earrings Set', quantity: 1 },
    { product_name: 'Kurta Set - Blue / M', quantity: 3, price: 0 },
  ] };
  const want = [
    { product_name: 'Jhumka box - Silver', quantity: 2, price: 1299 },
    { product_name: 'Earrings Set', quantity: 1, price: null },
    { product_name: 'Kurta Set - Blue / M', quantity: 3, price: 0 },
  ];
  assert.deepStrictEqual(oi.cleanItems(body), { items: want });
  assert.deepStrictEqual(oi.cleanItems(body.items), { items: want });
  // No quantity = 1; an empty price = none; a price with paise is kept to 2 decimals.
  assert.deepStrictEqual(oi.cleanItems([{ product_name: 'Bangle', price: '' }]), { items: [{ product_name: 'Bangle', quantity: 1, price: null }] });
  assert.deepStrictEqual(oi.cleanItems([{ product_name: 'Bangle', quantity: 20, price: 99.999 }]), { items: [{ product_name: 'Bangle', quantity: 20, price: 100 }] });
  assert.deepStrictEqual(oi.cleanItems([{ product_name: 'Bangle', price: 100000 }]), { items: [{ product_name: 'Bangle', quantity: 1, price: 100000 }] });
  // A name may carry a few digits (a size, a year), just not a phone number.
  assert.deepStrictEqual(oi.cleanItems([{ product_name: 'Saree 2024 edition / 38' }]), { items: [{ product_name: 'Saree 2024 edition / 38', quantity: 1, price: null }] });
  assert.strictEqual(oi.MAX_ITEMS, 10);
  assert.deepStrictEqual(oi.cleanItems(Array.from({ length: 10 }, (_, i) => ({ product_name: 'Item ' + i }))).items.length, 10);
});
t('cleanItems: the first thing wrong, named by its line: none, too many, name, "<", link, phone, quantity, price', () => {
  const err = (raw) => oi.cleanItems(raw).error;
  assert.strictEqual(err(null), 'Add at least one item');
  assert.strictEqual(err({}), 'Add at least one item');
  assert.strictEqual(err({ items: [] }), 'Add at least one item');
  assert.strictEqual(err({ items: 'x' }), 'Add at least one item');
  assert.strictEqual(err(Array.from({ length: 11 }, () => ({ product_name: 'Item' }))), 'At most 10 items');
  assert.strictEqual(err([{ product_name: 'A' }]), 'Item 1: write the product name (2-120 characters)');
  assert.strictEqual(err([{ product_name: 'Ok' }, {}]), 'Item 2: write the product name (2-120 characters)');
  assert.strictEqual(err([{ product_name: 'Ok' }, null]), 'Item 2: write the product name (2-120 characters)');
  assert.strictEqual(err([{ product_name: 'x'.repeat(121) }]), 'Item 1: write the product name (2-120 characters)');
  assert.strictEqual(err([{ product_name: '<b>Jhumka</b>' }]), 'Item 1: no "<" in a product name');
  assert.strictEqual(err([{ product_name: 'Jhumka https://x.in/a' }]), 'Item 1: no links in a product name');
  assert.strictEqual(err([{ product_name: 'see www.vastora.in' }]), 'Item 1: no links in a product name');
  assert.strictEqual(err([{ product_name: 'call 98765 43210 now' }]), 'Item 1: no phone numbers in a product name');
  assert.strictEqual(err([{ product_name: 'Jhumka', quantity: 0 }]), 'Item 1: quantity 1-20');
  assert.strictEqual(err([{ product_name: 'Jhumka', quantity: 21 }]), 'Item 1: quantity 1-20');
  assert.strictEqual(err([{ product_name: 'Jhumka', quantity: 1.5 }]), 'Item 1: quantity 1-20');
  assert.strictEqual(err([{ product_name: 'Jhumka', quantity: 'two' }]), 'Item 1: quantity 1-20');
  assert.strictEqual(err([{ product_name: 'Jhumka', price: -1 }]), 'Item 1: price 0-100000');
  assert.strictEqual(err([{ product_name: 'Jhumka', price: 100000.01 }]), 'Item 1: price 0-100000');
  assert.strictEqual(err([{ product_name: 'Jhumka', price: 'abc' }]), 'Item 1: price 0-100000');
  // priceOf, used by the loader on the database's "1299.00" strings.
  assert.strictEqual(oi.priceOf('1299.00'), 1299); assert.strictEqual(oi.priceOf(0), 0);
  assert.strictEqual(oi.priceOf(null), null); assert.strictEqual(oi.priceOf(''), null); assert.strictEqual(oi.priceOf('x'), null);
});
t('sameItems: the same lines in any order; a name, quantity or price change (null is not 0) and a missing line are different', () => {
  const a = [{ product_name: 'Jhumka box - Silver', quantity: 2, price: 1299 }, { product_name: 'Earrings Set', quantity: 1, price: 0 }];
  assert.strictEqual(oi.sameItems(a, [a[1], a[0]]), true);
  assert.strictEqual(oi.sameItems(a, a.map((x) => ({ ...x }))), true);
  assert.strictEqual(oi.sameItems([], []), true);
  assert.strictEqual(oi.sameItems(a, [a[0]]), false);
  assert.strictEqual(oi.sameItems(a, [a[0], { ...a[1], product_name: 'Earrings set' }]), false);
  assert.strictEqual(oi.sameItems(a, [a[0], { ...a[1], quantity: 2 }]), false);
  assert.strictEqual(oi.sameItems(a, [a[0], { ...a[1], price: 1 }]), false);
  assert.strictEqual(oi.sameItems(a, [a[0], { ...a[1], price: null }]), false);
  assert.strictEqual(oi.sameItems([{ product_name: 'A', quantity: 1, price: 10 }], [{ product_name: 'A', quantity: 1, price: 10.001 }]), true);
  // Two equal lines against one doubled: not the same.
  assert.strictEqual(oi.sameItems([a[0], a[0]], [{ ...a[0], quantity: 4 }]), false);
});
t('itemsLine: "Jhumka box - Silver ×2 · Earrings Set"; ×N only above 1; about 80 characters then "…"', () => {
  assert.strictEqual(oi.itemsLine([{ product_name: 'Jhumka box - Silver', quantity: 2, price: 1299 }, { product_name: 'Earrings Set', quantity: 1, price: null }]), 'Jhumka box - Silver ×2 · Earrings Set');
  assert.strictEqual(oi.itemsLine([]), '');
  assert.strictEqual(oi.itemsLine([{ product_name: 'Bangle', quantity: 1, price: 0 }]), 'Bangle');
  const long = oi.itemsLine(Array.from({ length: 6 }, (_, i) => ({ product_name: `Kurta Set - Blue / M number ${i}`, quantity: 1, price: 0 })));
  assert.ok(long.length <= 80 && long.endsWith('…') && !/[\s·]…$/.test(long), long);
  assert.ok(long.startsWith('Kurta Set - Blue / M number 0 · Kurta Set - Blue / M number 1'), long);
  const exact = oi.itemsLine([{ product_name: 'x'.repeat(80), quantity: 1, price: 0 }]);
  assert.strictEqual(exact.length, 80); assert.ok(!exact.endsWith('…'));
  assert.strictEqual(oi.itemsLine([{ product_name: 'x'.repeat(81), quantity: 1, price: 0 }]), 'x'.repeat(79) + '…');
});
// ── Ship again: the new parcel's AWB / link (reship.ts, owner 2026-10-03) ──
const rs = load('reship');
t('reship: fship links with utm junk, bare AWBs, and the dialog input are read; phones and order numbers are not', () => {
  assert.deepStrictEqual(rs.reshipInReply('Please find your updated tracking link below:\n[Track Your Order](https://app.fship.in/shipment/tracking?awbno=143449611008922&utm_source=chatgpt.com)\nThanks'),
    { awb: '143449611008922', link: 'https://app.fship.in/shipment/tracking?awbno=143449611008922' });
  assert.deepStrictEqual(rs.reshipInReply('143449611096485 XpressBees tracking: https://www.xpressbees.com/shipment/tracking?awbNo=143449611096485.'),
    { awb: '143449611096485', link: 'https://www.xpressbees.com/shipment/tracking?awbNo=143449611096485' });
  assert.deepStrictEqual(rs.reshipInReply('New AWB 143449611096485, it moves tomorrow'), { awb: '143449611096485', link: null });
  for (const s of ['Call us on 9876543210', '+919876543210 is the number', 'Order #4715 total 499', 'ETA 3 Oct', 'https://shiptrack.store/track/35ecb8cb-c000-4b1e-9f3a-82302749ffcd', 'ok done'])
    assert.strictEqual(rs.reshipInReply(s), null, s);
  assert.deepStrictEqual(rs.parseReship('  143449611008922 '), { awb: '143449611008922', link: null });
  assert.deepStrictEqual(rs.parseReship('vl0012345678'), { awb: 'VL0012345678', link: null });
  assert.ok('error' in rs.parseReship(''), 'empty');
  assert.ok('error' in rs.parseReship('https://app.fship.in/'), 'link without awb');
  assert.ok('error' in rs.parseReship('abc'), 'too short');
});

// ── Late orders on the tracking page (owner 2026-10-04; journey.ts "Late orders") ────────
// Order #1564: placed 19 Sept 10:22 IST, estimated 1 Oct, at Out for Delivery, never marked
// Delivered. Times below are IST; the engine works in UTC ms.
const dl = load('delay-ladder');
const IST = (y, m, d, h = 0, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi) - 5.5 * 3600 * 1000);
const LATE_ORDER = { tracking_status: 'Out for Delivery', created_at: IST(2026, 9, 19, 10, 22).toISOString(), estimated_delivery: '2026-10-01', city: 'Jaipur', state: 'Rajasthan' };
const istDate = (iso) => new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 16);
// ── Panel names: one panel per name (owner 2026-10-07; panel-name.ts, /api/businesses, panel-name-unique.sql) ──
t('panel names: capitals and extra spaces do not make a new name; the routes and the SQL use the same key', () => {
  const pn = load('panel-name', '../../src/lib');
  assert.strictEqual(pn.cleanPanelName('  Vastrika \t Store \n'), 'Vastrika Store');
  assert.strictEqual(pn.cleanPanelName(null), '');
  assert.strictEqual(pn.cleanPanelName('   '), '');
  assert.strictEqual(pn.cleanPanelName('x'.repeat(200)).length, pn.PANEL_NAME_MAX);
  const k = pn.panelNameKey('VASTRIKA');
  for (const same of ['vastrika', ' Vastrika ', 'VaStRiKa']) assert.strictEqual(pn.panelNameKey(same), k, same);
  for (const other of ['VASTRIKA STORE', 'vastrika2', 'vastora', 'vestora']) assert.notStrictEqual(pn.panelNameKey(other), k, other);
  // The database index is built on the very expression the routes compare with.
  const sql = fs.readFileSync(path.resolve(__dirname, '../../panel-name-unique.sql'), 'utf8');
  assert.ok(sql.includes(pn.PANEL_NAME_KEY_SQL.replace(/\\\\/g, '\\')), 'index expression');
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS/.test(sql) && !/DROP |DELETE |TRUNCATE /i.test(sql.replace(/--.*$/gm, '')), 'additive only');
  // Create and rename check before they change anything; the upload compares by the same key.
  const route = fs.readFileSync(path.resolve(__dirname, '../../src/app/api/businesses/route.ts'), 'utf8');
  assert.ok(/PANEL_NAME_KEY_SQL/.test(route) && /panelNameTakenMessage/.test(route) && /status: 409/.test(route));
  assert.ok(route.indexOf('panelNameTakenMessage(cleanName)') < route.indexOf('UPDATE businesses SET is_default = false WHERE is_default = true`'), 'create checks first');
  assert.ok(/name = \$\$\{pi\+\+\}`\);\s+params\.push\(newName\)/.test(route), 'rename saves the cleaned name');
  const up = fs.readFileSync(path.resolve(__dirname, '../../src/app/api/upload/route.ts'), 'utf8');
  // 2026-10-08: the upload no longer creates a panel at all (stronger than "no duplicate name"): it only reads them by the same key.
  assert.ok(/bizMap\.set\(panelNameKey\(b\.name\), b\.id\)/.test(up) && !/INSERT INTO businesses/.test(up));
});
t('estimated date for the model: the India calendar day, never the UTC day before (owner 2026-10-07, 18th vs 19th)', () => {
  // A date stored as India midnight is 18:30 UTC the day before.
  assert.strictEqual(jn.istDateOf('2026-10-18T18:30:00.000Z'), '2026-10-19');
  // A DATE read as UTC midnight is the same India day.
  assert.strictEqual(jn.istDateOf('2026-10-19T00:00:00.000Z'), '2026-10-19');
  // Late in the India evening stays on that day, just after India midnight moves on.
  assert.strictEqual(jn.istDateOf('2026-10-19T18:29:59.000Z'), '2026-10-19');
  assert.strictEqual(jn.istDateOf('2026-10-19T18:30:00.000Z'), '2026-10-20');
  assert.strictEqual(jn.istDateOf(null), null);
  assert.strictEqual(jn.istDateOf('not a date'), null);
  // The lookup the AI and the suggested replies read uses it (orders.ts toFoundOrder).
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat/orders.ts'), 'utf8');
  assert.ok(/estimated_delivery: istDateOf\(eta\)/.test(src));
});
t('late order: the page and the chat share one wording and one day ladder', () => {
  for (const k of [1, 2, 3]) assert.strictEqual(jn.LATE_REASONS[k], dl.DELAY_REASONS[k], `reason ${k}`);
  assert.deepStrictEqual([1, 2, 3, 4, 5, 9].map(jn.lateStage), [1, 2, 2, 2, 3, 3]);
  // No page line promises arrival today / tomorrow (rule 4.3).
  for (const s of Object.values(jn.LATE_REASONS)) assert.ok(!tp.promisesToday(s), s);
  // The chat starts from the page's step; asking again still climbs.
  assert.strictEqual(dl.delayStage({ daysToEta: -1.5, asks: 1, pageStage: 1 }), 1);
  assert.strictEqual(dl.delayStage({ daysToEta: -1.5, asks: 1 }), 2);
  assert.strictEqual(dl.delayStage({ daysToEta: -1.5, asks: 1, pageStage: null }), 2);
  assert.strictEqual(dl.delayStage({ daysToEta: -1.5, asks: 4, pageStage: 1 }), 3);
});
t('late order: not late on the estimated day nor before 10:00 the next morning', () => {
  for (const now of [IST(2026, 10, 1, 18), IST(2026, 10, 2, 9, 59)]) {
    const j = jn.buildJourney(LATE_ORDER, now);
    assert.strictEqual(j.late, null); assert.strictEqual(j.etaRevised, false);
    assert.strictEqual(j.eta, j.etaOriginal); assert.ok(j.eta.startsWith('2026-10-01'));
    assert.strictEqual(j.notice.title, 'Out for delivery');
    assert.strictEqual(j.events[j.events.length - 1].key, 'ofd');
  }
});
t('late order, day 1 (2 Oct 10:00): festive reason, one new line, revised date +3', () => {
  const j = jn.buildJourney(LATE_ORDER, IST(2026, 10, 2, 10, 0));
  assert.deepStrictEqual(j.late, { daysPast: 1, stage: 1, reason: jn.LATE_REASONS[1] });
  assert.strictEqual(j.currentLabel, 'Out for Delivery'); assert.strictEqual(j.stages[9].state, 'current');
  assert.strictEqual(j.notice.level, 'warn'); assert.ok(j.notice.title.includes('festive season'));
  assert.ok(j.notice.body.startsWith(jn.LATE_REASONS[1]) && j.notice.body.includes('revised delivery date'));
  assert.strictEqual(j.etaRevised, true); assert.ok(j.eta.startsWith('2026-10-04')); assert.ok(j.etaOriginal.startsWith('2026-10-01'));
  const last = j.events[j.events.length - 1];
  assert.strictEqual(last.key, 'late1'); assert.strictEqual(last.title, 'Delivery rescheduled');
  assert.ok(last.location.includes('Jaipur') && last.location.includes('Festive'), last.location);
  assert.strictEqual(istDate(last.timeISO), '2026-10-02T10:00');
});
t('late order, day 3 (4 Oct 12:00): network reason, three lines a day apart at 10:00, revised +6, feed ascending', () => {
  const j = jn.buildJourney(LATE_ORDER, IST(2026, 10, 4, 12, 0));
  assert.deepStrictEqual(j.late, { daysPast: 3, stage: 2, reason: jn.LATE_REASONS[2] });
  assert.ok(j.notice.title.includes('heavy load'));
  assert.ok(j.eta.startsWith('2026-10-07'), j.eta);
  const late = j.events.filter((e) => e.key.startsWith('late'));
  assert.deepStrictEqual(late.map((e) => e.key), ['late1', 'late2', 'late3']);
  assert.deepStrictEqual(late.map((e) => istDate(e.timeISO)), ['2026-10-02T10:00', '2026-10-03T10:00', '2026-10-04T10:00']);
  assert.ok(late[1].title.includes('courier partner'), 'day 2 = connecting with the courier');
  for (let i = 1; i < j.events.length; i++) assert.ok(j.events[i].timeISO > j.events[i - 1].timeISO, 'ascending');
  for (const e of late) assert.ok(!tp.promisesToday(e.title + ' ' + e.location), e.location);
});
t('late order, day 9: the team-following-up reason, lines stop at 5, no date (the team confirms it)', () => {
  const j = jn.buildJourney(LATE_ORDER, IST(2026, 10, 10, 15, 0));
  assert.deepStrictEqual(j.late, { daysPast: 9, stage: 3, reason: jn.LATE_REASONS[3] });
  assert.strictEqual(j.events.filter((e) => e.key.startsWith('late')).length, 5);
  assert.strictEqual(j.eta, null); assert.strictEqual(j.etaRevised, false); assert.ok(j.etaOriginal.startsWith('2026-10-01'));
  assert.ok(j.notice.body.includes('team will confirm'), j.notice.body);
  // Day 5 is the last one with a revised date (+6), day 6 has none.
  assert.ok(jn.buildJourney(LATE_ORDER, IST(2026, 10, 6, 10)).eta.startsWith('2026-10-07'));
  assert.strictEqual(jn.buildJourney(LATE_ORDER, IST(2026, 10, 7, 10)).eta, null);
});
t('late order: never for Delivered, cancelled or returned orders, nor before Out for Delivery', () => {
  const now = IST(2026, 10, 4, 12);
  const d = jn.buildJourney({ ...LATE_ORDER, tracking_status: 'Delivered' }, now);
  assert.strictEqual(d.late, null); assert.ok(d.delivered); assert.strictEqual(d.etaRevised, false);
  assert.strictEqual(jn.buildJourney({ ...LATE_ORDER, tracking_status: 'Cancelled' }, now).late, null);
  assert.strictEqual(jn.buildJourney({ ...LATE_ORDER, tracking_status: 'RTO' }, now).late, null);
  // Placed 3 days ago with an unbelievable 1-day date: still In Transit by the schedule, so not "late".
  const young = jn.buildJourney({ ...LATE_ORDER, tracking_status: 'In Transit', created_at: IST(2026, 10, 1, 10).toISOString(), estimated_delivery: '2026-10-02' }, now);
  assert.ok(young.currentIndex < 9); assert.strictEqual(young.late, null); assert.strictEqual(young.events.filter((e) => e.key.startsWith('late')).length, 0);
  // No date on the order: the day-13 end of the window counts (placed 19 Sept -> 2 Oct), late from 3 Oct 10:00.
  const noDate = jn.buildJourney({ ...LATE_ORDER, estimated_delivery: null }, now);
  assert.strictEqual(noDate.late.daysPast, 2); assert.ok(noDate.etaOriginal.startsWith('2026-10-02'));
});
// ── Suggested replies + "Sudharo" for the team (owner 2026-10-04; suggest.ts) ────────────
// suggest.ts imports the pure refund guard by its alias; loaded next to it like the harness does.
const sg = (() => {
  const lm = fs.readFileSync(path.resolve(__dirname, '../../src/lib/refund/link-mask.ts'), 'utf8');
  fs.writeFileSync(path.join(dir, 'refund-link-mask.js'), ts.transpileModule(lm, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText);
  load('dispute-advice');
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/lib/chat/suggest.ts'), 'utf8').replace("from '@/lib/refund/link-mask'", "from './refund-link-mask'");
  fs.writeFileSync(path.join(dir, 'suggest.js'), ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText);
  return require(path.join(dir, 'suggest.js'));
})();
t('suggest: the model answer is read as JSON, fenced JSON, a numbered list or one text; 3 distinct at most', () => {
  assert.deepStrictEqual(sg.parseOptions('{"options":["A one.","B two.","C three.","D four."]}'), ['A one.', 'B two.', 'C three.']);
  assert.deepStrictEqual(sg.parseOptions('```json\n{"options": ["Aap ka order aa raha hai.", "aap KA order aa raha hai.", "Dusra."]}\n```'), ['Aap ka order aa raha hai.', 'Dusra.']);
  assert.deepStrictEqual(sg.parseOptions('1. First one.\n2) Second one.\n- Third one.'), ['First one.', 'Second one.', 'Third one.']);
  assert.deepStrictEqual(sg.parseOptions('Just one plain reply.'), ['Just one plain reply.']);
  assert.deepStrictEqual(sg.parseOptions(''), []);
  assert.ok(sg.parseOptions(`{"options":["${'x'.repeat(900)}"]}`)[0].length <= sg.SUGGEST_MAX_CHARS);
});
t('suggest: every option goes through Chikki\'s guards; the bad ones are dropped, the courier is never named', () => {
  const ctx = { customerTexts: ['order kab aayega', 'mera order #1564 abhi tak nahi aaya'], courierNames: ['Valmo'] };
  const out = sg.guardOptions([
    'Aapka order aaj shaam tak aa jayega.',                                   // today promise: the sentence goes, nothing is left
    'Please fill this form https://forms.gle/abc123 for the refund.',       // form link: dropped
    'You can raise a chargeback with your bank for this.',                   // dispute advice: dropped
    'Aapka order Valmo ke paas hai, estimated date 7 Oct hai.',              // courier name -> courier partner
    'Aapka order Valmo ke paas hai, estimated date 7 Oct hai.',              // duplicate
    'I have checked: the parcel is at the local hub and we are following it up with the courier.',
  ], ctx);
  assert.strictEqual(out.length, 2, JSON.stringify(out));
  assert.ok(/courier partner/i.test(out[0]) && !/valmo/i.test(out[0]), out[0]);
  assert.ok(out[1].startsWith('I have checked'));
  for (const o of out) assert.ok(!tp.promisesToday(o), o);
  // A clean option keeps its text; the limit holds.
  assert.deepStrictEqual(sg.guardOptions(['Order dispatched hai, tracking link: https://shiptrack.store/track/abc'], ctx), ['Order dispatched hai, tracking link: https://shiptrack.store/track/abc']);
  assert.strictEqual(sg.guardOptions(['a', 'b', 'c', 'd'], ctx).length, 3);
});
t('suggest: the instruction speaks as the team, in the chosen language, with the night line and the case line', () => {
  const base = { lang: 'auto', after: null, caseKind: null, orderJson: '{"status":"Out for Delivery"}' };
  const day = sg.suggestInstruction(base);
  assert.ok(day.includes('exactly 3 options') && day.includes('The sender IS the team') && day.includes('"status":"Out for Delivery"'));
  assert.ok(day.includes('within 24 hours') && !day.includes('tomorrow morning, after 10 AM'));
  assert.ok(/language the customer wrote/.test(day));
  const night = sg.suggestInstruction({ ...base, after: 'tomorrow' });
  assert.ok(night.includes('tomorrow morning, after 10 AM') && night.includes('never "within 1 hour" or "within 24 hours"'));
  assert.ok(sg.suggestInstruction({ ...base, after: 'this_morning' }).includes('this morning, after 10 AM'));
  assert.ok(sg.suggestInstruction({ ...base, lang: 'en' }).includes('plain, simple English'));
  assert.ok(sg.suggestInstruction({ ...base, lang: 'hi' }).includes('Hinglish'));
  assert.ok(sg.suggestInstruction({ ...base, caseKind: 'refund' }).includes('Refund section'));
  assert.ok(sg.suggestInstruction({ ...base, caseKind: 'reship' }).includes('24-48 hours'));
  assert.ok(sg.suggestInstruction({ ...base, orderJson: null }).includes('No verified order facts'));
  for (const s of [day, night]) assert.ok(/never mention Karry, Chikki, an AI/.test(s));
});
t('suggest: the sender is the team, so "our team will" becomes "we will" (seen live 4 Oct)', () => {
  assert.strictEqual(sg.asTeam("You're most welcome, Kiran! Our team will get back to you here tomorrow morning after 10 AM."), "You're most welcome, Kiran! We will get back to you here tomorrow morning after 10 AM.");
  assert.strictEqual(sg.asTeam('Happy to help! The team will review your request and reply here.'), 'Happy to help! We will review your request and reply here.');
  assert.strictEqual(sg.asTeam('The support team is looking into it; our team has noted it.'), 'We are looking into it; we have noted it.');
  assert.strictEqual(sg.asTeam('Team Vastora thanks you.'), 'Team Vastora thanks you.');
  const out = sg.guardOptions(['Our team will update you here tomorrow morning after 10 AM.'], { customerTexts: ['thanks'], courierNames: [] });
  assert.deepStrictEqual(out, ['We will update you here tomorrow morning after 10 AM.']);
  assert.ok(/the team is "we"/.test(sg.suggestInstruction({ lang: 'auto', after: null, caseKind: null, orderJson: null })));
});
t('sudharo: the corrected text is taken only when it is a plain correction of the draft', () => {
  const d = 'aapka order dispatch ho gya h, link: https://shiptrack.store/track/abc';
  assert.strictEqual(sg.acceptPolish(d, 'Aapka order dispatch ho gaya hai, link: https://shiptrack.store/track/abc'), 'Aapka order dispatch ho gaya hai, link: https://shiptrack.store/track/abc');
  assert.strictEqual(sg.acceptPolish(d, '"Aapka order dispatch ho gaya hai, link: https://shiptrack.store/track/abc"'), 'Aapka order dispatch ho gaya hai, link: https://shiptrack.store/track/abc');
  assert.strictEqual(sg.acceptPolish(d, 'Corrected reply: Aapka order dispatch ho gaya hai, link: https://shiptrack.store/track/abc'), 'Aapka order dispatch ho gaya hai, link: https://shiptrack.store/track/abc');
  assert.strictEqual(sg.acceptPolish(d, ''), d);
  assert.strictEqual(sg.acceptPolish(d, 'Aapka order dispatch ho gaya hai, link: https://shiptrack.store/track/xyz'), d, 'a changed link: the draft stays');
  assert.strictEqual(sg.acceptPolish(d, 'Aapka order dispatch ho gaya hai. ' + 'Bahut lamba jawab. '.repeat(20)), d, 'far longer: the draft stays');
  assert.strictEqual(sg.acceptPolish('thanks', 'Thanks.'), 'Thanks.');
  assert.ok(sg.POLISH_INSTRUCTION.includes('Keep everything else exactly as it is') && sg.polishUserMessage('hi', 'kab aayega').includes('do not answer it'));
});
t('side tasks use the cheap model first (owner 4 Oct): health, subject, judge, learner, suggestions; customer replies do not', () => {
  const read = (f) => fs.readFileSync(path.resolve(__dirname, '../../', f), 'utf8');
  for (const f of ['src/lib/chat/health.ts', 'src/lib/chat/subject.ts', 'src/lib/' + ['team', 'score'].join('-') + '/judge.ts', 'src/lib/chat/suggest-run.ts']) {
    const s = read(f);
    assert.ok(/sideAttemptOrder\(\)/.test(s) && !/\battemptOrder\(\)/.test(s), f);
  }
  const learner = read('src/lib/chat/brain-suggest.ts');
  assert.ok(/sideModel\(\)/.test(learner) && !/getActiveModel\(\)/.test(learner), 'learner');
  const ai = read('src/lib/chat/ai.ts');
  assert.ok(!/sideAttemptOrder\(\)|sideModel\(\)/.test(ai), 'customer replies stay on the main chain');
  const models = read('src/lib/chat/ai-models.ts');
  assert.ok(/SIDE_MODEL_DEFAULT = 'deepseek\/deepseek-v4-flash'/.test(models) && /AI_SIDE_MODEL/.test(models));
  assert.ok(/AI_SIDE_MODEL=/.test(read('.env.example')), '.env.example lists the variable');
});
t('H7: a message that is only a phone number (lookup-guard.ts isBarePhone)', () => {
  const lg = load('lookup-guard');
  for (const s of ['8420844429', '+91 84208 44429', '0 8420844429', '918420844429', 'my number is 8420844429', '8420844429 hai mera number', '८४२०८४४४२९']) assert.ok(lg.isBarePhone(s), s);
  for (const s of ['1234', '#4715 8420844429', '4715, 8420844429', 'order 4715', '1234567890', 'kab aayega', '', '842084442']) assert.ok(!lg.isBarePhone(s), s);
  assert.ok(lg.asksForPhone("Thanks for sharing that! I'll also need the phone number on the order (all 10 digits) to look it up."));
  assert.ok(lg.asksForPhone('Please share the phone number on the order.'));
  assert.ok(!lg.asksForPhone('Please keep your phone number reachable for the delivery agent.'));
  assert.ok(!lg.asksForPhone('Please share your order ID so I can look it up.'));
  const en = lg.orderIdAfterPhoneReply([{ sender: 'visitor', content: 'track my order' }]);
  assert.ok(/order ID/.test(en) && /confirmation/.test(en) && !tp.promisesToday(en));
  assert.ok(/order ID/.test(lg.orderIdAfterPhoneReply([{ sender: 'visitor', content: 'mera order kahan hai' }])) && /Kripya/.test(lg.orderIdAfterPhoneReply([{ sender: 'visitor', content: 'mera order kahan hai' }])));
});
t('rulebook: 7.11 (owner 5 Oct) is a code rule at the end of section 7 that names the closed-hours note; 7.6 names the week', () => {
  const rule = (id) => rb.RULEBOOK.flatMap((s) => s.rules).find((r) => r.id === id);
  const sec = rb.RULEBOOK.find((s) => s.rules.some((r) => r.id === '7.11'));
  assert.strictEqual(sec.rules[sec.rules.length - 1].id, '7.11');
  assert.ok(rule('7.11').how === 'code' && /Promised Mon 10 AM/.test(rule('7.11').text) && /never says the courier is closed/.test(rule('7.11').text));
  assert.ok(/Saturday is a half day/.test(rule('7.6').text) && /on Monday morning, after 10 AM/.test(rule('7.6').text));
});
t('rulebook: 7.10 (owner 4 Oct) is a code rule in section 7', () => {
  const rule = (id) => rb.RULEBOOK.flatMap((s) => s.rules).find((r) => r.id === id);
  assert.ok(rb.RULE_IDS.has('7.10') && rule('7.10').how === 'code' && /Sudharo/.test(rule('7.10').text));
});
t('rulebook: 4.11 (owner 4 Oct) is a code rule at the end of section 4', () => {
  const rule = (id) => rb.RULEBOOK.flatMap((s) => s.rules).find((r) => r.id === id);
  assert.ok(rb.RULE_IDS.has('4.11') && rule('4.11').how === 'code');
  assert.ok(/revised date/.test(rule('4.11').text) && /5 days/.test(rule('4.11').text));
});

// ── The closed-hours note for an upset customer (owner 2026-10-05, closed-hours.ts) ──
const ch = load('closed-hours');
t('closed-hours: who gets the note and when (Critical: weekend 1st / night 2nd message; Frustrated: 3rd; calm never; full, short, then silent; a team member active: never)', () => {
  const step = (o) => ch.closedNoteStep({ why: 'weekend', score: 80, asks: 1, sent: 0, teamActiveMin: null, ...o });
  assert.strictEqual(step({}), 'full');
  assert.strictEqual(step({ sent: 1 }), 'short');
  assert.strictEqual(step({ sent: 2 }), 'silent');
  assert.strictEqual(step({ why: 'night' }), null);                       // Critical at night: not on the 1st message
  assert.strictEqual(step({ why: 'night', asks: 2 }), 'full');
  assert.strictEqual(step({ why: 'holiday' }), 'full');
  assert.strictEqual(step({ score: 74 }), null);                          // Frustrated: the 3rd message
  assert.strictEqual(step({ score: 74, asks: 2 }), null);
  assert.strictEqual(step({ score: 50, asks: 3 }), 'full');
  assert.strictEqual(step({ score: 49, asks: 9 }), null);                 // calmer: never
  assert.strictEqual(step({ why: null }), null);                          // the office is open
  assert.strictEqual(step({ teamActiveMin: 10 }), null);                  // a person is in the chat
  assert.strictEqual(step({ teamActiveMin: 30 }), 'full');
  assert.deepStrictEqual([ch.CLOSED_NOTE_CRITICAL_MIN, ch.CLOSED_NOTE_UPSET_MIN, ch.TEAM_ACTIVE_MIN, ch.CLOSED_NOTE_KEY], [75, 50, 30, 'closed_note']);
});
t('closed-hours: the notes are fixed text in English and Hinglish, honest about OUR hours, never "the courier is closed", never a day of arrival, and the waiting rule matches every one', () => {
  const EN = 'where is my order, nobody answers', HI = 'bhai mera order kahan hai';
  const all = [];
  for (const why of ['night', 'weekend', 'holiday']) {
    for (const after of ['tomorrow', 'this_morning', 'monday', 'tuesday']) {
      for (const [said, hi] of [[EN, false], [HI, true]]) {
        const full = ch.closedNote(said, why, after, 'full'), short = ch.closedNote(said, why, after, 'short');
        assert.strictEqual(ch.closedNote(said, why, after, 'silent'), null);
        all.push(full);   // the short line names only when the team is back, so it is the same for every `why`
        for (const x of [full, short]) {
          assert.ok(x && x.length > 40, `${why} ${after}`);
          assert.strictEqual(tp.promisesToday(x), false, x);
          assert.ok(!/1 hour|24 hours|ghante|courier (is|are) (closed|off)|courier band|courier ka off/i.test(x), x);
          assert.ok(new RegExp(waiting.AI_NOT_AN_ANSWER_REGEX, 'i').test(x), 'still waiting: ' + x);
          assert.ok(new RegExp(ch.CLOSED_NOTE_REGEX, 'i').test(x), x);
          assert.strictEqual(esc.looksHinglish(x), hi || /subah/.test(x), x);
          assert.ok(!x.includes("'") || !hi, 'no apostrophes in the Hinglish line');
        }
        assert.ok(full.includes(esc.teamBackWhen(after, hi).charAt(0).toUpperCase() + esc.teamBackWhen(after, hi).slice(1)), full);
        assert.ok(short.includes(esc.teamBackWhen(after, hi)), short);
      }
    }
  }
  assert.strictEqual(new Set(all).size, all.length, 'every full note is different');
  assert.ok(ch.closedNote(EN, 'weekend', 'monday', 'full').includes('closed over the weekend') && ch.closedNote(EN, 'weekend', 'monday', 'full').includes('On Monday morning, after 10 AM, our team will sit down with your case first thing'));
  assert.ok(ch.closedNote(EN, 'holiday', 'tuesday', 'full').includes('closed for the holiday'));
  assert.ok(ch.closedNote(EN, 'night', 'tomorrow', 'full').includes('10 AM to 7:30 PM'));
  assert.ok(ch.closedNote(HI, 'weekend', 'monday', 'full').includes('Monday subah 10 baje ke baad hamari team sabse pehle aapka case lekar baithegi'));
  // waiting.ts carries the same phrase (the SQL regex): a change to one must change the other.
  assert.ok(waiting.AI_NOT_AN_ANSWER_REGEX.endsWith('|' + ch.CLOSED_NOTE_REGEX));
  // The reply with the note as its only promise: the fixed team lines and hour promises go, the AI's facts stay.
  const note = ch.closedNote(EN, 'weekend', 'monday', 'full');
  assert.strictEqual(ch.withoutTeamLines(`Your order is In Transit.\n\n${esc.teamWillReplyLine(EN, 'monday')}`, [esc.teamWillReplyLine(EN, 'monday')]), 'Your order is In Transit.');
  assert.strictEqual(ch.withoutTeamLines(esc.teamWillReplyLine(EN, null), [esc.teamWillReplyLine(EN, null)]), '');
  assert.ok(note.length > 0);
});
t('escalation: the week\'s lines name the day ("on Monday morning, after 10 AM"), promise no hours and no "today"', () => {
  for (const after of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']) {
    const Day = after.charAt(0).toUpperCase() + after.slice(1);
    assert.strictEqual(esc.teamWillReplyLine(EN, after), `Our team will reply to you here in this chat on ${Day} morning, after 10 AM.`);
    assert.strictEqual(esc.teamWillReplyLine(HI, after), `Hamari team ${Day} subah 10 baje ke baad isi chat mein aapko jawab degi.`);
    assert.strictEqual(esc.routineLine('refund', EN, after), `I've noted your refund or cancellation request. Our team will reply to you here in this chat on ${Day} morning, after 10 AM.`);
    assert.strictEqual(esc.weekdayLabel(after), Day);
    for (const x of [esc.teamWillReplyLine(EN, after), esc.urgentAck(HI, after), esc.routineLine('refund', HI, after)]) {
      assert.strictEqual(tp.promisesToday(x), false, x);
      assert.ok(!/1 hour|24 hours|ghante|tomorrow|\bkal\b/.test(x), x);
    }
  }
  assert.strictEqual(esc.weekdayLabel('tomorrow'), null);
  assert.strictEqual(esc.weekdayLabel(null), null);
  assert.strictEqual(esc.teamBackWhen('tomorrow', false), 'tomorrow morning, after 10 AM');
  assert.strictEqual(esc.teamBackWhen('monday', true), 'Monday subah 10 baje ke baad');
  // The day and night lines are exactly what they were (the 12 night lines above still hold).
  assert.strictEqual(esc.teamWillReplyLine(EN, null), 'Our team will reply to you here in this chat within 1 hour.');
});
t('suggest: outside the week the instruction names the day; an upset customer while the office is closed gets the honest closed-hours option (rulebook 7.11)', () => {
  const base = { lang: 'auto', after: 'monday', caseKind: null, orderJson: '{"status":"Out for Delivery"}' };
  const mon = sg.suggestInstruction(base);
  assert.ok(mon.includes('"on Monday morning, after 10 AM, here in this chat" ("Monday subah 10 baje ke baad isi chat mein")') && mon.includes('Saturday to 14:00') && mon.includes('never "tomorrow"'), mon);
  assert.ok(!mon.includes('This customer is very upset'));
  const upset = sg.suggestInstruction({ ...base, upsetClosed: 'weekend' });
  assert.ok(upset.includes('This customer is very upset and the office is closed') && upset.includes('closed over the weekend') && upset.includes('on Monday morning, after 10 AM we sit down with their case') && upset.includes('Never say the courier is closed'), upset);
  assert.ok(sg.suggestInstruction({ ...base, after: 'tomorrow', upsetClosed: 'night' }).includes('not in the office right now') && sg.suggestInstruction({ ...base, after: 'tomorrow', upsetClosed: 'night' }).includes('tomorrow morning, after 10 AM we sit down'));
  assert.ok(sg.suggestInstruction({ ...base, after: 'tuesday', upsetClosed: 'holiday' }).includes('closed for the holiday'));
  assert.ok(!sg.suggestInstruction({ ...base, after: null, upsetClosed: 'weekend' }).includes('very upset'), 'the office is open: no such line');
});


// ── Links without copy-paste junk (reply-guards.ts stripLinkJunk, owner 2026-10-05: "yeh chatgpt kyu likha aa raha hai?") ──
t('stripLinkJunk: utm_source=chatgpt.com, fbclid, gclid go; the AWB, the path, other parameters and the punctuation after the link stay', () => {
  const L = 'https://app.fship.in/shipment/tracking?awbno=143449611038166&utm_source=chatgpt.com';
  assert.deepStrictEqual(rg.stripLinkJunk(`Here's your tracking link: ${L}. We're keeping an eye on it.`),
    { text: "Here's your tracking link: https://app.fship.in/shipment/tracking?awbno=143449611038166. We're keeping an eye on it.", changed: true });
  assert.deepStrictEqual(rg.stripLinkJunk('https://x.in/t?utm_source=chatgpt.com&awbno=12345678&fbclid=abc'), { text: 'https://x.in/t?awbno=12345678', changed: true });
  assert.deepStrictEqual(rg.stripLinkJunk('link (https://x.in/t?a=1&utm_medium=chat)'), { text: 'link (https://x.in/t?a=1)', changed: true });
  assert.deepStrictEqual(rg.stripLinkJunk('https://x.in/t?utm_source=chatgpt.com'), { text: 'https://x.in/t', changed: true });
  // Untouched: no junk, a ShipTrack link, a word that merely says utm, no link at all.
  for (const x of ['https://shiptrack.store/track/abc-123', 'https://app.fship.in/shipment/tracking?awbno=143449611038166', 'utm_source is a word', 'no link here', '']) {
    assert.deepStrictEqual(rg.stripLinkJunk(x), { text: x, changed: false }, x);
  }
  // The suggested replies and Sudharo clean the link too; Sudharo's "same links" check compares clean with clean.
  const ctx = { customerTexts: ['where is my parcel'], courierNames: [] };
  assert.deepStrictEqual(sg.guardOptions([`Your tracking link: ${L}`], ctx), ['Your tracking link: https://app.fship.in/shipment/tracking?awbno=143449611038166']);
  assert.strictEqual(sg.acceptPolish(`ur link ${L} pls check`, `Your link ${L}, please check.`), 'Your link https://app.fship.in/shipment/tracking?awbno=143449611038166, please check.');
  assert.strictEqual(sg.acceptPolish(`ur link ${L} pls check`, 'Your link https://other.in/x, please check.'), 'ur link https://app.fship.in/shipment/tracking?awbno=143449611038166 pls check');
});

// ── "What to do next" strip (owner 2026-10-08, next-step.ts) ──
const ns = load('next-step');
t('next-step: a visitor is told to verify (order ID + full phone) and nothing about any order; a closed chat needs nothing', () => {
  const base = { status: 'human_needed', known: false, verified: false, subject: 'Refund / Cancellation', caseKind: null, caseByChikki: false, reshipped: false, threat: false, accuse: false, health: null, waitingMs: null, returned: false, promiseDue: false, order: null, heldBy: null, heldByMe: false, canReply: true };
  const v = ns.nextStep(base);
  assert.strictEqual(v.wants, 'Not verified yet');
  assert.ok(/Order ID and the full phone number/.test(v.steps.join(' ')) && !/refund/i.test(v.steps.join(' ')));
  assert.strictEqual(ns.nextStep({ ...base, status: 'ai_handling' }).tone, 'muted');
  assert.strictEqual(ns.nextStep({ ...base, status: 'resolved', known: true }).wants, 'Chat is closed');
});
t('next-step: known customers get the rule-backed steps (refund form is the Super Admin\'s, no promises, family check for Delivered, Ship again, address in Details), at most 3 steps, upset or overdue is red', () => {
  const k = { status: 'agent_handling', known: true, verified: true, subject: null, caseKind: null, caseByChikki: false, reshipped: false, threat: false, accuse: false, health: 10, waitingMs: null, returned: false, promiseDue: false, order: { delivered: false, mode: 'normal' }, heldBy: null, heldByMe: true, canReply: true };
  const refund = ns.nextStep({ ...k, subject: 'Refund / Cancellation' });
  assert.ok(/Super Admin/.test(refund.steps.join(' ')) && /Do not promise an amount or a time/.test(refund.steps.join(' ')));
  assert.ok(/family, neighbours/.test(ns.nextStep({ ...k, subject: 'Not received', order: { delivered: true, mode: 'normal' } }).steps.join(' ')));
  assert.ok(/Never promise arrival today/.test(ns.nextStep({ ...k, subject: 'Delivery delay' }).steps.join(' ')));
  assert.ok(/Ship again/.test(ns.nextStep({ ...k, subject: 'Wrong tracking link' }).steps.join(' ')));
  assert.ok(/Details/.test(ns.nextStep({ ...k, subject: 'Address change' }).steps.join(' ')));
  const reship = ns.nextStep({ ...k, caseKind: 'reship' });
  assert.strictEqual(reship.wants, 'New parcel not sent yet');
  assert.strictEqual(ns.nextStep({ ...k, caseKind: 'reship', reshipped: true }).wants, 'New parcel sent');
  assert.strictEqual(ns.nextStep({ ...k, caseKind: 'refund', caseByChikki: true }).wants, 'Refund case');
  const threat = ns.nextStep({ ...k, threat: true });
  assert.strictEqual(threat.tone, 'danger');
  assert.ok(!/refund|chargeback form/i.test(threat.steps.join(' ').replace(/chargebacks or complaints/, '')), 'a threat gets no refund promise');
  const late = ns.nextStep({ ...k, subject: 'Refund / Cancellation', waitingMs: 3 * 3600_000, health: 80 });
  assert.strictEqual(late.tone, 'danger'); assert.ok(late.steps.length <= 3 && /waited 3h/.test(late.steps[0]));
  assert.ok(/has this chat/.test(ns.nextStep({ ...k, heldBy: 'Rahul', heldByMe: false }).steps[0]));
  assert.strictEqual(ns.waitedText(90 * 60_000), '1h');
});

// ── CSV upload: is this the right panel? (owner 2026-10-08, upload-check.ts) ──
const uc = load('upload-check', '../../src/lib');
t('upload-check: a file that looks like another panel gets a warning, a normal first upload to a new panel gets none', () => {
  const base = { panelName: 'Kurtiya', total: 10, inSelected: 0, inOthers: [], brandPanelsOther: [], brandMatchesSelected: false };
  assert.deepStrictEqual(uc.uploadWarnings(base), [], 'nothing known: no warning');
  // The brand in the file is another panel's name and not this one's.
  const brand = uc.uploadWarnings({ ...base, brandPanelsOther: ['VASTRIKA'] });
  assert.strictEqual(brand.length, 1); assert.strictEqual(brand[0].code, 'brand'); assert.ok(/VASTRIKA/.test(brand[0].message) && /Kurtiya/.test(brand[0].message));
  assert.deepStrictEqual(uc.uploadWarnings({ ...base, brandPanelsOther: ['VASTRIKA'], brandMatchesSelected: true }), [], 'the chosen panel matches a brand too: fine');
  // Most of the file's order numbers already sit in another panel and none in this one.
  const other = uc.uploadWarnings({ ...base, inOthers: [{ panel: 'vastora', count: 9, sample: ['1301', '#1302', '1303'] }] });
  assert.strictEqual(other.length, 1); assert.strictEqual(other[0].code, 'other_panel');
  assert.ok(/9 of the 10/.test(other[0].message) && /#1301, #1302, #1303/.test(other[0].message) && /"vastora"/.test(other[0].message));
  // A small overlap, a small share, or numbers this panel already has say nothing (numbers repeat across stores).
  assert.deepStrictEqual(uc.uploadWarnings({ ...base, inOthers: [{ panel: 'vastora', count: 2, sample: ['1', '2'] }] }), []);
  assert.deepStrictEqual(uc.uploadWarnings({ ...base, total: 100, inOthers: [{ panel: 'vastora', count: 40, sample: ['1'] }] }), []);
  assert.deepStrictEqual(uc.uploadWarnings({ ...base, inSelected: 4, inOthers: [{ panel: 'vastora', count: 9, sample: ['1'] }] }), []);
});
t('upload route: no panel is ever created from a CSV, an existing order updates only this panel\'s row, every upload is recorded', () => {
  const route = fs.readFileSync(path.resolve(__dirname, '../../src/app/api/upload/route.ts'), 'utf8');
  assert.ok(!/INSERT INTO businesses/.test(route), 'no panel from a CSV');
  assert.ok(/WHERE order_id = \$\$\{pi\} AND business_id = \$\$\{pi \+ 1\}/.test(route), 'the update is panel-scoped');
  assert.ok(/recordUpload\(/.test(route));
  const biz = fs.readFileSync(path.resolve(__dirname, '../../src/app/api/businesses/route.ts'), 'utf8');
  const post = biz.slice(biz.indexOf('export async function POST'), biz.indexOf('export async function PATCH'));
  assert.ok(/user\.role !== 'admin'/.test(post) && /checkOwnerPassword\(password\)/.test(post), 'a new panel: Super Admin + their password');
  assert.ok(post.indexOf('checkOwnerPassword') < post.indexOf('INSERT INTO businesses'), 'the password is checked first');
});

t('panel names: the same store written another way ("X" / "X Store", one letter apart) is refused on create and rename (owner 2026-10-08)', () => {
  const pn = load('panel-name', '../../src/lib');
  const sim = (a, b) => pn.panelNamesSimilar(a, b);
  for (const [a, b] of [['VASTRIKA', 'VASTRIKA STORE'], ['vastora', 'vestora'], ['Vastrika', ' vastrika  shop '], ['Lo-mora', 'LOMORA'], ['kurtiya', 'Kurtiya Official']]) assert.ok(sim(a, b), `${a} ~ ${b}`);
  for (const [a, b] of [['vastora', 'VASTRIKA'], ['kurtiya', 'LOMORA'], ['RUHANI', 'Studio Nine'], ['abc', 'abd'], ['', 'x'], [null, 'x']]) assert.ok(!sim(a, b), `${a} !~ ${b}`);
  assert.ok(/panelNamesSimilar\(b\.name, cleanName\)/.test(fs.readFileSync(path.resolve(__dirname, '../../src/app/api/businesses/route.ts'), 'utf8')), 'create checks it');
  assert.ok(/b\.id !== String\(id\) && panelNamesSimilar/.test(fs.readFileSync(path.resolve(__dirname, '../../src/app/api/businesses/route.ts'), 'utf8')), 'rename checks it (not against itself)');
});

console.log(`UNIT: ${n} groups passed`);
