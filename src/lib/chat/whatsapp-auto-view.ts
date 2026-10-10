// WhatsApp > Automation, the list under the panel cards (owner 2026-10-10: "jo bhi neeche dikh raha hai sab filter
// wise kar aur brand wise kar, izzat se kar; itna disturbance"). The automation keeps one row per message, so the
// old table showed every order twice (order placed, tracking link) with every brand mixed. Here: ONE line per order
// (both of its messages side by side), filtered by brand, by what needs doing, and by a search. Pure, no imports
// at runtime: the screen and the tests use it.

import type { RecentRow } from './whatsapp-auto';

export interface OrderLine {
  key: string; panelId: string; panel: string; orderId: string; name: string | null; to: string | null;
  placed: RecentRow | null; tracking: RecentRow | null; at: number;
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
    if (!o) { o = { key, panelId: r.panel_id, panel: r.panel, orderId: r.order_id, name: r.name, to: r.to, placed: null, tracking: null, at: 0 }; by.set(key, o); }
    if (r.kind === 'placed' && !o.placed) o.placed = r;
    if (r.kind === 'tracking' && !o.tracking) o.tracking = r;
    o.name = o.name || r.name; o.to = o.to || r.to;
  }
  const out = Array.from(by.values());
  // newest order first: the order-placed row is queued when the order comes in
  for (const o of out) o.at = o.placed ? ms(o.placed.due_at) : ms(o.tracking?.due_at) - 48 * 3_600_000;
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

export function filterOrders(lines: OrderLine[], f: { panel: string; show: AutoShow; q: string }): OrderLine[] {
  return lines.filter((o) => (f.panel === 'all' || o.panelId === f.panel) && matchesShow(o, f.show) && matchesSearch(o, f.q));
}

// The counts on the chips: per brand (with the chosen filter and search), per filter (in the chosen brand).
export function countByPanel(lines: OrderLine[], f: { show: AutoShow; q: string }): Record<string, number> {
  const out: Record<string, number> = { all: 0 };
  for (const o of lines) if (matchesShow(o, f.show) && matchesSearch(o, f.q)) { out.all++; out[o.panelId] = (out[o.panelId] || 0) + 1; }
  return out;
}
export function countByShow(lines: OrderLine[], f: { panel: string; q: string }): Record<AutoShow, number> {
  const out = { all: 0, failed: 0, waiting: 0, sent: 0, skipped: 0 } as Record<AutoShow, number>;
  for (const o of lines) {
    if ((f.panel !== 'all' && o.panelId !== f.panel) || !matchesSearch(o, f.q)) continue;
    for (const s of SHOW_LABELS) if (matchesShow(o, s.key)) out[s.key]++;
  }
  return out;
}
