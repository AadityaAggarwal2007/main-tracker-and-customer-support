// The WhatsApp number's health for the Today board (whatsapp-health-rules.ts says what the numbers mean). Meta's
// side (quality rating, status, messaging limit tier) is read at most every 5 minutes (memory, per process); our own
// numbers come from the database on every board refresh: the different customers we started a conversation with
// in the last 24 hours (the automation's sends + the team's template messages), the automation's failed and waiting
// messages today and the customers who asked us to stop. Never throws: a part that cannot be read stays 0 / UNKNOWN.

import { query } from '@/lib/db';
import { waConfigured } from './whatsapp';
import { getPhone } from './whatsapp-profile';
import { tierLimit, type WaHealth } from './whatsapp-health-rules';
import { stoppedNumbers } from './whatsapp-stop';

const PHONE_TTL_MS = 5 * 60_000;
type PhoneCache = { at: number; quality: string; status: string; tier: string; error: string | null };
const g = globalThis as unknown as { __waPhoneCache?: PhoneCache };

async function phoneFacts(now: number): Promise<PhoneCache> {
  const c = g.__waPhoneCache;
  if (c && now - c.at < PHONE_TTL_MS) return c;
  let next: PhoneCache = { at: now, quality: 'UNKNOWN', status: 'UNKNOWN', tier: 'UNKNOWN', error: null };
  try {
    const r = await getPhone();
    if (r.ok && r.value) next = { ...next, quality: r.value.qualityRating, status: r.value.status, tier: r.value.messagingLimit };
    else next.error = 'error' in r ? r.error : 'Meta gave no details for the number';
  } catch (e) { next.error = (e as Error).message; }
  g.__waPhoneCache = next;
  return next;
}

const IST_TODAY = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
const ignoreMissing = (e: unknown, what: string) => {
  const code = (e as { code?: string })?.code;
  if (code !== '42P01' && code !== '42703') console.error(`[wa-health] ${what}:`, (e as Error).message);
};

export async function loadWaHealth(now = Date.now()): Promise<WaHealth | null> {
  if (!waConfigured()) return null;
  const phone = await phoneFacts(now);
  const h: WaHealth = { quality: phone.quality, status: phone.status, tier: phone.tier, limit: tierLimit(phone.tier), used24h: 0, failedToday: 0, waitingToday: 0, stopped: 0, phoneError: phone.error };
  try {
    const r = await query<{ n: number }>(
      `SELECT count(DISTINCT x.digits)::int AS n FROM (
         SELECT w.to_number AS digits FROM wa_auto_sends w
          WHERE w.sent_at > now() - interval '24 hours' AND w.status IN ('sent', 'delivered', 'read')
         UNION ALL
         SELECT substr(c.visitor_id, 4) FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.created_at > now() - interval '24 hours' AND m.sender = 'agent' AND m.metadata ? 'wa_template'
            AND c.source = 'whatsapp' AND c.visitor_id LIKE 'wa:%' AND COALESCE(m.metadata->>'wa_sent', 'true') <> 'false'
       ) x`);
    h.used24h = r.rows[0]?.n ?? 0;
  } catch (e) { ignoreMissing(e, 'used'); }
  try {
    const r = await query<{ failed: number; waiting: number }>(
      `SELECT (count(*) FILTER (WHERE status = 'failed' AND updated_at >= ${IST_TODAY}))::int AS failed,
              (count(*) FILTER (WHERE status = 'pending'))::int AS waiting
         FROM wa_auto_sends`);
    h.failedToday = r.rows[0]?.failed ?? 0; h.waitingToday = r.rows[0]?.waiting ?? 0;
  } catch (e) { ignoreMissing(e, 'automation'); }
  try {
    h.stopped = (await stoppedNumbers()).size;
  } catch (e) { ignoreMissing(e, 'stopped'); }
  return h;
}

export function resetWaPhoneCache(): void { g.__waPhoneCache = undefined; }
