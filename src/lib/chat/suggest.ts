// ── Suggested replies for the team (owner 2026-10-04) ──────────────────────────────
// "Ladkon ke saath dikkat hai: bahut spelling mistake, dhang se baat nahi karte. Pre-filled
// message bana de, 3-4 option, chun lo ya khud type karo." When a team member opens a verified
// customer's chat, Chikki drafts SUGGEST_COUNT replies the team member could send, in the
// team's own manner (the same prompt Chikki answers with: the panel prompt, saved answers,
// Brain notes, team examples and the locked rules) and in the customer's language; a click
// puts one in the reply box, the team member sends it as it is or edits it first. "Sudharo"
// fixes the spelling and grammar of whatever they typed themselves. The team member stays
// the sender: the drafts speak as the team ("I" / "hum"), never as Chikki.
//
// This file is pure: the instruction blocks, the parser for the model's answer and the guards
// every option goes through (the same guards as Chikki's own replies: no "today / tomorrow",
// no form link, no chargeback advice, no address echo, no courier name). suggest-run.ts does
// the database and the model call.
import type { AfterHours, ClosedWhy } from '@/lib/office-hours';
import { dropFormMentions, hasFormLink } from '@/lib/refund/link-mask';
import { dropDisputeAdvice } from './dispute-advice';
import { looksHinglish, teamBackWhen, weekdayLabel } from './escalation';
import { dropAddressEcho, stripLinkJunk, withoutUnaskedCourier } from './reply-guards';
import { dropTodayPromise } from './today-promise';

export type SuggestLang = 'auto' | 'en' | 'hi';
export const SUGGEST_LANGS: SuggestLang[] = ['auto', 'en', 'hi'];
export const SUGGEST_COUNT = 3;
export const SUGGEST_MAX_CHARS = 600;
// How much of the chat the drafts see.
export const SUGGEST_HISTORY = 30;
export const SUGGEST_MAX_TOKENS = 900;
export const SUGGEST_TIMEOUT_MS = 25_000;
export const POLISH_MAX_CHARS = 2000;
export const POLISH_TIMEOUT_MS = 15_000;

const LANG_LINE: Record<SuggestLang, string> = {
  auto: 'Write every option in the language the customer wrote their latest messages in: Hinglish stays Hinglish (Roman letters), Hindi script stays Hindi, English stays English.',
  en: 'Write every option in plain, simple English, whatever language the customer used.',
  hi: 'Write every option in Hinglish (Hindi in Roman letters, the way people text), whatever language the customer used.',
};

const TEAM_TIME: Record<'day' | 'tomorrow' | 'this_morning', string> = {
  day: 'If an option says when the team comes back to the customer: "shortly, here in this chat"; for a refund or cancellation decision "within 24 hours, here in this chat". Never "within 1 hour".',
  tomorrow: 'It is after office hours now (the team works 10:00 to 19:30 IST). If an option says when the team comes back to the customer, it is "tomorrow morning, after 10 AM, here in this chat" ("kal subah 10 baje ke baad isi chat mein"); never "within 1 hour" or "within 24 hours".',
  this_morning: 'It is before office hours now (the team works 10:00 to 19:30 IST). If an option says when the team comes back to the customer, it is "this morning, after 10 AM, here in this chat" ("aaj subah 10 baje ke baad isi chat mein"); never "within 1 hour" or "within 24 hours".',
};
// The week (owner 2026-10-05): the office is closed until a named day (Saturday is a half day,
// Sunday and the listed holidays are off), so the time line names it: "on Monday morning".
function teamTimeLine(after: AfterHours): string {
  if (!after) return TEAM_TIME.day;
  if (after === 'tomorrow' || after === 'this_morning') return TEAM_TIME[after];
  return `It is outside office hours now (the team works Monday to Friday 10:00 to 19:30 IST and Saturday to 14:00; Sunday and holidays off). If an option says when the team comes back to the customer, it is "${teamBackWhen(after, false)}, here in this chat" ("${teamBackWhen(after, true)} isi chat mein"); never "within 1 hour" or "within 24 hours", never "tomorrow".`;
}
// An upset customer while the office is closed (closed-hours.ts, owner 2026-10-05): one option may
// say honestly why nobody can confirm anything right now and that we sit down with their case first
// thing when the office opens. The same limits as Chikki's note: never that the courier is closed,
// never a reason for THIS order's delay.
const CLOSED_WHY_LINE: Record<Exclude<ClosedWhy, null>, string> = {
  weekend: 'our office is closed over the weekend and courier coordination is limited on weekends too',
  holiday: 'our office is closed for the holiday and courier movement is limited too',
  night: 'our team is not in the office right now (we are here from 10 AM to 7:30 PM)',
};
function upsetClosedLine(why: ClosedWhy, after: AfterHours): string {
  if (!why || !after) return '';
  const day = weekdayLabel(after);
  const when = day ? `on ${day} morning, after 10 AM` : after === 'tomorrow' ? 'tomorrow morning, after 10 AM' : 'this morning, after 10 AM';
  return `
- This customer is very upset and the office is closed. One option may say, honestly, that ${CLOSED_WHY_LINE[why]}, so we cannot confirm anything right now, and that ${when} we sit down with their case first thing, take it up with the shipping partner and update them here. Never say the courier is closed or off, never give a reason for this order's delay, never a day of arrival.`;
}

export interface SuggestContext {
  lang: SuggestLang;
  after: AfterHours;
  caseKind: 'refund' | 'reship' | null;
  // The verified order as Chikki's lookup shows it (orders.ts toFoundOrder), as JSON text; null = none.
  orderJson: string | null;
  // Why the office is closed now (office-hours.ts closedWhy) when the customer is upset enough for the
  // closed-hours note (closed-hours.ts CLOSED_NOTE_UPSET_MIN); null or missing = the usual lines.
  upsetClosed?: ClosedWhy;
  // 'email' (owner 2026-10-09: the drafts show in email chats too) = the reply goes out by email, so each option is a
  // short, complete mail; missing or 'chat' = the chat box. storeName = the panel's name (never a fixed brand here).
  channel?: 'chat' | 'email';
  storeName?: string | null;
}

// Appended to Chikki's full system prompt (rules, saved answers, Brain, team examples): what to
// draft and how. It overrides the chat-box persona lines above it, because here Chikki is not the
// one replying.
export function suggestInstruction(ctx: SuggestContext): string {
  const when = teamTimeLine(ctx.after);
  const caseLine = ctx.caseKind === 'refund'
    ? 'This chat is in the Refund section: the team is handling the refund. Options may say the team is on it and that the refund form / the next step comes here in this chat from the team; never an amount, a date, a payment method, "approved" / "processed", and never a form link.'
    : ctx.caseKind === 'reship'
      ? 'This chat is in the Ship again section: the team sends a new parcel. Options may say the new tracking link comes here in this chat within 24-48 hours; never a day of arrival.'
      : '';
  const store = (ctx.storeName || '').trim();
  const team = store ? `the ${store} support team` : 'our support team';
  const signOff = store ? `${store} Support` : 'Support Team';
  const email = ctx.channel === 'email';
  const here = email ? 'by email' : 'here in this chat';
  return `

DRAFTING FOR A TEAM MEMBER (this overrides the lines above about who you are and how you reply)
You are not replying yourself. A member of ${team} has this ${email ? 'email conversation' : 'chat'} open and will send ONE of the replies you draft, as themselves, under the team's name. Draft exactly ${SUGGEST_COUNT} options for their next reply to the customer's latest ${email ? 'email' : 'message'}.
- ${email
    ? 'Each option is a complete, short email: an opening line ("Hi <first name>," when the name is in ORDER FACTS, else "Hi,"), 2 to 5 short sentences, and a closing line "Regards, ' + signOff + '". No subject line, no markdown, no bullet points, no emoji. Perfect spelling, grammar and punctuation: nobody will correct it.'
    : 'Each option is a complete reply, 1 to 3 short sentences, the way a person texts: no greeting block, no sign-off, no markdown, no bullet points, at most one emoji. Perfect spelling, grammar and punctuation: nobody will correct it.'}
- ${LANG_LINE[ctx.lang]}
- The three take different approaches, never three wordings of one sentence: option 1 short and direct (the fact and the next step); option 2 warmer, with an apology where the customer had trouble, and the next step; option 3 a different angle (a clarifying question, a reassurance, or the alternative the team can offer).
- The sender IS the team, so the team is "we", never a third party: "we will get back to you", "I'll check and update you here", "hum dekh ke batate hain". Never "our team will reply", "the team will review", "a person will reply", "I am passing this to the team"; never mention Karry, Chikki, an AI, a bot or anything automated. (A reply already sent in this chat may say "our team will reply": your options do not repeat that; they are the team's own answer.)
- Facts only from ORDER FACTS below and from what the customer wrote. Give the status, the estimated date (call it estimated) and the tracking link when they help. Never invent a scan, a city, a reason, a courier name or a date. If ORDER FACTS says the date is being confirmed, give no date.
- Never: a day of arrival (today, tonight, tomorrow, aaj, kal); a refund amount, date or method, or "approved" / "processed"; any form or link other than the tracking link in ORDER FACTS; a courier's name (say "our courier partner"); advice to raise a chargeback, a bank or UPI dispute, a police or consumer complaint; asking the customer for anything except the order ID and the phone number on the order; a payment link or "pay again"; a customer-care number.
- ${email ? when.replace(/here in this chat/g, here).replace(/isi chat mein/g, 'email par') : when}${upsetClosedLine(ctx.upsetClosed ?? null, ctx.after)}
${caseLine ? `- ${caseLine}\n` : ''}- Answer what the customer actually asked. Never repeat a reply already sent in this ${email ? 'conversation' : 'chat'}.

ORDER FACTS
${ctx.orderJson || 'No verified order facts are available: give no status or date.'}

Output ONLY this JSON, nothing before or after it:
{"options": ["option 1", "option 2", "option 3"]}`;
}

// The model's answer -> up to SUGGEST_COUNT distinct texts. JSON first (also inside a code fence),
// else numbered / dashed lines, else the whole text as one option.
export function parseOptions(raw: string | null | undefined): string[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, SUGGEST_MAX_CHARS);
  const unique = (list: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of list.map(clean).filter(Boolean)) {
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
      if (out.length >= SUGGEST_COUNT) break;
    }
    return out;
  };
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1)) as { options?: unknown };
      if (Array.isArray(parsed.options)) return unique(parsed.options.map((o) => (typeof o === 'string' ? o : '')));
    } catch { /* not JSON: fall through */ }
  }
  const lines = body.split(/\n+/).map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•]|option\s*\d+\s*[:.)-])\s*/i, '').trim()).filter(Boolean);
  if (lines.length >= 2) return unique(lines);
  return unique([body]);
}

export interface GuardContext {
  // The customer's own messages in this chat, oldest first (the address-echo guard reads the last 8).
  customerTexts: string[];
  // The courier(s) the lookup named: never in an option.
  courierNames: string[];
}

// The sender is the team (seen live 4 Oct: all three drafts said "Our team will get back to you"
// although a team member sends them): "our team / the team will ..." becomes "we will ...", with
// the verb kept. English only; Hinglish verb endings would need rewriting, so the prompt carries it.
const TEAM_THIRD = /\b(?:our|the) (?:support )?team (will|can|is going to|is|are|has|have)\b/gi;
export function asTeam(text: string): string {
  const out = text.replace(TEAM_THIRD, (_m, verb: string) => {
    const v = verb.toLowerCase();
    const w = v === 'is' ? 'are' : v === 'has' ? 'have' : v === 'is going to' ? 'are going to' : v;
    return `we ${w}`;
  });
  // A sentence now starting with "we": capitalised.
  return out.replace(/(^|[.!?]\s+)we\b/g, (_m, pre: string) => `${pre}We`);
}

// Every option goes through Chikki's own reply guards; one that is left empty, or still carries a
// form link, is dropped. The same text never appears twice.
export function guardOptions(options: string[], ctx: GuardContext): string[] {
  const latest = ctx.customerTexts[ctx.customerTexts.length - 1] || '';
  const hinglish = looksHinglish(ctx.customerTexts.slice(-2).join('\n'));
  const out: string[] = [];
  for (const raw of options) {
    let text = String(raw || '').trim();
    if (!text) continue;
    const form = dropFormMentions(text, hinglish);
    if (form.emptied) continue;
    text = form.text;
    const dispute = dropDisputeAdvice(text);
    if (dispute.emptied) continue;
    text = dispute.text;
    text = dropTodayPromise(text, '').trim();
    if (!text) continue;
    text = dropAddressEcho(text, ctx.customerTexts.slice(-8)).text;
    text = withoutUnaskedCourier(text, latest, ctx.courierNames, 0).text;
    text = asTeam(text).replace(/\s+/g, ' ').trim();
    // A link pasted into the chat from ChatGPT (utm_source=chatgpt.com) is copied without that tag (owner 2026-10-05).
    text = stripLinkJunk(text).text;
    if (!text || hasFormLink(text)) continue;
    if (out.some((o) => o.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
  }
  return out.slice(0, SUGGEST_COUNT);
}

// "Sudharo": the team member's own draft, spelling and grammar fixed, nothing else.
export const POLISH_INSTRUCTION = `You fix the spelling, grammar and punctuation of a short reply that a Vastora support team member is about to send to a customer in live chat.
Keep everything else exactly as it is: the meaning, the language (Hinglish stays Hinglish in Roman letters, Hindi stays Hindi, English stays English), the tone, every fact, number, date, amount, name, order ID and link, the line breaks and any emoji. Do not add a greeting, a sign-off, an apology, a promise or any sentence that is not there; do not remove or soften anything; do not answer the customer yourself. If the draft is already correct, return it unchanged.
Output the corrected reply text only: no quotes, no explanation, no labels.`;

export function polishUserMessage(draft: string, customerLatest: string | null): string {
  const ctx = customerLatest ? `The customer's latest message, for context only (do not answer it):\n${customerLatest.slice(0, 600)}\n\n` : '';
  return `${ctx}The team member's draft:\n${draft}`;
}

// The model's corrected text, or the draft itself when the answer is not a plain correction
// (empty, wrapped in quotes and labels, far longer or shorter, or carrying a link that was not
// there: the team member's words go out, not the model's).
export function acceptPolish(draft: string, raw: string | null | undefined): string {
  // The team member's own link loses a ChatGPT / ad tag too (owner 2026-10-05); the model's answer is
  // cleaned the same way, so the "same links" check below compares clean with clean.
  const d = stripLinkJunk(draft.trim()).text;
  raw = stripLinkJunk(String(raw || '')).text;
  let out = String(raw || '').trim();
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  out = out.replace(/^(?:corrected(?: reply| text)?|reply|output)\s*:\s*/i, '').trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) out = out.slice(1, -1).trim();
  if (!out) return d;
  if (out.length > d.length * 1.6 + 40 || out.length < d.length * 0.5 - 10) return d;
  const links = (s: string) => (s.match(/https?:\/\/\S+/g) || []).map((l) => l.replace(/[.,;:!?)]+$/, ''));
  const before = links(d), after = links(out);
  if (after.length !== before.length || after.some((l) => !before.includes(l))) return d;
  return out;
}
