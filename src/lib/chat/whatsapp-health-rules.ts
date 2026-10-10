// ── Is the WhatsApp number healthy? (owner 2026-10-10: "Number ki sehat Today board par dikhe: quality rating,
// aaj kitne naye customers ko message gaya aur limit kitni hai, automation mein kitne Failed") ──
// Pure: the Today board (PanelBoard.tsx) and the tests read it. Meta rates the number GREEN / YELLOW / RED from how
// customers react (blocks, reports); a low rating can cut the number's daily limit (how many different customers
// we may START a conversation with in 24 hours, the "messaging limit tier") or stop the number. The server
// (whatsapp-health.ts) fills the numbers; this file only says what they mean.

export interface WaHealth {
  quality: string;            // GREEN / YELLOW / RED / UNKNOWN (Meta's quality_rating)
  status: string;             // CONNECTED / FLAGGED / RESTRICTED / ... (Meta's number status)
  tier: string;               // TIER_250 / TIER_1K / ... / UNKNOWN
  limit: number | null;       // customers a day the tier allows; null = unlimited or unknown
  limitFrom: 'meta' | 'saved' | null; // Meta's number tier, or the limit the owner typed in WhatsApp > Setup
  used24h: number;            // different numbers we started a conversation with (templates) in the last 24 hours
  failedToday: number;        // automation messages that failed today (India day)
  waitingToday: number;       // automation messages waiting to go
  stopped: number;            // customers who asked us to stop (no automation message goes to them)
  phoneError: string | null;  // Meta could not be read (the numbers from our own database still show)
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
  if (status && status !== 'CONNECTED' && status !== 'UNKNOWN') {
    out.push({ tone: 'danger', text: `Meta says the number is ${status}: messages may not go out. Open WhatsApp Manager and read Meta's notice` });
  }
  if (quality === 'RED') out.push({ tone: 'danger', text: 'Quality RED: many customers blocked or reported the number. Meta may lower the daily limit or stop the number' });
  else if (quality === 'YELLOW') out.push({ tone: 'warn', text: 'Quality YELLOW: some customers blocked or reported the number. Watch the messages that go out' });
  if (h.limit) {
    const pct = h.used24h / h.limit;
    if (pct >= 0.9) out.push({ tone: 'danger', text: `Daily limit almost used: ${h.used24h} of ${h.limit} customers in the last 24 hours. New ones will not get the message` });
    else if (pct >= 0.7) out.push({ tone: 'warn', text: `Daily limit ${Math.round(pct * 100)}% used: ${h.used24h} of ${h.limit} customers in the last 24 hours` });
  }
  if (h.failedToday > 0) out.push({ tone: 'warn', text: `${h.failedToday} automation ${h.failedToday === 1 ? 'message' : 'messages'} failed today: open WhatsApp > Automation > Failed` });
  if (h.phoneError) out.push({ tone: 'warn', text: `Could not read the number from Meta: ${h.phoneError}` });
  return out;
}
