// ── WhatsApp message templates (owner 2026-10-10: "what app first message template") ──
// A conversation the BUSINESS starts (or a reply after 24 hours of silence) must be an approved template:
// Meta reviews each one (minutes to a day). This file makes, lists and deletes them through the Cloud API
// on the WhatsApp Business Account (WABA) and renders a template's text for the chat record. Pure parts
// (`templateSpec`, `varCount`, `renderTemplate`, `readTemplates`) are unit-tested; the API calls take fetch.
//
// Kept simple on purpose: a text header (optional), a body with {{1}} {{2}} ... variables and one example
// value each, a footer (optional). No buttons, media headers or authentication templates yet.

import { WA_API_BASE_DEFAULT } from './whatsapp';

export const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING'] as const;
export type TemplateCategory = typeof TEMPLATE_CATEGORIES[number];
export const TEMPLATE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en_US', label: 'English (US)' }, { code: 'en', label: 'English' }, { code: 'en_GB', label: 'English (UK)' }, { code: 'hi', label: 'Hindi' },
];
const NAME_RE = /^[a-z0-9_]{1,512}$/;
const VAR_RE = /\{\{\s*(\d+)\s*\}\}/g;
export const BODY_MAX = 1024, HEADER_MAX = 60, FOOTER_MAX = 60, PARAM_MAX = 1024;

export interface TemplateInput {
  name: string; language: string; category: string;
  header?: string | null; body: string; footer?: string | null;
  examples?: string[];          // one per {{n}}, in order; Meta needs them for review
}

export interface TemplateSpec {
  name: string; language: string; category: TemplateCategory;
  components: Record<string, unknown>[];
  vars: number;
}

export function varCount(body: string): number {
  const nums = new Set<number>();
  for (const m of body.matchAll(VAR_RE)) nums.add(Number(m[1]));
  return nums.size;
}

// {{1}}..{{n}} must be exactly 1..n, each used at least once. Returns '' when fine, else what is wrong.
function varProblem(body: string): string {
  const nums = [...body.matchAll(VAR_RE)].map((m) => Number(m[1]));
  if (!nums.length) return '';
  const set = new Set(nums);
  const max = Math.max(...nums);
  if (set.has(0) || max > 20) return 'Variables are {{1}}, {{2}} ... up to {{20}}';
  for (let i = 1; i <= max; i++) if (!set.has(i)) return `Variables must run {{1}}, {{2}} ... without a gap (missing {{${i}}})`;
  if (/^\s*\{\{\s*\d+\s*\}\}|\{\{\s*\d+\s*\}\}\s*$/.test(body)) return 'The body cannot start or end with a variable (Meta refuses it)';
  return '';
}

// Turns what the form typed into what Meta's API wants, or says what is wrong (one sentence, for the screen).
export function templateSpec(input: TemplateInput): { ok: true; spec: TemplateSpec } | { ok: false; error: string } {
  const name = String(input.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!NAME_RE.test(name)) return { ok: false, error: 'Name: small letters, numbers and _ only (e.g. order_shipped)' };
  const language = String(input.language || '').trim();
  if (!TEMPLATE_LANGUAGES.some((l) => l.code === language)) return { ok: false, error: 'Pick a language' };
  const category = String(input.category || '').toUpperCase() as TemplateCategory;
  if (!TEMPLATE_CATEGORIES.includes(category)) return { ok: false, error: 'Category must be Utility or Marketing' };
  const body = String(input.body || '').replace(/\r\n/g, '\n').trim();
  if (!body) return { ok: false, error: 'Write the message body' };
  if (body.length > BODY_MAX) return { ok: false, error: `The body is over ${BODY_MAX} characters` };
  const vp = varProblem(body);
  if (vp) return { ok: false, error: vp };
  const vars = varCount(body);
  const examples = (input.examples || []).map((e) => String(e ?? '').trim());
  if (vars > 0 && (examples.length < vars || examples.slice(0, vars).some((e) => !e))) {
    return { ok: false, error: `Give an example value for each variable (${vars})` };
  }
  const header = String(input.header || '').trim();
  if (header.length > HEADER_MAX) return { ok: false, error: `The header is over ${HEADER_MAX} characters` };
  if (VAR_RE.test(header)) { VAR_RE.lastIndex = 0; return { ok: false, error: 'No variables in the header (keep it a plain line)' }; }
  VAR_RE.lastIndex = 0;
  const footer = String(input.footer || '').trim();
  if (footer.length > FOOTER_MAX) return { ok: false, error: `The footer is over ${FOOTER_MAX} characters` };

  const components: Record<string, unknown>[] = [];
  if (header) components.push({ type: 'HEADER', format: 'TEXT', text: header });
  const bodyComp: Record<string, unknown> = { type: 'BODY', text: body };
  if (vars > 0) bodyComp.example = { body_text: [examples.slice(0, vars)] };
  components.push(bodyComp);
  if (footer) components.push({ type: 'FOOTER', text: footer });
  return { ok: true, spec: { name, language, category, components, vars } };
}

// The text the chat record keeps for a sent template: header / body with the values filled in / footer.
export function renderTemplate(t: { header?: string | null; body: string; footer?: string | null }, params: string[]): string {
  const body = t.body.replace(VAR_RE, (_m, n) => {
    const v = params[Number(n) - 1];
    return v == null || v === '' ? `{{${n}}}` : v;
  });
  return [t.header || '', body, t.footer || ''].filter(Boolean).join('\n');
}

export interface TemplateInfo {
  id: string; name: string; language: string; category: string;
  status: string;                      // APPROVED / PENDING / REJECTED / PAUSED / DISABLED ...
  header: string | null; body: string; footer: string | null;
  vars: number; rejectedReason: string | null;
}

type AnyRec = Record<string, unknown>;
const rec = (v: unknown): AnyRec | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as AnyRec : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// Meta's list answer -> our rows (anything odd is skipped, never thrown).
export function readTemplates(json: unknown): TemplateInfo[] {
  const out: TemplateInfo[] = [];
  const data = rec(json)?.data;
  for (const raw of Array.isArray(data) ? data : []) {
    const t = rec(raw);
    if (!t || !str(t.name)) continue;
    let header: string | null = null, body = '', footer: string | null = null;
    for (const c of Array.isArray(t.components) ? t.components : []) {
      const comp = rec(c);
      const type = str(comp?.type).toUpperCase();
      if (type === 'HEADER' && str(comp?.format).toUpperCase() === 'TEXT') header = str(comp?.text) || null;
      else if (type === 'BODY') body = str(comp?.text);
      else if (type === 'FOOTER') footer = str(comp?.text) || null;
    }
    out.push({
      id: str(t.id), name: str(t.name), language: str(t.language), category: str(t.category).toUpperCase(), status: str(t.status).toUpperCase() || 'UNKNOWN',
      header, body, footer, vars: varCount(body),
      rejectedReason: str(t.rejected_reason) && str(t.rejected_reason).toUpperCase() !== 'NONE' ? str(t.rejected_reason) : null,
    });
  }
  return out;
}

export type TemplateApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

function apiBase(env: NodeJS.ProcessEnv): string {
  return (env.WHATSAPP_API_BASE || WA_API_BASE_DEFAULT).replace(/\/+$/, '');
}

function metaError(status: number, json: unknown): string {
  const err = rec(rec(json)?.error);
  const msg = str(err?.error_user_msg) || str(err?.message);
  if (status === 401 || err?.code === 190) return 'The WhatsApp token was refused (expired or revoked)';
  if (err?.code === 10) return (/^\(#10\)/.test(msg) ? msg : `(#10) ${msg || 'Application does not have permission for this action'}`).slice(0, 220);
  if (err?.code === 100 && /does not exist|cannot be loaded|missing permissions/i.test(msg)) return 'Meta does not know this WhatsApp Business Account id, or the token has no rights on it';
  // Meta's own code (and subcode) go after the words, so a refusal can be looked up exactly
  const details = str(rec(err?.error_data)?.details);
  const tag = err?.code ? ` [Meta code ${String(err.code)}${err.error_subcode ? `/${String(err.error_subcode)}` : ''}]` : '';
  const more = details && !msg.includes(details) ? ` ${details.slice(0, 160)}` : '';
  return msg ? msg.slice(0, 200) + more + tag : `WhatsApp answered ${status}${more}${tag}`;
}

async function call<T>(path: string, init: RequestInit, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, read: (json: unknown) => T): Promise<TemplateApiResult<T>> {
  if (!env.WHATSAPP_CLOUD_TOKEN) return { ok: false, error: 'WhatsApp is not set up (token missing)' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetchImpl(`${apiBase(env)}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.WHATSAPP_CLOUD_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: ctl.signal,
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* no body */ }
    if (!res.ok) return { ok: false, error: metaError(res.status, json) };
    return { ok: true, value: read(json) };
  } catch (e) {
    return { ok: false, error: (e as Error)?.name === 'AbortError' ? 'WhatsApp did not answer in time' : 'Could not reach WhatsApp' };
  } finally {
    clearTimeout(timer);
  }
}

const WABA_RE = /^\d{6,30}$/;

export async function listTemplates(waba: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<TemplateApiResult<TemplateInfo[]>> {
  if (!WABA_RE.test(waba)) return { ok: false, error: 'Set the WhatsApp Business Account id first' };
  return call(`${waba}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=100`, { method: 'GET' }, env, fetchImpl, readTemplates);
}

export async function createTemplate(waba: string, spec: TemplateSpec, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<TemplateApiResult<{ id: string; status: string }>> {
  if (!WABA_RE.test(waba)) return { ok: false, error: 'Set the WhatsApp Business Account id first' };
  const body = JSON.stringify({ name: spec.name, language: spec.language, category: spec.category, components: spec.components });
  return call(`${waba}/message_templates`, { method: 'POST', body }, env, fetchImpl, (json) => ({ id: str(rec(json)?.id), status: str(rec(json)?.status).toUpperCase() || 'PENDING' }));
}

export async function deleteTemplate(waba: string, name: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<TemplateApiResult<boolean>> {
  if (!WABA_RE.test(waba)) return { ok: false, error: 'Set the WhatsApp Business Account id first' };
  if (!NAME_RE.test(name)) return { ok: false, error: 'Not a template name' };
  return call(`${waba}/message_templates?name=${encodeURIComponent(name)}`, { method: 'DELETE' }, env, fetchImpl, (json) => rec(json)?.success === true);
}

// Edits an existing template (Meta allows it for APPROVED / REJECTED / PAUSED ones, a few times a day; an
// approved one goes back to review). Name and language cannot change: a new one is made for that.
export async function updateTemplate(id: string, spec: Pick<TemplateSpec, 'components' | 'category'>, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<TemplateApiResult<boolean>> {
  if (!/^\d{6,30}$/.test(id)) return { ok: false, error: 'Not a template id' };
  return call(id, { method: 'POST', body: JSON.stringify({ components: spec.components, category: spec.category }) }, env, fetchImpl, (json) => rec(json)?.success === true);
}
