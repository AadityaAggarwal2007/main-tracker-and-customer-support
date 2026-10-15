// ── The Mail tab's filters, search and order (owner 2026-10-08: "filter bana de, search bar bana") ──
// Pure (no imports): the screen keeps the last list it read and filters it here, so a filter click never
// goes back to Gmail. Staff screen only.

export type MailView = 'todo' | 'done' | 'other' | 'active' | 'closed' | 'all' | 'unread' | 'unverified' | 'verified' | 'notreplied' | 'replied' | 'attach' | 'today' | 'week';
export type MailSort = 'unreadfirst' | 'newest' | 'oldest';

// repliedAt: when we last wrote to this customer after this mail, in any conversation (ISO; the mail store only, mail-store.ts storeList).
export interface FilterItem { uid: number; from: string; fromAddress: string; subject: string; date: string; unread: boolean; hasAttachment: boolean; answered: boolean; replied?: boolean; repliedAt?: string; snippet?: string; contact?: boolean; bounce?: MailBounce }
// Gmail's "could not deliver" report(s) on our mails to this customer since their newest mail (mail-store-rules.ts
// applyBounces, owner 2026-10-14): why = BounceWhy, count = how many. open = it came after our last reply, so the mail
// counts as NOT replied (To reply, Active case) until we write again.
export interface MailBounce { at: string; why: string; to: string | null; count?: number; open?: boolean }
export type VerifiedMap = Record<string, { orderId: string }[] | undefined>;

// ── Cases per customer (owner 2026-10-11 afternoon: "active case aur close case ... jo customer dobara dobara email kar
// rahe na unko hum log ek active case mein jaake reply ... close case") ──
// One case per sender address per mailbox (mail-cases.ts keeps the close / reopen by hand in chat_settings). A mail
// that is not a customer's (isCustomerMail) never has a case.
// Since 2026-10-11 12:45 (owner, live test: he replied and the customer stayed in Active cases; "Chat Support jaisa,
// apne aap") the case works on TIMES, like a chat: our last mark = when we last answered the customer's newest mail
// (repliedAt from the store; without it, the replied / answered flag counts as "answered at the mail's own time") or
// closed the case by hand; their last mark = their newest mail, or a reopen by hand. CLOSED when our mark is not older
// than theirs (a reply closes the case by itself, so does Close case); ACTIVE otherwise (a new mail from the customer,
// or a reopen, until we reply again or close again). The To reply / Replied boxes keep their own rule (bucketOf).
export interface MailCase { closedAt: string | null; by?: string; byName?: string; reopenedAt?: string | null }
export type CasesMap = Record<string, MailCase | undefined>;
export type CaseState = 'active' | 'closed';
// closedBy: 'reply' = we wrote after their newest mail (closedAt = when), 'hand' = Close case (closedAt = when, byName = who)
export interface CustomerCase { state: CaseState; closedAt: string | null; closedBy?: 'reply' | 'hand'; byName?: string }
export const caseAddress = (address: string): string => (address || '').trim().toLowerCase();
const stampMs = (s: string | null | undefined): number => (s ? Date.parse(s) || 0 : 0);
const closedAtMs = (c: MailCase | undefined): number => stampMs(c?.closedAt);
// The close by hand this mail falls under (it is not newer than the close), else null: the To reply box reads it
// (a manual close clears To reply without a reply); the case state itself is caseMarks below.
export function caseClosedAt(it: FilterItem, cases: CasesMap | undefined): string | null {
  const c = cases?.[caseAddress(it.fromAddress)];
  const at = closedAtMs(c);
  return at && time(it) <= at ? (c as MailCase).closedAt : null;
}
// The two marks of one customer, from their newest mail and the case by hand (0 = never).
function caseMarks(newest: FilterItem, c: MailCase | undefined): { ours: number; theirs: number; replyAt: number } {
  const replyAt = newest.repliedAt ? stampMs(newest.repliedAt) : (newest.replied || newest.answered ? time(newest) : 0);
  return { ours: Math.max(replyAt, closedAtMs(c)), theirs: Math.max(time(newest), stampMs(c?.reopenedAt)), replyAt };
}
// The customer's state from their NEWEST mail.
export function caseState(newest: FilterItem, cases: CasesMap | undefined): CaseState {
  const m = caseMarks(newest, cases?.[caseAddress(newest.fromAddress)]);
  return m.ours > 0 && m.ours >= m.theirs ? 'closed' : 'active';
}
// The open mail's customer: their state from their newest mail in the list, and how it was closed (null = not a customer,
// or the address is not in the list).
export function customerCase(items: FilterItem[], address: string, v: VerifiedMap, cases: CasesMap | undefined): CustomerCase | null {
  const k = caseAddress(address);
  const mine = items.filter(it => caseAddress(it.fromAddress) === k);
  if (!mine.length || !isCustomerMail(mine[0], v)) return null;
  const newest = mine.reduce((a, b) => (time(b) > time(a) ? b : a));
  const c = cases?.[k];
  const m = caseMarks(newest, c);
  if (!(m.ours > 0 && m.ours >= m.theirs)) return { state: 'active', closedAt: null };
  // the later of the two closed it: the reply, else the close by hand (a close after the reply is the one the team meant)
  if (m.replyAt >= closedAtMs(c)) return { state: 'closed', closedAt: newest.repliedAt || newest.date, closedBy: 'reply' };
  return { state: 'closed', closedAt: (c as MailCase).closedAt, closedBy: 'hand', byName: c?.byName };
}
// One row per customer (their newest conversation) with how many conversations the list holds of them (the last 30 days),
// newest first; only the customers in the asked state. Not-customer mail is never a case.
export function caseRows<T extends FilterItem>(items: T[], v: VerifiedMap, cases: CasesMap | undefined, state: CaseState): (T & { convCount: number })[] {
  const by = new Map<string, { newest: T; n: number }>();
  for (const it of items) {
    if (!isCustomerMail(it, v)) continue;
    const k = caseAddress(it.fromAddress);
    const have = by.get(k);
    if (!have) by.set(k, { newest: it, n: 1 });
    else { have.n++; if (time(it) > time(have.newest)) have.newest = it; }
  }
  return Array.from(by.values())
    .filter(x => caseState(x.newest, cases) === state)
    .sort((a, b) => time(b.newest) - time(a.newest))
    .map(x => ({ ...x.newest, convCount: x.n }));
}

export const VIEW_LABELS: Record<MailView, string> = {
  todo: 'To reply', done: 'Replied', other: 'Not customers', active: 'Active cases', closed: 'Closed cases',
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
// sent through mailing services) is "Not customers". A customer's mail is "Replied" once we wrote to that customer
// after it, in the same Gmail conversation or any other (storeList's replied, owner 2026-10-11 13:02: two mails of one
// customer in two threads, one answer), or Gmail marks it answered; else "To reply".
const PERSONAL = /@(gmail|googlemail|yahoo|ymail|rocketmail|outlook|hotmail|live|msn|icloud|me|mac|rediffmail|rediff|aol|proton|protonmail|pm|zoho|yandex|gmx|mail|inbox)\.[a-z.]{2,8}$/i;
const ROBOT = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|news|marketing|promotions?|offers?|updates?|info|hello|team|billing|accounts?|admin|support|feedback|digest)([._+-]|@)/i;
export function isCustomerMail(it: FilterItem, v: VerifiedMap): boolean {
  if (isVerified(it, v)) return true;
  const a = (it.fromAddress || '').toLowerCase();
  if (ROBOT.test(a)) return false;
  // A personal mailbox, or an address we have written to before (a customer with a work / college address, owner
  // 2026-10-14: such mails sat under "Not customers" and never in To reply).
  return PERSONAL.test(a) || !!it.contact;
}
export type MailBucket = 'todo' | 'done' | 'other';
// cases (owner 2026-10-11 afternoon): a mail under a closed case is "Replied" even without a reply (closing clears it from
// To reply); without the map the boxes are as before.
export function bucketOf(it: FilterItem, v: VerifiedMap, cases?: CasesMap): MailBucket {
  if (!isCustomerMail(it, v)) return 'other';
  if (cases && caseClosedAt(it, cases)) return 'done';
  return it.replied || it.answered ? 'done' : 'todo';
}
export const BUCKET_LABEL: Record<MailBucket, string> = { todo: 'To reply', done: 'Replied', other: 'Not a customer' };

export function matchesView(it: FilterItem, view: MailView, v: VerifiedMap, now: number, cases?: CasesMap): boolean {
  switch (view) {
    case 'todo': case 'done': case 'other': return bucketOf(it, v, cases) === view;
    // per mail, by the same marks (a reply after it, the flag, or a close / reopen by hand); the Active / Closed cases lists
    // themselves are one row per customer (caseRows)
    case 'active': case 'closed': return isCustomerMail(it, v) && caseState(it, cases) === view;
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

// Active / Closed cases count CUSTOMERS, not mails.
export function viewCounts(items: FilterItem[], v: VerifiedMap, now: number, cases?: CasesMap): Record<MailView, number> {
  const out = {} as Record<MailView, number>;
  for (const k of Object.keys(VIEW_LABELS) as MailView[]) {
    out[k] = k === 'active' || k === 'closed' ? caseRows(items, v, cases, k).length : items.filter(it => matchesView(it, k, v, now, cases)).length;
  }
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

// ── Bounces: "Mail Delivery Subsystem" (owner 2026-10-14, a "recipient's inbox is out of storage space" and a "Message
// blocked" mail showed "Not verified · Verify", Notes and Correction as if a customer had written) ──
// Gmail's own report that one of OUR mails did not reach the customer. Never a customer: no verify, no case, no
// reply; the screen says to whom it failed and why, in plain words.
const BOUNCE_FROM = /^(mailer-daemon|postmaster)@/i;
const BOUNCE_SUBJECT = /^(delivery status notification|undeliverable|undelivered mail|mail delivery (failed|subsystem)|returned mail|delivery (failure|incomplete|has failed)|message (blocked|not delivered))/i;
export function isBounce(fromAddress: string | null | undefined, subject?: string | null): boolean {
  const a = String(fromAddress || '').trim().toLowerCase();
  if (BOUNCE_FROM.test(a)) return true;
  return ROBOT.test(a) && BOUNCE_SUBJECT.test(String(subject || '').trim());
}
export type BounceWhy = 'suspicious' | 'limit' | 'full' | 'blocked' | 'not_found' | 'other';
export const BOUNCE_WHY: Record<BounceWhy, string> = {
  // owner 2026-10-14 (VASTRIKA: "Your message to ... appears suspicious and wasn't delivered"): Gmail ITSELF stopped our
  // mail before it left; nothing reached the customer and their address is fine.
  suspicious: 'Gmail itself stopped our mail before it left (it never reached the customer): Google thought it looked suspicious. Their address is fine; it is about how much and what this Gmail sends. Do not send the same text again and again (each try makes Google stricter): send one short, plain reply without links, and tell the Super Admin if it keeps happening.',
  limit: 'This Gmail has reached Google\'s daily sending limit, so nothing more goes out from it for up to 24 hours. Reply again tomorrow and tell the Super Admin.',
  full: 'Their Gmail inbox is full (out of storage), so our mail could not be handed over. Nothing is wrong on our side. Gmail keeps trying by itself for about a day: if they free space, it arrives then. Do NOT send it again: every new mail bounces too and makes Google trust this Gmail less. Answer them when they write again, or Close case.',
  blocked: 'Their mail server refused our mail, usually because it looked like spam (many links, a long tracking link, or many mails sent from this Gmail in a short time). Send a short mail without links, or ask them to check Spam.',
  not_found: 'This address does not exist. Check the email on the order for a typo. Sending again to the same address will bounce again.',
  other: 'Gmail could not deliver our mail. Its reason is in the mail below.',
};
const EMAIL_IN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export function bounceInfo(text: string | null | undefined, ownEmail?: string | null): { to: string | null; why: BounceWhy } {
  const t = String(text || '');
  const own = String(ownEmail || '').trim().toLowerCase();
  const named = t.match(/(?:message to|delivered to|deliver(?:ed)? it to|delivery to|wasn't delivered to|was not delivered to|couldn't be delivered to|could not be delivered to|failed recipients?:?|recipient address:?)\s*<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  let to: string | null = named ? named[1].toLowerCase() : null;
  if (!to) {
    for (const m of t.match(EMAIL_IN) || []) {
      const a = m.toLowerCase();
      if (a === own || BOUNCE_FROM.test(a) || /@(googlemail\.com|google\.com)$/.test(a)) continue;
      to = a; break;
    }
  }
  const why: BounceWhy = /appears suspicious|looks suspicious|wasn'?t delivered because it (looks|appears) suspicious|unusual sending activity/i.test(t) ? 'suspicious'
    : /reached a limit for sending|sending limit exceeded|daily (user )?sending (quota|limit)/i.test(t) ? 'limit'
    : /out of storage|storage space|mailbox (is )?full|inbox is full|over quota|quota exceeded|insufficient storage/i.test(t) ? 'full'
    : /address not found|couldn'?t be found|could not be found|does ?n[o']t exist|no such user|user unknown|unknown user|account .{0,30}disabled/i.test(t) ? 'not_found'
    : /blocked|spam|rejected|refused|policy/i.test(t) ? 'blocked' : 'other';
  return { to, why };
}

// Gmail stopping OUR mails (suspicious / sending limit) today, India day (owner 2026-10-14): the Mail tab warns once at
// the top, so the team stops resending the same text into Google's filter. Counts a customer's row whose reply bounced
// and a bounce report that stands on its own.
export function gmailBlocksToday(items: FilterItem[], now: number): number {
  const day = (ms: number) => Math.floor((ms + 330 * 60_000) / 86_400_000);
  const today = day(now);
  let n = 0;
  for (const it of items) {
    if (it.bounce) { if ((it.bounce.why === 'suspicious' || it.bounce.why === 'limit') && day(Date.parse(it.bounce.at) || 0) === today) n++; continue; }
    if (!isBounce(it.fromAddress, it.subject) || day(time(it)) !== today) continue;
    const w = bounceInfo(`${it.subject} ${it.snippet || ''}`).why;
    if (w === 'suspicious' || w === 'limit') n++;
  }
  return n;
}

// A bounce for which sending again does not help (owner 2026-10-15: a customer's inbox was full and the team re-sent
// the reply many times): the reply box asks before another mail goes to that customer. Short words for that question.
export const RESEND_USELESS: Record<string, string> = {
  full: 'their Gmail inbox is full',
  not_found: 'the address does not exist',
  suspicious: 'Gmail stopped our mail as suspicious',
  limit: 'this Gmail reached its daily sending limit',
};
export function resendWarning(b: MailBounce | null | undefined): string | null {
  if (!b || !(b.why in RESEND_USELESS)) return null;
  const n = b.count && b.count > 1 ? `${b.count} of our mails` : 'Our last mail';
  return `${n} to this customer came back: ${RESEND_USELESS[b.why]}. This one will most likely come back too, and every bounce makes Google trust this Gmail less. Send anyway?`;
}
