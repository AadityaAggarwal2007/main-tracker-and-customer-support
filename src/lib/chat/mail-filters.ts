// ── The Mail tab's filters, search and order (owner 2026-10-08: "filter bana de, search bar bana") ──
// Pure (no imports): the screen keeps the last list it read and filters it here, so a filter click never
// goes back to Gmail. Staff screen only.

export type MailView = 'todo' | 'done' | 'other' | 'all' | 'unread' | 'unverified' | 'verified' | 'notreplied' | 'replied' | 'attach' | 'today' | 'week';
export type MailSort = 'unreadfirst' | 'newest' | 'oldest';

export interface FilterItem { uid: number; from: string; fromAddress: string; subject: string; date: string; unread: boolean; hasAttachment: boolean; answered: boolean; replied?: boolean; snippet?: string }
export type VerifiedMap = Record<string, { orderId: string }[] | undefined>;

export const VIEW_LABELS: Record<MailView, string> = {
  todo: 'To reply', done: 'Replied', other: 'Not customers',
  all: 'All mail', unread: 'Unread', unverified: 'Not verified', verified: 'Verified',
  notreplied: 'Not replied', replied: 'Replied', attach: 'With attachment', today: 'Today', week: 'Last 7 days',
};

const DAY = 24 * 60 * 60 * 1000;
export const startOfDay = (now: number): number => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const isVerified = (it: FilterItem, v: VerifiedMap) => !!v[it.fromAddress]?.length;
const time = (it: FilterItem) => Date.parse(it.date) || 0;

// ── The three boxes (owner 2026-10-11: "Jawab dena hai / Jawab de diya / Customer nahi") ──
// A customer: a sender verified for an order, or a person writing from a personal mailbox (Gmail, Yahoo, Outlook ...)
// that is not a no-reply / notification address. Everything else (newsletters, banks, gateways, tools, sales pitches
// sent through mailing services) is "Not customers". A customer's mail is "Replied" once we wrote in the same Gmail
// conversation after it (or Gmail marks it answered), else "To reply".
const PERSONAL = /@(gmail|googlemail|yahoo|ymail|rocketmail|outlook|hotmail|live|msn|icloud|me|mac|rediffmail|rediff|aol|proton|protonmail|pm|zoho|yandex|gmx|mail|inbox)\.[a-z.]{2,8}$/i;
const ROBOT = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|news|marketing|promotions?|offers?|updates?|info|hello|team|billing|accounts?|admin|support|feedback|digest)([._+-]|@)/i;
export function isCustomerMail(it: FilterItem, v: VerifiedMap): boolean {
  if (isVerified(it, v)) return true;
  const a = (it.fromAddress || '').toLowerCase();
  return PERSONAL.test(a) && !ROBOT.test(a);
}
export type MailBucket = 'todo' | 'done' | 'other';
export function bucketOf(it: FilterItem, v: VerifiedMap): MailBucket {
  if (!isCustomerMail(it, v)) return 'other';
  return it.replied || it.answered ? 'done' : 'todo';
}
export const BUCKET_LABEL: Record<MailBucket, string> = { todo: 'To reply', done: 'Replied', other: 'Not a customer' };

export function matchesView(it: FilterItem, view: MailView, v: VerifiedMap, now: number): boolean {
  switch (view) {
    case 'todo': case 'done': case 'other': return bucketOf(it, v) === view;
    case 'all': return true;
    case 'unread': return it.unread;
    case 'unverified': return !isVerified(it, v);
    case 'verified': return isVerified(it, v);
    case 'notreplied': return !(it.answered || it.replied);
    case 'replied': return !!(it.answered || it.replied);
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
  if (it.from.toLowerCase().includes(t) || it.fromAddress.includes(t) || it.subject.toLowerCase().includes(t) || (it.snippet || '').toLowerCase().includes(t)) return true;
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
