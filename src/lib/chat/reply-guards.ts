// ── Two checks on every reply, made in code (owner, 2026-10-01) ─────────────────────
// The prompt already says both; the model still slipped in live tests, so the reply is fixed
// here, the same way today-promise.ts and order-mention.ts do it. Pure: only address-conflict.ts
// and escalation.ts, both without imports. Tested offline (scripts/ai-tests).
//
// 1. dropAddressEcho: the agent must not repeat an address the customer typed (the prompt's
//    ADDRESS CHANGE section: "ask them to type the correct address, do not repeat it back").
//    A run of words the reply copies from a message of the customer that looks like an address
//    (addressIn) is taken out, when it carries a place name, a house number or a PIN code.
//    Ordinary words the two share ("your new address is noted") are never touched.
// 2. withCheckAround: an order the team marked Delivered that the customer says they did not
//    get: before anything else, the customer is asked ONCE to check with family, neighbours,
//    security or reception (the prompt's DELIVERY PROBLEMS section). If the agent has not asked
//    it in this chat yet and the reply does not ask it, the line is added.
import { addressIn } from './address-conflict';
import { looksHinglish } from './escalation';

const ADDRESS_HINT = /^(?:road|rd|street|st|sector|nagar|colony|lane|marg|gali|chowk|block|phase|flat|house|plot|apartment|apartments|apt|society|tower|wing|floor|building|bldg|village|vpo|dist|district|tehsil|enclave|vihar|puram|ganj|bazar|market|near|opp|opposite|landmark|pin|pincode|hno|extension)$/;

interface Tok { w: string; start: number; end: number }

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

export function dropAddressEcho(reply: string, customerTexts: string[]): { text: string; changed: boolean } {
  if (!reply || !customerTexts.length) return { text: reply, changed: false };
  const addresses = customerTexts
    .map((t) => ({ t, guess: addressIn(t) }))
    .filter((x): x is { t: string; guess: NonNullable<ReturnType<typeof addressIn>> } => !!x.guess);
  if (!addresses.length) return { text: reply, changed: false };

  const rt = tokens(reply);
  const spans: [number, number][] = [];
  for (const { t, guess } of addresses) {
    const at = tokens(t).map((x) => x.w);
    const joined = ` ${at.join(' ')} `;
    const placeWord = (w: string) => guess.words.has(w);
    const digits = (w: string) => /\d/.test(w);
    for (let i = 0; i < rt.length; i++) {
      // The longest run starting at i that the customer's address message also has, in order.
      let j = i;
      while (j < rt.length && joined.includes(` ${rt.slice(i, j + 1).map((x) => x.w).join(' ')} `)) j++;
      // Only the address itself: generic words at either end ("naya address", "is") stay.
      const specific = (w: string) => placeWord(w) || digits(w) || ADDRESS_HINT.test(w);
      let a = i, b = j - 1;
      while (a <= b && !specific(rt[a].w)) a++;
      while (b >= a && !specific(rt[b].w)) b--;
      const run = a <= b ? rt.slice(a, b + 1).map((x) => x.w) : [];
      if (!run.length) continue;
      const hasPlace = run.some(placeWord);
      const hasDigit = run.some(digits);
      const hasHint = run.some((w) => ADDRESS_HINT.test(w));
      const isPin = run.length === 1 && guess.pin !== null && run[0] === guess.pin;
      const ok = isPin
        || (run.length >= 3 && (hasPlace || hasDigit))
        || (run.length === 2 && (hasDigit || (hasPlace && hasHint)));
      if (ok) {
        spans.push([rt[a].start, rt[b].end]);
        i = j - 1;
      }
    }
  }
  if (!spans.length) return { text: reply, changed: false };

  // Right after the word "address" / "pata" the place is just dropped ("your address 12 MG Road
  // is noted" -> "your address is noted"); anywhere else it becomes "the address you shared".
  // In the reply's own language (a Hinglish customer may get an English reply).
  const hinglish = looksHinglish(reply) || /\b(?:aapka|aapki|aapke|naya|nayi|liya|maine|humne|hamari)\b/i.test(reply);
  const stand = hinglish ? 'aapka bataya hua address' : 'the address you shared';
  spans.sort((a, b) => b[0] - a[0]);
  let text = reply;
  for (const [s, e] of spans) {
    // "address X", "address: X", "address as X", "address noted is X".
    const lead = text.slice(Math.max(0, s - 40), s);
    const afterAddressWord = /\b(?:address|addr|pata)\b(?:\s+(?:noted|saved|updated|likha))?\s*(?:as|is|hai|=)?[\s:–—-]*["'“‘(]?\s*$/i.test(lead) || /पता[\s:–—-]*$/.test(lead);
    // "Sector 21 ka address", "MG Road's address", "Pune wala address": the word address follows.
    const before = text.slice(e).match(/^\s*["'”’)]?\s*(?:'s|ka|ki|ke|wala|wali|vala|vali)?\s*(?=(?:address|addr|pata)\b)/i);
    if (!afterAddressWord && before) {
      text = text.slice(0, s) + text.slice(e + before[0].length);
      continue;
    }
    text = text.slice(0, s) + (afterAddressWord ? '\u0000' : '\u0001') + text.slice(e);
  }
  text = text
    // "Your new address: X." -> "Your new address is noted."
    .replace(/\b(address|pata)\s*[:–—-]\s*["'“‘(]?\s*\u0000\s*["'”’)]?\s*(?=[.!?]|$)/gi, hinglish ? '$1 note kar liya hai' : '$1 is noted')
    // "address as X and" / "address noted is X." : the connector goes with the place.
    .replace(/\b((?:address|addr|pata)(?:\s+(?:noted|saved|updated|likha))?)\s+(?:as|is|hai|=)\s*["'“‘(]?\s*\u0000/gi, '$1\u0000')
    .replace(/\u0001/g, stand)
    .replace(/["“‘']\s*(the address you shared|aapka bataya hua address)\s*["”’']/g, '$1')
    .replace(/(?:,\s*)+(?=[.!?]|$)/g, '')
    // The separators that framed the address: "the address — X — and", "address: X.", "(X)", "'X'".
    .replace(/[\s,:;–—-]*["'“”‘’(]?\s*\u0000\s*["'“”‘’)]?[\s,;–—-]*(?=[.!?]|$)/g, '')
    .replace(/\s*[,:;–—-]?\s*["'“”‘’(]?\s*\u0000\s*["'“”‘’)]?\s*[,;–—-]?\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([.!?])\s*[,;:]\s*/g, '$1 ')
    .trim();
  // Fix the capital letter of a sentence that now starts with the remaining word.
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (m, pre: string, c: string) => pre + c.toUpperCase());
  if (!text.replace(/[^\p{L}\p{N}]/gu, '') || text.replace(/[^\p{L}\p{N} ]/gu, '').trim().toLowerCase() === stand.toLowerCase()) {
    text = looksHinglish(customerTexts.join(' ')) ? 'Maine aapka bataya hua address note kar liya hai.' : "I've noted the address you shared.";
  }
  return { text, changed: true };
}

// The customer says the parcel did not reach them.
const NOT_RECEIVED = [
  /\b(?:not|never|didn'?t|did not|haven'?t|have not|hasn'?t|has not|no one|nobody)\b[^.?!\n]{0,25}\b(?:receiv\w*|got|get|arriv\w*|come|came|reach\w*|deliver\w*)\b/i,
  /\b(?:nahi|nahin|nhi|na|nai)\s+(?:mila|mili|mile|aaya|aayi|aya|ayi|aaye|pahuncha|pahunchi|pohcha)\b/i,
  /\b(?:mila|mili|aaya|aya|aayi|receive|deliver)\s+(?:hi\s+)?(?:nahi|nhi|nahin|nai)\b/i,
  /\b(?:missing|lost|kho gaya|gum)\b/i,
  /\b(?:deliver\w*|delivery)\s+(?:nahi|nhi|nahin)\s+(?:hui|hua|huyi|hu[ia])\b/i,
  /(?:नहीं मिला|नहीं मिली|नहीं आया|नहीं आई)/,
];
const ASKS_AROUND = /\b(?:family|neighbou?rs?|security|reception|guard|watchman|padosi|parivaar|pariwar|ghar (?:ke|wal\w*)|aas.?paas|nearby|gate)\b/i;
const CLOSING = /\n*\s*(?:anything else[^\n]*|is there anything else[^\n]*|kuch aur[^\n]*|aur koi[^\n]*)$/i;

// "Refund nahi mila", "email not received": about money or a message, not the parcel.
const NOT_PARCEL = /\b(?:refund|money|paisa|paise|payment|amount|otp|e-?mail|mail|sms|message|msg|call|link|reply|response|invoice|bill|update|tracking)\b/i;
const PARCEL = /\b(?:parcel|package|packet|order|item|product|saman|samaan|jhumk\w*|earring\w*|delivered|delivery)\b/i;

export function saysNotReceived(text: string): boolean {
  const t = text || '';
  if (!NOT_RECEIVED.some((re) => re.test(t))) return false;
  return !(NOT_PARCEL.test(t) && !PARCEL.test(t));
}

export function checkAroundLine(customerText: string): string {
  return looksHinglish(customerText)
    ? 'Kabhi-kabhi delivered parcel ghar ke kisi member, padosi, security guard ya reception ke paas aa jata hai. Please ek baar unse check kar lijiye.'
    : 'Sometimes a delivered parcel is received by a family member, a neighbour, the security guard or reception. Could you please check with them once?';
}

export function withCheckAround(reply: string, ctx: {
  customerLatest: string;      // the customer's latest messages, joined
  orderDelivered: boolean;     // an order in this chat is marked Delivered
  earlierAgentReplies: string[];
}): { text: string; changed: boolean } {
  if (!reply || !ctx.orderDelivered || !saysNotReceived(ctx.customerLatest)) return { text: reply, changed: false };
  if (ASKS_AROUND.test(reply) || ctx.earlierAgentReplies.some((r) => ASKS_AROUND.test(r || ''))) return { text: reply, changed: false };
  const line = checkAroundLine(ctx.customerLatest);
  const close = reply.match(CLOSING);
  if (close && close.index !== undefined && close.index > 0) {
    const body = reply.slice(0, close.index).trimEnd();
    return { text: `${body}\n\n${line}\n\n${close[0].trim()}`, changed: true };
  }
  return { text: `${reply.trimEnd()}\n\n${line}`, changed: true };
}

// 3. withoutUnaskedCourier: the courier (Valmo for Vastora) is named only when the customer asks
//    which courier / company delivers (owner, 2026-10-01), and since 2026-10-02 10:55 only from
//    the customer's THIRD such ask, counted over this chat and their earlier chats on the site
//    (ai.ts reads the count). Before that the name becomes "our courier partner" and a
//    "Courier: X" line is dropped. Every order now carries a courier (courier.ts), so without
//    this the agent said "shipped via Valmo" to everyone. Links are never touched. The result is
//    always a whole sentence (2026-10-02 review): "delivered by Valmo" -> "delivered by our courier
//    partner" (the preposition stays, so an ask is still answered and "is with Valmo and" never
//    becomes "is and"), "the courier is Valmo" / "aapka courier Valmo hai" -> "your order is with our
//    courier partner" / "aapka order hamare courier partner ke paas hai", "Valmo Logistics" -> one
//    "our courier partner", and a reply that was only "Courier: Valmo" gets that sentence.
//    An ask is a real question about WHO delivers: "which courier", "kaun sa courier", "courier
//    ka naam kya hai", "kis company se aa raha hai", "kaun deliver karega", "कौन सा कूरियर", or a
//    yes / no check of a name ("kya ye Valmo se aa raha hai?", "is it Valmo?"). A message that
//    only names the courier in a complaint ("Valmo website shows tracking id invalid", "valmo
//    wala delivery boy nahi aa raha", "valmo ka number do") is not an ask.
export const COURIER_NAME_FROM_ASK = 3;

const COURIER_W = String.raw`(?:(?:delivery|shipping|shipment|courier|logistics?)\s+(?:company|companies|partner|partners|service|agency|provider|firm)|couri[eo]rs?|curr?i[eo]rs?|cori[eo]rs?|kuri[ae]?y?[ae]?rs?|kooriyar|logistic\w*|logestic\w*|carriers?)`;
const COMPANY_W = String.raw`(?:company|companies|compan[iy]|compny|comapny|kampani|kampni|kumpani)`;
const OTHER_W = String.raw`(?:platform|partner|agency|service|provider)`;
const WHICH = String.raw`(?:which|wich|whch|kaun|kon|koun|kaunsa|konsa|kounsa|kaunsi|konsi|kaunse|konse|kis)`;
const FILL = String.raw`(?:\s+(?:is|was|will|be|the|one|wala|vala|wali|wale|sa|si|se|hai|h|he|ka|ki|ke|delivery|shipping|your|ur|my|mera|meri|mere|aapka|aapki|apka|apki|ye|yeh))`;
const NOT_A_DAY = String.raw`(?!\s+(?:(?:sa|si|se)\s+)?(?:din|date|tarikh|tareekh|time|samay|waqt|baje|jagah|jagha|city|day|month))`;
const DELIVERY_CTX = /\b(?:deliver\w*|ship\w*|dispatch\w*|couri[eo]r\w*|logistic\w*|parcel|package|bhej\w*|send|sent|aa\s+(?:raha|rha|rahi|rhi|rahe)|aayega|aaega|ayega|aayegi|aaegi|la\s+(?:raha|rha|rahi|rhi)|layega|laega|laayega)\b|डिलीवर|भेज|आ रहा|आ रही|कूरियर/i;
const PRODUCT_OR_STORE = /\b(?:product|products|item|items|brand|store|shop|website|site|earrings?|jhumk\w*|dress|kurti|saree|sari|suit|kapd\w*|cloth\w*|maal|saman|samaan|bag|you|u|aap|ap|tum|your|ur|aapki|apki|aapka|apka)\b/i;
const NOT_WHO = /\b(?:contact|call|complain\w*|talk|speak|baat|refund|paisa|paise|money|reply|jawab|answer|number|phone|email|helpline|responsible|blame|fault|help)\b/i;

// Questions about who delivers, tested one sentence at a time.
const ASK_WHICH: RegExp[] = [
  // "which courier", "kaun sa courier", "kaunse courier se", "which is the courier", "kis logistics se"
  new RegExp(`\\b${WHICH}\\b${NOT_A_DAY}${FILL}{0,3}\\s+${COURIER_W}\\b`, 'i'),
  // "what courier", "what is the courier name", "what's the logistics"
  new RegExp(`\\bwhat(?:'s|s|\\s+is|\\s+was|\\s+will\\s+be)?(?:\\s+(?:the|your|ur|my))?\\s+${COURIER_W}\\b`, 'i'),
  // "courier kaun sa hai", "courier konsa hai", "delivery partner kaun hai"
  new RegExp(`\\b${COURIER_W}\\b(?:\\s+(?:company|partner|service|ka|ki|ke|wala|wale|hai|h|he|is|tha|hoga|hogi|aapka|apka|mera))?\\s+(?:kaun|kon|koun|kaunsa|konsa|kounsa|kaunsi|konsi|kaunse|konse)\\b${NOT_A_DAY}`, 'i'),
  // "courier ka naam", "courier name", "courier partner name", "courier details"
  new RegExp(`\\b${COURIER_W}\\b(?:\\s+(?:company|partner|service|wale|wala))?\\s*(?:ka|ki|ke|'s)?\\s*(?:naam|nam|name|details?|info|information)\\b`, 'i'),
  // "name of the courier"
  new RegExp(`\\b(?:naam|name)\\s+(?:of\\s+)?(?:the\\s+|your\\s+|ur\\s+)?${COURIER_W}\\b`, 'i'),
];
// "which company" / "kis company se" / "company ka naam": only about the delivery, never "kis
// company ka product hai" or "aap kis company se ho".
const ASK_COMPANY: RegExp[] = [
  new RegExp(`\\b(?:${WHICH}|what)\\b${NOT_A_DAY}${FILL}{0,2}\\s+${COMPANY_W}\\b`, 'i'),
  new RegExp(`\\b${COMPANY_W}\\s+(?:kaun|kon|koun|kaunsi|konsi|kaunsa|konsa)\\b`, 'i'),
  new RegExp(`\\b${COMPANY_W}\\s*(?:ka|ki|ke|'s)?\\s*(?:naam|nam|name)\\b`, 'i'),
];
// "which platform / partner delivers": only with a delivery word in the sentence.
const ASK_OTHER = new RegExp(`\\b(?:${WHICH}|what)\\b${NOT_A_DAY}${FILL}{0,2}\\s+${OTHER_W}\\b`, 'i');
// "who delivers", "kaun deliver karega", "kaun la raha hai", "delivery kaun karega", "kisse aa raha hai"
const ASK_WHO: RegExp[] = [
  /\b(?:who|whom)(?:'s|s)?\b[^.?!\n]{0,25}?\b(?:deliver\w*|ship\w*|bring\w*|sending|send\w*|dispatch\w*|couri[eo]rs?|logistic\w*|carriers?)\b/i,
  /\b(?:kaun|kon|koun)\b(?!\s*(?:sa|si|se)\b)(?:\s+\S+){0,3}?\s+(?:deliver\w*|delivery|la|laa|laega|layega|laayega|laaega|bhej\w*|ship\w*|dega|degi|aayega|aaega|ayega|aa\s+(?:raha|rha|rahi|rhi|rahe))\b/i,
  /\b(?:delivery|deliver|parcel|order|saman|samaan)\s+(?:kaun|kon|koun)\s+(?:karega|karegi|karenge|kar\s+(?:raha|rha|rahi|rhi|rahe)|dega|degi|layega|laega|laayega|bhejega|la\s+(?:raha|rha))\b/i,
  /\b(?:kisse|kis\s*se|kiske\s+(?:through|thru|dwara|zariye|zarie)|kis\s+ke\s+(?:through|thru|dwara|zariye)|kisne)\b(?:\s+\S+){0,3}?\s+(?:aa|aaya|aayega|aaega|ayega|bhej\w*|ship\w*|deliver\w*|send|sent|dispatch\w*)\b/i,
];
const ASK_HI: RegExp[] = [
  /(?:कौन|कोन|किस)\s*(?:सा|सी|से)?\s*(?:कूरियर|कुरियर|कोरियर|कुरिअर|कंपनी|कम्पनी|लॉजिस्टिक|प्लेटफॉर्म|प्लेटफार्म|पार्टनर)/,
  /(?:कूरियर|कुरियर|कोरियर|कंपनी|कम्पनी)\s*(?:पार्टनर\s*)?(?:का|की|के)?\s*(?:नाम|कौन|कोन)/,
  /(?:कौन|कोन)\s*(?:डिलीवर|डिलिवर|डेलिवर|भेज|ला\s*रह|लाएगा|लायेगा)/,
  /(?:डिलीवरी|डिलिवरी)\s*(?:कौन|कोन)/,
  /(?:किससे|किस\s*से|किसने)\s*(?:\S+\s*){0,2}?(?:आ\s*रह|आएगा|आयेगा|भेज|डिलीवर)/,
];
// A yes / no check of a courier's name: "kya ye Valmo se aa raha hai?", "is it Valmo?", "Valmo?".
const KNOWN_COURIERS = String.raw`v[ao]lmo|walmo|delhi?ver[yi]|blue\s?dart|e-?kart|shadowfax|xpress\s?bees|dtdc|india\s+post|speed\s?post|ecom\s+express|smartr|shiprocket|amazon\s+shipping`;
const KNOWN_COURIERS_HI = 'वाल्मो|वॉल्मो|वालमो|डेल्हीवरी|दिल्लीवरी|ब्लू ?डार्ट|ईकार्ट';
const YES_NO = /\?\s*$|\b(?:kya|kia|kyaa|is\s+it|isn'?t\s+it|right)\b|^\s*(?:is|are|will|would|does|do|did|was|has|have|can)\b|\b(?:na|naa)\s*\??\s*$|क्या/i;
// Complaints, other questions (when / why / where / how), contact asks: never a check of the name.
const NOT_A_CHECK = /\b(?:invalid|valid|wrong|galat|galt|glat|fake|farzi|farji|nakli|fraud|scam|error|stuck|atka\w*|ruka|update\w*|website|site|app|portal|online|tr[ae]?c?k\w*|awb|number|contact|phone|call\w*|helpline|care|office|hub|warehouse|boy|agent|rider|guy|banda|rude|refund|return|cancel\w*|rto|wapas|why|kyu|kyun|kyon|kab|when|where|kaha|kahan|kidhar|kitne|kitna|how|kaise|problem|issue|complain\w*|late|delay\w*|status|not|nahi|nahin|nhi|nai|never|don'?t|didn'?t|doesn'?t|won'?t|can'?t|cannot|bol\w*|said|says|told|keh\w*|msg|message|sms|otp|cod|paisa|paise|payment|pay|good|bad|achha|acha|bekar|bakwas|worst|trust|bharosa|reliable|safe)\b|गलत|ग़लत|नहीं|नही|फर्जी|फ़र्ज़ी|नकली|फेक|वेबसाइट|साइट|ऐप|ट्रैक|ट्रेक|नंबर|कब|कहाँ|कहां|क्यों|क्यूँ|कैसे|शिकायत|रिफंड|कॉल|फोन|अपडेट/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const courierNameRe = (courierNames: string[]) => {
  const names = Array.from(new Set(courierNames.map((n) => String(n || '').trim()).filter((n) => n.length >= 3)));
  return new RegExp(`\\b(?:${[KNOWN_COURIERS, ...names.map(esc)].join('|')})\\b|${KNOWN_COURIERS_HI}`, 'i');
};

function sentenceAsks(s: string, nameRe: RegExp): boolean {
  if (ASK_WHICH.some((re) => re.test(s)) || ASK_HI.some((re) => re.test(s))) return true;
  if (ASK_COMPANY.some((re) => re.test(s)) && (DELIVERY_CTX.test(s) || !PRODUCT_OR_STORE.test(s))) return true;
  if (ASK_OTHER.test(s) && DELIVERY_CTX.test(s)) return true;
  if (ASK_WHO.some((re) => re.test(s)) && !NOT_WHO.test(s)) return true;
  return nameRe.test(s) && YES_NO.test(s) && !NOT_A_CHECK.test(s);
}

// Does this message ask which courier / company delivers the order? One message is one ask.
export function asksAboutCourier(text: string, courierNames: string[] = []): boolean {
  const t = String(text || '').slice(0, 2000);
  if (!t.trim()) return false;
  const nameRe = courierNameRe(courierNames);
  return t.split(/(?<=[.!?\n।])\s*/).some((s) => s.trim() !== '' && sentenceAsks(s, nameRe));
}

// How many of these customer messages ask which courier delivers.
export function courierAskCount(texts: string[], courierNames: string[] = []): number {
  return texts.filter((t) => asksAboutCourier(t, courierNames)).length;
}

// The name may be given only when the latest messages ask AND this is at least the third ask
// (asks: every ask of this customer so far, the latest included). Unknown (null / not given)
// = not yet: a failed read never names the courier.
export function courierNameAllowed(customerLatest: string, asks: number | null | undefined, courierNames: string[] = []): boolean {
  return typeof asks === 'number' && asks >= COURIER_NAME_FROM_ASK && asksAboutCourier(customerLatest, courierNames);
}

// The name in Devanagari (a Hindi reply) becomes "हमारे कूरियर पार्टनर"; "आपका कूरियर वाल्मो है"
// becomes "आपका ऑर्डर हमारे कूरियर पार्टनर के पास है".
const NAME_HI = /(?:वाल्मो|वॉल्मो|वालमो)/g;
const NAME_HI_IS = /(?:(?:आपका|आपके)\s*)?(?:कूरियर|कुरियर|कोरियर)(?:\s*पार्टनर)?\s*(?:वाल्मो|वॉल्मो|वालमो)\s*(?:है|हैं)/g;
const COURIER_SAYS_EN = 'your order is with our courier partner';
const COURIER_SAYS_HINGLISH = 'aapka order hamare courier partner ke paas hai';

export function withoutUnaskedCourier(
  reply: string,
  customerLatest: string,
  courierNames: string[],
  asks: number | null = null,   // the customer's courier asks so far, the latest included; null = unknown
): { text: string; changed: boolean } {
  if (!reply || courierNameAllowed(customerLatest, asks, courierNames)) return { text: reply, changed: false };
  const names = Array.from(new Set(courierNames.map((n) => String(n || '').trim()).filter((n) => n.length >= 3)));
  const alt = ['v[ao]lmo', ...names.map(esc)].join('|');
  const NAME = `(?:${alt})`;
  if (!new RegExp(`\\b${NAME}\\b`, 'i').test(reply) && !/(?:वाल्मो|वॉल्मो|वालमो)/.test(reply)) return { text: reply, changed: false };
  const hinglish = looksHinglish(reply);
  const partner = hinglish ? 'hamare courier partner' : 'our courier partner';
  // The name with a courier word after it ("Valmo Logistics", "Valmo courier"): one name.
  const NAMED = `${NAME}(?:\\s+(?:courier|couriers|logistics|express))?`;
  const KIND = String.raw`(?:courier|delivery|logistics|shipping)(?:\s+(?:partner|company|service|provider|agency))?`;
  const FOR_ORDER = String.raw`(?:\s+(?:for|of|on)\s+(?:your|this|the)\s+(?:order|parcel|package|shipment))?`;

  // Never inside a link.
  const parts = reply.split(/(https?:\/\/\S+)/g);
  const fixed = parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      // "Courier: Valmo" on its own line
      .replace(new RegExp(`^[ \\t]*(?:courier(?:\\s+partner)?|delivery\\s+partner|logistics(?:\\s+partner)?)\\s*[:\\-–—]\\s*${NAMED}[ \\t]*\\.?[ \\t]*(?:\\r?\\n|$)`, 'gim'), '')
      // "The courier for your order is Valmo", "Your courier partner is Valmo", "Valmo is our courier
      // partner for this order" -> "your order is with our courier partner" (never "the courier is
      // our courier partner"); "Aapka courier Valmo hai" -> "aapka order hamare courier partner ke paas hai"
      .replace(new RegExp(`\\b(?:the|your|ur)\\s+${KIND}${FOR_ORDER}\\s+(?:is|will\\s+be|would\\s+be)\\s+${NAMED}\\b`, 'gi'), COURIER_SAYS_EN)
      .replace(new RegExp(`\\b${NAMED}\\s+(?:is|will\\s+be)\\s+(?:the|your|our)\\s+${KIND}${FOR_ORDER}(?=\\s*(?:[.!?,]|$))`, 'gim'), COURIER_SAYS_EN)
      .replace(new RegExp(`\\b(?:(?:aapka|aapke|apka|apke|aapki|apki|hamara|hamare|humare|hamari)\\s+)?(?:order\\s+(?:ka|ke)\\s+)?${KIND}\\s+${NAMED}\\s+(?:hai|hain)\\b`, 'gi'), COURIER_SAYS_HINGLISH)
      // "our courier partner, Valmo," / "courier partner (Valmo)" / "courier partner Valmo se"
      .replace(new RegExp(`\\b((?:courier|delivery|logistics|shipping)\\s+partner)(?:\\s*[,:(—–-]\\s*|\\s+)${NAMED}(?:\\s*\\))?`, 'gi'), '$1')
      // "Valmo (our courier partner)" / "Valmo, our courier partner" -> "our courier partner"
      .replace(new RegExp(`${NAMED}\\s*(?:\\(\\s*((?:our|hamare)\\s+(?:courier|delivery|logistics)\\s+partner)\\s*\\)|[,—–-]\\s*((?:our|hamare)\\s+(?:courier|delivery|logistics)\\s+partner)\\b)`, 'gi'), '$1$2')
      // anything left: the name becomes "our courier partner" ("shipped via Valmo" -> "shipped via
      // our courier partner", "is with Valmo and" -> "is with our courier partner and")
      .replace(new RegExp(`\\b${NAMED}(?:'s)?\\b`, 'gi'), (m) => (/'s$/i.test(m) ? `${partner}'s` : partner))
      .replace(NAME_HI_IS, 'आपका ऑर्डर हमारे कूरियर पार्टनर के पास है')
      .replace(NAME_HI, 'हमारे कूरियर पार्टनर');
  }).join('');
  let text = fixed
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/(^|[.!?]\s+|\n)(our courier partner|hamare courier partner|your order is with our|aapka order hamare)/g, (m, pre: string, p: string) => pre + p.charAt(0).toUpperCase() + p.slice(1))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // The reply was only the courier line ("Courier: Valmo"): say it in a sentence instead.
  if (!text.replace(/[^\p{L}\p{N}]/gu, '')) {
    text = looksHinglish(customerLatest) ? 'Aapka order hamare courier partner ke paas hai.' : 'Your order is with our courier partner.';
  }
  return { text, changed: text !== reply };
}

// ── Exact tracking links (owner 2026-10-03, from the chat report) ──
// The model retypes the tracking link from the lookup result and sometimes changes a character
// (6 dead links in the 1-3 Oct chats: "35ec8bcb" for "35ecb8cb", "82202749" for "82302749"). Every
// tracking-page link in a reply (scheme optional, any host, "/track/<token>") is compared with the
// links the lookup results gave: written exactly, it stays byte for byte; a token a few edits away
// from a known one becomes that exact link; a link on a known host whose token matches nothing while
// the chat knows exactly one link becomes that link; anything else (another site's /track/ page, two
// orders and no close token) is left as it is. Text without such a link is returned unchanged.
const TRACK_LINK_RE = /(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/track\/(?:[A-Za-z0-9_~-]|\.(?=[A-Za-z0-9]))+/gi;
const linkParts = (link: string): { host: string; token: string } | null => {
  const m = link.match(/^(?:https?:\/\/)?([^/]+)\/track\/(.+)$/i);
  return m ? { host: m[1].toLowerCase(), token: m[2] } : null;
};
function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
export function withExactTrackingLinks(reply: string, knownLinks: string[]): { text: string; changed: boolean; fixed: number } {
  const input = reply || '';
  const known = Array.from(new Set(knownLinks.filter((l) => typeof l === 'string' && linkParts(l)))).map((l) => ({ link: l, ...linkParts(l)! }));
  if (!known.length || !/\/track\//i.test(input)) return { text: input, changed: false, fixed: 0 };
  let fixed = 0;
  const text = input.replace(TRACK_LINK_RE, (written) => {
    const w = linkParts(written);
    if (!w) return written;
    if (known.some((k) => k.host === w.host && k.token === w.token)) return written;
    let best: { link: string; d: number } | null = null;
    for (const k of known) {
      const d = editDistance(w.token.toLowerCase(), k.token.toLowerCase());
      if (!best || d < best.d) best = { link: k.link, d };
    }
    const limit = Math.max(2, Math.floor(Math.max(w.token.length, 1) * 0.2));
    let exact: string | null = best && best.d <= limit ? best.link : null;
    if (!exact && known.length === 1 && known[0].host === w.host) exact = known[0].link;
    if (!exact || exact === written) return written;
    fixed++;
    return exact;
  });
  return { text, changed: fixed > 0, fixed };
}
