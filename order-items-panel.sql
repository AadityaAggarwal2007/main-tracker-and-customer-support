-- ============================================================
-- order_items gets the PANEL of its order. 2026-10-13 (owner; kurtiya #1918 showed 13 item lines from three panels).
--
-- Every Shopify store numbers its orders from #1001, so the same order number is an order of two or three panels
-- (on 13 Oct: 2,223 numbers; VASTRIKA 2,222, vastora 2,221, kurtiya 1,241). order_items had only order_id, so each
-- panel's order showed the other panels' lines too (tracking page, Chikki, order emails, refund form, Chat Support),
-- and a CSV upload's "delete the order's items, insert the CSV's" wiped the other panels' lines of that number.
--
-- This file (additive; nothing is deleted; safe to run twice; one transaction):
--   1. order_items.business_id (uuid, the panel) + an index (order_id, business_id).
--   2. Fills it for the rows that have none, in three steps, each only where the answer is certain:
--        A. the order number belongs to ONE panel                       -> that panel
--        B. shared number: exactly one panel's order with that number was created within 10 minutes of the row
--           (the webhook / CSV writes the lines right after the order; on 13 Oct no row was near two panels)
--        C. still empty: the row's brand (Shopify's vendor) is, among the rows A and B placed, at least 95 % one
--           panel's (20 rows or more), and that panel has an order with this number                -> that panel
--      Rows none of the steps can place stay empty (NULL) and are counted at the end; the app shows a row only
--      with its own panel's order, so an empty row is shown nowhere and never mixed in.
--   3. trg_items_panel: a row inserted WITHOUT a panel (the Shopify webhook's code is frozen and does not name one)
--      gets the panel of the order with that number created in the last 10 minutes, else the one updated last.
--   4. keep_team_items (order-items-edit.sql) now reads the edited flag of the row's OWN panel's order: before,
--      "WHERE o.order_id = ..." picked any of the panels' orders.
--
-- Run (the owner's yes first):
--   ssh shiptrack-vps 'cd /var/www/tracker && git pull -q origin main && sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f order-items-panel.sql'
-- The last lines print how many rows each step placed and how many are left empty.
-- Undo: the app code that reads the column comes AFTER this file; to undo the file itself (owner's OK):
--   DROP TRIGGER IF EXISTS trg_items_panel ON order_items;  (the column can stay: old code ignores it)
-- ============================================================
BEGIN;
-- The backfill below only FILLS the new column; let it through the team-edited guard (trg_keep_team_items would
-- otherwise skip the rows of an order the team edited). This transaction only.
SET LOCAL app.team_items_edit = '1';

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS business_id uuid;
CREATE INDEX IF NOT EXISTS order_items_order_panel_idx ON order_items (order_id, business_id);

CREATE TEMP TABLE items_panel_report (step text, rows_placed bigint) ON COMMIT DROP;

-- A. The number belongs to one panel.
WITH one AS (
  SELECT order_id, (array_agg(DISTINCT business_id))[1] AS business_id
    FROM orders WHERE business_id IS NOT NULL
   GROUP BY order_id HAVING count(DISTINCT business_id) = 1
), done AS (
  UPDATE order_items oi SET business_id = one.business_id
    FROM one WHERE oi.order_id = one.order_id AND oi.business_id IS NULL
  RETURNING 1
)
INSERT INTO items_panel_report SELECT 'A one panel', count(*) FROM done;

-- B. Shared number: exactly one panel's order created within 10 minutes of the row.
WITH near AS (
  SELECT oi.id, (array_agg(DISTINCT o.business_id))[1] AS business_id, count(DISTINCT o.business_id) AS n
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id AND o.business_id IS NOT NULL
   WHERE oi.business_id IS NULL
     AND abs(extract(epoch FROM (oi.created_at - o.created_at))) < 600
   GROUP BY oi.id
), done AS (
  UPDATE order_items oi SET business_id = near.business_id
    FROM near WHERE near.id = oi.id AND near.n = 1 AND oi.business_id IS NULL
  RETURNING 1
)
INSERT INTO items_panel_report SELECT 'B created together', count(*) FROM done;

-- C. Still empty: the brand, learned from the rows A and B placed.
WITH m AS (
  SELECT lower(btrim(brand)) AS br, business_id, count(*) AS n,
         sum(count(*)) OVER (PARTITION BY lower(btrim(brand))) AS tot
    FROM order_items
   WHERE business_id IS NOT NULL AND btrim(coalesce(brand, '')) <> ''
   GROUP BY 1, 2
), best AS (
  SELECT br, business_id FROM m WHERE n >= 20 AND n >= 0.95 * tot
), done AS (
  UPDATE order_items oi SET business_id = best.business_id
    FROM best
   WHERE oi.business_id IS NULL
     AND lower(btrim(oi.brand)) = best.br
     AND EXISTS (SELECT 1 FROM orders o WHERE o.order_id = oi.order_id AND o.business_id = best.business_id)
  RETURNING 1
)
INSERT INTO items_panel_report SELECT 'C brand', count(*) FROM done;

-- 3. New rows without a panel (the frozen Shopify webhook): the order with that number created in the last
--    10 minutes (the webhook writes the lines right after the order), else the one updated last.
CREATE OR REPLACE FUNCTION order_items_panel() RETURNS trigger AS $$
BEGIN
  IF NEW.business_id IS NULL THEN
    SELECT o.business_id INTO NEW.business_id
      FROM orders o
     WHERE o.order_id = NEW.order_id AND o.business_id IS NOT NULL
     ORDER BY (o.created_at > now() - interval '10 minutes') DESC, o.created_at DESC, o.updated_at DESC NULLS LAST
     LIMIT 1;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- Triggers fire in name order: trg_items_panel (fills the panel) runs before trg_keep_team_items (reads it).
DROP TRIGGER IF EXISTS trg_items_panel ON order_items;
CREATE TRIGGER trg_items_panel
  BEFORE INSERT OR UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_panel();

-- 4. The team's edited-items guard reads the row's own panel's order (any panel's when the row has none).
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
    SELECT max(o.items_edited_at) INTO edited FROM orders o
     WHERE o.order_id = OLD.order_id AND (OLD.business_id IS NULL OR o.business_id = OLD.business_id);
    IF edited IS NOT NULL THEN RETURN NULL; END IF;
    RETURN OLD;
  END IF;
  SELECT max(o.items_edited_at) INTO edited FROM orders o
   WHERE o.order_id = NEW.order_id AND (NEW.business_id IS NULL OR o.business_id = NEW.business_id);
  IF edited IS NOT NULL THEN RETURN NULL; END IF;
  -- An UPDATE that moves a row to another order: the row's old order counts too.
  IF TG_OP = 'UPDATE' AND (NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.business_id IS DISTINCT FROM OLD.business_id) THEN
    SELECT max(o.items_edited_at) INTO edited FROM orders o
     WHERE o.order_id = OLD.order_id AND (OLD.business_id IS NULL OR o.business_id = OLD.business_id);
    IF edited IS NOT NULL THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

INSERT INTO items_panel_report
SELECT 'left empty (shown nowhere)', count(*) FROM order_items WHERE business_id IS NULL;

SELECT step, rows_placed FROM items_panel_report;
SELECT b.name AS panel, count(*) AS item_rows
  FROM order_items oi JOIN businesses b ON b.id = oi.business_id
 GROUP BY b.name ORDER BY 2 DESC;

COMMIT;
