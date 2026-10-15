// ── The WhatsApp number paused after Meta's rate limit (owner 2026-10-15: "130429 Rate limit hit", 59 order messages
// failed and the chargeback alert did not arrive) ──
// One row in chat_settings (`wa_pause` = {until, reason, at}), so BOTH PM2 processes stop sending from the number until
// `until`; a later pause only moves it forward. Read with a 10-second cache. Never throws: a failed read = not paused
// (the send itself then meets Meta's answer again).
// The SAFETY STOP (owner 2026-10-15 night, "1 msg bhi dubara drop ya fail ho toh pause ho jae"): a Meta-side failure of
// an order message, an alert or the test message (whatsapp-auto-rules.ts failureSide) writes the same row with
// `stopped: true` and `until` 30 days on (stopWhatsApp): no order message goes until the Super Admin presses Resume
// (resumeNow). The timed 130429 pause (pauseWhatsApp) stays for a report that is nobody's (another app on the number)
// and for a team chat message; it never shortens a stop.
import { query, queryOne } from '@/lib/db';
import {
  MANUAL_PAUSE_MIN, MAX_STRIKES, SEND_EVERY_MS, SEND_RATE_KEY, SEND_RATES, STOP_BY, STOP_MS, STRIKE_WINDOW_MS, firstAfterQuietOf, gapFor, nextPause, parsePauseState, parseSendRate,
  sendEveryFor, sendRateValue, stopLogLine, withTemplate, type PauseState, type SendRate,
} from './whatsapp-auto-rules';

const KEY = 'wa_pause';
export interface WaPause { until: number; reason: string; stopped?: boolean }
let cache: { at: number; pause: WaPause | null } | null = null;

export function parsePause(value: string | null | undefined, now = Date.now()): WaPause | null {
  try {
    const j = JSON.parse(String(value || ''));
    const until = Date.parse(j?.until);
    return Number.isFinite(until) && until > now ? { until, reason: String(j?.reason || ''), ...(j?.stopped === true ? { stopped: true } : {}) } : null;
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
// quietBefore (owner 2026-10-15): the caller looked and found no order message in the 10 minutes before the refused one;
// with that, or a message sent within 2 minutes of the previous pause's end, the pause carries `firstAfterQuiet` (the
// Number status box: "not our speed", whatsapp-auto-rules.ts FIRST_AFTER_QUIET_TEXT).
export async function pauseWhatsApp(reason: string, now = Date.now(), ms?: number, sentAt?: number | null, quietBefore = false): Promise<number> {
  const prev = await pauseState();
  if (prev?.stopped && prev.until > now) return prev.until;          // the safety stop holds: a timed pause never shortens or replaces it
  const next = ms != null ? { until: now + ms, strikes: prev && now - prev.at < 2 * 60 * 60 * 1000 ? Math.min(prev.strikes + 1, MAX_STRIKES) : 1 } : nextPause(prev, now, undefined, sentAt);
  if (!next) {                                                     // the same burst: the pause already ran / runs
    if (prev && sentAt != null && prev.until <= now) console.warn(`[whatsapp] late 130429 report for a message sent ${Math.round((now - sentAt) / 60000)} min ago, before the last pause ended: not a new refusal`);
    return prev!.until;
  }
  const firstAfterQuiet = firstAfterQuietOf(prev, sentAt, quietBefore);
  const until = new Date(next.until).toISOString();
  const value = JSON.stringify({ until, reason: reason.slice(0, 200), at: new Date(now).toISOString(), strikes: next.strikes, ...(firstAfterQuiet ? { firstAfterQuiet: true } : {}) });
  cache = { at: now, pause: { until: next.until, reason } };
  try {
    await query(
      `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEY, value]);
    console.warn(`[whatsapp] sending paused until ${until} (strike ${next.strikes}${firstAfterQuiet ? ', the FIRST message after a quiet stretch: not our speed' : ''}): ${reason.slice(0, 120)}`);
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

// The speed the owner chose (owner 2026-10-15, "har minute 2, 3, 4 message"; whatsapp-auto-rules.ts SEND_RATE_KEY): 1-4
// order messages a minute for the whole install, read with a 10-second cache per process like the pause; a failed read
// or no row = 2 a minute (today's 30 s).
let rateCache: { at: number; rate: SendRate } | null = null;
export async function loadSendRate(now = Date.now()): Promise<SendRate> {
  if (rateCache && now - rateCache.at < 10_000) return rateCache.rate;
  let rate = parseSendRate(null);
  try {
    const r = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [SEND_RATE_KEY]);
    rate = parseSendRate(r?.value);
  } catch (e) { console.error('[whatsapp] send rate:', (e as Error).message); }
  rateCache = { at: now, rate };
  return rate;
}
export async function saveSendRate(perMinute: number, by: string, now = Date.now()): Promise<SendRate | null> {
  if (!SEND_RATES.includes(perMinute)) return null;
  const value = sendRateValue(perMinute, by, now);
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SEND_RATE_KEY, value]);
  rateCache = null;
  console.log(`[whatsapp] order messages: ${perMinute} a minute, set by ${by}`);
  return parseSendRate(value);
}
export function forgetSendRateCache(): void { rateCache = null; }

// The gap between two order messages right now: the chosen one (gapFor), the slower of it and 60 s for two hours after
// a 130429.
export async function sendEvery(now = Date.now()): Promise<number> {
  return sendEveryFor(await pauseState(), now, gapFor((await loadSendRate(now)).perMinute));
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
  if (prev?.stopped && prev.until > now) return prev.until;          // the safety stop already holds everything: nothing to add
  const until = Math.max(now + minutes * 60_000, prev && prev.until > now ? prev.until : 0);
  await writePause({
    until: new Date(until).toISOString(), reason: `Paused by ${by}`.slice(0, 200),
    at: new Date(prev ? prev.at : now - STRIKE_WINDOW_MS).toISOString(), strikes: prev ? prev.strikes : 1,
    manual: true, by: by.slice(0, 60), ...(prev?.firstAfterQuiet ? { firstAfterQuiet: true } : {}),
  });
  console.warn(`[whatsapp] sending paused by hand until ${new Date(until).toISOString()} (${by})`);
  return until;
}

// "Resume now": the pause ends at once (Meta's, one by hand, or the safety stop: the ONLY way a stop ends). The strikes
// stay, so after a Meta refusal messages still go 1 a minute for the rest of the 2 hours. false = nothing paused.
export async function resumeNow(by: string, now = Date.now()): Promise<boolean> {
  const prev = await pauseState();
  if (!prev || prev.until <= now) return false;
  await writePause({
    until: new Date(now).toISOString(), reason: prev.reason, at: new Date(prev.at).toISOString(), strikes: prev.strikes,
    ...(prev.manual ? { manual: true, by: prev.by || '' } : {}), resumedBy: by.slice(0, 60), ...(prev.firstAfterQuiet ? { firstAfterQuiet: true } : {}),
  });
  console.warn(`[whatsapp] sending resumed by hand (${by})${prev.stopped ? `: the stop after ${prev.reason.slice(0, 80)} is over, the waiting order messages go in line` : ''}`);
  return true;
}

// ── The safety stop (owner 2026-10-15 night) ──
// A Meta-side failure (whatsapp-auto-rules.ts failureSide): the number stops sending order messages until Resume. The row
// keeps `strikes` counting as a refusal (the Number status box's "Nth in the last 2 hours") and `firstAfterQuiet`;
// `code` / `order` / `kind` ('placed' / 'tracking' / 'alert' / 'test') say what failed. Nothing is written when a stop
// already runs (the same failure reported twice, a second message of the same burst), and a LATE report for a message
// SENT before the last pause / stop ended (`sentAt`, as nextPause reads it) belongs to the failure the owner already saw:
// no new stop, the row still goes back in line. Returns whether a NEW stop began (the caller then alerts the owner once).
// template (2026-10-15 night): the template Meta refused, so the reason says at once when an old one went out
export interface StopInfo { code: number | null; words: string; order?: string | null; kind?: string | null; template?: string | null }
export interface StopResult { started: boolean; until: number; at: number }
export async function stopWhatsApp(info: StopInfo, now = Date.now(), sentAt?: number | null, quietBefore = false): Promise<StopResult> {
  const prev = await pauseState();
  if (prev?.stopped && prev.until > now) return { started: false, until: prev.until, at: prev.at };
  if (prev && sentAt != null && Number.isFinite(sentAt) && sentAt < prev.until) {
    console.warn(`[whatsapp] late failure report (${info.code ?? 'no code'}) for a message sent ${Math.round((now - sentAt) / 60000)} min ago, before the last pause ended: not a new stop`);
    return { started: false, until: prev.until, at: prev.at };
  }
  const strikes = prev && now - prev.at < STRIKE_WINDOW_MS ? Math.min(prev.strikes + 1, MAX_STRIKES) : 1;
  const firstAfterQuiet = firstAfterQuietOf(prev, sentAt, quietBefore);
  const words = String(info.words || '').replace(/[\r\n\t]+/g, ' ').trim();
  const reason = withTemplate((info.code != null && !new RegExp(`^${info.code}\\b`).test(words) ? `${info.code} ${words}` : words).trim().slice(0, 200) || 'no words from Meta', info.template);   // a report's words already start with the code
  const until = now + STOP_MS;
  cache = { at: now, pause: { until, reason, stopped: true } };
  try {
    await writePause({
      until: new Date(until).toISOString(), reason, at: new Date(now).toISOString(), strikes,
      stopped: true, by: STOP_BY, code: info.code ?? null, order: info.order ? String(info.order).slice(0, 40) : null, kind: info.kind ? String(info.kind).slice(0, 20) : null,
      ...(firstAfterQuiet ? { firstAfterQuiet: true } : {}),
    });
    cache = { at: now, pause: { until, reason, stopped: true } };
    console.error(stopLogLine(info.code, info.words, info.order, info.template));
  } catch (e) { console.error('[whatsapp] stop:', (e as Error).message); }
  return { started: true, until, at: now };
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
