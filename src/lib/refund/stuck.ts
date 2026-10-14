// ── Promises that got stuck: the counts and the once-a-day WhatsApp (owner 2026-10-14; rules in stuck-rules.ts) ──
// In the refund area because it reads the refund tables (refund-isolation I2): the panel board and the Chat Support
// bar get the numbers from GET /api/refunds/counts?stuck=1, never from the tables. Read only, except the one
// chat_settings row that claims "today's alert was sent" (both PM2 processes run the minute cron; the first one sends).
// Customers are told nothing.
import { query, queryOne } from '@/lib/db';
import { isOfficeHours } from '@/lib/office-hours';
import { loadHolidays } from '@/lib/chat/holidays';
import { sendWhatsAppTemplate, waConfigured } from '@/lib/chat/whatsapp';
import { listTemplates } from '@/lib/chat/whatsapp-templates';
import { alertTo, extraAlertTo, templatesAccount } from '@/lib/chat/whatsapp-settings';
import { STUCK_DAYS, alertTimeOk, emptyStuck, istDay, stuckAlertText, stuckTotal, type StuckCounts } from './stuck-rules';

const missing = (e: unknown) => ['42P01', '42703'].includes((e as { code?: string })?.code || '');

// Per panel id. scope = the login's panels (null = every panel). Each read in its own try: a missing table counts 0.
export async function loadStuck(scope: string[] | null): Promise<Record<string, StuckCounts>> {
  const out: Record<string, StuckCounts> = {};
  const at = (id: string) => (out[id] ??= emptyStuck());
  const old = `now() - interval '${STUCK_DAYS} days'`;
  try {
    const r = await query<{ panel: string; no_form: string; reship: string }>(
      `SELECT s.tracker_business_id::text AS panel,
              count(*) FILTER (WHERE c.case_kind = 'refund'
                AND NOT EXISTS (SELECT 1 FROM refund_links l WHERE l.business_id = s.tracker_business_id::text AND l.order_id = c.case_order_id)
                AND NOT EXISTS (SELECT 1 FROM refund_requests q WHERE q.business_id = s.tracker_business_id::text AND q.order_id = c.case_order_id)) AS no_form,
              count(*) FILTER (WHERE c.case_kind = 'reship' AND c.reshipped_at IS NULL) AS reship
         FROM conversations c JOIN sites s ON s.id = c.site_id
        WHERE c.case_kind IN ('refund', 'reship') AND c.case_marked_at < ${old}
          AND c.status <> 'resolved' AND c.merged_into IS NULL AND c.source <> 'whatsapp'
          AND s.tracker_business_id IS NOT NULL AND ($1::text[] IS NULL OR s.tracker_business_id::text = ANY($1::text[]))
        GROUP BY s.tracker_business_id`, [scope]);
    for (const row of r.rows) { const p = at(row.panel); p.refundNoForm = Number(row.no_form) || 0; p.reshipNotSent = Number(row.reship) || 0; }
  } catch (e) { if (!missing(e)) console.error('[stuck] chats:', (e as Error).message); }
  try {
    const r = await query<{ panel: string; n: string }>(
      `SELECT business_id AS panel, count(*) AS n FROM refund_requests
        WHERE status IN ('new', 'approved') AND status_at < ${old} AND ($1::text[] IS NULL OR business_id = ANY($1::text[]))
        GROUP BY business_id`, [scope]);
    for (const row of r.rows) at(row.panel).refundWaiting = Number(row.n) || 0;
  } catch (e) { if (!missing(e)) console.error('[stuck] requests:', (e as Error).message); }
  return out;
}

// The once-a-day WhatsApp to the alert numbers (WhatsApp > Setup: the owner's number + up to 5 more), through the
// approved shiptrack_alert template. Office days only, from 10:30 India time; nothing stuck = nothing sent. Never throws.
let busy = false;
export async function runStuckAlert(now = Date.now()): Promise<number> {
  if (busy) return 0;
  busy = true;
  try {
    if (!alertTimeOk(now) || !waConfigured()) return 0;
    if (!isOfficeHours(now, await loadHolidays(now))) return 0;
    const key = `stuck_alert:${istDay(now)}`;
    const done = await queryOne<{ key: string }>(`SELECT key FROM chat_settings WHERE key = $1`, [key]).catch(() => null);
    if (done) return 0;
    const counts = await loadStuck(null);
    if (!Object.values(counts).some((c) => stuckTotal(c) > 0)) return 0;
    const names = await query<{ id: string; name: string }>(`SELECT id::text AS id, name FROM businesses WHERE id::text = ANY($1::text[])`, [Object.keys(counts)])
      .then((r) => Object.fromEntries(r.rows.map((x) => [x.id, x.name]))).catch(() => ({} as Record<string, string>));
    const text = stuckAlertText(Object.entries(counts).map(([id, c]) => ({ name: names[id] || 'A panel', counts: c })));
    if (!text) return 0;
    const to = Array.from(new Set([await alertTo(), ...await extraAlertTo()].filter(Boolean)));
    if (!to.length) return 0;
    const list = await listTemplates(await templatesAccount());
    const tpl = list.ok ? list.value.find((t) => t.name === 'shiptrack_alert' && t.status === 'APPROVED') : null;
    if (!tpl) return 0;
    // Claimed just before sending: one alert a day, whichever process gets here first.
    const claim = await queryOne<{ key: string }>(
      `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, JSON.stringify({ at: new Date(now).toISOString() })]).catch(() => null);
    if (!claim) return 0;
    let sent = 0;
    for (const n of to) {
      const r = await sendWhatsAppTemplate(n, tpl.name, tpl.language, [text]);
      if ('error' in r) console.error('[stuck] alert not sent:', r.error); else sent++;
    }
    console.log(`[stuck] daily alert sent to ${sent} of ${to.length} number(s)`);
    return sent;
  } catch (e) {
    console.error('[stuck] alert:', (e as Error).message);
    return 0;
  } finally { busy = false; }
}
