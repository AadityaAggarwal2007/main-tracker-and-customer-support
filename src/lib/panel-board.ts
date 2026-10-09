// ── The panel board (owner 2026-10-09): "har panel ki ek line: is par kya karna hai" ───────────
// Pure: the numbers come from panel-board-server.ts, these rules turn them into the lines the owner reads
// every morning on the Orders tab, one card per panel, the panel with the most to do first. Nothing here is
// read by the AI or shown to a customer.

export interface PanelStats {
  id: string;
  name: string;
  // Chat Support (one row per customer, like the inbox counts)
  needsYou: number;        // chats in Needs you
  waiting: number;         // customers waiting for a reply (any open chat)
  overdue: number;         // of those, waiting 2 hours or more
  emailWaiting: number;    // held email replies in Needs you
  refundCases: number;     // open Refund-marked chats
  reshipToShip: number;    // Ship again chats whose new parcel is not sent yet
  // Super Admin only (null = not shown to this login). refundRequestsNew is filled in by the screen from
  // GET /api/refunds/counts?byPanel=1 (the refund tables stay in src/lib/refund); the server sends null.
  chargebacksOpen: number | null;
  refundRequestsNew: number | null;
  // Orders
  ordersToday: number;
  lateOrders: number;      // past the estimated date, not delivered, not cancelled / returned (last 60 days)
  // Setup
  aiOn: boolean | null;    // null = the panel has no chat site yet
  hasPrompt: boolean;
  supportGmail: boolean;
  chargebackGmail: boolean;
  whatsapp: boolean;       // the chargeback WhatsApp number is set
}

export type NeedTone = 'danger' | 'warn' | 'ok';
export interface Need { tone: NeedTone; text: string; go?: 'chats' | 'chargebacks' | 'refunds' | 'settings' | 'orders' }

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// The lines, most urgent first. Chargebacks and threats to the customer first, then waiting customers, then the
// setup gaps a new panel usually has (owner: new panels must reach Vastora's level). "All clear" when nothing.
export function panelNeeds(s: PanelStats): Need[] {
  const out: Need[] = [];
  if ((s.chargebacksOpen ?? 0) > 0) out.push({ tone: 'danger', text: `${n(s.chargebacksOpen!, 'chargeback', 'chargebacks')} open: answer the gateway before its deadline`, go: 'chargebacks' });
  if (s.overdue > 0) out.push({ tone: 'danger', text: `${n(s.overdue, 'customer', 'customers')} waiting over 2 hours`, go: 'chats' });
  if (s.needsYou > 0) out.push({ tone: s.overdue > 0 ? 'warn' : 'danger', text: `${n(s.needsYou, 'chat needs', 'chats need')} you${s.emailWaiting > 0 ? ` (${n(s.emailWaiting, 'held email', 'held emails')})` : ''}`, go: 'chats' });
  if (s.waiting > s.overdue) out.push({ tone: 'warn', text: `${n(s.waiting - s.overdue, 'customer', 'customers')} waiting under 2 hours`, go: 'chats' });
  if ((s.refundRequestsNew ?? 0) > 0) out.push({ tone: 'warn', text: `${n(s.refundRequestsNew!, 'refund request', 'refund requests')} to decide`, go: 'refunds' });
  if (s.refundCases > 0) out.push({ tone: 'warn', text: `${n(s.refundCases, 'Refund chat', 'Refund chats')} open`, go: 'chats' });
  if (s.reshipToShip > 0) out.push({ tone: 'warn', text: `${n(s.reshipToShip, 'Ship again parcel', 'Ship again parcels')} not sent yet`, go: 'chats' });
  if (s.lateOrders > 0) out.push({ tone: 'warn', text: `${n(s.lateOrders, 'order', 'orders')} past the estimated date`, go: 'orders' });
  if (s.aiOn === false) out.push({ tone: 'warn', text: 'Chikki is OFF: every chat waits for a person', go: 'settings' });
  if (!s.hasPrompt) out.push({ tone: 'warn', text: 'Chikki has no prompt yet: use Settings > Copy setup', go: 'settings' });
  if (!s.supportGmail) out.push({ tone: 'warn', text: 'No customer-support Gmail connected', go: 'settings' });
  if (!s.chargebackGmail) out.push({ tone: 'warn', text: 'No chargeback Gmail connected', go: 'settings' });
  else if (!s.whatsapp) out.push({ tone: 'warn', text: 'Chargeback WhatsApp number not set', go: 'settings' });
  if (out.length === 0) out.push({ tone: 'ok', text: 'All clear: nothing waiting' });
  return out;
}

// A number for the order of the cards: the panel with the most urgent work first; ties keep the given order.
export function urgency(s: PanelStats): number {
  return (s.chargebacksOpen ?? 0) * 1000 + s.overdue * 100 + s.needsYou * 20 + (s.refundRequestsNew ?? 0) * 10 + s.waiting * 5
    + s.refundCases * 3 + s.reshipToShip * 3 + Math.min(s.lateOrders, 20) + (s.aiOn === false ? 2 : 0) + (s.hasPrompt ? 0 : 1);
}

export function sortPanels(panels: PanelStats[]): PanelStats[] {
  return panels.map((p, i) => ({ p, i })).sort((a, b) => urgency(b.p) - urgency(a.p) || a.i - b.i).map(x => x.p);
}
