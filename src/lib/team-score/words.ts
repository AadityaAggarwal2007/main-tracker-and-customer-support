// ── Team score (owner, 2026-10-01, part 4): the keyword judge. Pure. ──
// STAFF ONLY. Decides from a customer's own words whether they said thank you, whether they accepted
// the team's answer ("convinced"), and whether a staff reply was a holding line ("will check and
// update") or asked for a thank-you. 'unsure' goes to the AI check (judge.ts, cron only); the report
// never waits on a model. Never used by the widget, the AI reply path, the learner or search.
import { scanSignals, saysResolved } from '@/lib/chat/health-rules';
import { isCourtesyOnly } from '@/lib/chat/escalation';

export type Tri = 'yes' | 'no' | 'unsure';

// ── Patterns (exact; all case-insensitive unless noted) ──
const THANKS_LATIN = /\b(thanks?|thank\s*(you|u+|yu|q)|thanku+|thanq|thnx|thnks|thanx|thx|tysm|ty|tq|shukriya+|shukria|sukriya|dhanyavaa?d|dhanyawaa?d|dhanyabad|grateful|appreciated?)\b/i;
const THANKS_DEVA  = /(धन्यवाद|शुक्रिया|थैंक|आभार)/;
const THANKS_EMOJI = /🙏/u;
const SARCASM = [
  /\b(no\s+thanks?|thanks?\s+for\s+(nothing|wasting|ignoring|no\s+help)|thank\s*(you|u)\s+for\s+(nothing|wasting|ignoring)|thanks?\s+a\s+lot\s+for\s+nothing|wah\s+(kya|kitni)\s+(service|support))\b/i,
  /(🙄|😡|🤬|😤)/u,
];
const BUT_OR_QUESTION = /\?|\b(but|lekin|par|pr|still|abhi\s+tak|ab\s+tak|kab|when|where|kahan|kaha|nahi|nahin|nhi|not)\b|(लेकिन|अभी तक|कब|नहीं)/i;
// A thank-you tacked onto a NEW request ("please check my order, thank you", "size M chahiye thanks")
// is the customer still waiting, not a reaction to the answer: not a sure thank-you, the AI decides
// (slice 4 test W1: a sure 'yes' paid +3 to the last replier and stopped the 2-hour clock).
const REQUEST = /\b(please|pls|plz|kindly|in\s+advance|i\s+want|i\s+need|want\s+to|need\s+to|also|one\s+more|send|share|call\s+me|chahiye|chaiye|karna\s+(hai|h)|karwana|bhej|bhejo|bhejiye|bhej\s+do|bata\s*(do|dena|dijiye)|batao|bataiye|batayein|kar\s*(do|dijiye|dena)|kijiye)\b/i;
// Only-courtesy text that is still a nudge, not a goodbye: a greeting or a question mark.
const NUDGE = /\?|\b(hi+|hello+|helo+|hlo+|hey+)\b/i;
const ANGRY_FACE = SARCASM[1];   // 🙄 😡 🤬 😤: never a happy last word
// Real push-back only ("where is my order" / "kab aayega" are questions, not objections).
const STILL_NOT = /\b(abhi\s+tak|ab\s+tak|still\s+(not|no|waiting|nothing)|not\s+(yet\s+)?(received|delivered|come|arrived|got)|nahi\s+(aaya|aayi|aya|mila|mili|pahuncha|hua)|nhi\s+(aaya|aya|mila|mili|hua)|kab\s+tak|same\s+problem|wrong\s+(item|product|size|order)|galat)\b|(अभी तक|नहीं आया|नहीं मिला|कब तक)/i;
const ACCEPT = /\b(i'?ll\s+wait|i\s+will\s+wait|will\s+wait|wait\s+kar\s*(lu|lunga|lungi|leta|leti|unga|ungi|enge|lenge|raha|rahi)|wait\s+karunga|wait\s+karungi|ruk\s+(jata|jati|jaunga|jaungi|jate)|no\s+need\s+(to\s+)?(cancel|refund)|don'?t\s+cancel|do\s+not\s+cancel|cancel\s+(mat|na)\s+karo|cancel\s+nahi\s+karna|refund\s+nahi\s+chahiye|samajh\s+(gaya|gayi|gya|gyi|aa\s+gaya)|samjh\s+(gaya|gayi|gya)|understood|got\s+it|makes\s+sense|ok(ay)?\s+(no\s+problem|sure|fine)|no\s+problem|no\s+worries|koi\s+baat\s+nahi|th[ie]+k\s+hai|thik\s+h|chalo\s+(th[ie]+k|theek)|alright|fair\s+enough)\b/i;
const ACCEPT_DEVA = /(इंतज़ार|इंतजार कर|रुक जात|समझ गया|समझ गई|ठीक है|कोई बात नहीं|कैंसिल मत)/;
// Copied from brain-examples.ts (copied, not imported: a learner change must never move scores).
const POLITE_WORDS = new Set('ok okk okkk okay okey k kk thanks thank thanku thankyou thnx thx ty you so much very theek thik hai h accha achha acha ji haan han ha done great good nice alright sure got it noted cool fine sir mam maam madam maim mem dear bhai bhaiya didi sahi samajh gaya gayi samjha shukriya dhanyavad dhanyawad welcome'.split(' '));
const DONE = /\b(?:change|changed|update|updated|cancel|cancelled|done|correct|sahi|theek)\w*\s+(?:ho\s+)?(?:gaya|gayi|gya|hua|ho gya)\b/i;
// A holding line: the reply says "I will check / confirm / update", "please wait", "ek minute" (owner
// default kept: "ok thanks" after "check karke batata hu" is not a thank-you). holdingKind() splits them
// (review 2026-10-02, fourth pass; fifth pass: by what is LEFT, see holdingKind): 'pure' = only the
// holding line, the keywords decide; 'mixed' = a holding phrase AND anything more ("Aapka refund ho gaya
// hai, please wait 5-7 working days", "Pickup kal hoga, thoda wait kariye"): the keywords cannot tell an
// answer from a promise, the AI decides (owner Q12: keywords first, AI only when unsure). No length limit.
const HOLDING = [
  /\b(will|we'?ll|i'?ll|let\s+me|going\s+to|shall)\b[^.?!]{0,40}\b(check|update|confirm|get\s+back|look\s+into|inform|share|revert|escalate)/i,
  /\b(please|kindly|pls|plz)\s+wait\b/i,
  /\bwait\s+(karo|kro|kariye|kijiye|kare|karein|karen|kar\s+lijiye|kr\s+lijiye)\b|\b(ruko|rukiye|rukie|rukein)\b/i,
  /\blooking\s+into\b/i,
  /\b(check|confirm|pata)\s+(karke|kar\s+ke|krke|kr\s+ke)\s+(bata|btata|batate|batati|update)/i,
  /\bdekh\s*(ke|kar|kr)\s+(bata|btata|batate|batati)/i,
  /\bteam\s+(ko|se)\s+(forward|puch|pooch|bhej)/i,
  /\bescalat(e|ed|ing)\b/i,
  /(चेक करके|चेक कर रहा|चेक कर रही|कन्फर्म करके|देख कर बता|देखकर बता|पता करके|देखता हूँ|देखता हूं|देखती हूँ|देखती हूं|एक मिनट|प्रतीक्षा करें|प्रतीक्षा कीजिए|इंतज़ार करें|इंतजार करें|इंतज़ार कीजिए|इंतजार कीजिए|रुकिए|रुको)/,
  // "Dekhta hu", "ruko check kar raha hu", "Checking, ek minute" (review 2026-10-02). Never a bare
  // "checking": "after checking, your order arrives 7 Oct" is a real answer.
  /\b(dekhta|dekhti)\s+(hu|hun|hoon|hai|h)\b|\bdekh\s+(raha|rahi|rha|rhi)\b/i,
  /\bcheck\s+(kar|kr)\s+(raha|rahi|rha|rhi)\b/i,
  /\b(ek|1)\s*min(ute)?\b/i,
];
// Facts and done work: a reply with one of these says what happened or when, even with a "please
// wait" or "we will update you" in it. Fifth pass: only a safety net; a holding line with more than one
// word left over is 'mixed' anyway (holdingKind).
const HOLDING_FACT = [
  /\b(ho|hogaya|hogya)\s*(gaya|gayi|gyi|gya|gaye|chuka|chuki|chuke)\b|\bhogaya\b|\bhogya\b/i,
  /\b(done|completed?|processed|refunded|initiated|credited|approved|shipped|dispatched|delivered|out\s+for\s+delivery|in\s+transit|cancell?ed|replaced|resolved)\b/i,
  /\b(aaj|kal|parso|tomorrow|today|tonight)\b[^.?!]{0,30}\b(aa\s*ja[ye]*g[ai]|aa\s*jaeg[ai]|aay?eg[ai]|aaeg[ai]|deliver\w*|dispatch\w*|ship\w*|pahunch\w*|mil\s*ja[ye]*g[ai]|mileg[ai]|arriv\w*|reach\w*)/i,
  /\b\d+\s*(?:(?:-|–|to|se|or|ya)\s*\d+\s*)?(?:working\s+|business\s+)?(?:days?|din|weeks?|hafte|hafta)\b/i,
  /\b\d{1,2}\s*(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\b/i,
  /\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b|\b\d{1,2}-\d{1,2}-\d{2,4}\b/,
  /https?:\/\/|\bwww\.|(?<![\w])(?:ST|AWB)[A-Z0-9]{6,}\b|\d{8,}/i,
  /(हो गया|हो गयी|हो गई|हो चुका|हो चुकी|डिलीवर|डिस्पैच|शिप हो|ट्रैकिंग|लिंक|कल (?:तक )?आ जाएगा|कल (?:तक )?आ जायेगा|कल आएगा|कल आयेगा|[0-9०-९]+\s*दिन)/,
  // Done work, stock, where the parcel is and when (fourth pass): "refund kar diya", "courier ne pickup kar
  // liya", "confirm kiya hai", "Haan size M available hai, ek minute", "stock me hai", "exchange possible
  // hai", "it is on the way", "order aa raha hai", "please wait till Monday", "one more day".
  /\b(kar|kr)\s*(diya|diye|dia|di|dii|liya|liye|lia|li)\b|\bavailable\s+(hai|h|he|hain|hn)\b|\bkiya\s+(hai|h|he|tha)\b|\bpossible\s+(hai|h|he)\b|\b(in|out\s+of)\s+stock\b|\bstock\s+(me|mein|mai)\s+(hai|h|he)\b|(कर दिया|कर दी|कर दिए|कर लिया|उपलब्ध है)/i,
  /\bon\s+(the|its)\s+way\b|\bis\s+with\s+(the\s+|our\s+)?courier\b|\braste\s+(me|mein|mai|main)\b|\baa\s+(raha|rahi|rhi|rha)\s+(hai|h|he)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar)\b|\b(one|two|three|four|five|ek|teen|char|paanch)\s+(more\s+|aur\s+)?(days?|din|weeks?|hafte|hafta)\b/i,
];
// Fifth pass (lead design v5): what is left of a holding line once every holding phrase (HOLDING_CUT:
// HOLDING with the "will ... check" gap made lazy, so it never swallows the words in between, each match
// taken to the end of its word, "bata" -> "batata"; and a chained "... and get back to you") and these
// polite / filler words are taken out. Not a fact list: anything NOT here is content. "haan" / "yes" /
// "nahi" / "no" are never filler: a yes or no is an answer (ANSWER_WORD). "hai" is content too.
const HOLDING_CUT = [
  ...HOLDING.map((re) => new RegExp('(?:' + re.source.replace('[^.?!]{0,40}\\b', '[^.?!]{0,40}?\\b') + ')[a-z]*', re.flags + 'g')),
  /\bget\s+back\b/gi,
];
const FILLER = new Set((
  'sir maam madam mam ji please pls plz kindly just ok okay sure while i we me my us our your you it this that the a an for of on in to ' +
  'with is are am and let will shall moment minute minutes min second seconds sec time some status details check checking update ' +
  'updating team shortly soon asap wait waiting sorry inconvenience patience thanks thank dear hello hi ' +
  'thoda bas abhi main mai hum ham aap aapka aapke aapki aapko apka apke apki apko order ko ka ki ke se me mein ya aur hu hun hoon ' +
  'raha rahi rahe rha rhi karta karti karte kar kr karke krke jaldi bhai bhaiya didi ' +
  'सर मैम जी कृपया थोड़ा बस अभी मैं हम आप आपका आपके आपकी आपको ऑर्डर को का की के से में मे और या हूँ हूं हु रहा रही रहे करता करती करते कर करके ' +
  'समय मिनट सेकंड स्टेटस चेक अपडेट टीम जल्दी'
).normalize('NFC').split(' '));
const ANSWER_WORD = /^(haan|han|haanji|hanji|yes|yeah|yep|yup|no|nope|not|nahi|nahin|nhi|हाँ|हां|नहीं)$/;
// The words left of a holding line (lower case; punctuation, emoji and one-letter words dropped; a
// number is a word).
function leftOver(text: string): string[] {
  let t = text;
  for (const re of HOLDING_CUT) t = t.replace(re, ' ');
  return t.normalize('NFC').toLowerCase()
    .replace(/\b(i|we|you|it|that|there|let)['’](ll|m|re|ve|s|d)\b/g, '$1 ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9ऀ-ॣ०-ॿ]+/g, ' ')
    .split(' ')
    .filter((w) => w && !FILLER.has(w) && (w.length > 1 || /[0-9०-९]/.test(w)));
}
const ASKS_THANKS = [
  /\b(say|bol|bolo|boliye|bol\s+do|bol\s+dena|bol\s+dijiye|likh|likho|likhiye|likh\s+do|likh\s+dena|type|send|reply\s+with)\b\W+(?:\w+\W+){0,3}?(thanks?|thank\s*(you|u)|shukriya|dhanyavad)\b/i,
  /\b(thanks?|thank\s*(you|u)|shukriya|dhanyavad)\b\W+(?:\w+\W+){0,2}?(bol|bolo|boliye|bol\s+do|bol\s+dena|likh|likho|likhiye|likh\s+do|type\s+kar)/i,
  /\b(rate|rating|review|feedback|stars?)\b[^.?!]{0,25}\b(do|de\s+do|dijiye|dena|please|us|5|five)\b/i,
  /\b(5|five)\s*-?\s*stars?\b/i,
  /(धन्यवाद|थैंक\s*यू|शुक्रिया)\s*(बोल|लिख)/,
];
const SIGN_OFF = /^(thanks|thank you|thanks and regards|thanks & regards|regards|best regards|kind regards|warm regards|sincerely|cheers|best)[,!.]?\s*$/i;
const QUOTE_START = /^(on .+ wrote:|-{2,}\s*original message|from:\s)/i;

const any = (list: RegExp[], text: string) => list.some((re) => re.test(text));

function signals(text: string) {
  return scanSignals([{ sender: 'visitor', content: text }]);
}

// Copied from brain-examples.ts isPolite: at most 8 words, all polite / courtesy words, or only
// these emoji.
function isPoliteOnly(text: string): boolean {
  const ws = text.toLowerCase().replace(/[^a-zऀ-ॿ ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!ws.length) return /^[\s🙏👍❤️😊🙂✅]+$/u.test(text);
  return ws.length <= 8 && ws.every((w) => POLITE_WORDS.has(w));
}

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

// The thank-you spellings isCourtesyOnly (escalation.ts) does not know: "ok thank u", "ok thanku",
// "ok thnx", "ok tq", "ok thanks bhaiya".
const ACK_THANKS = /^(thanks?|thank|thanku+|thankyou|thanq|thnx|thnks|thanx|thx|tysm|ty|tq|u+|yu|q)$/;

// ── Rules ──

// Email only: drops the quoted earlier mail and the sign-off block before judging. A mail that is
// nothing but a sign-off ("Thanks,\nRam") keeps its text: that line IS the message there.
export function stripEmailQuote(text: string): string {
  let lines = String(text || '').split(/\r?\n/);
  const q = lines.findIndex((l) => QUOTE_START.test(l.trim()));
  if (q >= 0) lines = lines.slice(0, q);
  lines = lines.filter((l) => !/^\s*>/.test(l));
  const filled: number[] = [];
  lines.forEach((l, i) => { if (l.trim()) filled.push(i); });
  const last4 = filled.slice(-4);
  for (const i of last4) {
    if (SIGN_OFF.test(lines[i].trim()) && filled[0] < i) { lines = lines.slice(0, i); break; }
  }
  return lines.join('\n').trim();
}

// "hi", "ok", 👍, "." : stops the clock like any reply, but never earns a fast reply.
export function isTrivialReply(staffText: string): boolean {
  const t = String(staffText || '');
  if (isCourtesyOnly(t)) return true;
  return (t.match(/[\p{L}\p{N}]/gu) || []).length < 3;
}

// A polite "ok thanks" in any common spelling, and nothing else (at most 8 words, no question): after
// a holding reply it is not a thank-you, the customer is still waiting for the answer. "thank you so
// much mil gaya" is not one (it says the problem is solved).
export function isPoliteAck(text: string): boolean {
  const t = String(text || '');
  if (isCourtesyOnly(t)) return true;
  if (/\?/.test(t)) return false;
  const ws = t.toLowerCase().replace(/[^a-zऀ-ॿ ]+/g, ' ').split(/\s+/).filter(Boolean);
  return ws.length > 0 && ws.length <= 8 && ws.every((w) => POLITE_WORDS.has(w) || ACK_THANKS.test(w));
}

// 'pure': only a holding line ("We will check and update you", "Please wait while I check your order",
// "Ek minute, check karke batata hu", "मैं देखता हूँ"): a polite "ok thanks" after it is not a thank-you
// and not "convinced" (the keywords decide). 'mixed': a holding phrase AND anything more ("Aapka refund
// process ho gaya hai, please wait 5-7 working days", "Pickup kal hoga, thoda wait kariye", "Haan COD
// hai, ek minute"): a polite "ok thanks" after it goes to the AI (engine.ts). null: no holding phrase.
// Fifth pass (lead design v5): decided by what is left (leftOver), not by a fact list: 'pure' = at most
// one word left, not a yes / no, and no HOLDING_FACT. When in doubt it is 'mixed': a wrong trip to the
// AI costs one capped call, a wrong 'pure' silently costs a member real points.
export type HoldingKind = 'pure' | 'mixed' | null;
export function holdingKind(staffText: string): HoldingKind {
  const t = String(staffText || '').trim();
  if (!t || !any(HOLDING, t)) return null;
  if (any(HOLDING_FACT, t)) return 'mixed';
  const left = leftOver(t);
  return left.length <= 1 && !left.some((w) => ANSWER_WORD.test(w)) ? 'pure' : 'mixed';
}

// Any holding line, pure or mixed.
export function isHoldingReply(staffText: string): boolean {
  return holdingKind(staffText) !== null;
}

// "thank you bol dena", "rate us 5 stars": a thank-you after it is not counted.
export function asksForThanks(staffText: string): boolean {
  return any(ASKS_THANKS, String(staffText || ''));
}

// The customer pushes back: refund / cancel, abuse, fraud, threats, complaints, or "still not
// received" / "abhi tak nahi aaya".
export function isObjection(customerText: string): boolean {
  const t = String(customerText || '');
  const s = signals(t);
  return s.refund + s.abuse + s.rude + s.accuse + s.threat + s.escalate > 0 || STILL_NOT.test(t);
}

export function keywordThanks(customerText: string): Tri {
  const t = String(customerText || '');
  if (!t.trim()) return 'no';
  if (!THANKS_LATIN.test(t) && !THANKS_DEVA.test(t) && !THANKS_EMOJI.test(t)) return 'no';
  if (any(SARCASM, t)) return 'unsure';
  const s = signals(t);
  if (s.abuse + s.rude + s.accuse + s.threat + s.escalate + s.refund > 0) return 'unsure';
  if (BUT_OR_QUESTION.test(t)) return 'unsure';
  if (REQUEST.test(t)) return 'unsure';
  return 'yes';
}

// Which rule decided keywordConvinced: 'accept' (ACCEPT / ACCEPT_DEVA), 'resolved' (saysResolved /
// DONE / a thank-you) or 'polite' (only polite words, "ok").
type ConvincedWhy = 'accept' | 'resolved' | 'polite' | null;
function convinced(customerText: string): { tri: Tri; why: ConvincedWhy } {
  const t = String(customerText || '');
  if (!t.trim()) return { tri: 'no', why: null };
  const s = signals(t);
  if (s.abuse + s.rude + s.accuse + s.threat > 0 || STILL_NOT.test(t)) return { tri: 'no', why: null };
  const q = t.includes('?');
  // Before the refund / cancel check on purpose: "cancel mat karo, main wait kar lungi" and
  // "refund nahi chahiye" mention cancel / refund and still accept.
  if (ACCEPT.test(t) || ACCEPT_DEVA.test(t)) return { tri: q ? 'unsure' : 'yes', why: 'accept' };
  if (isObjection(t)) return { tri: 'no', why: null };
  if (saysResolved(t) || DONE.test(t) || keywordThanks(t) === 'yes') return { tri: q ? 'unsure' : 'yes', why: 'resolved' };
  if (isPoliteOnly(t)) return { tri: q ? 'unsure' : 'yes', why: 'polite' };
  if (q) return { tri: 'no', why: null };
  return { tri: wordCount(t) <= 3 ? 'no' : 'unsure', why: null };
}

export function keywordConvinced(customerText: string): Tri {
  return convinced(customerText).tri;
}

// A new question or request after an accepted answer ("aur mera dusra order kab dispatch hoga", "bill
// bhej do", "can you check my other order?"): the customer asks for more, it does not take the earlier
// acceptance back (engine.ts, fourth pass). Only these fall back to it; any other unsure message is the
// last word, as before.
const ASK = /\b(kab|kya|kaise|kaisa|kaisi|kitne|kitna|kitni|kaha|kahan|kahaan|kyu|kyun|kyon|kaun|kon|konsa|kaunsa|when|what|where|how|why|which|who|can\s+you|could\s+you|will\s+you|would\s+you|can\s+i|do\s+you|is\s+there)\b|(कब|क्या|कैसे|कितने|कितना|कितनी|कहाँ|कहां|क्यों|कौन|बताओ|बताइए|बताइये|बता दो|भेज दो|भेजो|भेजिए|चाहिए)/i;
export function isNewAsk(customerText: string): boolean {
  const t = String(customerText || '');
  return t.includes('?') || ASK.test(t) || REQUEST.test(t);
}

// Fifth pass (lead design v5): push-back in a later message ("itna time kyu lag raha hai?", "why is it
// taking so long?", "pehle bhi yahi bola tha, kab aayega?", "seriously? kitne din aur?", "ye kya mazak
// hai", "mujhe nahi chahiye ab ye order"). Such a question is NOT a new ask that keeps an earlier
// acceptance: it is the last word, as in c113ed0. A complaint (isObjection), anger or shouting from the
// health counts (caps, "???" / "!!!"), or one of these words. A repeated complaint is a complaint.
const PUSHBACK = /\b(kyu|kyun|kyon|kyo|why|kitne\s+din|kitna\s+time|kab\s+tak|pehle\s+bhi|phir\s+se|fir\s+se|mazak|mazaak|majak|(nahi|nahin|nhi)\s+chahiye|cancel\w*|refund\w*|seriously|bakwas|worst|fraud\w*|cheat\w*|ghatiya|late|delay\w*|abhi\s+tak|still\s+not|not\s+received|kuch\s+kar(te|ti|o|oge|enge)?)\b|(क्यों|क्यूं|कितने दिन|कितना समय|कब तक|पहले भी|फिर से|मज़ाक|मजाक|नहीं चाहिए|कैंसिल|रिफंड|बकवास|घटिया|फ्रॉड|धोखा|देरी|अभी तक|कुछ करते)/i;
export function pushesBack(customerText: string): boolean {
  const t = String(customerText || '');
  if (isObjection(t) || PUSHBACK.test(t)) return true;
  const s = signals(t);
  return s.caps + s.burst > 0;
}

// The customer says no to the answer: "no", "not ok", "nahi", "I am not convinced", "ye sahi nahi hai".
const REJECT = /^\s*(no+|nope|nah|nahi+|nahin|nhi|nai)\b(?!\s+(problem|prob|worries|worry|issue|issues|need|tension|baat))|\bnot\s+(ok|okay|fine|happy|satisfied|convinced|acceptable|agreed?)\b|\b(i\s+am|i'?m|im)\s+not\s+(ok|okay|fine|happy|satisfied|convinced|sure)\b|\b(don'?t|do\s+not|can'?t|cannot)\s+(agree|accept|believe)\b|\bunacceptable\b|\b(sahi|theek|thik|thek|thk)\s+(nahi|nahin|nhi|nai)\b|\b(nahi|nahin|nhi)\s+(chalega|manunga|manungi|maanunga|maanungi)\b|(^\s*नहीं|सही नहीं|ठीक नहीं|मंजूर नहीं|मंज़ूर नहीं|नहीं चलेगा)/i;
// A rejection takes an earlier acceptance back: a complaint (isObjection), a "no" phrase, or a keyword
// "no" that is not a new question ("no", "not ok", "nahi"; "kab aayega?" is 'no' only for its "?").
export function rejectsAnswer(customerText: string): boolean {
  const t = String(customerText || '');
  return isObjection(t) || REJECT.test(t) || (keywordConvinced(t) === 'no' && !isNewAsk(t));
}

// An auto-close counts as solved only when the customer's last word was thanks / "mil gaya" /
// "theek hai" (owner Q10 default). A bare "ok" is polite-only: it is "convinced" by the keyword
// rules, but it does not say the problem is over, so it does not make an auto-close a solve.
export function acceptsClose(customerText: string): boolean {
  const t = String(customerText || '');
  if (keywordThanks(t) === 'yes' || saysResolved(t)) return true;
  const c = convinced(t);
  return c.tri === 'yes' && c.why !== 'polite';
}

// A real new message after a close (the solved 24-hour watch). Not one: a no-reply-needed line,
// a thank-you, an acceptance, or courtesy only.
export function cameBack(customerText: string, noReply: boolean): boolean {
  if (noReply) return false;
  const t = String(customerText || '');
  if (keywordThanks(t) === 'yes') return false;
  if (keywordConvinced(t) === 'yes') return false;
  if (isCourtesyOnly(t)) return false;
  return true;
}

// A happy last word ("ok got it thanks", "theek hai", 🙏): after a team answer, not a customer left
// waiting (rules.ts scoreWaiting). A nudge made of courtesy words ("hello?", "hi", an angry face) is not
// one: the customer is still waiting, as the inbox says (slice 4 test W3). Memoised: the clock walk asks
// it for the same text many times.
const signOffMemo = new Map<string, boolean>();
export function isSignOff(customerText: string): boolean {
  const t = String(customerText || '');
  const hit = signOffMemo.get(t);
  if (hit !== undefined) return hit;
  const v = !ANGRY_FACE.test(t)
    && (keywordThanks(t) === 'yes' || keywordConvinced(t) === 'yes' || (isCourtesyOnly(t) && !NUDGE.test(t)));
  if (signOffMemo.size >= 5000) signOffMemo.clear();
  signOffMemo.set(t, v);
  return v;
}

// Copy of the maskPersonal chain (brain-learn.ts; copied, because brain-learn imports brain), then
// whitespace collapsed and cut to `max` code points.
export function maskForJudge(text: string, max = 500): string {
  const s = String(text || '')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(?<![\w])(?:ST|AWB)[A-Z0-9]{6,}\b/gi, '[tracking id]')
    .replace(/#\s?\d{2,}/g, '[order]')
    .replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, '[phone]')
    .replace(/\d{5,}/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, Math.max(0, max)).join('') : s;
}

export const JUDGE_INSTRUCTION = `You check one customer message from an online store's support chat, for the store owner's staff report. You get the support team's last reply and the customer's next message. Judge only the CUSTOMER's message. THANKS: is the customer genuinely thanking the team (not sarcastic, not "no thanks", not only a polite "ok" while still waiting)? CONVINCED: does the customer accept the answer or say the problem is settled (agrees to wait, says ok / understood, got the order), with no new complaint, demand or open question? If the team's reply only promises to check, confirm or update later and gives no answer yet, a polite ok / thanks is THANKS=no and CONVINCED=no; if it gives a real answer (even with "please wait N days"), judge normally. Answer with exactly one line: THANKS=yes|no CONVINCED=yes|no`;

// Never staff names, scores, points or notes: only the two masked texts.
export function buildJudgeInput(teamText: string, customerText: string): string {
  return 'TEAM: ' + maskForJudge(teamText) + '\nCUSTOMER: ' + maskForJudge(customerText);
}

export function parseJudgeReply(raw: string | null | undefined): { thanks: boolean; convinced: boolean } | null {
  const s = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const th = s.match(/THANKS\s*[=:]\s*(yes|no)/i);
  const cv = s.match(/CONVINCED\s*[=:]\s*(yes|no)/i);
  if (!th || !cv) return null;
  return { thanks: th[1].toLowerCase() === 'yes', convinced: cv[1].toLowerCase() === 'yes' };
}
