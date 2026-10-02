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
const HOLDING = [
  /\b(will|we'?ll|i'?ll|let\s+me|going\s+to|shall)\b[^.?!]{0,40}\b(check|update|confirm|get\s+back|look\s+into|inform|share|revert|escalate)/i,
  /\b(please|kindly|pls)\s+wait\b/i,
  /\b(check|confirm|pata)\s+(karke|kar\s+ke|krke|kr\s+ke)\s+(bata|btata|batate|batati|update)/i,
  /\bdekh\s*(ke|kar|kr)\s+(bata|btata|batate|batati)/i,
  /\bteam\s+(ko|se)\s+(forward|puch|pooch|bhej)/i,
  /\bescalat(e|ed|ing)\b/i,
  /(चेक करके|देख कर बता|देखकर बता|पता करके)/,
  // "Dekhta hu", "ruko check kar raha hu", "Checking, ek minute" (review 2026-10-02). Never a bare
  // "checking": "after checking, your order arrives 7 Oct" is a real answer.
  /\b(dekhta|dekhti)\s+(hu|hun|hoon|hai|h)\b|\bdekh\s+(raha|rahi|rha|rhi)\b/i,
  /\bcheck\s+(kar|kr)\s+(raha|rahi|rha|rhi)\b/i,
  /\b(ek|1)\s*min(ute)?\b/i,
];
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

// "We will check and update you", "please wait", "check karke batata hu".
export function isHoldingReply(staffText: string): boolean {
  return any(HOLDING, String(staffText || ''));
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

export const JUDGE_INSTRUCTION = `You check one customer message from an online store's support chat, for the store owner's staff report. You get the support team's last reply and the customer's next message. Judge only the CUSTOMER's message. THANKS: is the customer genuinely thanking the team (not sarcastic, not "no thanks", not only a polite "ok" while still waiting)? CONVINCED: does the customer accept the answer or say the problem is settled (agrees to wait, says ok / understood, got the order), with no new complaint, demand or open question? Answer with exactly one line: THANKS=yes|no CONVINCED=yes|no`;

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
