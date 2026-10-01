-- ============================================================
-- The team changes a delivery address from Chat Support. 2026-10-01 (owner: "chat support me
-- address edit karne ka option ... baar baar Shopify se CSV download karke karna padta hai").
-- Shopify only sends NEW orders here (webhook orders/create), so an address changed later in
-- Shopify reached ShipTrack only through a CSV re-upload. Now staff with "Change order status"
-- (orders.update) change it in the chat of a VERIFIED customer (PATCH
-- /api/chat/conversations/[id]/address). It changes ShipTrack only: not Shopify, not the courier.
--
--   orders.address_edited_at / _by   when and by whom the team last changed the address
--   order_address_changes            every change, old and new address (history, never edited)
--   trg_keep_team_address            once the team changed an order's address, a later Shopify
--                                    webhook, CSV upload or resync keeps the team's address (it
--                                    still updates everything else). Only a team edit, which
--                                    moves address_edited_at, changes the address again.
-- Additive only: no existing row changes when this runs.
-- ============================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_edited_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_edited_by text;

CREATE TABLE IF NOT EXISTS order_address_changes (
  id              bigserial PRIMARY KEY,
  order_uuid      uuid NOT NULL,
  order_id        text NOT NULL,
  business_id     uuid,
  conversation_id text,
  old_address     jsonb NOT NULL,
  new_address     jsonb NOT NULL,
  changed_by      text NOT NULL,
  changed_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_address_changes_order_idx ON order_address_changes (order_uuid, created_at DESC);

GRANT SELECT, INSERT ON order_address_changes TO tracker_user;
GRANT USAGE, SELECT ON SEQUENCE order_address_changes_id_seq TO tracker_user;

CREATE OR REPLACE FUNCTION keep_team_address() RETURNS trigger AS $$
BEGIN
  IF OLD.address_edited_at IS NOT NULL
     AND NEW.address_edited_at IS NOT DISTINCT FROM OLD.address_edited_at THEN
    NEW.address_line1 := OLD.address_line1;
    NEW.address_line2 := OLD.address_line2;
    NEW.address_line3 := OLD.address_line3;
    NEW.city          := OLD.city;
    NEW.state         := OLD.state;
    NEW.pincode       := OLD.pincode;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_keep_team_address ON orders;
CREATE TRIGGER trg_keep_team_address
  BEFORE UPDATE OF address_line1, address_line2, address_line3, city, state, pincode ON orders
  FOR EACH ROW EXECUTE FUNCTION keep_team_address();
