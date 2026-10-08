-- ============================================================
-- One chargeback Gmail for TWO panels (owner 2026-10-08: Vastrika and kurtiya use the same Gmail but different
-- gateways: "PayGlocal ke chargeback us panel par, PayU ke us par"). chargeback.sql made the Gmail address UNIQUE
-- across panels, so the second panel could not use it. This file:
--   * removes that one-address-one-panel limit (the address may now appear once per panel; each panel still has only
--     ONE chargeback Gmail: business_id stays unique). The Gmail is read once and each mail goes to the panel whose
--     gateway checklist ticks the mail's gateway, or that has the order the mail names (src/lib/chargeback/routing.ts);
--   * adds chargeback_alerts.routed_by ('single' / 'order' / 'gateway' / 'unsure' / 'manual') so the screen can say
--     "panel unsure" and let the Super Admin move an alert to the other panel.
-- Run it before connecting the same Gmail to a second panel. Changes no data, never deletes a row; safe to run twice.
-- Apply AFTER chargeback.sql.
-- ============================================================
ALTER TABLE chargeback_mailboxes DROP CONSTRAINT IF EXISTS chargeback_mailboxes_email_key;
CREATE INDEX IF NOT EXISTS chargeback_mailboxes_email_idx ON chargeback_mailboxes (lower(email));
ALTER TABLE chargeback_alerts ADD COLUMN IF NOT EXISTS routed_by text;
