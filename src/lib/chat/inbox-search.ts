// ── Searching the staff inbox ──────────────────────────────────
// Asked for by the owner on 2026-09-30: staff need to find a customer's chats
// by name, phone, order ID or anything said in the chat, e.g. to answer a
// chargeback ("what did we tell them about order #1234?").
//
// This only builds SQL fragments for GET /api/chat/conversations; it runs in
// that route, after the panel scoping (businessIds) is already in the WHERE,
// so a search can never reach a panel the caller may not see. Every value from
// the caller is bound as a parameter, never pasted into the SQL. It looks in:
//   - the customer's name (the name on the order a chat is tied to, and on an
//     order the AI looked up),
//   - the phone (only when the query is a number of 6+ digits),
//   - the verified order ID, and orders the AI looked up in the chat
//     (order ID / tracking ID inside the stored lookup result),
//   - the visible messages and the chat's subject.
// Deleted messages and hidden tool rows are never searched as text.

import { ORDER_NAME_ALIAS } from '@/lib/chat/display-name';

export interface InboxSearch {
  q: string;             // '' = no search
  params: string[];      // to append to the query's parameters
  cte: string;           // a WITH-list item ('msg_hits AS MATERIALIZED (...)'), '' when not searching
  join: string;          // LEFT JOIN msg_hits h ON ... to add after the conversations join
  hitOrder: string;      // boolean SQL expressions over conversations alias c (and h)
  hitPhone: string;
  hitName: string;
  hitText: string;
  snippet: string;       // scalar SQL over conversations alias g: text around the latest match
}

// A search shorter than this is ignored (it would match nearly everything).
export const MIN_SEARCH_CHARS = 2;
const MAX_SEARCH_CHARS = 80;

// Refund form messages (sender 'system', owner 2026-10-02) are never searched: their text is fixed,
// and staff must not probe a form link's token letter by letter.
const VISIBLE_TEXT = `m.deleted_at IS NULL
      AND m.sender <> 'tool_result'
      AND m.sender <> 'system'
      AND COALESCE(m.metadata->>'hidden', 'false') <> 'true'`;

export function parseInboxSearch(raw: string | null | undefined, firstParam: number): InboxSearch {
  const q = (raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_CHARS);
  if (q.length < MIN_SEARCH_CHARS) {
    return { q: '', params: [], cte: '', join: '', hitOrder: 'false', hitPhone: 'false', hitName: 'false', hitText: 'false', snippet: 'NULL::text' };
  }

  const params: string[] = [];
  const bind = (v: string) => { params.push(v); return `$${firstParam + params.length - 1}::text`; };
  // LIKE wildcards and regex operators in what the person typed are plain text.
  const like = (s: string) => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';
  const regex = (s: string) => s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');

  const pLike = bind(like(q));
  const pRaw = bind(q);

  // "#1234" and "1234" are the same order.
  const order = q.replace(/^[#\s]+/, '').trim();
  const pOrderLike = order ? bind(like(order)) : '';
  const pOrderRe = order ? bind(regex(order)) : '';
  // The name on an order the AI found is in the stored lookup result too.
  const searchNames = !/^[\d\s+()#-]+$/.test(q);
  const pNameRe = searchNames ? bind(regex(q)) : '';

  // Messages are scanned ONCE for all three kinds of match and folded into one
  // row per chat. A separate EXISTS per flag made Postgres scan the whole
  // messages table for each of them, on every row: ~1.8 s for 40,000 messages.
  const orderTest = order
    ? `m.content ~* ('"(order_id|tracking_id)":"[^"]*' || ${pOrderRe} || '[^"]*"')` : 'false';
  const nameTest = searchNames
    ? `m.content ~* ('"customer_name":"[^"]*' || ${pNameRe} || '[^"]*"')` : 'false';
  const cte = `msg_hits AS MATERIALIZED (
       SELECT m.conversation_id,
              bool_or(m.sender NOT IN ('tool_result', 'system') AND COALESCE(m.metadata->>'hidden', 'false') <> 'true'
                      AND m.content ILIKE ${pLike}) AS text_hit,
              bool_or(m.sender = 'tool_result' AND ${orderTest}) AS order_hit,
              bool_or(m.sender = 'tool_result' AND ${nameTest}) AS name_hit
         FROM messages m
        WHERE m.deleted_at IS NULL
          AND (m.content ILIKE ${pLike}
               OR (m.sender = 'tool_result' AND (${orderTest} OR ${nameTest})))
        GROUP BY m.conversation_id
     )`;
  const join = 'LEFT JOIN msg_hits h ON h.conversation_id = c.id';

  const hitOrder = order
    ? `(COALESCE(ltrim(c.verified_order_id, '#') ILIKE ${pOrderLike}, false) OR COALESCE(h.order_hit, false))`
    : 'false';
  // ORDER_NAME_ALIAS.name is the customer name on the chat's order (display-name.ts,
  // joined by the list route), so a phone-matched chat is found by its customer's name.
  const hitName = `(COALESCE(c.visitor_name ILIKE ${pLike}, false) OR COALESCE(${ORDER_NAME_ALIAS}.name ILIKE ${pLike}, false) OR COALESCE(h.name_hit, false))`;
  const hitText = `(COALESCE(c.subject_summary ILIKE ${pLike}, false) OR COALESCE(h.text_hit, false))`;

  // A number of 6+ digits is a phone: +91 89182 21791, 08918221791, 8918221791.
  let hitPhone = 'false';
  if (/^\+?[\d\s()-]+$/.test(q)) {
    let digits = q.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length >= 6) {
      const pDigits = bind('%' + digits + '%');
      hitPhone = `COALESCE(regexp_replace(COALESCE(c.visitor_phone, ''), '\\D', '', 'g') LIKE ${pDigits}
        OR COALESCE(c.customer_key, '') LIKE ${pDigits}, false)`;
    }
  }

  // About 200 characters around the newest message that contains the text,
  // with an ellipsis when it starts mid-message.
  const snippet = `(SELECT (CASE WHEN position(lower(${pRaw}) IN lower(m.content)) > 51 THEN '…' ELSE '' END)
                         || substring(m.content FROM greatest(position(lower(${pRaw}) IN lower(m.content)) - 50, 1) FOR 200)
                    FROM messages m
                   WHERE m.conversation_id = g.id AND ${VISIBLE_TEXT} AND m.content ILIKE ${pLike}
                   ORDER BY m.created_at DESC
                   LIMIT 1)`;

  return { q, params, cte, join, hitOrder, hitPhone, hitName, hitText, snippet };
}
