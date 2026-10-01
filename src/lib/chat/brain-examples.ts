// ── How our team handles difficult customers (Brain part 3, owner 2026-10-01) ─────────
// The owner wants the agent to learn from the team: when a customer is critical (refund or
// cancellation, wrong tracking, a late order, anger, a fraud claim, a payment problem...), how
// does the team talk to them, what do they say, what calms them down. A real team reply after
// which the customer calmed down becomes an EXAMPLE (masked, approved by an admin), and the
// agent is shown 1-2 examples of the same situation as a guide to tone and manner.
// Pure: the detectors only use health-rules.ts and brain.ts (both pure). Tested offline.
import { saysResolved, scanSignals } from './health-rules';
import { noteProblem, topicsIn } from './brain';
import { hasPersonalDetail } from './brain-learn';
import { promisesToday } from './today-promise';

export const SITUATIONS: { key: string; label: string }[] = [
  { key: 'refund_cancel', label: 'Refund / Cancellation' },
  { key: 'wrong_tracking', label: 'Wrong tracking' },
  { key: 'delay', label: 'Late order / not received' },
  { key: 'angry', label: 'Angry / frustrated customer' },
  { key: 'fraud_claim', label: 'Calls us fraud / threatens' },
  { key: 'payment', label: 'Payment problem' },
  { key: 'address', label: 'Address change' },
  { key: 'damaged', label: 'Damaged / wrong item' },
  { key: 'exchange', label: 'Exchange / return' },
];
export const SITUATION_KEYS = SITUATIONS.map((s) => s.key);

const WRONG_TRACKING = /\b(wrong|galat|incorrect|invalid|not working|kaam nahi|nahi chal|does ?n'?t work|different|another|someone else'?s|kisi aur ka|dusre ka|doosre ka)\b[^.?!\n]{0,40}\b(tracking|track|link|awb|order|name)\b|\b(tracking|track|link|awb)\b[^.?!\n]{0,40}\b(wrong|galat|incorrect|invalid|not working|kaam nahi|nahi chal|not (opening|updating)|update nahi|show(ing)? (another|someone)|kisi aur)\b/i;
const DELAY = /\b(late|delay\w*|der se|abhi tak|ab tak|still not|not (yet )?(received|delivered|arrived|come)|nahi (aaya|mila|aayi|mili)|nhi (aaya|mila|aayi)|kab (aayega|aayegi|milega|milegi|tak aayega)|kitne din|\d+\s*(din|days) ho gaye|when will (it|my order|i get|i receive|the order)|where is my (order|parcel))\b/i;

// The situations a customer's latest messages (oldest first) bring up. Order matters: the most
// serious first, because the agent is shown examples for the first one or two.
export function detectSituations(recentCustomerTexts: string[]): string[] {
  const text = recentCustomerTexts.join('\n');
  const topics = new Set(topicsIn(text));
  const sig = scanSignals(recentCustomerTexts.map((content) => ({ sender: 'visitor', content })));
  const out: string[] = [];
  if (sig.accuse || sig.threat) out.push('fraud_claim');
  if (topics.has('refund') || topics.has('cancel') || sig.refund) out.push('refund_cancel');
  if (topics.has('payment')) out.push('payment');
  if (WRONG_TRACKING.test(text)) out.push('wrong_tracking');
  if (topics.has('damaged')) out.push('damaged');
  if (DELAY.test(text)) out.push('delay');
  // Typing in capitals or asking the same thing twice is not anger on its own.
  if (sig.abuse || sig.rude || sig.escalate || (sig.caps && sig.burst) || sig.repeats >= 3) out.push('angry');
  if (topics.has('address')) out.push('address');
  if (topics.has('exchange')) out.push('exchange');
  return Array.from(new Set(out));
}

// After a team reply, did the customer calm down? `after` = the customer's messages that came
// after it (oldest first). Yes only when nothing they wrote afterwards is angry, accusing,
// threatening, a complaint or a refund demand again, and at least one says thanks / ok /
// solved. No reply at all is not proof (they may have given up), so it is a no.
const POLITE_WORDS = new Set('ok okk okkk okay okey k kk thanks thank thanku thankyou thnx thx ty you so much very theek thik hai h accha achha acha ji haan han ha done great good nice alright sure got it noted cool fine sir mam maam madam maim mem dear bhai bhaiya didi sahi samajh gaya gayi samjha shukriya dhanyavad dhanyawad welcome'.split(' '));
// The team did what was asked: "address change ho gaya", "cancel ho gaya", "update ho gaya".
const DONE = /\b(?:change|changed|update|updated|cancel|cancelled|done|correct|sahi|theek)\w*\s+(?:ho\s+)?(?:gaya|gayi|gya|hua|ho gya)\b/i;

function isPolite(text: string): boolean {
  const ws = text.toLowerCase().replace(/[^a-z\u0900-\u097f ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!ws.length) return /^[\s🙏👍❤️😊🙂✅]+$/u.test(text);
  return ws.length <= 8 && ws.every((w) => POLITE_WORDS.has(w));
}

export function customerCalmedAfter(after: string[]): boolean {
  const msgs = after.map((t) => (t || '').trim()).filter(Boolean);
  if (!msgs.length) return false;
  const sig = scanSignals(msgs.map((content) => ({ sender: 'visitor', content })));
  if (sig.abuse || sig.rude || sig.accuse || sig.threat || sig.escalate || sig.caps || sig.burst || sig.refund) return false;
  return msgs.some((m) => isPolite(m) || saysResolved(m) || DONE.test(m) || /\b(thanks?|thank you|shukriya|dhanyavad)\b/i.test(m));
}

// Why a team reply cannot be an example, or null. On top of the note rules (noteProblem):
// no personal detail, no amount, no calendar date, no promise of a refund time or of arrival.
export function exampleProblem(teamReplied: string): string | null {
  const t = (teamReplied || '').trim();
  if (t.length < 30) return 'Too short to learn from.';
  if (t.length > 900) return 'Too long: keep the part that matters.';
  if (hasPersonalDetail(t)) return 'Take out phone numbers, order IDs, links and e-mail addresses.';
  if (/(₹|\brs\.?\s?\d|\binr\b|\d+\s?(rupees|rs)\b)/i.test(t)) return 'Take out amounts: the agent must not copy a price or a refund amount.';
  if (/\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}\b|\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/i.test(t)) return 'Take out dates: the agent takes dates only from the order lookup.';
  if (promisesToday(t)) return 'It promises arrival today / tonight / tomorrow.';
  if (/\brefund\w*\b[^.]{0,60}\b(processed|initiated|credited|within|working days|days|hours|ho jayega|aa jayega|mil jayega)\b|\b(will|we'?ll|ho jayega)\b[^.]{0,30}\brefund\b/i.test(t)) return 'It promises a refund or a refund time: the agent hands refunds to the team.';
  return noteProblem('', t);
}

export interface Example { id?: string; situation: string; customer_said: string; team_replied: string }

// The prompt block for the agent: at most `max` examples, the first situation first.
export function examplesSection(examples: Example[]): string {
  if (!examples.length) return '';
  const label = (k: string) => SITUATIONS.find((s) => s.key === k)?.label || k;
  const blocks = examples.map((e, i) => `Example ${i + 1} (${label(e.situation)})\nCustomer: ${e.customer_said.trim()}\nOur team: ${e.team_replied.trim()}`);
  return `

HOW OUR TEAM HANDLES THIS
Real replies the store's own team sent to a customer in the same situation; the customer calmed down after them, and the owner approved them. Talk the way they do: the same calm, the same kind of explanation, the same respect, in the customer's language. Write your own sentences that fit this customer's message: never repeat an example word for word, and answer what this customer actually asked. Copy the manner, never the facts: never copy a date, an amount, an order detail or a promise from them; facts come only from the lookup. The SHIPTRACK RULES above always win (refunds, cancellations and payment problems still go to the team).
${blocks.join('\n\n')}`;
}

// Which approved examples to show: for the detected situations in order, the newest first,
// at most `max`, and never two from the same situation while another situation has one.
export function pickExamples(all: Example[], situations: string[], max = 2): Example[] {
  const out: Example[] = [];
  for (const s of situations) {
    const e = all.find((x) => x.situation === s && !out.includes(x));
    if (e) out.push(e);
    if (out.length >= max) return out;
  }
  for (const s of situations) {
    for (const e of all.filter((x) => x.situation === s && !out.includes(x))) {
      out.push(e);
      if (out.length >= max) return out;
    }
  }
  return out;
}

// Chat replies are short: an email-style greeting and signature are not part of how the team
// talks in chat, so they are taken off an example.
export function cleanTeamReply(text: string): string {
  return String(text || '')
    .replace(/^\s*(?:dear|hi|hello|hey)\b[^\n,]{0,40}[,!]?\s*\n+/i, '')
    .replace(/\n+\s*(?:regards|thanks|thank you|warm regards|best regards)?[,\s]*\n*\s*(?:team\s+)?(?:vastora|vestora|luxeva)?\s*(?:customer\s+)?(?:support|care)(?:\s+team)?\s*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Situations that are critical enough to learn from a chat that simply ended after the team's
// reply (no calm word from the customer).
export const QUIET_OK = ['refund_cancel', 'fraud_claim', 'angry', 'wrong_tracking', 'delay', 'payment', 'damaged'];

export interface ExampleDraft { situation: string; customer_said: string; team_replied: string }

// The example part of the learner's JSON, or null when missing or unusable.
export function parseExample(raw: string | null | undefined, allowedSituations: string[]): ExampleDraft | null {
  if (!raw) return null;
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) return null;
  let obj: { example?: { situation?: string; customer?: string; team?: string } | null };
  try { obj = JSON.parse(json[0]); } catch { return null; }
  const e = obj?.example;
  if (!e || typeof e !== 'object') return null;
  const situation = String(e.situation || '').trim();
  if (!SITUATION_KEYS.includes(situation) || !allowedSituations.includes(situation)) return null;
  const customer = String(e.customer || '').trim().slice(0, 300);
  const team = cleanTeamReply(String(e.team || ''));
  // What the customer said must itself be about this situation (not a coupon question filed as anger).
  if (!detectSituations([customer]).includes(situation)) return null;
  if (customer.length < 3 || hasPersonalDetail(customer)) return null;
  if (exampleProblem(team)) return null;
  return { situation, customer_said: customer, team_replied: team };
}

export const sameReply = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z\u0900-\u097f]+/g, ' ').trim().slice(0, 80) === b.toLowerCase().replace(/[^a-z\u0900-\u097f]+/g, ' ').trim().slice(0, 80);
