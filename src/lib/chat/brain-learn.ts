// ── The Brain's learning loop (owner, 2026-10-01) ────────────────────────────────
// The system SUGGESTS, the owner APPROVES. A chat where a team member answered the customer
// shows how the store wants such a question handled; once a day one small model call reads
// each new such chat (personal details masked first) and either drafts ONE general note or
// says there is nothing to learn. A draft goes to brain_suggestions and is invisible to the AI
// until an admin approves it in Panel Settings (then it becomes a brain_notes row). The AI
// never writes to its own rules. The pure helpers below have no imports and are tested offline.

export const SUGGEST_MAX_PER_RUN = 15;

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
  if (!topics.length) return null;
  const same = (a: string, b: string) => a.toLowerCase().replace(/\W+/g, ' ').trim() === b.toLowerCase().replace(/\W+/g, ' ').trim();
  if (existingTitles.some((t) => same(t, title))) return null;
  const kind = l.kind === 'rule' || l.kind === 'fact' ? l.kind : 'lesson';
  return { kind, title, body, topics, why: String(obj.why || '').trim().slice(0, 200) };
}

export const LEARN_INSTRUCTION = `You review one support chat from an Indian online store: a customer, the store's AI assistant (Karry) and a human team member. The team member's reply shows how the store wants such a question handled.
Decide whether the AI should learn ONE general thing from it: a store fact, a rule for how to act, or a mistake to avoid, written as an instruction to the AI. It must not already be covered by the existing notes listed.
Answer with JSON only, no other text:
{"lesson": null}
or
{"lesson": {"kind": "rule" | "fact" | "lesson", "title": "at most 8 words", "body": "1 to 3 sentences, general, as an instruction to the AI", "topics": ["..."]}, "why": "one short line"}
topics must come from the list given. Never include a name, phone number, order ID, address, amount or date from this chat.
Return {"lesson": null} when: the team reply is a greeting, thanks or small talk; the answer is only about this one order; you are not sure; or it would change how customers are verified, how refunds or payments are handled, or would promise a delivery date.`;
