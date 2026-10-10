// ── The WhatsApp business profile and number, managed from ShipTrack (owner 2026-10-10: "admin panel mein sab
// kuch kar sakein: photo, business name, category ...") ──
// Cloud API: the profile (about, description, address, email, websites, vertical = category, profile picture),
// the number's state (display name + its review status, quality rating, messaging limit) and a display-name
// change request (Meta reviews it). The picture goes up through Meta's resumable upload (needs the Meta App id,
// kept in Settings) and is then attached to the profile by its handle. Business HOURS are not in the Cloud API
// (only the WhatsApp Business phone app has them): the screen says so.
// Pure parts (`profileSpec`, `readProfile`, `readPhone`) are unit-tested; the API calls take fetch.

import { WA_API_BASE_DEFAULT } from './whatsapp';

export const VERTICALS: { code: string; label: string }[] = [
  { code: 'RETAIL', label: 'Retail' }, { code: 'APPAREL', label: 'Clothing and apparel' }, { code: 'BEAUTY', label: 'Beauty, spa and salon' },
  { code: 'GROCERY', label: 'Grocery' }, { code: 'PROF_SERVICES', label: 'Professional services' }, { code: 'ENTERTAIN', label: 'Entertainment' },
  { code: 'EVENT_PLAN', label: 'Event planning' }, { code: 'FINANCE', label: 'Finance and banking' }, { code: 'HEALTH', label: 'Medical and health' },
  { code: 'HOTEL', label: 'Hotel and lodging' }, { code: 'RESTAURANT', label: 'Restaurant' }, { code: 'TRAVEL', label: 'Travel and transportation' },
  { code: 'EDU', label: 'Education' }, { code: 'AUTO', label: 'Automotive' }, { code: 'GOVT', label: 'Public service' }, { code: 'NONPROFIT', label: 'Non-profit' },
  { code: 'OTHER', label: 'Other' }, { code: 'UNDEFINED', label: 'Not set' },
];
export const ABOUT_MAX = 139, DESCRIPTION_MAX = 512, ADDRESS_MAX = 256, EMAIL_MAX = 128, WEBSITE_MAX = 256, WEBSITES_MAX = 2;
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;

export interface ProfileInput {
  about?: string; description?: string; address?: string; email?: string; websites?: string[]; vertical?: string;
}
export interface Profile {
  about: string; description: string; address: string; email: string; websites: string[]; vertical: string; pictureUrl: string | null;
}

type AnyRec = Record<string, unknown>;
const rec = (v: unknown): AnyRec | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as AnyRec : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

// The form -> what Meta's profile call takes, or one sentence on what is wrong. Empty fields are sent empty
// (that clears them on the profile); the vertical must be one of Meta's.
export function profileSpec(input: ProfileInput): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const about = String(input.about ?? '').trim();
  if (about.length > ABOUT_MAX) return { ok: false, error: `"About" is over ${ABOUT_MAX} characters` };
  const description = String(input.description ?? '').trim();
  if (description.length > DESCRIPTION_MAX) return { ok: false, error: `The description is over ${DESCRIPTION_MAX} characters` };
  const address = String(input.address ?? '').trim();
  if (address.length > ADDRESS_MAX) return { ok: false, error: `The address is over ${ADDRESS_MAX} characters` };
  const email = String(input.email ?? '').trim();
  if (email && (email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { ok: false, error: 'That email address does not look right' };
  const websites = (input.websites || []).map((w) => String(w ?? '').trim()).filter(Boolean);
  if (websites.length > WEBSITES_MAX) return { ok: false, error: `At most ${WEBSITES_MAX} websites` };
  for (const w of websites) {
    if (w.length > WEBSITE_MAX || !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(w)) return { ok: false, error: `A website must start with https:// (${w.slice(0, 40)})` };
  }
  const vertical = String(input.vertical ?? '').trim().toUpperCase() || 'UNDEFINED';
  if (!VERTICALS.some((v) => v.code === vertical)) return { ok: false, error: 'Pick a category from the list' };
  return { ok: true, body: { messaging_product: 'whatsapp', about, description, address, email, websites, vertical } };
}

export function readProfile(json: unknown): Profile | null {
  const data = rec(json)?.data;
  const p = Array.isArray(data) ? rec(data[0]) : rec(json);
  if (!p) return null;
  return {
    about: str(p.about), description: str(p.description), address: str(p.address), email: str(p.email),
    websites: Array.isArray(p.websites) ? p.websites.map(str).filter(Boolean) : [], vertical: str(p.vertical).toUpperCase() || 'UNDEFINED',
    pictureUrl: str(p.profile_picture_url) || null,
  };
}

export interface PhoneInfo {
  displayPhoneNumber: string; verifiedName: string; nameStatus: string; qualityRating: string; status: string;
  messagingLimit: string; codeVerification: string;
}
export function readPhone(json: unknown): PhoneInfo | null {
  const p = rec(json);
  if (!p || (!str(p.display_phone_number) && !str(p.verified_name))) return null;
  return {
    displayPhoneNumber: str(p.display_phone_number), verifiedName: str(p.verified_name), nameStatus: str(p.name_status).toUpperCase() || 'UNKNOWN',
    qualityRating: str(p.quality_rating).toUpperCase() || 'UNKNOWN', status: str(p.status).toUpperCase() || 'UNKNOWN',
    messagingLimit: str(p.messaging_limit_tier).toUpperCase() || 'UNKNOWN', codeVerification: str(p.code_verification_status).toUpperCase() || 'UNKNOWN',
  };
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

function apiBase(env: NodeJS.ProcessEnv): string {
  return (env.WHATSAPP_API_BASE || WA_API_BASE_DEFAULT).replace(/\/+$/, '');
}
function metaError(status: number, json: unknown): string {
  const err = rec(rec(json)?.error);
  const msg = str(err?.error_user_msg) || str(err?.message);
  if (status === 401 || err?.code === 190) return 'The WhatsApp token was refused (expired or revoked)';
  if (err?.code === 10) return `(#10) ${msg || 'Application does not have permission for this action'}`.slice(0, 220);
  return msg ? msg.slice(0, 200) : `WhatsApp answered ${status}`;
}

async function call<T>(path: string, init: RequestInit, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, read: (json: unknown) => T, auth = 'Bearer'): Promise<ApiResult<T>> {
  if (!env.WHATSAPP_CLOUD_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return { ok: false, error: 'WhatsApp is not set up (token or phone number id missing)' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetchImpl(`${apiBase(env)}/${path}`, {
      ...init, headers: { Authorization: `${auth} ${env.WHATSAPP_CLOUD_TOKEN}`, ...(init.headers || {}) }, signal: ctl.signal,
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
const JSON_H = { 'Content-Type': 'application/json' };
const PROFILE_FIELDS = 'about,address,description,email,profile_picture_url,websites,vertical';
const PHONE_FIELDS = 'display_phone_number,verified_name,name_status,quality_rating,status,messaging_limit_tier,code_verification_status';

export function getProfile(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<ApiResult<Profile | null>> {
  return call(`${env.WHATSAPP_PHONE_NUMBER_ID}/whatsapp_business_profile?fields=${PROFILE_FIELDS}`, { method: 'GET' }, env, fetchImpl, readProfile);
}

export function updateProfile(body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<ApiResult<boolean>> {
  return call(`${env.WHATSAPP_PHONE_NUMBER_ID}/whatsapp_business_profile`, { method: 'POST', headers: JSON_H, body: JSON.stringify(body) }, env, fetchImpl, (j) => rec(j)?.success === true);
}

export function getPhone(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<ApiResult<PhoneInfo | null>> {
  return call(`${env.WHATSAPP_PHONE_NUMBER_ID}?fields=${PHONE_FIELDS}`, { method: 'GET' }, env, fetchImpl, readPhone);
}

// Asks Meta to change the name customers see (they review it; `name_status` says where it stands).
export function requestDisplayName(name: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<ApiResult<boolean>> {
  const clean = name.trim();
  if (clean.length < 3 || clean.length > 75) return Promise.resolve({ ok: false, error: 'The display name is 3 to 75 characters' });
  return call(`${env.WHATSAPP_PHONE_NUMBER_ID}`, { method: 'POST', headers: JSON_H, body: JSON.stringify({ new_display_name: clean }) }, env, fetchImpl, (j) => rec(j)?.success === true);
}

// The profile picture: JPG / PNG up to 5 MB, square works best (640 x 640). Resumable upload on the Meta APP
// (start a session with the size and type, send the bytes with "OAuth" auth and file_offset 0, get a handle), then
// the handle goes on the profile.
export async function uploadProfilePicture(appId: string, bytes: Uint8Array, mime: 'image/jpeg' | 'image/png', env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<ApiResult<string>> {
  if (!/^\d{6,30}$/.test(appId)) return { ok: false, error: 'Set the Meta App id first (Settings > WhatsApp)' };
  if (!bytes.length) return { ok: false, error: 'That file is empty' };
  if (bytes.length > PICTURE_MAX_BYTES) return { ok: false, error: 'The picture is over 5 MB' };
  const start = await call(`${appId}/uploads?file_length=${bytes.length}&file_type=${encodeURIComponent(mime)}`, { method: 'POST' }, env, fetchImpl, (j) => str(rec(j)?.id));
  if ('error' in start) return { ok: false, error: start.error };
  if (!start.value) return { ok: false, error: 'Meta did not open an upload session' };
  const sent = await call(start.value, { method: 'POST', headers: { file_offset: '0', 'Content-Type': 'application/octet-stream' }, body: bytes as unknown as BodyInit }, env, fetchImpl, (j) => str(rec(j)?.h), 'OAuth');
  if ('error' in sent) return { ok: false, error: sent.error };
  if (!sent.value) return { ok: false, error: 'Meta did not return the picture handle' };
  const put = await updateProfile({ messaging_product: 'whatsapp', profile_picture_handle: sent.value }, env, fetchImpl);
  if ('error' in put) return { ok: false, error: put.error };
  return { ok: true, value: sent.value };
}

export function pictureMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}
