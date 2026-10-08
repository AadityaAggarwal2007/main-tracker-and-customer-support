-- ============================================================
-- Chargeback protection: EVERYTHING the database needs, in one file (owner 2026-10-08: "sab kuch ek saath set
-- chahiye"). Run it ONCE on the server; it is safe to run again at any time, changes no data, never deletes a row.
--   ssh shiptrack-vps 'cd /var/www/tracker && git pull origin main && sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chargeback-setup.sql'
-- It is the sum of chargeback.sql (the tables), chargeback-shared.sql (one Gmail on several panels) and
-- chargeback-disconnect.sql (Disconnect in Settings), so it does not matter which of those were run before.
-- ============================================================

-- 1. The tables (chargeback.sql)
CREATE TABLE IF NOT EXISTS chargeback_mailboxes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  text NOT NULL UNIQUE,
  email        text NOT NULL,
  app_password text NOT NULL,
  last_uid     bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chargeback_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   text NOT NULL,
  mailbox_id    uuid NOT NULL,
  uid           bigint NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  from_address  text NOT NULL DEFAULT '',
  from_name     text NOT NULL DEFAULT '',
  subject       text NOT NULL DEFAULT '',
  snippet       text NOT NULL DEFAULT '',
  gateway       text NOT NULL DEFAULT 'Unknown',
  order_id      text,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'done')),
  seen_by_name  text,
  seen_at       timestamptz,
  done_by_name  text,
  done_at       timestamptz,
  note          text,
  notify_status text NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS chargeback_alerts_mail_unique ON chargeback_alerts (mailbox_id, uid);
CREATE INDEX IF NOT EXISTS chargeback_alerts_open_idx ON chargeback_alerts (business_id, order_id) WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS chargeback_alerts_status_idx ON chargeback_alerts (status, received_at DESC);
CREATE TABLE IF NOT EXISTS panel_chargeback (
  business_id     text PRIMARY KEY,
  whatsapp_number text NOT NULL DEFAULT '',
  gateways        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text NOT NULL DEFAULT ''
);

-- 2. One Gmail on several panels (chargeback-shared.sql): the one-address-one-panel limit goes; each panel still
--    has only ONE chargeback Gmail (business_id stays unique); the alert remembers how its panel was chosen.
ALTER TABLE chargeback_mailboxes DROP CONSTRAINT IF EXISTS chargeback_mailboxes_email_key;
CREATE INDEX IF NOT EXISTS chargeback_mailboxes_email_idx ON chargeback_mailboxes (lower(email));
ALTER TABLE chargeback_alerts ADD COLUMN IF NOT EXISTS routed_by text;

-- 3. What the app may do (chargeback.sql + chargeback-disconnect.sql): alerts and settings are never deleted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_user') THEN
    GRANT SELECT, INSERT, UPDATE ON chargeback_mailboxes, chargeback_alerts, panel_chargeback TO tracker_user;
    GRANT DELETE ON chargeback_mailboxes TO tracker_user;
  END IF;
END $$;

-- 4. Shows what the install looks like now (read only).
SELECT (SELECT count(*) FROM chargeback_mailboxes) AS gmails_connected,
       (SELECT count(DISTINCT lower(email)) FROM chargeback_mailboxes) AS distinct_gmails,
       (SELECT count(*) FROM chargeback_alerts WHERE status <> 'done') AS open_alerts,
       NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chargeback_mailboxes_email_key') AS shared_gmail_allowed,
       has_table_privilege('tracker_user', 'chargeback_mailboxes', 'DELETE') AS disconnect_allowed;
