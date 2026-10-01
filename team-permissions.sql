-- ============================================================
-- Team logins with their own permissions. 2026-10-01 (owner).
-- The owner (super admin) gives each team member a role (Admin / Manager / Chat agent / Viewer,
-- stored as panel_admin / manager / agent / viewer), the panels they may use (business_ids, as
-- before) and, if wanted, their own ticks (permissions; NULL = the role's list, see
-- src/lib/permissions.ts). session_version goes up on a password reset: the member's old logins
-- stop working at once. Passwords are scrypt hashes since this change (src/lib/auth.ts).
-- Additive only. team_users is already GRANTed to tracker_user.
-- ============================================================
ALTER TABLE team_users ADD COLUMN IF NOT EXISTS permissions text[];
ALTER TABLE team_users ADD COLUMN IF NOT EXISTS session_version int NOT NULL DEFAULT 1;
ALTER TABLE team_users ADD COLUMN IF NOT EXISTS created_by text;
