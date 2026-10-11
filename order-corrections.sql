-- ============================================================
-- Corrections (owner 2026-10-11: verified customers ask in the chat and by mail for small changes to an order:
-- address, pincode, phone number, size, colour, product, pack of 3 / quantity, Buy 1 Get 1. The team promises
-- "kal subah theek ho jayega", nobody writes it down, nobody re-reads the chats, and the change never happens).
-- A team member presses "Correction" on a VERIFIED chat (Chat Support) or a verified sender's mail (Mail tab);
-- that makes ONE row here, shown in Chat Support > Corrections to everyone with Open Chat Support, pending and
-- done. Only the Super Admin and the Manager (team.lead) fix the order and mark the row done / cancelled; a row
-- can be reopened. Nothing is ever sent to the customer by this; the team member tells them. One order can
-- have several corrections (several rows).
--   order_corrections.source        'chat' (website widget), 'email' (an email chat in Chat Support) or 'mail' (the Mail tab)
--   conversation_id                 the chat it was made from (conversations.id), NULL for a Mail-tab correction
--                                   of a sender with no chat yet
--   mail_box_id / mail_uid          the Gmail mailbox (site_emails.id) and the mail's uid, Mail-tab rows only
--   customer_email                  the sender's address, Mail-tab rows only
--   order_id                        the verified order, as stored ('#1553')
--   kinds                           what to change: address, pincode, phone, size, colour, product, pack, bogo, other
--   note                            what exactly (1-500 characters; it can hold the new address or number: staff only,
--                                   never logged, never sent to the AI or a customer)
--   status                          pending | done | cancelled
--   created_by / created_by_name    who asked ('owner' = the Super Admin, else team_users.id) and their name then
--   done_by / done_by_name / done_at / done_note   who closed it (done or cancelled), when, and a note of at most 300
-- Staff only: never read by the widget, the AI reply path or a customer's screen. Additive, safe to run twice,
-- never deletes (tracker_user gets no DELETE). Until it is run the code says "not installed" (503 on the routes,
-- empty in the thread, zero on the Today board) and the inbox keeps working.
--   psql -v ON_ERROR_STOP=1 -f order-corrections.sql
-- ============================================================
CREATE TABLE IF NOT EXISTS order_corrections (
  id               bigserial PRIMARY KEY,
  business_id      text        NOT NULL,
  source           text        NOT NULL CHECK (source IN ('chat', 'email', 'mail')),
  conversation_id  text,
  mail_box_id      text,
  mail_uid         bigint,
  customer_email   text,
  order_id         text        NOT NULL,
  kinds            text[]      NOT NULL CHECK (cardinality(kinds) >= 1),
  note             text        NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
  created_by       text,
  created_by_name  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  done_by          text,
  done_by_name     text,
  done_at          timestamptz,
  done_note        text        CHECK (done_note IS NULL OR length(done_note) <= 300),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_corrections_status_idx ON order_corrections (status, created_at);
CREATE INDEX IF NOT EXISTS order_corrections_panel_idx  ON order_corrections (business_id, status);
CREATE INDEX IF NOT EXISTS order_corrections_conv_idx   ON order_corrections (conversation_id);
CREATE INDEX IF NOT EXISTS order_corrections_order_idx  ON order_corrections (order_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_user') THEN
    GRANT SELECT, INSERT, UPDATE ON order_corrections TO tracker_user;
    GRANT USAGE, SELECT ON SEQUENCE order_corrections_id_seq TO tracker_user;
  END IF;
END $$;

SELECT 'corrections ready' AS result,
       (SELECT count(*) FROM order_corrections) AS rows_ever,
       (SELECT count(*) FROM order_corrections WHERE status = 'pending') AS pending;
