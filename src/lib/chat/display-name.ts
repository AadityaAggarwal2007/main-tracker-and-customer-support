// ── The name staff read on a chat ──────────────────────────────
// Asked for by the owner on 2026-09-30: a chat whose number matched a customer's
// order (an old "Phone match", chat-phone-match.sql) said "Visitor" where the customer's name
// should be, and the team could not tell who it was. Then, the same day: a name
// the customer TYPES must never be shown for a chat that has an order. The name
// on the order is the name the parcel goes to, so it is the only one staff read.
//
// The rule: a chat tied to an order (its verified order, else the one its number
// matched) shows the customer name on that order, always, whatever the chat's
// own name says. A chat with no order (a plain visitor), or whose order cannot
// be found, shows its own name, else "Visitor".
//
// Worked out when the inbox is read, from the order the chat is tied to, and
// NEVER stored: conversations.visitor_name stays what the customer or the
// widget gave, the name follows the order if the match moves, and nothing is
// rewritten. Staff only (list + thread routes): the AI and the widget never
// read it. A phone match is still a hint, not proof of who is typing, so the
// inbox draws that name in italics. The rule lives in SQL only, so the list
// row, the thread header and the search always agree. This file has no imports:
// the list route, the thread route and the search share it.

// The alias the list route gives the joined order name, so the search can use it.
export const ORDER_NAME_ALIAS = 'oname';

// SQL: LEFT JOIN LATERAL that gives `oname.name`, the customer name on the order
// chat `c` is tied to (its verified order, else its phone match), inside the
// chat's own panel (`s` = its site). A chat with no order, or whose panel is
// unknown, gets NULL, so no other store's customer is ever named. Order numbers
// are unique per panel (orders_unique_per_panel), so the "exactly one name" test
// is only a guard.
export const orderNameJoinSql = (c: string, s: string) => `LEFT JOIN LATERAL (
           SELECT CASE WHEN count(DISTINCT n.name) = 1 THEN min(n.name) END AS name
             FROM (SELECT regexp_replace(btrim(o.customer_name), '\\s*\\.\\s*$', '') AS name
                     FROM orders o
                    WHERE COALESCE(${c}.verified_order_id, ${c}.phone_match_order_id) IS NOT NULL
                      AND o.order_id = COALESCE(${c}.verified_order_id, ${c}.phone_match_order_id)
                      AND o.business_id::text = ${s}.tracker_business_id::text
                      AND btrim(COALESCE(o.customer_name, '')) <> '') n
         ) ${ORDER_NAME_ALIAS} ON true`;

// SQL: the name to show for chat `c`: the order's, else the chat's own.
export const displayNameSql = (c: string) =>
  `COALESCE(${ORDER_NAME_ALIAS}.name, ${c}.visitor_name)`;

// SQL: true when the name shown is the order's (not the chat's own).
export const nameFromOrderSql = () => `(${ORDER_NAME_ALIAS}.name IS NOT NULL)`;
