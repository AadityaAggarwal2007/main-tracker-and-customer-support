// Max effort (effort.ts): before a reply goes out, Chikki reads it once more against the
// locked rules and the order's facts and fixes it (owner, 2026-10-01: "soche, apne rules aur
// logic check kare, phir bheje"). One extra model call, no tools, no thinking. The checker
// may only take things out or put them right: anything new it brings (a link, a long number)
// that is not in the draft, the order facts or the customer's own words is refused, and the
// draft goes as it was. A failed or slow check never stops the reply. Pure: the call itself is
// made in ai.ts, which runs the corrected text through the same reply guards again.

// The check is asked as a continuation of the same conversation: the model sees exactly what it
// saw when it wrote the reply (the instructions, the locked rules, the notes, the saved answers,
// the delay reason the code chose, the order lookup, the whole chat), then its own reply, then
// this note. A first version that showed the checker only the locked rules and the order facts
// took out a delay reason the code had chosen (live test late-ladder-2, 2026-10-01).
export const CHECK_NOTE = '(Note from the system, not the customer: before your reply above is sent, check it once more. Does it follow every SHIPTRACK RULE and your instructions, state only what the order lookup and your instructions say, answer the customer\'s last message and say what happens next? If yes, answer exactly OK. If not, or if your reply is cut off, starts in the middle of a word or sentence, or does not answer, write the corrected full reply only, ready to send: same language, plain text, no notes or explanation. Never add a date, amount, promise, link, phone number or order number that is not in the lookup or your instructions; never say or hint that the order arrives today, tonight or tomorrow; keep the tracking link if your reply had it; keep any line saying our team will reply here.)';

const URL_RE = /https?:\/\/[^\s)]+/gi;
const LONG_NUMBER_RE = /\d[\d\s-]{3,}\d/g;
const digitsOnly = (s: string) => s.replace(/\D/g, '');
const urls = (s: string) => (s.match(URL_RE) || []).map((u) => u.replace(/[.,!?]+$/, ''));
const longNumbers = (s: string) => (s.match(LONG_NUMBER_RE) || []).map(digitsOnly).filter((d) => d.length >= 4);

export interface CheckResult { text: string; changed: boolean; reason: string }

// raw = the checker's answer; known = the order facts and the customer's own words, the only
// places a new link or long number may come from.
export function parseCheck(raw: string | null | undefined, draft: string, known: string): CheckResult {
  let t = String(raw ?? '').trim();
  const keep = (reason: string): CheckResult => ({ text: draft, changed: false, reason });
  if (!t) return keep('empty check');
  if (/^ok\b[\s.!]*$/i.test(t) || (/^ok\b/i.test(t) && t.length <= 40)) return keep('ok');
  t = t.replace(/^(corrected( message| reply)?|final( message| reply)?|reply|message)\s*:\s*/i, '')
    .replace(/^["“']([\s\S]*)["”']$/, '$1')
    .replace(/\*\*/g, '')
    .trim();
  if (t.length < 10) return keep('too short');
  if (t === draft.trim()) return keep('same');
  if (t.length > Math.max(draft.length * 2, draft.length + 400)) return keep('too long');
  if (/\b(STORE RULES|ORDER FACTS|DRAFT)\b/.test(t)) return keep('echoed the check');
  const allowedUrls = new Set([...urls(draft), ...urls(known)]);
  if (urls(t).some((u) => !allowedUrls.has(u))) return keep('new link');
  if (urls(draft).some((u) => !urls(t).includes(u))) return keep('dropped the link');
  const allowedNums = new Set([...longNumbers(draft), ...longNumbers(known)]);
  if (longNumbers(t).some((n) => !allowedNums.has(n))) return keep('new number');
  return { text: t, changed: true, reason: 'fixed' };
}

// The newest found order(s) the reply could talk about, from the lookup results the model saw.
export function latestOrderFacts(toolContents: string[]): string {
  for (let i = toolContents.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(toolContents[i]);
      if (r?.found && Array.isArray(r.orders) && r.orders.length) return JSON.stringify(r.orders).slice(0, 4000);
    } catch { /* not a lookup result */ }
  }
  return '';
}
