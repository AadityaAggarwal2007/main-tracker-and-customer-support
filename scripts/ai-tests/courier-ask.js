// The courier (Valmo) is named only on the customer's 3rd ask about which courier delivers
// (owner, 2026-10-02 10:55). Before that it is "our courier partner" / "hamare courier partner"
// and a "Courier: X" line is dropped. The asks are counted over this chat and the customer's
// earlier chats on the site (customer_key); a message that only names the courier in a complaint
// is not an ask; a yes / no check of the name is. A count that cannot be read never names it.
// Offline: the pure helpers (reply-guards.ts) and the REAL getAIResponse (ai.ts) through
// harness.js, with a scripted model and a fake database. Nothing is sent anywhere.
const path = require('path'), assert = require('assert'), Module = require('module');
const { state, getAI, OUT } = require('./harness');

const rg = require(path.join(OUT, 'reply-guards.js'));
let n = 0;
const t = async (name, fn) => {
  try { await fn(); n++; } catch (e) { console.error(`FAIL  ${name}`); throw e; }
};

// ── The fake database: the customer's other chats (ai.ts courierAsksSoFar) ──────────────
const db = Module._load('@/lib/db', module, false);
const baseQuery = db.query;
const other = { rows: [], fail: false, calls: 0, sql: '' };
db.query = async (sql, params) => {
  if (/customer_key/.test(sql) && /JOIN messages/.test(sql)) {
    other.calls++; other.sql = sql;
    if (other.fail) throw new Error('connection refused');
    return { rows: other.rows.map((content) => ({ content })) };
  }
  return baseQuery(sql, params);
};

const order = (o = {}) => ({
  order_id: '#4715', customer_name: 'Test Customer', status: 'Shipped', tracking_id: 'STTEST123',
  tracking_link: 'https://shiptrack.store/track/test-token', courier: 'Valmo', estimated_delivery: '2026-10-10',
  total: 499, products: ['Earrings Set'], placed_on: '2026-09-28T17:11:00Z', store: 'Vastora', cancelled: false, payment: 'Prepaid', ...o,
});
const V = (text) => ({ who: 'visitor', text });
const A = (text) => ({ who: 'ai', text });
function rowsFor(history) {
  const now = Date.now();
  return history.map((h, i) => ({ sender: h.who, content: h.text, metadata: null, created_at: new Date(now - (history.length - i) * 20000) }));
}

let getAIResponse;
async function reply({ history, mock, earlier = [], dbFails = false }) {
  Object.assign(state, {
    history: rowsFor(history), verifiedOrderId: '#4715', fresh: { found: true, count: 1, orders: [order()] }, verified: true,
    facts: null, health: null, effortSettings: { calm: 'normal', uneasy: 'normal', frustrated: 'normal', critical: 'normal' },
    brain: [], brainError: false, faqs: [], examples: [], lookups: {}, script: [{ content: mock }], requests: [], responses: [],
  });
  Object.assign(other, { rows: earlier, fail: dbFails, calls: 0, sql: '' });
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const r = await getAIResponse('test-conv', null, null, null, 'chat', 'test-site', { brain: [] });
    return { text: r.content || '', system: String(state.requests[0]?.messages?.[0]?.content || ''), dbCalls: other.calls };
  } finally { console.log = log; console.error = err; }
}

(async () => {
  // ── 1. What counts as an ask (pure) ─────────────────────────────────────────────────────
  await t('asks: which courier / company / courier ka naam / kaun sa courier, in English, Hinglish and Hindi', () => {
    for (const s of [
      'which courier is delivering my order?', 'Which courier', 'what is the courier name?', 'courier name?', 'name of the courier?',
      'who is the courier?', 'who will deliver my order', 'which company?', 'which company is delivering my order',
      'from which logistics this order is shipped??', 'Which platform delivers the order?', 'which delivery company',
      'mera order kaunse courier se aa raha hai?', 'kaun sa courier hai', 'konsa courier hai', 'bhai courier kon sa h',
      'courier ka naam kya hai', 'courier ka naam batao', 'courier konsa hai', 'delivery partner kaun hai',
      'kis company se aa raha hai', 'kaun si company deliver karegi', 'kaun deliver kar raha hai', 'delivery kaun karega',
      'kaun la raha hai mera parcel', 'kisse aa raha hai order', 'kis courier se bheja hai', 'courier details bhejo',
      'कौन सा कूरियर है?', 'किस कूरियर से आ रहा है', 'कूरियर का नाम क्या है', 'कौन डिलीवर करेगा', 'कौनसी कंपनी से आ रहा है',
    ]) assert.ok(rg.asksAboutCourier(s), `should be an ask: ${s}`);
  });
  await t('asks: a yes / no check of the name counts ("kya ye Valmo se aa raha hai?")', () => {
    for (const s of [
      'kya ye Valmo se aa raha hai?', 'Valmo se aa raha hai kya', 'is it Valmo?', 'Valmo?', 'Which courier? Valmo?',
      'is this coming through Valmo?', 'Is my order shipped by Valmo?', 'Delhivery or Valmo?', 'valmo se aayega na?',
      'क्या ये वाल्मो से आ रहा है?',
    ]) assert.ok(rg.asksAboutCourier(s), `a check of the name is an ask: ${s}`);
    assert.ok(rg.asksAboutCourier('kya ye Shree Express se aa raha hai?', ['Shree Express']), 'a panel courier from the lookup');
  });
  await t('not an ask: the courier named in a complaint, a contact ask, a date ask, other questions', () => {
    for (const s of [
      'Valmo website shows tracking id invalid', 'Valmo website shows trecking id invalid', 'valmo pe tracking id invalid bata raha hai',
      'valmo pe tracking id invalid aa raha hai kya?', 'valmo par tracking id nahi mil rahi', 'वाल्मो पर आईडी नहीं मिल रही',
      'valmo wala delivery boy nahi aa raha', 'valmo se parcel nahi mila', 'valmo ka number do', 'valmo ka number kya hai?',
      'valmo se kab aayega?', 'kya valmo pe track kar sakte hai?', 'Valmo wale bol rahe hai order cancel hai, kya ye sach hai?',
      'courier nahi aa raha', 'courier ka number do', 'courier ne call kiya tha', 'The courier guy was rude', 'the courier did not come',
      'courier kon se din aayega', 'kis din courier aayega', 'kis time deliver hoga', 'kaun sa order aa raha hai',
      'ye kis company ka product hai', 'aap kis company se ho', 'refund kaun dega', 'who should I contact for delivery issue',
      'Track my order', 'order kab aayega', 'where is my order', 'tracking link bhejo', 'ट्रैकिंग लिंक भेजो', 'hi', 'ok thanks',
    ]) assert.ok(!rg.asksAboutCourier(s), `not an ask: ${s}`);
  });
  await t('counting: one message is one ask; complaints do not count', () => {
    assert.strictEqual(rg.courierAskCount(['which courier?', 'Valmo website shows tracking id invalid', 'kaun sa courier hai? which courier?', 'ok', 'kya ye Valmo se aa raha hai?']), 3);
    assert.strictEqual(rg.courierAskCount([]), 0);
  });

  // ── 2. The guard (pure): the name only from the 3rd ask, never on an unknown count ──────
  await t('guard: 1st and 2nd ask hide the name, the 3rd keeps it, unknown hides it', () => {
    const r = 'Your order is being delivered by Valmo.';
    const hidden = 'Your order is being delivered by our courier partner.';
    const g = (asks, latest = 'which courier is delivering?') => rg.withoutUnaskedCourier(r, latest, ['Valmo'], asks).text;
    assert.strictEqual(g(1), hidden);
    assert.strictEqual(g(2), hidden);
    assert.strictEqual(g(3), r);
    assert.strictEqual(g(7), r);
    assert.strictEqual(g(null), hidden);
    assert.strictEqual(g(undefined), hidden);
    assert.strictEqual(rg.withoutUnaskedCourier(r, 'which courier is delivering?', ['Valmo']).text, hidden, 'no count given = not yet');
    // A count of 3 is not enough when the latest messages do not ask.
    assert.strictEqual(g(3, 'ok thanks'), hidden);
    assert.strictEqual(g(3, 'Valmo website shows tracking id invalid'), hidden);
    assert.ok(!rg.courierNameAllowed('which courier?', 2) && rg.courierNameAllowed('which courier?', 3) && !rg.courierNameAllowed('which courier?', null));
    assert.strictEqual(rg.COURIER_NAME_FROM_ASK, 3);
  });
  await t('guard: the "Courier: X" line goes before the 3rd ask; links are never touched', () => {
    const details = 'Tracking ID: ST1\nCourier: Valmo\nStatus: Shipped\nhttps://shiptrack.store/track/abc';
    assert.strictEqual(rg.withoutUnaskedCourier(details, 'tracking details aur courier ka naam do', ['Valmo'], 2).text, 'Tracking ID: ST1\nStatus: Shipped\nhttps://shiptrack.store/track/abc');
    assert.strictEqual(rg.withoutUnaskedCourier(details, 'tracking details aur courier ka naam do', ['Valmo'], 3).text, details);
    const link = 'Valmo will deliver it. See https://valmo.in/track/x';
    assert.strictEqual(rg.withoutUnaskedCourier(link, 'which courier?', ['Valmo'], 1).text, 'Our courier partner will deliver it. See https://valmo.in/track/x');
    assert.strictEqual(rg.withoutUnaskedCourier('Aapka order Valmo se aa raha hai.', 'kaun sa courier hai', ['Valmo'], 1).text, 'Aapka order hamare courier partner se aa raha hai.');
    assert.strictEqual(rg.withoutUnaskedCourier('आपका ऑर्डर वाल्मो से आ रहा है।', 'कौन सा कूरियर है?', ['Valmo'], 1).text, 'आपका ऑर्डर हमारे कूरियर पार्टनर से आ रहा है।');
    assert.strictEqual(rg.withoutUnaskedCourier('आपका ऑर्डर वाल्मो से आ रहा है।', 'कौन सा कूरियर है?', ['Valmo'], 3).text, 'आपका ऑर्डर वाल्मो से आ रहा है।');
  });

  await t('guard: real replies on the 1st / 2nd ask stay whole sentences ("our courier partner", never cut)', () => {
    const cases = [
      // [the model's reply, the customer's message, what the customer gets]
      ['Your order is with Valmo and is In Transit, estimated delivery 7 October 2026.', 'Valmo website shows tracking id invalid', 'Your order is with our courier partner and is In Transit, estimated delivery 7 October 2026.'],
      ['Your parcel is with Valmo. You can track it here:\nhttps://shiptrack.store/track/x', 'which courier?', 'Your parcel is with our courier partner. You can track it here:\nhttps://shiptrack.store/track/x'],
      ['The courier for your order is Valmo.', 'which courier?', 'Your order is with our courier partner.'],
      ['Your courier partner is Valmo.', 'which courier?', 'Your order is with our courier partner.'],
      ['Valmo is our courier partner for this order.', 'which courier?', 'Your order is with our courier partner.'],
      ['Your order is being shipped by Valmo, our courier partner.', 'which courier?', 'Your order is being shipped by our courier partner.'],
      ["It's being delivered by Valmo Logistics.", 'which courier?', "It's being delivered by our courier partner."],
      ['We ship all orders with Valmo.', 'which courier?', 'We ship all orders with our courier partner.'],
      ['Aapka courier Valmo hai.', 'kaun sa courier hai', 'Aapka order hamare courier partner ke paas hai.'],
      ['Hamare courier partner Valmo hain.', 'kaun sa courier hai', 'Aapka order hamare courier partner ke paas hai.'],
      ['Aapka order Valmo courier se aa raha hai.', 'kaun sa courier hai', 'Aapka order hamare courier partner se aa raha hai.'],
      ['Courier: Valmo', 'courier ka naam batao', 'Aapka order hamare courier partner ke paas hai.'],
      ['Courier partner: Valmo', 'which courier?', 'Your order is with our courier partner.'],
      ['आपका कूरियर वाल्मो है।', 'कौन सा कूरियर है?', 'आपका ऑर्डर हमारे कूरियर पार्टनर के पास है।'],
    ];
    for (const [reply, said, want] of cases) {
      for (const asks of [1, 2]) assert.strictEqual(rg.withoutUnaskedCourier(reply, said, ['Valmo'], asks).text, want, `${asks}: ${reply}`);
    }
    // No word left dangling: never "is and", "is.", "partner courier", "partner Logistics", "the courier is our courier partner".
    for (const [reply, said] of cases) {
      const out = rg.withoutUnaskedCourier(reply, said, ['Valmo'], 1).text;
      assert.ok(!/\bis (?:and|\.)|partner (?:courier|logistics)\b|courier(?: partner)? is our courier partner|^\s*$/i.test(out), out);
      assert.ok(!/v[ao]lmo|वाल्मो/i.test(out.replace(/https?:\/\/\S+/g, '')), out);
    }
  });

  // ── 3. The real getAIResponse (ai.ts): count, prompt note, guard ─────────────────────────
  ({ getAIResponse } = getAI());
  const NAMED = 'Your order is being delivered by Valmo.';
  await t('ai: 1st ask -> no name, the "not yet" note, one count read', async () => {
    const r = await reply({ history: [V('which courier is delivering my order?')], mock: NAMED });
    assert.ok(!/valmo/i.test(r.text), r.text);
    assert.match(r.system, /COURIER NAME[^\n]*do not name the courier in this reply/);
    // The note asks for the same whole sentence the guard writes (never "aapka courier hamare courier partner hai").
    assert.match(r.system, /COURIER NAME[^\n]*one whole sentence[^\n]*"Aapka order hamare courier partner ke paas hai\."/);
    assert.ok(!/may name|three times or more/.test(r.system));
    assert.strictEqual(r.dbCalls, 1);
  });
  await t('ai: 2nd ask -> still no name', async () => {
    const r = await reply({ history: [V('which courier?'), A('Your order is with our courier partner.'), V('courier ka naam kya hai')], mock: 'Aapka order Valmo se aa raha hai.' });
    assert.strictEqual(r.text, 'Aapka order hamare courier partner se aa raha hai.');
  });
  await t('ai: 3rd ask in this chat -> the name is given, the "may name" note', async () => {
    const r = await reply({ history: [V('which courier?'), A('Your order is with our courier partner.'), V('courier ka naam kya hai'), A('Aapka order hamare courier partner se aa raha hai.'), V('kaun sa courier hai bhai?')], mock: NAMED });
    assert.strictEqual(r.text, NAMED);
    assert.match(r.system, /COURIER NAME[^\n]*three times or more/);
  });
  await t('ai: asks in an earlier chat of the same customer count', async () => {
    const r = await reply({ history: [V('kya ye Valmo se aa raha hai?')], mock: 'Haan, aapka order Valmo se aa raha hai.', earlier: ['which courier is delivering?', 'Hi', 'courier ka naam batao'] });
    assert.strictEqual(r.text, 'Haan, aapka order Valmo se aa raha hai.');
    assert.match(other.sql, /me\.customer_key IS NOT NULL/);
    assert.match(other.sql, /c\.site_id = me\.site_id/);
    assert.match(other.sql, /c\.id <> me\.id/);
    assert.match(other.sql, /m\.sender = 'visitor'/);
    assert.match(other.sql, /m\.deleted_at IS NULL/);
  });
  await t('ai: earlier complaint mentions of Valmo do not count', async () => {
    const r = await reply({
      history: [V('which courier?'), A('Your order is with our courier partner.'), V('which courier is it?')], mock: NAMED,
      earlier: ['Valmo website shows tracking id invalid', 'valmo wala delivery boy nahi aa raha', 'valmo ka number do'],
    });
    assert.ok(!/valmo/i.test(r.text), r.text);
  });
  await t('ai: Devanagari asks, the 3rd names it', async () => {
    const hi = 'आपका ऑर्डर वाल्मो से आ रहा है।';
    const first = await reply({ history: [V('कौन सा कूरियर है?')], mock: hi });
    assert.strictEqual(first.text, 'आपका ऑर्डर हमारे कूरियर पार्टनर से आ रहा है।');
    const third = await reply({ history: [V('कौन सा कूरियर है?'), A('x'), V('कूरियर का नाम क्या है'), A('y'), V('किस कूरियर से आ रहा है')], mock: hi });
    assert.strictEqual(third.text, hi);
  });
  await t('ai: the count cannot be read -> never named (even with 3 asks in this chat)', async () => {
    const r = await reply({ history: [V('which courier?'), A('a'), V('which courier?'), A('b'), V('which courier??')], mock: NAMED, dbFails: true });
    assert.ok(!/valmo/i.test(r.text), r.text);
    assert.match(r.system, /do not name the courier in this reply/);
  });
  await t('ai: not asking -> no count read, no note, the "Courier:" line dropped, links kept', async () => {
    const r = await reply({ history: [V('tracking details do')], mock: 'Tracking ID: STTEST123\nCourier: Valmo\nStatus: Shipped\nhttps://shiptrack.store/track/test-token' });
    assert.strictEqual(r.text, 'Tracking ID: STTEST123\nStatus: Shipped\nhttps://shiptrack.store/track/test-token');
    assert.strictEqual(r.dbCalls, 0);
    assert.ok(!/COURIER NAME \(from the system/.test(r.system));
  });
  await t('ai: a complaint naming Valmo is not an ask -> no count read, the name becomes our courier partner', async () => {
    const r = await reply({ history: [V('Valmo website shows tracking id invalid')], mock: "Valmo's website does not show this ID. Here is your tracking link:\nhttps://shiptrack.store/track/test-token" });
    assert.strictEqual(r.text, "Our courier partner's website does not show this ID. Here is your tracking link:\nhttps://shiptrack.store/track/test-token");
    assert.strictEqual(r.dbCalls, 0);
  });
  await t('prompt: the tracking details list has no Courier line and says to wait for the note', () => {
    const p = require(path.join(OUT, 'ai.js')).DEFAULT_SYSTEM_PROMPT;
    assert.ok(p.includes('Tracking ID, Status, Estimated delivery') && !p.includes('Tracking ID, Courier'));
    assert.ok(p.includes('unless a COURIER NAME note below says you may'));
  });

  console.log(`COURIER-ASK: ${n} groups passed`);
})().catch((e) => { console.error(e); process.exit(1); });
