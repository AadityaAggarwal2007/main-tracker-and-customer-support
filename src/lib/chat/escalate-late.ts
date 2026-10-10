// ── 30 minutes without a reply: the chat goes to the Manager (owner 2026-10-10, step 4 of the Manager-panel plan:
// "agar koi support team member adhe ghante se customer ko reply nahi deta, toh wo chat seedhe Manager Panel par chali
// jaye aur team ko bottom message chala jaye"; answer: the chat moves to the Manager) ──
// Every minute (the chat-email-poll cron) during office hours: a chat held by a team member (not the Manager, not the
// Super Admin), not Closed, not a Refund / Ship again chat, whose customer has been waiting (the inbox's own waiting
// rule: "ok / thanks" never counts) for 30+ office minutes since max(their message, when the member got the chat, 10:00
// today) goes to the Manager (pickManager: one who is around, the fewest open chats; none = the Super Admin), status as
// a transfer gives it (a verified customer: Needs you). One 'transfer' event by the system, reason 'no_reply_30', with
// who had it and how long the customer waited: the inbox's red bar for the whole team reads these (lateAlerts). The
// customer is told nothing. Moved only if the holder is still the same (WHERE assigned_to = the holder). Never throws.

import { query, withTransaction } from '@/lib/db';
import { teamEntries } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { isOfficeHours, todayOpenMs } from '@/lib/office-hours';
import { loadHolidays } from './holidays';
import { WAITING_LATERAL, WAITING_SINCE_SQL } from './waiting-sql';
import { OWNER_KEY, transferStatus } from './team-rules';
import { isKnownCustomer, logChatEvent, nameOfKey, pickManager, setSystemActor } from './team-routing';

export const NO_REPLY_MIN = 30;
const g = globalThis as unknown as { __lateBusy?: boolean };

export interface LateRun { idle?: string; moved: number; checked: number }

export async function runLateEscalation(now = Date.now()): Promise<LateRun> {
  const out: LateRun = { moved: 0, checked: 0 };
  if (g.__lateBusy) return { ...out, idle: 'busy' };
  g.__lateBusy = true;
  try {
    const holidays = await loadHolidays(now).catch(() => [] as string[]);
    if (!isOfficeHours(now, holidays)) return { ...out, idle: 'office_closed' };
    // The clock starts at the latest of: the customer's message, the member getting the chat, today's 10:00.
    const cutoff = new Date(now - NO_REPLY_MIN * 60_000).toISOString();
    const opened = new Date(todayOpenMs(now)).toISOString();
    const rows = await query<{
      id: string; site_id: string; status: string; case_kind: string | null; assigned_to: string; panel: string | null;
      verified_order_id: string | null; phone_match_order_id: string | null; waited_from: string;
    }>(
      `SELECT x.* FROM (
         SELECT c.id, c.site_id, c.status, c.case_kind, c.assigned_to, s.tracker_business_id::text AS panel,
                c.verified_order_id, c.phone_match_order_id,
                GREATEST(${WAITING_SINCE_SQL}, COALESCE(c.assigned_at, 'epoch'::timestamptz), $2::timestamptz) AS waited_from,
                ${WAITING_SINCE_SQL} AS waiting_since
           FROM conversations c
           JOIN sites s ON s.id = c.site_id
           ${WAITING_LATERAL}
          WHERE c.assigned_to IS NOT NULL AND c.assigned_to <> '${OWNER_KEY}' AND c.status <> 'resolved'
            AND c.merged_into IS NULL AND c.case_kind IS NULL) x
        WHERE x.waiting_since IS NOT NULL AND x.waited_from <= $1::timestamptz
        ORDER BY x.waited_from ASC LIMIT 40`,
      [cutoff, opened]
    );
    // Only a plain team member's chats: the Manager's (team.lead) and the Super Admin's are not moved.
    const leads = new Set(teamEntries().filter((e) => can(e, 'team.lead')).map((e) => e.id));
    for (const c of rows.rows) {
      if (leads.has(c.assigned_to)) continue;
      out.checked++;
      const waited = Math.max(NO_REPLY_MIN, Math.floor((now - Date.parse(c.waited_from)) / 60_000));
      const moved = await withTransaction(async (client) => {
        const to = await pickManager(client, c.panel, now);
        if (to === c.assigned_to) return false;
        const status = transferStatus({ status: c.status, case_kind: c.case_kind, known: isKnownCustomer(c) }, false) ?? c.status;
        await setSystemActor(client, 'No reply in 30 min', 'no_reply_30');
        const r = await client.query(
          `UPDATE conversations SET assigned_to = $3::text, assigned_at = now(), status = $4, auto_closed_at = NULL, updated_at = now()
            WHERE id = $1 AND assigned_to = $2 AND status <> 'resolved' RETURNING id`,
          [c.id, c.assigned_to, to, status]
        );
        if (!r.rows.length) return false;
        await logChatEvent(client, 'system', {
          conversationId: c.id, siteId: c.site_id, kind: 'transfer', fromOwner: c.assigned_to, toOwner: to,
          fromStatus: c.status, toStatus: status, reason: 'no_reply_30',
          meta: { waited_min: waited, from_name: nameOfKey(c.assigned_to) ?? 'a team member', to_name: to === OWNER_KEY ? 'Super Admin' : (nameOfKey(to) ?? 'the Manager') },
        });
        return true;
      }).catch((e) => { console.error('[late] move:', (e as Error).message); return false; });
      if (moved) { out.moved++; console.log(`[late] conv ${c.id}: no reply for ${waited} min, moved to the Manager`); }
    }
    return out;
  } catch (e) {
    console.error('[late] run:', (e as Error).message);
    return { ...out, idle: 'error' };
  } finally {
    g.__lateBusy = false;
  }
}

// The red bar in every team member's inbox: the chats moved in the last 2 hours, in the login's panels.
export interface LateAlert { id: string; conversation_id: string; at: string; from_name: string; to_name: string; waited_min: number; customer: string | null }
export async function lateAlerts(panels: string[] | null): Promise<LateAlert[]> {
  try {
    const r = await query<{ id: string; conversation_id: string; at: string; meta: Record<string, unknown> | null; customer: string | null }>(
      `SELECT e.id::text AS id, e.conversation_id, e.created_at AS at, e.meta, c.visitor_name AS customer
         FROM chat_events e
         JOIN conversations c ON c.id = e.conversation_id
         JOIN sites s ON s.id = c.site_id
        WHERE e.reason = 'no_reply_30' AND e.created_at > now() - interval '2 hours'
          AND ($1::text[] IS NULL OR s.tracker_business_id::text = ANY($1::text[]))
        ORDER BY e.created_at DESC LIMIT 10`,
      [panels]
    );
    return r.rows.map((x) => ({
      id: x.id, conversation_id: x.conversation_id, at: new Date(x.at).toISOString(),
      from_name: String(x.meta?.from_name ?? 'A team member'), to_name: String(x.meta?.to_name ?? 'the Manager'),
      waited_min: Number(x.meta?.waited_min ?? NO_REPLY_MIN), customer: x.customer || null,
    }));
  } catch (e) {
    if ((e as { code?: string })?.code !== '42P01') console.error('[late] alerts:', (e as Error).message);
    return [];
  }
}
