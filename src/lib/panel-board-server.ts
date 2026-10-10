import { query } from '@/lib/db';
import { WAITING_LATERAL, WAITING_SINCE_SQL } from '@/lib/chat/waiting-sql';
import { WAITING_OVERDUE_HOURS } from '@/lib/chat/waiting';
import { chargebackKind } from '@/lib/chargeback/parse';
import { getMailboxStatus } from '@/lib/chat/mailbox-status';
import { aiHealth, AI_REASON_TEXT, type AiHealth } from '@/lib/chat/ai-health';
import { loadHolidays } from '@/lib/chat/holidays';
import { loadWaHealth } from '@/lib/chat/whatsapp-health';
import type { WaHealth } from '@/lib/chat/whatsapp-health-rules';
import { isOfficeHours, istDate } from '@/lib/office-hours';
import { loadCommon, savedMode } from '@/lib/chat/common-setup';
import { commonReady, modeFor } from '@/lib/chat/common-setup-rules';
import type { GmailStatus, PanelStats } from './panel-board';

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

  const sites = by(await safe('sites', async () => (await query<{ site_id?: string; business_id: string; ai_enabled: boolean; has_prompt: boolean; support_gmail: number; email_ids: string[] | null }>(
    `SELECT s.id::text AS site_id, s.tracker_business_id::text AS business_id, s.ai_enabled, COALESCE(length(btrim(s.system_prompt)), 0) > 0 AS has_prompt,
            (SELECT count(*) FROM site_emails e WHERE e.site_id = s.id)::int AS support_gmail,
            (SELECT array_agg(e.id::text ORDER BY e.created_at) FROM site_emails e WHERE e.site_id = s.id) AS email_ids
       FROM sites s WHERE s.tracker_business_id::text = ANY($1::text[])`, [ids])).rows, []));

  // Step 7: a panel on the All panels setup has a prompt even with none of its own.
  const common = commonReady(await loadCommon());
  for (const s of Array.from(sites.values())) {
    if (s.site_id && !s.has_prompt && common && modeFor(await savedMode(s.site_id), null, true) === 'common') s.has_prompt = true;
  }

  // Today in India: customers who wrote, team replies, Chikki's replies.
  const today = by(await safe('today', async () => (await query<{ business_id: string; chats: string; team: string }>(
    `SELECT s.tracker_business_id::text AS business_id,
            count(DISTINCT m.conversation_id) FILTER (WHERE m.sender = 'visitor') AS chats,
            count(*) FILTER (WHERE m.sender = 'agent') AS team
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN sites s ON s.id = c.site_id
      WHERE s.tracker_business_id::text = ANY($1::text[]) AND m.created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
        AND m.deleted_at IS NULL
      GROUP BY s.tracker_business_id`, [ids])).rows, []));
  const chikki = by(await safe('chikki', async () => (await query<{ business_id: string; n: string }>(
    `SELECT s.tracker_business_id::text AS business_id, count(*) AS n
       FROM chikki_runs r JOIN sites s ON s.id = r.site_id
      WHERE s.tracker_business_id::text = ANY($1::text[]) AND r.created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
      GROUP BY s.tracker_business_id`, [ids])).rows, []));

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
                               AND estimated_delivery >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 14 AND COALESCE(is_cancelled, false) = false
                               AND tracking_status <> 'Delivered' AND tracking_status !~* 'cancel|rto|return') AS late
       FROM orders WHERE business_id::text = ANY($1::text[]) GROUP BY business_id`, [ids])).rows, []));

  // The chargeback Gmail's sign-in status is kept under the first-connected panel's row of that address (poll.ts).
  const cbBoxes = by(await safe('chargeback boxes', async () => (await query<{ business_id: string; whatsapp: string | null; status_id: string }>(
    `SELECT m.business_id::text AS business_id, (SELECT whatsapp_number FROM panel_chargeback p WHERE p.business_id = m.business_id) AS whatsapp,
            (SELECT f.id::text FROM chargeback_mailboxes f WHERE lower(f.email) = lower(m.email) ORDER BY f.created_at LIMIT 1) AS status_id
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
    const s = sites.get(p.id), c = chats.get(p.id), o = orders.get(p.id), cb = cbBoxes.get(p.id), t = today.get(p.id);
    const sup = gmailStatus((s?.email_ids ?? []).map(id => getMailboxStatus(id)));
    const cbs = cb ? gmailStatus([getMailboxStatus(`cb:${cb.status_id}`)]) : null;
    return {
      id: p.id, name: p.name,
      needsYou: num(c?.needs_you), waiting: num(c?.waiting), overdue: num(c?.overdue), emailWaiting: num(c?.email_waiting),
      refundCases: num(c?.refund_cases), reshipToShip: num(c?.reship_to_ship),
      chargebacksOpen: superAdmin ? (cbOpen.get(p.id) ?? 0) : null,
      refundRequestsNew: null,
      chatsToday: num(t?.chats), teamRepliesToday: num(t?.team), chikkiToday: num(chikki.get(p.id)?.n),
      ordersToday: num(o?.today), lateOrders: num(o?.late),
      aiOn: s ? s.ai_enabled !== false : null, hasPrompt: s?.has_prompt === true,
      supportGmail: num(s?.support_gmail) > 0, chargebackGmail: !!cb, whatsapp: !!(cb && cb.whatsapp && cb.whatsapp.trim()),
      supportGmailStatus: num(s?.support_gmail) > 0 ? sup.status : null, supportGmailError: sup.error,
      chargebackGmailStatus: cbs ? cbs.status : null, chargebackGmailError: cbs ? cbs.error : null,
    };
  });
}

// One word for a panel's Gmail(s): 'error' when any sign-in failed last time, 'ok' when every known one worked,
// 'unknown' before the poller's first look after a restart.
function gmailStatus(list: (ReturnType<typeof getMailboxStatus>)[]): { status: GmailStatus; error: string | null } {
  const known = list.filter((x): x is NonNullable<typeof x> => !!x);
  const bad = known.find(x => !x.ok);
  if (bad) return { status: 'error', error: bad.error };
  return { status: known.length === list.length && list.length > 0 ? 'ok' : 'unknown', error: null };
}

// The day itself: India's date, whether the office is open now and who is in ShipTrack right now (seen in the
// last 5 minutes, like the inbox's team list). Names only; nothing else about a person.
export interface BoardAi extends AiHealth { text: string | null }
export async function loadBoardDay(superAdmin = false): Promise<{ date: string; officeOpen: boolean; online: string[]; ai: BoardAi; whatsapp: WaHealth | null }> {
  const now = Date.now();
  // Chikki's health (ai-health.ts): a red banner while every model fails (credits, key, rate limit, timeouts).
  const h = aiHealth(now);
  const ai: BoardAi = { ...h, text: h.reason ? AI_REASON_TEXT[h.reason] : null };
  const holidays = await loadHolidays(now).catch(() => [] as string[]);
  const online = await safe('presence', async () => (await query<{ name: string }>(
    `SELECT COALESCE(u.display_name, u.username, CASE WHEN p.actor = 'owner' THEN 'Super Admin' END) AS name
       FROM staff_presence p LEFT JOIN team_users u ON u.id::text = p.actor
      WHERE p.last_seen_at > now() - interval '5 minutes' ORDER BY 1`)).rows.map(r => r.name).filter(Boolean), []);
  // The WhatsApp number's health (whatsapp-health.ts): the Super Admin's only, like the WhatsApp tab.
  const whatsapp = superAdmin ? await loadWaHealth(now).catch((e) => { console.error('[panel-board] whatsapp:', (e as Error).message); return null; }) : null;
  return { date: istDate(now), officeOpen: isOfficeHours(now, holidays), online, ai, whatsapp };
}
