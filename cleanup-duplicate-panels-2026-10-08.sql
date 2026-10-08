-- ShipTrack: clean up the duplicate panels and the wrong Kurtiya order (owner 2026-10-08).
--
-- What happened: CSV uploads used to create a panel from every brand in the file, and a wrong CSV once went
-- into Kurtiya. Result: "vestora" (6 orders) and "VASTRIKA STORE" (2 orders) hold COPIES of orders that
-- "vastora" and "VASTRIKA" already have (same number, pin, phone, name, total, date), and "kurtiya" holds a
-- copy of VASTRIKA's #1303. Every upload of such a copy also added a second set of item rows for the same
-- order number (order_items is keyed by the order number only).
--
-- This file, in ONE transaction (psql -v ON_ERROR_STOP=1; anything unexpected raises and rolls everything back):
--   1. finds exactly 9 copy rows and proves each one is the same order as the row it copies;
--   2. backs up every row it will delete into two NEW tables (cleanup_20261008_orders / _order_items);
--   3. deletes the 9 copy order rows;
--   4. deletes only item batches (rows inserted by one later upload) whose content is IDENTICAL to the
--      earliest batch of that order number; a batch that differs is left alone and reported;
--   5. prints what is left.
-- It does NOT touch: the real orders, tracking_history, email_queue, chats, panels (the two empty panels
-- are deleted afterwards from Settings > Danger zone, which shows 0 orders), or the Shopify code.
-- Safe to run once; a second run finds nothing and stops. Undo: copy the rows back from the two backup tables
-- (INSERT INTO orders SELECT * FROM cleanup_20261008_orders; same for order_items). Nothing is dropped.
BEGIN;

-- 0. The panels this file is about must exist exactly once.
DO $$
DECLARE n int;
BEGIN
  FOR n IN SELECT count(*) FROM businesses WHERE name IN ('vastora', 'VASTRIKA', 'vestora', 'VASTRIKA STORE', 'kurtiya') LOOP
    IF n <> 5 THEN RAISE EXCEPTION 'cleanup: expected the 5 panels vastora, VASTRIKA, vestora, VASTRIKA STORE and kurtiya once each, found % rows. Nothing changed.', n; END IF;
  END LOOP;
END $$;

-- 1. The copies: the same order number in the duplicate panel and in the real panel, with the same
--    pin code, phone, name, total (and the same placed time, except Kurtiya's #1303: the CSV and Shopify
--    differ by 3 seconds there).
CREATE TEMP TABLE dup_orders ON COMMIT DROP AS
SELECT o.id AS dup_id, o.order_id, b.name AS dup_panel, r.id AS real_id
  FROM orders o
  JOIN businesses b ON b.id = o.business_id AND b.name IN ('vestora', 'VASTRIKA STORE')
  JOIN orders r ON r.order_id = o.order_id
               AND r.business_id = (SELECT id FROM businesses WHERE name = CASE b.name WHEN 'vestora' THEN 'vastora' ELSE 'VASTRIKA' END)
 WHERE o.order_total = r.order_total
   AND o.pincode IS NOT DISTINCT FROM r.pincode
   AND o.customer_mobile = r.customer_mobile
   AND lower(o.customer_name) = lower(r.customer_name)
   AND o.created_at = r.created_at;

INSERT INTO dup_orders
SELECT o.id, o.order_id, 'kurtiya', r.id
  FROM orders o
  JOIN businesses b ON b.id = o.business_id AND b.name = 'kurtiya'
  JOIN orders r ON r.order_id = o.order_id AND r.business_id = (SELECT id FROM businesses WHERE name = 'VASTRIKA')
 WHERE o.order_id = '1303'
   AND o.source_store = 'csv'
   AND o.order_total = r.order_total
   AND o.pincode IS NOT DISTINCT FROM r.pincode
   AND o.customer_mobile = r.customer_mobile
   AND lower(o.customer_name) = lower(r.customer_name);

DO $$
DECLARE n int; v int; s int; k int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE dup_panel = 'vestora'),
         count(*) FILTER (WHERE dup_panel = 'VASTRIKA STORE'), count(*) FILTER (WHERE dup_panel = 'kurtiya')
    INTO n, v, s, k FROM dup_orders;
  IF n <> 9 OR v <> 6 OR s <> 2 OR k <> 1 THEN
    RAISE EXCEPTION 'cleanup: expected 6 vestora + 2 VASTRIKA STORE + 1 kurtiya copies (9), found % + % + % (%). Nothing changed.', v, s, k, n;
  END IF;
  RAISE NOTICE 'cleanup: 9 copies found and each matches the order it copies.';
END $$;

-- 2. Item batches. One upload chunk inserts all its item rows in one statement, so the rows of one order
--    that came from one upload share one created_at: that is a batch.
CREATE TEMP TABLE item_batches ON COMMIT DROP AS
SELECT i.order_id, i.created_at, count(*) AS n,
       md5(string_agg(coalesce(i.product_name, '') || '|' || coalesce(i.quantity::text, '') || '|' || coalesce(i.price::text, ''),
                      ',' ORDER BY coalesce(i.product_name, ''), i.quantity, i.price)) AS h
  FROM order_items i
 WHERE i.order_id IN (SELECT order_id FROM dup_orders)
 GROUP BY i.order_id, i.created_at;

-- A later batch is a copy only when it is IDENTICAL to the earliest batch of that order number.
CREATE TEMP TABLE item_dups ON COMMIT DROP AS
SELECT b.order_id, b.created_at, b.n
  FROM item_batches b
  JOIN (SELECT DISTINCT ON (order_id) order_id, created_at AS first_at, h AS first_h
          FROM item_batches ORDER BY order_id, created_at) f ON f.order_id = b.order_id
 WHERE b.created_at > f.first_at AND b.h = f.first_h;

-- 3. Backups (new tables; nothing is dropped anywhere).
CREATE TABLE IF NOT EXISTS cleanup_20261008_orders AS SELECT * FROM orders WHERE false;
CREATE TABLE IF NOT EXISTS cleanup_20261008_order_items AS SELECT * FROM order_items WHERE false;
INSERT INTO cleanup_20261008_orders SELECT o.* FROM orders o WHERE o.id IN (SELECT dup_id FROM dup_orders);
INSERT INTO cleanup_20261008_order_items
SELECT i.* FROM order_items i JOIN item_dups d ON d.order_id = i.order_id AND d.created_at = i.created_at;

-- 4. The deletes, with their counts checked.
DO $$
DECLARE del_orders int; del_items int; want_items int;
BEGIN
  SELECT coalesce(sum(n), 0) INTO want_items FROM item_dups;
  DELETE FROM order_items i USING item_dups d WHERE i.order_id = d.order_id AND i.created_at = d.created_at;
  GET DIAGNOSTICS del_items = ROW_COUNT;
  DELETE FROM orders WHERE id IN (SELECT dup_id FROM dup_orders);
  GET DIAGNOSTICS del_orders = ROW_COUNT;
  -- trg_keep_team_items silently keeps the rows of an order the team edited by hand: that shows up here.
  IF del_orders <> 9 THEN RAISE EXCEPTION 'cleanup: deleted % order rows, expected 9. Rolled back.', del_orders; END IF;
  RAISE NOTICE 'cleanup: deleted % copy orders and % duplicate item rows (% planned).', del_orders, del_items, want_items;
END $$;

-- 5. What is left for these order numbers (item_rows above distinct_items = a batch that was NOT identical,
--    left for a person to look at).
SELECT o.order_id, b.name AS panel, o.tracking_status,
       (SELECT count(*) FROM order_items i WHERE i.order_id = o.order_id) AS item_rows,
       (SELECT count(DISTINCT i.product_name) FROM order_items i WHERE i.order_id = o.order_id) AS distinct_items
  FROM orders o JOIN businesses b ON b.id = o.business_id
 WHERE o.order_id IN ('1140', '1148', '4001', '7168', '8608', '8996', '9456', '9578', '1303')
 ORDER BY o.order_id, b.name;

SELECT b.name AS panel, (SELECT count(*) FROM orders o WHERE o.business_id = b.id) AS orders
  FROM businesses b WHERE b.name IN ('vestora', 'VASTRIKA STORE', 'kurtiya') ORDER BY b.name;

COMMIT;
