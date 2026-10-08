-- Disconnect the chargeback Gmail from Settings (owner 2026-10-08).
-- Why: chargeback.sql granted tracker_user only SELECT / INSERT / UPDATE, so pressing Disconnect failed with
-- "Could not disconnect it." (the database refused the DELETE). This lets the app remove ONLY the connection row
-- (the Gmail and its App Password). Alerts and panel settings stay: they are never deleted by the app.
-- Safe to run again at any time; changes no data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_user') THEN
    GRANT DELETE ON chargeback_mailboxes TO tracker_user;
  END IF;
END $$;
