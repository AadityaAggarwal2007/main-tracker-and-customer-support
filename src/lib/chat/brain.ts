// ── The Brain (owner, 2026-10-01) ─────────────────────────────────────────────
// Notes the owner keeps in Panel Settings (table brain_notes, chat-brain.sql). The AI is
// shown only the ones that fit the customer's message: every `always` note, plus the notes
// whose topics appear in what the customer just wrote. That keeps the prompt short and lets
// the owner teach the agent something new without a deploy. Pure (only today-promise.ts, itself
// pure), tested offline.
import { promisesToday } from './today-promise';

export type BrainKind = 'rule' | 'fact' | 'lesson';

export type BrainAudience = 'all' | 'verified' | 'visitor';

export interface BrainNote {
  id?: string;
  audience?: BrainAudience;
  kind: BrainKind;
  title: string;
  body: string;
  topics: string[];
  always: boolean;
  sort_order?: number;
}

// The topics a note can be filed under, and the words in a customer message that bring each
// one up (English, Hinglish and Hindi). A topic with no match is simply not shown.
export const BRAIN_TOPICS: { key: string; label: string; words: RegExp }[] = [
  { key: 'refund', label: 'Refund', words: /\b(refund|money back|paisa?\s*wapas|paise\s*wapas|return\s*money|chargeback)\b|रिफंड|पैसे\s*वापस/i },
  { key: 'cancel', label: 'Cancel', words: /\b(cancel|cancell?ation|cancle)\b|कैंसिल|रद्द/i },
  { key: 'payment', label: 'Payment', words: /\b(pay|paid|payment|upi|card|debit|credit|deducted|kat\s*gaya|paisa\s*kat|transaction|cash on delivery)\b|पेमेंट|भुगतान/i },
  { key: 'delivery', label: 'Delivery date / delay', words: /\b(when|kab|date|eta|estimated|expected|delay|late|der|deliver\w*|arriv\w*|aayega|milega|kitne\s*din|how many days|\d+\s*days?|\d+\s*din)\b|डिलीवरी|कब|कितने\s*दिन/i },
  { key: 'tracking', label: 'Tracking / status', words: /\b(track\w*|status|where|kaha|kahan|shipped|dispatch\w*|out for delivery|in transit|stuck|link)\b|ट्रैक|कहाँ|कहां/i },
  { key: 'address', label: 'Address', words: /\b(address|pincode|pin code|landmark)\b|पता|पिनकोड/i },
  { key: 'cod', label: 'COD', words: /\b(cod|cash on delivery|prepaid)\b|कैश/i },
  { key: 'contact', label: 'Contact / number', words: /\b(number|contact|call|phone|whatsapp|customer care|helpline|agent|delivery\s*(man|boy|agent)|speak|talk)\b|नंबर|कॉल/i },
  { key: 'exchange', label: 'Exchange / return', words: /\b(exchange|return|replace\w*|size)\b|एक्सचेंज/i },
  { key: 'damaged', label: 'Damaged / wrong item', words: /\b(damag\w*|broken|wrong (item|product)|defect\w*|torn|tuta|toota|khraab|kharab|missing)\b|टूटा|खराब/i },
  { key: 'verify', label: 'Verify / order lookup', words: /\b(order\s*(id|number|no)|verify|verification|phone number|registered)\b|ऑर्डर\s*(आईडी|नंबर)/i },
];

export const BRAIN_TOPIC_KEYS = BRAIN_TOPICS.map((t) => t.key);

// The topics a piece of text brings up.
export function topicsIn(text: string): string[] {
  return BRAIN_TOPICS.filter((t) => t.words.test(text)).map((t) => t.key);
}

export const BRAIN_CHAR_BUDGET = 3500;
export const BRAIN_MAX_NOTES = 14;

// The notes to show for this customer message: `always` notes first, then topic matches (a
// note that matches more of the message's topics first), within a character budget so the
// prompt stays short. `text` is the customer's latest messages joined.
export function selectNotes(
  notes: BrainNote[], text: string, budget = BRAIN_CHAR_BUDGET, max = BRAIN_MAX_NOTES, verified?: boolean,
): BrainNote[] {
  const wanted = new Set(topicsIn(text));
  // A note meant for verified customers (or visitors) is skipped for the other kind of chat.
  // When the caller does not say, every note is eligible.
  const eligible = (n: BrainNote) => verified === undefined || !n.audience || n.audience === 'all'
    || (n.audience === 'verified' ? verified : !verified);
  const scored = notes
    .filter(eligible)
    .map((n, i) => ({ n, i, hits: n.always ? 99 : n.topics.filter((t) => wanted.has(t)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || (a.n.sort_order ?? 0) - (b.n.sort_order ?? 0) || a.i - b.i);
  const out: BrainNote[] = [];
  let used = 0;
  for (const { n } of scored) {
    const size = n.title.length + n.body.length + 6;
    if (out.length >= max || used + size > budget) continue;
    used += size;
    out.push(n);
  }
  return out;
}

// The block added to the system prompt, or '' when nothing fits.
export function brainSection(selected: BrainNote[]): string {
  if (!selected.length) return '';
  const lines = selected.map((n) => `- ${n.title.trim()}: ${n.body.trim().replace(/\s*\n+\s*/g, ' ')}`);
  return `

STORE BRAIN
Notes from the store owner about exactly this kind of question. Follow them, in the customer's language.
The SHIPTRACK RULES above always win over a note, and a note never makes you ask for anything except the order ID and the phone number.
${lines.join('\n')}`;
}

// Why a note may not be saved, or null. A note is the owner's own words, but it must never teach
// what the locked rules forbid (SHIPTRACK_MASTER_RULES.md): promising arrival today / tonight /
// tomorrow, hiding the estimated date, asking for anything but the order ID and the phone,
// promising a refund, sending a payment link or skipping the check of who the customer is.
// Checked when a note is added, changed or approved; the locked rules still win at answer time.
export function noteProblem(title: string, body: string): string | null {
  const text = `${title}. ${body}`;
  if (promisesToday(text)) return 'A note must not tell the agent to say an order arrives today, tonight or tomorrow.';
  // The rest are checked sentence by sentence, and a sentence that says "never" / "do not" before
  // the thing is a ban on it, which is what the locked rules want, so it passes.
  const NEGATED = /\b(?:never|not|no|don'?t|do not|mat|nahi|nhi|without asking)\b/i;
  const checks: [RegExp, string][] = [
    [/\b(?:ask|request|maango|poochho|collect)\b[^.]{0,50}\b(?:upi|utr|transaction\s*id|payment\s*reference|screenshot|account\s*number|e-?mail|email|full\s*name|aadhaar)/i, 'The agent may ask only for the order ID and the phone number, nothing else.'],
    [/\b(?:send|share|give)\b[^.]{0,30}\b(?:payment\s*link|upi\s*id|bank\s*(?:details|account))/i, 'A note must not tell the agent to send payment details.'],
    [/\b(?:pay|payment)\b[^.]{0,20}\b(?:again|dobara|retry)\b/i, 'A note must not tell the agent to ask the customer to pay again.'],
    [/\b(?:promise|guarantee|assure|confirm)\b[^.]{0,40}\b(?:refund|replacement|cancell?ation)\b/i, 'A note must not tell the agent to promise a refund, a replacement or a cancellation.'],
    [/\b(?:skip|no need (?:for|to)|bina)\b[^.]{0,40}\b(?:verif\w*|order\s*id|phone)\b/i, 'A note must not tell the agent to skip the order ID and phone check.'],
    // Who goes to the team is decided by the system (only verified customers, owner 2026-09-30).
    [/\b(?:hand(?:s|ing)?\s*(?:it\s*)?(?:off|over)|escalat\w*|transfer\w*|connect\w*\s+(?:them\s+)?(?:to|with)\s+(?:the\s+)?team)\b[^.]{0,80}\b(?:verif\w*|cannot find|can'?t find|not found|attempts?|tries|failed|lookups?|identifiers?)\b|\b(?:verif\w*|cannot find|can'?t find|not found|attempts?|failed|lookups?)\b[^.]{0,80}\b(?:hand(?:s|ing)?\s*(?:it\s*)?(?:off|over)|escalat\w*|transfer\w*)\b/i, 'Who is handed to the team is decided by the system: only a verified customer, never after failed checks.'],
  ];
  // Finding an order takes the order ID AND the phone (master rules 8.1), and the customer is
  // helped here in the chat, never sent to e-mail, WhatsApp or a call.
  if (/\border\s*(?:id|number|no)\b[^.]{0,40}\b(?:first|only)\b[^.]{0,80}\b(?:not|instead of|without|unless)\b[^.]{0,30}\b(?:phone|mobile)\b/i.test(text)
    || /\b(?:do not|don'?t|never|mat)\s+(?:ask|maango|poochho)\b[^.]{0,20}\b(?:for\s+)?(?:the\s+|their\s+)?(?:phone|mobile|verification|order\s*id)\b(?![^.]{0,40}\b(?:again|twice|already|dobara|phir se)\b)/i.test(text)) {
    return 'Finding an order needs both the order ID and the phone number: a note cannot drop one.';
  }
  if (/\b(?:direct|redirect|send|refer|ask)\b[^.]{0,30}\b(?:to\s+)?(?:e-?mail|whatsapp|call|instagram|facebook)\b(?:\s+(?:support|us|the team|team))?/i.test(text)
    && !/\b(?:no|not|never|don'?t|do not)\b[^.]{0,30}\b(?:e-?mail|whatsapp|call)\b/i.test(text)) {
    return 'The customer is helped here in the chat: a note cannot send them to e-mail, WhatsApp or a call.';
  }
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const [re, message] of checks) {
      const m = re.exec(sentence);
      if (m && !NEGATED.test(sentence.slice(0, m.index))) return message;
    }
  }
  // Hiding the estimated date.
  if (/\b(?:never|don'?t|do not|mat)\b[^.]{0,30}\b(?:give|share|tell|say|batao|bolo)\b[^.]{0,30}\b(?:estimated\s+)?date\b/i.test(text)) return 'A note must not tell the agent to hide the estimated delivery date.';
  return null;
}

// Word overlap between two notes (0..1), so the learner does not suggest the same thing twice in
// other words. Short common words are ignored.
const STOP = new Set('the a an to of and or is are be it in on for with when if not do does this that they them their customer customers agent ai should must any as at by from has have was were will can you your order orders'.split(' '));
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z\u0900-\u097f ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
export function similarity(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  A.forEach((w) => { if (B.has(w)) both++; });
  return both / Math.min(A.size, B.size);
}

// A note that talks about handing the chat to the team only makes sense for a verified customer:
// a visitor is never handed over (owner, 2026-09-30). Used as the default audience on approval.
export function defaultAudience(title: string, body: string): BrainAudience {
  return /\b(?:hand(?:s|ing)?\s*(?:it\s*)?(?:off|over)|escalat\w*|forward\w*\s+(?:it\s+|the request\s+)?to\s+(?:the\s+)?team|pass\w*\s+(?:it\s+)?to\s+(?:the\s+)?team)\b/i.test(`${title} ${body}`) ? 'verified' : 'all';
}
