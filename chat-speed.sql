-- chat-speed.sql (owner 2026-10-10, step 6: the open chat loads fast)
-- One index so the inbox's "newest 200 messages of this chat" and the 3-second "what changed since" read only that
-- chat's rows, newest first, instead of sorting all of them. Additive: nothing is changed or deleted.
-- CONCURRENTLY: customers and the team keep writing while it is built (a minute or two). It cannot run inside a
-- transaction, so run this file WITHOUT -1:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-speed.sql
-- Safe to run again. Undo (owner's OK): DROP INDEX CONCURRENTLY IF EXISTS messages_conversation_created_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at);

-- A run stopped half way leaves an INVALID index; this row says whether it is ready (valid = t).
SELECT c.relname AS index_name, i.indisvalid AS valid
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname = 'messages_conversation_created_idx';
