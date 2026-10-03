import { AlertCircle, Bot, Check, Clock, Flame, Inbox, Link2, MapPin, PackageX, RefreshCw, ShieldAlert, Truck, Undo2, User, UserCheck, UserRoundCheck, Users } from 'lucide-react';
import type { Conversation, InboxTab, NameSrc, TeamLogEntry } from './types';

// "away 40 min", "seen 3 min ago", "seen 2 h ago" beside a name in the transfer list.
export const minutesText = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`);
export function presenceText(away: number | null, seen: number | null | undefined): string {
  if (away != null) return `away ${minutesText(away)}`;
  if (seen == null) return '';
  return seen < 1 ? 'seen just now' : `seen ${minutesText(seen)} ago`;
}

// A team history time in India time: "14:05" today, "30 Sept 14:05" before.
export function logTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  const day = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return day(d) === day(new Date())
    ? time
    : `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })} ${time}`;
}

// One line of the team history in words. "You" when it was this login.
export function teamLogLine(e: TeamLogEntry, me: string | null): string {
  const actor = me && e.actor === me ? 'You' : (e.actor_name || 'Someone');
  const name = (key: string | null, n: string | null) => (key && me && key === me ? 'you' : n || 'a former member');
  const to = e.to_owner ? name(e.to_owner, e.to_name) : 'the open pool';
  switch (e.kind) {
    case 'claim': return `${actor} took it (${e.reason === 'reply' ? 'first reply' : 'Take over'})`;
    case 'take': return `${actor} took it from ${name(e.from_owner, e.from_name)}`;
    case 'transfer': {
      const from = e.from_owner && e.from_owner !== e.actor ? ` from ${name(e.from_owner, e.from_name)}` : '';
      return e.to_owner ? `${actor} transferred it${from} to ${to}` : `${actor} put it back in the open pool${from ? ` (it was ${name(e.from_owner, e.from_name)}'s)` : ''}`;
    }
    case 'inherit': return e.reason === 'same_customer_handover'
      ? `Needs a person: given to ${to} (had this customer's last chat)`
      : `Came back: given to ${to} (had this customer's last chat)`;
    case 'merge': return `Merged chats: given to ${to}`;
    default: return `${actor}: ${e.kind}`;
  }
}

// The name the widget shows the customer above AI replies ("Vastora Support"),
// built from the site name the same way public/widget.js builds it. The owner
// asked for the brand, not "AI", on these messages. A team reply says "You" when it
// is this login's, else the writer's name (the customer only ever sees the brand).
export function supportLabel(siteName?: string | null): string {
  const name = (siteName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) return 'Support';
  const brand = name.charAt(0).toUpperCase() + name.slice(1);
  return /\bsupport$/i.test(brand) ? brand : `${brand} Support`;
}

export const STATUS_LABELS: Record<string, string> = {
  ai_handling: 'AI',
  // Every chat a person has taken over, whoever it is (owner, 2026-10-01): "With Rahul" in the
  // thread header, "You" / the holder's name on a list row.
  agent_handling: 'With team',
  resolved: 'Closed',
  human_needed: 'Needs you',
};

export const CATEGORY_LABELS: Record<string, string> = {
  wrong_tracking: 'Wrong tracking',
  refund: 'Refund',
  cancellation: 'Cancellation',
  others: '',
};

// Kind of concern behind a subject label, so the team can tell at a glance
// (chips.tsx subjectTone): money (amber), a change the customer asks for
// (blue), something that went wrong (red), anything else (grey).
export const SUBJECT_MONEY = ['Refund / Cancellation', 'Refund', 'Cancellation', 'Payment issue', 'Payment method / COD'];
export const SUBJECT_CHANGE = ['Address change', 'Wrong address', 'Size exchange', 'Product exchange', 'Return', 'Cancellation'];
export const SUBJECT_PROBLEM = ['Not received', 'Damaged item', 'Wrong item', 'Missing item', 'Wrong tracking link', 'Delivery delay', 'Complaint'];

// An AI reply that was written but never sent — escalated to a person, or the
// send itself failed. The customer has not seen it.
export const WITHHELD_LABELS: Record<string, string> = {
  escalated: 'needs a human',
  send_failed: 'sending failed',
  sending: 'still sending',
};

export const POLL_MS = 3000;

export const TOPIC_ICONS: Record<string, typeof Inbox> = {
  risk: Flame, fraud: ShieldAlert, refund: Undo2, tracking: Link2, delay: Clock, address: MapPin, damaged: PackageX, exchange: RefreshCw,
};
export const INBOX_TABS: { v: InboxTab; label: string; icon: typeof Inbox; status: string; segment: '' | 'visitors' | 'customers' }[] = [
  { v: 'all', label: 'All', icon: Inbox, status: '', segment: 'customers' },
  { v: 'visitors', label: 'Visitors', icon: Users, status: '', segment: 'visitors' },
  { v: 'customers', label: 'Customers', icon: UserCheck, status: '', segment: 'customers' },
  { v: 'human_needed', label: 'Needs you', icon: AlertCircle, status: 'human_needed', segment: '' },
  { v: 'mine', label: 'My chats', icon: UserRoundCheck, status: '', segment: '' },
  { v: 'agent_handling', label: 'With team', icon: User, status: 'agent_handling', segment: '' },
  { v: 'ai_handling', label: 'With AI', icon: Bot, status: 'ai_handling', segment: '' },
  // Refund / Ship again (owner, 2026-10-01): a marked chat shows only here; no status of its own.
  { v: 'case:refund', label: 'Refund', icon: Undo2, status: '', segment: '' },
  { v: 'case:reship', label: 'Ship again', icon: Truck, status: '', segment: '' },
  { v: 'resolved', label: 'Closed', icon: Check, status: 'resolved', segment: '' },
];

// How another chat's status reads on its divider or bar ("Earlier chat ·
// 28 Sept · Closed"): the inbox tab names.
export function chatStatusLabel(status: string): string {
  return INBOX_TABS.find(t => t.status === status)?.label || '';
}

// "Waiting 3h": how long the customer has been waiting for an answer, short enough
// for a chip ("now", "40m", "3h", "2d"; the hover has waiting.ts's fuller text).
export function waitingText(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
export const msSince = (iso: string) => Date.now() - Date.parse(iso);

// The name to print for a chat, and a hover note when it is not the chat's own
// but taken from its order (a phone match is a staff hint, not verification).
export const convName = (c: { display_name?: string | null; visitor_name: string | null }) =>
  c.display_name || c.visitor_name || 'Visitor';

export const nameFromOrder = (c: NameSrc) => !!c.name_from_order && !c.verified_order_id;
export const nameNote = (c: NameSrc) => !c.name_from_order ? undefined
  : c.verified_order_id ? `Name from order ${c.verified_order_id}`
  : `Name from order ${c.phone_match_order_id ?? ''}, matched by phone number (not verified)`;

// India is where the stores ship, so dates are read in India time whatever the
// staff member's own clock says. "26 Sep" (en-IN would say "Sept"); the year only
// when it is not this year.
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function orderDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ist = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number); // [y, m, d]
  const [y, m, day] = ist(d);
  const [thisYear] = ist(new Date());
  return `${day} ${SHORT_MONTHS[m - 1] ?? ''}${y !== thisYear ? ` ${y}` : ''}`;
}

export const stampIST = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

// Who closed a Closed chat, in words: the system (auto_closed_at: 4 quiet days) or a
// team member (with their name and the time when it was recorded). Null when the chat
// is not Closed. Rows closed before chat-closed-by.sql just say "by support".
export function closedInfo(c: { status: string; auto_closed_at?: string | null; closed_by_name?: string | null; closed_at?: string | null }) {
  if (c.status !== 'resolved') return null;
  const stamp = (iso?: string | null) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime())
      ? d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
      : '';
  };
  if (c.auto_closed_at) {
    const at = stamp(c.auto_closed_at);
    return {
      auto: true,
      short: 'Closed · AI',
      long: 'Closed by AI (4 quiet days)',
      title: `Closed by AI (the automatic sweep)${at ? ` on ${at}` : ''}: nobody wrote for 4 days and the customer was not waiting for an answer. Nothing was sent to the customer. If they write again it opens itself.`,
    };
  }
  const name = (c.closed_by_name || '').trim();
  const at = stamp(c.closed_at);
  return {
    auto: false,
    short: 'Closed · support',
    long: `Closed by support${name ? ` (${name})` : ''}`,
    title: `Closed by ${name || 'a team member'}${at ? ` on ${at}` : ''}.`,
  };
}

// Refund / Ship again (chat-cases.sql): which section, who marked it, when.
export const CASE_LABELS: Record<string, string> = { refund: 'Refund', reship: 'Ship again' };

// A visitor: a chat that has not proved an order (no verified order, no old phone
// match). Same split as the Visitors / Customers tabs. The frustration score is shown
// for customers only (owner, 2026-09-30: a visitor is not flagged "100% Critical",
// and carries no Threat / Fraud claim chip or Waiting timer either).
export const isVisitorChat = (c: { verified_order_id?: string | null; phone_match_order_id?: string | null }) =>
  !c.verified_order_id && !c.phone_match_order_id;

export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// A link stops at an asterisk, so "**https://…/abc**" still opens the page.
// " · matched: order, message": which kind of match put a chat in the results.
export function matchedText(c: Conversation): string {
  const why = [c.hit_order && 'order', c.hit_phone && 'phone', c.hit_name && 'name', c.hit_text && 'message'].filter(Boolean);
  return why.length ? ` · matched: ${why.join(', ')}` : '';
}

export const draggingFiles = (e: { dataTransfer: DataTransfer | null }) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

export const fullDate = (iso: string) =>
  new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
