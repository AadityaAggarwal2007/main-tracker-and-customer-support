// ── "Check token" (owner 2026-10-10, after an hour of "(#10)" and "Meta does not know this id") ──
// Asks Meta what the token on the server really is: its app, its permissions, and which WhatsApp accounts
// it may manage (debug_token's granular scopes carry the account ids), then tries the saved account id and
// the phone number id with it. The verdicts say in plain words what is missing. Never returns the token.

import { WA_API_BASE_DEFAULT } from './whatsapp';

type AnyRec = Record<string, unknown>;
const rec = (v: unknown): AnyRec | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as AnyRec : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

export interface TokenCheck {
  valid: boolean | null;              // null = debug_token could not be read
  type: string | null;                // USER / SYSTEM_USER / PAGE ...
  appId: string | null;
  appName: string | null;
  expires: string | null;             // 'never' or an ISO date
  scopes: string[];
  granular: { scope: string; targets: string[] }[];
  waba: { id: string; name: string | null; error: string | null };
  phone: { id: string; ok: boolean; error: string | null };
  debugError: string | null;
  verdicts: string[];
}

export const NEEDED = ['whatsapp_business_management', 'whatsapp_business_messaging'];

// Pure: the verdicts from what Meta said.
export function tokenVerdicts(c: Omit<TokenCheck, 'verdicts'>, savedAppId: string): string[] {
  const out: string[] = [];
  if (c.valid === false) out.push('Meta says this token is not valid any more (revoked or expired). Make a new one.');
  if (c.valid !== false) {
    for (const s of NEEDED) if (c.scopes.length && !c.scopes.includes(s)) out.push(`The token has no "${s}" permission. Generate a new token with it ticked.`);
    const mgmt = c.granular.find((g) => g.scope === 'whatsapp_business_management');
    if (mgmt && mgmt.targets.length && c.waba.id && !mgmt.targets.includes(c.waba.id)) {
      out.push(`The token manages WhatsApp account(s) ${mgmt.targets.join(', ')}, not the saved id ${c.waba.id}. Either the saved id is another account, or the System User has no access to this one (Assign assets).`);
    }
    if (c.waba.id && c.waba.error && !out.some((v) => /manages WhatsApp account/.test(v))) out.push(`Reading the saved WhatsApp Business Account ${c.waba.id} failed: ${c.waba.error}`);
    if (!c.phone.ok && c.phone.error) out.push(`Reading the phone number ${c.phone.id} failed: ${c.phone.error}`);
    if (c.appId && savedAppId && c.appId !== savedAppId) out.push(`The token belongs to app ${c.appId}, the saved Meta App id is ${savedAppId}. Use the id of the app the token was made for.`);
    if (c.type && c.type !== 'SYSTEM_USER') out.push(`This is a ${c.type} token (a person's, which expires), not a System User token.`);
  }
  if (c.debugError && c.valid === null) out.push(`Meta would not describe the token: ${c.debugError}`);
  if (!out.length && c.valid) out.push('The token is fine: valid, the needed permissions, the account and the number readable.');
  return out;
}

export async function checkToken(savedWaba: string, savedAppId: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<TokenCheck> {
  const token = env.WHATSAPP_CLOUD_TOKEN || '';
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID || '';
  const base = (env.WHATSAPP_API_BASE || WA_API_BASE_DEFAULT).replace(/\/+$/, '');
  const get = async (path: string): Promise<{ ok: boolean; json: unknown; status: number }> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      const res = await fetchImpl(`${base}/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
      let json: unknown = null;
      try { json = await res.json(); } catch { /* none */ }
      return { ok: res.ok, json, status: res.status };
    } catch (e) {
      return { ok: false, json: { error: { message: (e as Error)?.name === 'AbortError' ? 'Meta did not answer in time' : 'Could not reach Meta' } }, status: 0 };
    } finally { clearTimeout(timer); }
  };
  const errText = (r: { json: unknown; status: number }) => str(rec(rec(r.json)?.error)?.message) || `HTTP ${r.status}`;

  const c: Omit<TokenCheck, 'verdicts'> = {
    valid: null, type: null, appId: null, appName: null, expires: null, scopes: [], granular: [],
    waba: { id: savedWaba, name: null, error: null }, phone: { id: phoneId, ok: false, error: null }, debugError: null,
  };
  if (!token) { c.debugError = 'No WHATSAPP_CLOUD_TOKEN on the server'; return { ...c, verdicts: tokenVerdicts(c, savedAppId) }; }

  const dbg = await get(`debug_token?input_token=${encodeURIComponent(token)}`);
  const d = rec(rec(dbg.json)?.data);
  if (dbg.ok && d) {
    c.valid = d.is_valid === true;
    c.type = str(d.type) || null;
    c.appId = str(d.app_id) || null;
    c.appName = str(d.application) || null;
    const exp = Number(d.expires_at);
    c.expires = Number.isFinite(exp) ? (exp === 0 ? 'never' : new Date(exp * 1000).toISOString()) : null;
    c.scopes = Array.isArray(d.scopes) ? d.scopes.map(str).filter(Boolean) : [];
    c.granular = (Array.isArray(d.granular_scopes) ? d.granular_scopes : []).map((g) => {
      const r = rec(g);
      return { scope: str(r?.scope), targets: Array.isArray(r?.target_ids) ? (r!.target_ids as unknown[]).map(str).filter(Boolean) : [] };
    }).filter((g) => g.scope);
  } else {
    c.debugError = errText(dbg);
  }
  if (savedWaba) {
    const w = await get(`${encodeURIComponent(savedWaba)}?fields=id,name`);
    if (w.ok) c.waba.name = str(rec(w.json)?.name) || '(no name)';
    else c.waba.error = errText(w);
  }
  if (phoneId) {
    const p = await get(`${encodeURIComponent(phoneId)}?fields=display_phone_number`);
    c.phone.ok = p.ok;
    if (!p.ok) c.phone.error = errText(p);
  }
  return { ...c, verdicts: tokenVerdicts(c, savedAppId) };
}
