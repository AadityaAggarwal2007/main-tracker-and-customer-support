-- ============================================================
-- A team member's own name (owner, 2026-10-01: "naam edit kar paaye, har 15 din me ek baar; hum har
-- baar edit kar paayein; humein dikhe unhone kya naam rakha"). My profile (/api/auth/profile) lets a
-- member change their display name once every 15 days (name_changed_at); the owner changes it any
-- time in Team, without touching name_changed_at. Every change is kept in team_name_changes (who,
-- old, new), because old names stay frozen in places like closed_by_name. Customers never see staff
-- names (they see "Vastora Support"). Additive only.
-- ============================================================
ALTER TABLE team_users ADD COLUMN IF NOT EXISTS name_changed_at timestamptz;

CREATE TABLE IF NOT EXISTS team_name_changes (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL,
  old_name    text NOT NULL,
  new_name    text NOT NULL,
  changed_by  text NOT NULL,          -- 'self' or 'owner'
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_name_changes_user_idx ON team_name_changes (user_id, changed_at DESC);

GRANT SELECT, INSERT ON team_name_changes TO tracker_user;
GRANT USAGE, SELECT ON SEQUENCE team_name_changes_id_seq TO tracker_user;
