import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { withTransaction } from '@/lib/db';
import { isSuperAdmin } from '@/lib/permissions';
import { OWNER_KEY, actorTier } from '@/lib/chat/team-rules';
import { STARTING_MESSAGE, actionError, actionsReady, staffActor } from '@/lib/chat/team-routing';

export const dynamic = 'force-dynamic';

// The note on every released chat's transfer event (staff only, like every transfer note).
const RELEASE_NOTE = 'Released by Super Admin';

// ── POST /api/chat/team/release ────────────────────────────────
// "Give all my open chats to the team" (owner answer 3, 2026-10-01), Super Admin only. His own
// first reply or Take over makes a chat his (owner answer Q2), and he answers about 95 chats a day;
// the team can only read those until he lets go. This lets go of all of them at once: every chat he
// holds that is open and not a merged shell goes back to the open pool (assigned_to NULL), its
// status unchanged, so the next member to reply or Take over gets it. One transfer event per chat
// (from 'owner' to nobody, meta.bulk), in the same transaction: no chat is freed without its record.
// That record is also what keeps the chat in the pool: trg_chat_inherit_owner (chat-team.sql) never
// gives a chat with a transfer to nobody back to anyone, so the AI's next hand-off cannot return it
// to him through one of the customer's Closed chats.
// His Closed chats keep him as their holder (decision 4: Close never changes the holder).
// Body: {} (nothing to choose). Answer: { released: n }.
export async function POST(request: NextRequest) {
  // Rights come from the team list: right after a restart, wait for it rather than guess.
  if (!(await actionsReady())) return NextResponse.json({ error: STARTING_MESSAGE }, { status: 503 });
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const actor = staffActor(user);
  if (!isSuperAdmin(user) || !actor) {
    return NextResponse.json({ error: 'Only Super Admin can give his chats back to the team' }, { status: 403 });
  }

  try {
    const released = await withTransaction(async (client) => {
      // Fail fast (409 "try again") instead of waiting behind a reply in progress; locked in id
      // order like every chat action, and only these rows (a widget message is never held up).
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      const held = await client.query<{ id: string; site_id: string | null; status: string }>(
        `SELECT id, site_id, status
           FROM conversations
          WHERE assigned_to = $1 AND status <> 'resolved' AND merged_into IS NULL
          ORDER BY id
            FOR NO KEY UPDATE`,
        [OWNER_KEY]
      );
      const rows = held.rows;
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      // No status change, so the status trigger does not fire; the holder change is logged below.
      await client.query(
        `UPDATE conversations SET assigned_to = NULL, assigned_at = NULL WHERE id = ANY($1::text[])`,
        [ids]
      );
      await client.query(
        `INSERT INTO chat_events (conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner,
                                  from_status, to_status, reason, note, meta)
         SELECT x.id, x.site_id, 'transfer', $4, $5, $4, NULL, x.status, x.status, 'transfer', $6, $7::jsonb
           FROM unnest($1::text[], $2::text[], $3::text[]) AS x(id, site_id, status)`,
        [ids, rows.map((r) => r.site_id), rows.map((r) => r.status), OWNER_KEY, actor.name, RELEASE_NOTE,
          JSON.stringify({ tier: actorTier(actor), bulk: true })]
      );
      return ids.length;
    });
    console.log(`[chat] Super Admin gave ${released} open chats back to the team`);
    return NextResponse.json({ released });
  } catch (err) {
    // A lock that took over 5 s or a deadlock: nothing was changed, try again.
    const refused = actionError(err);
    if (refused) return refused;
    console.error('[chat] release failed:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not give the chats back. Try again.' }, { status: 500 });
  }
}
