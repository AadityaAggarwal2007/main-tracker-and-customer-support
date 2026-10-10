// ── Chats go to the team by themselves (owner 2026-10-10, step 3 of the Manager-panel plan) ──
// Every minute (the chat-email-poll cron, like the WhatsApp automation) the open chats that need a PERSON and that
// nobody holds are given out to the team members on duty (auto-assign-rules.ts onDuty: logged in today, around,
// office open), the one with the fewest open chats first. Owner's answers: only chats that need a person (Needs you,
// or With team with the customer waiting: Chikki's own chats are never given out), the Manager is not in the queue
// (he gets the escalations), nobody logged in = nobody gets a chat (they stay in the open pool, visible to everyone).
// A Refund / Ship again chat is the Manager's and never given out here. Claimed with "WHERE assigned_to IS NULL", so
// the two PM2 processes never give one chat twice; the customer's other open chats nobody holds go with it, as on a
// first reply. Logged as a 'claim' by the system (reason 'auto_assign'). Never throws.

import { withTransaction, query } from '@/lib/db';
import { lastSeenMs, presenceRead, teamEntries, teamLoaded } from '@/lib/auth';
import { can, canAccessPanel } from '@/lib/permissions';
import { awayMinutes, isOfficeHours, todayOpenMs } from '@/lib/office-hours';
import { loadHolidays } from './holidays';
import { WAITING_LATERAL, WAITING_SINCE_SQL } from './waiting-sql';
import { logChatEvent, setSystemActor } from './team-routing';
import { onDuty, pickAssignee, type Candidate } from './auto-assign-rules';

const MAX_PER_RUN = 40;
const g = globalThis as unknown as { __autoAssignBusy?: boolean; __autoAssignLast?: Map<string, number> };
const lastGiven = () => (g.__autoAssignLast ??= new Map<string, number>());

export interface AssignRun { idle?: string; given: number; onDuty: number; waiting: number }

// The members on duty now, for one panel (undefined = in any panel: is anybody on duty at all?).
export function dutyMembers(panelId: string | null | undefined, now: number, holidays: string[]) {
  const officeOpen = isOfficeHours(now, holidays);
  const openedTodayMs = todayOpenMs(now);
  return teamEntries().filter((e) => onDuty({
    active: e.active, canReply: can(e, 'chat.reply'), lead: can(e, 'team.lead'), panelOk: panelId === undefined || canAccessPanel(e, panelId),
    officeOpen, seenTodayMs: lastSeenMs(e.id), openedTodayMs, awayMin: awayMinutes(lastSeenMs(e.id), now, holidays),
  }));
}

export async function runAutoAssign(now = Date.now()): Promise<AssignRun> {
  const out: AssignRun = { given: 0, onDuty: 0, waiting: 0 };
  if (g.__autoAssignBusy) return { ...out, idle: 'busy' };
  g.__autoAssignBusy = true;
  try {
    // After a restart nobody is "seen" until presence is read once: give nothing rather than guess.
    if (!teamLoaded() || !presenceRead()) return { ...out, idle: 'starting' };
    const holidays = await loadHolidays(now).catch(() => [] as string[]);
    if (!isOfficeHours(now, holidays)) return { ...out, idle: 'office_closed' };
    if (!dutyMembers(undefined, now, holidays).length) return { ...out, idle: 'nobody_on_duty' };

    const due = await query<{ id: string; site_id: string; customer_key: string | null; source: string; panel: string | null; status: string }>(
      `SELECT c.id, c.site_id, c.customer_key, c.source, s.tracker_business_id::text AS panel, c.status
         FROM conversations c
         JOIN sites s ON s.id = c.site_id
         ${WAITING_LATERAL}
        WHERE c.assigned_to IS NULL AND c.merged_into IS NULL AND c.case_kind IS NULL
          AND (c.status = 'human_needed' OR (c.status = 'agent_handling' AND (${WAITING_SINCE_SQL}) IS NOT NULL))
        ORDER BY c.last_message_at ASC NULLS LAST
        LIMIT ${MAX_PER_RUN}`
    );
    out.waiting = due.rows.length;
    if (!due.rows.length) return out;

    // Open chats each member holds now (the load).
    const loads = new Map<string, number>();
    const l = await query<{ assigned_to: string; n: number }>(
      `SELECT assigned_to, count(*)::int AS n FROM conversations
        WHERE assigned_to IS NOT NULL AND status <> 'resolved' AND merged_into IS NULL GROUP BY assigned_to`
    );
    for (const r of l.rows) loads.set(r.assigned_to, r.n);

    for (const c of due.rows) {
      const duty = dutyMembers(c.panel, now, holidays);
      out.onDuty = Math.max(out.onDuty, duty.length);
      const pick = pickAssignee(duty.map((e): Candidate => ({ key: e.id, name: e.name, load: loads.get(e.id) ?? 0, lastAssignedMs: lastGiven().get(e.id) ?? 0 })));
      if (!pick) continue;
      const got = await withTransaction(async (client) => {
        await setSystemActor(client, 'Auto-assign', 'auto_assign');
        // The chat and the customer's other open chats nobody holds (one person per customer), only if still free.
        const r = await client.query<{ id: string }>(
          `UPDATE conversations SET assigned_to = $2::text, assigned_at = now()
            WHERE assigned_to IS NULL AND merged_into IS NULL
              AND (id = $1 OR ($3::text IS NOT NULL AND source = 'chat' AND site_id = $4 AND customer_key = $3::text AND status <> 'resolved'))
              AND EXISTS (SELECT 1 FROM conversations x WHERE x.id = $1 AND x.assigned_to IS NULL)
            RETURNING id`,
          [c.id, pick.key, c.source === 'chat' ? c.customer_key : null, c.site_id]
        );
        if (!r.rows.length) return 0;
        await logChatEvent(client, 'system', {
          conversationId: c.id, siteId: c.site_id, kind: 'claim', toOwner: pick.key, fromStatus: c.status, toStatus: c.status,
          reason: 'auto_assign', meta: { to_name: pick.name, group: r.rows.map((x) => x.id).filter((id) => id !== c.id) },
        });
        return r.rows.length;
      }).catch((e) => { console.error('[auto-assign] claim:', (e as Error).message); return 0; });
      if (got > 0) {
        out.given++;
        loads.set(pick.key, (loads.get(pick.key) ?? 0) + 1);
        lastGiven().set(pick.key, now + out.given);   // later picks in this run count as later
        console.log(`[auto-assign] conv ${c.id} -> ${pick.name}`);
      }
    }
    return out;
  } catch (e) {
    console.error('[auto-assign] run:', (e as Error).message);
    return { ...out, idle: 'error' };
  } finally {
    g.__autoAssignBusy = false;
  }
}
