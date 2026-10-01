-- ============================================================
-- Brain, part 2 (owner: "make the Brain better"). 2026-10-01.
--   audience     who a note is for: 'all', 'verified' (the chat has proved an order) or 'visitor'.
--   shown_count  how many replies the note was shown for; last_shown_at the latest one.
--   brain_usage  which notes the agent was shown for one reply (message_id -> notes), read by
--                the inbox so staff can see WHY the agent answered as it did. Staff only: it is
--                kept out of messages.metadata because the widget returns that to the customer.
-- Additive only.
-- ============================================================
ALTER TABLE brain_notes ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'all';
ALTER TABLE brain_notes ADD COLUMN IF NOT EXISTS shown_count integer NOT NULL DEFAULT 0;
ALTER TABLE brain_notes ADD COLUMN IF NOT EXISTS last_shown_at timestamptz;
DO $$ BEGIN
  ALTER TABLE brain_notes ADD CONSTRAINT brain_notes_audience_check CHECK (audience IN ('all', 'verified', 'visitor'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS brain_usage (
  message_id  text PRIMARY KEY,
  notes       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON brain_usage TO tracker_user;
