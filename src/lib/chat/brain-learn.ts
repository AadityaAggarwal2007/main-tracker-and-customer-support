// ── The Brain's learning loop (owner, 2026-10-01) ────────────────────────────────
// The system SUGGESTS, the owner APPROVES. A chat where a team member answered the customer
// shows how the store wants such a question handled; once a day one small model call reads
// each new such chat (personal details masked first) and either drafts ONE general note or
// says there is nothing to learn. A draft goes to brain_suggestions and is invisible to the AI
// until an admin approves it in Panel Settings (then it becomes a brain_notes row). The AI
// never writes to its own rules. The pure helpers below have no imports and are tested offline.

import { promisesToday } from './today-promise';
import { noteProblem } from './brain';

export const SUGGEST_MAX_PER_RUN = 15;

// Topics the owner's locked rules already settle: a draft about them is never offered.
const LOCKED_TOPICS = ['refund', 'cancel', 'payment'];

// Phones, emails, order / tracking IDs, links, long digit runs, PIN codes: a lesson is general,
// so none of that is sent to the model or allowed in a draft.
export function maskPersonal(text: string): string {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(?<![\w])(?:ST|AWB)[A-Z0-9]{6,}\b/gi, '[tracking id]')
    .replace(/#\s?\d{2,}/g, '[order]')
    .replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, '[phone]')
    .replace(/\d{5,}/g, '[number]');
}

// True when a draft still carries something personal or specific to one chat.
export function hasPersonalDetail(text: string): boolean {
  return /\d{5,}|@|#\s?\d|https?:\/\/|\b(?:ST|AWB)[A-Z0-9]{6,}\b/i.test(text);
}

export interface Draft { kind: 'rule' | 'fact' | 'lesson'; title: string; body: string; topics: string[]; why: string }

// What the model sent back, as a draft, or null when there is nothing to learn or the draft is
// unusable (no JSON, too short or long, personal details, no valid topic, a title already taken).
export function parseDraft(raw: string | null | undefined, validTopics: string[], existingTitles: string[]): Draft | null {
  if (!raw) return null;
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) return null;
  let obj: { lesson?: { kind?: string; title?: string; body?: string; topics?: unknown } | null; why?: string };
  try { obj = JSON.parse(json[0]); } catch { return null; }
  const l = obj?.lesson;
  if (!l || typeof l !== 'object') return null;
  const title = String(l.title || '').trim().slice(0, 120);
  const body = String(l.body || '').trim().slice(0, 600);
  if (title.length < 4 || body.length < 25) return null;
  if (hasPersonalDetail(title) || hasPersonalDetail(body)) return null;
  const topics = (Array.isArray(l.topics) ? l.topics : []).map(String).filter((t) => validTopics.includes(t)).slice(0, 3);
  if (!topics.length || topics.some((t) => LOCKED_TOPICS.includes(t))) return null;
  // Never a draft that teaches promising arrival today / tonight, or hiding the estimated date.
  if (promisesToday(title + '. ' + body) || /\b(never|don'?t|do not)\b[^.]{0,30}\b(give|share|tell|say)\b[^.]{0,30}\bdate\b/i.test(body)) return null;
  if (noteProblem(title, body)) return null;
  const same = (a: string, b: string) => a.toLowerCase().replace(/\W+/g, ' ').trim() === b.toLowerCase().replace(/\W+/g, ' ').trim();
  if (existingTitles.some((t) => same(t, title))) return null;
  const kind = l.kind === 'rule' || l.kind === 'fact' ? l.kind : 'lesson';
  return { kind, title, body, topics, why: String(obj.why || '').trim().slice(0, 200) };
}

export const LEARN_INSTRUCTION = `You review one support chat from an Indian online store: a customer, the store's AI assistant (Karry) and the store's human team. Lines marked "Team action (panel)" are what the team did in the order panel. The store wants its AI to learn how the TEAM handles difficult customers: refunds and cancellations, wrong tracking, late orders, anger, fraud claims, payment problems.
You return two things.
1. "example": a team reply the AI should imitate. Only a reply marked [CALMED] may be used (the customer calmed down after it). Rewrite it as a reusable example: keep the team's own wording, tone and approach, but remove every name, phone number, order ID, tracking ID, link, amount and date, and anything only true for this one order. "customer" is what the customer said just before it, short, in their own words and language, with the same details removed. "situation" is one of the situations given. Return null if no [CALMED] reply is a good example (a greeting, thanks, a one-line answer, or a reply that promises a refund, a refund time, an exact delivery date or delivery today).
2. "lesson": ONE general thing the AI should learn from this chat (a store fact, a rule, or a mistake the AI made that the team had to fix), as an instruction to the AI, not already covered by the existing notes. Return null when unsure, when it is only about this order, or when it touches how customers are verified, refund / cancellation / payment policy, or a delivery date.
If "Corrections by the team" are given, a team member changed what the AI first wrote: that is the strongest lesson.
Answer with JSON only, no other text:
{"example": null | {"situation": "...", "customer": "...", "team": "..."}, "lesson": null | {"kind": "rule" | "fact" | "lesson", "title": "at most 8 words", "body": "1 to 3 sentences", "topics": ["..."]}, "why": "one short line"}
The AI must never say an order arrives today, tonight or tomorrow, must always give the estimated date from the order, and must hand refunds, cancellations and payment problems to the team: never suggest otherwise. The team is sometimes hurried or wrong: copy only what is clearly good.`;
