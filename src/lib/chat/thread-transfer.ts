import { NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { canAct, cleanTransferNote, transferStatus, type Actor } from './team-rules';
import { ChatActionError, holderOf, isKnownCustomer, lockChatGroup, logChatEvent, nameOfKey, setActor, transferList } from './team-routing';
import type { ConversationRow } from './thread-read';

// ── Transfer ────────────────────────────────────────────────────────
// The holder (or anyone on a chat nobody holds, or the Super Admin) gives the chat to someone who can
// reply in its panel, with a one-line note for the team. The note is STAFF ONLY: it lives only in
// chat_events (never in messages, metadata, search, the learner, the AI or the widget) and is never
// written to the logs. A known customer goes to Needs you (the AI stops, auto-close leaves it, it
// shows "For Rahul"); a visitor to agent_handling (only verified customers reach Needs you); a Refund /
// Ship again chat and "Nobody" keep their status. The customer's other open chats that had the same
// holder move too.
const PICK_MESSAGE = 'Pick someone who can reply in this panel (not you, not the person who has it)';

export async function transfer(conversation: ConversationRow, staff: Actor, rawTo: unknown, rawNote: unknown) {
  const note = cleanTransferNote(rawNote);
  if (!note) return NextResponse.json({ error: 'Write one line for the team: why are you transferring it?' }, { status: 400 });
  if (rawTo !== null && (typeof rawTo !== 'string' || !rawTo)) return NextResponse.json({ error: PICK_MESSAGE }, { status: 400 });
  const to = rawTo as string | null;
  const panel = conversation.tracker_business_id;

  const out = await withTransaction(async (client) => {
    const now = Date.now();
    const { chat, siblings } = await lockChatGroup(client, conversation.id, conversation.site_id, conversation.customer_key);
    if (chat.status === 'resolved') {
      throw new ChatActionError(400, 'This chat is Closed. When the customer writes again it goes to whoever holds it.');
    }
    const h = holderOf(chat.assigned_to, panel, now);
    if (!canAct(staff, h)) {
      throw new ChatActionError(409, h!.superAdmin
        ? 'Super Admin has this chat. Only Super Admin can transfer it.'
        : `${h!.name} has this chat. Only ${h!.name} or Super Admin can transfer it.`);
    }
    if (to === null && !staff.superAdmin) throw new ChatActionError(403, 'Only Super Admin can put a chat back in the open pool');
    if (!transferList(staff, h, panel, now).some((t) => t.key === to)) throw new ChatActionError(400, PICK_MESSAGE);
    const status = transferStatus({ status: chat.status, case_kind: chat.case_kind, known: isKnownCustomer(chat) }, to === null) ?? chat.status;

    await setActor(client, staff, 'transfer');
    const r = await client.query<{ status: string; assigned_to: string | null }>(
      `UPDATE conversations
          SET assigned_to = $2::text, assigned_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
              status = $3, auto_closed_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING status, assigned_to`,
      [chat.id, to, status]
    );
    const group = siblings.filter((s) => s.assigned_to === chat.assigned_to).map((s) => s.id);
    if (group.length > 0) {
      await client.query(
        `UPDATE conversations SET assigned_to = $1::text, assigned_at = CASE WHEN $1::text IS NULL THEN NULL ELSE now() END
          WHERE id = ANY($2::text[])`,
        [to, group]
      );
    }
    // Required: the note lives only here, so a transfer that cannot be logged does not happen. For
    // "Nobody" it also keeps the chat and its group (meta.group) in the open pool: the inherit trigger
    // (chat-team.sql) never gives a chat named in a transfer to nobody back to its old holder.
    await logChatEvent(client, staff, {
      conversationId: chat.id, siteId: chat.site_id, kind: 'transfer', fromOwner: chat.assigned_to, toOwner: to,
      fromStatus: chat.status, toStatus: status, reason: 'transfer', note, meta: { status_before: chat.status, group },
    }, { required: true });
    return { row: r.rows[0], from: chat.assigned_to };
  });

  console.log(`[chat] transfer conv ${conversation.id} from ${out.from ?? 'nobody'} to ${out.row?.assigned_to ?? 'nobody'} (note ${Array.from(note).length} chars)`);
  return NextResponse.json({
    success: true, status: out.row?.status, assigned_to: out.row?.assigned_to ?? null,
    holder_name: nameOfKey(out.row?.assigned_to),
  });
}
