// ── Customer health: how upset is this customer? ───────────────
// Asked for by the owner on 2026-09-30. A score from 0 to 100 for each
// customer's CURRENT frustration and how likely they are to file a chargeback,
// so the team answers the angriest customers first (chat-health.sql).
//
// Two things make the number: a small model call that reads the customer's
// history (health.ts), and the counts below, which need no model and cannot be
// talked out of seeing a threat or a swear word. This file has no imports, so
// the inbox page, the server and the one-off backfill script all use the same
// rules, and it is tested on its own.

// ── Levels ─────────────────────────────────────────────────────
export interface HealthLevel {
  key: 'calm' | 'uneasy' | 'frustrated' | 'critical';
  label: string;
  min: number;
  bg: string;
  fg: string;
  bar: string;
}

// Highest first: the first level whose min the score reaches.
export const HEALTH_LEVELS: HealthLevel[] = [
  { key: 'critical', label: 'Critical', min: 75, bg: '#fee2e2', fg: '#b91c1c', bar: '#dc2626' },
  { key: 'frustrated', label: 'Frustrated', min: 50, bg: '#ffedd5', fg: '#c2410c', bar: '#ea580c' },
  { key: 'uneasy', label: 'Uneasy', min: 25, bg: '#fef9c3', fg: '#a16207', bar: '#ca8a04' },
  { key: 'calm', label: 'Calm', min: 0, bg: '#dcfce7', fg: '#15803d', bar: '#16a34a' },
];

// An OPEN chat at or above this stays at the top of the inbox until it is Closed.
// 50 (the start of "Frustrated") put 796 of 2,431 open chats up there on the first
// day, 33%, because scores bunch at 55-59 for customers the bot asked the same thing
// twice; 60 gave 213 (9%). The owner chose 65 (142 chats, 6%) on 2026-09-30.
export const HEALTH_PIN_MIN = 65;

export function healthLevel(score: number): HealthLevel {
  return HEALTH_LEVELS.find((l) => score >= l.min) || HEALTH_LEVELS[HEALTH_LEVELS.length - 1];
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// ── What the customer wrote ────────────────────────────────────
export interface HealthRow {
  sender: string;          // 'visitor' | 'ai' | 'agent'
  content: string;
  at?: string | null;      // ISO time of the message
  chat?: number;           // which of the customer's chats it is from (0 = oldest)
}

export interface HealthSignals {
  refund: number;          // messages asking for a refund / cancellation / money back
  abuse: number;           // swearing and insults
  rude: number;            // milder: worst, useless, rubbish
  accuse: number;          // fraud, scam, cheat, fake
  threat: number;          // chargeback, dispute, police, court, bad reviews
  escalate: number;        // complaint, manager, owner
  caps: number;            // SHOUTING
  burst: number;           // "!!!", "???", "pleaseeeee"
  repeats: number;         // the same message sent again
  chats: number;           // how many chats this customer has opened
  waitingDays: number;     // days since the oldest open chat began
  recentAbuse: boolean;    // in the customer's last 2 messages
  recentThreat: boolean;   // in the customer's last 3
  calmed: boolean;         // their LAST message says it is solved, with nothing negative in it
}

// The words are matched as text, lower-cased. Latin (English and Hinglish) with
// word boundaries; Devanagari, which \b does not work for, without. Add words
// here as they turn up in real chats.
const ABUSE = [
  /\b(bc|mc|bsdk|bhenchod|behenchod|bhosdike|bhosdi|madarchod|maderchod|mc|chutiya|chutiye|chutya|gandu|gaandu|harami|haramkhor|haramzada|kamina|kamine|kutta|kutte|kuttiya|randi|bakchod|bakchodi|lund|loda|lauda|gaand|fuck|fucking|fucked|shit|bastard|bitch|asshole|idiot|idiots|stupid|moron|bewakoof|bewakuf|bewkoof|nalayak)\b/i,
  /(चूतिया|चुतिया|चूतिये|भोसड़ी|भोसडी|मादरचोद|बहनचोद|गांडू|गण्डू|हरामी|हरामखोर|कमीना|कमीने|कुत्ता|कुत्ते|कुतिया|रंडी|बकचोद|बेवकूफ|नालायक)/,
];
const RUDE = [
  /\b(worst|useless|rubbish|nonsense|pathetic|waste|garbage|joke|shameless|ullu|pagal|saala|saale|sala|bekar|faltu|bakwas|ghatiya)\b/i,
  /(बकवास|घटिया|बेकार|फालतू|साला|साले|पागल|उल्लू|बेशर्म)/,
];
const ACCUSE = [
  /\b(fraud|frauds|fraudster|scam|scammer|scammers|cheat|cheater|cheaters|cheating|fake|chor|chors|thief|thieves|loot|looted|looting|dhokha|dhoka|dhokebaaz|duplicate)\b/i,
  /(धोखा|धोखेबाज|फ्रॉड|चोर|ठग|लूट)/,
];
const THREAT = [
  /\b(charge ?back|chargeback|dispute|disputed|consumer (court|forum|complaint)|court|police|cyber ?cell|cyber ?crime|legal|lawyer|advocate|fir|expose|viral|social media|bad review|one star|1 star|trust ?pilot|report (you|this|your|to)|block (my|the) (card|payment)|reverse (the )?payment)\b/i,
  /(चार्जबैक|चार्ज बैक|पुलिस|कोर्ट|कानूनी|वकील|उपभोक्ता|साइबर)/,
];
const ESCALATE = [
  /\b(complaint|complain|escalate|escalation|higher authority|senior|manager|owner|ceo|founder|supervisor|grievance)\b/i,
  /(शिकायत|मैनेजर|मालिक|ऑनर)/,
];
const REFUND = [
  /\b(refund|refunds|money ?back|paise wapas|paisa wapas|pese wapas|paise vapas|paisa vapas|paise return|return my money|give my money|cancel|cancelled|cancellation|reverse)\b/i,
  /\b(paise|paisa|pese|amount|payment)\b[^.?!\n]{0,20}\b(wapas|vapas|return|refund|back)\b/i,
  /\b(wapas|vapas)\b[^.?!\n]{0,20}\b(paise|paisa|pese|amount)\b/i,
  /(रिफंड|रिफण्ड|कैंसिल|पैसे वापस|पैसा वापस|पैसे लौटा|पैसे वापिस)/,
];

// The customer says the problem is over ("mil gaya", "got my order", "all good").
// A plain "ok thanks" is not that: customers say it after "the team will check"
// too, while they are still waiting. Not "not received", "nahi mila", or a question.
const RESOLVED = [
  /\b(mil ?gaya|mil ?gayi|mil gya|mila gaya|received|got (it|my|the)|solved|resolved|sorted|fixed|all good|sab theek|theek ho gaya|no (more )?(issue|problem)s?|problem (is )?(solved|fixed)|delivered)\b/i,
  /(मिल गया|मिल गई|सब ठीक|ठीक हो गया|सॉल्व)/,
];
const NEGATION = /\b(not|nahi|nahin|nhi|never|haven'?t|hasn'?t|didn'?t|no)\b|नहीं/i;

const any = (list: RegExp[], text: string) => list.some((re) => re.test(text));

export function saysResolved(text: string): boolean {
  if (!any(RESOLVED, text)) return false;
  const t = text.replace(/\bno (more )?(issue|problem)s?\b/gi, ' ');
  return !NEGATION.test(t) && !t.includes('?');
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();

// Counts, over the customer's own messages, how many carry each kind of signal.
// `rows` are oldest first; only the customer's ('visitor') are read.
export function scanSignals(
  rows: HealthRow[],
  ctx: { chats?: number; openSince?: string | null; now?: number } = {}
): HealthSignals {
  const mine = rows.filter((r) => r.sender === 'visitor' && (r.content || '').trim());
  const sig: HealthSignals = {
    refund: 0, abuse: 0, rude: 0, accuse: 0, threat: 0, escalate: 0, caps: 0, burst: 0, repeats: 0,
    chats: Math.max(1, ctx.chats || 1), waitingDays: 0, recentAbuse: false, recentThreat: false, calmed: false,
  };
  const seen = new Map<string, number>();
  mine.forEach((r, i) => {
    const text = r.content.slice(0, 1500);
    const recentThreat = i >= mine.length - 3;
    const recentAbuse = i >= mine.length - 2;
    if (any(REFUND, text)) sig.refund++;
    if (any(ABUSE, text)) { sig.abuse++; if (recentAbuse) sig.recentAbuse = true; }
    else if (any(RUDE, text)) sig.rude++;
    if (any(ACCUSE, text)) sig.accuse++;
    if (any(THREAT, text)) { sig.threat++; if (recentThreat) sig.recentThreat = true; }
    if (any(ESCALATE, text)) sig.escalate++;
    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 8 && letters.replace(/[^A-Z]/g, '').length / letters.length >= 0.7) sig.caps++;
    if (/[!?]{3,}/.test(text) || /([a-z])\1{4,}/i.test(text)) sig.burst++;
    const key = normalise(text);
    if (key.length >= 8 && /[a-zऀ-ॿ]/.test(key)) seen.set(key, (seen.get(key) || 0) + 1);
  });
  seen.forEach((n) => { if (n > 1) sig.repeats += n - 1; });
  const last = mine.length ? mine[mine.length - 1].content.slice(0, 1500) : '';
  sig.calmed = !!last && saysResolved(last)
    && !any([...ABUSE, ...RUDE, ...ACCUSE, ...THREAT, ...ESCALATE, ...REFUND], last);
  if (ctx.openSince) {
    const t = Date.parse(ctx.openSince);
    if (!Number.isNaN(t)) sig.waitingDays = Math.max(0, Math.floor(((ctx.now ?? Date.now()) - t) / 86_400_000));
  }
  return sig;
}

// ── The counts as a score ──────────────────────────────────────
export function heuristicScore(sig: HealthSignals): number {
  let s = 0;
  if (sig.abuse) s += Math.min(55, 35 + 10 * (sig.abuse - 1));
  if (sig.threat) s += 50;
  if (sig.accuse) s += 20;
  s += Math.min(40, sig.refund * 10);   // "refund refund refund": the customer asks again and again
  s += Math.min(12, sig.rude * 4);
  s += Math.min(12, sig.escalate * 6);
  s += Math.min(10, sig.caps * 5);
  s += Math.min(8, sig.burst * 4);
  s += Math.min(12, sig.repeats * 4);
  s += Math.min(15, (sig.chats - 1) * 5);
  // Days of waiting only matter for a customer who is already unhappy: a calm
  // "where is my order" on day 8 is not a chargeback.
  if (sig.refund + sig.abuse + sig.accuse + sig.threat + sig.escalate > 0) s += Math.min(20, sig.waitingDays * 2);
  return clamp(s);
}

// The model's number and the counts together. The model reads the whole story
// and knows when the customer has been helped and thanked, so it leads; the
// counts pull it up when it is too gentle, and a threat or swearing in the
// customer's LAST messages is never scored below 85 / 70 whatever the model
// says. Old anger does not hold a floor once the customer has calmed down, and
// a customer whose last message says the problem is solved is at most 30:
// the owner's rule is that a solved chat goes back down, whatever happened
// before it.
export function combineHealth(llm: number | null, sig: HealthSignals): number {
  const heur = heuristicScore(sig);
  const blended = llm == null ? heur : Math.max(Math.round(0.65 * llm + 0.35 * heur), llm - 8);
  if (sig.calmed) return clamp(Math.min(blended, 30));
  const floor = sig.recentThreat ? 85 : sig.recentAbuse ? 70 : 0;
  return clamp(Math.max(blended, floor));
}

// A reason from the counts alone, when the model gave none.
export function heuristicReason(sig: HealthSignals): string {
  const parts: string[] = [];
  if (sig.threat) parts.push('threatens chargeback, police, court or bad reviews');
  if (sig.abuse) parts.push('abusive language');
  if (sig.accuse) parts.push('accuses of fraud');
  if (sig.refund) parts.push(`asked for a refund or cancellation ${sig.refund} ${sig.refund === 1 ? 'time' : 'times'}`);
  if (sig.escalate) parts.push('wants to complain higher up');
  if (sig.repeats) parts.push('repeats the same message');
  if (sig.chats > 1) parts.push(`${sig.chats} chats`);
  if (sig.waitingDays >= 2 && parts.length) parts.push(`waiting ${sig.waitingDays} days`);
  const text = parts.join(', ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

// ── Asking the model ───────────────────────────────────────────
export const HEALTH_INSTRUCTION = `You rate how upset a customer of an online store is, for the support team, so that angry customers are answered first and chargebacks are avoided.
Read the chat history (oldest first; several chats of the same customer may be joined, each starting with a line beginning ===) and the order facts. Give ONE score from 0 to 100 for the customer's CURRENT frustration and how likely they are to file a chargeback or dispute:
0-24 calm: normal questions, polite, satisfied or thanked.
25-49 uneasy: mildly worried, or asking again about a delay.
50-74 frustrated: repeated complaints or demands for a refund or cancellation (even if polite), waiting a long time, ignored, or asked the same thing again by support. A polite customer asking three times for a refund on an overdue order is about 65.
75-100 critical: angry, abusive or swearing, accusing the store of fraud, or threatening (chargeback, bank, police, court, consumer forum, bad reviews).
Judge the latest state: if the customer's LAST message says the problem is solved (for example "got my order, all good"), the score is 30 or lower whatever happened before. A plain "ok thanks" after a holding answer such as "the team will check" does not mean solved.
Calibration examples:
- Polite, asks where the order is, order 2 days old: 5.
- Polite, asks once or twice when it will arrive, order 9 days old, estimated delivery still ahead: 25.
- Polite but asks three times for a refund on an overdue order: 60.
- Swears, accuses the store of fraud, or threatens a chargeback: 90.
- Swore earlier, but the last message says the problem is solved: 10.
Answer with exactly one line: the number, then " | ", then the reason. The reason is at most 100 characters, in English, plain facts. No names, phone numbers, emails or links. Example of the format: 63 | Refund asked 3 times, order 11 days old`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso: string | null | undefined): string {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return '';
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
}

export interface HealthOrderFacts {
  order_id?: string;
  placed_on?: string | null;
  status?: string | null;
  estimated_delivery?: string | null;
  cancelled?: boolean;
  payment?: string | null;
}

// One line about the customer's verified order: a customer whose order is 12
// days old and not shipped is in a different place from one on day 2.
export function healthOrderFacts(o: HealthOrderFacts | null | undefined, now = Date.now()): string {
  if (!o) return '';
  const bits: string[] = [];
  const placed = o.placed_on ? Date.parse(o.placed_on) : NaN;
  if (!Number.isNaN(placed)) bits.push(`placed ${shortDate(o.placed_on)} (${Math.max(0, Math.floor((now - placed) / 86_400_000))} days ago)`);
  if (o.status) bits.push(`status ${o.status}`);
  if (o.cancelled) bits.push('cancelled');
  const eta = o.estimated_delivery ? Date.parse(o.estimated_delivery) : NaN;
  if (!Number.isNaN(eta)) bits.push(`estimated delivery ${shortDate(o.estimated_delivery)}${eta < now ? ' (already passed)' : ''}`);
  if (o.payment) bits.push(o.payment.toLowerCase().includes('cod') ? 'cash on delivery' : 'prepaid');
  return bits.length ? `Order ${o.order_id || ''}: ${bits.join(', ')}.`.replace('Order :', 'Order:') : '';
}

const MESSAGE_CHARS = 400;

// The chat as the model reads it, oldest first. Support (AI and team) is "Support".
export function buildHealthTranscript(rows: HealthRow[], facts: string, now = Date.now()): string {
  const d = new Date(now);
  const lines: string[] = [`Today is ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}.`];
  if (facts) lines.push(facts);
  let chat: number | undefined;
  for (const r of rows) {
    if (r.chat !== chat) {
      chat = r.chat;
      lines.push(`=== ${chat === undefined ? 'Chat' : `Chat ${chat + 1}`} ===`);
    }
    let text = (r.content || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > MESSAGE_CHARS) text = text.slice(0, MESSAGE_CHARS) + '…';
    const when = shortDate(r.at);
    lines.push(`${when ? `[${when}] ` : ''}${r.sender === 'visitor' ? 'Customer' : 'Support'}: ${text}`);
  }
  return lines.join('\n');
}

export const HEALTH_REASON_MAX = 110;

// A reason for staff: one line, no links, emails or phone numbers.
export function cleanHealthReason(raw: string): string {
  let s = (raw || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}\S*/gi, ' ')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (run) => (run.replace(/\D/g, '').length >= 8 ? ' ' : run))
    .replace(/\*\*|__|`|#{1,6}\s/g, '')
    .replace(/["“”]/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^['‘’*\-–—|:,\s]+/, '').replace(/['‘’*\-–—|:,\s]+$/, '').trim();
  if (s.length > HEALTH_REASON_MAX) {
    const room = HEALTH_REASON_MAX - 1;
    let cut = s.slice(0, room + 1);
    const space = cut.lastIndexOf(' ');
    cut = space >= room / 2 ? cut.slice(0, space) : s.slice(0, room);
    s = cut.replace(/[\s,;:.\-–—]+$/, '') + '…';
  }
  return s;
}

// "82 | reason". A model may add a line of preamble, write "SCORE | 82" or
// "Score: 82" or "82%", use a dash for the bar, or put the reason on the next
// line ("reason | ..."). Null for a blank answer, or one with no number from 0
// to 100 (the next model is tried).
export function parseHealthReply(text: string | null | undefined): { score: number; reason: string } | null {
  const lines = (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const label = (r: string) => r.replace(/^\W*reason\s*[|:=-]?\s*/i, '');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\W*(?:score\s*[|:=-]?\s*)?(\d{1,3})\s*%?\s*(?:[|:\u2013\u2014-]\s*(.*))?$/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (n > 100) continue;
    let reason = label(m[2] || '');
    if (!reason && lines[i + 1] && !/^\W*(?:score\s*[|:=-]?\s*)?\d{1,3}\s*%?(\s|\||$)/i.test(lines[i + 1])) reason = label(lines[i + 1]);
    return { score: n, reason: cleanHealthReason(reason) };
  }
  return null;
}

// One customer message's words, for the chargeback risk engine (src/lib/chargeback/risk-rules.ts): the same lists.
export function textFlags(text: string): { accuse: boolean; abuse: boolean; refund: boolean } {
  const t = String(text || '').slice(0, 1500);
  return { accuse: any(ACCUSE, t), abuse: any(ABUSE, t), refund: any(REFUND, t) };
}
