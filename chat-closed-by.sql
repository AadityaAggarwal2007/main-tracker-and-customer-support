-- ============================================================
-- Who closed a chat. 2026-09-30.
-- Asked for by the owner in chat on 2026-09-30: a Closed chat must say whether the
-- system closed it ("Closed automatically") or a team member did ("Closed by
-- support"), in the thread header and on the Closed list, so nobody has to guess
-- (the Closed tab holds chats from both, and aged chats look alike there).
--
--   closed_by_name  the team member who pressed Close (their display name), set by
--                   PATCH /api/chat/conversations/[id]. NULL = not recorded.
--   closed_at       when they pressed it.
--
-- The system's own closes are already marked by auto_closed_at (chat-auto-close.sql),
-- so the inbox reads a Closed chat like this:
--   auto_closed_at set        -> Closed automatically (4 quiet days)
--   otherwise                 -> Closed by support, with the name and time when known
-- Chats closed before this went live have no name or time: they read plain
-- "Closed by support" (until 2026-09-30 the Close button was the only way but the
-- auto-close to end a chat, so that is true of them; a few are test chats closed
-- from the database). No existing row is changed by this file.
--
-- APPLY BEFORE THE CODE DEPLOY: the new code reads and writes these columns.
-- On the VPS after git pull:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-closed-by.sql
-- Additive + idempotent.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS closed_by_name TEXT,
  ADD COLUMN IF NOT EXISTS closed_at      TIMESTAMP(3);
