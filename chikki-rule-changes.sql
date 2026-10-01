-- ============================================================
-- Chikki's rulebook: changes the owner asks for. 2026-10-01 (owner).
-- Panel Settings > Chikki > Rules lists every rule the AI and the system follow
-- (src/lib/chat/rulebook.ts). An admin writes what should change next to a rule (or asks
-- for a new one, rule_id 'new'); the developer applies it after testing and closes the
-- row ('done', with a note), or the admin withdraws it ('dropped'). Rows are never
-- deleted. Nothing here changes how the AI answers by itself.
-- Additive only.
-- ============================================================
CREATE TABLE IF NOT EXISTS chikki_rule_changes (
  id          uuid PRIMARY KEY,
  rule_id     text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  closed_note text
);
DO $$ BEGIN
  ALTER TABLE chikki_rule_changes ADD CONSTRAINT chikki_rule_changes_status_check CHECK (status IN ('open', 'done', 'dropped'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS chikki_rule_changes_created_idx ON chikki_rule_changes (created_at DESC);

-- The app connects as tracker_user.
GRANT SELECT, INSERT, UPDATE ON chikki_rule_changes TO tracker_user;
