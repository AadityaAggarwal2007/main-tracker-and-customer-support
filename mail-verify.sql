-- ============================================================
-- Which Gmail sender has been verified for which order (owner 2026-10-08: "har ek mail ko verify karwate
-- chalein ... admin ya koi bhi ladka"). In the Mail tab a team member asks the sender for the Order ID and
-- the FULL phone number on the order; when the customer answers, the member types both in "Verify", the
-- server checks them exactly like the chat's verify form (verifyOrderByPhone: order ID + full phone, inside
-- this panel only) and only then writes a row here. The sender's address alone proves nothing.
--   business_id      the panel (businesses.id as text): the same address can be verified in two panels
--   email            the sender's address, lower case
--   order_id         orders.order_id as stored, e.g. '#1553'
--   verified_by      'owner' or team_users.id; verified_by_name = the name then (kept if the member is removed)
--   removed_at/by    "Remove" = a wrong click; the row stays as a record, it just stops counting
-- Also, when a verification is saved, the email chats of that sender in the panel's Chat Support are moved
-- to verified (conversations.verified_via = 'mail': a team check, so the automatic Refund promise, which
-- needs 'form' / 'chat_phone', is NOT made for it).
-- Staff only: never read by the widget, the AI reply path or the customer's screens.
-- Apply BEFORE deploying the code that reads it (until then Verify answers 503 and the Mail tab shows every
-- sender as not verified). Additive, safe to run twice, never deletes.
-- ============================================================
CREATE TABLE IF NOT EXISTS mail_verifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      text NOT NULL,
  email            text NOT NULL,
  order_id         text NOT NULL,
  verified_by      text NOT NULL,
  verified_by_name text NOT NULL DEFAULT '',
  verified_at      timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz,
  removed_by       text
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_verifications_unique
  ON mail_verifications (business_id, email, order_id);
CREATE INDEX IF NOT EXISTS mail_verifications_order_idx
  ON mail_verifications (business_id, order_id) WHERE removed_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_user') THEN
    GRANT SELECT, INSERT, UPDATE ON mail_verifications TO tracker_user;
  END IF;
END $$;
