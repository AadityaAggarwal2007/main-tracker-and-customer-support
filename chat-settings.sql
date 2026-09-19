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
