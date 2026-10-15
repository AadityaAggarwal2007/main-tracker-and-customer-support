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
import { dailyLimit } from './whatsapp-settings';
import { loadForeignToday } from './whatsapp-foreign';
import { foreignSeen } from './whatsapp-foreign-rules';
import { pauseState } from './whatsapp-pause';

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

// The conversations WE started in the last 24 hours (Meta's rolling window): the automation's sends and the team's
// template messages, one per different number.
const STARTED_24H_SQL = `
         SELECT w.to_number AS digits, w.sent_at AS at FROM wa_auto_sends w
          WHERE w.sent_at > now() - interval '24 hours' AND w.status IN ('sent', 'delivered', 'read')
         UNION ALL
         SELECT substr(c.visitor_id, 4), m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.created_at > now() - interval '24 hours' AND m.sender = 'agent' AND m.metadata ? 'wa_template'
            AND c.source = 'whatsapp' AND c.visitor_id LIKE 'wa:%' AND COALESCE(m.metadata->>'wa_sent', 'true') <> 'false'`;

// How many different customers we started a conversation with in the last 24 hours / since midnight India time, and
// when the oldest of them was (24 hours after it the rolling count drops by one). One query; a failed read = zeros.
export async function usedNumbers(): Promise<{ used24h: number; usedToday: number; oldest24h: string | null }> {
  try {
    const r = await query<{ n: number; today: number; oldest: string | Date | null }>(
      `SELECT count(DISTINCT x.digits)::int AS n, (count(DISTINCT x.digits) FILTER (WHERE x.at >= ${IST_TODAY}))::int AS today, min(x.at) AS oldest FROM (${STARTED_24H_SQL}
       ) x`);
    const oldest = r.rows[0]?.oldest;
    return { used24h: r.rows[0]?.n ?? 0, usedToday: r.rows[0]?.today ?? 0, oldest24h: oldest ? new Date(oldest).toISOString() : null };
  } catch (e) { ignoreMissing(e, 'used'); return { used24h: 0, usedToday: 0, oldest24h: null }; }
}
// The numbers of those customers (the daily limit guard, whatsapp-auto.ts: a message to one of them is not a NEW
// conversation for Meta and may still go at the limit). Read only when the count is near the limit. A failed read = none.
export async function knownNumbers24h(): Promise<Set<string>> {
  try {
    const r = await query<{ digits: string }>(`SELECT DISTINCT x.digits FROM (${STARTED_24H_SQL}
       ) x WHERE x.digits IS NOT NULL`);
    return new Set(r.rows.map((x) => String(x.digits)));
  } catch (e) { ignoreMissing(e, 'known'); return new Set(); }
}
// The daily limit that counts now: Meta's tier when the number carries one, else the limit typed in WhatsApp > Setup
// (Meta keeps it on the portfolio now, so the tier often comes back empty); null = unlimited or not known.
export async function limitNow(now = Date.now()): Promise<{ limit: number | null; limitFrom: 'meta' | 'saved' | null; phone: { quality: string; status: string; tier: string; error: string | null } }> {
  if (!waConfigured()) return { limit: null, limitFrom: null, phone: { quality: 'UNKNOWN', status: 'UNKNOWN', tier: 'UNKNOWN', error: null } };
  const phone = await phoneFacts(now);
  const metaLimit = tierLimit(phone.tier);
  const saved = metaLimit || phone.tier.toUpperCase() === 'TIER_UNLIMITED' ? null : await dailyLimit();
  return { limit: metaLimit ?? saved, limitFrom: metaLimit ? 'meta' : saved ? 'saved' : null, phone };
}

export async function loadWaHealth(now = Date.now()): Promise<WaHealth | null> {
  if (!waConfigured()) return null;
  const { limit, limitFrom, phone } = await limitNow(now);
  const h: WaHealth = { quality: phone.quality, status: phone.status, tier: phone.tier, limit, limitFrom, used24h: 0, failedToday: 0, waitingToday: 0, stopped: 0, phoneError: phone.error };
  const used = await usedNumbers();
  h.usedToday = used.usedToday; h.used24h = used.used24h; h.oldest24h = used.oldest24h;
  try {
    const r = await query<{ failed: number; waiting: number }>(
      `SELECT (count(*) FILTER (WHERE status = 'failed' AND updated_at >= ${IST_TODAY}))::int AS failed,
              (count(*) FILTER (WHERE status = 'pending'))::int AS waiting
         FROM wa_auto_sends`);
    h.failedToday = r.rows[0]?.failed ?? 0; h.waitingToday = r.rows[0]?.waiting ?? 0;
  } catch (e) { ignoreMissing(e, 'automation'); }
  try {
    const at = `COALESCE(w.sent_at, CASE WHEN w.status = 'pending' THEN w.due_at ELSE w.updated_at END)`;
    const r = await query<{ kind: string; status: string; n: number }>(
      `SELECT w.kind, w.status, count(*)::int AS n FROM wa_auto_sends w
        WHERE ${at} >= ${IST_TODAY} AND ${at} < ${IST_TODAY} + interval '1 day' GROUP BY 1, 2`);
    const t = { placedWent: 0, placedRead: 0, trackingWent: 0, trackingRead: 0, failed: 0, skipped: 0, dueLater: 0 };
    for (const x of r.rows) {
      const went = ['sent', 'delivered', 'read'].includes(x.status);
      if (went && x.kind === 'placed') t.placedWent += x.n;
      if (went && x.kind === 'tracking') t.trackingWent += x.n;
      if (x.status === 'read') { if (x.kind === 'placed') t.placedRead += x.n; else t.trackingRead += x.n; }
      if (x.status === 'failed') t.failed += x.n;
      if (x.status === 'skipped') t.skipped += x.n;
      if (x.status === 'pending') t.dueLater += x.n;
    }
    h.today = t;
  } catch (e) { ignoreMissing(e, 'today'); }
  try {
    h.stopped = (await stoppedNumbers()).size;
  } catch (e) { ignoreMissing(e, 'stopped'); }
  // another app on the number (owner 2026-10-15): one small read, never throws
  h.foreignToday = foreignSeen(await loadForeignToday(now));
  // the safety stop (owner 2026-10-15 night): the Today board's red line until Resume
  const st = await pauseState().catch(() => null);
  h.safetyStop = st?.stopped && st.until > now ? { reason: st.reason, at: new Date(st.at).toISOString(), order: st.order ?? null } : null;
  return h;
}

export function resetWaPhoneCache(): void { g.__waPhoneCache = undefined; }
