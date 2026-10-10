// ── WhatsApp automation: the worker (owner 2026-10-10) ──
// Runs every minute from the existing chat-email-poll cron route (no new crontab line). For every panel the
// Super Admin switched ON (chat_settings `wa_auto:<panel id>`, default OFF): (1) every new order of that panel
// (placed after the switch went on, within 24 hours) gets one row "placed" and one row "tracking" in wa_auto_sends
// (the unique key = never twice); (2) due rows are sent through the approved templates; (3) a failure is tried
// again up to 3 times when Meta's code says it may pass, else it stays Failed with the reason in words. Nothing
// here touches Shopify, the orders or Chat Support; the rules are in whatsapp-auto-rules.ts.
import { query, queryOne } from '@/lib/db';
import { sendWhatsAppTemplate, waConfigured, waDigits } from './whatsapp';
import { listTemplates, renderTemplate, type TemplateInfo } from './whatsapp-templates';
import { templatesAccount } from './whatsapp-settings';
import { loadBrands } from './whatsapp-brands';
import { loadHolidays } from './holidays';
import { isOfficeHours } from '@/lib/office-hours';
import {
  AUTO_PREFIX, BATCH, FRESH_MS, MAX_ATTEMPTS, PLACED_TEMPLATE, RETRY_MS, SKIP, TRACKING_TEMPLATE, TRACKING_TOO_LATE_MS,
  autoKey, autoValue, dueNow, eligibleFrom, parseAuto, placedParams, retryable, trackingDueMs, trackingParams,
  type AutoSetting, type BrandWords, type OrderFacts,
} from './whatsapp-auto-rules';

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
let tplCache: { at: number; list: TemplateInfo[] | null; error: string | null } = { at: 0, list: null, error: null };
export async function templateStates(nowMs = Date.now(), force = false): Promise<{ list: TemplateInfo[] | null; error: string | null }> {
  if (!force && nowMs - tplCache.at < 60_000) return tplCache;
  const account = await templatesAccount().catch(() => '');
  if (!account) { tplCache = { at: nowMs, list: null, error: 'No Messaging account id saved (Setup tab)' }; return tplCache; }
  const r = await listTemplates(account);
  tplCache = 'error' in r ? { at: nowMs, list: null, error: r.error } : { at: nowMs, list: r.value, error: null };
  return tplCache;
}
export const resetTemplateCache = () => { tplCache = { at: 0, list: null, error: null }; };
const approved = (list: TemplateInfo[] | null, name: string) => list?.find((t) => t.name === name && t.status === 'APPROVED') || null;

interface DueRow {
  id: string; order_id: string; kind: Kind; attempts: number; due_at: string;
  gone: boolean; customer_name: string | null; customer_mobile: string | null; created_at: string | null;
  is_cancelled: boolean | null; tracking_status: string | null; delivered_at: string | null;
  tracking_token: string | null; tracking_domain: string | null;
}

export interface AutoRun { idle?: string; panels: number; queued: number; sent: number; failed: number; skipped: number; retried: number }

const TIMED_OUT = 'WhatsApp did not answer in time';   // whatsapp.ts, the 15-second cut
const g = globalThis as unknown as { __waAutoBusy?: boolean; __waAutoInstalled?: boolean | null };

export async function runWaAutomation(nowMs = Date.now()): Promise<AutoRun> {
  const out: AutoRun = { panels: 0, queued: 0, sent: 0, failed: 0, skipped: 0, retried: 0 };
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
    const { list } = await templateStates(nowMs);
    let budget = BATCH;

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

      // 2. due rows, a few a minute: order-placed first; tracking rows only while the office is open and Meta has
      // approved that template (a pile of waiting tracking rows must never hold back today's order-placed messages)
      const trackingCanGo = isOfficeHours(nowMs, holidays) && !!approved(list, TRACKING_TEMPLATE);
      const due = await query<DueRow>(
        `SELECT w.id::text AS id, w.order_id, w.kind, w.attempts, w.due_at,
                (o.order_id IS NULL) AS gone, o.customer_name, o.customer_mobile, o.created_at, o.is_cancelled,
                o.tracking_status, o.delivered_at, o.tracking_token::text AS tracking_token, b.tracking_domain
           FROM wa_auto_sends w
           LEFT JOIN orders o ON o.business_id::text = w.business_id AND o.order_id = w.order_id
           LEFT JOIN businesses b ON b.id = o.business_id
          WHERE w.business_id = $1 AND w.status = 'pending' AND w.due_at <= now() AND (w.kind = 'placed' OR $2::boolean)
          ORDER BY (w.kind = 'placed') DESC, w.due_at ASC LIMIT 40`,
        [panelId, trackingCanGo]
      );
      const brand: BrandWords = brands.get(panelId) || { name: '', email: '' };
      for (const r of due.rows) {
        if (budget <= 0) break;
        const skip = async (why: string) => { await query(`UPDATE wa_auto_sends SET status = 'skipped', error = $2, updated_at = now() WHERE id = $1`, [r.id, why]); out.skipped++; };
        if (r.gone) { await skip(SKIP.gone); continue; }
        const createdMs = r.created_at ? new Date(r.created_at).getTime() : nowMs;
        if (r.is_cancelled) { await skip(SKIP.cancelled); continue; }
        const digits = waDigits(r.customer_mobile);
        if (!digits) { await skip(SKIP.noNumber); continue; }
        if (r.kind === 'placed' && nowMs - createdMs > FRESH_MS) { await skip(SKIP.tooOld); continue; }
        if (r.kind === 'tracking') {
          if (r.delivered_at || /^delivered$/i.test(r.tracking_status || '')) { await skip(SKIP.delivered); continue; }
          if (!r.tracking_token) { await skip(SKIP.noLink); continue; }
          if (nowMs - createdMs > TRACKING_TOO_LATE_MS) { await skip(SKIP.tooOld); continue; }
          if (!dueNow('tracking', new Date(r.due_at).getTime(), nowMs, holidays)) continue;   // office closed: it waits
        }
        const tpl = approved(list, r.kind === 'placed' ? PLACED_TEMPLATE : TRACKING_TEMPLATE);
        if (!tpl) continue;                                                                    // not approved by Meta yet: it waits
        const base = (r.tracking_domain || process.env.TRACKING_BASE_URL || 'https://shiptrack.store').replace(/\/+$/, '');
        const facts: OrderFacts = { orderId: r.order_id, customerName: r.customer_name, trackingLink: r.tracking_token ? `${base}/track/${r.tracking_token}` : null };
        const params = r.kind === 'placed' ? placedParams(facts, brand) : trackingParams(facts, brand);
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
        } else if (res.error === TIMED_OUT) {
          // Meta may have taken it before the answer was lost: never sent again by itself
          await query(`UPDATE wa_auto_sends SET status = 'failed', error = $2, code = NULL, attempts = attempts + 1, updated_at = now() WHERE id = $1`,
            [r.id, 'WhatsApp did not answer in time: it may still have been delivered. Check with the customer before Send again.']);
          out.failed++;
        } else if (retryable(res.code) && r.attempts + 1 < MAX_ATTEMPTS) {
          await query(`UPDATE wa_auto_sends SET attempts = attempts + 1, error = $2, code = $3, due_at = $4, updated_at = now() WHERE id = $1`,
            [r.id, res.error, res.code, new Date(nowMs + RETRY_MS)]);
          out.retried++;
        } else {
          await query(`UPDATE wa_auto_sends SET status = 'failed', error = $2, code = $3, attempts = attempts + 1, updated_at = now() WHERE id = $1`,
            [r.id, res.error, res.code]);
          out.failed++;
        }
      }
    }
    return out;
  } finally {
    g.__waAutoBusy = false;
  }
}

// ── What the Automation tab shows ──
export interface PanelAuto {
  id: string; name: string; enabled: boolean; since: string | null;
  placed: Counts; tracking: Counts; placed24: Counts; tracking24: Counts;
  replied: number;                     // customers who wrote back after one of these messages (distinct numbers)
}
export interface RecentRow {
  id: string; panel: string; order_id: string; kind: Kind; status: string; to: string | null; error: string | null; code: number | null;
  attempts: number; due_at: string; sent_at: string | null;
}
export interface AutoOverview {
  installed: boolean; configured: boolean;
  templates: { placed: string; tracking: string; error: string | null };
  panels: PanelAuto[]; recent: RecentRow[];
}
const maskTo = (n: string | null) => (n ? `••••${n.slice(-4)}` : null);

export async function automationOverview(): Promise<AutoOverview> {
  const panelRows = await query<{ id: string; name: string }>(`SELECT b.id::text AS id, b.name FROM businesses b ORDER BY b.is_default DESC, b.created_at ASC`);
  const settings = await loadAutoSettings().catch(() => new Map<string, AutoSetting>());
  const { list, error } = await templateStates();
  const stateOf = (name: string) => (list ? (list.find((t) => t.name === name)?.status || 'MISSING') : 'UNKNOWN');
  const panels: PanelAuto[] = panelRows.rows.map((p) => {
    const s = settings.get(p.id) || { enabled: false, since: null };
    return { id: p.id, name: p.name, enabled: s.enabled, since: s.since ? new Date(s.since).toISOString() : null, placed: zero(), tracking: zero(), placed24: zero(), tracking24: zero(), replied: 0 };
  });
  let installed = true; let recent: RecentRow[] = [];
  try {
    const c = await query<{ business_id: string; kind: Kind; status: keyof Counts; n: number; n24: number }>(
      `SELECT business_id, kind, status, count(*)::int AS n, (count(*) FILTER (WHERE created_at > now() - interval '24 hours'))::int AS n24 FROM wa_auto_sends GROUP BY 1, 2, 3`);
    for (const row of c.rows) {
      const p = panels.find((x) => x.id === row.business_id); if (!p || !STATUSES.includes(row.status)) continue;
      p[row.kind][row.status] += row.n; p[row.kind === 'placed' ? 'placed24' : 'tracking24'][row.status] += row.n24;
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
    const r = await query<{ id: string; business_id: string; order_id: string; kind: Kind; status: string; to_number: string | null; error: string | null; code: number | null; attempts: number; due_at: string; sent_at: string | null }>(
      `SELECT id::text AS id, business_id, order_id, kind, status, to_number, error, code, attempts, due_at, sent_at FROM wa_auto_sends ORDER BY updated_at DESC LIMIT 30`);
    recent = r.rows.map((x) => ({ id: x.id, panel: panels.find((p) => p.id === x.business_id)?.name || x.business_id, order_id: x.order_id, kind: x.kind, status: x.status, to: maskTo(x.to_number), error: x.error, code: x.code, attempts: x.attempts, due_at: x.due_at, sent_at: x.sent_at }));
  } catch (e) {
    if (missingTable(e)) installed = false; else console.error('[wa-auto] overview:', (e as Error).message);
  }
  return { installed, configured: waConfigured(), templates: { placed: stateOf(PLACED_TEMPLATE), tracking: stateOf(TRACKING_TEMPLATE), error }, panels, recent };
}

// "Send again" on a Failed row (the run still refuses an order that is too old / cancelled).
export async function retryFailed(id: string): Promise<boolean> {
  const r = await query(`UPDATE wa_auto_sends SET status = 'pending', attempts = 0, error = NULL, code = NULL, due_at = now(), updated_at = now() WHERE id = $1 AND status = 'failed'`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function panelExists(id: string): Promise<boolean> {
  return !!(await queryOne(`SELECT 1 FROM businesses WHERE id::text = $1`, [id]));
}

// "Send a test to my number" (owner 2026-10-10: "har cheez check kario"): both automation messages exactly as a
// customer of this brand would get them, filled from the brand's latest order (its order id and real tracking link)
// with the name typed, to the number typed. Nothing is recorded in wa_auto_sends and no customer is messaged.
export interface TestSend { kind: Kind; ok: boolean; text: string; error: string | null }
export async function sendAutomationTest(panelId: string, to: string, name: string): Promise<{ results: TestSend[]; order: string | null } | { error: string }> {
  const digits = waDigits(to);
  if (!digits) return { error: 'Type the WhatsApp number (10 digits = India)' };
  if (!waConfigured()) return { error: 'WhatsApp is not set up on the server (token / phone number id)' };
  const { list, error } = await templateStates(Date.now(), true);
  if (!list) return { error: error || 'Could not read the templates' };
  const brand = (await loadBrands().catch(() => [])).find((b) => b.id === panelId);
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
  for (const kind of ['placed', 'tracking'] as const) {
    const tpl = approved(list, kind === 'placed' ? PLACED_TEMPLATE : TRACKING_TEMPLATE);
    if (!tpl) { results.push({ kind, ok: false, text: '', error: 'Template not approved by Meta yet' }); continue; }
    const params = (kind === 'placed' ? placedParams(facts, words) : trackingParams(facts, words)).slice(0, tpl.vars);
    const r = await sendWhatsAppTemplate(digits, tpl.name, tpl.language, params);
    results.push({ kind, ok: !('error' in r), text: renderTemplate(tpl, params), error: 'error' in r ? r.error : null });
  }
  return { results, order: o?.order_id || null };
}
