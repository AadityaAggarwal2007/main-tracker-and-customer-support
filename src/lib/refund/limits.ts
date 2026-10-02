// ── Refund form: rate limits for the public routes (owner, 2026-10-02) ──
// In memory, like the verify-form limits (src/lib/chat/lookup-limits.ts): ShipTrack runs as one PM2
// process, and the counters reset on a restart. They live on globalThis (Next.js may bundle each route
// with its own copy of this module) in their OWN map, capped at 5,000 entries (expired ones pruned
// first, then the oldest), so a flood of refund requests can never push out the verify-form counters.
// Keys carry an IP or 8 characters of a token HASH, never a token. Spec 3.3.
// Owner change 2026-10-02 ~15:00: no photo / video upload, so there are no file / part limits.

const MAX_ENTRIES = 5000;
const MIN = 60_000, HOUR = 60 * MIN;

export const REFUND_LIMITS = {
  bad:        { max: 20,  windowMs: HOUR },        // rf:bad:<ip>: bad format, unknown token, wrong origin; then 429 everywhere
  open_ip:    { max: 30,  windowMs: 10 * MIN },    // rf:open:<ip>
  open_tok:   { max: 60,  windowMs: 24 * HOUR },   // rf:open:tok:<hash8>
  submit_tok: { max: 10,  windowMs: HOUR },        // rf:submit:tok:<hash8> (validation failures count)
  submit_ip:  { max: 20,  windowMs: HOUR },        // rf:submit:<ip>
  reveal:     { max: 30,  windowMs: HOUR },        // Super Admin reveal, global
} as const;

type Entry = { count: number; resetAt: number };
const shared = globalThis as unknown as { __shiptrackRefundLimits?: Map<string, Entry> };
const counters: Map<string, Entry> = shared.__shiptrackRefundLimits || (shared.__shiptrackRefundLimits = new Map());

function prune(now: number) {
  for (const [k, v] of counters) if (now > v.resetAt) counters.delete(k);
  for (const k of counters.keys()) {   // still too many live entries: drop the oldest (insertion order)
    if (counters.size <= MAX_ENTRIES) break;
    counters.delete(k);
  }
}

// Counts first, then says whether this call is over the limit (the (max + 1)th call in the window is).
export function hit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const e = counters.get(key);
  if (!e || now > e.resetAt) {
    counters.delete(key);   // re-insert at the end, so "oldest" stays true
    counters.set(key, { count: 1, resetAt: now + windowMs });
    if (counters.size > MAX_ENTRIES) prune(now);
    return 1 > max;
  }
  e.count += 1;
  return e.count > max;
}

// Only checks: true once `max` calls were counted in the window (rf:bad: the 21st request gets 429).
export function limited(key: string, max: number): boolean {
  const e = counters.get(key);
  if (!e) return false;
  if (Date.now() > e.resetAt) { counters.delete(key); return false; }
  return e.count >= max;
}

// The first 8 characters of a token hash, for the per-link keys.
export const hash8 = (tokenHash: string) => String(tokenHash || '').slice(0, 8);

// Tests only.
export function resetRefundLimits() { counters.clear(); }
export const refundLimitEntries = () => counters.size;
