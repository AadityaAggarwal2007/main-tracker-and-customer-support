// ── Promises that got stuck (owner 2026-10-14: "Refund aur Ship again ka vaada atak jaata hai ... iska kya solution";
// answer: ShipTrack + WhatsApp alert) ──
// Pure (no imports). A customer who was promised something and then hears nothing for days is the one who raises a
// chargeback. Three kinds of promise, counted per panel by stuck.ts, older than STUCK_DAYS:
//   refundNoForm   a Refund chat (marked by the team or by Chikki's promise) and no refund form was sent yet
//   refundWaiting  the customer filled the refund form and it waits to be decided (New) or paid (Approved)
//   reshipNotSent  a Ship again chat whose new parcel is not marked sent yet
// Nothing here ever goes to a customer: the team is told (Today board, the Chat Support bar, one WhatsApp a day).

export const STUCK_DAYS = 2;

export interface StuckCounts { refundNoForm: number; refundWaiting: number; reshipNotSent: number }
export const emptyStuck = (): StuckCounts => ({ refundNoForm: 0, refundWaiting: 0, reshipNotSent: 0 });
export const stuckTotal = (s: StuckCounts | null | undefined) => (s ? s.refundNoForm + s.refundWaiting + s.reshipNotSent : 0);

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

// The words for one panel, e.g. "2 Ship again parcels not sent, 1 refund form not sent".
export function stuckParts(s: StuckCounts): string[] {
  const out: string[] = [];
  if (s.reshipNotSent > 0) out.push(`${n(s.reshipNotSent, 'Ship again parcel', 'Ship again parcels')} not sent`);
  if (s.refundNoForm > 0) out.push(`${n(s.refundNoForm, 'refund form', 'refund forms')} not sent`);
  if (s.refundWaiting > 0) out.push(`${n(s.refundWaiting, 'refund request', 'refund requests')} not decided / paid`);
  return out;
}

// The one-line WhatsApp alert ({{1}} of the shiptrack_alert template: no line breaks, no tabs, at most 600 characters).
// Panels with nothing stuck are left out; null when nothing is stuck anywhere.
export function stuckAlertText(panels: { name: string; counts: StuckCounts }[]): string | null {
  const lines = panels.filter((p) => stuckTotal(p.counts) > 0).map((p) => `${p.name}: ${stuckParts(p.counts).join(', ')}`);
  if (!lines.length) return null;
  const text = `Promises waiting ${STUCK_DAYS}+ days. ${lines.join('. ')}. Please clear them today (ShipTrack > Today).`;
  return text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').slice(0, 600);
}

// The India day ("2026-10-14") and minutes since midnight, for the once-a-day alert.
export function istDay(now: number): string { return new Date(now + 330 * 60_000).toISOString().slice(0, 10); }
export function istMinutes(now: number): number { return Math.floor(((now + 330 * 60_000) % 86_400_000) / 60_000); }
// The alert goes once a working day, from 10:30 India time (after the team has come in), never after 22:00.
export const ALERT_FROM_MIN = 10 * 60 + 30;
export function alertTimeOk(now: number): boolean { const m = istMinutes(now); return m >= ALERT_FROM_MIN && m < 22 * 60; }
