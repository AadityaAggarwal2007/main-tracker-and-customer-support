-- ============================================================
-- A subject line on every chat, 2026-09-30.
-- Asked for by the owner in chat on 2026-09-30: staff could not tell what a
-- customer wanted without reading the whole chat again. Each chat now keeps a
-- short subject for the customer's CURRENT concern, which the inbox shows at
-- the top of the thread and in the list:
--   subject_label      one of SUBJECT_LABELS in src/lib/chat/subject.ts
--                      ('Address change', 'Refund', 'Wrong tracking link', ...)
--   subject_summary    one line for staff, at most 90 characters, never a
--                      phone number, email, address or link
--   subject_updated_at when the chat was read to write it
-- Written by updateConversationSubject (src/lib/chat/subject.ts), a small
-- model call made after each new customer message (/api/widget/message and
-- the email poll), so it changes when the customer's concern does. Only these
-- three columns are ever written by it (updated_at is left alone).
-- NULL = no subject yet; the inbox then shows the category as before.
--
-- APPLY BEFORE THE CODE DEPLOY: the new code reads and writes these columns.
-- On the VPS after git pull:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-subject.sql
-- Apply after chat-tables.sql. Additive + idempotent: no existing value is
-- changed or deleted. Open chats of the last 7 days are given a subject by a
-- one-off script run after the deploy (not in Git); older chats get one when
-- the customer next writes.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS subject_label      TEXT,
  ADD COLUMN IF NOT EXISTS subject_summary    TEXT,
  ADD COLUMN IF NOT EXISTS subject_updated_at TIMESTAMP(3);
