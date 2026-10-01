import { AI_NOT_AN_ANSWER_REGEX, NO_REPLY_NEEDED_REGEX } from './waiting';

// ── The "waiting for a reply" SQL ───────────────────────────────
// Moved word for word out of the inbox list route (src/app/api/chat/conversations/route.ts), so the
// chat team routes can ask the same question about one chat ("is this customer waiting?" for
// "Take from X" when the holder is away, team-routing.ts) without a second copy that could drift.
// The rule itself is in ./waiting.ts. Both strings expect the conversation under the alias c, and
// WAITING_SINCE_SQL reads the lateral join WAITING_LATERAL adds (alias w).

// What a chat's messages say about waiting (alias w): the last customer message, the last staff
// reply, the last urgent customer message, who wrote last and what the customer last wrote.
// Closed chats skip the work (all NULL).
export const WAITING_LATERAL = `LEFT JOIN LATERAL (
           SELECT max(m.created_at) FILTER (WHERE m.sender = 'visitor') AS last_visitor_at,
                  max(m.created_at) FILTER (WHERE m.sender = 'agent') AS last_agent_at,
                  max(m.created_at) FILTER (WHERE m.sender = 'visitor' AND m.metadata->>'urgent' IS NOT NULL) AS last_urgent_at,
                  (array_agg(m.sender ORDER BY m.created_at DESC, m.id DESC))[1] AS last_sender,
                  (array_agg(m.content ORDER BY m.created_at DESC, m.id DESC) FILTER (WHERE m.sender = 'visitor'))[1] AS last_visitor_text,
                  (array_agg(m.content ORDER BY m.created_at DESC, m.id DESC) FILTER (WHERE m.sender = 'ai'))[1] AS last_ai_text
             FROM messages m
            WHERE m.conversation_id = c.id AND c.status <> 'resolved'
              AND m.sender <> 'tool_result'
              AND COALESCE(m.metadata->>'hidden', 'false') <> 'true'
              AND COALESCE(m.metadata->>'withheld', '') = ''
              AND m.content IS NOT NULL AND btrim(m.content) <> ''
              AND m.deleted_at IS NULL
         ) w ON true`;

// Since when the customer has waited for an answer (src/lib/chat/waiting.ts), NULL when nobody owes
// one: closed, answered by a team member since, a plain "ok / thanks" after an answer, or an AI chat
// whose AI really answered. Still waiting: a chat in Needs you no person has answered yet (even if
// the customer's last word was "ok"), the customer wrote last, or the AI's last word was no answer
// ("sorry, that took longer", "let me confirm with the team": AI_NOT_AN_ANSWER_REGEX, the same rule
// as auto-close.ts). Also what "Unread" lists (owner, 2026-10-01: "jawab baaki wali"; it used to be
// any message no one had opened, AI answers included).
export const WAITING_SINCE_SQL = `CASE WHEN c.status = 'resolved' OR w.last_visitor_at IS NULL THEN NULL
                   WHEN w.last_agent_at IS NOT NULL AND w.last_agent_at > w.last_visitor_at THEN NULL
                   WHEN c.status = 'human_needed' AND w.last_agent_at IS NULL THEN w.last_visitor_at
                   WHEN w.last_visitor_text ~* '${NO_REPLY_NEEDED_REGEX}' THEN NULL
                   WHEN c.status = 'human_needed' OR w.last_sender = 'visitor'
                        OR (w.last_sender = 'ai' AND w.last_ai_text ~* '${AI_NOT_AN_ANSWER_REGEX}') THEN w.last_visitor_at
              END`;
