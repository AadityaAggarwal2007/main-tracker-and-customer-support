-- ============================================================
-- The team changes an order's ITEMS (product / colour lines) from Chat Support. 2026-10-03 (owner:
-- "customer na jo order kia ha woh bhi edit ho saka jaisa color and product edit ho saka ... upper
-- header ma hi"). Same shape as the address edit (order-address-edit.sql): staff with "Change
-- order status" (orders.update) change the items in the chat of a VERIFIED customer (PATCH
-- /api/chat/conversations/[id]/items). It changes ShipTrack only: not Shopify, not the courier.
-- Chikki's lookup_order and the customer's tracking page read order_items live, so they show the
-- team's items from the next lookup / page load on.
--
--   orders.items_edited_at / _by   when and by whom the team last changed the items
--   order_item_changes             every change, old and new items as JSON (history, never edited)
--   trg_keep_team_items            once the team changed an order's items, a later Shopify
--                                  webhook or CSV upload (both DELETE the order's rows and INSERT
--                                  Shopify's lines again) leaves the team's rows exactly as they
--                                  are: the trigger runs BEFORE each INSERT / UPDATE / DELETE on
--                                  order_items and returns NULL (= skip this row, no error) when
--                                  the row's order has items_edited_at set. The webhook / upload
--                                  still update the rest of the order. Only the team's own edit
--                                  passes: the PATCH route runs SET LOCAL app.team_items_edit = '1'
--                                  inside its transaction, and the trigger lets every row through
--                                  while that setting is '1'. The resync route never touches
--                                  order_items. New orders (items_edited_at NULL) are not affected.
--                                  Deleting an order still works: the FK cascade deletes its rows
--                                  after the order row is gone, so the lookup finds no
--                                  items_edited_at and lets the delete through.
-- To give an order back to Shopify's lines: UPDATE orders SET items_edited_at = NULL WHERE id = ...,
-- then re-upload the CSV.
-- Additive only: no existing row changes when this runs. Safe to run twice.
-- ============================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_edited_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_edited_by text;

CREATE TABLE IF NOT EXISTS order_item_changes (
  id              bigserial PRIMARY KEY,
  order_uuid      uuid NOT NULL,
  order_id        text NOT NULL,
  business_id     uuid,
  conversation_id text,
  old_items       jsonb NOT NULL,
  new_items       jsonb NOT NULL,
  changed_by      text NOT NULL,
  changed_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_item_changes_order_idx ON order_item_changes (order_uuid, created_at DESC);

GRANT SELECT, INSERT ON order_item_changes TO tracker_user;
GRANT USAGE, SELECT ON SEQUENCE order_item_changes_id_seq TO tracker_user;

-- Row-level guard on order_items (see the header). RETURN NULL in a BEFORE ROW trigger skips that
-- one row silently: the webhook's "DELETE FROM order_items WHERE order_id = $1" deletes nothing for
-- an edited order and its INSERT adds nothing, with no error, so the rest of its work goes on. The
-- upload route's "DELETE ... WHERE order_id = ANY($1)" over a batch of existing orders skips only
-- the edited orders' rows and still replaces the others'.
CREATE OR REPLACE FUNCTION keep_team_items() RETURNS trigger AS $$
DECLARE
  edited timestamptz;
BEGIN
  -- The team's own edit (PATCH .../items) sets this for its transaction only.
  IF current_setting('app.team_items_edit', true) = '1' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT o.items_edited_at INTO edited FROM orders o WHERE o.order_id = OLD.order_id;
    IF edited IS NOT NULL THEN RETURN NULL; END IF;
    RETURN OLD;
  END IF;
  SELECT o.items_edited_at INTO edited FROM orders o WHERE o.order_id = NEW.order_id;
  IF edited IS NOT NULL THEN RETURN NULL; END IF;
  -- An UPDATE that moves a row to another order: the row's old order counts too.
  IF TG_OP = 'UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    SELECT o.items_edited_at INTO edited FROM orders o WHERE o.order_id = OLD.order_id;
    IF edited IS NOT NULL THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_keep_team_items ON order_items;
CREATE TRIGGER trg_keep_team_items
  BEFORE INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION keep_team_items();
