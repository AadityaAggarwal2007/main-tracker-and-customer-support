-- ============================================================
-- The owner's own login (the super admin), changeable in the panel. 2026-10-01 (owner: "admin
-- panel ka id password update karne ka option ... sab staff ke paas hai").
-- Until now the super admin was only ADMIN_USERNAME / ADMIN_PASSWORD in /etc/tracker/.env, which
-- the whole staff knew. Team > "Change username / password" (POST /api/auth/account) writes this
-- one row; from then on ONLY this row is the super admin and the .env pair no longer logs in.
-- session_version goes up on every change: every login made with the old details stops working at
-- once (src/lib/auth.ts compares it on each request). Forgot it? On the server:
--   cd /var/www/tracker && node scripts/admin-login-reset.js   (prints a new password once)
-- Additive only.
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_login (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  username        text NOT NULL,
  password_hash   text NOT NULL,
  session_version integer NOT NULL DEFAULT 2,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text
);

GRANT SELECT, INSERT, UPDATE ON admin_login TO tracker_user;
