// ── Chargeback Shield, step 2: Critical -> the Manager, the team's red bar, a WhatsApp to the owner and the Manager ──
// Owner 2026-10-10: "saari chat Sunny ke paas chali jaye ya humein pata chal jaye Super Admin mein bhi".
// From the minute cron (chat-email-poll), not awaited, at most once every 5 minutes per process, one run at a time:
// 1. Every Critical order on the risk list (risk.ts, the Super Admin's whole scope) whose customer's open chat is held by
//    a team member or nobody goes to the Manager (pickManager: one who is around, the fewest open chats; none = the
//    Super Admin), during office hours only, with the status a transfer gives (a verified customer: Needs you; a Refund /
//    Ship again chat keeps its status). One 'transfer' event by the system, reason 'chargeback_risk' (score, order, the
//    top reasons): the inbox's red bar for the whole team reads these (escalate-late.ts lateAlerts). A chat already moved
//    for this reason in the last 7 days is never pulled again (the Manager may hand it back on purpose). Moved only if
//    the holder is still the same. A chat the Manager or the Super Admin holds stays where it is.
// 2. ONE WhatsApp (approved template "shiptrack_alert") per Critical order, ever, to the owner's alert number and the
//    extra alert numbers (WhatsApp > Setup: Sunny, the team; up to 5), 09:00-22:00 India time; claimed in chat_settings first (`risk_alert:<panel>|<order>`),
//    so the two PM2 processes never send it twice. Nothing is sent to the customer; nothing is refunded. Never throws.
import { queryOne, withTransaction } from '@/lib/db';
import { teamEntries, teamLoaded } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { isOfficeHours } from '@/lib/office-hours';
import { loadHolidays } from '@/lib/chat/holidays';
import { OWNER_KEY, transferStatus } from '@/lib/chat/team-rules';
import { isKnownCustomer, logChatEvent, nameOfKey, pickManager, setSystemActor } from '@/lib/chat/team-routing';
import { sendWhatsAppTemplate, waConfigured } from '@/lib/chat/whatsapp';
import { listTemplates } from '@/lib/chat/whatsapp-templates';
import { alertTo, extraAlertTo, templatesAccount } from '@/lib/chat/whatsapp-settings';
import { loadRiskList, type RiskItem } from './risk';
import { riskAlertText, alertHourOk } from './risk-rules';

export const RISK_REASON = 'chargeback_risk';
const EVERY_MS = 5 * 60_000;
const g = globalThis as unknown as { __riskEscBusy?: boolean; __riskEscAt?: number };

export interface RiskRun { idle?: string; critical: number; moved: number; alerted: number }

export async function runRiskEscalation(now = Date.now(), force = false): Promise<RiskRun> {
  const out: RiskRun = { critical: 0, moved: 0, alerted: 0 };
  if (g.__riskEscBusy) return { ...out, idle: 'busy' };
  if (!force && g.__riskEscAt && now - g.__riskEscAt < EVERY_MS) return { ...out, idle: 'soon' };
  if (!teamLoaded()) return { ...out, idle: 'starting' };
  g.__riskEscBusy = true; g.__riskEscAt = now;
  try {
    const list = await loadRiskList(null, now);
    const critical = list.items.filter((i) => i.level === 'critical');
    out.critical = critical.length;
    if (!critical.length) return out;
    const holidays = await loadHolidays(now).catch(() => [] as string[]);
    if (isOfficeHours(now, holidays)) {
      const leads = new Set(teamEntries().filter((e) => can(e, 'team.lead')).map((e) => e.id));
      for (const item of critical) if (item.chatId && await moveToManager(item, leads, now)) out.moved++;
    }
    if (alertHourOk(now)) out.alerted = await sendAlerts(critical);
    return out;
  } catch (e) {
    console.error('[risk] escalate:', (e as Error).message);
    return { ...out, idle: 'error' };
  } finally {
    g.__riskEscBusy = false;
  }
}

async function moveToManager(item: RiskItem, leads: Set<string>, now: number): Promise<boolean> {
  return withTransaction(async (client) => {
    const c = (await client.query<{
      id: string; site_id: string; status: string; case_kind: string | null; assigned_to: string | null; panel: string | null;
      verified_order_id: string | null; phone_match_order_id: string | null; merged_into: string | null;
    }>(
      `SELECT c.id, c.site_id, c.status, c.case_kind, c.assigned_to, s.tracker_business_id::text AS panel,
              c.verified_order_id, c.phone_match_order_id, c.merged_into
         FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = $1 FOR NO KEY UPDATE OF c`, [item.chatId])).rows[0];
    if (!c || c.status === 'resolved' || c.merged_into) return false;
    if (c.assigned_to === OWNER_KEY || (c.assigned_to && leads.has(c.assigned_to))) return false;
    const before = await client.query(
      `SELECT 1 FROM chat_events WHERE conversation_id = $1 AND reason = $2 AND created_at > now() - interval '7 days' LIMIT 1`, [c.id, RISK_REASON]);
    if (before.rows.length) return false;
    const to = await pickManager(client, c.panel, now);
    if (to === c.assigned_to) return false;
    const status = transferStatus({ status: c.status, case_kind: c.case_kind, known: isKnownCustomer(c) }, false) ?? c.status;
    await setSystemActor(client, 'Chargeback risk', RISK_REASON);
    const r = await client.query(
      `UPDATE conversations SET assigned_to = $3::text, assigned_at = now(), status = $4, auto_closed_at = NULL, updated_at = now()
        WHERE id = $1 AND assigned_to IS NOT DISTINCT FROM $2::text AND status <> 'resolved' RETURNING id`,
      [c.id, c.assigned_to, to, status]);
    if (!r.rows.length) return false;
    await logChatEvent(client, 'system', {
      conversationId: c.id, siteId: c.site_id, kind: 'transfer', fromOwner: c.assigned_to, toOwner: to,
      fromStatus: c.status, toStatus: status, reason: RISK_REASON,
      meta: {
        score: item.score, order: item.orderId, reasons: item.signals.filter((s) => s.points > 0).slice(0, 2).map((s) => s.text),
        from_name: c.assigned_to ? (nameOfKey(c.assigned_to) ?? 'a team member') : 'nobody',
        to_name: to === OWNER_KEY ? 'Super Admin' : (nameOfKey(to) ?? 'the Manager'),
      },
    });
    console.log(`[risk] conv ${c.id}: Critical chargeback risk (${item.score}), moved to the Manager`);
    return true;
  }).catch((e) => { console.error('[risk] move:', (e as Error).message); return false; });
}

async function sendAlerts(items: RiskItem[]): Promise<number> {
  if (!waConfigured()) return 0;
  const to = Array.from(new Set([await alertTo(), ...await extraAlertTo()].filter(Boolean)));
  if (!to.length) return 0;
  const list = await listTemplates(await templatesAccount());
  const tpl = list.ok ? list.value.find((t) => t.name === 'shiptrack_alert' && t.status === 'APPROVED') : null;
  if (!tpl) return 0;
  let sent = 0;
  for (const item of items.slice(0, 10)) {
    // Claimed first: one alert per order, whichever process gets here first.
    const claim = await queryOne<{ key: string }>(
      `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [`risk_alert:${item.businessId}|${item.orderId}`, JSON.stringify({ score: item.score, at: new Date().toISOString() })]).catch(() => null);
    if (!claim) continue;
    const text = riskAlertText(item);
    for (const n of to) {
      const r = await sendWhatsAppTemplate(n, tpl.name, tpl.language, [text]);
      if ('error' in r) console.error('[risk] alert not sent:', r.error); else sent++;
    }
  }
  return sent;
}
