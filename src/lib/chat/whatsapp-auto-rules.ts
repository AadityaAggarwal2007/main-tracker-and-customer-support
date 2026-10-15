// ── WhatsApp automation: the rules (owner 2026-10-10: "har naye order par apne aap message chala jaye ... 48
// ghante ke baad tracking link, on/off ka button, kitne bheje kitne fail") ──
// Pure, no imports of the database: the screen and the tests use it. The worker is whatsapp-auto.ts.
//   1. Every NEW order of a switched-on panel gets the "order placed" template (order id, brand, support email).
//   2. 48 hours after it was placed the customer gets the tracking link ("order_tracking" template), only while
//      the office is open (10:00-19:30 Monday to Friday, 10:00-14:00 Saturday, no Sunday / holiday): a 48th hour
//      that falls at night, on a Sunday or on a holiday goes out when the office opens next.
//   3. Never an old order: only orders placed after the panel's switch went ON and within the last 24 hours, so
//      an old CSV upload never messages anyone. Never a cancelled, delivered or number-less order.
//   4. Since 2026-10-15 evening only order_placed_link is on Meta (the owner deleted the two above): while the
//      one-message mode runs, every message (the first one, and the 48-hour link of older orders) goes with it and an
//      order with no tracking link yet waits for it (pickTemplate below).
import { isOfficeHours, nextOpenMs } from '@/lib/office-hours';

export const PLACED_TEMPLATE = 'order_placed';
export const TRACKING_TEMPLATE = 'order_tracking';
export const FRESH_MS = 24 * 3600 * 1000;           // an order older than this at send time is never messaged
export const TRACKING_AFTER_MS = 48 * 3600 * 1000;
export const TRACKING_TOO_LATE_MS = 6 * 24 * 3600 * 1000; // a tracking message later than this is dropped, not sent
export const MAX_ATTEMPTS = 3;
export const RETRY_MS = 10 * 60 * 1000;
export const BATCH = 15;                            // sends per minute: Meta's rate limit and the minute's budget

// ONE message per order (owner 2026-10-15: "pehle hi message mein saath mein tracking link chala jaye ... double double
// message ... do do hazar messages"): once Meta has APPROVED the "order_placed_link" template (order placed + the
// tracking link, the brand-rules preset ORDER_LINK_PRESET) AND the switch below is ON (or unset) the first message
// carries the link and the 48-hour tracking message is skipped for that order; until then the two messages go as before.
// Its values are trackingParams'.
export const LINK_TEMPLATE = 'order_placed_link';
// The switch "One message per order" (owner 2026-10-15, "switch ya jo bhi banana h bana": the link template was APPROVED
// at 13:44 and the tab said one-message mode was on, yet every 'placed' row of the afternoon went as order_placed): one
// row in chat_settings `wa_link_mode` = {on, by, at}. No row = ON (the template decides, as before). OFF = the two old
// messages exactly as before, whatever Meta approved. `linkModeOf` is the ONE place that decides which mode runs, with
// the reason in words: the worker logs it, the overview shows it, the test send follows it.
export const LINK_MODE_KEY = 'wa_link_mode';
export interface LinkModeSetting { on: boolean | null; by: string | null; at: string | null }
export function parseLinkMode(value: string | null | undefined): LinkModeSetting {
  try {
    const j = JSON.parse(String(value || ''));
    return { on: typeof j?.on === 'boolean' ? j.on : null, by: typeof j?.by === 'string' ? j.by.slice(0, 60) : null, at: typeof j?.at === 'string' ? j.at : null };
  } catch { return { on: null, by: null, at: null }; }
}
export const linkModeValue = (on: boolean, by: string, nowMs: number) => JSON.stringify({ on, by: by.slice(0, 60), at: new Date(nowMs).toISOString() });
export interface LinkMode {
  on: boolean;         // the switch (no row = on)
  approved: boolean;   // Meta has APPROVED order_placed_link
  active: boolean;     // on AND approved = the first message carries the link, the 48-hour message is skipped
  reason: string;      // which mode runs and why, in words (the [wa-auto] log line and the Automation tab)
  template: { name: string; language: string } | null;
}
export function linkModeOf(setting: LinkModeSetting | null, link: { name: string; language: string } | null, linkState: string, listError: string | null, note?: string | null): LinkMode {
  const on = setting?.on ?? true;
  const approved = !!link;
  if (on && approved) return { on, approved, active: true, reason: `one message: ${link!.name} (${link!.language}) is approved and the switch is ON`, template: link };
  const why = !on ? `the switch "One message per order" is OFF${setting?.by ? ` (by ${setting.by})` : ''}`
    : listError ? `the templates could not be read from Meta: ${listError}`
      : note ? note
        : linkState === 'MISSING' ? `${LINK_TEMPLATE} is not made yet` : `${LINK_TEMPLATE} is ${linkState.toLowerCase()} on Meta, not approved`;
  return { on, approved, active: false, reason: `two messages: ${why}`, template: link };
}

// Which template on Meta IS the one-message template (owner 2026-10-15, live: the PM2 log said "order_placed_link is not
// made yet" for hours while WhatsApp > Templates showed it APPROVED, and no order message ever went with it). Meta keeps
// a deleted template's name for about 30 days, so a template made again is often order_placed_link_2 / _v2, or the name
// was typed a little differently; the worker's exact-name lookup then never finds it. The exact name APPROVED wins; else
// the first APPROVED template whose name starts with order_placed_link AND has exactly the LINK_VARS values trackingParams
// fills (customer, order, brand, tracking link, support email): one with another count is never picked, Meta would refuse
// the send. `state` is for the screen and the log: APPROVED when found; else the exact one's status, else the best
// prefix match's, else MISSING (UNKNOWN when the list could not be read). `note` says in words when a template of the
// right name is there but cannot be used (the wrong number of values).
export const LINK_VARS = 5;
export interface TemplateLike { name: string; language: string; status: string; vars: number }
const tplKey = (t: { name: string }) => t.name.trim().toLowerCase();
export const isLinkTemplateName = (name: string | null | undefined): boolean => String(name || '').trim().toLowerCase().startsWith(LINK_TEMPLATE);
export function findLinkTemplate<T extends TemplateLike>(list: T[] | null): { template: T | null; state: string; note: string | null } {
  if (!list) return { template: null, state: 'UNKNOWN', note: null };
  const usable = (t: T) => t.status === 'APPROVED' && t.vars === LINK_VARS;
  const exact = list.find((t) => tplKey(t) === LINK_TEMPLATE && usable(t)) || null;
  if (exact) return { template: exact, state: 'APPROVED', note: null };
  const prefix = list.filter((t) => isLinkTemplateName(t.name));
  const near = prefix.find(usable) || null;
  if (near) return { template: near, state: 'APPROVED', note: null };
  // nothing usable: say what IS there, the exact name first, then the closest by name (5 values before others)
  const best = prefix.find((t) => tplKey(t) === LINK_TEMPLATE) || prefix.find((t) => t.vars === LINK_VARS) || prefix[0] || null;
  if (!best) return { template: null, state: 'MISSING', note: null };
  const note = best.status === 'APPROVED'
    ? `${tplKey(best)} is approved on Meta but has ${best.vars} value${best.vars === 1 ? '' : 's'}, the automation fills ${LINK_VARS}: make it again from its preset button`
    : tplKey(best) === LINK_TEMPLATE ? null : `${tplKey(best)} is ${best.status.toLowerCase()} on Meta, not approved`;
  return { template: null, state: best.status, note };
}
// What the worker read from Meta, for the [wa-auto] mode line (owner 2026-10-15: the log said only "not made yet" and
// nobody could tell what Meta had listed): how many templates, from which account (its last 4 digits, as templateStates
// masks it), and the ones named order_* with their status, at most `max`. Never a token, never a phone number.
export function templatesReadNote(list: { name: string; status: string }[] | null, account: string | null, max = 8): string {
  if (!list) return '';
  const ours = list.filter((t) => tplKey(t).startsWith('order_'));
  const names = ours.slice(0, max).map((t) => `${tplKey(t)} ${t.status}`).join(', ');
  const more = ours.length > max ? `, +${ours.length - max} more` : '';
  return `(read ${list.length} template${list.length === 1 ? '' : 's'}${account ? ` from account ${account}` : ''}: ${names || 'none named order_…'}${more})`;
}
// The mode line goes to the log again at least this often per process, so the PM2 log is never stale (owner 2026-10-15).
export const MODE_LOG_EVERY_MS = 10 * 60 * 1000;

// Only order_placed_link (owner 2026-10-15 evening: he DELETED order_placed and order_tracking on Meta, which keeps a
// deleted name for about 30 days; "jo atka ha unka new template sa bhejio, mix mat kario" = everything waiting goes with
// the NEW template, never mixed with the old ones). While the one-message mode is active (the switch ON and the link
// template APPROVED) this is the ONE place that says which template a due row goes with:
//   - a 'placed' row WITH its tracking link: the link template (trackingParams, as before);
//   - a 'placed' row WITHOUT a link: it WAITS (pending, nothing written; the 24-hour tooOld skip still ends it): never
//     order_placed any more;
//   - a 'tracking' row (its order's first message went earlier with the old order_placed): the link template with the
//     same 5 values, still only in office hours and still skipped when delivered / cancelled / no link / too old / the
//     first message already carried the link;
//   - order_placed and order_tracking are NEVER sent in this mode, even if Meta lists them APPROVED again.
// With the switch OFF (two-message mode) nothing changes: the old templates, and a row waits while its template is not
// approved (or no longer exists).
export type ParamsKind = 'placed' | 'tracking';
export type TemplatePick<T> = { template: T; params: ParamsKind; waits: null } | { template: null; params: null; waits: 'link' | 'approval' };
export function pickTemplate<T>(kind: 'placed' | 'tracking', hasLink: boolean, mode: { active: boolean }, link: T | null, placed: T | null, tracking: T | null): TemplatePick<T> {
  if (mode.active && link) {
    if (kind === 'placed' && !hasLink) return { template: null, params: null, waits: 'link' };
    return { template: link, params: 'tracking', waits: null };
  }
  const old = kind === 'placed' ? placed : tracking;
  return old ? { template: old, params: kind, waits: null } : { template: null, params: null, waits: 'approval' };
}
// May tracking rows be asked for now? Only while the office is open, and only when something can send them: the old
// order_tracking APPROVED, or the one-message mode (the link template carries them since 2026-10-15 evening).
export const trackingCanGo = (officeOpen: boolean, trackingApproved: boolean, linkActive: boolean): boolean => officeOpen && (trackingApproved || linkActive);
// The old templates are gone from Meta (deleted; the name blocked ~30 days): the "Turn OFF" confirm of the one-message
// switch must say that with the switch OFF no order message goes until they are made again.
export const oldTemplatesGone = (placedState: string, trackingState: string): boolean => placedState === 'MISSING' || trackingState === 'MISSING';
export const OLD_TEMPLATES_GONE_TEXT = 'order_placed and order_tracking are not on Meta any more: with the switch OFF, no order message will go until they are made again (Meta blocks a deleted name for about 30 days).';
// The log line, once per run, when 'placed' rows wait for their tracking link in the one-message mode.
export const waitingLinkLine = (n: number, template: string = LINK_TEMPLATE): string => `[wa-auto] ${n} order message${n === 1 ? '' : 's'} wait${n === 1 ? 's' : ''} for the order's tracking link (one message per order: ${template} needs it; order_placed is not sent)`;

// Meta's "130429 Rate limit hit: too many messages sent from this phone number in a short period of time" (owner
// 2026-10-15: 59 order messages failed in half an hour, and the chargeback alert on the same number did not arrive). It
// often comes AFTER Meta took the message, as a failed delivery report. The message never went out, so: every send from
// the number stops for PAUSE_MS (whatsapp-pause.ts, both processes), the row waits and goes again by itself, at most
// RATE_MAX_ATTEMPTS tries; and sends are spaced SEND_GAP_MS apart instead of back to back.
export const RATE_LIMIT_CODE = 130429;
export const RATE_MAX_ATTEMPTS = 6;
export const PAUSE_MS = 15 * 60 * 1000;
export const SEND_GAP_MS = 2_000;
// Slow and steady (owner 2026-10-15: "dheere dheere chala jaye, har minute 1 ya 2 msg, jisse yeh crash na kare"): ONE
// order message every SEND_EVERY_MS across the whole install (both processes, every run): 2 a minute, at most 2,880 a
// day. A run that finds the slot taken stops and the next run (every 30 s) goes on. ShipTrack's own alerts do not wait
// for it (a chargeback alert is never held back by order messages).
export const SEND_EVERY_MS = 30_000;
// The speed, set by the owner (owner 2026-10-15: "button se set kar sakein ki har minute 2, 3, 4 message"): one row in
// chat_settings `wa_send_rate` = {perMinute, by, at}; 1, 2, 3 or 4 order messages a minute for the whole install (no row
// = 2, i.e. SEND_EVERY_MS). After a 130429 the gap is the SLOWER of 60 s and the chosen one for two hours (never faster
// than chosen): today's "1 a minute after a refusal" stays. Read with a 10-second cache per process (whatsapp-pause.ts).
export const SEND_RATE_KEY = 'wa_send_rate';
export const SEND_RATES: readonly number[] = [1, 2, 3, 4];
export const DEFAULT_PER_MINUTE = 2;
export interface SendRate { perMinute: number; by: string | null; at: string | null }
export function parseSendRate(value: string | null | undefined): SendRate {
  try {
    const j = JSON.parse(String(value || ''));
    const n = Number(j?.perMinute);
    if (!SEND_RATES.includes(n)) return { perMinute: DEFAULT_PER_MINUTE, by: null, at: null };
    return { perMinute: n, by: typeof j?.by === 'string' ? j.by.slice(0, 60) : null, at: typeof j?.at === 'string' ? j.at : null };
  } catch { return { perMinute: DEFAULT_PER_MINUTE, by: null, at: null }; }
}
export const sendRateValue = (perMinute: number, by: string, nowMs: number) => JSON.stringify({ perMinute, by: by.slice(0, 60), at: new Date(nowMs).toISOString() });
// The gap between two order messages at that speed (2 a minute = SEND_EVERY_MS).
export const gapFor = (perMinute: number): number => Math.round(60_000 / (SEND_RATES.includes(perMinute) ? perMinute : DEFAULT_PER_MINUTE));

// Which template ShipTrack uses for what (owner 2026-10-15: "template ke bahar on/off ka button ki ye wala working hai
// baaki nahi"): one chip per template card in WhatsApp > Templates, from the automation's current mode (linkModeOf).
export const ALERT_TEMPLATE = 'shiptrack_alert';
export interface TemplateUsage { text: string; tone: 'ok' | 'warn' | 'muted' }
export function templateUsage(t: { name: string; status: string }, mode: LinkMode): TemplateUsage {
  const name = tplKey(t), approved = t.status === 'APPROVED';
  const notYet = t.status === 'PENDING' ? 'waiting for approval' : `not approved (${String(t.status || 'unknown').toLowerCase()})`;
  const use = (text: string): TemplateUsage => (approved ? { text, tone: 'ok' } : { text: `${text} — but ${notYet}`, tone: 'warn' });
  if (isLinkTemplateName(name)) {
    if (mode.active) {
      return mode.template && tplKey(mode.template) === name
        ? { text: 'In use: every order (new orders, and the 48-hour link for older ones)', tone: 'ok' }
        : { text: `Not in use (${mode.template ? tplKey(mode.template) : LINK_TEMPLATE} is the one sent)`, tone: 'muted' };
    }
    if (!mode.on) return { text: 'Not in use (switch OFF)', tone: 'warn' };
    if (!approved) return { text: t.status === 'PENDING' ? 'Waiting for approval' : `Not in use (${notYet})`, tone: 'warn' };
    return { text: `Not in use: ${mode.reason.replace(/^two messages: /, '')}`, tone: 'warn' };
  }
  // the old two (owner 2026-10-15 evening): never sent while the one-message mode runs
  if (name === PLACED_TEMPLATE) return mode.active ? { text: 'Not used (one message mode)', tone: 'muted' } : use('In use: every new order');
  if (name === TRACKING_TEMPLATE) return mode.active ? { text: 'Not used (one message mode)', tone: 'muted' } : use('In use: every order, 48 hours later');
  if (name === ALERT_TEMPLATE) return use('In use: ShipTrack alerts (chargeback, AI credit, chargeback risk, stuck promises)');
  return { text: 'Not used by ShipTrack', tone: 'muted' };
}
// Meta keeps refusing after a burst (owner 2026-10-15, live: 77 messages in 3 minutes during the deploy, then 130429 again
// at ONE message a minute): every new 130429 within STRIKE_WINDOW_MS of the last one is a "strike"; the pause doubles
// (15, 30, 60, 120 min) and, after the pause, order messages go 1 a minute instead of 2 (owner: "har minute 2-4 msg", never
// slower than one a minute) until two hours pass without a 130429. A 130429 that comes WHILE the pause still runs is the
// same burst (the reports of messages sent before it, or an alert tried every minute): it counts once, never a new strike
// (review 2026-10-15: retries of one refused alert pushed the pause up and up). At most MAX_STRIKES strikes.
export const STRIKE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const MAX_PAUSE_MS = 2 * 60 * 60 * 1000;
export const MAX_SEND_EVERY_MS = 60 * 1000;
export const MAX_STRIKES = 10;
// manual / by: a pause the Super Admin set from the Automation tab (owner 2026-10-15, "pause ka option"); resumedBy: who
// ended a pause early.
// firstAfterQuiet (owner 2026-10-15, the afternoon's three 130429 reports came 8 seconds after the FIRST order message
// sent after a 15 / 30 minute pause, at 1-2 messages a minute): Meta refused a message that followed at least 10 quiet
// minutes (QUIET_MS: no order message sent before it) or came within 2 minutes of the previous pause's end
// (AFTER_PAUSE_MS). That is not our speed: the number itself is limited on Meta's side (quality, a restriction, another
// app sending from it). The Number status box says so in red; the strike / pause rules stay as they are.
export const QUIET_MS = 10 * 60 * 1000;
export const AFTER_PAUSE_MS = 2 * 60 * 1000;
export const FIRST_AFTER_QUIET_TEXT = 'Meta refused the very first message after a quiet pause: this is not our speed. Check the number in WhatsApp Manager (status, quality, messaging limit) and make sure no other app or tool is sending from this number.';
export function firstAfterQuietOf(prev: PauseState | null, sentAt: number | null | undefined, quietBefore: boolean): boolean {
  if (quietBefore) return true;
  if (!prev || sentAt == null || !Number.isFinite(sentAt)) return false;
  return sentAt >= prev.until && sentAt - prev.until <= AFTER_PAUSE_MS;
}
// stopped / code / order / kind (owner 2026-10-15 night, the safety stop): a Meta-side failure stopped every order message
// until Resume; `by` is then STOP_BY, `at` when it began, `until` 30 days on (STOP_MS).
export interface PauseState { until: number; reason: string; at: number; strikes: number; manual?: boolean; by?: string; resumedBy?: string; firstAfterQuiet?: boolean; stopped?: boolean; code?: number | null; order?: string | null; kind?: string | null }
export function parsePauseState(value: string | null | undefined): PauseState | null {
  try {
    const j = JSON.parse(String(value || ''));
    const until = Date.parse(j?.until), at = Date.parse(j?.at);
    if (!Number.isFinite(until)) return null;
    return { until, reason: String(j?.reason || ''), at: Number.isFinite(at) ? at : until - PAUSE_MS, strikes: Math.max(1, Math.floor(Number(j?.strikes) || 1)),
      ...(j?.manual ? { manual: true, by: String(j?.by || '').slice(0, 60) } : {}), ...(j?.resumedBy ? { resumedBy: String(j.resumedBy).slice(0, 60) } : {}),
      ...(j?.firstAfterQuiet === true ? { firstAfterQuiet: true } : {}),
      ...(j?.stopped === true ? { stopped: true, by: String(j?.by || STOP_BY).slice(0, 60), code: Number.isFinite(Number(j?.code)) && j?.code !== null && j?.code !== '' ? Number(j.code) : null, order: j?.order ? String(j.order).slice(0, 40) : null, kind: j?.kind ? String(j.kind).slice(0, 20) : null } : {}) };
  } catch { return null; }
}
// The next pause after a 130429 at `now`: null = the pause still runs (the same burst), keep it as it is.
// sentAt (owner 2026-10-15: "is baar theek se kaam nahi kiya", the 3rd refusal came one minute after a 30-minute pause
// ended): Meta often reports a refusal LATER, as a failed delivery report; a report for a message sent before the last
// pause ended belongs to that old burst, never a new refusal: no new strike, no longer pause.
export function nextPause(prev: PauseState | null, now: number, base = PAUSE_MS, sentAt?: number | null): { until: number; strikes: number } | null {
  if (prev && prev.until > now) return null;
  if (prev && sentAt != null && Number.isFinite(sentAt) && sentAt < prev.until) return null;
  const strikes = prev && now - prev.at < STRIKE_WINDOW_MS ? Math.min(prev.strikes + 1, MAX_STRIKES) : 1;
  return { until: now + Math.min(base * 2 ** (strikes - 1), MAX_PAUSE_MS), strikes };
}
// What the Automation tab's "Number status" box says (owner 2026-10-15: "pata chal jaee ki meta na pause kia ha, kab tak
// resume ho jaega"): paused (by Meta or by hand) until when, or sending slowly until when, or normal; Meta's last refusal,
// which refusal of the last 2 hours it was, and how long the NEXT pause would be if Meta refuses again.
export interface PauseView {
  state: 'stopped' | 'paused' | 'slow' | 'normal';   // stopped = the safety stop (owner 2026-10-15 night): until Resume
  until: string | null;          // paused: when it sends again
  manual: boolean; by: string | null;
  reason: string | null;         // Meta's words (or "Paused by ...")
  lastRefusalAt: string | null;  // Meta's last 130429 (not a pause by hand)
  strikes: number;               // refusals in the last 2 hours (0 = none)
  slowUntil: string | null;      // 1 a minute until then
  sendEveryMs: number;
  nextPauseMin: number;          // if Meta refuses again now / after the pause
  resumedBy: string | null;
  firstAfterQuiet: boolean;      // Meta's last refusal hit the first message after a quiet stretch: not our speed
  perMinute: number;             // the chosen speed (wa_send_rate), what "normal" means
  // the safety stop: Meta's code and words, the order (or the test / alert) it failed on, when it began (ISO)
  stopped: boolean; stopCode: number | null; stopOrder: string | null; stopKind: string | null; stopAt: string | null;
}
// `base` = the chosen gap (gapFor(perMinute)); the view says "slow" only when the gap is wider than the chosen one.
export function pauseView(st: PauseState | null, now: number, base = SEND_EVERY_MS): PauseView {
  const inWindow = !!st && now - st.at < STRIKE_WINDOW_MS && !(st.manual && st.at <= now - STRIKE_WINDOW_MS);
  const strikes = st && inWindow ? st.strikes : 0;
  const paused = !!st && st.until > now;
  const stopped = paused && !!st!.stopped;
  const every = sendEveryFor(st && inWindow ? st : null, now, base);
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    state: stopped ? 'stopped' : paused ? 'paused' : every > base ? 'slow' : 'normal',
    until: paused ? iso(st!.until) : null,
    manual: !!(paused && st!.manual && !stopped), by: paused && st!.manual && !stopped ? st!.by || null : null,
    reason: st ? st.reason || null : null,
    lastRefusalAt: st && strikes > 0 ? iso(st.at) : null,
    strikes,
    slowUntil: !paused && every > base && st ? iso(st.at + STRIKE_WINDOW_MS) : null,
    sendEveryMs: every,
    nextPauseMin: Math.round(Math.min(PAUSE_MS * 2 ** (strikes > 0 ? Math.min(strikes, MAX_STRIKES - 1) : 0), MAX_PAUSE_MS) / 60000),
    resumedBy: st && !paused ? st.resumedBy || null : null,
    firstAfterQuiet: !!(st && st.firstAfterQuiet && (paused || strikes > 0)),
    perMinute: Math.max(1, Math.round(60_000 / base)),
    stopped, stopCode: stopped ? st!.code ?? null : null, stopOrder: stopped ? st!.order ?? null : null, stopKind: stopped ? st!.kind ?? null : null, stopAt: stopped ? iso(st!.at) : null,
  };
}
export const MANUAL_PAUSE_MIN = [15, 30, 60, 120];
// How far apart order messages go now: the chosen gap (`base`, gapFor(perMinute); 30 s by default), and while the last
// 130429 is under two hours old the SLOWER of 60 s and the chosen gap (never faster than chosen).
export function sendEveryFor(state: PauseState | null, now: number, base = SEND_EVERY_MS): number {
  if (!state || now - state.at >= STRIKE_WINDOW_MS) return base;
  return Math.max(base, MAX_SEND_EVERY_MS);
}
export function isRateLimited(code: number | null | undefined, error?: string | null): boolean {
  return code === RATE_LIMIT_CODE || /^\s*130429\b/.test(String(error || ''));
}

// ── The safety stop (owner 2026-10-15 night, after 3 order messages were LOST with 132001 "template name does not exist"
// while Meta propagated a deleted template, and 130429 kept coming: "1 msg bhi dubara drop ya fail ho toh pause ho jae,
// meta ki limit na kharab ho") ──
// Which side a failure is on decides everything:
//   - CUSTOMER side (this one number: not on WhatsApp, blocked us, the per-user marketing limit, an experiment group, an
//     invalid recipient): that ONE message fails, the rest go on, nothing stops.
//   - META side (everything else: 130429 rate limit, 132001 template missing, the token, a hiccup, our own timeout, an
//     unknown code): the message is NOT lost (its row goes back in line, pending) and EVERY order message STOPS until the
//     Super Admin presses Resume in WhatsApp > Automation (whatsapp-pause.ts stopWhatsApp: `wa_pause` with stopped: true,
//     until 30 days on). New orders are still queued; ShipTrack's alerts and the test send still go. The owner gets ONE
//     WhatsApp alert per stop (whatsapp-alert-queue.ts alertStopped).
// `failureSide` reads Meta's code when the send answered one, else the number a delivery report's words start with
// ("131026 · Message undeliverable · ..."), else the words themselves (our own "Not a WhatsApp number").
export type FailureSide = 'customer' | 'meta';
export const CUSTOMER_SIDE_CODES: readonly number[] = [
  131026,   // message undeliverable: not a WhatsApp user, or they blocked the number
  131030,   // the recipient is not in the allowed list (a test number)
  131021,   // sender and recipient are the same number
  130472,   // the user's number is part of a Meta experiment: no marketing message to them
  131049,   // the per-user marketing limit: Meta holds back marketing to this one user
];
// Meta's / our words for a recipient that cannot be messaged (no code, or the generic 100 "invalid parameter" naming the number)
export const CUSTOMER_SIDE_WORDS = /not a whatsapp number|cannot receive whatsapp|undeliverable|not in (the )?allowed list|invalid (recipient|phone|whatsapp)|(recipient|phone)( number)?[^.]{0,40}\b(is |are )?(invalid|not valid)|parameter ['"]?to['"]? (is )?invalid|not a valid (whatsapp )?(number|recipient)|part of an experiment/i;
export const STOP_MS = 30 * 24 * 3600 * 1000;   // a stop never ends by itself: 30 days, or Resume
export const STOP_BY = 'Meta failure';
export const STOP_ALERT_KEY = 'wa_stop_alert';  // chat_settings: the `at` of the stop the owner was last told about (one alert per stop)
// The code a failure carries: Meta's code when given, else the number the report's words start with.
export function codeIn(code: number | null | undefined, error?: string | null): number | null {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  const m = String(error || '').match(/^\s*(\d{1,7})\b/);
  return m ? Number(m[1]) : null;
}
export function failureSide(code: number | null | undefined, error?: string | null): FailureSide {
  const c = codeIn(code, error);
  if (c != null && CUSTOMER_SIDE_CODES.includes(c)) return 'customer';
  if ((c == null || c === 100 || c === 131009) && CUSTOMER_SIDE_WORDS.test(String(error || ''))) return 'customer';
  return 'meta';
}
const istClock = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const codeWords = (code: number | null | undefined, words: string | null | undefined) => {
  const w = String(words || '').replace(/[\r\n\t]+/g, ' ').trim();
  const c = code != null && !new RegExp(`^\\s*${code}\\b`).test(w) ? `${code} ` : '';
  return `${c}${w}`.trim() || 'no words from Meta';
};
// The PM2 line, once per stop.
export const stopLogLine = (code: number | null | undefined, words: string | null | undefined, order: string | null | undefined): string =>
  `[whatsapp] order messages STOPPED after a Meta failure (${codeWords(code, words)}, order ${order || '—'}): press Resume in WhatsApp > Automation`;
// The one WhatsApp to the owner: one line, no breaks, at most 600 characters (a template value).
export function stopAlertText(code: number | null | undefined, order: string | null | undefined, atMs: number, kind?: string | null): string {
  const what = kind === 'test' ? 'on the test message' : kind === 'alert' ? 'on a ShipTrack alert' : `on order ${order || '—'}`;
  return `WhatsApp order messages STOPPED: Meta refused (${code ?? 'no code'}) ${what} at ${istClock(atMs)}. Nothing is lost; open WhatsApp > Automation and press Resume when fixed.`.replace(/\s+/g, ' ').slice(0, 600);
}
// The Today board's red line (whatsapp-health-rules.ts) and the Number status box's first line.
export const stopBoardLine = (reason: string | null | undefined, atMs: number, order?: string | null): string =>
  `WhatsApp order messages are STOPPED after a Meta failure since ${istClock(atMs)} (${(reason || 'no words from Meta').slice(0, 160)}${order ? `, order ${order}` : ''}): nothing is lost, the messages wait. Open WhatsApp > Automation, check Meta's words, then press Resume`;
export const STOP_RESUME_CONFIRM = (perMinute: number, waiting: number) =>
  `Start sending order messages again, ${perMinute} a minute? ${waiting ? `The ${waiting} that waited go out in line. ` : ''}Make sure the cause (Meta's words in the Number status box) is fixed first: if Meta refuses even one again, everything stops again.`;

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

// Meta codes worth another try (a hiccup on their side or a rate limit), against ones that never change. Since the
// safety stop (2026-10-15 night) the worker no longer retries by itself: failureSide decides (a Meta-side failure =
// the row waits and the automation stops until Resume); kept for the tests and any later use.
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
  stopped: 'The customer asked us to stop WhatsApp messages (STOP)',
  inFirst: 'Not needed: the tracking link already went in the first message (one message per order)',
} as const;
