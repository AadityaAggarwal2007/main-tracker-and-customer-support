import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest, AuthUser } from '@/lib/auth';
import crypto from 'crypto';
import { query, queryOne, withTransaction } from '@/lib/db';
import { loadOrderFacts } from '@/lib/chat/order-facts';
import { displayNameSql, nameFromOrderSql, orderNameJoinSql } from '@/lib/chat/display-name';
import { can, canAccessPanel } from '@/lib/permissions';

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

  return NextResponse.json({
    conversation,
    messages: messages.rows,
    earlier: thread.earlier,
    earlier_total: thread.earlierTotal,
    newer_chat: thread.newer,
    order_facts: orderFacts,
  });
}

// ── PATCH /api/chat/conversations/:id ──────────────────────────
// Take over, hand back to the AI, or close. These were socket events in the old
// app; with the inbox polling they are an ordinary request.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.reply')) {
    return NextResponse.json({ error: 'You cannot change conversations' }, { status: 403 });
  }

  const conversation = await loadForUser(params.id, user);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const body = await request.json();

    // Refund / Ship again (chat-cases.sql, owner 2026-10-01): { caseKind: 'refund' | 'reship' | null }.
    if (body && Object.prototype.hasOwnProperty.call(body, 'caseKind')) {
      if (!can(user, 'chat.cases')) return NextResponse.json({ error: 'You cannot mark Refund / Ship again' }, { status: 403 });
      return await setCase(conversation, body.caseKind, user);
    }

    const { status } = body;
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Unknown status' }, { status: 400 });
    }
    // A Refund / Ship again chat is the team's: the AI stays off until the mark is removed.
    if (status === 'ai_handling' && conversation.case_kind) {
      return NextResponse.json({ error: 'Remove the Refund / Ship again mark before handing this chat to the AI' }, { status: 409 });
    }

    // Close, Take over and Hand to AI are a person acting on the chat, so the
    // "came back after the auto-close" mark (chat-auto-close.sql) is cleared. A
    // Close also records who pressed it (chat-closed-by.sql), so a Closed chat says
    // "Closed by support" and not "Closed by AI". Closing a chat that is
    // already Closed changes neither the mark nor the name.
    const updated = await queryOne<{ status: string; closed_by_name: string | null; closed_at: string | null; auto_closed_at: string | null }>(
      `UPDATE conversations
          SET status = $1,
              unread_count = CASE WHEN $1 = 'resolved' THEN 0 ELSE unread_count END,
              closed_by_name = CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN $3::text ELSE closed_by_name END,
              closed_at = CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN now() ELSE closed_at END,
              auto_closed_at = CASE WHEN $1 = 'resolved' AND status = 'resolved' THEN auto_closed_at ELSE NULL END,
              updated_at = now()
        WHERE id = $2
        RETURNING status, closed_by_name, closed_at, auto_closed_at`,
      [status, params.id, (user.displayName || user.username || '').trim() || 'support']
    );

    // What the database now says about who closed it, so the screen shows that
    // and not its own guess (a chat the auto-close closed a moment ago stays
    // "Closed by AI" even if someone pressed Close on a stale screen).
    return NextResponse.json({
      success: true,
      status,
      closed_by_name: updated?.closed_by_name ?? null,
      closed_at: updated?.closed_at ?? null,
      auto_closed_at: updated?.auto_closed_at ?? null,
    });
  } catch {
    return NextResponse.json({ error: 'Could not update that conversation' }, { status: 500 });
  }
}

// ── Refund / Ship again ─────────────────────────────────────────────
// Marking: only a known customer's chat (verified, or an old phone match: the Customers list),
// never a visitor's. The chat leaves every other inbox list and shows only under its section, the
// AI stops (agent_handling), and nothing is sent to the customer. Removing: the chat goes back to
// the status it had before. Every mark and remove is kept in chat_case_events.
const CASE_KINDS = ['refund', 'reship'];

async function setCase(conversation: ConversationRow, raw: unknown, user: AuthUser) {
  const kind = raw === null || raw === '' ? null : String(raw);
  if (kind !== null && !CASE_KINDS.includes(kind)) {
    return NextResponse.json({ error: 'Unknown case' }, { status: 400 });
  }
  const actor = (user.displayName || user.username || '').trim() || 'support';
  const orderId = conversation.verified_order_id || conversation.phone_match_order_id || null;

  if (kind) {
    if (!orderId) {
      return NextResponse.json({ error: 'Only a verified customer can be marked for a refund or to ship again' }, { status: 400 });
    }
    if (conversation.case_kind === kind) return NextResponse.json({ success: true, case_kind: kind });
    const row = await withTransaction(async (client) => {
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
        [conversation.id, kind, actor, orderId]
      );
      if (conversation.case_kind) {
        await client.query(
          `INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
           VALUES ($1, $2, $3, $4, 'remove', $5, $6, $7)`,
          [crypto.randomUUID(), conversation.id, conversation.site_id, conversation.case_kind, conversation.case_order_id, actor, user.role]
        );
      }
      await client.query(
        `INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
         VALUES ($1, $2, $3, $4, 'mark', $5, $6, $7)`,
        [crypto.randomUUID(), conversation.id, conversation.site_id, kind, orderId, actor, user.role]
      );
      return r.rows[0];
    });
    console.log(`[chat] conv ${conversation.id} marked ${kind} by ${actor}`);
    return NextResponse.json({ success: true, ...row });
  }

  if (!conversation.case_kind) return NextResponse.json({ success: true, case_kind: null });
  const row = await withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE conversations
          SET status = CASE WHEN status = 'resolved' THEN status
                            ELSE COALESCE(case_prev_status, 'agent_handling') END,
              case_kind = NULL, case_marked_by = NULL, case_marked_at = NULL, case_order_id = NULL, case_prev_status = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING status`,
      [conversation.id]
    );
    await client.query(
      `INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
       VALUES ($1, $2, $3, $4, 'remove', $5, $6, $7)`,
      [crypto.randomUUID(), conversation.id, conversation.site_id, conversation.case_kind, conversation.case_order_id, actor, user.role]
    );
    return r.rows[0];
  });
  console.log(`[chat] conv ${conversation.id} ${conversation.case_kind} mark removed by ${actor}`);
  return NextResponse.json({ success: true, case_kind: null, status: row?.status });
}
