-- ============================================================
-- Customer health: how upset is this customer? 2026-09-30.
-- Asked for by the owner in chat on 2026-09-30: staff should see at a glance
-- which customers are frustrated (repeated refund demands, abusive language,
-- threats, waiting for days) so they can be answered first and a chargeback
-- is avoided, instead of reading every chat.
--
--   health_score       0-100 frustration / chargeback risk (higher = worse)
--   health_reason      one short line for staff: "Refund asked 4 times, swearing"
--   health_signals     the counts behind it (refund, abuse, threat, ... waitingDays)
--   health_updated_at  when the chat was read to work it out
--
-- Written by updateConversationHealth (src/lib/chat/health.ts) after each new
-- customer message, from the customer's recent messages (all their chats on
-- the site) and the scoring rules in src/lib/chat/health-rules.ts. The inbox
-- shows it in the thread header and on the list row, and keeps every OPEN chat
-- with a score of 65+ (HEALTH_PIN_MIN in health-rules.ts) at the top of the list
-- until it is Closed.
-- NULL = not scored yet (no customer message since this went live).
--
-- APPLY BEFORE THE CODE DEPLOY: the new code reads and writes these columns.
-- On the VPS after git pull:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-health.sql
-- Additive + idempotent: no existing value is changed or deleted. Open chats of
-- the last 7 days are scored by a one-off script run after the deploy (not in
-- Git); other chats get a score when the customer next writes.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS health_score      SMALLINT,
  ADD COLUMN IF NOT EXISTS health_reason     TEXT,
  ADD COLUMN IF NOT EXISTS health_signals    JSONB,
  ADD COLUMN IF NOT EXISTS health_updated_at TIMESTAMP(3);
