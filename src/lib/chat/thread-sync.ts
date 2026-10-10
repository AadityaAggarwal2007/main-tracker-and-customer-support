// ── The open chat loads fast (owner 2026-10-10, step 6: "email aur purani chats jaldi khulein") ──
// Pure, shared by the thread route and the inbox. The inbox used to download the whole open chat (every message,
// the customer's earlier chats, the order, the team log) every 3 seconds. Now:
// - a full load (on open, and every FULL_EVERY_MS) brings the newest THREAD_PAGE messages and says how many are older
//   ("Load older" brings THREAD_PAGE more each time);
// - the 3-second poll asks only for what changed since the last answer (?after=): new, edited or deleted messages
//   and the chat's own row (status, holder, what this login may do). LIGHT_OVERLAP_MS of overlap so a message whose
//   transaction committed a moment after its created_at is never missed; the inbox merges by id, so a repeat is harmless.

export const THREAD_PAGE = 200;
export const LIGHT_MAX = 500;
export const FULL_EVERY_MS = 30_000;
export const LIGHT_OVERLAP_MS = 15_000;

// A cursor the route accepts: an ISO time within a day of now (anything else = a full load).
export function parseAfter(raw: string | null, now = Date.now()): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t > now + 60_000 || t < now - 86_400_000) return null;
  return new Date(t).toISOString();
}

// "Load older": the first message on screen (its time and id).
export function parseBefore(at: string | null, id: string | null): { at: string; id: string } | null {
  if (!at || !id || id.length > 100) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? { at: new Date(t).toISOString(), id } : null;
}

// The ?after= the inbox sends: the last answer's time minus the overlap.
export const afterFor = (asOf: string) => new Date(Date.parse(asOf) - LIGHT_OVERLAP_MS).toISOString();

interface Msg { id: string; created_at: string }
const byTime = (a: Msg, b: Msg) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The poll's changes into the list on screen: a message with the same id is replaced (an edit, a delete), a new one is
// added in time order.
export function mergeMessages<M extends Msg>(list: M[], changes: M[]): M[] {
  if (!changes.length) return list;
  const map = new Map(list.map((m) => [m.id, m] as const));
  for (const m of changes) map.set(m.id, { ...(map.get(m.id) ?? {}), ...m });
  return Array.from(map.values()).sort(byTime);
}

// A full reload brings the newest page again: the older messages "Load older" put on screen are kept (those before the
// page's first message), the rest is the server's.
export function keepOlder<M extends Msg>(list: M[], page: M[]): M[] {
  if (!page.length) return page;
  const first = page[0];
  const older = list.filter((m) => byTime(m, first) < 0 && !page.some((p) => p.id === m.id));
  return older.length ? [...older, ...page] : page;
}
