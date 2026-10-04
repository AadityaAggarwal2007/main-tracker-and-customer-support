// ── Office holidays (owner 2026-10-05, answer 10: "ha, ginna hai") ─────────────────
// The Super Admin lists the days the office is closed (Team > Office hours & holidays), one
// 'YYYY-MM-DD' per line, saved as ONE row of chat_settings (key 'office_holidays'; the table
// from chat-settings.sql, no new SQL). The widget route, the email poller, the inbox list and
// the suggested replies read it through loadHolidays() (cached a minute: one small query, never
// an error, [] when the row or the table is missing); the synchronous team rules (who is
// "away") read the last loaded list through cachedHolidays(). Office hours themselves (the
// week) are in src/lib/office-hours.ts.
import { query, queryOne } from '@/lib/db';
import { parseHolidays } from '@/lib/office-hours';

export const HOLIDAYS_KEY = 'office_holidays';
const CACHE_MS = 60_000;
// At most this many dates are kept (a year of holidays is far fewer).
export const MAX_HOLIDAYS = 60;

let cache: { at: number; days: string[] } = { at: 0, days: [] };

export async function loadHolidays(now = Date.now()): Promise<string[]> {
  if (now - cache.at < CACHE_MS) return cache.days;
  try {
    const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [HOLIDAYS_KEY]);
    cache = { at: now, days: parseHolidays(row?.value).slice(0, MAX_HOLIDAYS) };
  } catch (err) {
    console.error('[office] holidays read failed:', (err as Error).message);
    cache = { at: now, days: cache.days };
  }
  return cache.days;
}

// The last list loadHolidays() read (empty until the first read after a restart).
export function cachedHolidays(): string[] {
  return cache.days;
}

// Save the list as typed; returns the cleaned dates. The next read sees them at once.
export async function saveHolidays(text: string): Promise<string[]> {
  const days = parseHolidays(text).slice(0, MAX_HOLIDAYS);
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [HOLIDAYS_KEY, days.join('\n')]
  );
  cache = { at: Date.now(), days };
  return days;
}
