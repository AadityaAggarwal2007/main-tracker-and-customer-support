-- ============================================================
-- Payments > Brand Directory (owner 2026-10-17: "ek payment ka section ... sirf super admin"). One row per
-- brand the owner keeps a note of: who founded / owns it, the brand's name, the bank account name and two
-- fields the owner names himself (e.g. "GST Firm" = "Jiva Enterprises", "Payment Gateway" = "PayU").
-- These brands are NOT ShipTrack panels; nothing else in ShipTrack reads this table.
--   founder_name                      required, 1-80 characters
--   brand_name                        required, 1-80 characters; the same name may be saved more than once
--                                     (owner 2026-10-17: "existing brand likh sakte hain, ye rule mat laga")
--   bank_account_name                 optional, at most 120
--   custom_field_1_label / _value     the owner's own label (at most 40) and value (at most 200), optional
--   custom_field_2_label / _value     the same, second field
--   created_by / updated_by           who saved it ('owner' = the Super Admin)
-- Super Admin only (every route checks); never in a customer's screen, the AI or a log line.
-- Additive and safe to run twice. tracker_user may also DELETE here: the Delete button removes ONE brand row
-- (the owner's own record, asked for in plain words); nothing else is ever deleted.
-- Until it is run the Payments tab says "not installed" and the rest of ShipTrack is unchanged.
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f brand-directory.sql
-- ============================================================
CREATE TABLE IF NOT EXISTS brand_directory (
  id                    bigserial   PRIMARY KEY,
  founder_name          text        NOT NULL CHECK (length(btrim(founder_name)) BETWEEN 1 AND 80),
  brand_name            text        NOT NULL CHECK (length(btrim(brand_name)) BETWEEN 1 AND 80),
  bank_account_name     text        NOT NULL DEFAULT '' CHECK (length(bank_account_name) <= 120),
  custom_field_1_label  text        NOT NULL DEFAULT '' CHECK (length(custom_field_1_label) <= 40),
  custom_field_1_value  text        NOT NULL DEFAULT '' CHECK (length(custom_field_1_value) <= 200),
  custom_field_2_label  text        NOT NULL DEFAULT '' CHECK (length(custom_field_2_label) <= 40),
  custom_field_2_value  text        NOT NULL DEFAULT '' CHECK (length(custom_field_2_value) <= 200),
  created_by            text,
  updated_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- The first version kept one brand name once; the owner asked for that rule to go (2026-10-17). Dropping the
-- unique index removes no row. A plain index keeps the name lookups quick.
DROP INDEX IF EXISTS brand_directory_name_key;
CREATE INDEX IF NOT EXISTS brand_directory_name_idx ON brand_directory (lower(btrim(brand_name)));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON brand_directory TO tracker_user;
    GRANT USAGE, SELECT ON SEQUENCE brand_directory_id_seq TO tracker_user;
  END IF;
END $$;

SELECT 'brand_directory ready' AS status, count(*) AS brands FROM brand_directory;
