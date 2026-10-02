// ── Fake / invalid tracking claims: the pure part (owner, 2026-10-02) ──────────────────
// Owner, 09:50 IST: a customer who says "Valmo website shows tracking id invalid", that the
// tracking link is fake, shows someone else's order, does not open, or has not moved for days,
// gets a fixed new-link promise and the chat goes to Ship again by itself ("humara core ki
// chargeback nai ana dena"). This file holds what needs no database: the detector, the stage
// of the order, the language, the fixed texts and the follow-up decision in a Ship again chat.
// The server side (state reads, the auto mark, the red flag) is case-auto.ts; the widget route
// (src/app/api/widget/message/route.ts) calls it. The inbox imports AUTO_MARK_NAME from here,
// so this file stays pure: only escalation.ts and journey.ts, both without database access.
//
// The texts never name the courier, never promise today / tonight / tomorrow, and are never
// passed through withHandOverLine / dropReplyTimes: "24-48 hours" is the new link, not the
// team's reply time, so they are the same day and night. Tested in scripts/ai-tests/unit.js
// (41 messages that must match, 49 that must not) and team-routing.js R24-R41.
import { DELIVERED_INDEX, JOURNEY } from '@/lib/journey';
import { isCourtesyOnly, looksHinglish, routineLine, type RoutineKind, type UrgentKind } from './escalation';

// Who shows as the marker of Chikki's own Ship again marks (case_marked_by, chat_case_events.actor).
// Staff screens only: the customer only ever meets "Vastora Support".
export const AUTO_MARK_NAME = 'Chikki (auto)';

// ── 1. The detector ───────────────────────────────────────────────────────────────────
// Words that make the sentence about the tracking. 'tr[ae]?c?k\w*' covers track, tracking,
// trecking, traking, trackig, trek, trk. Devanagari has no \b, so it is matched without it.
const TRACK = String.raw`(?:tr[ae]?c?k\w*|tracing|awb|consignment|docket|valmo|volmo|walmo)`;
const CTX_EN = String.raw`(?:tr[ae]?c?k\w*|tracing|awb|consignment|docket|valmo|volmo|walmo|status|link|url)`;
const CTX_HI = String.raw`(?:ट्रैक|ट्रेक|वाल्मो|लिंक|स्टेटस)`;
// (a) invalid / not found / wrong
const INVALID = String.raw`(?:invalid|in-valid|not valid|not found|no (?:record|records|data|result|results|details?|info(?:rmation)?) (?:found|available)|does ?n[o']?t exist|not exist\w*|no such|incorrect|wrong|galat|galt|glat|error|unable to track|can'?t track|cannot track|could ?n[o']?t (?:be )?track\w*|not (?:registered|recogni[sz]ed))`;
const SEE = String.raw`(?:not (?:showing|show(?:n|s)?|available|visible|found)|no record\w*|(?:nahi|nahin|nhi|nai) (?:dikh|dikha|dikhai|show|exist)\w*|(?:dikh|show|exist) (?:nahi|nhi|nai) (?:raha|rha|rahi|rhi|ho|hota|hoti|karta|karti|kar)\w*)`;
const GET = String.raw`(?:(?:nahi|nahin|nhi|nai) (?:mil (?:raha|rha|rahi|rhi)|milta|milti)|mil (?:nahi|nhi|nai) (?:raha|rha|rahi|rhi))`;
const COURIER_SITE = /\b(?:valmo|volmo|walmo|courier (?:site|website|app|page|portal))\b|वाल्मो/i;
const OBJ_SEE = String.raw`(?:id|number|no|awb|tr[ae]?c?k\w*|order|parcel|shipment|details?|record)`;
const OBJ_GET = String.raw`(?:id|number|no|awb|tr[ae]?c?k\w*|details?)`;
const ANY_SITE = String.raw`(?:website|site|app|portal)`;
// (b) fake / another order / does not work. 'fraud' is NOT here: "fraud hai, tracking link kahan
// hai?" is a fraud claim plus a question, which stays the fraud path (escalation.ts).
const FAKE = String.raw`(?:fake|farzi|farji|nakli|nakali|jhoot\w*|jhut\w*|bogus|dummy|made[- ]up|fabricated)`;
const ANOTHER = String.raw`(?:someone else'?s?|somebody else'?s?|kisi (?:aur|or|dusre|doosre) (?:ka|ki|ke)|dusre (?:ka|ki|ke)|doosre (?:ka|ki|ke)|(?:another|other|different) (?:person|customer|name|order|parcel|address)(?:'?s)?)`;
const SHOW = String.raw`(?:show\w*|dikh\w*|aa (?:raha|rha|rahi|rhi)|open\w*|khul\w*)`;
const BROKEN = String.raw`(?:not (?:working|opening|open|loading|load)|does ?n'?t (?:work|open|load)|is ?n'?t (?:working|opening)|won'?t (?:open|load)|broken|expired|404|page not found|ka?am (?:nahi|nhi|nai) (?:kar|kr)\w*|(?:nahi|nhi|nai) (?:khul|chal|open|load)\w*|(?:khul|chal|open|load) (?:nahi|nhi|nai)\w*)`;
// (c) not updating for days
const STUCK_CTX = String.raw`(?:tr[ae]?c?k\w*|tracing|awb|valmo|volmo|walmo|status|location|jagah|jagha|hub)`;
const STUCK = String.raw`(?:not (?:updat\w*|moving|moved|changing|changed|progress\w*)|no (?:update|updates|movement|progress)|stuck|atka\w*|atak\w*|ruka\w*|ruk (?:gaya|gya|gayi|gyi)|updat\w* (?:nahi|nhi|nai)\w*|(?:nahi|nhi|nai) updat\w*|aage (?:nahi|nhi|nai) (?:badh|badha|gaya|gya|ja)\w*|move (?:nahi|nhi|nai)\w*|hil (?:nahi|nhi|nai)\w*|same|wahi|wohi|vahi)`;
const SAME_PLACE = String.raw`(?:(?:same|ek hi|wahi|wohi|usi|vahi) (?:jagah|jagha|location|status|stage|city|hub|place))`;

const W = '[^.?!\\n।]{0,50}';          // the two words within 50 characters of one sentence
const near = (a: string, b: string) => new RegExp(`(?:\\b${a}\\b${W}\\b${b}\\b|\\b${b}\\b${W}\\b${a}\\b)`, 'i');
const nearHi = (a: string, b: string) => new RegExp(`(?:${a}${W}${b}|${b}${W}${a})`, 'i');

// Taken out before matching: the claim is about something else (coupon, OTP, payment link,
// address, "wrong product" ...), so "coupon invalid" or "wrong size, tracking says delivered"
// never count.
const NOT_TRACK = [
  /\b(?:coupon|promo|discount|voucher|otp|upi|card|payment|pay|password|email|e-mail|mobile|phone|pin ?code|pincode|address|naam|name|size|colou?r|product|item|refund|cod|offer|insta\w*|whatsapp|facebook|review)\s+(?:code |number |no\.? |id |link |status )?(?:is |hai |bhi )?(?:invalid|wrong|galat|incorrect|error|fake|not working|nahi chal\w*|kaam nahi\w*)/gi,
  /\b(?:wrong|galat|incorrect|fake|nakli|duplicate)\s+(?:product|item|size|colou?r|address|piece|saree|kurti|dress|shirt|pant|order|parcel|maal|saman|samaan|cheez)\b/gi,
  /\b(?:payment|pay|upi|razorpay|paytm|product|item|website|store|shop|insta\w*|whatsapp|facebook|offer|sale|coupon|refund|return|exchange|review|checkout)\s+(?:ka |ki |ke )?(?:link|url|status)\b/gi,
];
const HAS_TRACK = new RegExp(`\\b${TRACK}\\b|ट्रैक|ट्रेक|वाल्मो`, 'i');

export type TrackingClaim = 'invalid' | 'fake' | 'stuck';

const RULES: Record<TrackingClaim, RegExp[]> = {
  fake: [
    near(CTX_EN, FAKE), near(CTX_EN, `${ANOTHER}[^.?!\\n]{0,30}${SHOW}`), near(CTX_EN, `${SHOW}[^.?!\\n]{0,30}${ANOTHER}`), near(CTX_EN, BROKEN),
    nearHi(CTX_HI, '(?:फर्जी|फ़र्ज़ी|नकली|फेक|झूठ|किसी और का|दूसरे का|नहीं खुल|नहीं चल|काम नहीं|खुल नहीं|चल नहीं)'),
  ],
  invalid: [near(CTX_EN, INVALID), nearHi(CTX_HI, '(?:गलत|ग़लत|इनवैलिड|इनवेलिड|नहीं (?:दिख|मिल) रह|मौजूद नहीं)')],
  stuck: [
    near(STUCK_CTX, STUCK), new RegExp(`\\b${SAME_PLACE}\\b`, 'i'), nearHi(CTX_HI, '(?:अपडेट नहीं|अटक|रुका|रुक गय|आगे नहीं)'),
    /(?:एक ही जगह|वहीं (?:पर|पे) )/,
  ],
};
const courierSee = near(OBJ_SEE, `(?:${SEE}|${INVALID})`);
const courierGet = near(OBJ_GET, GET);
const siteSee = near(ANY_SITE, SEE);

// The kind of claim in one customer message, or null. Asking for the link ("tracking link
// bhejo"), a delay question with no tracking word ("order stuck hai"), "delivered dikha raha hai
// par mila nahi" and a plain fraud claim are NOT claims: they keep their own paths.
export function trackingClaimKind(text: string | null | undefined): TrackingClaim | null {
  let t = String(text || '').slice(0, 2000);
  if (!t.trim()) return null;
  for (const re of NOT_TRACK) t = t.replace(re, ' ');
  for (const k of ['fake', 'invalid', 'stuck'] as const) if (RULES[k].some((re) => re.test(t))) return k;
  if (COURIER_SITE.test(t) && (courierSee.test(t) || courierGet.test(t))) return 'invalid';
  if (HAS_TRACK.test(t) && siteSee.test(t)) return 'invalid';
  return null;
}

// A tracking word at all (for the route's "tracking words, no claim" log line, spec 1.5).
export function mentionsTracking(text: string | null | undefined): boolean {
  return HAS_TRACK.test(String(text || '').slice(0, 2000));
}

// ── 1.6 Another order than the verified one ───────────────────────────────────────────
// True when the claim may be about another order: the message names an order number (4-6
// digits; a 10-digit phone never matches) other than the verified one, or this turn's lookup
// found orders and none is the verified one (a chat keeps its first verified order).
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
export function mentionsOtherOrder(said: string | null | undefined, verifiedOrderId: string | null | undefined, toolResult: string | null | undefined): boolean {
  const mine = digits(verifiedOrderId);
  const typed = String(said || '').slice(0, 2000).match(/#?\b\d{4,6}\b/g) || [];
  if (typed.some((n) => digits(n) !== mine)) return true;
  if (!toolResult) return false;
  try {
    const r = JSON.parse(toolResult) as { found?: unknown; orders?: unknown };
    if (!r || r.found !== true || !Array.isArray(r.orders) || !r.orders.length) return false;
    return !r.orders.some((o) => digits((o as { order_id?: unknown } | null)?.order_id) === mine);
  } catch {
    return false;
  }
}

// ── 2.1 Where the order is ────────────────────────────────────────────────────────────
// The tracking page's stage (orders.ts toFoundOrder): Order Placed / Processing / Packed = not
// dispatched; Shipped .. Out for Delivery = in transit; Delivered (only the team sets it);
// anything else (cancelled, RTO, an exception, unknown) = other.
export type ClaimStage = 'pre_dispatch' | 'in_transit' | 'delivered' | 'other';
export function claimStage(o: { status: string | null; cancelled?: boolean | null } | null | undefined): ClaimStage {
  if (!o || o.cancelled) return 'other';
  const i = JOURNEY.findIndex((s) => s.status === o.status);
  if (i < 0) return 'other';
  if (i <= 2) return 'pre_dispatch';
  if (i === DELIVERED_INDEX) return 'delivered';
  return 'in_transit';
}

// ── 2.3 The language and the fixed texts ──────────────────────────────────────────────
// Hindi when any message has a Devanagari letter (not its digits), Hinglish when any looks
// Hinglish, else English: read over the claim message and the customer's last few messages,
// like lookup-guard.ts replyLanguage.
export type ClaimLang = 'en' | 'hinglish' | 'hi';
const DEVANAGARI = /[ऀ-॥॰-ॿ]/;
export function claimLang(texts: Array<string | null | undefined>): ClaimLang {
  const all = texts.map((t) => String(t || ''));
  if (all.some((t) => DEVANAGARI.test(t))) return 'hi';
  if (all.some((t) => looksHinglish(t))) return 'hinglish';
  return 'en';
}

// A. The promise (owner's answer 1; the Hinglish keeps his own words).
const PROMISE: Record<ClaimLang, string> = {
  hinglish: 'Pareshani ke liye sorry. Aapke order ka naya tracking link 24-48 ghante me isi chat me bhej denge.',
  en: 'Sorry for the trouble. We will send a new tracking link for your order here in this chat within 24-48 hours.',
  hi: 'परेशानी के लिए माफ़ी चाहते हैं। आपके ऑर्डर का नया ट्रैकिंग लिंक 24-48 घंटे में इसी चैट में भेज देंगे।',
};
// B. The reminder in a Chikki-marked chat (answer 4): no new promise.
const REMINDER: Record<ClaimLang, string> = {
  hinglish: 'Hamari team aapka naya tracking link bana rahi hai, 24-48 ghante me yahin isi chat me milega.',
  en: 'Our team is preparing your new tracking link, and you will get it right here in this chat within 24-48 hours.',
  hi: 'हमारी टीम आपका नया ट्रैकिंग लिंक बना रही है, 24-48 घंटे में यहीं इसी चैट में मिलेगा।',
};
// C. Not dispatched yet (answer 6). Never says the ST tracking ID works on the courier's site.
const PRE_DISPATCH: Record<ClaimLang, [string, string]> = {
  hinglish: ['Aapka order abhi dispatch nahi hua hai, isliye courier ki website par abhi ye nahi dikhega. Courier ki tracking dispatch ke baad shuru hoti hai.', 'Aap apna order yahan dekh sakte hain:'],
  en: ["Your order has not been dispatched yet, so the courier's website will not show it for now. Courier tracking starts once the order is dispatched.", 'You can follow your order here:'],
  hi: ['आपका ऑर्डर अभी डिस्पैच नहीं हुआ है, इसलिए कूरियर की वेबसाइट पर यह अभी नहीं दिखेगा। कूरियर की ट्रैकिंग डिस्पैच के बाद शुरू होती है।', 'आप अपना ऑर्डर यहाँ देख सकते हैं:'],
};
// D. Delivered -> the team (answer 7): no hours, never argues that it shows delivered.
const DELIVERED: Record<ClaimLang, string> = {
  hinglish: 'Iske liye hamein sach mein afsos hai. Maine ise abhi hamari team ko de diya hai, team isi chat mein aapko jawab degi.',
  en: "I'm really sorry about this. I've passed it to our team right now, and they will reply to you here in this chat.",
  hi: 'इसके लिए हमें सच में अफ़सोस है। मैंने इसे अभी हमारी टीम को दे दिया है, टीम इसी चैट में आपको जवाब देगी।',
};
// E. The team has it, no hours: escalation.ts's payment line word for word, Hindi added.
const TEAM_HAS_IT_HI = 'मैंने इसे हमारी टीम को दे दिया है, टीम इसी चैट में आपको जवाब देगी।';

export function promiseReply(lang: ClaimLang): string { return PROMISE[lang] ?? PROMISE.en; }
export function reminderReply(lang: ClaimLang): string { return REMINDER[lang] ?? REMINDER.en; }
// The reminder's first words in each language. case-auto.ts looks for them in the AI messages since
// the mark, so "the one reminder was sent" does not depend on the language it went out in, nor on a
// red line after it or a sensitive-data warning before it.
export const REMINDER_HEADS: readonly string[] = Object.values(REMINDER).map((t) => t.split(',')[0]);
// The tracking link goes last, on its own line, with nothing after it (ai.ts link rule); with
// no link the last sentence is left out.
export function preDispatchReply(lang: ClaimLang, link: string | null | undefined): string {
  const [text, here] = PRE_DISPATCH[lang] ?? PRE_DISPATCH.en;
  const url = String(link || '').trim();
  return url ? `${text} ${here}\n${url}` : text;
}
export function deliveredReply(lang: ClaimLang): string { return DELIVERED[lang] ?? DELIVERED.en; }
// `said` is the message that carried the claim: routineLine picks Hinglish or English from it.
export function teamHasItReply(lang: ClaimLang, said: string): string {
  return lang === 'hi' ? TEAM_HAS_IT_HI : routineLine('payment', said);
}

// ── 4.3 The customer writes again in a Ship again chat (the AI is off) ────────────────
// A message about the link or the order. Anything else in a Chikki-marked chat goes to a person.
// A '?' alone ("?", "??") counts; a question mark does not make another subject one ("COD available
// hai?"), and neither does a link / order word next to one ("Can I change my delivery address?").
export const FOLLOW_UP = /\b(?:track\w*|link|kab|kb|when|update|status|kaha|kahan|kidhar|where|order|parcel|delivery|deliver\w*|bhej\w*|send|mil\w*|aay\w*|dispatch\w*|ship\w*)\b|ट्रैक|लिंक|कब|कहाँ|कहां|ऑर्डर|मिल/i;
const ONLY_ASKS = /^[\s?？!.।]*[?？][\s?？!.।]*$/;
const OTHER_SUBJECT = /\b(?:address|adress|addres|pin ?code|exchange|return|size|cod|cash on delivery)\b|एड्रेस|एक्सचेंज|साइज/i;
export function aboutTheLink(said: string | null | undefined): boolean {
  const t = String(said || '');
  if (OTHER_SUBJECT.test(t)) return false;
  return ONLY_ASKS.test(t) || FOLLOW_UP.test(t);
}

export const PROMISE_HOURS = 48;

export interface FollowUpInput {
  auto: boolean;                 // Chikki's mark (actor_role system / backfill) and no team message since
  said: string;                  // this message, masked
  urgent: UrgentKind | null;     // urgentKind(said)
  routine: RoutineKind | null;   // routineHandOverKind(said)
  claim: TrackingClaim | null;   // trackingClaimKind(said)
  angry: boolean;                // scanSignals: abuse, rude, escalate, caps or burst
  hoursSinceMark: number | null; // since case_marked_at; null = unknown
  repeated: boolean;             // the reminder was sent since the mark (any language), or would repeat one of the last 3 AI replies
}
// red: flag the chat red (Ship again + Needs you). reply: which line the customer gets
// (case-auto.ts builds it): 'threat' = urgentAck, 'routine' = routineLine, 'handoff' = handoffReply.
export type FollowUpReply = null | 'reminder' | 'reminder+team' | 'threat' | 'routine' | 'handoff';
export interface FollowUpAction { red: boolean; reply: FollowUpReply }

// Spec 4.3, first match wins. A chat a person marked, or one a team member has written in since
// the mark, sends nothing (rule 9.2); only a new tracking claim (with or without a fraud word)
// turns it red. In a Chikki-marked chat: one reminder for a question about the link, red with
// the line for the case otherwise. The reminder is sent at most once (rule 12): when it would
// repeat, a red case gets the hand-off (a fraud claim: the urgent line) instead. Once the 48 hours
// have passed (row 8, the promise is broken) the reminder is never sent again, whatever the
// message: a claim or anger gets the hand-off, a fraud claim the urgent line.
export function followUpAction(x: FollowUpInput): FollowUpAction {
  const said = String(x.said || '');
  const none: FollowUpAction = { red: false, reply: null };
  if (!x.claim && isCourtesyOnly(said)) return none;                                            // 1
  if (!x.auto) {
    return x.claim ? { red: true, reply: null } : none;                                       // 4, 5 (staff)
  }
  const late = x.hoursSinceMark !== null && x.hoursSinceMark >= PROMISE_HOURS;                // 8
  if (x.urgent === 'threat') return { red: true, reply: 'threat' };                           // 2
  if (x.routine) return { red: true, reply: 'routine' };                                      // 3
  if (x.urgent === 'accusation') return { red: true, reply: x.repeated || late ? 'threat' : 'reminder+team' };  // 4
  if (x.claim || x.angry) return { red: true, reply: x.repeated || late ? 'handoff' : 'reminder' };   // 5, 6
  if (!aboutTheLink(said)) return { red: true, reply: 'handoff' };                            // 7
  if (late) return { red: true, reply: 'handoff' };                                           // 8
  if (x.repeated) return { red: true, reply: 'handoff' };                                     // 9
  return { red: false, reply: 'reminder' };                                                   // 10
}
