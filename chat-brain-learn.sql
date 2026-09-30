-- ============================================================
-- The Brain's learning loop. 2026-10-01 (owner's plan: the system SUGGESTS, the owner APPROVES).
--
-- brain_suggestions: a lesson the system drafted from a chat where a team member answered.
--   Nothing here is ever read by the AI. It only becomes a brain_notes row (source 'learned')
--   when an admin approves it in Panel Settings.
-- brain_reviewed: chats already looked at, so none is reviewed twice.
-- Additive only.
-- ============================================================
CREATE TABLE IF NOT EXISTS brain_suggestions (
  id              uuid PRIMARY KEY,
  site_id         text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id text,
  kind            text NOT NULL DEFAULT 'lesson' CHECK (kind IN ('rule', 'fact', 'lesson')),
  title           text NOT NULL,
  body            text NOT NULL,
  topics          text[] NOT NULL DEFAULT '{}',
  why             text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brain_suggestions_site_idx ON brain_suggestions (site_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS brain_reviewed (
  conversation_id text PRIMARY KEY,
  site_id         text,
  had_lesson      boolean NOT NULL DEFAULT false,
  reviewed_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON brain_suggestions TO tracker_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON brain_reviewed TO tracker_user;
