// ── Another app on the WhatsApp number (owner 2026-10-15: the number sent 343 messages the day before with no refusal,
// 242 by 13:00 today, then a 77-message deploy burst, and from 13:00 Meta refused EVERY message with 130429, even one
// message after a two-hour quiet pause, quality GREEN, status CONNECTED; the account also carries a
// `3p_direct_integration_test_template`, the mark of a third-party integration onboarded on it) ──
// Meta sends a delivery report (sent / delivered / read / failed) for EVERY message sent from the number, whoever sent
// it. A report whose wamid is none of ours (a chat message's metadata.wa_id, an automation row's wa_id, an alert's or a
// test send's record) is a message SOMETHING ELSE sent from the number: another app or partner sharing it, and so
// sharing Meta's limit. whatsapp-foreign.ts counts those reports per India day and hour in ONE chat_settings row
// (`wa_foreign:<YYYY-MM-DD>`), updated atomically (both PM2 processes add up). This file is pure: the key, the JSON's
// shape, the day's summary and the plain-words line the Number status box and the Today board show. No imports.

export const FOREIGN_PREFIX = 'wa_foreign:';
// A report may reach us BEFORE our own send wrote the wamid (the send answers the id, our UPDATE follows within
// milliseconds): a report that matches nothing is looked at AGAIN after this long before it is counted as foreign.
export const FOREIGN_RECHECK_MS = 20_000;

const IST_MS = 330 * 60_000;
// The India day (YYYY-MM-DD) and hour (0-23) of a time.
export function istDayOf(ms: number): string { return new Date(ms + IST_MS).toISOString().slice(0, 10); }
export function istHourOf(ms: number): number { return new Date(ms + IST_MS).getUTCHours(); }
export const foreignKey = (ms: number) => FOREIGN_PREFIX + istDayOf(ms);

export const FOREIGN_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const;
export type ForeignStatus = typeof FOREIGN_STATUSES[number];
export interface ForeignHour { sent: number; delivered: number; read: number; failed: number; failed130429: number }
// The stored JSON: hours = {"13": {...}, "14": {...}}; the last report's time, the last failure's time and Meta's words
// (at most 200 characters), and the number it was for, masked to its last 4 (never a full number).
export interface ForeignDay { hours: Record<string, Partial<ForeignHour>>; lastAt: string | null; lastStatus: string | null; lastTo: string | null; lastFailAt: string | null; lastError: string | null }

export const isRateLimitWords = (error: string | null | undefined): boolean => /^\s*130429\b/.test(String(error || ''));
export const maskLast4 = (n: string | null | undefined): string | null => (n && String(n).length >= 4 ? `••••${String(n).slice(-4)}` : null);

const n0 = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
export function parseForeignDay(value: string | null | undefined): ForeignDay | null {
  try {
    const j = JSON.parse(String(value || ''));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const hours: Record<string, Partial<ForeignHour>> = {};
    for (const [h, v] of Object.entries((j.hours && typeof j.hours === 'object' ? j.hours : {}) as Record<string, Partial<ForeignHour>>)) {
      if (!/^\d{1,2}$/.test(h) || !v || typeof v !== 'object') continue;
      hours[h] = { sent: n0(v.sent), delivered: n0(v.delivered), read: n0(v.read), failed: n0(v.failed), failed130429: n0(v.failed130429) };
    }
    const s = (x: unknown) => (typeof x === 'string' && x ? x.slice(0, 200) : null);
    return { hours, lastAt: s(j.lastAt), lastStatus: s(j.lastStatus), lastTo: s(j.lastTo), lastFailAt: s(j.lastFailAt), lastError: s(j.lastError) };
  } catch { return null; }
}

// What ONE report adds: the fresh row's JSON (the first report of the day) and the pieces the atomic UPDATE needs.
export interface ForeignAdd { key: string; hour: string; status: ForeignStatus; rateLimited: boolean; fresh: string; top: string }
export function foreignAdd(status: string, error: string | null | undefined, to: string | null | undefined, nowMs: number): ForeignAdd | null {
  if (!(FOREIGN_STATUSES as readonly string[]).includes(status)) return null;
  const st = status as ForeignStatus, hour = String(istHourOf(nowMs)), at = new Date(nowMs).toISOString();
  const rateLimited = st === 'failed' && isRateLimitWords(error);
  const top: Record<string, string | null> = { lastAt: at, lastStatus: st, lastTo: maskLast4(to) };
  if (st === 'failed') { top.lastFailAt = at; top.lastError = String(error || 'failed').slice(0, 200); }
  const hours: Record<string, Partial<ForeignHour>> = { [hour]: { [st]: 1, ...(rateLimited ? { failed130429: 1 } : {}) } };
  return { key: foreignKey(nowMs), hour, status: st, rateLimited, fresh: JSON.stringify({ hours, ...top }), top: JSON.stringify(top) };
}

// The day in one look: the totals (sent = messages another app sent, one report each; failed apart), per hour, the last
// report and the last failure. Null / an unreadable row = nothing seen.
export interface ForeignToday {
  sent: number; delivered: number; read: number; failed: number; failed130429: number;
  lastAt: string | null; lastStatus: string | null; lastTo: string | null; lastFailAt: string | null; lastError: string | null;
  hours: ({ hour: number } & ForeignHour)[];   // India hours with at least one report, in order
}
export function foreignSummary(day: ForeignDay | null): ForeignToday {
  const out: ForeignToday = { sent: 0, delivered: 0, read: 0, failed: 0, failed130429: 0, lastAt: day?.lastAt ?? null, lastStatus: day?.lastStatus ?? null, lastTo: day?.lastTo ?? null, lastFailAt: day?.lastFailAt ?? null, lastError: day?.lastError ?? null, hours: [] };
  for (const [h, v] of Object.entries(day?.hours || {})) {
    const row = { hour: Number(h), sent: n0(v.sent), delivered: n0(v.delivered), read: n0(v.read), failed: n0(v.failed), failed130429: n0(v.failed130429) };
    out.sent += row.sent; out.delivered += row.delivered; out.read += row.read; out.failed += row.failed; out.failed130429 += row.failed130429;
    out.hours.push(row);
  }
  out.hours.sort((a, b) => a.hour - b.hour);
  return out;
}
// Did anything else send from the number today, as far as ShipTrack can see? (a sent report, or any report at all: a
// failed one is a message somebody tried to send)
export const foreignSeen = (f: ForeignToday): number => f.sent + f.delivered + f.read + f.failed;

// The line (owner 2026-10-15: "we need evidence"). `refusing` = Meta is refusing OUR messages now (a 130429 in the last
// 2 hours, or paused by Meta): without it and without foreign reports there is nothing to say.
export interface ForeignLine { tone: 'danger' | 'ok'; text: string }
const WHERE_TO_LOOK = 'Two apps on one number share Meta\'s limit: find it in Meta Business Settings > Accounts > WhatsApp accounts > (this account) > Partners, and Business Settings > Integrations > Connected apps / System users, and remove what you don\'t use.';
export function foreignLine(f: ForeignToday, refusing: boolean): ForeignLine | null {
  const seen = foreignSeen(f);
  if (seen > 0) {
    const istTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : null);
    const n = f.sent > 0 ? f.sent : seen;
    const failed = f.failed > 0 ? ` ${f.failed} of them failed${f.failed130429 > 0 ? ` (${f.failed130429} with Meta's 130429 rate limit)` : ''}.` : '';
    const last = f.lastAt ? ` Last one ${istTime(f.lastAt)}${f.lastTo ? ` to ${f.lastTo}` : ''}.` : '';
    return { tone: 'danger', text: `Another app sent ${n} message${n === 1 ? '' : 's'} from this number today (Meta's reports for messages ShipTrack never sent).${failed}${last} ${WHERE_TO_LOOK}` };
  }
  if (refusing) return { tone: 'ok', text: 'No other app\'s messages seen from this number today, as far as ShipTrack can see (an app under another Meta app sends its reports elsewhere): Meta itself is holding the number back after this afternoon\'s burst; it lifts on Meta\'s side.' };
  return null;
}
