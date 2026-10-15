// ── The WhatsApp number paused after Meta's rate limit (owner 2026-10-15: "130429 Rate limit hit", 59 order messages
// failed and the chargeback alert did not arrive) ──
// One row in chat_settings (`wa_pause` = {until, reason, at}), so BOTH PM2 processes stop sending from the number until
// `until`; a later pause only moves it forward. Read with a 10-second cache. Never throws: a failed read = not paused
// (the send itself then meets Meta's answer again).
import { query, queryOne } from '@/lib/db';
import { PAUSE_MS, SEND_EVERY_MS } from './whatsapp-auto-rules';

const KEY = 'wa_pause';
export interface WaPause { until: number; reason: string }
let cache: { at: number; pause: WaPause | null } | null = null;

export function parsePause(value: string | null | undefined, now = Date.now()): WaPause | null {
  try {
    const j = JSON.parse(String(value || ''));
    const until = Date.parse(j?.until);
    return Number.isFinite(until) && until > now ? { until, reason: String(j?.reason || '') } : null;
  } catch { return null; }
}

export async function whatsAppPause(now = Date.now()): Promise<WaPause | null> {
  if (cache && now - cache.at < 10_000) return cache.pause && cache.pause.until > now ? cache.pause : null;
  let pause: WaPause | null = null;
  try {
    const r = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [KEY]);
    pause = parsePause(r?.value, now);
  } catch { pause = null; }
  cache = { at: now, pause };
  return pause;
}

export async function pauseWhatsApp(reason: string, now = Date.now(), ms = PAUSE_MS): Promise<void> {
  const until = new Date(now + ms).toISOString();
  const value = JSON.stringify({ until, reason: reason.slice(0, 200), at: new Date(now).toISOString() });
  cache = { at: now, pause: { until: now + ms, reason } };
  try {
    await query(
      `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEY, value]);
    console.warn(`[whatsapp] sending paused until ${until}: ${reason.slice(0, 120)}`);
  } catch (e) { console.error('[whatsapp] pause:', (e as Error).message); }
}

export function forgetPauseCache(): void { cache = null; }

// The send slot (owner 2026-10-15, "har minute 1 ya 2 msg"): one automation message per SEND_EVERY_MS for the whole
// install. `wa_send_slot` holds when the last one was let through; taking the slot is one UPDATE that only one process
// can win. A failed read = no slot (nothing goes rather than a burst).
const SLOT = 'wa_send_slot';
export async function takeSendSlot(everyMs = SEND_EVERY_MS): Promise<boolean> {
  try {
    await query(`INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING`, [SLOT, '1970-01-01T00:00:00.000Z']);
    const r = await queryOne<{ key: string }>(
      `UPDATE chat_settings SET value = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), updated_at = now()
        WHERE key = $1 AND value::timestamptz <= clock_timestamp() - $2 * interval '1 millisecond' RETURNING key`,
      [SLOT, everyMs]);
    return !!r;
  } catch (e) {
    console.error('[whatsapp] send slot:', (e as Error).message);
    return false;
  }
}
