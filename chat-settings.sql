-- ============================================
-- Chat Support settings (one row per key)
-- Run once on the VPS:
--   sudo -u postgres psql -d tracking_crm -f chat-settings.sql
-- ============================================
-- The AI model used to live in a module variable in the old chat-support
-- server, so every restart silently reverted it to the env default. It lives
-- here now so a chosen model survives a deploy.
CREATE TABLE IF NOT EXISTS chat_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The app connects as tracker_user. This table was first created without any GRANT, so on the live server
-- every read and write of it failed with "permission denied for table chat_settings" (found 2026-10-08 in the
-- PM2 log): the email draft switch (Settings > Email Support) could not be read (it fails closed: drafts stay
-- ON) or saved, and the office holidays and the chosen AI model could not be saved either.
-- Safe to run again at any time; changes no data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_user') THEN
    GRANT SELECT, INSERT, UPDATE ON chat_settings TO tracker_user;
  END IF;
END $$;
