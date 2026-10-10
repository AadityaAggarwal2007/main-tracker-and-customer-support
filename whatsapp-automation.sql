-- WhatsApp automation (owner 2026-10-10): the "order placed" message to every new order's customer and the
-- tracking-link message 48 hours later. ADDITIVE and safe to run twice. Apply BEFORE switching a panel on;
-- until it is run the automation stays idle and the WhatsApp > Automation tab says it is not installed.
--   psql -v ON_ERROR_STOP=1 -f whatsapp-automation.sql
-- One row per (panel, order, kind): the unique key is what stops a customer from getting the same message twice.
CREATE TABLE IF NOT EXISTS wa_auto_sends (
  id          BIGSERIAL PRIMARY KEY,
  business_id TEXT        NOT NULL,
  order_id    TEXT        NOT NULL,
  kind        TEXT        NOT NULL CHECK (kind IN ('placed', 'tracking')),
  status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  to_number   TEXT,
  template    TEXT,
  body_text   TEXT,                       -- the filled-in message, as the customer saw it
  wa_id       TEXT,                       -- Meta's message id: delivery reports land on the row by it
  error       TEXT,                       -- why it failed or was skipped, in words
  code        INTEGER,                    -- Meta's error code when it failed
  attempts    INTEGER     NOT NULL DEFAULT 0,
  due_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, order_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_wa_auto_due ON wa_auto_sends (status, due_at);
CREATE INDEX IF NOT EXISTS idx_wa_auto_wa_id ON wa_auto_sends (wa_id) WHERE wa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_auto_panel ON wa_auto_sends (business_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON wa_auto_sends TO tracker_user;
GRANT USAGE, SELECT ON SEQUENCE wa_auto_sends_id_seq TO tracker_user;
-- never DELETE: these rows are the record of what customers were sent
SELECT 'wa_auto_sends ready' AS result, count(*) AS rows FROM wa_auto_sends;
