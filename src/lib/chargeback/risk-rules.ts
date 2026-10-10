// ── Chargeback Shield: which PREPAID order is about to become a chargeback, and what to do (owner 2026-10-10) ──
// Owner: "chargeback bilkul tarike se rok paaye ... Gmail aur chat support dono ki connectivity ... kaun se customers ko
// website fake lag rahi hai, link fake lag raha hai, time bahut zyada lag raha hai ... jo critical level pe hain ...
// reship kar paaye ya jisko lagta hai chargeback marega usko refund kar paaye ... saari chat Sunny ke paas ... Super Admin
// ko bhi pata chale."
// Pure: one order, the customer's messages on every channel (chat box, email, WhatsApp) up to a moment, and a few facts ->
// a score 0-100, a level, the reasons in plain words and the ONE next step for the team. It restates the existing rules
// (the tracking-claim Ship again path, the threat-on-a-late-order Refund path, the family check for Delivered, the
// waiting test); it never writes to the customer and never decides a refund by itself: the Manager / Super Admin does.
// A Cash on Delivery order cannot be charged back (nothing was paid by card / UPI), so the loader never sends one here.
// Imports only pure files (no database).
import { textFlags, saysResolved } from '@/lib/chat/health-rules';
import { refundThreatKind, etaOf, istDay } from '@/lib/chat/refund-threat';
import { trackingClaimKind } from '@/lib/chat/tracking-claim';
import { isDelayAsk } from '@/lib/chat/delay-ladder';
import { saysNotReceived } from '@/lib/chat/reply-guards';
import { AI_NOT_AN_ANSWER_REGEX, NO_REPLY_NEEDED_REGEX } from '@/lib/chat/waiting';

export type RiskLevel = 'low' | 'watch' | 'high' | 'critical';
export const LEVEL_MIN: Record<Exclude<RiskLevel, 'low'>, number> = { watch: 30, high: 50, critical: 70 };
export const levelOf = (score: number): RiskLevel =>
  score >= LEVEL_MIN.critical ? 'critical' : score >= LEVEL_MIN.high ? 'high' : score >= LEVEL_MIN.watch ? 'watch' : 'low';

export type Channel = 'chat' | 'email' | 'whatsapp';
export interface RiskMsg { sender: string; content: string; at: number; channel: Channel; chatId: string; hidden?: boolean }
export interface RiskOrder {
  orderId: string; businessId: string;
  placedAt: number; estimatedDelivery: string | null;
  delivered: boolean; total: number;
}
export interface RiskFacts {
  healthMax: number;            // the highest health_score of the customer's chats (0 when none)
  caseKind: 'refund' | 'reship' | null;
  reshipped: boolean;           // Ship again: the new parcel went out
  priorChargebacks: number;     // real chargebacks on this customer's other orders (same phone / email)
  chargedBack: boolean;         // a real chargeback already names THIS order
}

export type SignalKey =
  | 'threat_chargeback' | 'threat_legal' | 'fake_site' | 'site_doubt' | 'fake_link' | 'stuck_link' | 'not_received'
  | 'late' | 'refund_ask' | 'many_asks' | 'unanswered' | 'upset' | 'channels' | 'prior_chargeback' | 'high_value'
  | 'calmed' | 'reshipped' | 'delivered';
export interface RiskSignal { key: SignalKey; points: number; text: string }

export type ActionKey = 'charged_back' | 'refund' | 'family_check' | 'reship' | 'reassure' | 'reply' | 'watch';
export interface RiskAction { key: ActionKey; text: string }

export interface RiskResult {
  score: number; level: RiskLevel; signals: RiskSignal[]; action: RiskAction;
  daysLate: number;               // India days past the estimated date (0 = not late)
  waitingHours: number | null;    // the customer's unanswered wait, null = nobody is waiting
  lastCustomerAt: number | null;
  channels: Channel[];
}

// "this website is fake / a fraud", "aap log fraud ho", "scam site": the store itself, not the tracking link (that is
// trackingClaimKind). "is this site genuine / legit / trusted?", "asli hai?": a doubt, lower.
const STORE = '(?:web ?site|site|store|shop|brand|company|page|insta(?:gram)?|you(?: people| guys)?|u people|aap(?: log| ki| ka)?|tum(?: log)?|ye log|yeh log|vastra\\w*|seller)';
const FAKE = '(?:fake|fraud\\w*|froud|scam\\w*|cheat\\w*|chor\\w*|dhok\\w*|thag\\w*|farzi|nakli|duplicate|not (?:genuine|real|legit))';
const FAKE_SITE = [
  new RegExp(`\\b${STORE}\\b[^.?!\\n]{0,40}\\b${FAKE}`, 'i'),
  new RegExp(`\\b${FAKE}\\b[^.?!\\n]{0,25}\\b${STORE}\\b`, 'i'),
  /\b(?:fraud|scam|scammer|scammers|frauds|fraudster|cheaters?|chor log|dhokebaaz)\b/i,
  /(फर्जी|फ़र्ज़ी|नकली|धोखा|धोखेबाज|फ्रॉड|ठग)/,
];
const DOUBT = [
  /\b(?:genuine|legit|legitimate|trusted|trustworthy|real (?:web ?site|site|store|company)|safe to (?:order|buy|pay))\b/i,
  /\b(?:asli|bharosa|bharosemand|trust kar)\b/i,
];
// A fake claim about the LINK only (no store word) is the tracking claim's, never the store's.
const LINK_ONLY = /\b(?:tracking|track|link|awb)\b/i;
const SITE_WORD = /\b(?:web ?site|site|store|shop|company|brand)\b/i;
const fakeSite = (t: string) => FAKE_SITE.some((re) => re.test(t)) && !(LINK_ONLY.test(t) && !SITE_WORD.test(t));
const doubtsSite = (t: string) => DOUBT.some((re) => re.test(t));

const NOT_ANSWER = new RegExp(AI_NOT_AN_ANSWER_REGEX, 'i');
// A Postgres regex: its [:space:] class is \s in JavaScript.
const NO_REPLY = new RegExp(NO_REPLY_NEEDED_REGEX.replace(/\[:space:\]/g, '\\s'), 'i');
const visible = (m: RiskMsg) => !m.hidden && (m.content || '').trim() !== '';

// The customer's unanswered wait at `now`: from their first message after our last real answer (team or a real AI
// answer; a "took longer" / "the team will confirm" line is not one), unless it is only "ok / thanks".
export function waitingSince(msgs: RiskMsg[]): number | null {
  let since: number | null = null;
  for (const m of msgs) {
    if (!visible(m)) continue;
    if (m.sender === 'visitor') { if (since === null && !NO_REPLY.test(m.content.trim())) since = m.at; }
    else if (m.sender === 'agent' || (m.sender === 'ai' && !NOT_ANSWER.test(m.content))) since = null;
  }
  return since;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function scoreOrder(order: RiskOrder, allMsgs: RiskMsg[], facts: RiskFacts, now: number): RiskResult {
  const msgs = allMsgs.filter((m) => m.at <= now).sort((a, b) => a.at - b.at);
  const mine = msgs.filter((m) => m.sender === 'visitor' && visible(m));
  const signals: RiskSignal[] = [];
  const add = (key: SignalKey, points: number, text: string) => signals.push({ key, points, text });

  let cb = 0, legal = 0, fake = 0, doubt = 0, fakeLink = 0, stuck = 0, notRecv = 0, refund = 0, asks = 0;
  for (const m of mine) {
    const t = m.content.slice(0, 2000);
    const th = refundThreatKind(t);
    if (th === 'chargeback') cb++; else if (th) legal++;
    const claim = trackingClaimKind(t);
    if (claim === 'fake' || claim === 'invalid') fakeLink++; else if (claim === 'stuck') stuck++;
    if (!claim && fakeSite(t)) fake++; else if (!claim && doubtsSite(t)) doubt++;
    if (saysNotReceived(t)) notRecv++;
    if (textFlags(t).refund) refund++;
    if (isDelayAsk(t)) asks++;
  }

  const eta = etaOf({ estimated_delivery: order.estimatedDelivery, placed_on: new Date(order.placedAt).toISOString() });
  const daysLate = !order.delivered && eta != null ? Math.max(0, istDay(now) - istDay(eta)) : 0;
  const since = waitingSince(msgs);
  const waitingHours = since === null ? null : Math.max(0, (now - since) / 3_600_000);
  const channels = Array.from(new Set(mine.map((m) => m.channel)));
  const chats = new Set(mine.map((m) => m.chatId)).size;

  if (facts.priorChargebacks > 0) add('prior_chargeback', 40, `Raised a chargeback before (${plural(facts.priorChargebacks, 'time')})`);
  if (cb) add('threat_chargeback', 45, `Talked about a chargeback / bank dispute (${plural(cb, 'message')})`);
  if (legal) add('threat_legal', 35, `Threatened consumer court / police / legal action`);
  if (order.delivered && notRecv) add('not_received', 30, 'Marked Delivered, but says the parcel did not come');
  if (fake) add('fake_site', fake > 1 ? 35 : 25, `Called the store fake / a fraud${fake > 1 ? ` (${fake} times)` : ''}`);
  else if (doubt) add('site_doubt', 10, 'Asked whether the store is genuine');
  if (fakeLink) add('fake_link', 20, 'Says the tracking link is fake / invalid / not opening');
  else if (stuck) add('stuck_link', 12, 'Says the tracking has not moved');
  if (daysLate >= 6) add('late', 30, `${daysLate} days past the delivery date`);
  else if (daysLate >= 3) add('late', 20, `${daysLate} days past the delivery date`);
  else if (daysLate >= 1) add('late', 10, `${plural(daysLate, 'day')} past the delivery date`);
  if (refund) add('refund_ask', refund >= 3 ? 18 : 12, `Asked for a refund / cancel (${plural(refund, 'time')})`);
  if (asks >= 3) add('many_asks', 10, `Asked where the order is ${asks} times`);
  if (waitingHours !== null && waitingHours >= 24) add('unanswered', 20, `Waiting for our reply for ${Math.floor(waitingHours)} hours`);
  else if (waitingHours !== null && waitingHours >= 2) add('unanswered', 10, `Waiting for our reply for ${Math.floor(waitingHours)} hours`);
  if (facts.healthMax >= 75) add('upset', 15, `Very upset (${facts.healthMax}%)`);
  else if (facts.healthMax >= 50) add('upset', 8, `Upset (${facts.healthMax}%)`);
  if (channels.length >= 2 || chats >= 3) add('channels', 8, channels.length >= 2 ? `Wrote on ${channels.join(' + ')}` : `Opened ${chats} chats`);
  if (order.total >= 2500 && signals.length) add('high_value', 5, `A big order (₹${Math.round(order.total)})`);

  // What brings it down: the customer said it is solved, the new parcel went out, or it was delivered and nobody says otherwise.
  const last = mine.length ? mine[mine.length - 1].content : '';
  const lastBad = refundThreatKind(last) || textFlags(last).accuse || textFlags(last).refund;
  if (last && saysResolved(last) && !lastBad) add('calmed', -30, 'Last message: says it is solved');
  if (facts.reshipped) add('reshipped', -15, 'The new parcel has gone out');
  if (order.delivered && !notRecv) add('delivered', -20, 'Delivered, and nobody says otherwise');

  let score = Math.max(0, Math.min(100, signals.reduce((s, x) => s + x.points, 0)));
  if (facts.chargedBack) score = 100;
  // A customer who never wrote to us is not on the list (most late orders are only not marked Delivered yet), unless they
  // raised a chargeback before. The study (risk.ts loadStudy) counts such "silent" chargebacks separately.
  if (!facts.chargedBack && !facts.priorChargebacks && !mine.length) score = Math.min(score, LEVEL_MIN.watch - 1);
  const level = levelOf(score);
  const has = (k: SignalKey) => signals.some((s) => s.key === k);

  return {
    score, level, signals: signals.sort((a, b) => b.points - a.points),
    action: riskAction({ has, facts, daysLate, waiting: waitingHours !== null }),
    daysLate, waitingHours, lastCustomerAt: mine.length ? mine[mine.length - 1].at : null, channels,
  };
}

// The ONE next step, in the order the owner's existing rules put them. Staff words only.
export function riskAction(x: { has: (k: SignalKey) => boolean; facts: RiskFacts; daysLate: number; waiting: boolean }): RiskAction {
  const { has, facts } = x;
  if (facts.chargedBack) return { key: 'charged_back', text: 'Chargeback raised: answer the gateway with proof (tracking, chat, delivery) today.' };
  if (has('threat_chargeback') || has('threat_legal') || has('prior_chargeback')) {
    if (has('delivered')) return { key: 'reassure', text: 'Delivered: share the delivery proof and the tracking link calmly; do not argue.' };
    return facts.caseKind === 'refund'
      ? { key: 'refund', text: 'In Refund: send the refund form and close it before they go to the bank.' }
      : { key: 'refund', text: 'Chargeback risk: offer the refund (mark Refund, send the form) before they go to the bank.' };
  }
  if (has('not_received')) return { key: 'family_check', text: 'Ask them to check with family / neighbours / security; if still not found, Ship again.' };
  if (has('fake_link') || has('stuck_link') || x.daysLate >= 6) {
    return facts.reshipped
      ? { key: 'reassure', text: 'New parcel sent: share its tracking link and keep them updated.' }
      : facts.caseKind === 'reship'
        ? { key: 'reship', text: 'In Ship again: send the new parcel and give them the new tracking link.' }
        : { key: 'reship', text: 'Ship again with a new tracking link (or refund if they insist).' };
  }
  if (has('fake_site') || has('site_doubt')) return { key: 'reassure', text: 'Reassure: share their tracking link and that the store is genuine.' };
  if (has('refund_ask') && x.daysLate >= 1) return { key: 'refund', text: 'Late and asking for money back: decide refund or Ship again today.' };
  if (x.waiting) return { key: 'reply', text: 'Reply now: they are waiting for us.' };
  return { key: 'watch', text: 'Keep an eye: reply with the tracking link and the delivery date.' };
}

// ── The chargeback mail -> the order, when the mail names no order number (owner's 3 "order not found") ──
// A gateway's dispute mail usually names the customer's email or phone and the amount, not the Shopify order number.
// Pure: the candidates only; the server checks them against the panel's orders and accepts ONE order or none.
const GATEWAY_DOMAINS = /(payu|razorpay|cashfree|payglocal|paytm|phonepe|stripe|instamojo|ccavenue|easebuzz|billdesk|juspay|paypal|shopify|google|gmail-noreply|noreply|no-reply)/i;
export function contactCandidates(text: string): { emails: string[]; phones: string[]; amounts: number[] } {
  const hay = String(text || '').slice(0, 8000);
  const emails = Array.from(new Set((hay.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map((e) => e.toLowerCase())))
    .filter((e) => !GATEWAY_DOMAINS.test(e.split('@')[1] || '') && !/^(?:support|care|help|chargeback|dispute|noreply|no-reply|info|admin)@/.test(e))
    .slice(0, 5);
  const phones = Array.from(new Set((hay.match(/(?<![\d])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\d])/g) || [])
    .map((p) => p.replace(/\D/g, '').slice(-10)))).slice(0, 5);
  const amounts = Array.from(new Set(Array.from(hay.matchAll(/(?:₹|rs\.?|inr)\s?([\d,]{2,9}(?:\.\d{1,2})?)/gi))
    .map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n >= 50 && n <= 500000))).slice(0, 5);
  return { emails, phones, amounts };
}

// The signal's short name, for the study's "what came before the chargebacks" counts.
export const SIGNAL_NAME: Record<SignalKey, string> = {
  threat_chargeback: 'Talked about a chargeback / bank dispute', threat_legal: 'Threatened court / police / legal',
  fake_site: 'Called the store fake / a fraud', site_doubt: 'Asked if the store is genuine', fake_link: 'Tracking link fake / invalid',
  stuck_link: 'Tracking not moving', not_received: 'Delivered but not received', late: 'Past the delivery date',
  refund_ask: 'Asked for refund / cancel', many_asks: 'Asked 3+ times where the order is', unanswered: 'Waited 2+ hours for our reply',
  upset: 'Upset (health 50%+)', channels: 'Wrote on several channels / chats', prior_chargeback: 'Raised a chargeback before',
  high_value: 'Big order', calmed: 'Said it is solved', reshipped: 'New parcel sent', delivered: 'Delivered',
};

// The WhatsApp alert's one line (a template variable: no line breaks, no tabs, no long runs of spaces; Meta refuses them).
export function riskAlertText(i: { score: number; orderId: string; panelName: string; customerName?: string; signals: RiskSignal[]; action: RiskAction }): string {
  const why = i.signals.filter((s) => s.points > 0).slice(0, 3).map((s) => s.text).join('; ');
  const t = `Chargeback risk CRITICAL (${i.score}): order ${i.orderId} on ${i.panelName}${i.customerName ? `, ${i.customerName}` : ''}. ${why}. Next step: ${i.action.text}`;
  return t.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').slice(0, 600);
}
// WhatsApp alerts go out 09:00-22:00 India time only (the owner's phone at night stays quiet; the list keeps them).
export function alertHourOk(now: number): boolean {
  const h = Math.floor(((now + 330 * 60_000) % 86_400_000) / 3_600_000);
  return h >= 9 && h < 22;
}

export const LEVEL_TEXT: Record<RiskLevel, string> = { low: 'Low', watch: 'Watch', high: 'High', critical: 'Critical' };
