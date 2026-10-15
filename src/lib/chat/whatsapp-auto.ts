// ── WhatsApp automation: the worker (owner 2026-10-10) ──
// Runs every minute from the existing chat-email-poll cron route (no new crontab line). For every panel the
// Super Admin switched ON (chat_settings `wa_auto:<panel id>`, default OFF): (1) every new order of that panel
// (placed after the switch went on, within 24 hours) gets one row "placed" and one row "tracking" in wa_auto_sends
// (the unique key = never twice); (2) due rows are sent through the approved templates; (3) a failure is tried
// again up to 3 times when Meta's code says it may pass, else it stays Failed with the reason in words. Nothing
// here touches Shopify, the orders or Chat Support; the rules are in whatsapp-auto-rules.ts.
import { query, queryOne } from '@/lib/db';
import { sendWhatsAppTemplate, waConfigured, waDigits } from './whatsapp';
import { stoppedNumbers } from './whatsapp-stop';
import { listTemplates, renderTemplate, type TemplateInfo } from './whatsapp-templates';
import { templatesAccount } from './whatsapp-settings';
import { loadBrands } from './whatsapp-brands';
import { ORDER_LINK_PRESET } from './whatsapp-brand-rules';
import { loadHolidays } from './holidays';
import { isOfficeHours } from '@/lib/office-hours';
import {
  AUTO_PREFIX, BATCH, SEND_EVERY_MS, FRESH_MS, LINK_MODE_KEY, LINK_SEEN_CLEARED, LINK_SEEN_KEY, LINK_TEMPLATE, LINK_VARS, MODE_LOG_EVERY_MS, PLACED_TEMPLATE, RATE_MAX_ATTEMPTS, SKIP,
  TRACKING_TEMPLATE, TRACKING_TOO_LATE_MS,
  autoKey, autoValue, dueNow, eligibleFrom, failureSide, findLinkTemplate, gapFor, isLinkTemplateName, linkMemoryAction, linkModeOf, linkModeValue, linkSeenFresh, linkSeenValue, linkStateText,
  parseAuto, parseLinkMode, parseLinkSeen, pauseView, pickTemplate, placedParams,
  templatesReadNote, trackingCanGo, trackingDueMs, trackingParams, waitingLinkLine, waitingTemplateLine,
  type AutoSetting, type LinkMode, type LinkModeSetting, type LinkSeen, type PauseView, type BrandWords, type OrderFacts, type SendRate,
} from './whatsapp-auto-rules';
import { dayRange } from './whatsapp-auto-view';
import { loadSendRate, pauseState, sendEvery, takeSendSlot, whatsAppPause } from './whatsapp-pause';
import { safetyStop } from './whatsapp-safety-stop';
import { alertsWaiting } from './whatsapp-alert-queue';
import { quietBefore } from './whatsapp-auto-status';
import { knownNumbers24h, limitNow, loadWaHealth, usedNumbers } from './whatsapp-health';
import { limitFreeAt, limitReached, waHealthLines, type WaLine } from './whatsapp-health-rules';
import { loadForeignToday, loadTestReports, noteTestSent, type TestRecord } from './whatsapp-foreign';
import { foreignLine, type ForeignLine, type ForeignToday } from './whatsapp-foreign-rules';

export type Kind = 'placed' | 'tracking';
const STATUSES = ['pending', 'sent', 'delivered', 'read', 'failed', 'skipped'] as const;
export type Counts = Record<typeof STATUSES[number], number>;
const zero = (): Counts => ({ pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 });

interface TableErr { code?: string }
const missingTable = (e: unknown) => (e as TableErr)?.code === '42P01';

export async function loadAutoSettings(): Promise<Map<string, AutoSetting>> {
  const out = new Map<string, AutoSetting>();
  const r = await query<{ key: string; value: string }>(`SELECT key, value FROM chat_settings WHERE key LIKE 'wa_auto:%'`);
  for (const row of r.rows) out.set(row.key.slice(AUTO_PREFIX.length), parseAuto(row.value));
  return out;
}

// ON starts the clock: only orders placed from this moment on are ever messaged. OFF drops the panel's waiting
// messages (Skipped), so switching it on again later never sends anything old.
export async function saveAuto(panelId: string, enabled: boolean, nowMs = Date.now()): Promise<AutoSetting> {
  const value = autoValue(enabled, nowMs);
  if (!enabled) {
    try {
      await query(`UPDATE wa_auto_sends SET status = 'skipped', error = 'Automation was switched off', updated_at = now() WHERE business_id = $1 AND status = 'pending'`, [panelId]);
    } catch (e) { if (!missingTable(e)) throw e; }
  }
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [autoKey(panelId), value]
  );
  return parseAuto(value);
}

// The two templates' state on Meta (APPROVED / PENDING / REJECTED / MISSING), read live once a minute at most.
// `account` = the account the list came from, masked to its last 4 digits (for the log line; never the whole id).
export interface TemplatesRead { list: TemplateInfo[] | null; error: string | null; account: string | null }
let tplCache: TemplatesRead & { at: number } = { at: 0, list: null, error: null, account: null };
const maskAccount = (id: string) => `…${id.slice(-4)}`;
export async function templateStates(nowMs = Date.now(), force = false): Promise<TemplatesRead> {
  if (!force && nowMs - tplCache.at < 60_000) return tplCache;
  const account = await templatesAccount().catch(() => '');
  if (!account) { tplCache = { at: nowMs, list: null, error: 'No Messaging account id saved (Setup tab)', account: null }; return tplCache; }
  const r = await listTemplates(account);
  tplCache = 'error' in r ? { at: nowMs, list: null, error: r.error, account: maskAccount(account) } : { at: nowMs, list: r.value, error: null, account: maskAccount(account) };
  return tplCache;
}
export const resetTemplateCache = () => { tplCache = { at: 0, list: null, error: null, account: null }; };
// the APPROVED template of that name (Meta keeps names in small letters; a stray space or capital never hides one)
const approved = (list: TemplateInfo[] | null, name: string) => list?.find((t) => t.name.trim().toLowerCase() === name && t.status === 'APPROVED') || null;
const stateOf = (list: TemplateInfo[] | null, name: string) => (list ? (list.find((t) => t.name.trim().toLowerCase() === name)?.status || 'MISSING') : 'UNKNOWN');
// the one-message template is found by name OR by its prefix + 5 values (whatsapp-auto-rules.ts findLinkTemplate, owner
// 2026-10-15: a remade template is often order_placed_link_2 and the exact name never matched)
const linkTemplateOf = (list: TemplateInfo[] | null) => findLinkTemplate(list);

// The switch "One message per order" (owner 2026-10-15; whatsapp-auto-rules.ts LINK_MODE_KEY): read with a 10-second
// cache per process like the pause; a failed read = no row = ON (the template decides, as before).
let linkModeCache: { at: number; setting: LinkModeSetting } | null = null;
export async function loadLinkMode(nowMs = Date.now()): Promise<LinkModeSetting> {
  if (linkModeCache && nowMs - linkModeCache.at < 10_000) return linkModeCache.setting;
  let setting: LinkModeSetting = { on: null, by: null, at: null };
  try {
    const r = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [LINK_MODE_KEY]);
    setting = parseLinkMode(r?.value);
  } catch (e) { console.error('[wa-auto] link mode:', (e as Error).message); }
  linkModeCache = { at: nowMs, setting };
  return setting;
}
export async function saveLinkMode(on: boolean, by: string, nowMs = Date.now()): Promise<LinkModeSetting> {
  const value = linkModeValue(on, by, nowMs);
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [LINK_MODE_KEY, value]);
  linkModeCache = null;
  console.log(`[wa-auto] one message per order switched ${on ? 'ON' : 'OFF'} by ${by}`);
  return parseLinkMode(value);
}
export const forgetLinkModeCache = () => { linkModeCache = null; };
// Never back to the deleted templates (2026-10-15 night; whatsapp-auto-rules.ts LINK_SEEN_KEY): the link template a read
// last listed APPROVED is remembered in chat_settings `wa_link_seen` (read with a 10-second cache per process, like the
// switch), written only when it changed or the stored time is older than 10 minutes, cleared only by a read that lists
// that name REJECTED / PAUSED / DISABLED. A read that flips (Meta listing the old two and missing the link template for a
// while after a deletion) then changes nothing: the remembered template sends, the old two never go.
let linkSeenCache: { at: number; seen: LinkSeen | null } | null = null;
// the last APPROVED link template this process read in full (its real words for the message record); the memory row keeps
// only the name + language, so after a restart the preset's words stand in until the next read lists it
let lastLinkInfo: TemplateInfo | null = null;
export async function loadLinkSeen(nowMs = Date.now()): Promise<LinkSeen | null> {
  if (linkSeenCache && nowMs - linkSeenCache.at < 10_000) return linkSeenCache.seen;
  let seen: LinkSeen | null = null;
  try {
    const r = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [LINK_SEEN_KEY]);
    seen = parseLinkSeen(r?.value);
  } catch (e) { console.error('[wa-auto] link seen:', (e as Error).message); }
  linkSeenCache = { at: nowMs, seen };
  return seen;
}
export const forgetLinkSeenCache = () => { linkSeenCache = null; lastLinkInfo = null; };
async function writeLinkSeen(value: string, seen: LinkSeen | null, nowMs: number): Promise<void> {
  try {
    await query(
      `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [LINK_SEEN_KEY, value]);
    linkSeenCache = { at: nowMs, seen };
  } catch (e) { console.error('[wa-auto] link seen:', (e as Error).message); }
}
const rememberedInfo = (seen: LinkSeen): TemplateInfo => (lastLinkInfo && lastLinkInfo.name.trim().toLowerCase() === seen.name && lastLinkInfo.language === seen.language ? lastLinkInfo
  : { id: '', name: seen.name, language: seen.language, category: ORDER_LINK_PRESET.category, status: 'APPROVED', header: ORDER_LINK_PRESET.header || null, body: ORDER_LINK_PRESET.body, footer: ORDER_LINK_PRESET.footer || null, vars: LINK_VARS, rejectedReason: null });
// after a read: the memory follows what it found (write / clear / keep), and the fresh memory comes back for linkModeOf
async function rememberLink(list: TemplateInfo[] | null, found: TemplateInfo | null, nowMs: number): Promise<LinkSeen | null> {
  const seen = linkSeenFresh(await loadLinkSeen(nowMs), nowMs);
  const action = linkMemoryAction(seen, found, list, nowMs);
  if (found) lastLinkInfo = found;
  if (action === 'write') {
    const next: LinkSeen = { name: found!.name.trim().toLowerCase(), language: found!.language, at: nowMs };
    await writeLinkSeen(linkSeenValue(found!.name, found!.language, nowMs), next, nowMs);
    if (!seen || seen.name !== next.name) console.log(`[wa-auto] remembered ${next.name} (${next.language}) as approved: a read that misses it changes nothing, the old templates are never sent`);
    return next;
  }
  if (action === 'clear') {
    const st = list?.find((t) => t.name.trim().toLowerCase() === seen!.name)?.status || 'gone';
    await writeLinkSeen(LINK_SEEN_CLEARED(nowMs, `${seen!.name} is ${st}`), null, nowMs);
    console.warn(`[wa-auto] ${seen!.name} is ${st.toLowerCase()} on Meta: the remembered one-message template is forgotten`);
    return null;
  }
  return seen;
}
// Which mode runs now and why, from the templates read, the switch and the memory (the ONE decision the worker, the
// overview and the test send share). Logged by the worker once per run that sends, and whenever the answer changes.
async function currentLinkMode(list: TemplateInfo[] | null, listError: string | null, nowMs: number): Promise<LinkMode> {
  const found = linkTemplateOf(list);
  const link = found.template;
  const seen = await rememberLink(list, link, nowMs);
  return linkModeOf(await loadLinkMode(nowMs), link ? { name: link.name, language: link.language } : null, found.state, listError, found.note, seen);
}
// The template a send goes with: the one this read listed APPROVED, else the remembered one while the mode runs on it.
function linkInfoFor(list: TemplateInfo[] | null, mode: LinkMode): TemplateInfo | null {
  const found = linkTemplateOf(list).template;
  if (found) return found;
  return mode.active && mode.remembered && mode.template ? rememberedInfo({ name: mode.template.name, language: mode.template.language, at: Date.parse(mode.seenAt || '') || 0 }) : null;
}
// The mode line: once per run that sends, whenever the answer changes, and at least every 10 minutes per process even when
// unchanged, so the PM2 log always says what runs now (owner 2026-10-15: the only line for hours was a stale one).
let lastModeLogged = '', lastModeLoggedAt = 0;
export const resetModeLog = () => { lastModeLogged = ''; lastModeLoggedAt = 0; };

interface DueRow {
  id: string; order_id: string; kind: Kind; attempts: number; due_at: string; placed_template: string | null;
  gone: boolean; customer_name: string | null; customer_mobile: string | null; created_at: string | null;
  is_cancelled: boolean | null; tracking_status: string | null; delivered_at: string | null;
  tracking_token: string | null; tracking_domain: string | null;
}

// limited = messages to NEW customers that waited for the daily limit this run (they stay pending, not failed / skipped);
// waitingLink = 'placed' rows that waited for their order's tracking link in the one-message mode (owner 2026-10-15 evening);
// stopped = this run met a Meta-side failure and stopped every order message until Resume (owner 2026-10-15 night);
// waitingTemplate = rows that waited because the one-message template was neither listed nor remembered in words (never the old two)
export interface AutoRun { idle?: string; panels: number; queued: number; sent: number; failed: number; skipped: number; retried: number; paused?: boolean; limited?: number; waitingLink?: number; waitingTemplate?: number; stopped?: boolean }

const TIMED_OUT = 'WhatsApp did not answer in time';   // whatsapp.ts, the 15-second cut
const g = globalThis as unknown as { __waAutoBusy?: boolean; __waAutoInstalled?: boolean | null };

// The daily limit guard (owner 2026-10-15: Meta refused every message to a NEW customer at ~250 in 24 h whatever the
// speed; whatsapp-health-rules.ts). Once per run: the limit (Meta's tier, else the one typed in WhatsApp > Setup) and the
// count of different customers we started a conversation with in the last 24 hours (one count query). Only when that
// count is within one batch of the limit are the numbers themselves read (at most `limit` of them), so each row can tell
// a NEW customer (waits at the limit) from one messaged in the last 24 hours (still goes). ShipTrack's alerts
// (whatsapp-alert-queue.ts) and the test send never pass through here. A failed read = no guard (never a stuck queue).
interface DailyGuard { limit: number | null; used: number; known: Set<string> | null }
async function dailyGuard(nowMs: number): Promise<DailyGuard> {
  try {
    const { limit } = await limitNow(nowMs);
    if (!limit) return { limit: null, used: 0, known: null };
    const { used24h } = await usedNumbers();
    return { limit, used: used24h, known: used24h + BATCH >= limit ? await knownNumbers24h() : null };
  } catch (e) { console.error('[wa-auto] daily limit:', (e as Error).message); return { limit: null, used: 0, known: null }; }
}
// a NEW customer for Meta's rolling window (the guard only knows the numbers when the count is near the limit)
const newCustomer = (guard: DailyGuard, digits: string) => guard.limit != null && guard.known != null && !guard.known.has(digits);

export async function runWaAutomation(nowMs = Date.now()): Promise<AutoRun> {
  const out: AutoRun = { panels: 0, queued: 0, sent: 0, failed: 0, skipped: 0, retried: 0, limited: 0, waitingLink: 0, stopped: false };
  if (g.__waAutoBusy) return { ...out, idle: 'busy' };
  g.__waAutoBusy = true;
  try {
    if (!waConfigured()) return { ...out, idle: 'not_configured' };
    let settings: Map<string, AutoSetting>;
    try { settings = await loadAutoSettings(); } catch (e) { console.error('[wa-auto] settings:', (e as Error).message); return { ...out, idle: 'settings_unreadable' }; }
    const on = [...settings.entries()].filter(([, s]) => s.enabled);
    if (!on.length) return { ...out, idle: 'all_off' };
    try { await query(`SELECT 1 FROM wa_auto_sends LIMIT 1`); g.__waAutoInstalled = true; }
    catch (e) { if (missingTable(e)) { g.__waAutoInstalled = false; return { ...out, idle: 'not_installed' }; } throw e; }

    const holidays = await loadHolidays(nowMs).catch(() => [] as string[]);
    const brands = new Map<string, BrandWords>();
    for (const b of await loadBrands().catch(() => [])) brands.set(b.id, { name: b.name, email: b.email });
    const { list, error: listError, account } = await templateStates(nowMs);
    // one message or two (owner 2026-10-15): decided ONCE per run, said in the log when it changes, once per run that sends,
    // and every 10 minutes anyway; when it is two messages for want of the template, the line also says what Meta listed
    // (the account's last 4 digits, how many templates, the order_* names with their status), so the log answers "why"
    const mode = await currentLinkMode(list, listError, nowMs);
    const linkFound = linkInfoFor(list, mode);   // this read's, else the remembered one (never back to the deleted templates)
    const readNote = mode.on && !mode.approved && !listError ? templatesReadNote(list, account) : '';
    let modeLogged = false;
    const logMode = () => { if (modeLogged) return; modeLogged = true; lastModeLogged = mode.reason; lastModeLoggedAt = nowMs; console.log(`[wa-auto] ${mode.reason}${readNote ? ` ${readNote}` : ''}`); };
    if (mode.reason !== lastModeLogged || nowMs - lastModeLoggedAt >= MODE_LOG_EVERY_MS) logMode();
    let budget = BATCH;
    // Meta's rate limit (130429) or the safety stop (owner 2026-10-15 night: any Meta-side failure, until Resume): nothing
    // is sent while the number is paused / stopped; new orders are still queued. When it is over, the messages that
    // failed with a 130429 before (they never went out) wait in line again, at most RATE_MAX_ATTEMPTS tries.
    let paused = !!(await whatsAppPause(nowMs));
    // ShipTrack's alerts go first (owner 2026-10-15, "chargeback sabse pehle"): while one waits, no order message goes.
    const alertsFirst = (await alertsWaiting(nowMs)) > 0;
    if (!paused) {
      await query(
        `UPDATE wa_auto_sends SET status = 'pending', due_at = now(), updated_at = now()
          WHERE status = 'failed' AND (code = $1 OR error LIKE '130429%') AND attempts < $2 AND updated_at > now() - interval '24 hours'`,
        [130429, RATE_MAX_ATTEMPTS]).catch((e) => console.error('[wa-auto] requeue:', (e as Error).message));
    }
    out.paused = paused;
    // the gap between two order messages: the chosen speed (1-4 a minute, 2 by default), the slower of it and 60 s for
    // two hours after a 130429 (whatsapp-auto-rules.ts sendEveryFor, whatsapp-pause.ts sendEvery)
    const every = await sendEvery(nowMs);
    // numbers whose customer wrote STOP (whatsapp-stop.ts): never messaged
    const stopped = await stoppedNumbers().catch(() => new Set<string>());
    // the daily limit (owner 2026-10-15): at the limit, a NEW customer waits (the row stays pending), a known one still goes
    const guard = paused || alertsFirst ? { limit: null, used: 0, known: null } as DailyGuard : await dailyGuard(nowMs);
    let limitLogged = false;

    for (const [panelId, s] of on) {
      out.panels++;
      // 1. new orders -> a "placed" row now and a "tracking" row for 48 hours later
      const from = new Date(eligibleFrom(s.since, nowMs));
      const fresh = await query<{ order_id: string; customer_mobile: string | null; created_at: string }>(
        `SELECT o.order_id, o.customer_mobile, o.created_at
           FROM orders o
          WHERE o.business_id::text = $1 AND o.created_at >= $2 AND o.is_cancelled IS NOT TRUE
            AND (NOT EXISTS (SELECT 1 FROM wa_auto_sends w WHERE w.business_id = $1 AND w.order_id = o.order_id AND w.kind = 'placed')
                 OR NOT EXISTS (SELECT 1 FROM wa_auto_sends w WHERE w.business_id = $1 AND w.order_id = o.order_id AND w.kind = 'tracking'))
          ORDER BY o.created_at ASC LIMIT 100`,
        [panelId, from]
      );
      for (const o of fresh.rows) {
        const digits = waDigits(o.customer_mobile);
        const created = new Date(o.created_at).getTime();
        await query(
          `INSERT INTO wa_auto_sends (business_id, order_id, kind, status, to_number, error, due_at)
           VALUES ($1, $2, 'placed', $3, $4, $5, now()) ON CONFLICT (business_id, order_id, kind) DO NOTHING`,
          [panelId, o.order_id, digits ? 'pending' : 'skipped', digits, digits ? null : SKIP.noNumber]
        );
        await query(
          `INSERT INTO wa_auto_sends (business_id, order_id, kind, status, to_number, error, due_at)
           VALUES ($1, $2, 'tracking', $3, $4, $5, $6) ON CONFLICT (business_id, order_id, kind) DO NOTHING`,
          [panelId, o.order_id, digits ? 'pending' : 'skipped', digits, digits ? null : SKIP.noNumber, new Date(trackingDueMs(created, holidays))]
        );
        out.queued++;
      }

      if (paused || alertsFirst) continue;
      // 2. due rows, a few a minute: order-placed first; tracking rows only while the office is open and something can
      // send them: order_tracking APPROVED, or the one-message mode (the link template carries them since 2026-10-15
      // evening). A pile of waiting tracking rows must never hold back today's order-placed messages.
      const trackingNow = trackingCanGo(isOfficeHours(nowMs, holidays), !!approved(list, TRACKING_TEMPLATE), mode.active);
      const due = await query<DueRow>(
        `SELECT w.id::text AS id, w.order_id, w.kind, w.attempts, w.due_at,
                (SELECT p.template FROM wa_auto_sends p WHERE p.business_id = w.business_id AND p.order_id = w.order_id AND p.kind = 'placed' AND p.sent_at IS NOT NULL) AS placed_template,
                (o.order_id IS NULL) AS gone, o.customer_name, o.customer_mobile, o.created_at, o.is_cancelled,
                o.tracking_status, o.delivered_at, o.tracking_token::text AS tracking_token, b.tracking_domain
           FROM wa_auto_sends w
           LEFT JOIN orders o ON o.business_id::text = w.business_id AND o.order_id = w.order_id
           LEFT JOIN businesses b ON b.id = o.business_id
          WHERE w.business_id = $1 AND w.status = 'pending' AND w.due_at <= now() AND (w.kind = 'placed' OR $2::boolean)
          ORDER BY (w.kind = 'placed') DESC, w.due_at ASC LIMIT 40`,
        [panelId, trackingNow]
      );
      const brand: BrandWords = brands.get(panelId) || { name: '', email: '' };
      for (const r of due.rows) {
        if (budget <= 0 || paused) break;
        const skip = async (why: string) => { await query(`UPDATE wa_auto_sends SET status = 'skipped', error = $2, updated_at = now() WHERE id = $1`, [r.id, why]); out.skipped++; };
        if (r.gone) { await skip(SKIP.gone); continue; }
        const createdMs = r.created_at ? new Date(r.created_at).getTime() : nowMs;
        if (r.is_cancelled) { await skip(SKIP.cancelled); continue; }
        const digits = waDigits(r.customer_mobile);
        if (!digits) { await skip(SKIP.noNumber); continue; }
        if (stopped.has(digits)) { await skip(SKIP.stopped); continue; }
        if (r.kind === 'placed' && nowMs - createdMs > FRESH_MS) { await skip(SKIP.tooOld); continue; }
        if (r.kind === 'tracking') {
          if (isLinkTemplateName(r.placed_template)) { await skip(SKIP.inFirst); continue; }   // the link went in the first message (order_placed_link or a remade order_placed_link_2)
          if (r.delivered_at || /^delivered$/i.test(r.tracking_status || '')) { await skip(SKIP.delivered); continue; }
          if (!r.tracking_token) { await skip(SKIP.noLink); continue; }
          if (nowMs - createdMs > TRACKING_TOO_LATE_MS) { await skip(SKIP.tooOld); continue; }
          if (!dueNow('tracking', new Date(r.due_at).getTime(), nowMs, holidays)) continue;   // office closed: it waits
        }
        // Which template (whatsapp-auto-rules.ts pickTemplate, owner 2026-10-15 evening: only order_placed_link while the
        // one-message mode runs, under its real name + language): a 'placed' row with its link and a 'tracking' row go
        // with it; a 'placed' row without a link WAITS (never order_placed); the old two never go in this mode. With the
        // switch OFF the old templates as before, and a row whose template is not approved waits.
        // noOld (2026-10-15 night): the switch ON and the link template approved (this read or remembered) = the old two never
        const pick = pickTemplate(r.kind, !!r.tracking_token, { active: mode.active, noOld: mode.on && mode.approved }, linkFound, approved(list, PLACED_TEMPLATE), approved(list, TRACKING_TEMPLATE));
        if (pick.waits === 'link') { out.waitingLink = (out.waitingLink || 0) + 1; continue; }   // said once per run, below
        if (pick.waits === 'link-template') { out.waitingTemplate = (out.waitingTemplate || 0) + 1; continue; }
        if (!pick.template) continue;                                                          // not approved by Meta yet: it waits
        const tpl = pick.template;
        const sentWithLink = r.kind === 'placed' && pick.params === 'tracking';             // the first message carries the link
        logMode();
        const base = (r.tracking_domain || process.env.TRACKING_BASE_URL || 'https://shiptrack.store').replace(/\/+$/, '');
        const facts: OrderFacts = { orderId: r.order_id, customerName: r.customer_name, trackingLink: r.tracking_token ? `${base}/track/${r.tracking_token}` : null };
        const params = pick.params === 'tracking' ? trackingParams(facts, brand) : placedParams(facts, brand);
        if (params.length < tpl.vars) {
          await query(`UPDATE wa_auto_sends SET status = 'failed', error = $2, attempts = attempts + 1, updated_at = now() WHERE id = $1`,
            [r.id, `The template "${tpl.name}" has ${tpl.vars} values but the automation fills ${params.length}. Make the template again from its preset button.`]);
          out.failed++; continue;
        }
        if (!brand.email) {
          await query(`UPDATE wa_auto_sends SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
            [r.id, 'This brand has no support email for the message: set it in WhatsApp > Templates > "Each brand\'s own words", then Send again']);
          out.failed++; continue;
        }
        // The daily limit (owner 2026-10-15): a NEW customer waits while the last 24 hours' count is at the limit (not
        // failed, not skipped: the row goes once the oldest conversation drops out of Meta's window); said once per run
        if (newCustomer(guard, digits) && guard.used >= guard.limit!) {
          if (!limitLogged) { limitLogged = true; console.warn(`[wa-auto] daily limit reached: ${guard.used} of ${guard.limit} customers in the last 24 h; new customers wait`); }
          out.limited = (out.limited || 0) + 1; continue;
        }
        // Slow and steady (owner 2026-10-15): one order message per chosen gap for the whole install; no slot = this run stops
        if (!(await takeSendSlot(every))) break;
        // The server runs two processes: claim the row first (only one of them gets it) so nobody is messaged twice.
        const claim = await query(
          `UPDATE wa_auto_sends SET due_at = now() + interval '30 minutes', updated_at = now()
            WHERE id = $1 AND status = 'pending' AND due_at <= now() RETURNING id`, [r.id]);
        if (!claim.rowCount) continue;
        budget--;
        const res = await sendWhatsAppTemplate(digits, tpl.name, tpl.language, params.slice(0, tpl.vars));
        if (!('error' in res)) {
          await query(
            `UPDATE wa_auto_sends SET status = 'sent', wa_id = $2, to_number = $3, template = $4, body_text = $5, error = NULL, code = NULL,
                    attempts = attempts + 1, sent_at = now(), updated_at = now() WHERE id = $1`,
            [r.id, res.id, digits, tpl.name, renderTemplate(tpl, params.slice(0, tpl.vars))]
          );
          out.sent++;
          if (newCustomer(guard, digits)) { guard.used++; guard.known!.add(digits); }   // one more of the 24 hours' customers
          if (sentWithLink) {
            await query(`UPDATE wa_auto_sends SET status = 'skipped', error = $3, updated_at = now()
                          WHERE business_id = $1 AND order_id = $2 AND kind = 'tracking' AND status = 'pending'`,
              [panelId, r.order_id, SKIP.inFirst]).catch(() => undefined);
          }
        } else if (failureSide(res.code, res.error) === 'customer') {
          // this ONE number (not on WhatsApp, blocked us, the per-user limit): that message fails, the rest go on
          await query(`UPDATE wa_auto_sends SET status = 'failed', error = $2, code = $3, attempts = attempts + 1, template = $4, updated_at = now() WHERE id = $1`,
            [r.id, res.error, res.code, tpl.name]);
          out.failed++;
        } else if (res.error === TIMED_OUT) {
          // Meta may have taken it before the answer was lost: never sent again by itself (a second copy to the customer
          // is worse than one Send again); the number still stops (owner 2026-10-15 night: a lost answer is Meta's side)
          await query(`UPDATE wa_auto_sends SET status = 'failed', error = $2, code = NULL, attempts = attempts + 1, template = $3, updated_at = now() WHERE id = $1`,
            [r.id, 'WhatsApp did not answer in time: it may still have been delivered. Check with the customer before Send again.', tpl.name]);
          out.failed++;
          await safetyStop({ code: null, words: res.error, order: r.order_id, kind: r.kind, template: tpl.name }, nowMs, nowMs, await quietBefore(nowMs));
          paused = true; out.paused = true; out.stopped = true;
        } else {
          // META's side (owner 2026-10-15 night, "1 msg bhi fail ho toh pause ho jae": 130429 rate limit, 132001 template
          // missing while Meta propagates a deletion, the token, a hiccup, an unknown code): the message is NOT lost (it
          // waits in line again, due now; failed only after RATE_MAX_ATTEMPTS tries) and every order message STOPS until
          // the Super Admin presses Resume. Refused right after 10 quiet minutes = Meta's side, not our speed: the stop says so.
          // the row keeps the template Meta refused (2026-10-15 night), so a failed row says which one, and the stop's reason too
          await query(`UPDATE wa_auto_sends SET status = $5, attempts = attempts + 1, error = $2, code = $3, due_at = $4, template = $6, updated_at = now() WHERE id = $1`,
            [r.id, res.error, res.code, new Date(nowMs), r.attempts + 1 >= RATE_MAX_ATTEMPTS ? 'failed' : 'pending', tpl.name]);
          await safetyStop({ code: res.code, words: res.error, order: r.order_id, kind: r.kind, template: tpl.name }, nowMs, nowMs, await quietBefore(nowMs));
          paused = true; out.paused = true; out.stopped = true; out.retried++;
        }
      }
    }
    // the orders whose message waits for a tracking link (one message per order): one line per run with the count
    if (out.waitingLink) console.warn(waitingLinkLine(out.waitingLink, linkFound?.name.trim().toLowerCase()));
    if (out.waitingTemplate) console.warn(waitingTemplateLine(out.waitingTemplate));
    return out;
  } finally {
    g.__waAutoBusy = false;
  }
}

// ── What the Automation tab shows ──
// Owner 2026-10-11 ("date ka filter nahi hai, aaj ke kitne gaye, kya gaye, kyun gaye, raat ko kyun gaye"): everything is
// for the chosen India days (whatsapp-auto-view.ts dayRange: today by default). A message counts on the day of its own
// time (MSG_AT: when it went, failed or was skipped; a waiting one by when it goes). The list carries every message of
// those days (and the other message of the same order, so both show side by side), not just the latest 300 rows.
export interface PanelAuto {
  id: string; name: string; enabled: boolean; since: string | null;
  placed: Counts; tracking: Counts;            // all time
  placedIn: Counts; trackingIn: Counts;        // the chosen days
  orders: { total: number; cancelled: number; queued: number; beforeOn: number };   // orders that came in on the chosen days
  replied: number;                     // customers who wrote back after one of these messages (distinct numbers)
}
export interface RecentRow {
  id: string; panel: string; panel_id: string; order_id: string; name: string | null; kind: Kind; status: string; to: string | null; error: string | null; code: number | null;
  attempts: number; due_at: string; sent_at: string | null;
  at?: string | null; order_at?: string | null; in_range?: boolean;
}
export interface AutoOverview {
  installed: boolean; configured: boolean;
  // link = the one-message template's state; linkName = the template that state is about when its name is not exactly
  // order_placed_link (a remade order_placed_link_2 ...), so the tab shows the real name
  templates: { placed: string; tracking: string; link: string; linkName: string | null; error: string | null };
  paused: { until: string; reason: string; stopped?: boolean } | null;   // stopped = the safety stop (owner 2026-10-15 night), until Resume
  sendEveryMs?: number;
  // ShipTrack's own alerts waiting in the queue (alerts first: order messages wait while any does).
  alertsWaiting?: number;
  // The "Number status" box (owner 2026-10-15): paused / slow / normal, until when, Meta's last refusal; and how many
  // order messages are due now (waiting only for their turn or the pause).
  pauseInfo?: PauseView; ordersDue?: number;
  // One message per order (owner 2026-10-15): the switch, Meta's approval, whether it runs, and why in words.
  linkMode?: LinkMode;
  // Meta's side of the number (owner 2026-10-15, the Number status box): quality, status, messaging limit; null = not set up.
  numberHealth?: NumberHealth | null;
  // The speed the owner chose (owner 2026-10-15, "har minute 2, 3, 4 message"): 1-4 order messages a minute, 2 by default.
  sendRate?: SendRate;
  // Another app on the number (owner 2026-10-15): Meta's delivery reports today for messages ShipTrack never sent
  // (whatsapp-foreign-rules.ts), and the line the Number status box shows (null = nothing to say).
  foreign?: ForeignToday & { line: ForeignLine | null };
  // The last test messages with Meta's delivery report for each (owner 2026-10-15 night: a test said "sent" and never
  // arrived; whatsapp-foreign.ts noteTestStatus), newest first.
  tests?: TestRecord[];
  range: { day: string; from: string; to: string };
  panels: PanelAuto[]; recent: RecentRow[]; capped: boolean;
}
export interface NumberHealth {
  quality: string; status: string; tier: string; limit: number | null; limitFrom: 'meta' | 'saved' | null;
  used24h: number; usedToday: number; error: string | null; lines: WaLine[];
  // the daily limit guard (owner 2026-10-15): at the limit new customers wait until `limitFreeAt` (the oldest of the
  // window drops out). (The "Meta refused near the limit, type 250" line is gone: the live data disproved it.)
  limitReached: boolean; limitFreeAt: string | null;
}
// The number as Meta sees it (whatsapp-health.ts, Meta read at most every 5 minutes, never throws): for the Number
// status box, so a refusal can be read next to the quality rating, the status and the messaging limit.
async function numberHealth(nowMs: number): Promise<NumberHealth | null> {
  try {
    const h = await loadWaHealth(nowMs);
    if (!h) return null;
    return {
      quality: h.quality, status: h.status, tier: h.tier, limit: h.limit, limitFrom: h.limitFrom, used24h: h.used24h, usedToday: h.usedToday ?? 0, error: h.phoneError, lines: waHealthLines(h),
      limitReached: limitReached(h), limitFreeAt: limitReached(h) ? limitFreeAt(h) : null,
    };
  } catch (e) { console.error('[wa-auto] number health:', (e as Error).message); return null; }
}
const maskTo = (n: string | null) => (n ? `••••${n.slice(-4)}` : null);
const MSG_AT = `COALESCE(w.sent_at, CASE WHEN w.status = 'pending' THEN w.due_at ELSE w.updated_at END)`;
export const LIST_MAX = 4000;

export async function automationOverview(day: string | null = null, nowMs = Date.now()): Promise<AutoOverview> {
  const rg = dayRange(day, nowMs);
  const from = new Date(rg.from), to = new Date(rg.to);
  const panelRows = await query<{ id: string; name: string }>(`SELECT b.id::text AS id, b.name FROM businesses b ORDER BY b.is_default DESC, b.created_at ASC`);
  const settings = await loadAutoSettings().catch(() => new Map<string, AutoSetting>());
  const { list, error } = await templateStates();
  const panels: PanelAuto[] = panelRows.rows.map((p) => {
    const s = settings.get(p.id) || { enabled: false, since: null };
    return { id: p.id, name: p.name, enabled: s.enabled, since: s.since ? new Date(s.since).toISOString() : null, placed: zero(), tracking: zero(), placedIn: zero(), trackingIn: zero(), orders: { total: 0, cancelled: 0, queued: 0, beforeOn: 0 }, replied: 0 };
  });
  let installed = true; let recent: RecentRow[] = []; let capped = false;
  try {
    const c = await query<{ business_id: string; kind: Kind; status: keyof Counts; n: number; nin: number }>(
      `SELECT business_id, kind, status, count(*)::int AS n,
              (count(*) FILTER (WHERE ${MSG_AT} >= $1 AND ${MSG_AT} < $2))::int AS nin
         FROM wa_auto_sends w GROUP BY 1, 2, 3`, [from, to]);
    for (const row of c.rows) {
      const p = panels.find((x) => x.id === row.business_id); if (!p || !STATUSES.includes(row.status)) continue;
      p[row.kind][row.status] += row.n; p[row.kind === 'placed' ? 'placedIn' : 'trackingIn'][row.status] += row.nin;
    }
    try {
      const rep = await query<{ business_id: string; replied: number }>(
        `SELECT w.business_id, count(DISTINCT w.to_number)::int AS replied
           FROM wa_auto_sends w
           JOIN sites s ON s.tracker_business_id::text = w.business_id
           JOIN conversations c ON c.site_id = s.id AND c.source = 'whatsapp' AND c.visitor_id = 'wa:' || w.to_number
           JOIN messages m ON m.conversation_id = c.id AND m.sender = 'visitor' AND m.deleted_at IS NULL AND m.created_at > w.sent_at
          WHERE w.sent_at IS NOT NULL GROUP BY w.business_id`
      );
      for (const row of rep.rows) { const p = panels.find((x) => x.id === row.business_id); if (p) p.replied = row.replied; }
    } catch (e) { console.error('[wa-auto] replied count:', (e as Error).message); }
    // the orders that came in on those days: how many got the order-placed message, and why the rest did not
    try {
      const since: Record<string, string> = {};
      for (const p of panels) if (p.enabled && p.since) since[p.id] = p.since;
      const oc = await query<{ business_id: string; total: number; cancelled: number; queued: number; before_on: number }>(
        `SELECT o.business_id::text AS business_id, count(*)::int AS total,
                (count(*) FILTER (WHERE o.is_cancelled IS TRUE))::int AS cancelled,
                (count(w.id))::int AS queued,
                (count(*) FILTER (WHERE w.id IS NULL AND o.is_cancelled IS NOT TRUE
                                    AND o.created_at < ($3::jsonb ->> o.business_id::text)::timestamptz))::int AS before_on
           FROM orders o
           LEFT JOIN wa_auto_sends w ON w.business_id = o.business_id::text AND w.order_id = o.order_id AND w.kind = 'placed'
          WHERE o.created_at >= $1 AND o.created_at < $2
          GROUP BY 1`, [from, to, JSON.stringify(since)]);
      for (const row of oc.rows) { const p = panels.find((x) => x.id === row.business_id); if (p) p.orders = { total: row.total, cancelled: row.cancelled, queued: row.queued, beforeOn: row.before_on }; }
    } catch (e) { console.error('[wa-auto] orders count:', (e as Error).message); }
    const r = await query<{ id: string; business_id: string; order_id: string; kind: Kind; status: string; to_number: string | null; error: string | null; code: number | null; attempts: number; due_at: string; sent_at: string | null; customer_name: string | null; at: string | null; in_range: boolean; order_at: string | null }>(
      `WITH hit AS (SELECT DISTINCT w.business_id, w.order_id FROM wa_auto_sends w WHERE ${MSG_AT} >= $1 AND ${MSG_AT} < $2)
       SELECT w.id::text AS id, w.business_id, w.order_id, w.kind, w.status, w.to_number, w.error, w.code, w.attempts, w.due_at, w.sent_at,
              ${MSG_AT} AS at, (${MSG_AT} >= $1 AND ${MSG_AT} < $2) AS in_range, o.customer_name, o.created_at AS order_at
         FROM wa_auto_sends w
         JOIN hit h ON h.business_id = w.business_id AND h.order_id = w.order_id
         LEFT JOIN orders o ON o.business_id::text = w.business_id AND o.order_id = w.order_id
        ORDER BY at DESC LIMIT ${LIST_MAX + 1}`, [from, to]);
    capped = r.rows.length > LIST_MAX;
    recent = r.rows.slice(0, LIST_MAX).map((x) => ({ id: x.id, panel: panels.find((p) => p.id === x.business_id)?.name || x.business_id, panel_id: x.business_id, order_id: x.order_id, name: x.customer_name || null, kind: x.kind, status: x.status, to: maskTo(x.to_number), error: x.error, code: x.code, attempts: x.attempts, due_at: x.due_at, sent_at: x.sent_at, at: x.at, in_range: !!x.in_range, order_at: x.order_at || null }));
  } catch (e) {
    if (missingTable(e)) installed = false; else console.error('[wa-auto] overview:', (e as Error).message);
  }
  const link = linkTemplateOf(list);
  const linkMode = await currentLinkMode(list, error, nowMs);
  // the name the mode runs on: this read's, else the remembered one, else the closest by name on Meta
  const linkName = link.template ? link.template.name.trim().toLowerCase() : linkMode.remembered && linkMode.template ? linkMode.template.name : (list?.filter((t) => isLinkTemplateName(t.name))[0]?.name.trim().toLowerCase() ?? null);
  const sendRate = await loadSendRate(nowMs).catch(() => ({ perMinute: 2, by: null, at: null } as SendRate));
  const pauseInfo = pauseView(await pauseState().catch(() => null), nowMs, gapFor(sendRate.perMinute));
  // Meta refusing OUR messages now: a 130429 in the last 2 hours, a pause Meta set that still runs, or the safety stop
  const refusing = pauseInfo.strikes > 0 || (pauseInfo.state === 'paused' && !pauseInfo.manual) || pauseInfo.state === 'stopped';
  const foreignToday = await loadForeignToday(nowMs);
  return {
    installed, configured: waConfigured(),
    templates: { placed: stateOf(list, PLACED_TEMPLATE), tracking: stateOf(list, TRACKING_TEMPLATE), link: linkStateText(link.state, linkMode), linkName: linkName && linkName !== LINK_TEMPLATE ? linkName : null, error },
    paused: await whatsAppPause(nowMs).then((p) => (p ? { until: new Date(p.until).toISOString(), reason: p.reason, ...(p.stopped ? { stopped: true } : {}) } : null)).catch(() => null),
    sendEveryMs: await sendEvery(nowMs).catch(() => SEND_EVERY_MS),
    alertsWaiting: await alertsWaiting(nowMs).catch(() => 0),
    pauseInfo, sendRate,
    linkMode,
    numberHealth: waConfigured() ? await numberHealth(nowMs) : null,
    foreign: { ...foreignToday, line: foreignLine(foreignToday, refusing) },
    tests: await loadTestReports(),
    ordersDue: installed ? await query<{ n: number }>(`SELECT count(*)::int AS n FROM wa_auto_sends WHERE status = 'pending' AND due_at <= now()`)
      .then((r) => Number(r.rows[0]?.n || 0)).catch(() => 0) : 0,
    range: { day: rg.day, from: from.toISOString(), to: to.toISOString() }, panels, recent, capped,
  };
}

// "Send again" on a Failed row (the run still refuses an order that is too old / cancelled).
export async function retryFailed(id: string): Promise<boolean> {
  const r = await query(`UPDATE wa_auto_sends SET status = 'pending', attempts = 0, error = NULL, code = NULL, due_at = now(), updated_at = now() WHERE id = $1 AND status = 'failed'`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function panelExists(id: string): Promise<boolean> {
  return !!(await queryOne(`SELECT 1 FROM businesses WHERE id::text = $1`, [id]));
}

// "Send a test to my number" (owner 2026-10-10: "har cheez check kario"): the automation message(s) exactly as a
// customer of this brand would get them, filled from the brand's latest order (its order id and real tracking link)
// with the name typed, to the number typed. Nothing is recorded in wa_auto_sends and no customer is messaged. In the
// one-message mode (owner 2026-10-15 evening) it is the link template alone, and when the brand's latest order has no
// tracking link it says so instead of sending anything (order_placed is never sent in that mode).
export interface TestSend { kind: Kind; ok: boolean; text: string; error: string | null }
export async function sendAutomationTest(panelId: string, to: string, name: string): Promise<{ results: TestSend[]; order: string | null; mode: string } | { error: string }> {
  const digits = waDigits(to);
  if (!digits) return { error: 'Type the WhatsApp number (10 digits = India)' };
  if (!waConfigured()) return { error: 'WhatsApp is not set up on the server (token / phone number id)' };
  // A test goes at once, pause or not (owner 2026-10-15: "test message sabse pehle jaye"); Meta's answer is shown.
  const { list, error } = await templateStates(Date.now(), true);
  if (!list) return { error: error || 'Could not read the templates' };
  const brand = (await loadBrands().catch(() => [])).find((b) => b.id === panelId);
  const panelName = await queryOne<{ name: string }>(`SELECT name FROM businesses WHERE id::text = $1`, [panelId]).then((r) => r?.name || null).catch(() => null);
  const o = await queryOne<{ order_id: string; tracking_token: string | null; tracking_domain: string | null }>(
    `SELECT o.order_id, o.tracking_token::text AS tracking_token, b.tracking_domain
       FROM orders o LEFT JOIN businesses b ON b.id = o.business_id
      WHERE o.business_id::text = $1 ORDER BY o.created_at DESC LIMIT 1`,
    [panelId]
  ).catch(() => null);
  const base = (o?.tracking_domain || process.env.TRACKING_BASE_URL || 'https://shiptrack.store').replace(/\/+$/, '');
  const facts: OrderFacts = { orderId: o?.order_id || '#TEST', customerName: name || 'Test', trackingLink: o?.tracking_token ? `${base}/track/${o.tracking_token}` : `${base}/track` };
  const words: BrandWords = { name: brand?.name || '', email: brand?.email || '' };
  const results: TestSend[] = [];
  // one message per order while that mode is active (the switch ON and order_placed_link approved, owner 2026-10-15), else the two as before
  const mode = await currentLinkMode(list, error, Date.now());
  const link = mode.active ? linkInfoFor(list, mode) : null;   // the found template under its real name, else the remembered one
  if (link && !o?.tracking_token) {
    // the same rule as the worker: no link = the message waits, never order_placed
    return { results: [{ kind: 'placed', ok: false, text: '', error: `${o ? `The latest order ${o.order_id}` : 'This brand has no order yet, so nothing'} has no tracking link: the one-message template needs it (order_placed is not sent in this mode). Try again once an order has its link.` }], order: o?.order_id || null, mode: mode.reason };
  }
  for (const kind of (link ? ['placed'] : ['placed', 'tracking']) as Kind[]) {
    const pick = pickTemplate(kind, !!o?.tracking_token, { active: mode.active, noOld: mode.on && mode.approved }, link, approved(list, PLACED_TEMPLATE), approved(list, TRACKING_TEMPLATE));
    if (!pick.template) { results.push({ kind, ok: false, text: '', error: 'Template not approved by Meta yet' }); continue; }
    const tpl = pick.template;
    const params = (pick.params === 'tracking' ? trackingParams(facts, words) : placedParams(facts, words)).slice(0, tpl.vars);
    const r = await sendWhatsAppTemplate(digits, tpl.name, tpl.language, params);
    // its delivery reports are ours, not another app's, and the record shows what Meta reported for it (whatsapp-foreign.ts)
    if (!('error' in r)) await noteTestSent(r.id, digits, { template: tpl.name, language: tpl.language, panel: panelId, panelName, order: o?.order_id || null });
    results.push({ kind, ok: !('error' in r), text: renderTemplate(tpl, params), error: 'error' in r ? r.error : null });
  }
  return { results, order: o?.order_id || null, mode: mode.reason };
}
