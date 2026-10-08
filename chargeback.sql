-- ============================================================
-- Chargeback protection (owner 2026-10-08: "chargeback ki ek email ... chargeback aate hi pata chal jaye").
-- Every panel gets ONE extra Gmail that the owner types into each payment gateway (Razorpay, Cashfree, PayU ...)
-- as its chargeback / dispute email. ShipTrack reads that Gmail every minute (the existing chat-email-poll
-- cron, no new crontab line), turns each new mail into an alert, matches the order number to an order of the
-- panel, tags that customer's chat, shows a red badge in the admin panel and, when a WhatsApp number is set,
-- sends a WhatsApp message. No reply is ever sent from this Gmail and the AI never reads it.
--   chargeback_mailboxes   one Gmail per panel (business_id text, like mail_verifications); last_uid = the
--                          mailbox as it stood on connect, so old mail is not alerted
--   chargeback_alerts      one row per mail: sender, subject, a short text, the gateway it looks like, the
--                          matched order, new / seen / done, who and when, and how the WhatsApp message went
--   panel_chargeback       per panel: the WhatsApp number and the gateway checklist ("this email is added in
--                          Razorpay: yes / no, by whom, when"), a reminder only, ShipTrack fills nothing in a gateway
-- Staff only (the Super Admin): never read by the widget, the AI reply path or a customer screen.
-- Apply BEFORE deploying the code that reads it. Additive, safe to run twice, never deletes.
-- ============================================================
CREATE TABLE IF NOT EXISTS chargeback_mailboxes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  text NOT NULL UNIQUE,
  email        text NOT NULL UNIQUE,
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_user') THEN
    GRANT SELECT, INSERT, UPDATE ON chargeback_mailboxes, chargeback_alerts, panel_chargeback TO tracker_user;
    GRANT DELETE ON chargeback_mailboxes TO tracker_user;   -- Disconnect in Settings (2026-10-08); alerts and settings are never deleted
  END IF;
END $$;
