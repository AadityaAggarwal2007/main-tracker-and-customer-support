// ── Team score (owner, 2026-10-01, part 4): India-time arithmetic. Pure. ──
// STAFF ONLY: used by src/lib/team-score/* and the team score routes. Every IST rule of the report
// lives here, on plain epoch milliseconds: India has no daylight saving, so a fixed +5:30 offset is
// exact all year and the server's own time zone (TZ) never matters. No Date field getters or
// setters, no locale formatting and no time-zone library on purpose (a unit test greps for them).
import { IST_OFFSET_MIN, OFFICE_OPEN_MIN, OFFICE_CLOSE_MIN } from '@/lib/office-hours';

export const MIN_MS = 60_000, HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
export const IST_MS = IST_OFFSET_MIN * MIN_MS;                 // 330 min

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_DAY_LOOPS = 400;

// 00:00 IST of ms's India day, as UTC ms.
export function istDayStart(ms: number): number {
  return Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
}

// 'YYYY-MM-DD' of ms's India day.
export function istDay(ms: number): string {
  return new Date(ms + IST_MS).toISOString().slice(0, 10);
}

// 00:00 IST of a 'YYYY-MM-DD' India day, as UTC ms. null unless the text is a real date.
export function dayStartMs(day: string): number | null {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)), d = Number(day.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const utc = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== day) return null;   // 31 Feb
  return utc - IST_MS;
}

function mustStart(day: string): number {
  const s = dayStartMs(day);
  if (s === null) throw new Error(`team-score: not a date: ${String(day).slice(0, 20)}`);
  return s;
}

export function addDays(day: string, n: number): string {
  return istDay(mustStart(day) + Math.round(n) * DAY_MS);
}

// 10:00 IST (OFFICE_OPEN_MIN) of that India day.
export function openMs(day: string): number {
  return mustStart(day) + OFFICE_OPEN_MIN * MIN_MS;
}

// 19:30 IST (OFFICE_CLOSE_MIN): the first instant that is no longer office time.
export function closeMs(day: string): number {
  return mustStart(day) + OFFICE_CLOSE_MIN * MIN_MS;
}

// Milliseconds of [a, b) that fall inside office hours, [10:00, 19:30) IST of any day.
// 0 when b <= a. At most 400 day loops (the report never spans more than ~65 days).
export function officeMs(a: number, b: number): number {
  if (!(b > a)) return 0;
  let total = 0;
  let d = istDayStart(a);
  for (let i = 0; i < MAX_DAY_LOOPS && d < b; i++, d += DAY_MS) {
    const open = d + OFFICE_OPEN_MIN * MIN_MS, close = d + OFFICE_CLOSE_MIN * MIN_MS;
    total += Math.max(0, Math.min(b, close) - Math.max(a, open));
  }
  return total;
}

// The smallest t >= a with officeMs(a, t) >= need. need <= 0 gives a.
export function addOfficeMs(a: number, need: number): number {
  if (!(need > 0)) return a;
  let left = need;
  let d = istDayStart(a);
  const loops = MAX_DAY_LOOPS + Math.ceil(need / ((OFFICE_CLOSE_MIN - OFFICE_OPEN_MIN) * MIN_MS));
  for (let i = 0; i < loops; i++, d += DAY_MS) {
    const open = d + OFFICE_OPEN_MIN * MIN_MS, close = d + OFFICE_CLOSE_MIN * MIN_MS;
    const from = Math.max(a, open);
    if (close <= from) continue;
    if (left <= close - from) return from + left;
    left -= close - from;
  }
  return d;   // unreachable for any real input
}

// '14:05' India time.
export function hhmm(ms: number): string {
  const x = ((ms + IST_MS) % DAY_MS + DAY_MS) % DAY_MS;
  const h = Math.floor(x / HOUR_MS), m = Math.floor((x % HOUR_MS) / MIN_MS);
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
}

// '2 Oct' for '2026-10-02'.
export function dayLabel(day: string): string {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return String(day ?? '');
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`;
}

export function todayIst(nowMs: number): string {
  return istDay(nowMs);
}
