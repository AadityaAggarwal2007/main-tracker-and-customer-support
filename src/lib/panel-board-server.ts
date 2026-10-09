import { query } from '@/lib/db';
import { WAITING_LATERAL, WAITING_SINCE_SQL } from '@/lib/chat/waiting-sql';
import { WAITING_OVERDUE_HOURS } from '@/lib/chat/waiting';
import { chargebackKind } from '@/lib/chargeback/parse';
import type { PanelStats } from './panel-board';

// ── The panel board's numbers (owner 2026-10-09) ──────────────────────────────────────────────
// One read per table, every panel at once, each in its own try: a table that is not installed yet or a read
// that fails only zeroes that column; the board itself always answers. Chat numbers follow the inbox's own
// rules (one row per customer, the waiting SQL, Refund / Ship again marks). The Super Admin's chargeback number is
// null for a team member, who never sees that screen.

const missing = (e: unknown) => (e as { code?: string })?.code === '42P01' || (e as { code?: string })?.code === '42703';
async function safe<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e) { if (!missing(e)) console.error(`[panel-board] ${what}:`, (e as Error).message); return fallback; }
}
const num = (v: unknown) => Number(v ?? 0) || 0;

export async function loadPanelBoard(businessIds: string[] | null, superAdmin: boolean): Promise<PanelStats[]> {
  const scope = businessIds && businessIds.length > 0 ? businessIds : null;
  const panels = (await query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM businesses WHERE ($1::text[] IS NULL OR id::text = ANY($1::text[])) ORDER BY is_default DESC, created_at`, [scope])).rows;
  if (panels.length === 0) return [];
  const ids = panels.map(p => p.id);
  const by = <T extends { business_id: string }>(rows: T[]) => new Map(rows.map(r => [String(r.business_id), r]));

  const sites = by(await safe('sites', async () => (await query<{ business_id: string; ai_enabled: boolean; has_prompt: boolean; support_gmail: number }>(
    `SELECT s.tracker_business_id::text AS business_id, s.ai_enabled, COALESCE(length(btrim(s.system_prompt)), 0) > 0 AS has_prompt,
            (SELECT count(*) FROM site_emails e WHERE e.site_id = s.id)::int AS support_gmail
       FROM sites s WHERE s.tracker_business_id::text = ANY($1::text[])`, [ids])).rows, []));

  const chats = by(await safe('chats', async () => (await query<{ business_id: string; needs_you: string; email_waiting: string; waiting: string; overdue: string; refund_cases: string; reship_to_ship: string }>(
    `SELECT s.tracker_business_id::text AS business_id,
            count(DISTINCT CASE WHEN c.status = 'human_needed' AND (c.case_kind IS NULL OR c.case_kind = 'reship')
                                THEN COALESCE('k:' || c.site_id || ':' || NULLIF(CASE WHEN c.source = 'chat' THEN c.customer_key END, ''), 'c:' || c.id) END) AS needs_you,
            count(*) FILTER (WHERE c.status = 'human_needed' AND (c.case_kind IS NULL OR c.case_kind = 'reship') AND c.source = 'email') AS email_waiting,
            count(DISTINCT CASE WHEN (${WAITING_SINCE_SQL}) IS NOT NULL
                                THEN COALESCE('k:' || c.site_id || ':' || NULLIF(CASE WHEN c.source = 'chat' THEN c.customer_key END, ''), 'c:' || c.id) END) AS waiting,
            count(DISTINCT CASE WHEN (${WAITING_SINCE_SQL}) < now() - interval '${WAITING_OVERDUE_HOURS} hours'
                                THEN COALESCE('k:' || c.site_id || ':' || NULLIF(CASE WHEN c.source = 'chat' THEN c.customer_key END, ''), 'c:' || c.id) END) AS overdue,
            count(*) FILTER (WHERE c.case_kind = 'refund' AND c.status <> 'resolved') AS refund_cases,
            count(*) FILTER (WHERE c.case_kind = 'reship' AND c.status <> 'resolved' AND c.reshipped_at IS NULL) AS reship_to_ship
       FROM conversations c JOIN sites s ON s.id = c.site_id
       ${WAITING_LATERAL}
      WHERE s.tracker_business_id::text = ANY($1::text[]) AND c.merged_into IS NULL AND c.status <> 'resolved'
      GROUP BY s.tracker_business_id`, [ids])).rows, []));

  const orders = by(await safe('orders', async () => (await query<{ business_id: string; today: string; late: string }>(
    `SELECT business_id::text AS business_id,
            count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') AS today,
            count(*) FILTER (WHERE estimated_delivery IS NOT NULL AND estimated_delivery < (now() AT TIME ZONE 'Asia/Kolkata')::date
                               AND created_at >= now() - interval '60 days' AND COALESCE(is_cancelled, false) = false
                               AND tracking_status <> 'Delivered' AND tracking_status !~* 'cancel|rto|return') AS late
       FROM orders WHERE business_id::text = ANY($1::text[]) GROUP BY business_id`, [ids])).rows, []));

  const cbBoxes = by(await safe('chargeback boxes', async () => (await query<{ business_id: string; whatsapp: string | null }>(
    `SELECT m.business_id::text AS business_id, (SELECT whatsapp_number FROM panel_chargeback p WHERE p.business_id = m.business_id) AS whatsapp
       FROM chargeback_mailboxes m WHERE m.business_id::text = ANY($1::text[])`, [ids])).rows, []));

  // Super Admin only: open chargebacks (by the words, like the Chargebacks tab). The refund requests to decide are
  // NOT read here: the refund tables stay inside src/lib/refund (refund-isolation I2); the board's screen asks
  // GET /api/refunds/counts?byPanel=1 and fills refundRequestsNew itself.
  const cbOpen = new Map<string, number>();
  if (superAdmin) {
    for (const a of await safe('chargebacks', async () => (await query<{ business_id: string; subject: string; snippet: string }>(
      `SELECT business_id::text AS business_id, subject, snippet FROM chargeback_alerts WHERE status <> 'done' AND business_id::text = ANY($1::text[])`, [ids])).rows, [])) {
      if (chargebackKind(a.subject, a.snippet) === 'chargeback') cbOpen.set(a.business_id, (cbOpen.get(a.business_id) ?? 0) + 1);
    }
  }

  return panels.map(p => {
    const s = sites.get(p.id), c = chats.get(p.id), o = orders.get(p.id), cb = cbBoxes.get(p.id);
    return {
      id: p.id, name: p.name,
      needsYou: num(c?.needs_you), waiting: num(c?.waiting), overdue: num(c?.overdue), emailWaiting: num(c?.email_waiting),
      refundCases: num(c?.refund_cases), reshipToShip: num(c?.reship_to_ship),
      chargebacksOpen: superAdmin ? (cbOpen.get(p.id) ?? 0) : null,
      refundRequestsNew: null,
      ordersToday: num(o?.today), lateOrders: num(o?.late),
      aiOn: s ? s.ai_enabled !== false : null, hasPrompt: s?.has_prompt === true,
      supportGmail: num(s?.support_gmail) > 0, chargebackGmail: !!cb, whatsapp: !!(cb && cb.whatsapp && cb.whatsapp.trim()),
    };
  });
}
