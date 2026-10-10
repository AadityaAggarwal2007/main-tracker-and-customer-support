// ── The Manager's live board (owner 2026-10-10, step 5: "har 30 minute me har team member ki kitni chats hui hain";
// "Chikki ne bhi bahut kuch straight kiya hai, usko bhi record kar") ──
// For the Manager and the Super Admin (team.lead), in their panels: today (India day, from 10:00), per team member who
// replies to chats: on duty or not, last seen, the chats they hold and how many of those wait, their replies in each
// half hour, and how many of their chats went to the Manager after 30 minutes without a reply. Then Chikki: its replies
// per half hour, the chats it finished alone today, the chats it handed to the team, the Refund / Ship again marks it
// made, and whether it is answering at all (ai-health.ts). Read only; every part in its own try (a missing table
// zeroes only that part). Nothing stored.

import { query } from '@/lib/db';
import { lastSeenMs, presenceRead, teamEntries } from '@/lib/auth';
import { can, canAccessPanel } from '@/lib/permissions';
import { awayMinutes, isOfficeHours, todayOpenMs } from '@/lib/office-hours';
import { aiHealth, AI_REASON_TEXT } from './ai-health';
import { loadHolidays } from './holidays';
import { WAITING_LATERAL, WAITING_SINCE_SQL } from './waiting-sql';
import { onDuty } from './auto-assign-rules';
import { SLOT_MS, slotCount, slotLabels } from './team-live-rules';

export interface LiveMember {
  key: string; name: string; lead: boolean; onDuty: boolean; seenMin: number | null; awayMin: number | null;
  held: number; waiting: number; repliesToday: number; slots: number[]; movedToManager: number;
}
export interface LiveChikki { ok: boolean; reason: string | null; text: string | null; repliesToday: number; slots: number[]; aloneToday: number; handedToday: number; autoMarksToday: number }
export interface TeamLive { at: string; officeOpen: boolean; slotLabels: string[]; members: LiveMember[]; chikki: LiveChikki }

const missing = (e: unknown) => ['42P01', '42703'].includes((e as { code?: string })?.code || '');
async function safe<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e) { if (!missing(e)) console.error(`[team-live] ${what}:`, (e as Error).message); return fallback; }
}

export async function loadTeamLive(panels: string[] | null, now = Date.now()): Promise<TeamLive> {
  const holidays = await loadHolidays(now).catch(() => [] as string[]);
  const open = todayOpenMs(now);
  const n = slotCount(open, now);
  const openIso = new Date(open).toISOString();
  const officeOpen = isOfficeHours(now, holidays);
  const panelOk = (e: Parameters<typeof canAccessPanel>[0]) => !panels || panels.some((p) => canAccessPanel(e, p));
  const team = teamEntries().filter((e) => e.active && can(e, 'chat.reply') && panelOk(e));

  const held = await safe('held', async () => (await query<{ k: string; held: number; waiting: number }>(
    `SELECT c.assigned_to AS k, count(*)::int AS held, (count(*) FILTER (WHERE (${WAITING_SINCE_SQL}) IS NOT NULL))::int AS waiting
       FROM conversations c JOIN sites s ON s.id = c.site_id
       ${WAITING_LATERAL}
      WHERE c.assigned_to IS NOT NULL AND c.status <> 'resolved' AND c.merged_into IS NULL
        AND ($1::text[] IS NULL OR s.tracker_business_id::text = ANY($1::text[]))
      GROUP BY c.assigned_to`, [panels])).rows, [] as { k: string; held: number; waiting: number }[]);

  const replies = await safe('replies', async () => (await query<{ k: string; slot: number; n: number }>(
    `SELECT e.actor AS k, floor(extract(epoch FROM (e.created_at - $2::timestamptz)) / ${SLOT_MS / 1000})::int AS slot, count(*)::int AS n
       FROM chat_events e LEFT JOIN sites s ON s.id::text = e.site_id
      WHERE e.kind = 'reply' AND e.created_at >= $2::timestamptz
        AND ($1::text[] IS NULL OR s.tracker_business_id::text = ANY($1::text[]))
      GROUP BY 1, 2`, [panels, openIso])).rows, [] as { k: string; slot: number; n: number }[]);

  const moved = await safe('moved', async () => (await query<{ k: string; n: number }>(
    `SELECT e.from_owner AS k, count(*)::int AS n
       FROM chat_events e LEFT JOIN sites s ON s.id::text = e.site_id
      WHERE e.reason = 'no_reply_30' AND e.created_at >= $2::timestamptz
        AND ($1::text[] IS NULL OR s.tracker_business_id::text = ANY($1::text[]))
      GROUP BY 1`, [panels, openIso])).rows, [] as { k: string; n: number }[]);

  const members: LiveMember[] = team.map((e) => {
    const seen = presenceRead() ? lastSeenMs(e.id) : null;
    const slots = new Array(n).fill(0);
    for (const r of replies) if (r.k === e.id && r.slot >= 0 && r.slot < n) slots[r.slot] += r.n;
    const h = held.find((x) => x.k === e.id);
    const lead = can(e, 'team.lead');
    return {
      key: e.id, name: e.name, lead,
      onDuty: onDuty({ active: e.active, canReply: true, lead: false, panelOk: true, officeOpen, seenTodayMs: seen, openedTodayMs: open, awayMin: awayMinutes(seen, now, holidays) }),
      seenMin: seen === null ? null : Math.max(0, Math.floor((now - seen) / 60_000)),
      awayMin: awayMinutes(seen, now, holidays),
      held: h?.held ?? 0, waiting: h?.waiting ?? 0,
      repliesToday: slots.reduce((a, b) => a + b, 0), slots,
      movedToManager: moved.find((x) => x.k === e.id)?.n ?? 0,
    };
  }).sort((a, b) => Number(b.lead) - Number(a.lead) || b.repliesToday - a.repliesToday || a.name.localeCompare(b.name));

  // Chikki.
  const aiSlots = new Array(n).fill(0);
  const ai = await safe('chikki replies', async () => (await query<{ slot: number; n: number }>(
    `SELECT floor(extract(epoch FROM (m.created_at - $2::timestamptz)) / ${SLOT_MS / 1000})::int AS slot, count(*)::int AS n
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN sites s ON s.id = c.site_id
      WHERE m.sender = 'ai' AND m.created_at >= $2::timestamptz AND m.deleted_at IS NULL
        AND COALESCE(m.metadata->>'wa_auto_reply', '') <> 'true' AND COALESCE(m.metadata->>'withheld', '') = ''
        AND ($1::text[] IS NULL OR s.tracker_business_id::text = ANY($1::text[]))
      GROUP BY 1`, [panels, openIso])).rows, [] as { slot: number; n: number }[]);
  for (const r of ai) if (r.slot >= 0 && r.slot < n) aiSlots[r.slot] += r.n;
  const counts = await safe('chikki chats', async () => (await query<{ alone: number; handed: number }>(
    `SELECT (count(DISTINCT m.conversation_id) FILTER (WHERE c.status IN ('ai_handling', 'resolved')
               AND NOT EXISTS (SELECT 1 FROM messages t WHERE t.conversation_id = c.id AND t.sender = 'agent' AND t.created_at >= $2::timestamptz)))::int AS alone,
            (SELECT count(DISTINCT e.conversation_id) FROM chat_events e LEFT JOIN sites s2 ON s2.id::text = e.site_id
              WHERE e.kind = 'status' AND e.to_status = 'human_needed' AND e.actor IN ('ai', 'system') AND e.created_at >= $2::timestamptz
                AND ($1::text[] IS NULL OR s2.tracker_business_id::text = ANY($1::text[])))::int AS handed
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN sites s ON s.id = c.site_id
      WHERE m.sender = 'ai' AND m.created_at >= $2::timestamptz AND m.deleted_at IS NULL
        AND ($1::text[] IS NULL OR s.tracker_business_id::text = ANY($1::text[]))`, [panels, openIso])).rows[0], { alone: 0, handed: 0 });
  const marks = await safe('chikki marks', async () => (await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM chat_case_events e LEFT JOIN sites s ON s.id::text = e.site_id
      WHERE e.action = 'mark' AND e.actor_role = 'system' AND e.created_at >= $2::timestamptz
        AND ($1::text[] IS NULL OR s.tracker_business_id::text = ANY($1::text[]))`, [panels, openIso])).rows[0]?.n ?? 0, 0);
  const h = aiHealth(now);

  return {
    at: new Date(now).toISOString(), officeOpen, slotLabels: slotLabels(open, n),
    members,
    chikki: { ok: h.ok, reason: h.reason, text: h.reason ? AI_REASON_TEXT[h.reason] : null, repliesToday: aiSlots.reduce((a, b) => a + b, 0), slots: aiSlots, aloneToday: counts?.alone ?? 0, handedToday: counts?.handed ?? 0, autoMarksToday: marks },
  };
}
