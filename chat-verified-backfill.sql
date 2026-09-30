-- ============================================================
-- One-off, 2026-09-30: move chats that already proved their order from
-- Visitors to Customers in the inbox. Asked for by the owner in chat on
-- 2026-09-30 ("Visitors should hold only visitors; verified customers go to
-- the verified column"). It changes existing rows: apply only after the owner
-- has OK'd this file in plain words (AGENTS.md rule 5).
-- chat-verified.sql added conversations.verified_order_id and left every older
-- chat NULL, so chats in which the AI did find the customer's order with the
-- order ID + last 4 digits of the phone still show under Visitors.
--
-- A chat is marked verified only when the customer really proved ownership,
-- because verified_order_id also makes the AI keep that order in view if they
-- write again (ai.ts, lookupVerifiedOrder). For each chat still NULL this
-- takes its EARLIEST lookup_order call that:
--   * has an order_id and a phone_last4 of exactly 4 digits (the rule since
--     2026-09-24; the older name / phone / email lookups are NOT proof and
--     are left alone, so chats found only that way stay under Visitors),
--   * got a stored result with found = true (its orders[0] is the order),
--   * answered before 2026-09-29 21:58:55 UTC, when commit 573f418 (chat
--     verification) was made, so before it was deployed. From the deploy on
--     the app verifies chats itself, and /api/widget/resume clears that on
--     purpose when a chat is picked up on another device; this must not undo
--     that, however late it is applied,
--   * the customer typed themselves: the order ID and the 4 digits both appear
--     in a visitor message sent before the call (so an order ID the bot copied
--     from an earlier name/phone lookup does not count),
--   * the customer knew before the chat showed it to them: no tool result and
--     no visible AI/agent reply containing that order ID came before the
--     customer first typed it (so echoing back an ID that an old name/phone/
--     email lookup revealed does not count either),
--   * still checks out against orders today: that order's ID or tracking ID is
--     the one given, its phone ends in those 4 digits, and it belongs to the
--     site's panel when the site has one.
-- It sets verified_order_id, verified_at (when the lookup answered, converted
-- to UTC like the app writes it, whatever the session's TimeZone) and
-- verified_via = 'chat'. Nothing else is touched, and a chat that is already
-- verified is never overwritten, so running it again changes nothing.
--
-- Apply after chat-verified.sql, on the VPS after git pull:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-verified-backfill.sql
-- The pg_temp helpers disappear when the session ends; no schema change.
-- psql prints "UPDATE n" = chats moved. The UPDATE uses exactly the WITH below.
--
-- Dry run first (read-only): paste the block below, uncommented, into psql.
-- ------------------------------------------------------------
-- CREATE OR REPLACE FUNCTION pg_temp.try_jsonb(t text) RETURNS jsonb
--   LANGUAGE plpgsql IMMUTABLE AS $f$
--   BEGIN RETURN t::jsonb; EXCEPTION WHEN others THEN RETURN NULL; END $f$;
-- -- Regex for an order ID inside text; NULL (never matches) unless it is plain a-z0-9.
-- CREATE OR REPLACE FUNCTION pg_temp.id_re(id text) RETURNS text
--   LANGUAGE sql IMMUTABLE AS $f$
--   SELECT CASE WHEN id ~ '^[a-z0-9]+$' THEN '(^|[^0-9])' || id || '([^0-9]|$)' END $f$;
--
-- WITH calls AS (
--   SELECT m.conversation_id, m.created_at AS call_at, tc->>'id' AS call_id,
--          pg_temp.try_jsonb(tc->'function'->>'arguments') AS args
--     FROM conversations c
--     JOIN messages m ON m.conversation_id = c.id
--     CROSS JOIN LATERAL jsonb_array_elements(
--       CASE WHEN jsonb_typeof(m.metadata->'tool_calls') = 'array'
--            THEN m.metadata->'tool_calls' ELSE '[]'::jsonb END) tc
--    WHERE c.verified_order_id IS NULL
--      AND m.sender = 'ai' AND m.deleted_at IS NULL
--      AND tc->'function'->>'name' = 'lookup_order'
-- ), parsed AS (
--   SELECT k.*,
--          CASE WHEN jsonb_typeof(k.args) = 'object'
--               THEN NULLIF(lower(ltrim(btrim(translate(k.args->>'order_id',
--                      '०१२३४५६७८९', '0123456789')), '# ')), '') END AS arg_id,
--          CASE WHEN jsonb_typeof(k.args) = 'object'
--               THEN regexp_replace(translate(COALESCE(k.args->>'phone_last4', ''),
--                      '०१२३४५६७८९', '0123456789'), '\D', '', 'g') END AS arg_last4
--     FROM calls k
-- ), paired AS (
--   SELECT p.*, pg_temp.id_re(p.arg_id) AS id_re, r.created_at AS result_at, pg_temp.try_jsonb(r.content) AS res
--     FROM parsed p
--     LEFT JOIN LATERAL (
--       SELECT r.created_at, r.content FROM messages r
--        WHERE r.conversation_id = p.conversation_id AND r.sender = 'tool_result'
--          AND r.deleted_at IS NULL AND r.metadata->>'tool_call_id' = p.call_id
--        ORDER BY r.created_at LIMIT 1) r ON true
-- ), typed AS (
--   SELECT q.*,
--          (SELECT min(v.created_at) FROM messages v
--            WHERE v.conversation_id = q.conversation_id AND v.sender = 'visitor'
--              AND v.deleted_at IS NULL
--              AND lower(translate(v.content, '०१२३४५६७८९', '0123456789')) ~ q.id_re) AS first_typed_at
--     FROM paired q
-- ), checked AS (
--   SELECT q.*,
--          q.first_typed_at <= q.call_at AS id_typed,
--          EXISTS (SELECT 1 FROM messages v
--                   WHERE v.conversation_id = q.conversation_id AND v.sender = 'visitor'
--                     AND v.deleted_at IS NULL AND v.created_at <= q.call_at
--                     AND regexp_replace(translate(v.content, '०१२३४५६७८९', '0123456789'), '\D', '', 'g')
--                         LIKE '%' || q.arg_last4 || '%') AS last4_typed,
--          EXISTS (SELECT 1 FROM messages x
--                   WHERE x.conversation_id = q.conversation_id AND x.deleted_at IS NULL
--                     AND x.created_at < q.first_typed_at
--                     AND (x.sender = 'tool_result'
--                          OR (x.sender IN ('ai', 'agent') AND x.metadata->>'hidden' IS DISTINCT FROM 'true'))
--                     AND lower(translate(x.content, '०१२३४५६७८९', '0123456789')) ~ q.id_re) AS shown_first,
--          (SELECT o.order_id FROM orders o
--            WHERE o.order_id = q.res #>> '{orders,0,order_id}'
--              AND RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 4) = q.arg_last4
--              AND q.arg_id IN (lower(ltrim(o.order_id, '#')), lower(o.tracking_id))
--            LIMIT 1) AS order_matches,
--          (SELECT o.order_id FROM orders o
--            WHERE o.order_id = q.res #>> '{orders,0,order_id}'
--              AND RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 4) = q.arg_last4
--              AND q.arg_id IN (lower(ltrim(o.order_id, '#')), lower(o.tracking_id))
--              AND (s.tracker_business_id IS NULL OR o.business_id::text = s.tracker_business_id)
--            ORDER BY o.created_at DESC LIMIT 1) AS proved_order
--     FROM typed q
--     JOIN conversations c ON c.id = q.conversation_id
--     JOIN sites s ON s.id = c.site_id
-- ), staged AS (
--   SELECT h.*,
--     CASE
--       WHEN jsonb_typeof(h.args) IS DISTINCT FROM 'object'           THEN '0 invalid JSON arguments'
--       WHEN h.arg_id IS NULL OR length(h.arg_last4) <> 4               THEN '1 no order ID + last 4 (legacy name/phone/email)'
--       WHEN jsonb_typeof(h.res) IS DISTINCT FROM 'object'            THEN '2 no stored or parsable result'
--       WHEN h.res->>'found' IS DISTINCT FROM 'true'
--         OR h.res #>> '{orders,0,order_id}' IS NULL                    THEN '3 order not found'
--       WHEN h.result_at >= timestamptz '2026-09-29 21:58:55+00'        THEN '4 after the deploy (the app verifies these itself)'
--       WHEN NOT (COALESCE(h.id_typed, false) AND h.last4_typed)        THEN '5 order ID or last 4 not typed by the customer'
--       WHEN h.shown_first                                              THEN '6 order ID shown in the chat before the customer typed it'
--       WHEN h.order_matches IS NULL                                    THEN '7 re-check against orders failed'
--       WHEN h.proved_order IS NULL                                     THEN '8 business scope mismatch'
--       ELSE '9 proved' END AS stage
--     FROM checked h
-- ), pick AS (
--   SELECT DISTINCT ON (conversation_id) conversation_id, proved_order, result_at
--     FROM staged WHERE stage = '9 proved'
--    ORDER BY conversation_id, call_at, result_at
-- )
-- -- Chats that would move, by day of the matching lookup and current status:
-- SELECT (p.result_at AT TIME ZONE 'UTC')::date AS lookup_day, c.status, count(*) AS chats
--   FROM pick p JOIN conversations c ON c.id = p.conversation_id
--  GROUP BY ROLLUP (1, 2) ORDER BY 1 NULLS LAST, 2 NULLS LAST;
-- -- For why the rest stay, end the same WITH instead with:
-- --   SELECT best, count(*) AS chats
-- --     FROM (SELECT conversation_id, max(stage) AS best FROM staged GROUP BY 1) x
-- --    GROUP BY 1 ORDER BY 1;
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.try_jsonb(t text) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $f$
  BEGIN RETURN t::jsonb; EXCEPTION WHEN others THEN RETURN NULL; END $f$;
-- Regex for an order ID inside text; NULL (never matches) unless it is plain a-z0-9.
CREATE OR REPLACE FUNCTION pg_temp.id_re(id text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN id ~ '^[a-z0-9]+$' THEN '(^|[^0-9])' || id || '([^0-9]|$)' END $f$;

WITH calls AS (
  SELECT m.conversation_id, m.created_at AS call_at, tc->>'id' AS call_id,
         pg_temp.try_jsonb(tc->'function'->>'arguments') AS args
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(m.metadata->'tool_calls') = 'array'
           THEN m.metadata->'tool_calls' ELSE '[]'::jsonb END) tc
   WHERE c.verified_order_id IS NULL
     AND m.sender = 'ai' AND m.deleted_at IS NULL
     AND tc->'function'->>'name' = 'lookup_order'
), parsed AS (
  SELECT k.*,
         CASE WHEN jsonb_typeof(k.args) = 'object'
              THEN NULLIF(lower(ltrim(btrim(translate(k.args->>'order_id',
                     '०१२३४५६७८९', '0123456789')), '# ')), '') END AS arg_id,
         CASE WHEN jsonb_typeof(k.args) = 'object'
              THEN regexp_replace(translate(COALESCE(k.args->>'phone_last4', ''),
                     '०१२३४५६७८९', '0123456789'), '\D', '', 'g') END AS arg_last4
    FROM calls k
), paired AS (
  SELECT p.*, pg_temp.id_re(p.arg_id) AS id_re, r.created_at AS result_at, pg_temp.try_jsonb(r.content) AS res
    FROM parsed p
    LEFT JOIN LATERAL (
      SELECT r.created_at, r.content FROM messages r
       WHERE r.conversation_id = p.conversation_id AND r.sender = 'tool_result'
         AND r.deleted_at IS NULL AND r.metadata->>'tool_call_id' = p.call_id
       ORDER BY r.created_at LIMIT 1) r ON true
), typed AS (
  SELECT q.*,
         (SELECT min(v.created_at) FROM messages v
           WHERE v.conversation_id = q.conversation_id AND v.sender = 'visitor'
             AND v.deleted_at IS NULL
             AND lower(translate(v.content, '०१२३४५६७८९', '0123456789')) ~ q.id_re) AS first_typed_at
    FROM paired q
), checked AS (
  SELECT q.*,
         q.first_typed_at <= q.call_at AS id_typed,
         EXISTS (SELECT 1 FROM messages v
                  WHERE v.conversation_id = q.conversation_id AND v.sender = 'visitor'
                    AND v.deleted_at IS NULL AND v.created_at <= q.call_at
                    AND regexp_replace(translate(v.content, '०१२३४५६७८९', '0123456789'), '\D', '', 'g')
                        LIKE '%' || q.arg_last4 || '%') AS last4_typed,
         EXISTS (SELECT 1 FROM messages x
                  WHERE x.conversation_id = q.conversation_id AND x.deleted_at IS NULL
                    AND x.created_at < q.first_typed_at
                    AND (x.sender = 'tool_result'
                         OR (x.sender IN ('ai', 'agent') AND x.metadata->>'hidden' IS DISTINCT FROM 'true'))
                    AND lower(translate(x.content, '०१२३४५६७८९', '0123456789')) ~ q.id_re) AS shown_first,
         (SELECT o.order_id FROM orders o
           WHERE o.order_id = q.res #>> '{orders,0,order_id}'
             AND RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 4) = q.arg_last4
             AND q.arg_id IN (lower(ltrim(o.order_id, '#')), lower(o.tracking_id))
           LIMIT 1) AS order_matches,
         (SELECT o.order_id FROM orders o
           WHERE o.order_id = q.res #>> '{orders,0,order_id}'
             AND RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 4) = q.arg_last4
             AND q.arg_id IN (lower(ltrim(o.order_id, '#')), lower(o.tracking_id))
             AND (s.tracker_business_id IS NULL OR o.business_id::text = s.tracker_business_id)
           ORDER BY o.created_at DESC LIMIT 1) AS proved_order
    FROM typed q
    JOIN conversations c ON c.id = q.conversation_id
    JOIN sites s ON s.id = c.site_id
), staged AS (
  SELECT h.*,
    CASE
      WHEN jsonb_typeof(h.args) IS DISTINCT FROM 'object'           THEN '0 invalid JSON arguments'
      WHEN h.arg_id IS NULL OR length(h.arg_last4) <> 4               THEN '1 no order ID + last 4 (legacy name/phone/email)'
      WHEN jsonb_typeof(h.res) IS DISTINCT FROM 'object'            THEN '2 no stored or parsable result'
      WHEN h.res->>'found' IS DISTINCT FROM 'true'
        OR h.res #>> '{orders,0,order_id}' IS NULL                    THEN '3 order not found'
      WHEN h.result_at >= timestamptz '2026-09-29 21:58:55+00'        THEN '4 after the deploy (the app verifies these itself)'
      WHEN NOT (COALESCE(h.id_typed, false) AND h.last4_typed)        THEN '5 order ID or last 4 not typed by the customer'
      WHEN h.shown_first                                              THEN '6 order ID shown in the chat before the customer typed it'
      WHEN h.order_matches IS NULL                                    THEN '7 re-check against orders failed'
      WHEN h.proved_order IS NULL                                     THEN '8 business scope mismatch'
      ELSE '9 proved' END AS stage
    FROM checked h
), pick AS (
  SELECT DISTINCT ON (conversation_id) conversation_id, proved_order, result_at
    FROM staged WHERE stage = '9 proved'
   ORDER BY conversation_id, call_at, result_at
)
UPDATE conversations c
   SET verified_order_id = p.proved_order,
       verified_at       = p.result_at AT TIME ZONE 'UTC',
       verified_via      = 'chat'
  FROM pick p
 WHERE c.id = p.conversation_id
   AND c.verified_order_id IS NULL;

COMMIT;
