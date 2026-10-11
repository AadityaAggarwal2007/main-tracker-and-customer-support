// WhatsApp > Automation, the list under the panel cards (owner 2026-10-10: "jo bhi neeche dikh raha hai sab filter
// wise kar aur brand wise kar, izzat se kar; itna disturbance"). The automation keeps one row per message, so the
// old table showed every order twice (order placed, tracking link) with every brand mixed. Here: ONE line per order
// (both of its messages side by side), filtered by brand, by what needs doing, and by a search. Pure, no imports
// at runtime: the screen and the tests use it.

import type { RecentRow } from './whatsapp-auto';

export interface OrderLine {
  key: string; panelId: string; panel: string; orderId: string; name: string | null; to: string | null;
  placed: RecentRow | null; tracking: RecentRow | null; at: number; orderAt: string | null;
}

export type AutoShow = 'all' | 'failed' | 'waiting' | 'sent' | 'skipped';
export const SHOW_LABELS: { key: AutoShow; label: string }[] = [
  { key: 'all', label: 'All orders' }, { key: 'failed', label: 'Failed' }, { key: 'waiting', label: 'Waiting' },
  { key: 'sent', label: 'Both sent' }, { key: 'skipped', label: 'Skipped' },
];

const GONE = ['sent', 'delivered', 'read'];
const ms = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };

export function groupOrders(rows: RecentRow[]): OrderLine[] {
  const by = new Map<string, OrderLine>();
  for (const r of rows) {
    const key = `${r.panel_id}|${r.order_id}`;
    let o = by.get(key);
    if (!o) { o = { key, panelId: r.panel_id, panel: r.panel, orderId: r.order_id, name: r.name, to: r.to, placed: null, tracking: null, at: 0, orderAt: r.order_at || null }; by.set(key, o); }
    if (r.kind === 'placed' && !o.placed) o.placed = r;
    if (r.kind === 'tracking' && !o.tracking) o.tracking = r;
    o.name = o.name || r.name; o.to = o.to || r.to; o.orderAt = o.orderAt || r.order_at || null;
  }
  const out = Array.from(by.values());
  // newest order first: the order-placed row is queued when the order comes in
  for (const o of out) o.at = ms(o.orderAt) || (o.placed ? ms(o.placed.due_at) : ms(o.tracking?.due_at) - 48 * 3_600_000);
  return out.sort((a, b) => b.at - a.at);
}

export function matchesShow(o: OrderLine, show: AutoShow): boolean {
  const both = [o.placed, o.tracking].filter((x): x is RecentRow => !!x);
  if (show === 'failed') return both.some((x) => x.status === 'failed');
  if (show === 'waiting') return both.some((x) => x.status === 'pending');
  if (show === 'skipped') return both.some((x) => x.status === 'skipped');
  if (show === 'sent') return !!o.placed && !!o.tracking && GONE.includes(o.placed.status) && GONE.includes(o.tracking.status);
  return true;
}

export function matchesSearch(o: OrderLine, q: string): boolean {
  const s = q.trim().toLowerCase().replace(/^#/, '');
  if (!s) return true;
  const digits = s.replace(/\D/g, '');
  return o.orderId.toLowerCase().replace(/^#/, '').includes(s)
    || (o.name || '').toLowerCase().includes(s)
    || (digits.length >= 3 && (o.to || '').includes(digits));
}

export function filterOrders(lines: OrderLine[], f: { panel: string; show: AutoShow; q: string; time?: AutoTime }): OrderLine[] {
  return lines.filter((o) => (f.panel === 'all' || o.panelId === f.panel) && matchesShow(o, f.show) && matchesSearch(o, f.q) && matchesTime(o, f.time || 'all'));
}

// The counts on the chips: per brand (with the chosen filter and search), per filter (in the chosen brand).
export function countByPanel(lines: OrderLine[], f: { show: AutoShow; q: string; time?: AutoTime }): Record<string, number> {
  const out: Record<string, number> = { all: 0 };
  for (const o of lines) if (matchesShow(o, f.show) && matchesSearch(o, f.q) && matchesTime(o, f.time || 'all')) { out.all++; out[o.panelId] = (out[o.panelId] || 0) + 1; }
  return out;
}
export function countByTime(lines: OrderLine[], f: { panel: string; show: AutoShow; q: string }): Record<AutoTime, number> {
  const out = { all: 0, night: 0, day: 0 } as Record<AutoTime, number>;
  for (const o of lines) {
    if ((f.panel !== 'all' && o.panelId !== f.panel) || !matchesShow(o, f.show) || !matchesSearch(o, f.q)) continue;
    for (const t of TIME_LABELS) if (matchesTime(o, t.key)) out[t.key]++;
  }
  return out;
}
export function countByShow(lines: OrderLine[], f: { panel: string; q: string; time?: AutoTime }): Record<AutoShow, number> {
  const out = { all: 0, failed: 0, waiting: 0, sent: 0, skipped: 0 } as Record<AutoShow, number>;
  for (const o of lines) {
    if ((f.panel !== 'all' && o.panelId !== f.panel) || !matchesSearch(o, f.q) || !matchesTime(o, f.time || 'all')) continue;
    for (const s of SHOW_LABELS) if (matchesShow(o, s.key)) out[s.key]++;
  }
  return out;
}

// ── The date filter (owner 2026-10-11: "date ka filter nahi hai, aaj ke kitne gaye, kya gaye, kyun gaye, raat ko kyun
// gaye"). Every message is judged by its own time (`at`: when it went, failed or was skipped; a waiting one by when it
// goes), in India time. The server reads only the chosen days (whatsapp-auto.ts automationOverview).
export type AutoDay = 'today' | 'yesterday' | '7d' | string;   // or one India date 'YYYY-MM-DD'
const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const istMidnight = (ms: number) => Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
export const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);

export function dayRange(day: string | null | undefined, nowMs: number): { day: string; from: number; to: number } {
  const today = istMidnight(nowMs);
  if (day === 'yesterday') return { day, from: today - DAY_MS, to: today };
  if (day === '7d') return { day, from: today - 6 * DAY_MS, to: today + DAY_MS };
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const from = Date.parse(`${day}T00:00:00Z`) - IST_MS;
    if (Number.isFinite(from) && from <= today && from > today - 120 * DAY_MS) return { day, from, to: from + DAY_MS };
  }
  return { day: 'today', from: today, to: today + DAY_MS };
}

// Office hours of the automation's tracking link: 10:00 to 19:30 India time. Outside = "night".
export const istMinute = (ms: number) => Math.floor(((ms + IST_MS) % DAY_MS) / 60_000);
export const isNight = (ms: number) => { const m = istMinute(ms); return m < 600 || m >= 1170; };
export type AutoTime = 'all' | 'night' | 'day';
export const TIME_LABELS: { key: AutoTime; label: string }[] = [
  { key: 'all', label: 'Any time' }, { key: 'day', label: 'Office hours (10 AM – 7:30 PM)' }, { key: 'night', label: 'Night (7:30 PM – 10 AM)' },
];
export function matchesTime(o: OrderLine, time: AutoTime): boolean {
  if (time === 'all') return true;
  // only the messages of the chosen days count (the other message of the order rides along to show both)
  return [o.placed, o.tracking].some((r) => !!r && r.in_range !== false && !!r.at && isNight(ms(r.at)) === (time === 'night'));
}

// Messages per India hour of the chosen days: went (sent / delivered / read), failed, skipped.
export function hourBuckets(rows: RecentRow[], range: { from: number; to: number }): { hour: number; went: number; failed: number; skipped: number }[] {
  const out = Array.from({ length: 24 }, (_, hour) => ({ hour, went: 0, failed: 0, skipped: 0 }));
  for (const r of rows) {
    const t = ms(r.at); if (!t || t < range.from || t >= range.to) continue;
    const b = out[Math.floor(istMinute(t) / 60)];
    if (GONE.includes(r.status)) b.went++; else if (r.status === 'failed') b.failed++; else if (r.status === 'skipped') b.skipped++;
  }
  return out;
}

// Why messages did not go, with how many: one line per reason (failed / skipped), most first.
export function reasonCounts(rows: RecentRow[], range: { from: number; to: number }): { status: 'failed' | 'skipped'; reason: string; n: number }[] {
  const m = new Map<string, { status: 'failed' | 'skipped'; reason: string; n: number }>();
  for (const r of rows) {
    if (r.status !== 'failed' && r.status !== 'skipped') continue;
    const t = ms(r.at); if (!t || t < range.from || t >= range.to) continue;
    const reason = (r.error || 'No reason saved').replace(/\s+/g, ' ').trim() + (r.code ? ` [${r.code}]` : '');
    const k = r.status + '|' + reason;
    const x = m.get(k) || { status: r.status, reason, n: 0 }; x.n++; m.set(k, x);
  }
  return Array.from(m.values()).sort((a, b) => b.n - a.n);
}

// One line, in words, of why a message went when it did.
export function whyLine(r: RecentRow, orderAt: string | null): string {
  const fmt = (iso: string) => new Date(ms(iso)).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  if (r.kind === 'placed') return orderAt ? `the order came in ${fmt(orderAt)}` : 'sent as the order came in';
  return 'the order was 48 hours old (tracking links go only in office hours)';
}
