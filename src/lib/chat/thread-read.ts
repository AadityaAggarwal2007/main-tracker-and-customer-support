import { AuthUser, teamLoaded } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { displayNameSql, nameFromOrderSql, orderNameJoinSql } from './display-name';
import { nameOfKey } from './team-routing';
import { LIGHT_MAX, THREAD_PAGE } from './thread-sync';

export interface ConversationRow {
  id: string; site_id: string; visitor_name: string | null; display_name: string | null; name_from_order: boolean; visitor_phone: string | null;
  status: string; source: string; category: string; unread_count: number;
  last_message_at: string | null; created_at: string;
  site_name: string; tracker_business_id: string | null; panel_name: string | null;
  verified_order_id: string | null; verified_via: string | null; phone_match_order_id: string | null;
  customer_key: string | null;
  subject_label: string | null; subject_summary: string | null; subject_updated_at: string | null;
  health_score: number | null; health_reason: string | null; health_updated_at: string | null;
  // The counts behind the score (chat-health.sql) and the model's own number `llm` (health.ts), read by hotOf.
  health_signals?: Record<string, unknown> | null;
  // The newest urgent marker ('threat' / 'accusation', escalation.ts) on a customer message no team member
  // has answered since, else null (hotOf below; the list route's urgent_since, one chat).
  urgent_open?: string | null;
  auto_closed_at: string | null;
  closed_by_name: string | null; closed_at: string | null;
  case_kind: string | null; case_marked_by: string | null; case_marked_at: string | null; case_order_id: string | null; case_prev_status: string | null;
  // Ship again: the new parcel was sent (chat-reship-done.sql, owner 2026-10-03).
  reshipped_at: string | null; reshipped_by: string | null; reship_awb: string | null; reship_link: string | null;
  // The latest mark's chat_case_events.actor_role: 'system' (Chikki's live mark) or 'backfill' (the one-time move).
  case_mark_role?: string | null;
  // Who holds the chat (chat-team.sql): team_users.id, 'owner' (Super Admin) or null (nobody).
  assigned_to: string | null; assigned_at: string | null;
  merged_into: string | null;
}

// Reachable only if the conversation's panel is one this user may see.
export async function loadForUser(id: string, user: AuthUser): Promise<ConversationRow | null> {
  const conv = await queryOne<ConversationRow>(
    `SELECT c.id, c.site_id, c.visitor_name, ${displayNameSql('c')} AS display_name, ${nameFromOrderSql()} AS name_from_order, c.visitor_phone, c.status, c.source,
            c.category, c.unread_count, c.last_message_at, c.created_at,
            c.verified_order_id, c.verified_via, c.customer_key, c.phone_match_order_id,
            c.subject_label, c.subject_summary, c.subject_updated_at,
            c.health_score, c.health_reason, c.health_updated_at, c.health_signals, c.auto_closed_at, c.closed_by_name, c.closed_at,
            c.case_kind, c.case_marked_by, c.case_marked_at, c.case_order_id, c.case_prev_status,
            c.reshipped_at, c.reshipped_by, c.reship_awb, c.reship_link,
            CASE WHEN c.case_kind IS NOT NULL THEN
              (SELECT e.actor_role FROM chat_case_events e
                WHERE e.conversation_id = c.id AND e.kind = c.case_kind AND e.action = 'mark'
                ORDER BY e.created_at DESC LIMIT 1) END AS case_mark_role,
            (SELECT u.metadata->>'urgent' FROM messages u
              WHERE u.conversation_id = c.id AND u.sender = 'visitor' AND u.deleted_at IS NULL
                AND u.metadata->>'urgent' IN ('threat', 'accusation')
                AND COALESCE(u.metadata->>'hidden', 'false') <> 'true'
                AND NOT EXISTS (SELECT 1 FROM messages a
                                 WHERE a.conversation_id = c.id AND a.sender = 'agent' AND a.deleted_at IS NULL
                                   AND COALESCE(a.metadata->>'hidden', 'false') <> 'true' AND COALESCE(a.metadata->>'withheld', '') = ''
                                   AND a.content IS NOT NULL AND btrim(a.content) <> '' AND a.created_at > u.created_at)
              ORDER BY (u.metadata->>'urgent' = 'threat') DESC, u.created_at DESC LIMIT 1) AS urgent_open,
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

export async function loadCustomerThread(conv: ConversationRow, user: AuthUser): Promise<CustomerThread> {
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

// Loaders for GET's answer, moved out of the route on 2026-10-02 (pure move): GET awaits each at the same place as before.
// Since 2026-10-10 (step 6, thread-sync.ts) a full load brings the newest THREAD_PAGE messages and how many are older
// (`older`); `before` = "Load older" (the page before that message); `after` = the 3-second poll (what was written,
// edited or deleted since, at most LIGHT_MAX).
export async function loadThreadMessages(id: string, opts: { after?: string | null; before?: { at: string; id: string } | null } = {}) {
  // tool_result rows and the hidden tool bookkeeping are context for the model,
  // not part of the conversation a person reads. Deleted messages stay in the
  // list, marked, so the team can see what was removed and by whom.
  // `brain` = the Brain notes the agent was shown for that reply (brain_usage, staff only).
  // Before chat-brain-usage.sql is applied the table is missing: read without it then.
  const params: unknown[] = [id];
  let cond = '';
  if (opts.after) {
    params.push(opts.after);
    cond = ` AND (created_at > $2::timestamptz OR edited_at > $2::timestamptz OR deleted_at > $2::timestamptz)`;
  } else if (opts.before) {
    params.push(opts.before.at, opts.before.id);
    cond = ` AND (created_at, id::text) < ($2::timestamptz, $3::text)`;
  }
  const limit = opts.after ? LIGHT_MAX : THREAD_PAGE;
  const messagesSql = (withBrain: boolean) => `SELECT m.id, m.sender, m.content, m.metadata, m.created_at, m.edited_at, m.edited_by, m.deleted_at, m.deleted_by${
    withBrain ? `, (SELECT u.notes FROM brain_usage u WHERE u.message_id = m.id) AS brain` : ''}, m.match_total
       FROM (SELECT id, sender, content, metadata, created_at, edited_at, edited_by, deleted_at, deleted_by, count(*) OVER ()::int AS match_total
               FROM messages
              WHERE conversation_id = $1
                AND ${STAFF_MESSAGE_SQL}${cond}
              ORDER BY created_at DESC, id::text DESC
              LIMIT ${limit}) m
      ORDER BY m.created_at ASC, m.id::text ASC`;
  const messages = await query<Record<string, unknown>>(messagesSql(true), params).catch(() => query<Record<string, unknown>>(messagesSql(false), params));
  const total = Number(messages.rows[0]?.match_total ?? 0);
  for (const m of messages.rows) delete m.match_total;
  return { rows: messages.rows, older: Math.max(0, total - messages.rows.length) };
}

export async function loadWriters(agentIds: string[]) {
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
  return writers;
}

export async function loadTeamLog(id: string) {
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
    [id]
  ).then((r) => r.rows.map((e) => ({
    ...e,
    actor_name: nameOfKey(e.actor) ?? e.actor_name,
    from_name: e.from_owner ? nameOfKey(e.from_owner) ?? 'A former member' : null,
    to_name: e.to_owner ? nameOfKey(e.to_owner) ?? 'A former member' : null,
  }))).catch(() => []);
  return teamLog;
}
