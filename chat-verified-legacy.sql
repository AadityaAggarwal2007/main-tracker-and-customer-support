-- ============================================================
-- One-off, 2026-09-30: move chats whose order the AI found with the OLD
-- lookup rules (a full phone number or an email address) from Visitors to
-- Customers in the inbox. Asked for by the owner in chat on 2026-09-30, after
-- chat-verified-backfill.sql moved the chats that typed order ID + last 4.
-- It changes existing rows: apply only after the owner has OK'd this file in
-- plain words (AGENTS.md rule 5).
--
-- APPLY ONLY AFTER THE CODE THAT HANDLES verified_via = 'legacy' IS DEPLOYED
-- (ai.ts treats 'legacy' as not verified and hides old lookups' found results
-- from the model, the inbox shows an "Old check" badge). Before that, the live
-- ai.ts would take these rows as proof of ownership, keep the order in the
-- model's view and stop asking for the order ID + last 4.
--
-- 'legacy' is for display only. Until about 2026-09-24 16:20 UTC (commit
-- e7fc4b8) lookup_order accepted order_id, email, phone, phone_last4 and name,
-- and the version ported from chat-support OR'd email and phone together. Those
-- lookups are NOT proof of ownership (the 2026-09-11 privacy incident came
-- from them), so the AI ignores the tag, and getAIResponse swaps those old
-- found results in its history for a needs-verification answer
-- (isProvenLookup), so it asks for order ID + last 4 before sharing order
-- details; the tag only takes the chat out of Visitors.
--
-- For each chat still NULL this takes its EARLIEST lookup_order call that:
--   * got a stored result (paired by tool_call_id, not deleted) with
--     found = true (its orders[0] is the order) that answered before
--     2026-09-29 21:58:55 UTC, when commit 573f418 (chat verification) was
--     made, so before it was deployed. From the deploy on the app verifies
--     chats itself and /api/widget/resume clears that on purpose,
--   * has a strong identifier in its arguments: a full phone number (exactly
--     10 digits once non-digits, leading 0s and a leading 91 are removed) or an
--     email address. A blank argument ('' or spaces) counts as absent. A
--     name, last 4 alone, name + last 4, or order ID + last 4 are not enough
--     (order ID + last 4 was chat-verified-backfill.sql's job),
--   * the customer typed that identifier themselves: the 10 digits appear in
--     the message's digits (spaces, dashes, dots and brackets between them
--     are dropped first, so '98765 43210' counts), or the email (any case)
--     appears in its text, in a visitor message sent at or before the call,
--   * still checks out against orders today: the order with orders[0]'s ID
--     matches EVERY identifier in the arguments (phone: last 10 digits; email:
--     lower + trimmed; phone_last4 if given: last 4; order_id if given: its
--     order ID or tracking ID, ignoring '#' and case; a name is ignored, as are
--     keys the code never read), and belongs to the site's panel when the site
--     has one. When one phone/email has several orders, orders[0] (the newest)
--     is used only if it passes: it is the customer's own order, maybe not the
--     one they asked about, so the "Old check" badge can name another of that
--     customer's orders than the one discussed.
-- It sets verified_order_id, verified_at (when the lookup answered, converted
-- to UTC like the app writes it, whatever the session's TimeZone) and
-- verified_via = 'legacy'. Nothing else is touched, and a chat that is already
-- verified is never overwritten. Apply it ONCE: running it again straight
-- away changes nothing, but /api/widget/resume clears the three columns (legacy
-- tags included) when a chat is picked up on another device, and a later
-- re-run would tag those chats again and undo what resume did on purpose.
--
-- Apply after chat-verified-backfill.sql, on the VPS after git pull:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-verified-legacy.sql
-- The pg_temp helper disappears when the session ends; no schema change.
-- psql prints "UPDATE n" = chats moved. The UPDATE uses exactly the WITH below.
--
-- Dry run first (read-only): paste the block below, uncommented, into psql.
-- ------------------------------------------------------------
-- CREATE OR REPLACE FUNCTION pg_temp.try_jsonb(t text) RETURNS jsonb
--   LANGUAGE plpgsql IMMUTABLE AS $f$
--   BEGIN RETURN t::jsonb; EXCEPTION WHEN others THEN RETURN NULL; END $f$;
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
-- ), raw AS (
--   SELECT k.*,
--          CASE WHEN jsonb_typeof(k.args) = 'object'
--               THEN NULLIF(lower(ltrim(btrim(translate(k.args->>'order_id',
--                      '०१२३४५६७८९', '0123456789')), '# ')), '') END AS arg_id,
--          CASE WHEN jsonb_typeof(k.args) = 'object'
--               THEN NULLIF(regexp_replace(translate(k.args->>'phone_last4',
--                      '०१२३४५६७८९', '0123456789'), '\D', '', 'g'), '') END AS arg_last4,
--          CASE WHEN jsonb_typeof(k.args) = 'object'
--               THEN NULLIF(regexp_replace(translate(k.args->>'phone',
--                      '०१२३४५६७८९', '0123456789'), '\D', '', 'g'), '') END AS arg_phone,
--          CASE WHEN jsonb_typeof(k.args) = 'object'
--               THEN NULLIF(lower(btrim(k.args->>'email')), '') END AS arg_email
--     FROM calls k
-- ), parsed AS (
--   SELECT w.*,
--          -- The full phone: 10 digits after dropping leading 0s and a leading 91.
--          CASE WHEN length(ltrim(w.arg_phone, '0')) = 10 THEN ltrim(w.arg_phone, '0')
--               WHEN length(ltrim(w.arg_phone, '0')) = 12 AND ltrim(w.arg_phone, '0') LIKE '91%'
--                    THEN substr(ltrim(w.arg_phone, '0'), 3) END AS phone10,
--          w.arg_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AS email_ok
--     FROM raw w
-- ), paired AS (
--   SELECT p.*, r.created_at AS result_at, pg_temp.try_jsonb(r.content) AS res
--     FROM parsed p
--     LEFT JOIN LATERAL (
--       SELECT r.created_at, r.content FROM messages r
--        WHERE r.conversation_id = p.conversation_id AND r.sender = 'tool_result'
--          AND r.deleted_at IS NULL AND r.metadata->>'tool_call_id' = p.call_id
--        ORDER BY r.created_at LIMIT 1) r ON true
-- ), checked AS (
--   SELECT q.*,
--          q.phone10 IS NOT NULL AND EXISTS (
--            SELECT 1 FROM messages v
--             WHERE v.conversation_id = q.conversation_id AND v.sender = 'visitor'
--               AND v.deleted_at IS NULL AND v.created_at <= q.call_at
--               AND regexp_replace(translate(v.content, '०१२३४५६७८९', '0123456789'), '\D', '', 'g')
--                   LIKE '%' || q.phone10 || '%') AS phone_typed,
--          COALESCE(q.email_ok, false) AND EXISTS (
--            SELECT 1 FROM messages v
--             WHERE v.conversation_id = q.conversation_id AND v.sender = 'visitor'
--               AND v.deleted_at IS NULL AND v.created_at <= q.call_at
--               AND strpos(lower(v.content), q.arg_email) > 0) AS email_typed,
--          (SELECT o.order_id FROM orders o
--            WHERE o.order_id = q.res #>> '{orders,0,order_id}'
--              AND (q.arg_phone IS NULL
--                   OR RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 10) = q.phone10)
--              AND (q.arg_email IS NULL OR lower(btrim(o.customer_email)) = q.arg_email)
--              AND (q.arg_last4 IS NULL
--                   OR (length(q.arg_last4) >= 4
--                       AND RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 4) = RIGHT(q.arg_last4, 4)))
--              AND (q.arg_id IS NULL OR q.arg_id IN (lower(ltrim(o.order_id, '#')), lower(o.tracking_id)))
--            LIMIT 1) AS order_matches,
--          (SELECT o.order_id FROM orders o
--            WHERE o.order_id = q.res #>> '{orders,0,order_id}'
--              AND (q.arg_phone IS NULL
--                   OR RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 10) = q.phone10)
--              AND (q.arg_email IS NULL OR lower(btrim(o.customer_email)) = q.arg_email)
--              AND (q.arg_last4 IS NULL
--                   OR (length(q.arg_last4) >= 4
--                       AND RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 4) = RIGHT(q.arg_last4, 4)))
--              AND (q.arg_id IS NULL OR q.arg_id IN (lower(ltrim(o.order_id, '#')), lower(o.tracking_id)))
--              AND (s.tracker_business_id IS NULL OR o.business_id::text = s.tracker_business_id)
--            ORDER BY o.created_at DESC LIMIT 1) AS proved_order
--     FROM paired q
--     JOIN conversations c ON c.id = q.conversation_id
--     JOIN sites s ON s.id = c.site_id
-- ), staged AS (
--   SELECT h.*,
--     CASE WHEN h.phone_typed AND h.email_typed THEN 'full phone + email'
--          WHEN h.phone_typed THEN 'full phone' WHEN h.email_typed THEN 'email' END AS proof,
--     CASE
--       WHEN jsonb_typeof(h.args) IS DISTINCT FROM 'object'           THEN '0 invalid JSON arguments'
--       WHEN jsonb_typeof(h.res) IS DISTINCT FROM 'object'            THEN '1 no stored or parsable result'
--       WHEN h.res->>'found' IS DISTINCT FROM 'true'
--         OR h.res #>> '{orders,0,order_id}' IS NULL                    THEN '2 order not found'
--       WHEN h.result_at >= timestamptz '2026-09-29 21:58:55+00'        THEN '3 after the deploy (the app verifies these itself)'
--       WHEN h.phone10 IS NULL AND NOT COALESCE(h.email_ok, false)      THEN '4 no full phone or email (name / last 4 / order ID)'
--       WHEN NOT (h.phone_typed OR h.email_typed)                       THEN '5 phone or email not typed by the customer'
--       WHEN h.order_matches IS NULL                                    THEN '6 re-check against orders failed'
--       WHEN h.proved_order IS NULL                                     THEN '7 business scope mismatch'
--       ELSE '8 legacy' END AS stage
--     FROM checked h
-- ), pick AS (
--   SELECT DISTINCT ON (conversation_id) conversation_id, proved_order, result_at, proof
--     FROM staged WHERE stage = '8 legacy'
--    ORDER BY conversation_id, call_at, result_at
-- )
-- -- Chats that would move, by day of the matching lookup and what proved it:
-- SELECT (p.result_at AT TIME ZONE 'UTC')::date AS lookup_day, p.proof, count(*) AS chats
--   FROM pick p
--  GROUP BY ROLLUP (1, 2) ORDER BY 1 NULLS LAST, 2 NULLS LAST;
-- -- For why the rest stay, end the same WITH instead with (stage 3+ = the AI
-- -- found an order before the deploy):
-- --   SELECT best, count(*) AS chats
-- --     FROM (SELECT conversation_id, max(stage) AS best FROM staged GROUP BY 1) x
-- --    GROUP BY 1 ORDER BY 1;
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.try_jsonb(t text) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $f$
  BEGIN RETURN t::jsonb; EXCEPTION WHEN others THEN RETURN NULL; END $f$;

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
), raw AS (
  SELECT k.*,
         CASE WHEN jsonb_typeof(k.args) = 'object'
              THEN NULLIF(lower(ltrim(btrim(translate(k.args->>'order_id',
                     '०१२३४५६७८९', '0123456789')), '# ')), '') END AS arg_id,
         CASE WHEN jsonb_typeof(k.args) = 'object'
              THEN NULLIF(regexp_replace(translate(k.args->>'phone_last4',
                     '०१२३४५६७८९', '0123456789'), '\D', '', 'g'), '') END AS arg_last4,
         CASE WHEN jsonb_typeof(k.args) = 'object'
              THEN NULLIF(regexp_replace(translate(k.args->>'phone',
                     '०१२३४५६७८९', '0123456789'), '\D', '', 'g'), '') END AS arg_phone,
         CASE WHEN jsonb_typeof(k.args) = 'object'
              THEN NULLIF(lower(btrim(k.args->>'email')), '') END AS arg_email
    FROM calls k
), parsed AS (
  SELECT w.*,
         -- The full phone: 10 digits after dropping leading 0s and a leading 91.
         CASE WHEN length(ltrim(w.arg_phone, '0')) = 10 THEN ltrim(w.arg_phone, '0')
              WHEN length(ltrim(w.arg_phone, '0')) = 12 AND ltrim(w.arg_phone, '0') LIKE '91%'
                   THEN substr(ltrim(w.arg_phone, '0'), 3) END AS phone10,
         w.arg_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AS email_ok
    FROM raw w
), paired AS (
  SELECT p.*, r.created_at AS result_at, pg_temp.try_jsonb(r.content) AS res
    FROM parsed p
    LEFT JOIN LATERAL (
      SELECT r.created_at, r.content FROM messages r
       WHERE r.conversation_id = p.conversation_id AND r.sender = 'tool_result'
         AND r.deleted_at IS NULL AND r.metadata->>'tool_call_id' = p.call_id
       ORDER BY r.created_at LIMIT 1) r ON true
), checked AS (
  SELECT q.*,
         q.phone10 IS NOT NULL AND EXISTS (
           SELECT 1 FROM messages v
            WHERE v.conversation_id = q.conversation_id AND v.sender = 'visitor'
              AND v.deleted_at IS NULL AND v.created_at <= q.call_at
              AND regexp_replace(translate(v.content, '०१२३४५६७८९', '0123456789'), '\D', '', 'g')
                  LIKE '%' || q.phone10 || '%') AS phone_typed,
         COALESCE(q.email_ok, false) AND EXISTS (
           SELECT 1 FROM messages v
            WHERE v.conversation_id = q.conversation_id AND v.sender = 'visitor'
              AND v.deleted_at IS NULL AND v.created_at <= q.call_at
              AND strpos(lower(v.content), q.arg_email) > 0) AS email_typed,
         (SELECT o.order_id FROM orders o
           WHERE o.order_id = q.res #>> '{orders,0,order_id}'
             AND (q.arg_phone IS NULL
                  OR RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 10) = q.phone10)
             AND (q.arg_email IS NULL OR lower(btrim(o.customer_email)) = q.arg_email)
             AND (q.arg_last4 IS NULL
                  OR (length(q.arg_last4) >= 4
                      AND RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 4) = RIGHT(q.arg_last4, 4)))
             AND (q.arg_id IS NULL OR q.arg_id IN (lower(ltrim(o.order_id, '#')), lower(o.tracking_id)))
           LIMIT 1) AS order_matches,
         (SELECT o.order_id FROM orders o
           WHERE o.order_id = q.res #>> '{orders,0,order_id}'
             AND (q.arg_phone IS NULL
                  OR RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 10) = q.phone10)
             AND (q.arg_email IS NULL OR lower(btrim(o.customer_email)) = q.arg_email)
             AND (q.arg_last4 IS NULL
                  OR (length(q.arg_last4) >= 4
                      AND RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 4) = RIGHT(q.arg_last4, 4)))
             AND (q.arg_id IS NULL OR q.arg_id IN (lower(ltrim(o.order_id, '#')), lower(o.tracking_id)))
             AND (s.tracker_business_id IS NULL OR o.business_id::text = s.tracker_business_id)
           ORDER BY o.created_at DESC LIMIT 1) AS proved_order
    FROM paired q
    JOIN conversations c ON c.id = q.conversation_id
    JOIN sites s ON s.id = c.site_id
), staged AS (
  SELECT h.*,
    CASE WHEN h.phone_typed AND h.email_typed THEN 'full phone + email'
         WHEN h.phone_typed THEN 'full phone' WHEN h.email_typed THEN 'email' END AS proof,
    CASE
      WHEN jsonb_typeof(h.args) IS DISTINCT FROM 'object'           THEN '0 invalid JSON arguments'
      WHEN jsonb_typeof(h.res) IS DISTINCT FROM 'object'            THEN '1 no stored or parsable result'
      WHEN h.res->>'found' IS DISTINCT FROM 'true'
        OR h.res #>> '{orders,0,order_id}' IS NULL                    THEN '2 order not found'
      WHEN h.result_at >= timestamptz '2026-09-29 21:58:55+00'        THEN '3 after the deploy (the app verifies these itself)'
      WHEN h.phone10 IS NULL AND NOT COALESCE(h.email_ok, false)      THEN '4 no full phone or email (name / last 4 / order ID)'
      WHEN NOT (h.phone_typed OR h.email_typed)                       THEN '5 phone or email not typed by the customer'
      WHEN h.order_matches IS NULL                                    THEN '6 re-check against orders failed'
      WHEN h.proved_order IS NULL                                     THEN '7 business scope mismatch'
      ELSE '8 legacy' END AS stage
    FROM checked h
), pick AS (
  SELECT DISTINCT ON (conversation_id) conversation_id, proved_order, result_at, proof
    FROM staged WHERE stage = '8 legacy'
   ORDER BY conversation_id, call_at, result_at
)
UPDATE conversations c
   SET verified_order_id = p.proved_order,
       verified_at       = p.result_at AT TIME ZONE 'UTC',
       verified_via      = 'legacy'
  FROM pick p
 WHERE c.id = p.conversation_id
   AND c.verified_order_id IS NULL;

COMMIT;
