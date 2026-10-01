import { query } from '@/lib/db';
import { AI_NOT_AN_ANSWER_REGEX, NO_REPLY_NEEDED_REGEX } from '@/lib/chat/waiting';

// ── Closing chats that have gone quiet ─────────────────────────
// Asked for by the owner on 2026-09-30 (chat-auto-close.sql): a chat nobody has
// written in for AUTO_CLOSE_DAYS days, whose customer is not waiting for an
// answer, is Closed by the system. NOTHING is sent to the customer. The inbox and
// the At risk tabs then show today's chats instead of weeks of old ones; a chat
// that was angry on the 22nd is not a live risk on the 30th (and stays findable:
// Closed tab, search, and its frustration score is kept).
//
// NEVER closed here (customers; a visitor's widget chat closes after AUTO_CLOSE_VISITOR_HOURS whatever):
//   - a chat whose customer is still waiting for an answer: the inbox's "Waiting"
//     rule (waiting.ts, the list route) and a little more. Silence from OUR side is
//     not "the customer went quiet", closing it would hide the very person about to
//     charge back. Also counted as waiting: a chat someone owns (Needs you, or taken
//     over) that no team member has written in since the customer's last message; a
//     Needs you chat with no team reply ever, even if the customer's last word is
//     "thanks"; and a chat whose last AI message is not an answer (the "took longer
//     than expected" apology, or "let me get that confirmed by our team" with no
//     escalation), AI_NOT_AN_ANSWER_REGEX. Those stay open until someone answers.
//   - a CUSTOMER's chat that is PROTECTED (master rules section 24; a visitor's chat is
//     never protected, owner 2026-09-30, and since 2026-10-01 a quiet visitor chat is closed
//     even when the visitor's last message is unanswered): still in Needs you; about a
//     refund, cancellation or payment (subject label, or a message the widget / email
//     marked `routine`, or the health scorer counted a refund demand); a threat or a
//     fraud claim (message marked `urgent`, or the health scorer's threat / accuse
//     counts); or one where the customer sent card / OTP details (`sensitive_hidden`).
//     Asked for by the owner: these stay open until a team member closes them,
//     however quiet, because a refund or a complaint nobody finished is exactly what
//     turns into a chargeback. Chats already closed before this (2026-09-30) are left
//     as they are, by the owner's order.
//   - a chat with any message, or that a person or the customer touched (Take over,
//     Hand to AI, the verify form reopening it: updated_at), in the last
//     AUTO_CLOSE_DAYS days. Without that a chat reopened by the verify form (which
//     writes no message) was closed again within the hour.
//
// When the customer writes again the chat reopens by itself (widget message,
// form, email) and, because auto_closed_at is still set, the inbox shows it
// near the top as "Came back" until a person closes it or takes it over
// (PATCH /api/chat/conversations/[id] and a staff reply clear the mark).
// Called from GET /api/cron/chat-auto-close (VPS cron). Idempotent.

export const AUTO_CLOSE_DAYS = 4;

// A VISITOR's chat (a widget chat nobody has verified yet, and not an old phone-match
// customer) is closed after this many quiet HOURS instead of days (owner, 2026-09-30:
// 4 hours; 2026-10-01: 2 hours, and EVERY visitor chat, "sirf visitors ki"): a visitor
// who asked a question and left is done, and the Visitors tab should show the ones
// talking now. Since 2026-10-01 nothing keeps a quiet visitor chat open: not an
// unanswered last message, not a refund / chargeback / fraud / payment / card topic
// (a visitor's chat was never PROTECTED; the owner approved closing those too,
// master rules 24 owner note). Nothing is sent and nothing is deleted; the visitor's
// next message reopens it. Email threads are slower and keep the days.
export const AUTO_CLOSE_VISITOR_HOURS = 2;

// A visitor's widget chat: same test as the inbox's Visitors / Customers split.
const IS_VISITOR_SQL = `(c.source = 'chat' AND c.verified_order_id IS NULL AND c.phone_match_order_id IS NULL)`;
// The quiet window of ONE chat: hours for a visitor's widget chat, days otherwise.
// $1 = days, $2 = visitor hours.
const WINDOW_SQL = `(CASE WHEN ${IS_VISITOR_SQL}
                         THEN make_interval(hours => $2::int) ELSE make_interval(days => $1::int) END)`;

// Chats open right now (any status but Closed) and quiet for their window (WINDOW_SQL).
// `w` mirrors the list route's waiting join (its message filters are the list's own);
// customer_waiting is that rule made STRICTER, never looser: whatever the inbox shows
// as waiting is waiting here too (checked against the live list, see AGENTS.md).
const CANDIDATES_SQL = `
  SELECT c.id,
         ${IS_VISITOR_SQL} AS is_visitor,
         (w.last_visitor_at IS NOT NULL
          AND NOT (w.last_agent_at IS NOT NULL AND w.last_agent_at > w.last_visitor_at)
          AND (
                (NOT (w.last_visitor_text ~* '${NO_REPLY_NEEDED_REGEX}')
                 AND (c.status IN ('human_needed', 'agent_handling')
                      OR w.last_sender = 'visitor'
                      OR (w.last_sender = 'ai' AND w.last_ai_text ~* '${AI_NOT_AN_ANSWER_REGEX}')))
                OR (c.status = 'human_needed' AND w.last_agent_at IS NULL)
              )) AS customer_waiting,
         ((c.verified_order_id IS NOT NULL OR c.phone_match_order_id IS NOT NULL)
          AND (c.status = 'human_needed'
          OR COALESCE(c.subject_label, '') ~* '(refund|cancel|payment)'
          OR COALESCE((c.health_signals->>'refund')::int, 0) > 0
          OR COALESCE((c.health_signals->>'threat')::int, 0) > 0
          OR COALESCE((c.health_signals->>'accuse')::int, 0) > 0
          OR EXISTS (SELECT 1 FROM messages pm
                      WHERE pm.conversation_id = c.id AND pm.deleted_at IS NULL
                        AND (pm.metadata ? 'urgent' OR pm.metadata ? 'routine' OR pm.metadata ? 'sensitive_hidden')))
         ) AS is_protected
    FROM conversations c
    LEFT JOIN LATERAL (
      SELECT max(m.created_at) FILTER (WHERE m.sender = 'visitor') AS last_visitor_at,
             max(m.created_at) FILTER (WHERE m.sender = 'agent') AS last_agent_at,
             (array_agg(m.sender ORDER BY m.created_at DESC, m.id DESC))[1] AS last_sender,
             (array_agg(m.content ORDER BY m.created_at DESC, m.id DESC) FILTER (WHERE m.sender = 'visitor'))[1] AS last_visitor_text,
             (array_agg(m.content ORDER BY m.created_at DESC, m.id DESC) FILTER (WHERE m.sender = 'ai'))[1] AS last_ai_text
        FROM messages m
       WHERE m.conversation_id = c.id
         AND m.sender <> 'tool_result'
         AND COALESCE(m.metadata->>'hidden', 'false') <> 'true'
         AND COALESCE(m.metadata->>'withheld', '') = ''
         AND m.content IS NOT NULL AND btrim(m.content) <> ''
         AND m.deleted_at IS NULL
    ) w ON true
   WHERE c.status <> 'resolved'
     AND COALESCE(c.last_message_at, c.created_at) < now() - ${WINDOW_SQL}
     AND c.updated_at < now() - ${WINDOW_SQL}
     AND NOT EXISTS (SELECT 1 FROM messages m2
                      WHERE m2.conversation_id = c.id AND m2.created_at >= now() - ${WINDOW_SQL})`;

export interface AutoCloseResult {
  days: number;
  visitorHours: number;
  quiet: number;        // open chats with nothing new for the window
  waiting: number;      // of those, customers still waiting for an answer: left open (visitors are not counted: they close)
  protected: number;    // of those, a customer's refund / cancellation / payment / threat / fraud / Needs you chats: left open
  closed: number;       // closed now (0 on a dry run)
  dryRun: boolean;
}

export async function autoCloseIdleChats(opts: { dryRun?: boolean; days?: number; visitorHours?: number } = {}): Promise<AutoCloseResult> {
  const days = Math.max(1, Math.floor(opts.days ?? AUTO_CLOSE_DAYS));
  const visitorHours = Math.max(1, Math.floor(opts.visitorHours ?? AUTO_CLOSE_VISITOR_HOURS));
  const dryRun = !!opts.dryRun;

  if (dryRun) {
    const r = await query<{ quiet: number; waiting: number; kept: number }>(
      `SELECT count(*)::int AS quiet, count(*) FILTER (WHERE customer_waiting AND NOT is_visitor)::int AS waiting,
              count(*) FILTER (WHERE NOT customer_waiting AND is_protected AND NOT is_visitor)::int AS kept
         FROM (${CANDIDATES_SQL}) x`,
      [days, visitorHours]
    );
    return { days, visitorHours, quiet: r.rows[0]?.quiet ?? 0, waiting: r.rows[0]?.waiting ?? 0, protected: r.rows[0]?.kept ?? 0, closed: 0, dryRun };
  }

  // One statement, so the customer-waiting test and the close see the same rows.
  // The direct tests on c repeat the window: if a message lands while this runs,
  // its UPDATE moves last_message_at and Postgres rechecks the row, so a chat that
  // just got a message is not closed. No message is written; unread goes to 0
  // like a manual Close, and auto_closed_at is the mark (chat-auto-close.sql).
  const closed = await query<{ closed_n: number; quiet: number; waiting: number; kept: number }>(
    `WITH cand AS (${CANDIDATES_SQL}),
          stats AS (SELECT count(*)::int AS quiet, count(*) FILTER (WHERE customer_waiting AND NOT is_visitor)::int AS waiting,
                           count(*) FILTER (WHERE NOT customer_waiting AND is_protected AND NOT is_visitor)::int AS kept FROM cand),
          done AS (
            UPDATE conversations c
               SET status = 'resolved', unread_count = 0, auto_closed_at = now(), updated_at = now()
              FROM cand
             WHERE c.id = cand.id AND (cand.is_visitor OR (NOT cand.customer_waiting AND NOT cand.is_protected))
               AND c.status <> 'resolved'
               AND COALESCE(c.last_message_at, c.created_at) < now() - ${WINDOW_SQL}
               AND c.updated_at < now() - ${WINDOW_SQL}
            RETURNING c.id)
     SELECT (SELECT count(*) FROM done)::int AS closed_n, stats.quiet, stats.waiting, stats.kept
       FROM stats`,
    [days, visitorHours]
  );
  const row = closed.rows[0];
  return { days, visitorHours, quiet: row?.quiet ?? 0, waiting: row?.waiting ?? 0, protected: row?.kept ?? 0, closed: row?.closed_n ?? 0, dryRun };
}
