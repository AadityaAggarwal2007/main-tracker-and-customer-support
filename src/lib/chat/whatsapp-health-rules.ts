// ── Is the WhatsApp number healthy? (owner 2026-10-10: "Number ki sehat Today board par dikhe: quality rating,
// aaj kitne naye customers ko message gaya aur limit kitni hai, automation mein kitne Failed") ──
// Pure: the Today board (PanelBoard.tsx) and the tests read it. Meta rates the number GREEN / YELLOW / RED from how
// customers react (blocks, reports); a low rating can cut the number's daily limit (how many different customers
// we may START a conversation with in 24 hours, the "messaging limit tier") or stop the number. The server
// (whatsapp-health.ts) fills the numbers; this file only says what they mean.
import { stopBoardLine } from './whatsapp-auto-rules';

export interface WaHealth {
  quality: string;            // GREEN / YELLOW / RED / UNKNOWN (Meta's quality_rating)
  status: string;             // CONNECTED / FLAGGED / RESTRICTED / ... (Meta's number status)
  tier: string;               // TIER_250 / TIER_1K / ... / UNKNOWN
  limit: number | null;       // customers a day the tier allows; null = unlimited or unknown
  limitFrom: 'meta' | 'saved' | null; // Meta's number tier, or the limit the owner typed in WhatsApp > Setup
  used24h: number;            // different numbers we started a conversation with (templates) in the last 24 hours
  usedToday?: number;         // the same, since midnight India time (owner 2026-10-11: "2000 roz ki hai", the board shows today first)
  failedToday: number;        // automation messages that failed today (India day)
  waitingToday: number;       // automation messages waiting to go
  stopped: number;            // customers who asked us to stop (no automation message goes to them)
  phoneError: string | null;  // Meta could not be read (the numbers from our own database still show)
  // Today's automation, India day (owner 2026-10-11: "Today ma bhi WhatsApp message ka daily ka dikhe"): a message counts on
  // the day of its own time (sent, failed or skipped; a waiting one by when it goes), as WhatsApp > Automation counts it.
  today?: { placedWent: number; placedRead: number; trackingWent: number; trackingRead: number; failed: number; skipped: number; dueLater: number };
  // When the OLDEST of the last 24 hours' conversations started (ISO): 24 hours after it, Meta's rolling count drops by
  // one and the automation may message a new customer again (owner 2026-10-15, the daily limit guard).
  oldest24h?: string | null;
  // Another app on the number (owner 2026-10-15): Meta's reports today for messages ShipTrack never sent
  // (whatsapp-foreign-rules.ts foreignSeen); 0 / missing = none seen.
  foreignToday?: number;
  // The safety stop (owner 2026-10-15 night): a Meta-side failure stopped every order message until Resume
  // (whatsapp-pause.ts stopWhatsApp): Meta's words, when it began (ISO), the order it failed on. null = not stopped.
  safetyStop?: { reason: string; at: string; order: string | null } | null;
}
export const FOREIGN_BOARD_TEXT = (n: number) => `Another app sent ${n} message${n === 1 ? '' : 's'} from this number today (Meta's reports for messages ShipTrack never sent): the two share Meta's limit. Open WhatsApp > Automation > Number status for where to look`;

// The daily limit guard (owner 2026-10-15): the worker (whatsapp-auto.ts) stops messaging NEW customers once used24h
// reaches the limit (Meta's tier, else the one typed in WhatsApp > Setup: 2,000 today); a customer messaged in the last
// 24 hours still gets theirs. (The evening's "Meta refused near the limit: the real limit is 250, type 250" line was
// removed the same night: the day before, the number sent 343 messages in 4 hours with no refusal, so that guess was wrong.)
export const limitReached = (h: { used24h: number; limit: number | null }): boolean => h.limit != null && h.limit > 0 && h.used24h >= h.limit;
// When the oldest conversation of the window drops out of Meta's rolling 24 hours (ISO), null = not known.
export function limitFreeAt(h: { oldest24h?: string | null }): string | null {
  const t = Date.parse(h.oldest24h || '');
  return Number.isFinite(t) ? new Date(t + 24 * 3600 * 1000).toISOString() : null;
}
const istTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
export function dailyLimitLine(h: { used24h: number; limit: number | null; oldest24h?: string | null }): string | null {
  if (!limitReached(h)) return null;
  const at = limitFreeAt(h);
  return `Daily limit reached: ${h.used24h} / ${h.limit} in the last 24 h — new customers wait until the oldest drops out${at ? ` (about ${istTime(at)})` : ''}; customers messaged in the last 24 h still get theirs`;
}
export type WaTone = 'ok' | 'warn' | 'danger';
export interface WaLine { tone: WaTone; text: string }

const TIERS: Record<string, number | null> = {
  TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: null,
};
export function tierLimit(tier: string): number | null {
  const t = (tier || '').toUpperCase();
  return t in TIERS ? TIERS[t] : null;
}

// What needs doing, worst first; an empty list = healthy.
export function waHealthLines(h: WaHealth): WaLine[] {
  const out: WaLine[] = [];
  const status = (h.status || '').toUpperCase(), quality = (h.quality || '').toUpperCase();
  // the safety stop first: nothing goes until the Super Admin presses Resume (owner 2026-10-15 night)
  if (h.safetyStop) out.push({ tone: 'danger', text: stopBoardLine(h.safetyStop.reason, Date.parse(h.safetyStop.at) || Date.now(), h.safetyStop.order) });
  if (status && status !== 'CONNECTED' && status !== 'UNKNOWN') {
    out.push({ tone: 'danger', text: `Meta says the number is ${status}: messages may not go out. Open WhatsApp Manager and read Meta's notice` });
  }
  if (quality === 'RED') out.push({ tone: 'danger', text: 'Quality RED: many customers blocked or reported the number. Meta may lower the daily limit or stop the number' });
  else if (quality === 'YELLOW') out.push({ tone: 'warn', text: 'Quality YELLOW: some customers blocked or reported the number. Watch the messages that go out' });
  if (h.limit) {
    const pct = h.used24h / h.limit;
    const reached = dailyLimitLine(h);
    if (reached) out.push({ tone: 'danger', text: reached });
    else if (pct >= 0.9) out.push({ tone: 'danger', text: `Daily limit almost used: ${h.used24h} of ${h.limit} customers in the last 24 hours. New ones will wait once it is reached` });
    else if (pct >= 0.7) out.push({ tone: 'warn', text: `Daily limit ${Math.round(pct * 100)}% used: ${h.used24h} of ${h.limit} customers in the last 24 hours` });
  }
  if (h.foreignToday && h.foreignToday > 0) out.push({ tone: 'danger', text: FOREIGN_BOARD_TEXT(h.foreignToday) });
  if (h.failedToday > 0) out.push({ tone: 'warn', text: `${h.failedToday} automation ${h.failedToday === 1 ? 'message' : 'messages'} failed today: open WhatsApp > Automation > Failed` });
  if (h.phoneError) out.push({ tone: 'warn', text: `Could not read the number from Meta: ${h.phoneError}` });
  return out;
}
