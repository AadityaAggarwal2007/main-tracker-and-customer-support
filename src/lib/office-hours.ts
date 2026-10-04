// ── Office hours (owner, 2026-10-01; the week since 2026-10-05) ──────────
// The team works Monday to Friday from 10:00 to 19:30 India time, Saturday from 10:00 to
// 14:00 (a half day, owner 2026-10-05 answer 1), and is off on Sunday and on the holidays
// the Super Admin lists (Team > Office holidays, chat_settings key 'office_holidays').
// Three things hang off it:
//   - the night line: while the office is closed a customer handed to the team is told when
//     the team is back ("tomorrow morning, after 10 AM", "this morning", "on Monday
//     morning") instead of "within 1 hour" / "within 24 hours" (afterHours);
//   - the closed-hours note for an upset customer (src/lib/chat/closed-hours.ts): why the
//     office is closed (closedWhy) and since when (closedSinceMs);
//   - "away": a member not seen in ShipTrack for 30 minutes during office hours. A junior may
//     then mark Refund / Ship again while every senior is away, and anyone may take a waiting
//     customer's chat from an away holder (team-rules.ts). Outside office hours nobody is
//     "away", so neither happens at night, on Sunday or on a holiday.
// No imports: the server, the inbox and the tests share it. India has no daylight saving, so a
// fixed +5:30 offset is exact all year; no time-zone library is needed. `holidays` is a list of
// 'YYYY-MM-DD' India days; every function takes it as an optional last argument and treats a
// missing list as "no holidays", so older callers keep working.

export const IST_OFFSET_MIN = 330;     // +5:30
export const OFFICE_OPEN_MIN = 600;    // 10:00
export const OFFICE_CLOSE_MIN = 1170;  // 19:30 (the first minute that is no longer office time), Monday to Friday
export const SATURDAY_CLOSE_MIN = 840; // 14:00: Saturday is a half day
export const AWAY_AFTER_MIN = 30;

const MIN_MS = 60_000;
const DAY_MIN = 1440;
const DAY_MS = DAY_MIN * MIN_MS;
const IST_MS = IST_OFFSET_MIN * MIN_MS;
// How far ahead the next working day is looked for (a long run of holidays).
const MAX_LOOKAHEAD_DAYS = 14;

export const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type WeekdayName = typeof WEEKDAY_NAMES[number];

// When the team is back: 'this_morning' (today at 10:00), 'tomorrow' (tomorrow at 10:00) or
// the name of the next working day when that is further away ("on Monday morning"). null =
// the office is open now.
export type AfterHours = 'tomorrow' | 'this_morning' | WeekdayName | null;

// Why the office is closed: a weekday night, the Saturday afternoon and Sunday ('weekend'),
// a listed holiday, or null when it is open.
export type ClosedWhy = 'night' | 'weekend' | 'holiday' | null;

// Minutes since midnight in India (0..1439) for a UTC instant. The double modulo keeps
// instants before 1970 positive too.
export function istMinuteOfDay(ms: number): number {
  return ((Math.floor(ms / MIN_MS) + IST_OFFSET_MIN) % DAY_MIN + DAY_MIN) % DAY_MIN;
}

// 00:00 IST of ms's India day, as a UTC instant.
function istDayStartMs(ms: number): number {
  return Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
}

// 0 = Sunday .. 6 = Saturday, for the India day of `ms`.
export function istWeekday(ms: number): number {
  return new Date(istDayStartMs(ms) + IST_MS).getUTCDay();
}

// 'YYYY-MM-DD' of ms's India day.
export function istDate(ms: number): string {
  return new Date(istDayStartMs(ms) + IST_MS).toISOString().slice(0, 10);
}

// The holiday list as the Super Admin types it (one date per line, or commas): only real
// 'YYYY-MM-DD' dates are kept, each once, sorted. Anything else is ignored, never an error.
export function parseHolidays(text: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
    if (!m) continue;
    const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== raw.trim()) continue;  // 31 Feb
    out.add(raw.trim());
  }
  return Array.from(out).sort();
}

export function isHoliday(ms: number, holidays: readonly string[] = []): boolean {
  return holidays.length > 0 && holidays.includes(istDate(ms));
}

// The first minute of the India day of `ms` that is no longer office time, or null when the
// office does not open that day at all (Sunday, a holiday).
export function closeMinuteFor(ms: number, holidays: readonly string[] = []): number | null {
  if (isHoliday(ms, holidays)) return null;
  const wd = istWeekday(ms);
  if (wd === 0) return null;
  return wd === 6 ? SATURDAY_CLOSE_MIN : OFFICE_CLOSE_MIN;
}

export function isWorkingDay(ms: number, holidays: readonly string[] = []): boolean {
  return closeMinuteFor(ms, holidays) !== null;
}

export function isOfficeHours(ms: number, holidays: readonly string[] = []): boolean {
  const close = closeMinuteFor(ms, holidays);
  if (close === null) return false;
  const m = istMinuteOfDay(ms);
  return m >= OFFICE_OPEN_MIN && m < close;
}

// 10:00 India time on the India day of `ms`, as a UTC instant.
export function todayOpenMs(ms: number): number {
  return istDayStartMs(ms) + OFFICE_OPEN_MIN * MIN_MS;
}

// When the office next opens, as a UTC instant: today at 10:00 if it is a working day and
// 10:00 has not come yet, else 10:00 of the next working day. null while the office is open.
export function nextOpenMs(ms: number, holidays: readonly string[] = []): number | null {
  if (isOfficeHours(ms, holidays)) return null;
  if (isWorkingDay(ms, holidays) && istMinuteOfDay(ms) < OFFICE_OPEN_MIN) return todayOpenMs(ms);
  for (let d = 1; d <= MAX_LOOKAHEAD_DAYS; d++) {
    const day = ms + d * DAY_MS;
    if (isWorkingDay(day, holidays)) return todayOpenMs(day);
  }
  // Two weeks of holidays in the list: fall back to tomorrow rather than promise nothing.
  return todayOpenMs(ms + DAY_MS);
}

// Which "the team is back" line to use: 'this_morning' when the office opens later today,
// 'tomorrow' when it opens tomorrow, else the weekday name of the next working day. null =
// office hours (the day lines stay exactly as they are). The line is about the TEAM's reply,
// never about delivery (rule 4.3 still holds).
export function afterHours(ms: number, holidays: readonly string[] = []): AfterHours {
  const next = nextOpenMs(ms, holidays);
  if (next === null) return null;
  const days = Math.round((istDayStartMs(next) - istDayStartMs(ms)) / DAY_MS);
  if (days === 0) return 'this_morning';
  if (days === 1) return 'tomorrow';
  return WEEKDAY_NAMES[istWeekday(next)];
}

// Why the office is closed right now. 'weekend' = Sunday, or Saturday once the half day is
// over (and Saturday before 10:00 is still a night); 'holiday' = a listed date; 'night' =
// a working day outside 10:00-close. null = open.
export function closedWhy(ms: number, holidays: readonly string[] = []): ClosedWhy {
  if (isOfficeHours(ms, holidays)) return null;
  if (isHoliday(ms, holidays)) return 'holiday';
  const wd = istWeekday(ms);
  if (wd === 0) return 'weekend';
  if (wd === 6 && istMinuteOfDay(ms) >= SATURDAY_CLOSE_MIN) return 'weekend';
  return 'night';
}

// When the office last closed before `ms`, as a UTC instant: the start of the current closed
// stretch (Friday 19:30 for a Sunday, Saturday 14:00 for a Saturday evening, yesterday's close
// for a weekday night). null while the office is open. Used to count a customer's messages
// "since the office closed".
export function closedSinceMs(ms: number, holidays: readonly string[] = []): number | null {
  if (isOfficeHours(ms, holidays)) return null;
  for (let d = 0; d <= MAX_LOOKAHEAD_DAYS; d++) {
    const day = ms - d * DAY_MS;
    const close = closeMinuteFor(day, holidays);
    if (close === null) continue;
    const closeAt = istDayStartMs(day) + close * MIN_MS;
    if (closeAt <= ms) return closeAt;
    // Today, before opening: the stretch began at the previous working day's close.
  }
  return istDayStartMs(ms) - (MAX_LOOKAHEAD_DAYS + 1) * DAY_MS;
}

// How long someone has not been seen, counted from 10:00 today at the earliest, so every day
// starts fresh: a person not seen since yesterday is 20 min "away" at 10:20 and away from 10:30.
// null outside office hours (nobody is away at night, on Sunday or on a holiday). Never below
// 0: a last-seen time a moment newer than `ms` (memory flushed between two clock reads) is
// "just seen", not negative.
export function awayMinutes(lastSeenMs: number | null, ms: number, holidays: readonly string[] = []): number | null {
  if (!isOfficeHours(ms, holidays)) return null;
  const from = Math.max(lastSeenMs ?? 0, todayOpenMs(ms));
  return Math.max(0, Math.floor((ms - from) / MIN_MS));
}

export function isAway(lastSeenMs: number | null, ms: number, holidays: readonly string[] = []): boolean {
  const m = awayMinutes(lastSeenMs, ms, holidays);
  return m !== null && m >= AWAY_AFTER_MIN;
}
