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
  // Today (India time)
  chatsToday: number;      // customers who wrote today (chat box + email)
  teamRepliesToday: number;
  chikkiToday: number;     // AI replies today (chikki_runs)
  // Orders
  ordersToday: number;
  lateOrders: number;      // estimated date passed in the last 14 days, not delivered, not cancelled / returned
  // Setup
  aiOn: boolean | null;    // null = the panel has no chat site yet
  hasPrompt: boolean;
  supportGmail: boolean;
  chargebackGmail: boolean;
  whatsapp: boolean;       // the chargeback WhatsApp number is set
  // Is each Gmail being read? From the pollers' last sign-in (mailbox-status.ts, memory: 'unknown' right after a restart).
  supportGmailStatus: GmailStatus | null;
  supportGmailError: string | null;
  chargebackGmailStatus: GmailStatus | null;
  chargebackGmailError: string | null;
}
export type GmailStatus = 'ok' | 'error' | 'unknown';

export type NeedTone = 'danger' | 'warn' | 'ok';
export interface Need { tone: NeedTone; text: string; go?: 'chats' | 'chargebacks' | 'refunds' | 'settings' | 'orders' | 'whatsapp' }

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// The lines, most urgent first. Chargebacks and threats to the customer first, then waiting customers, then the
// setup gaps a new panel usually has (owner: new panels must reach Vastora's level). "All clear" when nothing.
export function panelNeeds(s: PanelStats): Need[] {
  const out: Need[] = [];
  if ((s.chargebacksOpen ?? 0) > 0) out.push({ tone: 'danger', text: `${n(s.chargebacksOpen!, 'chargeback', 'chargebacks')} open: answer the gateway before its deadline`, go: 'chargebacks' });
  if (s.supportGmailStatus === 'error') out.push({ tone: 'danger', text: `Support Gmail cannot be read: ${s.supportGmailError || 'sign-in failed'}`, go: 'settings' });
  if (s.chargebackGmailStatus === 'error') out.push({ tone: 'danger', text: `Chargeback Gmail cannot be read: ${s.chargebackGmailError || 'sign-in failed'}`, go: 'settings' });
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
  return (s.chargebacksOpen ?? 0) * 1000 + (s.supportGmailStatus === 'error' || s.chargebackGmailStatus === 'error' ? 500 : 0)
    + s.overdue * 100 + s.needsYou * 20 + (s.refundRequestsNew ?? 0) * 10 + s.waiting * 5
    + s.refundCases * 3 + s.reshipToShip * 3 + Math.min(s.lateOrders, 20) + (s.aiOn === false ? 2 : 0) + (s.hasPrompt ? 0 : 1);
}

export function sortPanels(panels: PanelStats[]): PanelStats[] {
  return panels.map((p, i) => ({ p, i })).sort((a, b) => urgency(b.p) - urgency(a.p) || a.i - b.i).map(x => x.p);
}

// ── The day across every panel: the strip at the top and the morning routine ──────────────────
export interface BoardSummary {
  panels: number; needsYou: number; overdue: number; waiting: number; chargebacks: number | null; refundRequests: number | null;
  refundCases: number; reshipToShip: number; lateOrders: number; chatsToday: number; teamRepliesToday: number; chikkiToday: number;
  ordersToday: number; gmailErrors: number; setupGaps: number;
}
export function summarize(panels: PanelStats[]): BoardSummary {
  const sum = (f: (p: PanelStats) => number) => panels.reduce((a, p) => a + f(p), 0);
  const sa = panels.some(p => p.chargebacksOpen !== null);
  return {
    panels: panels.length, needsYou: sum(p => p.needsYou), overdue: sum(p => p.overdue), waiting: sum(p => p.waiting),
    chargebacks: sa ? sum(p => p.chargebacksOpen ?? 0) : null, refundRequests: panels.some(p => p.refundRequestsNew !== null) ? sum(p => p.refundRequestsNew ?? 0) : null,
    refundCases: sum(p => p.refundCases), reshipToShip: sum(p => p.reshipToShip), lateOrders: sum(p => p.lateOrders),
    chatsToday: sum(p => p.chatsToday), teamRepliesToday: sum(p => p.teamRepliesToday), chikkiToday: sum(p => p.chikkiToday), ordersToday: sum(p => p.ordersToday),
    gmailErrors: sum(p => (p.supportGmailStatus === 'error' ? 1 : 0) + (p.chargebackGmailStatus === 'error' ? 1 : 0)),
    setupGaps: sum(p => (p.aiOn === false ? 1 : 0) + (p.hasPrompt ? 0 : 1) + (p.supportGmail ? 0 : 1) + (p.chargebackGmail ? 0 : 1)),
  };
}

// The morning routine (owner 2026-10-09: "everyday morning check"): the same every day, in the order that protects the
// store; a step is ticked by itself when its number is 0. "go" opens the screen for it.
export interface RoutineStep { text: string; count: number; done: boolean; go: NonNullable<Need['go']> }
// waProblems: the WhatsApp number's open problems (whatsapp-health-rules.ts waHealthLines), null = not shown (a team
// member, or WhatsApp not set up).
export function morningRoutine(t: BoardSummary, aiDown = false, waProblems: number | null = null): RoutineStep[] {
  const steps: RoutineStep[] = [];
  steps.push({ text: 'Chikki is answering customers (OpenRouter credits and key fine)', count: aiDown ? 1 : 0, done: !aiDown, go: 'settings' });
  if (waProblems !== null) steps.push({ text: 'WhatsApp number healthy (quality, daily limit, no failed messages)', count: waProblems, done: waProblems === 0, go: 'whatsapp' });
  if (t.chargebacks !== null) steps.push({ text: 'Answer every open chargeback', count: t.chargebacks, done: t.chargebacks === 0, go: 'chargebacks' });
  steps.push({ text: 'Both Gmails of every panel are being read', count: t.gmailErrors, done: t.gmailErrors === 0, go: 'settings' });
  steps.push({ text: 'No customer waiting over 2 hours', count: t.overdue, done: t.overdue === 0, go: 'chats' });
  steps.push({ text: 'Needs you is empty', count: t.needsYou, done: t.needsYou === 0, go: 'chats' });
  if (t.refundRequests !== null) steps.push({ text: 'Refund requests decided', count: t.refundRequests, done: t.refundRequests === 0, go: 'refunds' });
  steps.push({ text: 'Ship again parcels sent', count: t.reshipToShip, done: t.reshipToShip === 0, go: 'chats' });
  steps.push({ text: 'Refund chats closed', count: t.refundCases, done: t.refundCases === 0, go: 'chats' });
  steps.push({ text: 'Late orders followed up', count: t.lateOrders, done: t.lateOrders === 0, go: 'orders' });
  steps.push({ text: 'Every panel fully set up', count: t.setupGaps, done: t.setupGaps === 0, go: 'settings' });
  return steps;
}
