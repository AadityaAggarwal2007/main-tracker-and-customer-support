// ── The Brain (owner, 2026-10-01) ─────────────────────────────────────────────
// Notes the owner keeps in Panel Settings (table brain_notes, chat-brain.sql). The AI is
// shown only the ones that fit the customer's message: every `always` note, plus the notes
// whose topics appear in what the customer just wrote. That keeps the prompt short and lets
// the owner teach the agent something new without a deploy. No imports: pure, tested offline.

export type BrainKind = 'rule' | 'fact' | 'lesson';

export interface BrainNote {
  id?: string;
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
export function selectNotes(notes: BrainNote[], text: string, budget = BRAIN_CHAR_BUDGET, max = BRAIN_MAX_NOTES): BrainNote[] {
  const wanted = new Set(topicsIn(text));
  const scored = notes
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
