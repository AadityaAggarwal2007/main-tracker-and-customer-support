// ── The WhatsApp number paused after Meta's rate limit (owner 2026-10-15: "130429 Rate limit hit", 59 order messages
// failed and the chargeback alert did not arrive) ──
// One row in chat_settings (`wa_pause` = {until, reason, at}), so BOTH PM2 processes stop sending from the number until
// `until`; a later pause only moves it forward. Read with a 10-second cache. Never throws: a failed read = not paused
// (the send itself then meets Meta's answer again).
import { query, queryOne } from '@/lib/db';
import { MANUAL_PAUSE_MIN, MAX_STRIKES, SEND_EVERY_MS, STRIKE_WINDOW_MS, nextPause, parsePauseState, sendEveryFor, type PauseState } from './whatsapp-auto-rules';

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

// Pause the number after a 130429. `ms` given = exactly that long (tests); else the strikes decide (nextPause: 15, 30,
// 60, 120 minutes; a 130429 while the pause runs is the same burst and counts once). Returns when the number may send again.
export async function pauseWhatsApp(reason: string, now = Date.now(), ms?: number): Promise<number> {
  const prev = await pauseState();
  const next = ms != null ? { until: now + ms, strikes: prev && now - prev.at < 2 * 60 * 60 * 1000 ? Math.min(prev.strikes + 1, MAX_STRIKES) : 1 } : nextPause(prev, now);
  if (!next) return prev!.until;                                   // the same burst: the pause already runs
  const until = new Date(next.until).toISOString();
  const value = JSON.stringify({ until, reason: reason.slice(0, 200), at: new Date(now).toISOString(), strikes: next.strikes });
  cache = { at: now, pause: { until: next.until, reason } };
  try {
    await query(
      `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEY, value]);
    console.warn(`[whatsapp] sending paused until ${until} (strike ${next.strikes}): ${reason.slice(0, 120)}`);
  } catch (e) { console.error('[whatsapp] pause:', (e as Error).message); }
  return next.until;
}

// The stored pause, expired or not (the strikes and when the last 130429 came). A failed read = none.
export async function pauseState(): Promise<PauseState | null> {
  try {
    const r = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [KEY]);
    return parsePauseState(r?.value);
  } catch { return null; }
}

// The gap between two order messages right now (wider for two hours after a 130429).
export async function sendEvery(now = Date.now()): Promise<number> {
  return sendEveryFor(await pauseState(), now);
}

export function forgetPauseCache(): void { cache = null; }

async function writePause(value: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(value)]);
  cache = null;
}

// "Pause now" from the Automation tab (owner 2026-10-15, "pause ka koi option"): no order message for 15 / 30 / 60 / 120
// minutes. It never counts as Meta's refusal: the strikes and the time of Meta's last 130429 are kept as they were (none =
// a time 2 hours back, so nothing goes slower afterwards). Alerts and tests still go, as in Meta's pause.
export async function manualPause(minutes: number, by: string, now = Date.now()): Promise<number | null> {
  if (!MANUAL_PAUSE_MIN.includes(minutes)) return null;
  const prev = await pauseState();
  const until = Math.max(now + minutes * 60_000, prev && prev.until > now ? prev.until : 0);
  await writePause({
    until: new Date(until).toISOString(), reason: `Paused by ${by}`.slice(0, 200),
    at: new Date(prev ? prev.at : now - STRIKE_WINDOW_MS).toISOString(), strikes: prev ? prev.strikes : 1,
    manual: true, by: by.slice(0, 60),
  });
  console.warn(`[whatsapp] sending paused by hand until ${new Date(until).toISOString()} (${by})`);
  return until;
}

// "Resume now": the pause ends at once (Meta's or one by hand). The strikes stay, so after a Meta pause messages still
// go 1 a minute for the rest of the 2 hours and a new refusal still makes the next pause longer. false = nothing paused.
export async function resumeNow(by: string, now = Date.now()): Promise<boolean> {
  const prev = await pauseState();
  if (!prev || prev.until <= now) return false;
  await writePause({
    until: new Date(now).toISOString(), reason: prev.reason, at: new Date(prev.at).toISOString(), strikes: prev.strikes,
    ...(prev.manual ? { manual: true, by: prev.by || '' } : {}), resumedBy: by.slice(0, 60),
  });
  console.warn(`[whatsapp] sending resumed by hand (${by})`);
  return true;
}

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
