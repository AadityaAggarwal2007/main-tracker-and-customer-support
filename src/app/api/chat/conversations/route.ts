import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';
import { parseInboxSearch } from '@/lib/chat/inbox-search';
import { HEALTH_PIN_MIN } from '@/lib/chat/health-rules';
import { INBOX_TOPICS, sqlLabelList, topicByKey } from '@/lib/chat/inbox-topics';
import { NO_REPLY_NEEDED_REGEX, WAITING_OVERDUE_HOURS } from '@/lib/chat/waiting';
import { displayNameSql, nameFromOrderSql, orderNameJoinSql } from '@/lib/chat/display-name';

export const dynamic = 'force-dynamic';

// ── GET /api/chat/conversations ────────────────────────────────
// The inbox list. Scoped to the panels this user may see, because the chat
// tables know nothing about ShipTrack's roles on their own.
//
// ?segment=visitors|customers splits visitors from known customers (verified, or a
// phone that matches an order in the panel: KNOWN_CUSTOMER below)
// (conversations.verified_order_id, see chat-verified.sql).
//
// A verified customer's widget chats on one site are one row (customer_key,
// see chat-customer-key.sql), with thread_count, group_unread and
// group_needs_human added.
//
// subject_label / subject_summary / subject_updated_at (chat-subject.sql) are
// the row's own chat's subject; on a grouped row that is the latest chat.
//
// ?q=<text> searches every chat of the panels the caller may see (name, phone,
// order ID / tracking ID, what was said; see src/lib/chat/inbox-search.ts). It
// ignores status, segment and category, so a Closed chat or a visitor is found
// too, and adds hit_order/hit_phone/hit_name/hit_text (why a row matched) and
// match_snippet (the text around the newest matching message). Matches are
// still grouped one row per customer, best matches (an order) first.
//
// health_score / health_reason / health_updated_at (chat-health.sql, how upset
// the customer is, 0-100) are shown as the row's health. An OPEN chat whose
// customer scores HEALTH_PIN_MIN or more (health_pinned) is listed first, the
// highest score first, and goes back to its normal place when it is Closed. It
// is the row's OWN chat that counts (on a grouped row, the latest one): that is
// the chat staff open and Close, and its score already reads the customer's
// earlier chats, so a row can always be cleared by closing what it opens.
// A search (?q=) keeps its own order, best matches first.
//
// waiting_since / waiting_overdue (src/lib/chat/waiting.ts): how long the
// customer has waited for an answer. Waiting chats that have gone
// WAITING_OVERDUE_HOURS without one come first (with the frustrated ones: an
// angry customer who is also being ignored is the very first), then the
// frustrated, then everything else by activity.
//
// ?topic=risk|refund|tracking|delay|address|damaged|exchange lists the OPEN
// chats of one problem (src/lib/chat/inbox-topics.ts: by subject label, or, for
// risk, by frustration score). The answer also carries topic_counts, the number
// of open customers per topic in the caller's scope whatever tab is open, and
// each row health_threat / health_accuse: the customer has threatened a
// chargeback, police or court, or called the store a fraud.
//
// display_name (src/lib/chat/display-name.ts): the name staff read. A chat tied to
// an order (verified, else phone-matched) shows the customer name ON THE ORDER,
// never one the customer typed; a chat with no order shows its own name.
// name_from_order says which. Never stored.
//
// sites.tracker_business_id is text and businesses.id is uuid, so every join
// between the two apps' tables compares as text.
// A customer the team can place: they proved an order (verified_order_id: order
// ID + last 4, the widget form, or the old lookups) or the number they typed or
// saved is on an order in this panel (phone_match_order_id, phone-match.ts).
// Visitors are everyone else. The AI only trusts verified_order_id.
const KNOWN_CUSTOMER = '(c.verified_order_id IS NOT NULL OR c.phone_match_order_id IS NOT NULL)';

// The SQL that puts an open chat under a problem tab (a = the table alias).
function topicCondition(key: string, labels: string[], a: string): string {
  if (key === 'risk') return `COALESCE(${a}.health_score, 0) >= ${HEALTH_PIN_MIN}`;
  if (key === 'fraud') {
    return `(COALESCE((${a}.health_signals->>'accuse')::int, 0) > 0 OR COALESCE((${a}.health_signals->>'threat')::int, 0) > 0)`;
  }
  return `${a}.subject_label = ANY(${sqlLabelList(labels)})`;
}

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('businessId') || '';
  const status = searchParams.get('status') || '';
  const category = searchParams.get('category') || '';
  // Visitors = chats that have not proved which order they own; Customers =
  // chats verified by the widget form or a found lookup. Left out, as the
  // status tabs do, it lists everyone.
  const segment = searchParams.get('segment') || '';
  const topic = topicByKey(searchParams.get('topic'));
  const limit = Math.min(parseInt(searchParams.get('limit') || '200', 10), 500);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  if (businessId) {
    // A user restricted to certain panels cannot read another one by asking.
    if (user.businessIds && user.businessIds.length > 0 && !user.businessIds.includes(businessId)) {
      return NextResponse.json({ conversations: [] });
    }
    conditions.push(`s.tracker_business_id::text = $${pi++}::text`);
    params.push(businessId);
  } else if (user.businessIds && user.businessIds.length > 0) {
    conditions.push(`s.tracker_business_id::text = ANY($${pi++}::text[])`);
    params.push(user.businessIds);
  }

  // The panel scope alone, for the topic counts (positions $1.. are the same).
  const scopeConditions = [...conditions];
  const scopeParams = [...params];

  // A search looks at every chat in the scope above; the tabs do not narrow it.
  const search = parseInboxSearch(searchParams.get('q'), pi);
  if (search.q) {
    params.push(...search.params);
    pi += search.params.length;
  } else {
    if (status) { conditions.push(`c.status = $${pi++}`); params.push(status); }
    if (category) { conditions.push(`c.category = $${pi++}`); params.push(category); }
    if (segment === 'visitors') conditions.push(`NOT ${KNOWN_CUSTOMER}`);
    else if (segment === 'customers') conditions.push(KNOWN_CUSTOMER);
    if (topic) {
      conditions.push("c.status <> 'resolved'");
      conditions.push(KNOWN_CUSTOMER);   // problem tabs are for customers; visitors stay under Visitors
      conditions.push(topicCondition(topic.key, topic.labels, 'c'));
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  // One row per verified customer (chat-customer-key.sql): widget chats that
  // share (site_id, customer_key) collapse into their most recent chat among
  // the rows the filters above kept. thread_count is how many of that
  // customer's chats matched, group_unread their unread messages together,
  // group_needs_human whether any of them waits for a person (the row shows
  // the latest chat's status, which can hide an older one in Needs you).
  // Every other row is its own group of one. Grouped here in SQL, before the
  // LIMIT, so the limit counts rows the inbox actually shows.
  // Who needs an answer first. Top: an angry customer who is also being ignored
  // (frustrated and overdue), then customers waiting 2 hours or more (longest
  // first), then frustrated ones (highest score first). Then everything else,
  // and any Closed chat, by latest activity. A search: best matches first.
  const orderBy = search.q
    ? `CASE WHEN g.hit_order THEN 0 WHEN g.hit_phone OR g.hit_name THEN 1 ELSE 2 END,
       g.last_message_at DESC NULLS LAST`
    : `CASE WHEN g.waiting_overdue AND g.is_pinned THEN 0
            WHEN g.waiting_overdue THEN 1
            WHEN g.is_pinned THEN 2
            ELSE 3 END,
       CASE WHEN g.is_pinned THEN g.health_score END DESC NULLS LAST,
       CASE WHEN g.waiting_overdue THEN g.waiting_since END ASC NULLS LAST,
       g.last_message_at DESC NULLS LAST`;

  // How many open customers (one per grouped row) each problem tab holds.
  const countsSql = `SELECT ${INBOX_TOPICS.map((t) => `count(DISTINCT x.gk) FILTER (WHERE ${
    topicCondition(t.key, t.labels, 'x')
  })::int AS ${t.key}`).join(', ')}
       FROM (SELECT c.subject_label, c.health_score, c.health_signals,
                    CASE WHEN c.customer_key IS NOT NULL AND c.source = 'chat'
                         THEN 'k:' || s.id || ':' || c.customer_key ELSE 'c:' || c.id END AS gk
               FROM conversations c
               JOIN sites s ON s.id = c.site_id
              WHERE ${[...scopeConditions, "c.status <> 'resolved'", KNOWN_CUSTOMER].join(' AND ')}) x`;
  const countsPromise = query<Record<string, number>>(countsSql, scopeParams).catch((err) => {
    // Before chat-health.sql / chat-subject.sql are applied the columns are missing.
    console.error('[inbox] topic counts failed:', (err as Error)?.message);
    return { rows: [] as Record<string, number>[] };
  });

  const result = await query(
    `WITH ${search.cte ? search.cte + ',' : ''}
     base AS (
       SELECT c.id, c.visitor_name, ${displayNameSql('c')} AS display_name, ${nameFromOrderSql()} AS name_from_order, c.visitor_phone, c.status, c.source, c.category,
              c.unread_count, c.last_message_at, c.created_at,
              c.verified_order_id, c.verified_via, c.customer_key, c.phone_match_order_id,
              c.subject_label, c.subject_summary, c.subject_updated_at,
              c.health_score, c.health_reason, c.health_updated_at, c.health_signals,
              s.id AS site_id, s.name AS site_name, s.tracker_business_id,
              b.name AS panel_name,
              CASE WHEN c.customer_key IS NOT NULL AND c.source = 'chat'
                   THEN 'k:' || c.customer_key ELSE 'c:' || c.id END AS group_key,
              CASE WHEN c.status = 'resolved' OR w.last_visitor_at IS NULL THEN NULL
                   WHEN w.last_agent_at IS NOT NULL AND w.last_agent_at > w.last_visitor_at THEN NULL
                   WHEN w.last_visitor_text ~* '${NO_REPLY_NEEDED_REGEX}' THEN NULL
                   WHEN c.status = 'human_needed' OR w.last_sender = 'visitor' THEN w.last_visitor_at
              END AS waiting_since,
              ${search.hitOrder} AS hit_order,
              ${search.hitPhone} AS hit_phone,
              ${search.hitName} AS hit_name,
              ${search.hitText} AS hit_text
         FROM conversations c
         JOIN sites s ON s.id = c.site_id
         LEFT JOIN businesses b ON b.id::text = s.tracker_business_id::text
         LEFT JOIN LATERAL (
           SELECT max(m.created_at) FILTER (WHERE m.sender = 'visitor') AS last_visitor_at,
                  max(m.created_at) FILTER (WHERE m.sender = 'agent') AS last_agent_at,
                  (array_agg(m.sender ORDER BY m.created_at DESC, m.id DESC))[1] AS last_sender,
                  (array_agg(m.content ORDER BY m.created_at DESC, m.id DESC) FILTER (WHERE m.sender = 'visitor'))[1] AS last_visitor_text
             FROM messages m
            WHERE m.conversation_id = c.id AND c.status <> 'resolved'
              AND m.sender <> 'tool_result'
              AND COALESCE(m.metadata->>'hidden', 'false') <> 'true'
              AND COALESCE(m.metadata->>'withheld', '') = ''
              AND m.content IS NOT NULL AND btrim(m.content) <> ''
              AND m.deleted_at IS NULL
         ) w ON true
         ${orderNameJoinSql('c', 's')}
         ${search.join}
         ${where}
     ), filtered AS (
       SELECT b.*,
              (b.waiting_since IS NOT NULL AND b.waiting_since <= now() - interval '${WAITING_OVERDUE_HOURS} hours') AS waiting_overdue,
              (b.status <> 'resolved' AND COALESCE(b.health_score, 0) >= ${HEALTH_PIN_MIN}) AS is_pinned
         FROM base b
       ${search.q ? 'WHERE hit_order OR hit_phone OR hit_name OR hit_text' : ''}
     ), grouped AS (
       SELECT f.*,
              row_number() OVER w AS group_rank,
              count(*) OVER (PARTITION BY f.site_id, f.group_key)::int AS thread_count,
              sum(f.unread_count) OVER (PARTITION BY f.site_id, f.group_key)::int AS group_unread,
              bool_or(f.status = 'human_needed') OVER (PARTITION BY f.site_id, f.group_key) AS group_needs_human
         FROM filtered f
       WINDOW w AS (PARTITION BY f.site_id, f.group_key
                    ORDER BY f.last_message_at DESC NULLS LAST, f.created_at DESC, f.id)
     )
     SELECT g.id, g.visitor_name, g.display_name, g.name_from_order, g.visitor_phone, g.status, g.source, g.category,
            g.unread_count, g.last_message_at, g.created_at,
            g.verified_order_id, g.verified_via, g.phone_match_order_id,
            g.site_id, g.site_name, g.tracker_business_id, g.panel_name,
            g.customer_key, g.thread_count, g.group_unread, g.group_needs_human,
            g.subject_label, g.subject_summary, g.subject_updated_at,
            g.health_score, g.health_reason, g.health_updated_at,
            COALESCE((g.health_signals->>'threat')::int, 0) > 0 AS health_threat,
            COALESCE((g.health_signals->>'accuse')::int, 0) > 0 AS health_accuse,
            g.is_pinned AS health_pinned,
            g.waiting_since, g.waiting_overdue,
            g.hit_order, g.hit_phone, g.hit_name, g.hit_text,
            ${search.snippet} AS match_snippet,
            (SELECT m.content
               FROM messages m
              WHERE m.conversation_id = g.id
                AND m.sender <> 'tool_result'
                AND COALESCE(m.metadata->>'hidden', 'false') <> 'true'
                AND m.content IS NOT NULL AND btrim(m.content) <> ''
                AND m.deleted_at IS NULL
              ORDER BY m.created_at DESC
              LIMIT 1) AS last_message
       FROM grouped g
      WHERE g.group_rank = 1
      ORDER BY ${orderBy}
      LIMIT $${pi}`,
    params
  );

  const counts = (await countsPromise).rows[0] || {};
  return NextResponse.json({ conversations: result.rows, topic_counts: counts });
}
