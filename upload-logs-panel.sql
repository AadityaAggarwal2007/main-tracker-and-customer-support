-- ShipTrack: a real record of every CSV upload (owner 2026-10-08).
-- Kurtiya got a wrong order (#1303) from a CSV upload and nothing said which file went into which
-- panel. upload_logs now also keeps the panel, the first and last order number, the warning the
-- uploader clicked past, and one row per upload (the app adds each chunk's counts to it).
-- Additive and safe to run twice. Nothing is deleted or changed in existing rows. Apply BEFORE the
-- code that writes it; until then the app falls back to the old one-line record.
ALTER TABLE upload_logs ADD COLUMN IF NOT EXISTS upload_id    TEXT;
ALTER TABLE upload_logs ADD COLUMN IF NOT EXISTS business_id  TEXT;
ALTER TABLE upload_logs ADD COLUMN IF NOT EXISTS panel_name   TEXT;
ALTER TABLE upload_logs ADD COLUMN IF NOT EXISTS first_order  TEXT;
ALTER TABLE upload_logs ADD COLUMN IF NOT EXISTS last_order   TEXT;
ALTER TABLE upload_logs ADD COLUMN IF NOT EXISTS warning_text TEXT;
ALTER TABLE upload_logs ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS upload_logs_upload_id_uniq ON upload_logs (upload_id) WHERE upload_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS upload_logs_created_idx ON upload_logs (created_at DESC);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_user') THEN
    GRANT SELECT, INSERT, UPDATE ON upload_logs TO tracker_user;
  END IF;
END $$;
