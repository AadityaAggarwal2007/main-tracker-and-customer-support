import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';
import { parseInboxSearch } from '@/lib/chat/inbox-search';
import { HEALTH_PIN_MIN } from '@/lib/chat/health-rules';
import { INBOX_TOPICS, sqlLabelList, topicByKey } from '@/lib/chat/inbox-topics';
import { WAITING_OVERDUE_HOURS } from '@/lib/chat/waiting';
import { WAITING_LATERAL, WAITING_SINCE_SQL } from '@/lib/chat/waiting-sql';
import { displayNameSql, nameFromOrderSql, orderNameJoinSql } from '@/lib/chat/display-name';
import { can } from '@/lib/permissions';
import { isOfficeHours } from '@/lib/office-hours';
import { staffActor, teamDirectory } from '@/lib/chat/team-routing';
import { OWNER_KEY } from '@/lib/chat/team-rules';
import { REFUND_LINK_SQL } from '@/lib/refund/link-mask';

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
// returned / auto_closed_at (src/lib/chat/auto-close.ts, chat-auto-close.sql): a chat the
// system closed after 4 quiet days that the customer has since written in again (it
// reopened by itself). Listed right after the overdue chats, above merely frustrated
// ones, until a person closes it or takes it over, so it is seen and closed fast.
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
// Chat team (owner, 2026-10-01; chat-team.sql, src/lib/chat/team-rules.ts): every row carries
// assigned_to / assigned_at, who holds the chat (team_users.id, 'owner' = Super Admin, null =
// nobody; on a grouped row the latest chat's). ?mine=1 lists the caller's own chats in Needs you or
// With team (never a Refund / Ship again chat, like every list but its section). The answer adds
// me (the caller's key), team (who is on the team, from memory: names, Senior, away / last seen),
// office_open (10:00-19:30 India time) and mine { open, waiting } for the My chats tab.
//
// sites.tracker_business_id is text and businesses.id is uuid, so every join
// between the two apps' tables compares as text.
// A customer the team can place: they proved an order (verified_order_id: order
// ID + last 4, the widget form, or the old lookups) or the number they typed or
// saved was on an order in this panel (phone_match_order_id: OLD chats only, the
// detection was retired on 2026-09-30, a phone number alone no longer files a chat as a customer).
// Visitors are everyone else. The AI only trusts verified_order_id.
// A customer whose message was marked `urgent` (widget route / email poller: a
// threat of a chargeback, police, court, legal action, bad reviews, or a fraud or
// fake-site claim, see escalation.ts) and whom no team member has answered since.
// The team owes them an answer within 1 hour, not 2. The mark is on the message
// itself, so it does not depend on the frustration scorer, does not expire after
// three more messages, and is not hidden by an "ok" from the customer.
const URGENT_OVERDUE_HOURS = 1;

const KNOWN_CUSTOMER = '(c.verified_order_id IS NOT NULL OR c.phone_match_order_id IS NOT NULL)';

// A marked chat shows only in its section, except a red Ship again chat (owner 2026-10-02, answer 8):
// it is also in Needs you and the other lists until a person replies, takes it over or closes it.
const OUTSIDE_SECTION = "(c.case_kind IS NULL OR (c.case_kind = 'reship' AND c.status = 'human_needed'))";

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
  if (!can(user, 'chat.view')) return NextResponse.json({ error: 'You cannot open Chat Support' }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('businessId') || '';
  const status = searchParams.get('status') || '';
  const category = searchParams.get('category') || '';
  // Visitors = chats that have not proved which order they own; Customers =
  // chats verified by the widget form or a found lookup. Left out, as the
  // status tabs do, it lists everyone.
  const segment = searchParams.get('segment') || '';
  // ?unread=1 lists only chats waiting for an answer (WAITING_SINCE_SQL; the inbox's "Unread" filter).
  const unreadOnly = searchParams.get('unread') === '1';
  const topic = topicByKey(searchParams.get('topic'));
  // ?case=refund|reship: the Refund / Ship again section (chat-cases.sql). A marked chat shows ONLY
  // there (and in a search); every other list leaves it out, except a red Ship again chat
  // (OUTSIDE_SECTION above).
  const caseParam = searchParams.get('case') || '';
  const caseKind = caseParam === 'refund' || caseParam === 'reship' ? caseParam : '';
  // The page asks for 200 and "Show more" asks for more (the answer's total says how many there are).
  const limit = Math.max(1, Math.min(parseInt(searchParams.get('limit') || '200', 10) || 200, 1000));
  // ?mine=1: My chats. The caller's key, as the chat team stores it (no waiting: the list never
  // refuses; a login with no key yet simply has no chats of its own).
  const mine = searchParams.get('mine') === '1';
  const me = staffActor(user)?.key ?? null;

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

  // A chat that was merged into the customer's own (merge-chats.ts) is an empty shell:
  // never listed, so a customer is one row and one chat.
  conditions.push('c.merged_into IS NULL');

  // The panel scope alone, for the topic counts (positions $1.. are the same).
  const scopeConditions = [...conditions];
  const scopeParams = [...params];

  // A search looks at every chat in the scope above; the tabs do not narrow it.
  const search = parseInboxSearch(searchParams.get('q'), pi);
  if (search.q) {
    params.push(...search.params);
    pi += search.params.length;
  } else {
    if (caseKind) {
      conditions.push(`c.case_kind = $${pi++}`);
      params.push(caseKind);
    } else {
      conditions.push(OUTSIDE_SECTION);
    }
    if (status && !caseKind) { conditions.push(`c.status = $${pi++}`); params.push(status); }
    if (mine) {
      if (me) {
        conditions.push(`c.assigned_to = $${pi++} AND c.status IN ('human_needed', 'agent_handling')`);
        params.push(me);
      } else {
        conditions.push('false');
      }
    }
    // All / Customers / Visitors list OPEN chats; a Closed chat moves to Closed (owner, 2026-10-01:
    // a closed chat used to stay in its place there, only its label changed).
    if (!status && !caseKind && !topic) conditions.push("c.status <> 'resolved'");
    if (category) { conditions.push(`c.category = $${pi++}`); params.push(category); }
    if (segment === 'visitors' && !caseKind) conditions.push(`NOT ${KNOWN_CUSTOMER}`);
    else if (segment === 'customers' && !caseKind) conditions.push(KNOWN_CUSTOMER);
    if (topic && !caseKind) {
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
  // Newest activity first (owner, 2026-09-30): the chat that was written in last is on
  // top, so today's chats are at the top and a new chat appears at the top. It used to
  // put customers waiting 2 hours or more (and threats and frauds) first, and a chat
  // waiting since last week sat above everything from today. Those chats are still
  // marked (red Waiting timer, overdue colour, Fraud / Threat and At risk chips, the
  // Needs you tab and its counts), just not lifted out of date order. A search: best
  // matches first.
  const orderBy = search.q
    ? `CASE WHEN g.hit_order THEN 0 WHEN g.hit_phone OR g.hit_name THEN 1 ELSE 2 END,
       g.last_message_at DESC NULLS LAST`
    : `g.last_message_at DESC NULLS LAST, g.created_at DESC`;

  // How many open customers (one per grouped row) each problem tab holds.
  const countsSql = `SELECT ${INBOX_TOPICS.map((t) => `count(DISTINCT x.gk) FILTER (WHERE ${
    topicCondition(t.key, t.labels, 'x')
  })::int AS ${t.key}`).join(', ')}
       FROM (SELECT c.subject_label, c.health_score, c.health_signals,
                    CASE WHEN c.customer_key IS NOT NULL AND c.source = 'chat'
                         THEN 'k:' || s.id || ':' || c.customer_key ELSE 'c:' || c.id END AS gk
               FROM conversations c
               JOIN sites s ON s.id = c.site_id
              WHERE ${[...scopeConditions, "c.status <> 'resolved'", KNOWN_CUSTOMER, OUTSIDE_SECTION].join(' AND ')}) x`;
  const countsPromise = query<Record<string, number>>(countsSql, scopeParams).catch((err) => {
    // Before chat-health.sql / chat-subject.sql are applied the columns are missing.
    console.error('[inbox] topic counts failed:', (err as Error)?.message);
    return { rows: [] as Record<string, number>[] };
  });

  // How many open chats (one per customer) wait for an answer in this login's panels, whatever tab
  // is open: the number beside "Chat Support" (it used to add up unread messages, AI replies too).
  // In the same pass, the My chats tab's numbers: the caller's own chats in Needs you or With team
  // (mine_open), and how many of those wait for an answer (mine_waiting). FILTERs, not an outer
  // WHERE, so n is exactly the number it always was. Asked alongside the list.
  const meParam = `$${scopeParams.length + 1}`;
  const unansweredPromise = query<{ n: number; mine_open: number; mine_waiting: number }>(
    `SELECT count(DISTINCT x.gk) FILTER (WHERE x.waiting_since IS NOT NULL)::int AS n,
            count(DISTINCT x.gk) FILTER (WHERE x.assigned_to = ${meParam} AND x.status IN ('human_needed', 'agent_handling'))::int AS mine_open,
            count(DISTINCT x.gk) FILTER (WHERE x.assigned_to = ${meParam} AND x.status IN ('human_needed', 'agent_handling')
                                           AND x.waiting_since IS NOT NULL)::int AS mine_waiting
       FROM (SELECT CASE WHEN c.customer_key IS NOT NULL AND c.source = 'chat'
                         THEN 'k:' || s.id || ':' || c.customer_key ELSE 'c:' || c.id END AS gk,
                    c.assigned_to, c.status,
                    ${WAITING_SINCE_SQL} AS waiting_since
               FROM conversations c
               JOIN sites s ON s.id = c.site_id
               ${WAITING_LATERAL}
              WHERE ${[...scopeConditions, "c.status <> 'resolved'", OUTSIDE_SECTION].join(' AND ')}) x`,
    [...scopeParams, me ?? '']
  ).then((u) => u.rows[0] ?? { n: 0, mine_open: 0, mine_waiting: 0 }).catch((err) => {
    console.error('[inbox] unanswered count failed:', (err as Error)?.message);
    return null;
  });

  // The Super Admin's "Give all N to the team" (My chats): N is exactly what POST
  // /api/chat/team/release frees (the same WHERE: every open chat he holds, one by one, in any panel,
  // status or Refund / Ship again section), not mine_open (customers, Needs you / With team only).
  // Uses conversations_assigned_open_idx. 0 for everyone else.
  const heldPromise = me === OWNER_KEY
    ? query<{ n: number }>(
        `SELECT count(*)::int AS n FROM conversations
          WHERE assigned_to = $1 AND status <> 'resolved' AND merged_into IS NULL`,
        [OWNER_KEY]
      ).then((r) => r.rows[0]?.n ?? 0).catch(() => 0)
    : Promise.resolve(0);

  // case_mark_role: who made a marked chat's latest mark (chat_case_events.actor_role): 'system' = Chikki's
  // live Ship again mark (the customer was promised a new tracking link), 'backfill' = the one-time move of
  // 2 Oct (no message was sent). The inbox words the chip and the Remove question by it.
  // last_message: a refund form link (owner 2026-10-02) shows as "[refund form link]" in the list, for
  // every login (REFUND_LINK_SQL has no quotes or backslashes, so it is safe inside the literal).
  const result = await query(
    `WITH ${search.cte ? search.cte + ',' : ''}
     base AS (
       SELECT c.id, c.visitor_name, ${displayNameSql('c')} AS display_name, ${nameFromOrderSql()} AS name_from_order, c.visitor_phone, c.status, c.source, c.category,
              c.unread_count, c.last_message_at, c.created_at,
              c.verified_order_id, c.verified_via, c.customer_key, c.phone_match_order_id,
              c.subject_label, c.subject_summary, c.subject_updated_at,
              c.health_score, c.health_reason, c.health_updated_at, c.health_signals,
              c.auto_closed_at, c.closed_by_name, c.closed_at,
              c.case_kind, c.case_marked_by, c.case_marked_at, c.case_order_id,
              CASE WHEN c.case_kind IS NOT NULL THEN
                (SELECT e.actor_role FROM chat_case_events e
                  WHERE e.conversation_id = c.id AND e.kind = c.case_kind AND e.action = 'mark'
                  ORDER BY e.created_at DESC LIMIT 1) END AS case_mark_role,
              c.assigned_to, c.assigned_at,
              s.id AS site_id, s.name AS site_name, s.tracker_business_id,
              b.name AS panel_name,
              CASE WHEN c.customer_key IS NOT NULL AND c.source = 'chat'
                   THEN 'k:' || c.customer_key ELSE 'c:' || c.id END AS group_key,
              ${WAITING_SINCE_SQL} AS waiting_since,
              CASE WHEN c.status = 'resolved' OR w.last_urgent_at IS NULL THEN NULL
                   WHEN w.last_agent_at IS NOT NULL AND w.last_agent_at > w.last_urgent_at THEN NULL
                   ELSE w.last_urgent_at
              END AS urgent_since,
              ${search.hitOrder} AS hit_order,
              ${search.hitPhone} AS hit_phone,
              ${search.hitName} AS hit_name,
              ${search.hitText} AS hit_text
         FROM conversations c
         JOIN sites s ON s.id = c.site_id
         LEFT JOIN businesses b ON b.id::text = s.tracker_business_id::text
         ${WAITING_LATERAL}
         ${orderNameJoinSql('c', 's')}
         ${search.join}
         ${where}
     ), filtered AS (
       SELECT b.*,
              ((b.waiting_since IS NOT NULL AND b.waiting_since <= now() - interval '${WAITING_OVERDUE_HOURS} hours')
               OR (b.urgent_since IS NOT NULL AND b.urgent_since <= now() - interval '${URGENT_OVERDUE_HOURS} hour')) AS waiting_overdue,
              (b.status <> 'resolved' AND COALESCE(b.health_score, 0) >= ${HEALTH_PIN_MIN}) AS is_pinned,
              (b.status <> 'resolved' AND b.auto_closed_at IS NOT NULL
               AND (b.verified_order_id IS NOT NULL OR b.phone_match_order_id IS NOT NULL)) AS returned
         FROM base b
       ${search.q ? 'WHERE hit_order OR hit_phone OR hit_name OR hit_text'
         : unreadOnly ? 'WHERE b.waiting_since IS NOT NULL' : ''}
     ), grouped AS (
       SELECT f.*,
              row_number() OVER w AS group_rank,
              count(*) OVER (PARTITION BY f.site_id, f.group_key)::int AS thread_count,
              sum(f.unread_count) OVER (PARTITION BY f.site_id, f.group_key)::int AS group_unread,
              bool_or(f.status = 'human_needed') OVER (PARTITION BY f.site_id, f.group_key) AS group_needs_human,
              min(f.urgent_since) OVER (PARTITION BY f.site_id, f.group_key) AS group_urgent_since,
              min(f.waiting_since) OVER (PARTITION BY f.site_id, f.group_key) AS group_waiting_since
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
            g.returned, g.auto_closed_at, g.closed_by_name, g.closed_at,
            g.case_kind, g.case_marked_by, g.case_marked_at, g.case_order_id, g.case_mark_role,
            g.assigned_to, g.assigned_at,
            g.waiting_since, g.waiting_overdue, (g.group_urgent_since IS NOT NULL) AS urgent_waiting,
            (g.group_waiting_since IS NOT NULL) AS group_waiting,
            g.hit_order, g.hit_phone, g.hit_name, g.hit_text,
            count(*) OVER ()::int AS total_rows,
            ${search.snippet} AS match_snippet,
            (SELECT regexp_replace(m.content, '${REFUND_LINK_SQL}', '[refund form link]', 'gi')
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
  // How many rows there are in all (the page shows 200 at a time, "Show more" for the rest).
  const total = (result.rows[0] as { total_rows?: number } | undefined)?.total_rows ?? 0;
  for (const r of result.rows as Record<string, unknown>[]) delete r.total_rows;

  const unanswered = await unansweredPromise;
  const held = await heldPromise;
  const unansweredTotal = unanswered ? unanswered.n : null;

  // How many chats each section holds (and how many wait for an answer), for the sidebar; for the section that is open,
  // who marked how many per day (India time) over the last 14 days, for the owner's experts.
  const caseCounts: Record<string, { total: number; unread: number }> = { refund: { total: 0, unread: 0 }, reship: { total: 0, unread: 0 } };
  let caseSummary: { marked_by: string; day: string; n: number }[] = [];
  try {
    const cc = await query<{ case_kind: string; total: number; unread: number }>(
      `SELECT c.case_kind, count(*)::int AS total,
              count(*) FILTER (WHERE (${WAITING_SINCE_SQL}) IS NOT NULL)::int AS unread
         FROM conversations c JOIN sites s ON s.id = c.site_id
         ${WAITING_LATERAL}
        WHERE ${[...scopeConditions, 'c.case_kind IS NOT NULL'].join(' AND ')}
        GROUP BY c.case_kind`,
      scopeParams
    );
    for (const r of cc.rows) caseCounts[r.case_kind] = { total: r.total, unread: r.unread };
    if (caseKind) {
      const sm = await query<{ marked_by: string; day: string; n: number }>(
        `SELECT COALESCE(c.case_marked_by, '?') AS marked_by,
                to_char(c.case_marked_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
                count(*)::int AS n
           FROM conversations c JOIN sites s ON s.id = c.site_id
          WHERE ${[...scopeConditions, `c.case_kind = $${scopeParams.length + 1}`, `c.case_marked_at > now() - interval '14 days'`].join(' AND ')}
          GROUP BY 1, 2
          ORDER BY 2 DESC, 3 DESC`,
        [...scopeParams, caseKind]
      );
      caseSummary = sm.rows;
    }
  } catch (err) {
    // Before chat-cases.sql is applied the columns are missing.
    console.error('[inbox] case counts failed:', (err as Error)?.message);
  }

  const now = Date.now();
  return NextResponse.json({
    conversations: result.rows, total, unanswered_total: unansweredTotal,
    topic_counts: counts, case_counts: caseCounts, case_summary: caseSummary,
    me, team: teamDirectory(now), office_open: isOfficeHours(now),
    mine: { open: unanswered?.mine_open ?? 0, waiting: unanswered?.mine_waiting ?? 0, held },
  });
}
