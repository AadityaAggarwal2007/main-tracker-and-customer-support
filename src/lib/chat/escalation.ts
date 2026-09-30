// ── When the chat must go to a person by itself ────────────────
// SHIPTRACK_MASTER_RULES.md sections 11, 12, 13, 15, 16, 17: a threat or a fraud
// claim, an AI that cannot answer, an AI that keeps repeating itself, and a
// refund / cancellation / payment problem must each end in Needs you, never in
// silence and never in an argument. This file has no imports: the widget message
// route, the email poller and the tests share it.
//
// The detectors are worded to be exact rather than wide: a wrong hit sends a
// chat to a person and tells the customer so, and a common word must not do
// that ("fir" is Hinglish for "then", "duplicate" is a product word, "loot" is a
// sale word). They were checked against realistic English, Hindi and Hinglish
// messages on 2026-09-30 (see the independent review that day).

// ── What the customer wrote ────────────────────────────────────
// 'threat': chargeback, police, court, legal action, a complaint, bad reviews,
// a dispute. 'accusation': fraud, scam, cheating, a fake site.
export type UrgentKind = 'threat' | 'accusation';

const THREAT = [
  /\b(charge ?back|consumer (court|forum|commission|complaint|helpline|care)|police|cyber ?(cell|crime)|legal (action|notice|case|steps?|proceedings?)|legally|lawsuit|sue (you|them|this)|i (will|shall|am going to|'ll) sue|lawyer|advocate|vakil|kanooni|kanoon|trust ?pilot|one star|1 star|reverse (the |my )?payment|block (my|the) (card|payment)|(raise|file|start) (a )?dispute|dispute\b[^.\n]{0,30}\b(bank|card|payment|transaction|charge)|legal (jaunga|jaungi|karunga|karungi|karenge|kar dunga)|(file|lodge|register|raise|make|put in) (a |an )?(formal )?(complaint|case|fir)|complaint (karunga|karungi|karenge|karna|dunga|dungi|denge|kar dunga|kar dungi|karta hoon|karti hoon|karne)|complain (to|against|about you)|i (will|shall|am going to|'ll) complain|(give|leave|post|write|put)\s+(a\s+)?(bad|negative|1 star|one star|1-star)\s+reviews?|(bad|negative)\s+reviews?\s+(dunga|dungi|doonga|denge|likhunga|likhungi)|report (you|your (store|site|website|company|shop|page|business)|this (to|store|site|website|company|fraud|scam)|to (the |a )?(police|bank|consumer|cyber|rbi|authority|authorities))|go(ing)? viral|expose (you|this|your)|(post|put|share|tweet|write)\b[^.\n]{0,40}\b(twitter|instagram|insta|facebook|youtube|social media|everywhere|google reviews?))\b/i,
  /\bFIR\b/,
  // A court of law, not a tennis court or a "court-style" shoe.
  /(?<!tennis |basketball |badminton |football |volleyball |squash |cricket |food )\bcourt\b(?!-)/i,
  /(चार्जबैक|चार्ज बैक|पुलिस|कोर्ट|कानूनी|वकील|उपभोक्ता|साइबर|शिकायत\s*(?:करूँगा|करूंगा|करूँगी|करूंगी|करेंगे))/,
];
const ACCUSATION = [
  /\b(fraud|frauds|fraudster|scam|scammer|scammers|cheat|cheater|cheaters|cheating|cheated|thief|thieves|chor|chors|dhokha|dhoka|dhokebaaz|dhokhebaaz|you loot|loot (rahe|raha|liya|lia|liye)\b|looted (me|us|my)|looting)\b/i,
  /\bfake (site|website|company|store|shop|page|seller|business|brand|order)\b/i,
  /\b(site|website|company|store|shop|page|business|brand|seller)\s+(?:looks?\s+|seems?\s+|is\s+|hai\s+|ye\s+|yeh\s+|lag\s+raha\s+)?(?:a\s+|an\s+)?(fake|fraud|scam)\b/i,
  /(धोखा|धोखेबाज|फ्रॉड|चोर|ठग)/,
];

// A threat wins over an accusation: it needs the more careful answer.
export function urgentKind(text: string | null | undefined): UrgentKind | null {
  const t = String(text || '').slice(0, 2000);
  if (!t.trim()) return null;
  if (THREAT.some((re) => re.test(t))) return 'threat';
  if (ACCUSATION.some((re) => re.test(t))) return 'accusation';
  return null;
}

// ── What the customer is told ──────────────────────────────────
// Hindi in Devanagari, or Hinglish written in Latin letters: one clearly Hindi
// function word is enough ("Cancel kar do", "payment fail ho gaya").
export function looksHinglish(text: string): boolean {
  if (/[ऀ-ॿ]/.test(text)) return true;
  return /\b(?:hai|hain|kya|nahi|nahin|nhi|mera|meri|mere|mujhe|mujhko|bhai|aap|apna|apni|apne|karo|karna|kardo|krdo|kar|karunga|karungi|karenge|karta|karti|hoon|hoga|hogi|ho|hua|hui|hue|gaya|gayi|gaye|gya|bhejo|dena|diya|liya|abhi|kab|kaise|kitna|kaha|kahan|kyun|kyu|paisa|paise|wapas|vapas|chahiye|chahie|chaiye|dijiye|kijiye|batao|jaldi|bilkul|theek|thik|ko|ka|ki|ke|toh|tum|log|lekin|aur|mein|milega|milegi|mila|aaya|aayi|aaye|jaunga|jaungi|dunga|dungi|denge|raha|rahi|rahe|lag)\b/i.test(text);
}

// The team's promised answer time for a threat or a fraud claim: 1 hour
// (master rules sections 15 and 16).
export const URGENT_SLA_HOURS = 1;

// The one line that says a person has it and when they answer.
export function teamWillReplyLine(customerText: string): string {
  return looksHinglish(customerText)
    ? `Hamari team isi chat mein ${URGENT_SLA_HOURS} ghante ke andar aapko jawab degi.`
    : `Our team will reply to you here in this chat within ${URGENT_SLA_HOURS} hour.`;
}

// The whole reply for a threat: no argument, no defence, no AI text at all.
export function urgentAck(customerText: string): string {
  return looksHinglish(customerText)
    ? `Aapko jo pareshani hui, uske liye hamein sach mein afsos hai, aur ye baat hamare liye bahut zaroori hai. Maine ise abhi hamari team ko de diya hai. ${teamWillReplyLine(customerText)}`
    : `I'm really sorry for the trouble, and this matters to us. I've passed it to our team right now. ${teamWillReplyLine(customerText)}`;
}

// When the AI could not answer or keeps repeating itself: a person takes over.
// Plain words, nothing about how the system works (master rules section 40).
export function handoffReply(customerText: string): string {
  return looksHinglish(customerText)
    ? 'Sorry ki aapko wait karna pad raha hai. Maine aapki baat hamari team ko de di hai, team isi chat mein aapko jawab degi.'
    : "Sorry to keep you waiting. I've passed your message to our team, and they will reply to you here in this chat.";
}

// ── Refunds and payment problems (master rules sections 11 and 17) ──
// A refund or cancellation request goes to a person, who answers within 24
// hours; so does a payment problem (failed, or money taken with no order).
// Worked out from the customer's words by code because the model was tested on
// 2026-09-30 and never called escalate_to_human on a first message: it asked
// for the order ID first. "cancel" alone is not enough ("order cancelled hai
// kya?" is a status question), and a question about the policy, a refusal
// ("don't cancel") or thanks for a refund that arrived is not a request.
export type RoutineKind = 'refund' | 'payment';

const REFUND_ASK = [
  /\b(refund|refunds|money ?back|paise (kab )?(wapas|vapas)|paisa (kab )?(wapas|vapas)|pese (kab )?(wapas|vapas)|paise return|return my money|give (me )?my money|cancellation|cancel (my|the|this|our|that) (order|purchase)|cancel (it|this|that)\b|please cancel|(want|need|wish|like) to cancel|cancel (kar|karo|kardo|kar do|krdo|kr do|karde|kar de|karen|kijiye|kijie|karna|krna|karni|karwana|karwani|karvana)|order (ko )?cancel|cancel order)\b/i,
  /(रिफंड|रिफण्ड|पैसे वापस|पैसा वापस|पैसे लौटा|कैंसिल\s*(?:कर|करना|करो|कीजिए|करें|करवा|कराना))/,
];
const NOT_A_REQUEST = [
  /\b(policy|policies|terms|rules?)\b/i,                                            // "what is your refund policy"
  /\b(don'?t|do not|dont|mat|nahi|nhi|na)\s+(?:want to\s+|karo\s+|karna\s+|kariye\s+)?cancel/i,   // "please don't cancel"
  /\b(?:refund|paise|paisa|money)\b[^.?!\n]{0,30}\b(?:aa gaya|mil gaya|mil gya|received|got it|credited|aa gaye)\b/i,   // "refund aa gaya thanks"
  /\b(?:got|received)\s+(?:my\s+|the\s+)?refund\b/i,
];
const PAYMENT_PROBLEM = [
  /\b(payment|paise|paisa|pese|amount|money)\b[^.?!\n]{0,40}\b(fail|failed|fail ho|deduct\w*|kat gaye|kat gaya|kat gya|cut ho|cut gaya|cut gaye|cut gya|debited|stuck|pending|twice|double|order nahi|no order)\b/i,
  /\b(transaction|payment)\s+(failed|fail|declined|unsuccessful|not (done|successful|processed))\b/i,
  /\bpayment\s+(successful|done|success|ho gaya|hogaya)\s+(but|lekin|par|magar)\b/i,
  /\b(deducted|debited|double payment|paid twice|paid (via|by|through|using)?[^.?!\n]{0,20}\bbut\b)/i,
];

export function routineHandOverKind(text: string | null | undefined): RoutineKind | null {
  const t = String(text || '').slice(0, 2000);
  if (!t.trim()) return null;
  if (REFUND_ASK.some((re) => re.test(t)) && !NOT_A_REQUEST.some((re) => re.test(t))) return 'refund';
  if (PAYMENT_PROBLEM.some((re) => re.test(t))) return 'payment';
  return null;
}

export const REFUND_SLA_HOURS = 24;

// Says it is noted and with the team, and when a refund request is answered.
export function routineLine(kind: RoutineKind, customerText: string): string {
  const hi = looksHinglish(customerText);
  if (kind === 'refund') {
    return hi
      ? `Aapki refund ya cancellation ki request maine note kar li hai. Hamari team ${REFUND_SLA_HOURS} ghante ke andar isi chat mein aapko jawab degi.`
      : `I've noted your refund or cancellation request. Our team will reply to you here in this chat within ${REFUND_SLA_HOURS} hours.`;
  }
  return hi
    ? 'Maine ise hamari team ko de diya hai, team isi chat mein aapko jawab degi.'
    : "I've passed this to our team, and they will reply to you here in this chat.";
}

// True when the reply already tells the customer the 24 hours.
export function saysRefundTime(reply: string): boolean {
  return /\b24 ?(hours?|hrs?|ghante|ghanta)\b/i.test(reply);
}

// ── Putting a line into an email reply ─────────────────────────
// An email reply is "Hello, ... Best regards, Vastora Support": a warning above
// the greeting or a promise under the signature reads broken. 'top' goes right
// after the greeting line, 'bottom' right before the sign-off; a text without
// them gets the line at the start / end.
export function insertEmailNote(reply: string, note: string, where: 'top' | 'bottom'): string {
  const lines = reply.split('\n');
  if (where === 'top') {
    const greeting = lines.findIndex((l) => l.trim() !== '');
    if (greeting >= 0 && /^(hi|hello|dear|namaste|hey)\b[^.!?]{0,60}[,!:]?\s*$/i.test(lines[greeting].trim())) {
      lines.splice(greeting + 1, 0, '', note);
      return lines.join('\n');
    }
    return `${note}\n\n${reply}`;
  }
  let signOff = -1;
  lines.forEach((l, i) => { if (/^(best regards|kind regards|warm regards|regards|thanks|thank you|sincerely)[,!.]?\s*$/i.test(l.trim())) signOff = i; });
  if (signOff > 0) {
    lines.splice(signOff, 0, note, '');
    return lines.join('\n');
  }
  return `${reply}\n\n${note}`;
}

// ── The AI repeating itself (master rules section 12) ──────────
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim().split(' ').filter(Boolean);

// Two replies that say the same thing: identical once punctuation and case are
// removed, or sharing at least 90% of their words. Very short replies are never
// counted ("Anything else I can help with?").
export function isRepeatedReply(reply: string, earlier: string[]): boolean {
  const a = words(reply);
  if (a.join(' ').length < 25) return false;
  const setA = new Set(a);
  return earlier.some((prev) => {
    const b = words(prev);
    if (b.join(' ').length < 25) return false;
    const setB = new Set(b);
    let same = 0;
    setA.forEach((w) => { if (setB.has(w)) same++; });
    const union = setA.size + setB.size - same;
    return union > 0 && same / union >= 0.9;
  });
}

// "ok", "thanks a lot", "hello?", "good morning", 👍: a message that needs no
// answer, so an answer that looks like an earlier one is not a loop. Any mix of
// these words and emoji, nothing else.
const COURTESY_WORD = "(?:ok|okay|okk|k|kk|hi+|hello+|hey+|thanks?|thank you|thankyou|thx|ty|noted|fine|done|bye|good (?:morning|afternoon|evening|night)|shukriya|dhanyavad|dhanyawad|dhanyavaad|accha|acha|theek hai|thik hai|ji|jee|hmm+|bhai|sir|madam|ma'?am|so much|a lot|again|very much|a ton|sure|great|nice|cool|welcome)";
const COURTESY = new RegExp(`^\\s*(?:${COURTESY_WORD}[\\s.!,?\\p{Extended_Pictographic}\\u200d\\ufe0f]*)+$`, 'iu');
export function isCourtesyOnly(text: string): boolean {
  const t = text || '';
  return /^[\s\p{Extended_Pictographic}‍️]+$/u.test(t) || COURTESY.test(t);
}
