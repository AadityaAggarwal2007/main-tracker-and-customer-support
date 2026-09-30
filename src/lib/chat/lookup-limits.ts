// ── Guessing limits for "order ID + phone" checks ──────────────
// Order IDs are sequential and site keys sit in every storefront's page source,
// so the only thing between a caller and a stranger's order is the phone number.
// Failed attempts are counted in memory: ShipTrack runs as a single PM2 process,
// and a counter that resets on deploy is still far better than none.
//
// Shared by the widget's verify form (/api/widget/verify) and the chat's order
// lookup (ai.ts). Next.js may bundle each route with its own copy of this module,
// so the counters live on globalThis: one set for the whole process, and a
// caller cannot dodge one path's limit by using the other.
//
// visitorId is made up by the caller, so the visitor limit alone stops only
// honest mistakes. The IP limit uses nginx's X-Real-IP (see clientIp), and the
// order and phone limits cap guessing at one target however the caller rotates
// the rest: the 6 missing phone digits of one order, or the order numbers of one
// known phone.

export const LIMITS = {
  visitor: { max: 5, windowMs: 15 * 60 * 1000 },
  ip: { max: 20, windowMs: 60 * 60 * 1000 },
  order: { max: 10, windowMs: 24 * 60 * 60 * 1000 },
  phone: { max: 10, windowMs: 24 * 60 * 60 * 1000 },
};

const MAX_ENTRIES = 10000;

type Entry = { count: number; resetAt: number };
const shared = globalThis as unknown as { __shiptrackLookupFailures?: Map<string, Entry> };
const failures: Map<string, Entry> = shared.__shiptrackLookupFailures || (shared.__shiptrackLookupFailures = new Map());

function prune(now: number) {
  for (const [k, v] of failures) if (now > v.resetAt) failures.delete(k);
  // Still too many live entries: drop the oldest (a Map keeps insertion order).
  for (const k of failures.keys()) {
    if (failures.size <= MAX_ENTRIES) break;
    failures.delete(k);
  }
}

export function isLimited(key: string, max: number): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    failures.delete(key);
    return false;
  }
  return entry.count >= max;
}

// Counted before the database is asked, so parallel requests cannot all slip
// past the check while the first ones are still in flight. A match gives the
// attempt back (release).
export function reserve(key: string, windowMs: number) {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now > entry.resetAt) {
    failures.set(key, { count: 1, resetAt: now + windowMs });
    if (failures.size > MAX_ENTRIES / 2) prune(now);
    return;
  }
  entry.count += 1;
}

export function release(key: string) {
  const entry = failures.get(key);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) failures.delete(key);
}
