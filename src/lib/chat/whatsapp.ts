// ── WhatsApp in Chat Support (owner 2026-10-10: "now we will be adding whatsapp as well") ──
// The official WhatsApp Cloud API (Meta). One business number for the whole install: a customer who
// writes to it lands in Chat Support as a chat with `source = 'whatsapp'` (whatsapp-inbound.ts) and the
// team answers from the inbox; the reply route sends the text back through this file.
//
// Settings in /etc/tracker/.env (names only in .env.example, values never in Git or chat):
//   WHATSAPP_CLOUD_TOKEN       the System User token (sending; shared with the chargeback alert)
//   WHATSAPP_PHONE_NUMBER_ID   the number's id in Meta (sending)
//   WHATSAPP_VERIFY_TOKEN      what Meta sends on the webhook's verify call (GET)
//   WHATSAPP_APP_SECRET        the Meta app's secret: every POST is signed with it (X-Hub-Signature-256);
//                              when it is set a POST with a bad signature is refused, when it is not set
//                              nothing is checked (first test only: set it before real customers)
//   WHATSAPP_API_BASE          default https://graph.facebook.com/v25.0
//   WHATSAPP_PANEL_ID          the panel the WhatsApp chats belong to (default: the default panel)
//
// Rules of the platform the code respects: a text can only be sent within 24 hours of the customer's last
// message (outside it Meta answers 131047 and the team sees that), a conversation the business starts needs
// an approved template (`sendWhatsAppTemplate`). Nothing here reads the AI: Chikki does not answer on
// WhatsApp yet (owner: first a test with one person).

import { createHmac, timingSafeEqual } from 'crypto';

export const WA_API_BASE_DEFAULT = 'https://graph.facebook.com/v25.0';
const MAX_TEXT = 4000;        // Meta's text limit is 4096

export function waConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.WHATSAPP_CLOUD_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
}

function apiBase(env: NodeJS.ProcessEnv): string {
  return (env.WHATSAPP_API_BASE || WA_API_BASE_DEFAULT).replace(/\/+$/, '');
}

// A number as the Cloud API wants it: digits only with the country code. A 10-digit Indian number
// gets 91; anything shorter than 10 or longer than 15 digits is no number.
export function waDigits(input: unknown): string | null {
  const d = String(input ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) return '91' + d;
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

export type WaSendResult = { ok: true; id: string | null } | { ok: false; error: string; code: number | null };

// Meta's error in plain words for the inbox (never the raw JSON, never the token).
export function waErrorText(httpStatus: number, body: unknown): { text: string; code: number | null } {
  const err = (body as { error?: { code?: number; message?: string; error_data?: { details?: string } } } | null)?.error;
  const code = typeof err?.code === 'number' ? err.code : null;
  if (code === 131047) return { text: 'The customer last wrote over 24 hours ago: WhatsApp only allows a template message now', code };
  if (code === 131026 || code === 131030) return { text: 'This number cannot receive WhatsApp messages from us', code };
  if (code === 190 || httpStatus === 401) return { text: 'The WhatsApp token was refused (expired or revoked)', code };
  if (code === 131031 || code === 131056) return { text: 'WhatsApp has limited this business number right now', code };
  if (code === 100 || httpStatus === 400) return { text: `WhatsApp refused the message${err?.message ? ` (${err.message.slice(0, 120)})` : ''}`, code };
  return { text: `WhatsApp answered ${httpStatus}`, code };
}

async function post(payload: Record<string, unknown>, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<WaSendResult> {
  if (!waConfigured(env)) return { ok: false, error: 'WhatsApp is not set up (token or phone number id missing)', code: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetchImpl(`${apiBase(env)}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID as string)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_CLOUD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
      signal: ctl.signal,
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* no body */ }
    if (!res.ok) { const e = waErrorText(res.status, json); return { ok: false, error: e.text, code: e.code }; }
    const id = (json as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id;
    return { ok: true, id: typeof id === 'string' ? id : null };
  } catch (e) {
    return { ok: false, error: (e as Error)?.name === 'AbortError' ? 'WhatsApp did not answer in time' : 'Could not reach WhatsApp', code: null };
  } finally {
    clearTimeout(timer);
  }
}

// A plain text to a customer who wrote within the last 24 hours.
export async function sendWhatsAppText(to: string, text: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<WaSendResult> {
  const digits = waDigits(to);
  if (!digits) return { ok: false, error: 'Not a WhatsApp number', code: null };
  const body = text.trim().slice(0, MAX_TEXT);
  if (!body) return { ok: false, error: 'Nothing to send', code: null };
  return post({ to: digits, type: 'text', text: { preview_url: false, body } }, env, fetchImpl);
}

// An approved template (the only way to start a conversation, or to write after the 24-hour window).
export async function sendWhatsAppTemplate(
  to: string, name: string, lang = 'en_US', params: string[] = [],
  env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch,
): Promise<WaSendResult> {
  const digits = waDigits(to);
  if (!digits) return { ok: false, error: 'Not a WhatsApp number', code: null };
  if (!/^[a-z0-9_]{1,512}$/.test(name)) return { ok: false, error: 'Not a template name', code: null };
  const template: Record<string, unknown> = { name, language: { code: lang } };
  if (params.length) template.components = [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t).slice(0, 1024) })) }];
  return post({ to: digits, type: 'template', template }, env, fetchImpl);
}

// X-Hub-Signature-256: "sha256=<hmac of the raw body with the app secret>". No secret set = not checked.
export function waSignatureOk(rawBody: string, header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  const given = (header || '').trim();
  if (!given.startsWith('sha256=')) return false;
  const want = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const got = given.slice(7).toLowerCase();
  if (got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8'));
}

export interface WaInbound {
  id: string;                 // wamid: Meta sends a message again when it got no 200, so it is the dedupe key
  from: string;               // digits with the country code
  name: string | null;        // the customer's WhatsApp profile name (not proof of anything)
  text: string;               // what is shown in the inbox: the text, or "[Photo] caption" for media
  type: string;               // text / image / document / audio / video / sticker / location / button / interactive / ...
  timestamp: number;          // ms
  phoneNumberId: string | null;   // our number's id, as Meta names it
}

export interface WaStatus {
  id: string;                 // the wamid of OUR message
  status: string;             // sent / delivered / read / failed
  error: string | null;
  recipient: string | null;
}

const MEDIA_LABEL: Record<string, string> = {
  image: '[Photo]', video: '[Video]', audio: '[Voice message]', document: '[File]', sticker: '[Sticker]', contacts: '[Contact card]',
};

type AnyRec = Record<string, unknown>;
const rec = (v: unknown): AnyRec | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as AnyRec : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function inboundText(m: AnyRec): string {
  const type = str(m.type);
  if (type === 'text') return str(rec(m.text)?.body);
  if (type === 'button') return str(rec(m.button)?.text);
  if (type === 'interactive') {
    const i = rec(m.interactive);
    return str(rec(i?.button_reply)?.title) || str(rec(i?.list_reply)?.title) || '[Reply]';
  }
  if (type === 'location') {
    const l = rec(m.location);
    const parts = [str(l?.name), str(l?.address), l && l.latitude != null ? `${str(l.latitude)}, ${str(l.longitude)}` : ''].filter(Boolean);
    return `[Location] ${parts.join(' · ')}`.trim();
  }
  if (type === 'reaction') return `[Reaction] ${str(rec(m.reaction)?.emoji)}`.trim();
  if (MEDIA_LABEL[type]) {
    const media = rec(m[type]);
    const extra = str(media?.caption) || (type === 'document' ? str(media?.filename) : '');
    return `${MEDIA_LABEL[type]}${extra ? ' ' + extra : ''}`;
  }
  if (type === 'unsupported') return '[Unsupported message]';
  return type ? `[${type}]` : '[Message]';
}

// Reads Meta's webhook body (any number of entries / changes) into messages and statuses. Anything
// malformed is skipped, never thrown: the route must answer 200 quickly whatever arrives.
export function parseWaWebhook(body: unknown): { messages: WaInbound[]; statuses: WaStatus[] } {
  const messages: WaInbound[] = [];
  const statuses: WaStatus[] = [];
  const root = rec(body);
  if (!root || root.object !== 'whatsapp_business_account') return { messages, statuses };
  for (const entry of Array.isArray(root.entry) ? root.entry : []) {
    for (const change of Array.isArray(rec(entry)?.changes) ? (rec(entry)!.changes as unknown[]) : []) {
      const c = rec(change);
      if (!c || c.field !== 'messages') continue;
      const v = rec(c.value);
      if (!v) continue;
      const phoneNumberId = str(rec(v.metadata)?.phone_number_id) || null;
      const names = new Map<string, string>();
      for (const ct of Array.isArray(v.contacts) ? v.contacts : []) {
        const r = rec(ct);
        const wa = str(r?.wa_id), name = str(rec(r?.profile)?.name).trim();
        if (wa && name) names.set(wa.replace(/\D/g, ''), name.slice(0, 120));
      }
      for (const raw of Array.isArray(v.messages) ? v.messages : []) {
        const m = rec(raw);
        const id = str(m?.id), from = str(m?.from).replace(/\D/g, '');
        if (!m || !id || !from) continue;
        const ts = Number(m.timestamp);
        messages.push({
          id, from, name: names.get(from) || null, type: str(m.type) || 'unknown',
          text: inboundText(m).slice(0, MAX_TEXT), phoneNumberId,
          timestamp: Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now(),
        });
      }
      for (const raw of Array.isArray(v.statuses) ? v.statuses : []) {
        const s = rec(raw);
        const id = str(s?.id), status = str(s?.status);
        if (!s || !id || !status) continue;
        const errs = Array.isArray(s.errors) ? s.errors : [];
        const e0 = rec(errs[0]);
        const error = e0 ? [str(e0.code), str(e0.title) || str(e0.message), str(rec(e0.error_data)?.details)].filter(Boolean).join(' · ').slice(0, 300) : null;
        statuses.push({ id, status, error: error || null, recipient: str(s.recipient_id).replace(/\D/g, '') || null });
      }
    }
  }
  return { messages, statuses };
}
