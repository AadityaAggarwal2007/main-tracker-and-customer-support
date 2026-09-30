-- ============================================================
-- One chat per customer: merging a duplicate chat into the customer's own. 2026-10-01.
-- Asked for by the owner in chat: a customer who proves an order in the chat (order
-- ID + full phone) while an older chat of theirs sits on another device must end up
-- with ONE chat and its history, not two.
--
--   merged_into   set on the chat whose messages were moved into another chat. That chat
--                 stays as an empty, Closed shell (nothing is ever deleted) and is left
--                 out of the inbox; a device that still holds its id is sent to the chat
--                 it was merged into (widget routes follow merged_into).
--
-- Apply after chat-tables.sql. Additive + idempotent. Applied BEFORE the code that
-- reads it is deployed: every widget request and the inbox list read this column.
-- Undo (only if nothing else depends on it): ALTER TABLE conversations DROP COLUMN merged_into;
-- ============================================================
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS merged_into TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_merged_into ON conversations (merged_into) WHERE merged_into IS NOT NULL;
