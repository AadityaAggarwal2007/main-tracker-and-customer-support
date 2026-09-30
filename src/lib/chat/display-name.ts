// ── The name staff read on a chat ──────────────────────────────
// Asked for by the owner on 2026-09-30: a chat whose number matched a customer's
// order (Phone match, phone-match.ts) said "Visitor" where the customer's name
// should be, and the team could not tell who it was. The name on the matched
// order is now shown instead, whenever the chat has no name of its own.
//
// Worked out when the inbox is read, from the order the chat is tied to, and
// NEVER stored: conversations.visitor_name stays what the customer or the
// widget gave, the name follows the order if the match moves, and nothing is
// rewritten. Staff only (list + thread routes): the AI and the widget never
// read it. Like the Phone match tag it is a hint, not proof of who is typing.
//
// A chat keeps its own name when it has a real one (typed in the widget, or set
// when the customer verified an order). The rule lives in SQL only, so the list
// row, the thread header and the search always agree (a JS copy once differed on
// odd whitespace and on a failed lookup). This file has no imports: the list
// route, the thread route and the search share it.

// What the widget writes when it knows nothing (widget-api.ts: 'Visitor').
export const GENERIC_VISITOR_NAMES = ['visitor', 'guest', 'anonymous'];

// The alias the list route gives the joined order name, so the search can use it.
export const ORDER_NAME_ALIAS = 'oname';

// SQL: true when column `col` holds no real name.
export const genericNameSql = (col: string) =>
  `(${col} IS NULL OR btrim(${col}) = '' OR lower(btrim(${col})) IN (${GENERIC_VISITOR_NAMES.map((n) => `'${n}'`).join(', ')}))`;

// SQL for the list: LEFT JOIN LATERAL that gives `oname.name`, the customer name
// on the order chat `c` is tied to (its verified order, else its phone match),
// inside the chat's own panel (`s` = its site). Only chats with no real name of
// their own look anything up; a chat whose panel is unknown gets NULL, so no
// other store's customer is ever named. Order numbers are unique per panel
// (orders_unique_per_panel), so the "exactly one name" test is only a guard.
export const orderNameJoinSql = (c: string, s: string) => `LEFT JOIN LATERAL (
           SELECT CASE WHEN count(DISTINCT n.name) = 1 THEN min(n.name) END AS name
             FROM (SELECT regexp_replace(btrim(o.customer_name), '\\s*\\.\\s*$', '') AS name
                     FROM orders o
                    WHERE ${genericNameSql(`${c}.visitor_name`)}
                      AND COALESCE(${c}.verified_order_id, ${c}.phone_match_order_id) IS NOT NULL
                      AND o.order_id = COALESCE(${c}.verified_order_id, ${c}.phone_match_order_id)
                      AND o.business_id::text = ${s}.tracker_business_id::text
                      AND btrim(COALESCE(o.customer_name, '')) <> '') n
         ) ${ORDER_NAME_ALIAS} ON true`;

// SQL: the name to show for chat `c`.
export const displayNameSql = (c: string) =>
  `CASE WHEN ${genericNameSql(`${c}.visitor_name`)} THEN COALESCE(${ORDER_NAME_ALIAS}.name, ${c}.visitor_name) ELSE ${c}.visitor_name END`;
