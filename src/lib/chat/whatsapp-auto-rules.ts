// ── WhatsApp automation: the rules (owner 2026-10-10: "har naye order par apne aap message chala jaye ... 48
// ghante ke baad tracking link, on/off ka button, kitne bheje kitne fail") ──
// Pure, no imports of the database: the screen and the tests use it. The worker is whatsapp-auto.ts.
//   1. Every NEW order of a switched-on panel gets the "order placed" template (order id, brand, support email).
//   2. 48 hours after it was placed the customer gets the tracking link ("order_tracking" template), only while
//      the office is open (10:00-19:30 Monday to Friday, 10:00-14:00 Saturday, no Sunday / holiday): a 48th hour
//      that falls at night, on a Sunday or on a holiday goes out when the office opens next.
//   3. Never an old order: only orders placed after the panel's switch went ON and within the last 24 hours, so
//      an old CSV upload never messages anyone. Never a cancelled, delivered or number-less order.
import { isOfficeHours, nextOpenMs } from '@/lib/office-hours';

export const PLACED_TEMPLATE = 'order_placed';
export const TRACKING_TEMPLATE = 'order_tracking';
export const FRESH_MS = 24 * 3600 * 1000;           // an order older than this at send time is never messaged
export const TRACKING_AFTER_MS = 48 * 3600 * 1000;
export const TRACKING_TOO_LATE_MS = 6 * 24 * 3600 * 1000; // a tracking message later than this is dropped, not sent
export const MAX_ATTEMPTS = 3;
export const RETRY_MS = 10 * 60 * 1000;
export const BATCH = 15;                            // sends per minute: Meta's rate limit and the minute's budget

export const AUTO_PREFIX = 'wa_auto:';
export const autoKey = (panelId: string) => AUTO_PREFIX + panelId;

export interface AutoSetting { enabled: boolean; since: number | null }

// chat_settings value: {"enabled":true,"since":"2026-10-10T12:00:00.000Z"}. Anything else = off.
export function parseAuto(value: string | null | undefined): AutoSetting {
  try {
    const j = JSON.parse(String(value || ''));
    const since = typeof j?.since === 'string' ? Date.parse(j.since) : NaN;
    return { enabled: j?.enabled === true && Number.isFinite(since), since: Number.isFinite(since) ? since : null };
  } catch { return { enabled: false, since: null }; }
}
export const autoValue = (enabled: boolean, nowMs: number) => JSON.stringify({ enabled, since: new Date(nowMs).toISOString() });

// The oldest order a panel's automation may message now: after the switch went ON, and not older than 24 hours.
export function eligibleFrom(since: number | null, nowMs: number): number {
  return Math.max(since ?? nowMs, nowMs - FRESH_MS);
}

// When the tracking message is due: 48 hours after the order, moved to the next office opening.
export function trackingDueMs(createdMs: number, holidays: readonly string[] = []): number {
  const t = createdMs + TRACKING_AFTER_MS;
  return isOfficeHours(t, holidays) ? t : (nextOpenMs(t, holidays) ?? t);
}

// Is a row due now? (a tracking row is also held back outside office hours, whatever its due time says)
export function dueNow(kind: 'placed' | 'tracking', dueMs: number, nowMs: number, holidays: readonly string[] = []): boolean {
  if (dueMs > nowMs) return false;
  return kind === 'placed' ? true : isOfficeHours(nowMs, holidays);
}

// A value for a template variable: one line, no tabs, not empty (Meta refuses a newline / tab / 4 spaces in one).
export function cleanParam(v: unknown, max = 60): string {
  return String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}
export function firstName(name: unknown): string {
  const w = cleanParam(name, 80).split(' ')[0].replace(/[^\p{L}\p{M}'.-]/gu, '');
  if (!w) return 'there';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase().replace(/^(.)/, (c) => c);
}

export interface OrderFacts { orderId: string; customerName: string | null; trackingLink: string | null }
export interface BrandWords { name: string; email: string }

// {{1}} customer, {{2}} order, {{3}} brand, {{4}} support email (the order_placed preset).
export function placedParams(o: OrderFacts, b: BrandWords): string[] {
  return [firstName(o.customerName), cleanParam(o.orderId, 40), cleanParam(b.name, 40) || 'our store', cleanParam(b.email, 100) || 'our support team'];
}
// {{1}} customer, {{2}} order, {{3}} brand, {{4}} tracking link, {{5}} support email (the order_tracking preset).
export function trackingParams(o: OrderFacts, b: BrandWords): string[] {
  return [firstName(o.customerName), cleanParam(o.orderId, 40), cleanParam(b.name, 40) || 'our store', cleanParam(o.trackingLink, 200), cleanParam(b.email, 100) || 'our support team'];
}

// Meta codes worth another try (a hiccup on their side or a rate limit), against ones that never change
// (not a WhatsApp number, blocked, template missing): those fail for good and the screen shows the words.
export function retryable(code: number | null | undefined): boolean {
  if (code == null) return true;                       // no answer / network
  return [1, 2, 4, 17, 80007, 130429, 131016, 131056, 133004, 133016].includes(code) || (code >= 500 && code < 600);
}

// Why a send was skipped, in the owner's words.
export const SKIP = {
  tooOld: 'Order was more than 24 hours old when its turn came, so nobody is messaged late',
  cancelled: 'Order was cancelled',
  delivered: 'Order was already delivered',
  noNumber: 'No valid WhatsApp number on the order',
  noLink: 'The order has no tracking link',
  gone: 'The order is no longer there',
} as const;
