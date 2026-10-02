// ── Chargeback / dispute advice guard (owner's core rule; added 2026-10-03 from the chat report) ──
// On 1-3 Oct Chikki told three customers whose payment matched no order to raise a chargeback with
// their bank, a UPI dispute or a cybercrime complaint. That is the opposite of the store's first
// rule (no chargeback; every problem is solved in this chat), so such advice never goes out: every
// sentence that advises, offers or describes a chargeback, a bank / UPI / card dispute or
// complaint, a cyber-crime or police report, a consumer forum or a "fraudulent transaction" is
// dropped. ai.ts then hands a verified chat to the team and asks a visitor for the order ID +
// phone (rules 5.6 and 2.9). Pure, no imports (like escalation.ts), so the unit tests load it alone.
// A sentence that only says "please don't raise a dispute" is dropped too: the hand-over covers it,
// and keeping such sentences by a negation check would also keep "no need for police, just raise a
// dispute with your bank".

const EN = [
  String.raw`\bcharge\s*-?\s*backs?\b`,
  String.raw`\bcyber\s*-?\s*(?:crime|cell|police)\b`,
  String.raw`\bconsumer\s+(?:forum|court|complaint|helpline|protection|affairs|commission)\b`,
  String.raw`\bfraudulent\s+(?:transactions?|payments?|charges?)\b`,
  String.raw`\bFIR\b`,
  String.raw`\bpolice\b[^.!?\n]{0,40}\b(?:complaint|report|station|case)\b`,
  String.raw`\b(?:complaint|report|case)\b[^.!?\n]{0,40}\bpolice\b`,
  // A dispute raised / filed, in English or Hinglish word order.
  String.raw`\bdisputes?\b[^.!?\n]{0,40}\b(?:raise|rais\w+|file|fil\w+|lodge|lodg\w+|initiate|open|register|karein|karen|kare|karo|karwa\w*|kar\s+sakt\w*|kijiye|kariye|kar\s+do|hoga|hogi|ho\s+jayega)\b`,
  String.raw`\b(?:raise|rais\w+|file|fil\w+|lodge|lodg\w+|initiate|initiat\w+|open|opening|register|registering)\b[^.!?\n]{0,40}\bdisputes?\b`,
  // A complaint with, or a reversal from, the bank / UPI app / card issuer / ombudsman.
  String.raw`\bcomplaints?\b[^.!?\n]{0,40}\b(?:bank|upi|gpay|google\s*pay|phonepe|paytm|bhim|card\s+issuer|npci|rbi|ombudsman)\b`,
  String.raw`\b(?:bank|upi|gpay|google\s*pay|phonepe|paytm|bhim|npci|rbi|ombudsman)\b[^.!?\n]{0,40}\b(?:complaint|dispute|chargeback|reversal)\b`,
  // "go to / contact your bank to get the money back".
  String.raw`\b(?:contact|call|visit|approach|go\s+to|jaa?iye|jaa?kar|jakar|jao|jaana|jaa?yein)\b[^.!?\n]{0,25}\bbank\b[^.!?\n]{0,60}\b(?:money|paise|paisa|amount|refund|reverse|wapas|recover)`,
];
const HI = [
  'चार्ज\\s*बैक', 'साइबर', 'पुलिस', 'एफ\\s*\\.?\\s*आई\\s*\\.?\\s*आर', 'डिस्प्यूट', 'धोखाधड़ी\\s*(?:वाला|का)?\\s*(?:लेन-?देन|ट्रांज़?ैक्शन)',
  'उपभोक्ता\\s*(?:फोरम|फ़ोरम|अदालत|मंच|आयोग)', 'शिकायत[^.!?\\n।]{0,30}बैंक', 'बैंक[^.!?\\n।]{0,30}शिकायत',
];
export const DISPUTE_ADVICE_RE = new RegExp([...EN, ...HI].join('|'), 'i');

const SENTENCE_SPLIT = /(?<=[.!?।])\s+/;

export function mentionsDispute(text: string): boolean {
  return DISPUTE_ADVICE_RE.test(text || '');
}

// Every sentence (per line, split after . ! ? ।) that advises a dispute is dropped. A line that had
// text and lost all of it is dropped; blank lines that were there stay (3+ newlines become 2).
// emptied = nothing was left: the caller sends its own fixed line instead (never an empty reply).
// Unchanged text is returned as it was, byte for byte.
export function dropDisputeAdvice(reply: string): { text: string; changed: boolean; emptied: boolean } {
  const input = reply || '';
  if (!mentionsDispute(input)) return { text: input, changed: false, emptied: false };
  const lines: string[] = [];
  let dropped = 0;
  for (const line of input.split('\n')) {
    if (!line.trim() || !mentionsDispute(line)) { lines.push(line); continue; }
    const parts = line.split(SENTENCE_SPLIT).filter((s) => s.trim());
    const kept = parts.filter((s) => !mentionsDispute(s));
    dropped += parts.length - kept.length;
    if (kept.length) lines.push(kept.join(' '));
  }
  if (!dropped) return { text: input, changed: false, emptied: false };
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, changed: true, emptied: !text };
}
