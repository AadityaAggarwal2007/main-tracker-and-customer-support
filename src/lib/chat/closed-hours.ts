// ── The closed-hours note for an upset customer (owner, 2026-10-05) ──────────────
// "Saturday Sunday koi bhi courier ki taraf se jawab nahi aata ... jab customer critical level
// se paar ho, kuch aisa reasoning bhi bana sakte hain ki Saturday Sunday off hai, aur shaam
// saadhe saat se subah dus tak team active nahi rehti; subah dus baje team ke saath baith ke
// aapka case discuss karke batayenge."
//
// While the office is closed (src/lib/office-hours.ts: weekday nights, Saturday from 14:00,
// Sunday, the listed holidays) a VERIFIED customer who is very upset and keeps writing is told,
// honestly, why nobody can confirm anything right now and that the team sits down with their
// case first thing when it opens. The owner's answers (2026-10-05):
//   - only a verified customer (order ID + full phone); a visitor never hears of the team;
//   - who: Critical (frustration 75+) on their first message of a closed weekend / holiday,
//     on their second of a weekday night ("1-2 baar poochne pe"); Frustrated (50-74) on their
//     third message since the office closed; calmer customers get today's replies;
//   - how often: the full note once per closed stretch, a short line on the next message,
//     then silence (the chat is with the team, in Needs You, and the inbox shows the promise);
//   - any problem, not only a late order (answer 5); the chat widget only, not email (11).
// Rule 19 (never invent a delay reason): the note says what is true about OUR office hours
// and that courier coordination is LIMITED on weekends and holidays; it never says the courier
// is closed, never names a reason for this order's delay, and never a day of arrival (4.3).
// The lines are fixed text in English and Hinglish, never the model's; the "take up your case"
// phrase is what waiting.ts matches (AI_NOT_AN_ANSWER_REGEX), so the chat stays waiting.
// Pure: imports only escalation.ts (no imports) for the language check and the "when" words.
import { looksHinglish, teamBackWhen, type AfterHours } from './escalation';
import type { ClosedWhy } from '@/lib/office-hours';

// From this frustration score the note comes on the first weekend / holiday message, the second
// of a night; from CLOSED_NOTE_UPSET_MIN on the third message since the office closed.
export const CLOSED_NOTE_CRITICAL_MIN = 75;
export const CLOSED_NOTE_UPSET_MIN = 50;
// A team member who wrote this recently is at work: no note (they answer themselves).
export const TEAM_ACTIVE_MIN = 30;

export type ClosedNoteStep = 'full' | 'short' | 'silent';
// The marker on the AI message (messages.metadata.closed_note) that counts the notes sent.
export const CLOSED_NOTE_KEY = 'closed_note';

export interface ClosedNoteInput {
  why: ClosedWhy;                 // null = the office is open: never a note
  score: number;                  // the customer's frustration score now (effort.ts effortScore)
  asks: number;                   // the customer's messages since the office closed, this one included
  sent: number;                   // notes already sent in this closed stretch (full or short)
  teamActiveMin: number | null;   // minutes since a team member last wrote in this chat; null = never
}

// Owner 2026-10-10 (Chikki review A9 / A11: a customer who only sent the order number or "please reply" got the weekend
// note instead of their order's status, and was annoyed): "order ka status bheje; customer kuch bola toh woh weekend
// wali baat". A message that only asks where the order is (or is just the order number, "?", "reply", "hello") gets the
// status first, when Chikki has not answered yet in this closed stretch; the note comes with the customer's next
// message. Anything angry, a refund / cancel, a threat or a fraud word is never "only a status ask".
const NOT_STATUS = /\b(?:refund|cancel\w*|money\s+back|paisa\s+wapas|paise\s+wapas|fraud|scam|fake|chor|dhokha|cheat\w*|complaint|consumer|police|fir|court|legal|lawyer|chargeback|bank|dispute|worst|useless|bakwas|bekar|faltu)\b|धोखा|ठग|पैसे वापस/i;
const STATUS_WORDS = /\b(?:where|status|track\w*|update|kab|kaha|kahan|kidhar|deliver\w*|aaya|aayi|aayega|aayegi|aaega|ayega|milega|milegi|mila|mili|order|parcel|package|shipment|reply|jawab|respond|hello|hi|hey|hlo|sir|madam|mam|please|plz|pls)\b|कहाँ|कब|ऑर्डर/i;
export function asksStatusOnly(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length > 160 || NOT_STATUS.test(t)) return false;
  if (/^[\s?!.]+$/.test(t)) return true;                                   // "?", "..."
  if (/^(?:order\s*(?:id|no\.?|number)?\s*[:#-]?\s*)?#?\s*[a-z]{0,4}\d{3,}\s*$/i.test(t)) return true;   // just the order number
  return t.split(/\s+/).length <= 14 && STATUS_WORDS.test(t);
}

// Which note this message gets: 'full' the first time, 'short' the second, 'silent' after that
// (nothing is sent), null = this customer or moment does not qualify (today's replies).
export function closedNoteStep(i: ClosedNoteInput): ClosedNoteStep | null {
  if (!i.why) return null;
  if (i.teamActiveMin !== null && i.teamActiveMin < TEAM_ACTIVE_MIN) return null;
  const need = i.score >= CLOSED_NOTE_CRITICAL_MIN ? (i.why === 'night' ? 2 : 1)
    : i.score >= CLOSED_NOTE_UPSET_MIN ? 3 : Infinity;
  if (i.asks < need) return null;
  return i.sent <= 0 ? 'full' : i.sent === 1 ? 'short' : 'silent';
}

// Why nobody can confirm anything right now, in the customer's language.
function whyLine(why: Exclude<ClosedWhy, null>, hi: boolean): string {
  if (why === 'weekend') {
    return hi
      ? 'Weekend pe hamara office band rehta hai, aur courier ke saath coordination bhi weekend pe limited rehti hai, isliye abhi pakka update dena mushkil hai.'
      : "Our office is closed over the weekend, and courier coordination is limited on weekends too, so I can't get you a confirmed update right now.";
  }
  if (why === 'holiday') {
    return hi
      ? 'Chhutti ki wajah se hamara office band hai, aur courier movement bhi limited hai, isliye abhi pakka update dena mushkil hai.'
      : "Our office is closed for the holiday, and courier movement is limited too, so I can't get you a confirmed update right now.";
  }
  return hi
    ? 'Abhi hamari team office mein nahi hai (hum 10 AM se 7:30 PM tak hote hain), isliye abhi pakka update dena mushkil hai.'
    : "Our team is not in the office right now (we're here from 10 AM to 7:30 PM), so I can't get you a confirmed update at this hour.";
}

// The note itself. `after` says when the team is back (office-hours.ts afterHours; never null
// while `why` is set). 'silent' gives null: nothing is sent.
export function closedNote(customerText: string, why: Exclude<ClosedWhy, null>, after: Exclude<AfterHours, null>, step: ClosedNoteStep): string | null {
  if (step === 'silent') return null;
  const hi = looksHinglish(customerText);
  const when = teamBackWhen(after, hi);
  if (step === 'short') {
    return hi
      ? `Hamari team ${when} sabse pehle aapka case dekhegi aur isi chat mein aapko update degi. Aapke patience ke liye shukriya.`
      : `Our team will take up your case first thing ${when}, and update you here in this chat. Thank you for your patience.`;
  }
  const whenCap = when.charAt(0).toUpperCase() + when.slice(1);
  return hi
    ? `Aapki pareshani samajh aati hai, aur iske liye hamein afsos hai. ${whyLine(why, true)} ${whenCap} hamari team sabse pehle aapka case lekar baithegi, shipping partner se baat karegi, aur isi chat mein aapko update degi.`
    : `I understand how frustrating this has been, and I'm sorry. ${whyLine(why, false)} ${whenCap}, our team will sit down with your case first thing, take it up with the shipping partner, and update you here in this chat.`;
}

// The status a customer gets first (owner 2026-10-10, see asksStatusOnly), from the tracking page's own words: the
// order, its stage, the estimated date (not for a late order: its date is being confirmed), the tracking link. Never
// "today", never a reason, never a promise. null = nothing to say (no order).
export interface StatusFacts { order_id: string; status: string; eta: string | null; late: boolean; tracking_link: string | null }
export function statusLine(f: StatusFacts | null, customerText: string): string | null {
  if (!f || !f.order_id || !f.status) return null;
  const hi = looksHinglish(customerText);
  const date = f.eta && !f.late ? new Date(f.eta).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }) : null;
  const id = f.order_id.startsWith('#') ? f.order_id : `#${f.order_id}`;
  if (hi) {
    return `Aapka order ${id} abhi "${f.status}" stage par hai${date ? `, estimated delivery ${date}` : ''}.${f.tracking_link ? ` Yahan track kar sakte hain: ${f.tracking_link}` : ''}`;
  }
  return `Your order ${id} is at the "${f.status}" stage${date ? `, estimated delivery ${date}` : ''}.${f.tracking_link ? ` You can follow it here: ${f.tracking_link}` : ''}`;
}

// Matched by waiting.ts (a Postgres regex, case-insensitive) against the AI's last message: a
// chat ending in a closed-hours note is still waiting for the team. No apostrophes.
export const CLOSED_NOTE_REGEX = '(sit down with|take up) your case|sabse pehle aapka case';

// Remove the fixed team lines (the 1-hour / 24-hour / morning lines of escalation.ts) from a
// reply so the note is the only promise in it. Exact lines only; the caller passes the ones it
// could have added. Blank lines are tidied.
export function withoutTeamLines(text: string, lines: string[]): string {
  let out = String(text || '');
  for (const l of lines) if (l) out = out.split(l).join('');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
