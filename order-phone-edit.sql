-- ============================================================
-- The team changes the customer's PHONE from Chat Support / the Mail tab too. 2026-10-14 (owner:
-- "number edit karne wala option bhi chaia email aur chat support ma").
-- The Edit address dialog now also changes orders.customer_mobile (PATCH
-- /api/chat/conversations/[id]/address), logged in order_address_changes like the address.
-- This file makes that change STAY: like the address, once the team has edited an order
-- (address_edited_at set), a later CSV upload / resync that does not move address_edited_at keeps
-- the team's phone too. Without this file the edit works, but a CSV re-upload of that order puts
-- the old number back.
-- Safe to run twice. Changes no row when it runs. Needs order-address-edit.sql first.
-- Undo (owner's OK): run order-address-edit.sql again (it restores the address-only version).
-- ============================================================
CREATE OR REPLACE FUNCTION keep_team_address() RETURNS trigger AS $$
BEGIN
  IF OLD.address_edited_at IS NOT NULL
     AND NEW.address_edited_at IS NOT DISTINCT FROM OLD.address_edited_at THEN
    NEW.address_line1   := OLD.address_line1;
    NEW.address_line2   := OLD.address_line2;
    NEW.address_line3   := OLD.address_line3;
    NEW.city            := OLD.city;
    NEW.state           := OLD.state;
    NEW.pincode         := OLD.pincode;
    NEW.customer_mobile := OLD.customer_mobile;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_keep_team_address ON orders;
CREATE TRIGGER trg_keep_team_address
  BEFORE UPDATE OF address_line1, address_line2, address_line3, city, state, pincode, customer_mobile ON orders
  FOR EACH ROW EXECUTE FUNCTION keep_team_address();
