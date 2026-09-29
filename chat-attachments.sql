-- ============================================================
-- Files an agent attaches to a chat or email reply.
-- The bytes live here, next to the messages, so there is no separate storage
-- to set up or back up. A file is uploaded first (message_id NULL) and linked
-- to its message when the reply is sent; unsent uploads older than a day are
-- cleared by the upload route.
-- The id is 32 random bytes in hex. It is also the only key to the public URL
-- /api/widget/files/<id>, which the customer's widget loads, and that URL
-- serves a file only once it has been sent.
-- Apply after chat-tables.sql. Additive + idempotent.
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  file_name       TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  data            BYTEA NOT NULL,
  uploaded_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_conversation ON chat_attachments (conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments (message_id);

-- The app connects as tracker_user; a new table gets no grants on its own
-- (see supabase-chat-faq.sql).
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_attachments TO tracker_user;
