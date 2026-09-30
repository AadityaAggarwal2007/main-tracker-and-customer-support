import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest, AuthUser } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { loadOrderFacts } from '@/lib/chat/order-facts';
import { displayNameSql, nameFromOrderSql, orderNameJoinSql } from '@/lib/chat/display-name';

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
}

// Reachable only if the conversation's panel is one this user may see.
async function loadForUser(id: string, user: AuthUser): Promise<ConversationRow | null> {
  const conv = await queryOne<ConversationRow>(
    `SELECT c.id, c.site_id, c.visitor_name, ${displayNameSql('c')} AS display_name, ${nameFromOrderSql()} AS name_from_order, c.visitor_phone, c.status, c.source,
            c.category, c.unread_count, c.last_message_at, c.created_at,
            c.verified_order_id, c.verified_via, c.customer_key, c.phone_match_order_id,
            c.subject_label, c.subject_summary, c.subject_updated_at,
            c.health_score, c.health_reason, c.health_updated_at,
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

  const conversation = await loadForUser(params.id, user);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // tool_result rows and the hidden tool bookkeeping are context for the model,
  // not part of the conversation a person reads. Deleted messages stay in the
  // list, marked, so the team can see what was removed and by whom.
  const messages = await query(
    `SELECT id, sender, content, metadata, created_at, edited_at, edited_by, deleted_at, deleted_by
       FROM messages
      WHERE conversation_id = $1
        AND ${STAFF_MESSAGE_SQL}
      ORDER BY created_at ASC`,
    [params.id]
  );

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
  if (user.role === 'viewer') {
    return NextResponse.json({ error: 'Viewers cannot change conversations' }, { status: 403 });
  }

  const conversation = await loadForUser(params.id, user);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const { status } = await request.json();
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Unknown status' }, { status: 400 });
    }

    await query(
      `UPDATE conversations
          SET status = $1,
              unread_count = CASE WHEN $1 = 'resolved' THEN 0 ELSE unread_count END,
              updated_at = now()
        WHERE id = $2`,
      [status, params.id]
    );

    return NextResponse.json({ success: true, status });
  } catch {
    return NextResponse.json({ error: 'Could not update that conversation' }, { status: 500 });
  }
}
