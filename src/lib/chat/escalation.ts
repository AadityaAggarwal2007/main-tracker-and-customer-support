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
  // Owner 2026-10-02 (a chat of that afternoon: "I have raised the complaint against u in consumer department"
  // was not caught): a consumer / formal complaint against the store, a bank dispute, a case, a legal
  // notice or the police in more words. Added only: every line above is unchanged. refund-threat.ts
  // (a chat to Refund by itself) finds the same threats and is stricter, so everything that can move a
  // chat to Refund is a threat here too (unit.js checks it on every example). Worded like the lines
  // above, exact rather than wide: a lower-case "fir" only in an FIR phrase ("fir darj", "lodge an
  // fir"), "please reverse the payment" is a refund request (not here; "bank se reverse karwa dungi" is),
  // no "polis" alone ("nail polis"), no "थाना" alone (an address line), no "cyber security".
  // Review fix 2026-10-02: "khilaf" only with the store as the target ("aapke khilaf complaint", never "delivery
  // boy ke khilaf"); "legal karwai nahi karni" is not a threat; "attorney" only in a threat phrase ("power of
  // attorney" is not); "bank se paise wapas ..." only with the customer's own threat verb ("... le lungi"),
  // never the question "bank se paise wapas kab aayenge?"; "case file karo" asks the store (no bare "file").
  /\b(charge-back|chargebak|chargback|consumer\s*(department|dept|cell|affairs|protection|case|portal|grievance|redressal|ministry|adalat)s?|national consumer|e-?\s?daa?khil|grahak (adalat|suraksha|nyayalaya|forum|court|ayog|aayog)|ingram portal|(complain\w*|case|report\w*|shikayat|legal action|action)\s+(against|agaisnt|agianst|aganist)\s+(you|u|yu|you (guys|people|all)|(your|ur|this|the) (company|store|site|website|shop|seller|brand|page|team|business)|vastora)|consumer\b[^.?!\n]{0,40}\b(complain\w*|case|shikayat|report\w*|notice)|(complain\w*|case|shikayat|report\w*)\b[^.?!\n]{0,40}\bconsumer|(aap|aapke|aapki|aapka|apke|apki|apka|tum|tumhare|tumhari|tumhara|tere|teri|tera|is company|iss company|is store|vastora)\s+(\w+\s+){0,2}(khilaf|khilaaf)\b[^.?!\n]{0,30}\b(complain\w*|case|shikayat|report\w*|kesh)|(complain\w*|case|shikayat|report\w*)\b[^.?!\n]{0,30}\b(aap|aapke|aapki|aapka|apke|apki|apka|tum|tumhare|tumhari|tumhara|tere|teri|tera|is company|iss company|is store|vastora)\s+(\w+\s+)?(khilaf|khilaaf)|dispute\s+(raise|file|daal|dal|kar|open|lodge)\w*|(daal\w*|dal\w*|put|open|lodge)\s+(a\s+)?dispute|(ask|asked|tell|told|request|requested|get|got)\s+(my\s+|the\s+)?bank\s+(to\s+)?(\w+\s+){0,3}revers\w*|bank\s+(se|say|sy|ke\s+through|dwara|ke\s+zariye)\s+(\w+\s+){0,3}revers\w*|revers\w*\s+(karwa|karva|krwa|krva)(unga|ungi|enge|oonga|oongi|\s+(dunga|dungi|denge|lunga|lungi|lenge))|i\s*(will|'ll|shall|am\s+going\s+to|'m\s+going\s+to|m\s+going\s+to)\s+(get\s+|have\s+)?((the|my|this|that|it|payment|transaction|amount|money|paisa|paise)\s+){0,2}revers(e|ed)|(bank|rbi|npci|banking ombudsman|card company|credit card|debit card)\s+(me|mein|main|ko|se|pe|par|to|with|in)?\s*(complain\w*|shikayat|dispute|report\s+kar\w*)|(complain\w*|shikayat|report\w*)\s+(to|with|in|at|me|mein|ko)\s+(my\s+|the\s+|apne\s+)?(bank|rbi|npci)|bank\s+(se|say|sy)\s+(mere\s+|apne\s+)?(paise|paisa|pese|money|refund|amount)\s+(wapas|vapas|back)\s+(le\s*(lunga|lungi|lenge)|(karwa|karva|krwa|nikalwa|nikalva|mangwa|mangva)\s*(lunga|lungi|lenge|dunga|dungi|denge)|(karwa|karva|nikalwa|mangwa)(unga|ungi|oonga|oongi|enge|yenge))|(complain\w*|shikayat|report\w*)\b[^.?!\n]{0,30}\b(pmo|cpgrams|pg\s?portal|ministry|government|govt|sarkar|authority|authorities)|legal(ly)?\s+(matter|route|recourse|karwai|karyawahi|kar\w*|lunga|lungi|lenge|proceed|deal|aage)(?!\s+(nahi|nhi|nahin|nai|mat)\s+(\w+\s+)?(lena|leni|lunga|lungi|lenge|karunga|karungi|karenge|karna|karni|karte|karti|krunga|krungi|chahta|chahti|chahte|chahiye|bhejna|bhejni|jaunga|jaungi|jana|jaana)\b)|suing|lawsuits|sue\s+(u|your|ur|the company|vastora)|(my|our|through|via|consult|hire|contact)\s+(an?\s+)?attorney|attorney\s+(se|ko|will|ke\s+through|ke\s+zariye|dwara)|attorney[^.?!\n]{0,40}\b(notice|sue|court|legal)|vakeel|wakil|wakeel|case\s+(karunga|karungi|karenge|kar\s+dunga|kar\s+dungi|kar\s+denge|darj|lagaunga|lagaungi|thok\w*|daal\s*(dunga|dungi|denge)|daalunga|daalungi|dalunga|dalungi)|(file|lodge|register|darj)\s+(a\s+)?case|notice\s+(bhejunga|bhejungi|bhejenge|bhej\s+dunga|bhej\s+dungi|bhej\s+denge|bhijwa\w*|send\s+kar\w*|serve)|(send|serve|issue)\s+((you|u)\s+(a\s+|an\s+)?(legal\s+)?|(a\s+|an\s+)?legal\s+)notice|kanoo?ni|pulis|polis\s+(me|mein|ko|se|complaint|case|station|thana|report|jaunga|jaungi)|f\.\s?i\.\s?r|fir\s+(darj|lodge|lodged|registered|filed)|(lodge|lodged|lodging)\s+(an?\s+|the\s+|my\s+)?fir|an\s+fir|than[ae]\s+(me\s+|mein\s+|main\s+|pe\s+|par\s+)?(complaint|complain|report|shikayat|case|rapat|riport)\w*|cyber\s*(police|complaint|dept|department|thana|cel)|cybercrime\w*|cyber\b[^.?!\n]{0,20}\b(complain\w*|report\w*|shikayat))\b/i,
  /\bNCH\b/,
  /((आपके|आपकी|तुम्हारे|तुम्हारी|इस\s*कंपनी\s*के|कंपनी\s*के)\s*(खिलाफ|ख़िलाफ़)[^।.?!\n]{0,30}(शिकायत|केस|रिपोर्ट)|(शिकायत|केस)[^।.?!\n]{0,30}(आपके|आपकी|तुम्हारे|तुम्हारी)\s*(खिलाफ|ख़िलाफ़)|अदालत|न्यायालय|मुक़?दमा|लीगल\s*नोटिस|एफ़?आईआर|थाने\s*में\s*(शिकायत|रिपोर्ट|केस|रपट|एफ़?आईआर|जा)|कंज्यूमर\s*(फोरम|फ़ोरम|अदालत|कोर्ट|आयोग|हेल्पलाइन|शिकायत|केस|विभाग|न्यायालय)|ग्राहक\s*(अदालत|फोरम|फ़ोरम|आयोग)|बैंक\s*(में|को|से)?\s*(शिकायत|डिस्प्यूट)|केस\s*(करूँगा|करूंगा|करूँगी|करूंगी|करेंगे|दर्ज))/,
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

// ── Night (owner, 2026-10-01, decision 1) ──────────────────────
// The team works 10:00-19:30 IST, every day. A customer told "within 1 hour" at
// 22:00 waits all night for a promise that was broken the moment it was made, so
// from 19:30 to 10:00 the 1-hour and 24-hour lines say the team replies in the
// morning, after 10 AM, instead. 'tomorrow' from 19:30 to midnight, 'this_morning'
// from midnight to 10:00 (a customer writing at 1 AM is not told "kal"). null =
// office hours: every line is exactly what it was before. The value comes from
// afterHours() in src/lib/office-hours.ts; the type is repeated here so this file
// keeps no imports. Lines that promise no time (handoffReply, the payment line)
// are the same day and night.
// The week (owner 2026-10-05): Saturday is a half day (to 14:00), Sunday and the listed
// holidays are off, so the team may be back only "on Monday morning" (or Tuesday after a
// Monday holiday): afterHours then gives the weekday's name, and the line says that day.
export type AfterHours = 'tomorrow' | 'this_morning' | 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | null;
const DAY_EN = { sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday' } as const;
const MORNING: Record<Exclude<AfterHours, null>, { en: string; hi: string }> = {
  tomorrow: { en: 'tomorrow morning, after 10 AM', hi: 'kal subah 10 baje ke baad' },
  this_morning: { en: 'this morning, after 10 AM', hi: 'aaj subah 10 baje ke baad' },
  sunday: { en: 'on Sunday morning, after 10 AM', hi: 'Sunday subah 10 baje ke baad' },
  monday: { en: 'on Monday morning, after 10 AM', hi: 'Monday subah 10 baje ke baad' },
  tuesday: { en: 'on Tuesday morning, after 10 AM', hi: 'Tuesday subah 10 baje ke baad' },
  wednesday: { en: 'on Wednesday morning, after 10 AM', hi: 'Wednesday subah 10 baje ke baad' },
  thursday: { en: 'on Thursday morning, after 10 AM', hi: 'Thursday subah 10 baje ke baad' },
  friday: { en: 'on Friday morning, after 10 AM', hi: 'Friday subah 10 baje ke baad' },
  saturday: { en: 'on Saturday morning, after 10 AM', hi: 'Saturday subah 10 baje ke baad' },
};
// "tomorrow morning, after 10 AM" / "on Monday morning, after 10 AM" (and the Hinglish one), for
// other fixed texts that name when the team is back (closed-hours.ts).
export function teamBackWhen(after: Exclude<AfterHours, null>, hinglish: boolean): string {
  return hinglish ? MORNING[after].hi : MORNING[after].en;
}
export function weekdayLabel(after: AfterHours): string | null {
  return after && after in DAY_EN ? DAY_EN[after as keyof typeof DAY_EN] : null;
}

// The one line that says a person has it and when they answer.
export function teamWillReplyLine(customerText: string, after: AfterHours = null): string {
  if (after) {
    return looksHinglish(customerText)
      ? `Hamari team ${MORNING[after].hi} isi chat mein aapko jawab degi.`
      : `Our team will reply to you here in this chat ${MORNING[after].en}.`;
  }
  return looksHinglish(customerText)
    ? `Hamari team isi chat mein ${URGENT_SLA_HOURS} ghante ke andar aapko jawab degi.`
    : `Our team will reply to you here in this chat within ${URGENT_SLA_HOURS} hour.`;
}

// The whole reply for a threat: no argument, no defence, no AI text at all.
export function urgentAck(customerText: string, after: AfterHours = null): string {
  return looksHinglish(customerText)
    ? `Aapko jo pareshani hui, uske liye hamein sach mein afsos hai, aur ye baat hamare liye bahut zaroori hai. Maine ise abhi hamari team ko de diya hai. ${teamWillReplyLine(customerText, after)}`
    : `I'm really sorry for the trouble, and this matters to us. I've passed it to our team right now. ${teamWillReplyLine(customerText, after)}`;
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

// Says it is noted and with the team, and when a refund request is answered
// (at night: in the morning, after 10 AM; see AfterHours above).
export function routineLine(kind: RoutineKind, customerText: string, after: AfterHours = null): string {
  const hi = looksHinglish(customerText);
  if (kind === 'refund') {
    if (after) {
      return hi
        ? `Aapki refund ya cancellation ki request maine note kar li hai. Hamari team ${MORNING[after].hi} isi chat mein aapko jawab degi.`
        : `I've noted your refund or cancellation request. Our team will reply to you here in this chat ${MORNING[after].en}.`;
    }
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

// ── The AI's own hour promises, at night ───────────────────────
// The prompt still asks the model to say "within 1 hour" / "within 24 hours" when
// it hands over, and it does not know the time of day. At night such a sentence
// would sit right above the "after 10 AM" line and contradict it, so on a
// hand-over reply sent at night it is taken out. A sentence goes only when it has
// BOTH an hour amount and a word about the team answering: "shipped 24 hours ago",
// "open 24/7" or a tracking link stay. Sentences end at . ! ? or । followed by a
// space or the end, or at a line break, so "shiptrack.store" and "2.5" are not
// cut. Pure; the rest of the text is kept exactly as it was.
const HOUR_AMOUNT = /\b(?:\d{1,2}(?:\s*(?:-|to)\s*\d{1,2})?|one|an|ek|twenty[\s-]?four)\s*(?:hours?|hrs?|ghante|ghanta|ghanton)\b|(?:\d{1,2}|एक|चौबीस)\s*घंट/i;
const TEAM_ANSWERS = /\b(?:team|reply|replies|respond|get back|revert|jawab|answer|update|review|look into|contact|reach out)\b|टीम|जवाब/i;
const promisesHours = (sentence: string) => HOUR_AMOUNT.test(sentence) && TEAM_ANSWERS.test(sentence);

// One line cut into sentences, each with its ending and the spaces after it, so
// joining the pieces gives the line back exactly.
function sentencesOf(line: string): string[] {
  const out: string[] = [];
  const end = /[.!?।]+(?=\s|$)\s*/g;
  let start = 0;
  for (let m = end.exec(line); m; m = end.exec(line)) {
    out.push(line.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  if (start < line.length) out.push(line.slice(start));
  return out;
}

// `empty`: every sentence was a promise, nothing would be left.
function dropHourPromises(text: string): { text: string; removed: boolean; empty: boolean } {
  let removed = false;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const pieces = sentencesOf(line);
    const kept = pieces.filter((x) => !promisesHours(x));
    if (kept.length === pieces.length) { lines.push(line); continue; }
    removed = true;
    const rest = kept.join('').trimEnd();
    if (rest.trim()) lines.push(rest);          // a line that held only the promise goes away
  }
  if (!removed) return { text, removed: false, empty: false };
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '').trimEnd();
  return out.trim() ? { text: out, removed: true, empty: false } : { text, removed: false, empty: true };
}

// The reply without its hour promises. Never empty: when nothing would be left
// the original comes back (removed = false).
export function dropReplyTimes(text: string): { text: string; removed: boolean } {
  const r = dropHourPromises(String(text ?? ''));
  return { text: r.text, removed: r.removed };
}

// The hand-over line under an AI reply in the chat widget (master rules 11, 15, 16,
// 17). By day (after = null) it is exactly what the widget route added before the
// night line: the 1-hour line after a fraud claim, the 24-hour line after a refund
// request unless the AI already said 24 hours, the payment line, and nothing on an
// escalation (the AI or a guard already said the team replies). At night the AI's
// own hour promises are taken out first and the morning line goes in; an escalation
// gets the morning line only when a promise was taken out, so a guard's fixed
// hand-over text (lookup-guard.ts HAND_OVER, which promises no time) is never
// changed: the guard finds its own hand-over again by an exact match. Running it
// twice adds the line once: the morning line has no hour amount.
export function withHandOverLine(
  text: string,
  said: string,
  kind: 'accusation' | RoutineKind | 'escalated',
  after: AfterHours = null,
): string {
  if (!after) {
    if (kind === 'accusation') return `${text}\n\n${teamWillReplyLine(said)}`;
    if (kind === 'refund') return !saysRefundTime(text) ? `${text}\n\n${routineLine('refund', said)}` : text;
    if (kind === 'payment') return `${text}\n\n${routineLine('payment', said)}`;
    return text;
  }
  const d = dropHourPromises(text);
  const line = kind === 'refund' || kind === 'payment' ? routineLine(kind, said, after) : teamWillReplyLine(said, after);
  if (kind === 'escalated' && !d.removed && !d.empty) return text;
  // Only promises in the reply: the morning line alone, never a contradiction.
  return d.empty ? line : `${d.text}\n\n${line}`;
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
