-- ============================================================
-- "Phone match": a visitor whose number is a customer's, 2026-09-30.
-- Asked for by the owner in chat on 2026-09-30: a visitor who types (or saves)
-- a phone number that belongs to a customer should not stay in Visitors.
--
--   conversations.phone_match_order_id  the newest order, in THIS site's panel,
--                                       whose phone is a number the visitor typed
--                                       or saved. NULL = no match.
--   conversations.phone_matched_at      when it was found.
--
-- This is for STAFF ONLY: the inbox lists such a chat with the customers and
-- the problem tabs, tagged "Phone match", so the team sees at once that it is
-- probably a real customer. It is NOT verification: verified_order_id (order ID
-- + last 4, or the widget form) is the only thing that lets the AI talk about
-- an order, because anyone can type someone else's number (the 2026-09-11
-- privacy incident). Nothing here is ever sent to the visitor or the AI.
--
-- Set by detectPhoneMatch (src/lib/chat/phone-match.ts) after a visitor message
-- or a saved number; the second part of this file fills it in for the chats
-- already there. Apply BEFORE the code deploy:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-phone-match.sql
-- Additive + idempotent: only chats with no verified order and no match yet are
-- touched, and only these two columns.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS phone_match_order_id TEXT,
  ADD COLUMN IF NOT EXISTS phone_matched_at     TIMESTAMP(3);

-- One-off: the chats already there. A number is 10 digits starting 6-9, standing
-- alone (not part of a longer run of digits), with or without +91 / 0, and with
-- single spaces / dots / dashes inside ("98765 43210"). Order phones are worked
-- out once (op) so the join is an equality: comparing them per pair took ~9 s.
BEGIN;
WITH conv AS (
  SELECT c.id, c.visitor_phone, s.tracker_business_id
    FROM conversations c JOIN sites s ON s.id = c.site_id
   WHERE c.verified_order_id IS NULL AND c.phone_match_order_id IS NULL AND s.tracker_business_id IS NOT NULL
), typed AS (
  SELECT DISTINCT m.conversation_id AS id,
         regexp_replace((regexp_matches(m.content,
                         '(?:^|[^0-9])(?:\+?91[ .-]?|0)?([6-9](?:[ .-]?[0-9]){9})(?![0-9])', 'g'))[1], '[ .-]', '', 'g') AS phone
    FROM messages m JOIN conv ON conv.id = m.conversation_id
   -- The cheap test first: only messages with something like 10 digits get the full
   -- pattern. Without it the backfill took 31 s; with it the extraction takes ~0.1 s.
   WHERE m.sender = 'visitor' AND m.deleted_at IS NULL AND m.content ~ '[6-9](?:[ .-]?[0-9]){9}'
), saved AS (
  SELECT id, CASE WHEN length(d) = 10 THEN d
                  WHEN length(d) = 11 AND d LIKE '0%' THEN right(d, 10)
                  WHEN length(d) = 12 AND d LIKE '91%' THEN right(d, 10) END AS phone
    FROM (SELECT id, regexp_replace(COALESCE(visitor_phone, ''), '\D', '', 'g') AS d FROM conv) x
), nums AS (
  SELECT id, phone FROM typed UNION SELECT id, phone FROM saved WHERE phone ~ '^[6-9]'
), op AS MATERIALIZED (
  SELECT o.order_id, o.created_at, o.business_id::text AS biz,
         right(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 10) AS phone
    FROM orders o WHERE o.business_id IS NOT NULL
), hit AS (
  SELECT DISTINCT ON (n.id) n.id, op.order_id
    FROM nums n
    JOIN conv ON conv.id = n.id
    JOIN op ON op.biz = conv.tracker_business_id AND op.phone = n.phone
   ORDER BY n.id, op.created_at DESC NULLS LAST
)
UPDATE conversations c
   SET phone_match_order_id = hit.order_id, phone_matched_at = now()
  FROM hit
 WHERE c.id = hit.id AND c.verified_order_id IS NULL AND c.phone_match_order_id IS NULL;
COMMIT;
