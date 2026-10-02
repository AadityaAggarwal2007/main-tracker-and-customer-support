import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest, AuthUser, teamLoaded } from '@/lib/auth';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import { loadOrderFacts } from '@/lib/chat/order-facts';
import { loadOrderAddress } from '@/lib/chat/order-address-db';
import { displayNameSql, nameFromOrderSql, orderNameJoinSql } from '@/lib/chat/display-name';
import { can, canAccessPanel, isSuperAdmin } from '@/lib/permissions';
import { maskRefundLinks } from '@/lib/refund/link-mask';
import { refundMarkLocked, refundThreadState } from '@/lib/refund/server';
import { isOfficeHours } from '@/lib/office-hours';
import {
  canAct, claimsOnAct, cleanTransferNote, transferStatus, type Actor, type TakeKind,
} from '@/lib/chat/team-rules';
import {
  CASE_GATE_MESSAGE, ChatActionError, STARTING_MESSAGE, actionError, actionsReady, authorNamer, caseMarkState, heldMessage, holderOf,
  holderView, isKnownCustomer, lockChatGroup, logChatEvent, nameOfKey, setActor, shownAway, staffActor, takeFor, transferList,
  type LockedChat,
} from '@/lib/chat/team-routing';

export const dynamic = 'force-dynamic';

const VALID_STATUSES = ['ai_handling', 'agent_handling', 'resolved', 'human_needed'];

interface ConversationRow {
  id: string; site_id: string; visitor_name: string | null; display_name: string | null; name_from_order: boolean; visitor_phone: string | null;
  status: string; source: string; category: string; unread_count: number;
  last_message_at: string | null; created_at: string;
  site_name: string; tracker_business_id: string | null; panel_name: string | null;
  verified_order_id: string | null; verified_via: string | null; phone_match_order_id: string | null;
  customer_key: string | null;
  subject_label: string | null; subject_summary: string | null; subject_updated_at: string | null;
  health_score: number | null; health_reason: string | null; health_updated_at: string | null;
  auto_closed_at: string | null;
  closed_by_name: string | null; closed_at: string | null;
  case_kind: string | null; case_marked_by: string | null; case_marked_at: string | null; case_order_id: string | null; case_prev_status: string | null;
  // The latest mark's chat_case_events.actor_role: 'system' (Chikki's live mark) or 'backfill' (the one-time move).
  case_mark_role?: string | null;
  // Who holds the chat (chat-team.sql): team_users.id, 'owner' (Super Admin) or null (nobody).
  assigned_to: string | null; assigned_at: string | null;
  merged_into: string | null;
}

// Reachable only if the conversation's panel is one this user may see.
async function loadForUser(id: string, user: AuthUser): Promise<ConversationRow | null> {
  const conv = await queryOne<ConversationRow>(
    `SELECT c.id, c.site_id, c.visitor_name, ${displayNameSql('c')} AS display_name, ${nameFromOrderSql()} AS name_from_order, c.visitor_phone, c.status, c.source,
            c.category, c.unread_count, c.last_message_at, c.created_at,
            c.verified_order_id, c.verified_via, c.customer_key, c.phone_match_order_id,
            c.subject_label, c.subject_summary, c.subject_updated_at,
            c.health_score, c.health_reason, c.health_updated_at, c.auto_closed_at, c.closed_by_name, c.closed_at,
            c.case_kind, c.case_marked_by, c.case_marked_at, c.case_order_id, c.case_prev_status,
            CASE WHEN c.case_kind IS NOT NULL THEN
              (SELECT e.actor_role FROM chat_case_events e
                WHERE e.conversation_id = c.id AND e.kind = c.case_kind AND e.action = 'mark'
                ORDER BY e.created_at DESC LIMIT 1) END AS case_mark_role,
            c.assigned_to, c.assigned_at, c.merged_into,
            s.name AS site_name, s.tracker_business_id,
            b.name AS panel_name
       FROM conversations c
       JOIN sites s ON s.id = c.site_id
       LEFT JOIN businesses b ON b.id::text = s.tracker_business_id::text
       ${orderNameJoinSql('c', 's')}
      WHERE c.id = $1`,
    [id]
  );
  if (!conv) return null;

  if (user.businessIds && user.businessIds.length > 0) {
    const panel = conv.tracker_business_id;
    if (!panel || !user.businessIds.includes(panel)) return null;
  }
  return conv;
}

// What a person reads in a thread (see GET below).
const STAFF_MESSAGE_SQL = `sender <> 'tool_result'
        AND COALESCE(metadata->>'hidden', 'false') <> 'true'
        AND content IS NOT NULL AND btrim(content) <> ''`;

const EARLIER_CHATS = 5;
const EARLIER_MESSAGES = 200;

interface EarlierRow {
  conversation_id: string; conv_created_at: string; conv_status: string; older_total: number;
  id: string | null; sender: string; content: string; metadata: unknown; created_at: string;
  edited_at: string | null; edited_by: string | null; deleted_at: string | null; deleted_by: string | null;
}

interface EarlierChat {
  conversation_id: string;
  created_at: string;
  status: string;
  messages: {
    id: string; sender: string; content: string; metadata: unknown; created_at: string;
    edited_at: string | null; edited_by: string | null; deleted_at: string | null; deleted_by: string | null;
  }[];
}

interface NewerChat {
  conversation_id: string; created_at: string; last_message_at: string | null; status: string;
}

interface CustomerThread {
  earlier: EarlierChat[];
  // Older chats of the customer in all, shown or not (the last 5 are loaded,
  // and a chat with nothing to read is left out).
  earlierTotal: number;
  // Ids of the older chats loaded, whose unread messages the thread shows.
  shownIds: string[];
  // The customer's most recently active chat when it is not this one.
  newer: NewerChat | null;
}

// The same customer's other widget chats on this site (customer_key, see
// chat-customer-key.sql). "Older" and "newer" go by last activity
// (last_message_at, else created_at), the order the inbox list uses: a chat
// the customer wrote in after this one's last message is newer, so it is never
// drawn above this chat as an earlier one; the inbox offers to open it instead.
// Same panel scope as the main conversation (same site, and the caller's
// panels checked again), same message filters.
const ACTIVITY = `(COALESCE(c.last_message_at, c.created_at), c.created_at, c.id)`;

async function loadCustomerThread(conv: ConversationRow, user: AuthUser): Promise<CustomerThread> {
  const none: CustomerThread = { earlier: [], earlierTotal: 0, shownIds: [], newer: null };
  if (!conv.customer_key || conv.source !== 'chat') return none;
  const scoped = !!(user.businessIds && user.businessIds.length > 0);
  const params = [conv.site_id, conv.customer_key, conv.id, scoped, scoped ? user.businessIds : []];
  const siblings = `
         FROM conversations c
         JOIN sites s ON s.id = c.site_id
         CROSS JOIN (SELECT COALESCE(last_message_at, created_at) AS at, created_at, id
                       FROM conversations WHERE id = $3) cur
        WHERE c.site_id = $1
          AND c.customer_key = $2
          AND c.source = 'chat'
          AND c.id <> $3
          AND (NOT $4::boolean OR s.tracker_business_id::text = ANY($5::text[]))`;

  const rows = await query<EarlierRow>(
    `WITH older AS (
       SELECT c.id, c.created_at, c.status,
              count(*) OVER ()::int AS older_total,
              ${ACTIVITY} AS activity
       ${siblings}
          AND ${ACTIVITY} < (cur.at, cur.created_at, cur.id)
     ), others AS (
       SELECT * FROM older ORDER BY activity DESC LIMIT ${EARLIER_CHATS}
     )
     SELECT o.id AS conversation_id, o.created_at AS conv_created_at, o.status AS conv_status,
            o.older_total,
            m.id, m.sender, m.content, m.metadata, m.created_at,
            m.edited_at, m.edited_by, m.deleted_at, m.deleted_by
       FROM others o
       LEFT JOIN LATERAL (
         SELECT id, sender, content, metadata, created_at, edited_at, edited_by, deleted_at, deleted_by
           FROM messages
          WHERE conversation_id = o.id
            AND ${STAFF_MESSAGE_SQL}
          ORDER BY created_at DESC
          LIMIT ${EARLIER_MESSAGES}
       ) m ON true
      ORDER BY o.created_at ASC, o.id, m.created_at ASC`,
    params
  );

  const newer = await queryOne<NewerChat>(
    `SELECT c.id AS conversation_id, c.created_at, c.last_message_at, c.status
     ${siblings}
          AND ${ACTIVITY} > (cur.at, cur.created_at, cur.id)
      ORDER BY ${ACTIVITY} DESC
      LIMIT 1`,
    params
  );

  const chats: EarlierChat[] = [];
  const shownIds: string[] = [];
  let earlierTotal = 0;
  for (const r of rows.rows) {
    earlierTotal = r.older_total;
    let chat = chats[chats.length - 1];
    if (!chat || chat.conversation_id !== r.conversation_id) {
      chat = { conversation_id: r.conversation_id, created_at: r.conv_created_at, status: r.conv_status, messages: [] };
      chats.push(chat);
      shownIds.push(r.conversation_id);
    }
    if (r.id) {
      chat.messages.push({
        id: r.id, sender: r.sender, content: r.content, metadata: r.metadata, created_at: r.created_at,
        edited_at: r.edited_at, edited_by: r.edited_by, deleted_at: r.deleted_at, deleted_by: r.deleted_by,
      });
    }
  }
  // A chat with nothing a person can read (opened by the form, never written
  // in) would only add an empty divider.
  return { earlier: chats.filter((c) => c.messages.length > 0), earlierTotal, shownIds, newer: newer || null };
}

// ── GET /api/chat/conversations/:id ────────────────────────────
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.view')) return NextResponse.json({ error: 'You cannot open Chat Support' }, { status: 403 });

  const conversation = await loadForUser(params.id, user);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // tool_result rows and the hidden tool bookkeeping are context for the model,
  // not part of the conversation a person reads. Deleted messages stay in the
  // list, marked, so the team can see what was removed and by whom.
  // `brain` = the Brain notes the agent was shown for that reply (brain_usage, staff only).
  // Before chat-brain-usage.sql is applied the table is missing: read without it then.
  const messagesSql = (withBrain: boolean) => `SELECT id, sender, content, metadata, created_at, edited_at, edited_by, deleted_at, deleted_by${
    withBrain ? `, (SELECT u.notes FROM brain_usage u WHERE u.message_id = messages.id) AS brain` : ''}
       FROM messages
      WHERE conversation_id = $1
        AND ${STAFF_MESSAGE_SQL}
      ORDER BY created_at ASC`;
  const messages = await query(messagesSql(true), [params.id]).catch(() => query(messagesSql(false), [params.id]));

  // The same customer's older chats on this site (customer_key, see
  // chat-customer-key.sql), so the inbox shows one customer as one thread:
  // the 5 most recently active, each with its last 200 messages, returned
  // oldest first. A newer chat of the customer is named, not drawn
  // (newer_chat), so staff can switch to where the customer is now writing.
  const thread = await loadCustomerThread(conversation, user);

  // The header's order line (placed on, where it is now, estimated delivery):
  // the verified order, else the one the chat's number matched. Staff only.
  const orderFacts = conversation.verified_order_id
    ? await loadOrderFacts(conversation.verified_order_id, conversation.tracker_business_id, 'verified')
    : await loadOrderFacts(conversation.phone_match_order_id, conversation.tracker_business_id, 'phone_match');

  // The same order's delivery address, for logins that may see orders; changeable (PATCH
  // .../address) only on a verified order by logins that may change orders. Staff only.
  const orderAddress = can(user, 'orders.view')
    ? await loadOrderAddress(conversation.verified_order_id || conversation.phone_match_order_id, conversation.tracker_business_id)
    : null;

  // Opening a thread clears its unread badge, and the grouped inbox row
  // (group_unread) counts the customer's other chats too, so the older chats
  // shown here go as well. A newer chat keeps its badge: nothing of it is
  // shown here.
  if (conversation.unread_count > 0) {
    await query(`UPDATE conversations SET unread_count = 0, updated_at = now() WHERE id = $1`, [params.id]);
    conversation.unread_count = 0;
  }
  if (thread.shownIds.length > 0) {
    await query(
      `UPDATE conversations
          SET unread_count = 0, updated_at = now()
        WHERE id = ANY($1::text[]) AND unread_count > 0`,
      [thread.shownIds]
    );
  }

  // Who wrote each staff message, by name today ("You" is decided by the inbox). Staff only.
  // A reply sent since chat-team.sql has its writer's KEY in its 'reply' event (messages/route.ts), so
  // a member the owner renamed or removed keeps their own name (removed: the name they had then), and
  // a username given to someone new later never takes their replies. metadata.agent is only the
  // username at the time: it names the older replies (a member's today, else the Super Admin's own
  // login). author_key lets the inbox say "You" after a rename. Before the table exists: usernames.
  const author = authorNamer();
  const agentIds = [...messages.rows, ...thread.earlier.flatMap((c) => c.messages)]
    .filter((m) => m.sender === 'agent' && m.id != null)
    .map((m) => String(m.id));
  const writers = new Map<string, { key: string; name: string | null }>();
  if (agentIds.length > 0 && teamLoaded()) {
    const ev = await query<{ message_id: string; actor: string; actor_name: string | null }>(
      `SELECT DISTINCT ON (message_id) message_id, actor, actor_name
         FROM chat_events
        WHERE kind = 'reply' AND message_id = ANY($1::text[])
        ORDER BY message_id, id`,
      [agentIds]
    ).catch(() => ({ rows: [] as { message_id: string; actor: string; actor_name: string | null }[] }));
    for (const e of ev.rows) writers.set(e.message_id, { key: e.actor, name: nameOfKey(e.actor) ?? e.actor_name ?? 'Team' });
  }
  const withAuthor = <M extends { sender: string; metadata: unknown }>(m: M) => {
    if (m.sender !== 'agent') return m;
    const w = writers.get(String((m as { id?: unknown }).id));
    return w
      ? { ...m, author: w.name, author_key: w.key }
      : { ...m, author: author((m.metadata as { agent?: unknown } | null)?.agent), author_key: null };
  };
  // A refund form link (owner 2026-10-02) is "[refund form link]" on every staff screen, the Super
  // Admin's too: the raw link lives only in the 'system' message the customer opens. Any text that
  // names "refund" is checked (a percent-encoded "%2Frefund%23<token>" too: link-mask.ts).
  const unlink = <M extends { content: string }>(m: M) => (/refund/i.test(m.content ?? '') ? { ...m, content: maskRefundLinks(m.content) } : m);
  const earlier = thread.earlier.map((c) => ({ ...c, messages: c.messages.map((m) => unlink(withAuthor(m))) }));

  // The chat's team history (claims, takes, transfers with their note, returning customers,
  // merges), newest first, names as they are today. STAFF ONLY: the note is never sent to the
  // customer or the AI. Before chat-team.sql the table is missing: no history then.
  const teamLog = await query<{
    id: string; created_at: string; kind: string; actor: string; actor_name: string | null;
    from_owner: string | null; to_owner: string | null; reason: string | null; note: string | null;
  }>(
    `SELECT id, created_at, kind, actor, actor_name, from_owner, to_owner, reason, note
       FROM chat_events
      WHERE conversation_id = $1 AND kind IN ('claim','take','transfer','inherit','merge')
      ORDER BY id DESC LIMIT 10`,
    [params.id]
  ).then((r) => r.rows.map((e) => ({
    ...e,
    actor_name: nameOfKey(e.actor) ?? e.actor_name,
    from_name: e.from_owner ? nameOfKey(e.from_owner) ?? 'A former member' : null,
    to_name: e.to_owner ? nameOfKey(e.to_owner) ?? 'A former member' : null,
  }))).catch(() => []);

  return NextResponse.json({
    conversation,
    messages: messages.rows.map((m) => unlink(withAuthor(m as { sender: string; metadata: unknown; content: string }))),
    earlier,
    earlier_total: thread.earlierTotal,
    newer_chat: thread.newer,
    order_facts: orderFacts,
    order_address: orderAddress,
    address_editable: !!orderAddress && !!conversation.verified_order_id && can(user, 'orders.update'),
    team_log: teamLog,
    staff: await staffBlock(conversation, user),
    // The refund form chip (owner 2026-10-02): only the Super Admin, only in a Refund chat. Staff never
    // get this key. A read error leaves it null (the chip then hides); it never fails the thread.
    ...(isSuperAdmin(user) && conversation.case_kind === 'refund' ? { refund_form: await refundThreadState(conversation).catch(() => null) } : {}),
  });
}

// What this person may do on this chat, decided here from team-rules.ts (the inbox draws it and
// never guesses). Computed in memory; the waiting query runs only for away cover.
async function staffBlock(conv: ConversationRow, user: AuthUser) {
  const now = Date.now();
  const actor = staffActor(user);
  const h = holderOf(conv.assigned_to, conv.tracker_business_id, now);
  // A merged shell on a stale screen: read only (the actions refuse it too).
  const live = !!actor && !conv.merged_into;
  const take: TakeKind | null = live && actor ? await takeFor(null, actor, h, conv.id).catch(() => null) : null;
  const mark = actor ? caseMarkState(actor, now) : { allowed: false, override: false, note: null };
  return {
    me: actor?.key ?? null,
    holder: holderView(h),
    can_act: live && !!actor && canAct(actor, h),
    claims: live && !!actor && claimsOnAct(actor, h),
    take,
    transfer_to: live && actor && conv.status !== 'resolved'
      ? transferList(actor, h, conv.tracker_business_id, now).map((t) => ({
        key: t.key, name: t.name, senior: t.senior,
        away_min: shownAway(t.awayMin),
      }))
      : [],
    can_mark_case: mark.allowed,
    mark_override: mark.override,
    mark_note: mark.note,
    office_open: isOfficeHours(now),
  };
}

// ── PATCH /api/chat/conversations/:id ──────────────────────────
// Take over, hand back to the AI, or close. These were socket events in the old
// app; with the inbox polling they are an ordinary request.
//
// Chat team (owner, 2026-10-01; src/lib/chat/team-rules.ts). One chat has at most one holder:
//   { status }                 Take over / Hand to AI / Close: the holder, anyone on a chat nobody
//                              holds, or the Super Admin. Take over on a chat nobody holds makes it
//                              yours, with the customer's other open chats nobody holds. Close and
//                              Hand to AI never change the holder.
//   { status: 'agent_handling', take: true }
//                              "Take from X": the Super Admin from anyone, a senior from a junior,
//                              anyone from a member away 30+ min (office hours) while the customer waits.
//   { transferTo, note }       Transfer, with a one-line note only the team sees.
//   { caseKind }               Refund / Ship again (a senior or the Super Admin marks; setCase).
// Each runs in ONE transaction with the chat and the customer's other open chats locked
// (lockChatGroup), and every statement goes through that transaction's client. Someone else's chat
// is a 409 naming them, and nothing is saved.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  // Rights come from the team list: right after a restart, wait for it rather than guess.
  if (!(await actionsReady())) return NextResponse.json({ error: STARTING_MESSAGE }, { status: 503 });
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.reply')) {
    return NextResponse.json({ error: 'You cannot change conversations' }, { status: 403 });
  }
  const staff = staffActor(user);
  if (!staff) return NextResponse.json({ error: STARTING_MESSAGE }, { status: 503 });

  const conversation = await loadForUser(params.id, user);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const body = await request.json();
    const has = (key: string) => !!body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, key);

    if (has('transferTo')) return await transfer(conversation, staff, body.transferTo, body.note);

    // Refund / Ship again (chat-cases.sql, owner 2026-10-01): { caseKind: 'refund' | 'reship' | null }.
    if (has('caseKind')) {
      if (!can(user, 'chat.cases')) return NextResponse.json({ error: 'You cannot mark Refund / Ship again' }, { status: 403 });
      const raw = body.caseKind;
      const kind = raw === null || raw === '' ? null : String(raw);
      if (kind !== null && !CASE_KINDS.includes(kind)) {
        return NextResponse.json({ error: 'Unknown case' }, { status: 400 });
      }
      // Who marks (owner, 2026-10-01; rulebook 9.6): a senior or the Super Admin; a junior only while
      // every senior has been away 30+ minutes in office hours (logged as an override). Switching
      // between Refund and Ship again is a mark too. Remove: anyone with chat.cases (9.4).
      let override = false;
      if (kind) {
        const gate = caseMarkState(staff);
        if (!gate.allowed) return NextResponse.json({ error: CASE_GATE_MESSAGE }, { status: 403 });
        override = gate.override;
      }
      const done = await withTransaction(async (client) => {
        const { chat } = await lockChatGroup(client, conversation.id, conversation.site_id, conversation.customer_key);
        return setCase(client, chat, kind, user, staff, override);
      });
      if (done.log) console.log(done.log);
      return done.res;
    }

    const { status } = body;
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Unknown status' }, { status: 400 });
    }
    return await changeStatus(conversation, user, staff, status, body.take === true);
  } catch (err) {
    // Our own refusals (409 someone else's chat, a merged shell), a lock that took over 5 s or a
    // deadlock: nothing was saved, and the message says what to do.
    const refused = actionError(err);
    if (refused) return refused;
    return NextResponse.json({ error: 'Could not update that conversation' }, { status: 500 });
  }
}

// Take over, Take from X, Hand to AI, Close.
async function changeStatus(conversation: ConversationRow, user: AuthUser, staff: Actor, status: string, take: boolean) {
  const panel = conversation.tracker_business_id;
  const updated = await withTransaction(async (client) => {
    const now = Date.now();
    const { chat, siblings } = await lockChatGroup(client, conversation.id, conversation.site_id, conversation.customer_key);
    // A Refund / Ship again chat is the team's: the AI stays off until the mark is removed.
    if (status === 'ai_handling' && chat.case_kind) {
      throw new ChatActionError(409, 'Remove the Refund / Ship again mark before handing this chat to the AI');
    }

    const h = holderOf(chat.assigned_to, panel, now);
    let newOwner: string | null = null;
    let took: TakeKind | null = null;
    if (take && status === 'agent_handling') {
      took = await takeFor(client, staff, h, chat.id);
      if (!took) {
        throw new ChatActionError(409, !h || h.key === staff.key
          ? "Nothing to take: this chat is no longer someone else's."
          : `Nothing to take: ${h.name}'s chat cannot be taken by you.`);
      }
      newOwner = staff.key;
    } else {
      if (!canAct(staff, h)) throw new ChatActionError(409, heldMessage(h!, await takeFor(client, staff, h, chat.id)));
      if (status === 'agent_handling' && claimsOnAct(staff, h)) newOwner = staff.key;
    }

    // Logged as this person's status change (chat-team.sql trigger), with why.
    await setActor(client, staff, status === 'resolved' ? 'close' : status === 'ai_handling' ? 'hand_to_ai' : took ? 'take' : 'take_over');

    // Close, Take over and Hand to AI are a person acting on the chat, so the
    // "came back after the auto-close" mark (chat-auto-close.sql) is cleared. A
    // Close also records who pressed it (chat-closed-by.sql), so a Closed chat says
    // "Closed by support" and not "Closed by AI". Closing a chat that is
    // already Closed changes neither the mark nor the name. The holder changes only on a
    // claim or a take ($4); Close and Hand to AI keep it (owner decision 4).
    const r = await client.query<{ status: string; closed_by_name: string | null; closed_at: string | null; auto_closed_at: string | null; assigned_to: string | null }>(
      `UPDATE conversations
          SET status = $1,
              unread_count = CASE WHEN $1 = 'resolved' THEN 0 ELSE unread_count END,
              closed_by_name = CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN $3::text ELSE closed_by_name END,
              closed_at = CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN now() ELSE closed_at END,
              auto_closed_at = CASE WHEN $1 = 'resolved' AND status = 'resolved' THEN auto_closed_at ELSE NULL END,
              assigned_to = CASE WHEN $4::text IS NOT NULL THEN $4::text ELSE assigned_to END,
              assigned_at = CASE WHEN $4::text IS NOT NULL THEN now() ELSE assigned_at END,
              updated_at = now()
        WHERE id = $2
        RETURNING status, closed_by_name, closed_at, auto_closed_at, assigned_to`,
      [status, conversation.id, (user.displayName || user.username || '').trim() || 'support', newOwner]
    );

    if (newOwner) {
      // The customer comes along: on a take, their other open chats the same person held; on a
      // claim, their other open chats nobody holds.
      const group = siblings
        .filter((s) => (took ? s.assigned_to === chat.assigned_to : holderOf(s.assigned_to, panel, now) === null))
        .map((s) => s.id);
      if (group.length > 0) {
        await client.query(`UPDATE conversations SET assigned_to = $1, assigned_at = now() WHERE id = ANY($2::text[])`, [newOwner, group]);
      }
      await logChatEvent(client, staff, {
        conversationId: chat.id, siteId: chat.site_id, kind: took ? 'take' : 'claim',
        fromOwner: chat.assigned_to, toOwner: newOwner, fromStatus: chat.status, toStatus: status,
        reason: took ? 'take' : 'take_over', meta: took ? { take: took, group } : { group },
      });
    }
    return r.rows[0];
  });

  // What the database now says about who closed it, so the screen shows that
  // and not its own guess (a chat the auto-close closed a moment ago stays
  // "Closed by AI" even if someone pressed Close on a stale screen).
  return NextResponse.json({
    success: true,
    status,
    closed_by_name: updated?.closed_by_name ?? null,
    closed_at: updated?.closed_at ?? null,
    auto_closed_at: updated?.auto_closed_at ?? null,
    assigned_to: updated?.assigned_to ?? null,
  });
}

// ── Transfer ────────────────────────────────────────────────────────
// The holder (or anyone on a chat nobody holds, or the Super Admin) gives the chat to someone who can
// reply in its panel, with a one-line note for the team. The note is STAFF ONLY: it lives only in
// chat_events (never in messages, metadata, search, the learner, the AI or the widget) and is never
// written to the logs. A known customer goes to Needs you (the AI stops, auto-close leaves it, it
// shows "For Rahul"); a visitor to agent_handling (only verified customers reach Needs you); a Refund /
// Ship again chat and "Nobody" keep their status. The customer's other open chats that had the same
// holder move too.
const PICK_MESSAGE = 'Pick someone who can reply in this panel (not you, not the person who has it)';

async function transfer(conversation: ConversationRow, staff: Actor, rawTo: unknown, rawNote: unknown) {
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

// ── Refund / Ship again ─────────────────────────────────────────────
// Marking: only a known customer's chat (verified, or an old phone match: the Customers list),
// never a visitor's. The chat leaves every other inbox list and shows only under its section, the
// AI stops (agent_handling), and nothing is sent to the customer. Removing: the chat goes back to
// the status it had before. Every mark and remove is kept in chat_case_events.
// Runs inside PATCH's transaction on the locked row (`chat`); who may mark is checked before it.
// Marking never needs or changes the holder. Returns the answer and the line to log after commit.
const CASE_KINDS = ['refund', 'reship'];

async function setCase(
  client: PoolClient, chat: LockedChat, kind: string | null, user: AuthUser, staff: Actor, override: boolean,
): Promise<{ res: NextResponse; log: string | null }> {
  const actor = (user.displayName || user.username || '').trim() || 'support';
  const orderId = chat.verified_order_id || chat.phone_match_order_id || null;

  // Owner answer Q6 (2026-10-02, rulebook 9.4): while a refund form link is open or a refund request is
  // New / Approved, only the Super Admin removes or switches the Refund mark (the chat would otherwise
  // go back to an AI that never saw the form messages). Before refund-forms.sql: not locked.
  if (chat.case_kind === 'refund' && kind !== 'refund' && !isSuperAdmin(user) && await refundMarkLocked(client, chat)) {
    return { res: NextResponse.json({ error: 'A refund form is open for this chat. Only the Super Admin can change or remove the Refund mark now.' }, { status: 409 }), log: null };
  }

  if (kind) {
    if (!orderId) {
      return { res: NextResponse.json({ error: 'Only a verified customer can be marked for a refund or to ship again' }, { status: 400 }), log: null };
    }
    if (chat.case_kind === kind) return { res: NextResponse.json({ success: true, case_kind: kind }), log: null };
    await setActor(client, staff, 'case');
    // Switching from one to the other keeps the status the chat had before the first mark.
    const r = await client.query(
      `UPDATE conversations
          SET case_prev_status = CASE WHEN case_kind IS NULL THEN status ELSE case_prev_status END,
              case_kind = $2, case_marked_by = $3, case_marked_at = now(), case_order_id = $4,
              status = CASE WHEN status = 'resolved' THEN status ELSE 'agent_handling' END,
              auto_closed_at = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING case_kind, case_marked_by, case_marked_at, case_order_id, status`,
      [chat.id, kind, actor, orderId]
    );
    if (chat.case_kind) {
      await client.query(
        `INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
         VALUES ($1, $2, $3, $4, 'remove', $5, $6, $7)`,
        [crypto.randomUUID(), chat.id, chat.site_id, chat.case_kind, chat.case_order_id, actor, user.role]
      );
    }
    await client.query(
      `INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
       VALUES ($1, $2, $3, $4, 'mark', $5, $6, $7)`,
      [crypto.randomUUID(), chat.id, chat.site_id, kind, orderId, actor, user.role]
    );
    const row = r.rows[0];
    await logChatEvent(client, staff, {
      conversationId: chat.id, siteId: chat.site_id, kind: 'case_mark', fromStatus: chat.status, toStatus: row?.status ?? null,
      reason: 'case', meta: { case: kind, ...(chat.case_kind ? { from_case: chat.case_kind } : {}), ...(override ? { override: 'senior_away' } : {}) },
    });
    return { res: NextResponse.json({ success: true, ...row }), log: `[chat] conv ${chat.id} marked ${kind} by ${actor}${override ? ' (no senior around)' : ''}` };
  }

  if (!chat.case_kind) return { res: NextResponse.json({ success: true, case_kind: null }), log: null };
  await setActor(client, staff, 'case');
  const r = await client.query(
    `UPDATE conversations
        SET status = CASE WHEN status = 'resolved' THEN status
                          ELSE COALESCE(case_prev_status, 'agent_handling') END,
            case_kind = NULL, case_marked_by = NULL, case_marked_at = NULL, case_order_id = NULL, case_prev_status = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING status`,
    [chat.id]
  );
  await client.query(
    `INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
     VALUES ($1, $2, $3, $4, 'remove', $5, $6, $7)`,
    [crypto.randomUUID(), chat.id, chat.site_id, chat.case_kind, chat.case_order_id, actor, user.role]
  );
  const row = r.rows[0];
  await logChatEvent(client, staff, {
    conversationId: chat.id, siteId: chat.site_id, kind: 'case_remove', fromStatus: chat.status, toStatus: row?.status ?? null,
    reason: 'case', meta: { case: chat.case_kind },
  });
  return { res: NextResponse.json({ success: true, case_kind: null, status: row?.status }), log: `[chat] conv ${chat.id} ${chat.case_kind} mark removed by ${actor}` };
}
