-- ============================================================
-- One chat "slab" per verified customer, 2026-09-30.
-- Asked for by the owner in chat on 2026-09-30: the same verified customer
-- ended up with several separate chats in the inbox (a new one for every
-- browser, and a new one after staff closed the last), so staff had to piece
-- one customer's story together from rows spread down the list.
--
-- conversations.customer_key = the last 10 digits of the phone on the order a
-- chat verified (proved by the widget form with the full phone, or by the
-- AI's lookup with order ID + last 4). Chats of one customer on one site share
-- it, so the inbox shows them as ONE row with their whole history
-- (/api/chat/conversations groups by (site_id, customer_key),
-- /api/chat/conversations/[id] returns the older chats as `earlier`), and the
-- widget's "Verify yourself" form carries on the customer's existing chat for
-- the same order instead of opening a new one (/api/widget/verify). NULL = not grouped
-- (visitors, email, and chats whose order has no usable phone).
-- The key is the phone number itself: it is never sent to the widget or the
-- AI, only used to match rows.
--
-- APPLY BEFORE THE CODE DEPLOY: the new code reads and writes customer_key.
-- On the VPS after git pull:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-customer-key.sql
-- Apply after chat-verified.sql (and chat-verified-legacy.sql if it is used).
-- RUN IT ONCE MORE RIGHT AFTER THE DEPLOY: a chat verified in the minutes
-- between this file and the new code going live is written by the old code,
-- which leaves customer_key NULL, and only the backfill below fills it in.
-- Idempotent: running it again only keys verified chats still NULL.
-- ============================================================

-- ── 1. Schema (additive) ────────────────────────────────────
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_key TEXT;   -- last 10 digits of the verified order's phone

-- The inbox groups and the verify form looks up one customer's chats per site,
-- newest first.
CREATE INDEX IF NOT EXISTS conversations_customer_key_idx
  ON conversations (site_id, customer_key, last_message_at DESC)
  WHERE customer_key IS NOT NULL;

-- ── 2. One-off backfill (separate transaction) ──────────────
-- Existing verified chats (verified_via 'form', 'chat' or 'legacy') get the key
-- of the order they verified, so the chats a customer already has are grouped
-- from the first day. Only source = 'chat' (email threads are never grouped),
-- only rows still NULL (never overwrites), and the order must belong to the
-- site's own panel (orders.business_id is uuid, sites.tracker_business_id is
-- text, so compared as text). Same rule as the app: the phone reduced to its
-- digits, at least 10 of them, last 10 kept (drops a leading 91 or 0). When
-- the order is missing, has no such phone, or order rows disagree, the chat
-- stays NULL. Only customer_key is written (updated_at is left alone so the
-- inbox order does not change).
-- It fills a new column only; no existing value is changed or deleted.
-- Dry run 2026-09-30 (read-only): 861 verified chats, 861 would get a key,
-- 753 customers, 86 of them with 2+ chats (194 chats).
-- psql prints "UPDATE n" = chats given a key.
BEGIN;

WITH keys AS (
  SELECT c.id,
         CASE WHEN count(DISTINCT k.key) = 1 THEN min(k.key) END AS key
    FROM conversations c
    JOIN sites s  ON s.id = c.site_id
    JOIN orders o ON o.order_id = c.verified_order_id
                 AND o.business_id::text = s.tracker_business_id::text
    CROSS JOIN LATERAL (
      SELECT CASE WHEN length(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g')) >= 10
                  THEN RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\D', '', 'g'), 10)
             END AS key
    ) k
   WHERE c.source = 'chat'
     AND c.verified_order_id IS NOT NULL
     AND c.customer_key IS NULL
   GROUP BY c.id
)
UPDATE conversations c
   SET customer_key = keys.key
  FROM keys
 WHERE keys.id = c.id
   AND keys.key IS NOT NULL
   AND c.customer_key IS NULL;

COMMIT;
