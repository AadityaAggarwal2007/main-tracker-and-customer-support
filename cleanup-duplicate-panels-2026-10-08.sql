-- ShipTrack: clean up the duplicate panels and the wrong Kurtiya order (owner 2026-10-08).
--
-- What happened: CSV uploads used to create a panel from every brand in the file, and a wrong CSV once went
-- into Kurtiya. Result: "vestora" (6 orders) and "VASTRIKA STORE" (2 orders) hold COPIES of orders that
-- "vastora" and "VASTRIKA" already have (same number, pin, phone, name, total, date), and "kurtiya" holds a
-- copy of VASTRIKA's #1303. Every upload of such a copy also added a second set of item rows for the same
-- order number (order_items is keyed by the order number only).
--
-- First live run (2026-10-08, 16:15) found 0 copies and stopped with "Nothing changed": order numbers are stored with a
-- leading # ("#1303"), and a copy was written 4-5 seconds before the row it copies, not at the same second. Fixed below.
--
-- This file, in ONE transaction (psql -v ON_ERROR_STOP=1; anything unexpected raises and rolls everything back):
--   1. finds the copy rows (6 + 2 required; Kurtiya's #1303 when it provably is VASTRIKA's order) and proves each one is
--      the same order as the row it copies (pin, phone, name, total, placed within 60 seconds);
--   2. backs up every row it will delete into two NEW tables (cleanup_20261008_orders / _order_items);
--   3. deletes the copy order rows;
--   4. deletes only item batches (rows inserted by one later upload) whose content is IDENTICAL to the
--      earliest batch of that order number; a batch that differs is left alone and reported;
--   5. prints what is left (the panel list at the end should be exactly vastora, VASTRIKA, kurtiya).
-- 4b. then deletes the two duplicate PANELS (vestora, VASTRIKA STORE) if, and only if, each is now completely empty:
--      0 orders, 0 chats, 0 team members limited to it, 0 tickets, not the default panel (the same things the
--      Settings > Danger zone delete removes: its chat site, webhook log, support settings). A panel that is not
--      empty is KEPT and a NOTICE says why. Result: three panels, vastora, VASTRIKA and kurtiya.
-- It does NOT touch: the real orders, tracking_history, email_queue, chats, the other panels, or the Shopify code.
-- Safe to run once; a second run finds nothing and stops. Undo: copy the rows back from the backup tables
-- cleanup_20261008_orders / _order_items / _businesses / _sites (INSERT INTO orders SELECT * FROM cleanup_20261008_orders;
-- same for the others). Nothing is dropped.
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
--    pin code, phone, name, total and a placed time within 60 seconds (the live copies are 4-5 s apart).
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
   AND abs(extract(epoch FROM (o.created_at - r.created_at))) <= 60;

INSERT INTO dup_orders
SELECT o.id, o.order_id, 'kurtiya', r.id
  FROM orders o
  JOIN businesses b ON b.id = o.business_id AND b.name = 'kurtiya'
  JOIN orders r ON r.order_id = o.order_id AND r.business_id = (SELECT id FROM businesses WHERE name = 'VASTRIKA')
 WHERE o.order_id IN ('#1303', '1303')
   AND o.source_store = 'csv'
   AND o.order_total = r.order_total
   AND o.pincode IS NOT DISTINCT FROM r.pincode
   AND o.customer_mobile = r.customer_mobile
   AND lower(o.customer_name) = lower(r.customer_name)
   AND abs(extract(epoch FROM (o.created_at - r.created_at))) <= 60;

DO $$
DECLARE n int; v int; s int; k int; why text;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE dup_panel = 'vestora'),
         count(*) FILTER (WHERE dup_panel = 'VASTRIKA STORE'), count(*) FILTER (WHERE dup_panel = 'kurtiya')
    INTO n, v, s, k FROM dup_orders;
  IF v <> 6 OR s <> 2 THEN
    RAISE EXCEPTION 'cleanup: expected 6 vestora + 2 VASTRIKA STORE copies, found % + %. Nothing changed.', v, s;
  END IF;
  IF k > 1 THEN RAISE EXCEPTION 'cleanup: found % kurtiya copies, expected at most 1. Nothing changed.', k; END IF;
  IF k = 0 THEN
    -- Kurtiya's #1303 is NOT removed unless it is provably VASTRIKA's order. Say why, and go on with the other 8.
    SELECT string_agg(format('%s: total %s, pin %s, phone %s, name %s, seconds apart %s', o.order_id,
             (o.order_total = r.order_total), (o.pincode IS NOT DISTINCT FROM r.pincode), (o.customer_mobile = r.customer_mobile),
             (lower(o.customer_name) = lower(r.customer_name)), round(extract(epoch FROM (o.created_at - r.created_at)))), '; ')
      INTO why
      FROM orders o
      JOIN businesses b ON b.id = o.business_id AND b.name = 'kurtiya'
      JOIN orders r ON r.order_id = o.order_id AND r.business_id = (SELECT id FROM businesses WHERE name = 'VASTRIKA')
     WHERE o.order_id IN ('#1303', '1303');
    RAISE NOTICE 'cleanup: kurtiya #1303 was NOT removed (it did not match VASTRIKA''s order on everything). Compared: %', coalesce(why, 'no #1303 in both panels');
  END IF;
  RAISE NOTICE 'cleanup: % copies found (vestora %, VASTRIKA STORE %, kurtiya %), each matches the order it copies.', n, v, s, k;
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
CREATE TABLE IF NOT EXISTS cleanup_20261008_businesses AS SELECT * FROM businesses WHERE false;
CREATE TABLE IF NOT EXISTS cleanup_20261008_sites AS SELECT * FROM sites WHERE false;
INSERT INTO cleanup_20261008_businesses SELECT b.* FROM businesses b WHERE b.name IN ('vestora', 'VASTRIKA STORE');
INSERT INTO cleanup_20261008_sites SELECT s.* FROM sites s WHERE s.tracker_business_id::text IN (SELECT id::text FROM businesses WHERE name IN ('vestora', 'VASTRIKA STORE'));
INSERT INTO cleanup_20261008_orders SELECT o.* FROM orders o WHERE o.id IN (SELECT dup_id FROM dup_orders);
INSERT INTO cleanup_20261008_order_items
SELECT i.* FROM order_items i JOIN item_dups d ON d.order_id = i.order_id AND d.created_at = i.created_at;

-- 4. The deletes, with their counts checked.
DO $$
DECLARE del_orders int; del_items int; want_items int; want_orders int;
BEGIN
  SELECT count(*) INTO want_orders FROM dup_orders;
  SELECT coalesce(sum(n), 0) INTO want_items FROM item_dups;
  DELETE FROM order_items i USING item_dups d WHERE i.order_id = d.order_id AND i.created_at = d.created_at;
  GET DIAGNOSTICS del_items = ROW_COUNT;
  DELETE FROM orders WHERE id IN (SELECT dup_id FROM dup_orders);
  GET DIAGNOSTICS del_orders = ROW_COUNT;
  -- trg_keep_team_items silently keeps the rows of an order the team edited by hand: that shows up here.
  IF del_orders <> want_orders THEN RAISE EXCEPTION 'cleanup: deleted % order rows, expected %. Rolled back.', del_orders, want_orders; END IF;
  RAISE NOTICE 'cleanup: deleted % copy orders and % duplicate item rows (% planned).', del_orders, del_items, want_items;
END $$;

-- 4b. The two duplicate panels, only when completely empty (the same cleanup the Danger zone does).
DO $$
DECLARE b record; ord int; chats int; team int; tix int;
BEGIN
  FOR b IN SELECT id, name, is_default FROM businesses WHERE name IN ('vestora', 'VASTRIKA STORE') LOOP
    SELECT count(*) INTO ord FROM orders WHERE business_id = b.id;
    SELECT count(*) INTO chats FROM conversations c JOIN sites s ON s.id = c.site_id WHERE s.tracker_business_id::text = b.id::text;
    SELECT count(*) INTO team FROM team_users WHERE business_ids::text[] @> ARRAY[b.id::text];
    SELECT count(*) INTO tix FROM support_tickets WHERE business_id::text = b.id::text;
    IF ord = 0 AND chats = 0 AND team = 0 AND tix = 0 AND NOT b.is_default THEN
      DELETE FROM shopify_webhook_logs WHERE business_id::text = b.id::text;
      DELETE FROM support_settings WHERE business_id::text = b.id::text;
      DELETE FROM sites WHERE tracker_business_id::text = b.id::text;
      DELETE FROM businesses WHERE id = b.id;
      RAISE NOTICE 'cleanup: panel "%" was empty and is deleted.', b.name;
    ELSE
      RAISE NOTICE 'cleanup: panel "%" is KEPT (not empty): orders %, chats %, team members %, tickets %, default %.', b.name, ord, chats, team, tix, b.is_default;
    END IF;
  END LOOP;
END $$;

-- 5. What is left for these order numbers (item_rows above distinct_items = a batch that was NOT identical,
--    left for a person to look at).
SELECT o.order_id, b.name AS panel, o.tracking_status,
       (SELECT count(*) FROM order_items i WHERE i.order_id = o.order_id) AS item_rows,
       (SELECT count(DISTINCT i.product_name) FROM order_items i WHERE i.order_id = o.order_id) AS distinct_items
  FROM orders o JOIN businesses b ON b.id = o.business_id
 WHERE o.order_id IN (SELECT order_id FROM dup_orders) OR o.order_id IN ('#1303', '1303')
 ORDER BY o.order_id, b.name;

SELECT b.name AS panel, (SELECT count(*) FROM orders o WHERE o.business_id = b.id) AS orders,
       (SELECT count(*) FROM sites s WHERE s.tracker_business_id::text = b.id::text) AS chat_sites
  FROM businesses b ORDER BY b.created_at;

COMMIT;
