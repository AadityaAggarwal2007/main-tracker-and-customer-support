// ── The Mail tab's filters, search and order (owner 2026-10-08: "filter bana de, search bar bana") ──
// Pure (no imports): the screen keeps the last list it read and filters it here, so a filter click never
// goes back to Gmail. Staff screen only.

export type MailView = 'all' | 'unread' | 'unverified' | 'verified' | 'notreplied' | 'replied' | 'attach' | 'today' | 'week';
export type MailSort = 'unreadfirst' | 'newest' | 'oldest';

export interface FilterItem { uid: number; from: string; fromAddress: string; subject: string; date: string; unread: boolean; hasAttachment: boolean; answered: boolean }
export type VerifiedMap = Record<string, { orderId: string }[] | undefined>;

export const VIEW_LABELS: Record<MailView, string> = {
  all: 'All mail', unread: 'Unread', unverified: 'Not verified', verified: 'Verified',
  notreplied: 'Not replied', replied: 'Replied', attach: 'With attachment', today: 'Today', week: 'Last 7 days',
};

const DAY = 24 * 60 * 60 * 1000;
export const startOfDay = (now: number): number => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const isVerified = (it: FilterItem, v: VerifiedMap) => !!v[it.fromAddress]?.length;
const time = (it: FilterItem) => Date.parse(it.date) || 0;

export function matchesView(it: FilterItem, view: MailView, v: VerifiedMap, now: number): boolean {
  switch (view) {
    case 'all': return true;
    case 'unread': return it.unread;
    case 'unverified': return !isVerified(it, v);
    case 'verified': return isVerified(it, v);
    case 'notreplied': return !it.answered;
    case 'replied': return it.answered;
    case 'attach': return it.hasAttachment;
    case 'today': return time(it) >= startOfDay(now);
    case 'week': return time(it) >= now - 7 * DAY;
  }
}

export function viewCounts(items: FilterItem[], v: VerifiedMap, now: number): Record<MailView, number> {
  const out = {} as Record<MailView, number>;
  for (const k of Object.keys(VIEW_LABELS) as MailView[]) out[k] = items.filter(it => matchesView(it, k, v, now)).length;
  return out;
}

// Sender name or address, subject, and the order number a customer wrote (or was verified for): "1553" and "#1553" both find it.
export function searchMatch(it: FilterItem, q: string, v: VerifiedMap): boolean {
  const t = q.trim().toLowerCase().replace(/^#/, '');
  if (!t) return true;
  if (it.from.toLowerCase().includes(t) || it.fromAddress.includes(t) || it.subject.toLowerCase().includes(t)) return true;
  return (v[it.fromAddress] || []).some(x => x.orderId.toLowerCase().replace(/^#/, '').includes(t));
}

export function sortItems<T extends FilterItem>(list: T[], sort: MailSort): T[] {
  return [...list].sort((a, b) => {
    if (sort === 'oldest') return time(a) - time(b);
    if (sort === 'unreadfirst' && a.unread !== b.unread) return a.unread ? -1 : 1;
    return time(b) - time(a);
  });
}

// Previous / next mail in the list that is on screen (null at the ends or when the mail is not in it).
export function neighbour(list: { uid: number }[], uid: number | null, dir: 1 | -1): number | null {
  const i = list.findIndex(x => x.uid === uid);
  if (i < 0) return null;
  return list[i + dir]?.uid ?? null;
}

// "#1553" numbers visible in a subject, for the small chip on a row.
export function orderNumbersIn(subject: string): string[] {
  return Array.from(new Set(Array.from((subject || '').matchAll(/#\s?(\d{3,8})\b/g)).map(m => `#${m[1]}`))).slice(0, 2);
}

export function initials(name: string): string {
  const parts = (name || '').replace(/<.*>/, '').trim().split(/\s+/).filter(Boolean);
  const s = (parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
  return (s || '?').toUpperCase();
}
