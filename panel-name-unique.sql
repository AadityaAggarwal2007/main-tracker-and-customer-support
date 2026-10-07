-- ShipTrack: no two panels with the same name (owner 2026-10-07).
-- The app already refuses a create / rename to a name another panel has (src/lib/panel-name.ts,
-- /api/businesses). This is the database's own guard for two requests at the same moment: capital
-- letters and extra spaces do not make a name different. Additive and safe to run twice. If two
-- panels ALREADY share a name (ignoring case and spaces) nothing is created and the names are
-- listed: rename one of them in Panel Settings, then run this file again. Nothing is deleted.
DO $$
DECLARE dupes text;
BEGIN
  SELECT string_agg(k || ' (' || n || ' panels)', ', ') INTO dupes FROM (
    SELECT lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) AS k, count(*) AS n
      FROM businesses GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dupes IS NOT NULL THEN
    RAISE NOTICE 'panel-name-unique: NOT created, these names are used by more than one panel: %', dupes;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS businesses_name_key_uniq
      ON businesses (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));
    RAISE NOTICE 'panel-name-unique: index in place';
  END IF;
END $$;
