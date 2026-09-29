-- ============================================================
-- Editing and deleting messages we sent (AI or team), from the chat inbox.
-- An edit changes the message row in place; a delete only marks it
-- (soft delete) so nothing is ever lost. Every change first copies the old
-- text into message_revisions, so the original AI wording and each earlier
-- version stay on record.
-- Who sent a message is the existing messages.sender column ('ai', 'agent';
-- the username of an agent is metadata.agent), so no sender-type column.
-- Apply after chat-tables.sql. Additive + idempotent.
-- ============================================================
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_by  TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by TEXT;

CREATE TABLE IF NOT EXISTS message_revisions (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL,
  action           TEXT NOT NULL,          -- 'edit' | 'delete'
  previous_content TEXT NOT NULL,          -- the text before this change
  new_content      TEXT,                   -- the text after an edit
  actor            TEXT NOT NULL,          -- username
  actor_role       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_revisions_message ON message_revisions (message_id, created_at);

-- The app connects as tracker_user. The history is append-only: the app can
-- read and add to it, never change or remove it. (The new columns on messages
-- inherit that table's existing grants.)
GRANT SELECT, INSERT ON message_revisions TO tracker_user;
