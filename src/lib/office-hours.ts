// ── Office hours (owner, 2026-10-01) ────────────────────────────
// The team works every day from 10:00 to 19:30 India time. Two things hang off it:
//   - the night line: from 19:30 to 10:00 a customer handed to the team is told the team
//     replies in the morning, after 10 AM, instead of "within 1 hour" / "within 24 hours"
//     (afterHours);
//   - "away": a member not seen in ShipTrack for 30 minutes during office hours. A junior may
//     then mark Refund / Ship again while every senior is away, and anyone may take a waiting
//     customer's chat from an away holder (team-rules.ts). Outside office hours nobody is
//     "away", so neither happens at night.
// No imports: the server, the inbox and the tests share it. India has no daylight saving, so a
// fixed +5:30 offset is exact all year; no time-zone library is needed.

export const IST_OFFSET_MIN = 330;     // +5:30
export const OFFICE_OPEN_MIN = 600;    // 10:00
export const OFFICE_CLOSE_MIN = 1170;  // 19:30 (the first minute that is no longer office time)
export const AWAY_AFTER_MIN = 30;

const MIN_MS = 60_000;
const DAY_MIN = 1440;

export type AfterHours = 'tomorrow' | 'this_morning' | null;

// Minutes since midnight in India (0..1439) for a UTC instant. The double modulo keeps
// instants before 1970 positive too.
export function istMinuteOfDay(ms: number): number {
  return ((Math.floor(ms / MIN_MS) + IST_OFFSET_MIN) % DAY_MIN + DAY_MIN) % DAY_MIN;
}

export function isOfficeHours(ms: number): boolean {
  const m = istMinuteOfDay(ms);
  return m >= OFFICE_OPEN_MIN && m < OFFICE_CLOSE_MIN;
}

// Which night line to use: from 19:30 to midnight the team replies 'tomorrow' morning; from
// midnight to 10:00 it is 'this_morning', so a customer writing at 1 AM is not told "kal".
// null during office hours (the day lines stay exactly as they are).
export function afterHours(ms: number): AfterHours {
  const m = istMinuteOfDay(ms);
  if (m >= OFFICE_CLOSE_MIN) return 'tomorrow';
  if (m < OFFICE_OPEN_MIN) return 'this_morning';
  return null;
}

// 10:00 India time on the India day of `ms`, as a UTC instant.
export function todayOpenMs(ms: number): number {
  const startOfIstDay = ms - istMinuteOfDay(ms) * MIN_MS - (ms % MIN_MS + MIN_MS) % MIN_MS;
  return startOfIstDay + OFFICE_OPEN_MIN * MIN_MS;
}

// How long someone has not been seen, counted from 10:00 today at the earliest, so every day
// starts fresh: a person not seen since yesterday is 20 min "away" at 10:20 and away from 10:30.
// null outside office hours (nobody is away at night). Never below 0: a last-seen time a moment
// newer than `ms` (memory flushed between two clock reads) is "just seen", not negative.
export function awayMinutes(lastSeenMs: number | null, ms: number): number | null {
  if (!isOfficeHours(ms)) return null;
  const from = Math.max(lastSeenMs ?? 0, todayOpenMs(ms));
  return Math.max(0, Math.floor((ms - from) / MIN_MS));
}

export function isAway(lastSeenMs: number | null, ms: number): boolean {
  const m = awayMinutes(lastSeenMs, ms);
  return m !== null && m >= AWAY_AFTER_MIN;
}
