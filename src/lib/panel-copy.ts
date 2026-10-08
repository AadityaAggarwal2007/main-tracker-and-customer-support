// ── Copy one panel's setup to another (owner 2026-10-08) ──────────────────────────────────────────
// Owner: "jitna kaam Vastora par kiya utna hi dono par bhi ... jab bhi nayi panel banayein to jo latest apne panels mein
// update kiya wo at least update to ho". Every panel gets the same AI setup: Chikki's own prompt, the saved answers,
// the Brain notes, the COD answer, the default courier and the effort levels. Pure: no imports; the database part is
// panel-copy-server.ts. NOTHING is ever deleted: saved answers and notes are only ADDED (a question / title the panel
// already has is skipped), and a setting the panel already has is kept unless "overwrite" is on. A panel's own things
// (orders, chats, Gmail, WhatsApp number, logo, tracking domain, team) are never touched. The source panel's name in
// any copied text becomes the target panel's name.

export interface CopyParts { prompt: boolean; answers: boolean; notes: boolean; cod: boolean; courier: boolean; effort: boolean }
export const ALL_PARTS: CopyParts = { prompt: true, answers: true, notes: true, cod: true, courier: true, effort: true };
export const PART_KEYS = Object.keys(ALL_PARTS) as (keyof CopyParts)[];

export function cleanParts(v: unknown): CopyParts {
  if (!v || typeof v !== 'object') return { ...ALL_PARTS };
  const o = v as Record<string, unknown>;
  const out = { ...ALL_PARTS };
  for (const k of PART_KEYS) if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Vastora" -> "VASTRIKA" in every shape of capitals, whole words only ("Vastora's", "Vastora Support" follow).
export function replaceBrand(text: string, from: string, to: string): { text: string; hits: number } {
  const f = (from || '').trim(), t = (to || '').trim();
  if (!text || !f || !t || f.toLowerCase() === t.toLowerCase()) return { text: text || '', hits: 0 };
  let hits = 0;
  const out = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(f)}(?![\\p{L}\\p{N}])`, 'giu'), () => { hits += 1; return t; });
  return { text: out, hits };
}

export interface FaqRow { question: string; answer: string; sort_order: number; is_enabled: boolean }
export interface NoteRow { kind: string; title: string; body: string; topics: string[]; always: boolean; is_enabled: boolean; source: string; sort_order: number; audience?: string }
export interface Setup {
  name: string;
  prompt: string | null;
  codAvailable: boolean | null; codStates: string | null;
  effort: unknown | null;
  courier: string | null;
  faqs: FaqRow[]; notes: NoteRow[];
}

export type SettingAction = 'off' | 'nothing' | 'copy' | 'overwrite' | 'keep';
export interface CopyPlan {
  prompt: { action: SettingAction; chars: number; hits: number; value: string | null };
  cod: { action: SettingAction; codAvailable: boolean | null; codStates: string | null };
  courier: { action: SettingAction; value: string | null };
  effort: { action: SettingAction; value: unknown | null };
  answers: { on: boolean; add: FaqRow[]; skip: number; hits: number };
  notes: { on: boolean; add: NoteRow[]; skip: number; hits: number };
}

const has = (v: unknown) => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function decide(on: boolean, sourceHas: boolean, targetHas: boolean, overwrite: boolean): SettingAction {
  if (!on) return 'off';
  if (!sourceHas) return 'nothing';
  if (!targetHas) return 'copy';
  return overwrite ? 'overwrite' : 'keep';
}

export function planCopy(src: Setup, dst: Setup, parts: CopyParts, overwrite: boolean): CopyPlan {
  const to = dst.name, from = src.name;
  const promptRepl = replaceBrand(src.prompt || '', from, to);
  const codHas = (s: Setup) => s.codAvailable !== null || has(s.codStates);

  // saved answers: ADD the ones whose question the target does not have (after the name is replaced)
  const haveQ = new Set(dst.faqs.map(f => key(f.question)));
  const maxOrder = dst.faqs.reduce((m, f) => Math.max(m, f.sort_order), -1);
  let answerHits = 0, answerSkip = 0;
  const addFaqs: FaqRow[] = [];
  if (parts.answers) {
    for (const f of [...src.faqs].sort((a, b) => a.sort_order - b.sort_order)) {
      const q = replaceBrand(f.question, from, to), a = replaceBrand(f.answer, from, to);
      if (haveQ.has(key(q.text))) { answerSkip += 1; continue; }
      haveQ.add(key(q.text));
      answerHits += q.hits + a.hits;
      addFaqs.push({ question: q.text, answer: a.text, sort_order: maxOrder + 1 + addFaqs.length, is_enabled: f.is_enabled });
    }
  }
  // notes: ADD the ones whose title the target does not have
  const haveT = new Set(dst.notes.map(n => key(n.title)));
  let noteHits = 0, noteSkip = 0;
  const addNotes: NoteRow[] = [];
  if (parts.notes) {
    for (const n of [...src.notes].sort((a, b) => a.sort_order - b.sort_order)) {
      const t = replaceBrand(n.title, from, to), b = replaceBrand(n.body, from, to);
      if (haveT.has(key(t.text))) { noteSkip += 1; continue; }
      haveT.add(key(t.text));
      noteHits += t.hits + b.hits;
      addNotes.push({ ...n, title: t.text, body: b.text });
    }
  }
  return {
    prompt: { action: decide(parts.prompt, has(src.prompt), has(dst.prompt), overwrite), chars: (src.prompt || '').length, hits: promptRepl.hits, value: has(src.prompt) ? promptRepl.text : null },
    cod: { action: decide(parts.cod, codHas(src), codHas(dst), overwrite), codAvailable: src.codAvailable, codStates: src.codStates },
    courier: { action: decide(parts.courier, has(src.courier), has(dst.courier), overwrite), value: src.courier },
    effort: { action: decide(parts.effort, has(src.effort), has(dst.effort), overwrite), value: src.effort },
    answers: { on: parts.answers, add: addFaqs, skip: answerSkip, hits: answerHits },
    notes: { on: parts.notes, add: addNotes, skip: noteSkip, hits: noteHits },
  };
}

// A short, plain-words summary of a plan for the screen (no long texts).
export function describePlan(p: CopyPlan): string[] {
  const set = (label: string, a: SettingAction, extra = '') => ({
    off: '', nothing: `${label}: the source has none, nothing to copy.`,
    copy: `${label}: will be copied${extra}.`, overwrite: `${label}: will be REPLACED${extra} (the old value is saved).`,
    keep: `${label}: this panel already has one, kept as it is.`,
  } as Record<SettingAction, string>)[a];
  const lines = [
    set("Chikki's own prompt", p.prompt.action, ` (${p.prompt.chars} characters, the store name changed ${p.prompt.hits} time${p.prompt.hits === 1 ? '' : 's'})`),
    p.answers.on ? `Saved answers: ${p.answers.add.length} will be added${p.answers.skip ? `, ${p.answers.skip} already there and skipped` : ''}.` : '',
    p.notes.on ? `Brain notes: ${p.notes.add.length} will be added${p.notes.skip ? `, ${p.notes.skip} already there and skipped` : ''}.` : '',
    set('Cash on Delivery answer', p.cod.action, p.cod.codStates ? ` (only in ${p.cod.codStates})` : p.cod.codAvailable === null ? '' : p.cod.codAvailable ? ' (available)' : ' (not available)'),
    set('Default courier', p.courier.action, p.courier.value ? ` (${p.courier.value})` : ''),
    set('Effort levels', p.effort.action),
  ];
  return lines.filter(Boolean);
}

export function planIsEmpty(p: CopyPlan): boolean {
  const acts: SettingAction[] = [p.prompt.action, p.cod.action, p.courier.action, p.effort.action];
  return !acts.some(a => a === 'copy' || a === 'overwrite') && p.answers.add.length === 0 && p.notes.add.length === 0;
}
