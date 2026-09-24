-- ============================================================
-- Origin warehouse city, per panel.
-- Spec §5: "Origin warehouse -> Inter-city hub -> Destination State ->
-- Destination City -> Local Hub". The feed had no origin at all, so early
-- stages read as a generic "Seller facility" with no place name.
-- Additive + idempotent.
-- ============================================================
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS origin_city TEXT;

COMMENT ON COLUMN businesses.origin_city IS
  'City the panel ships FROM. Shown on the tracking feed for the pre-transit stages. NULL = fall back to a generic "Seller warehouse" (never invent a city).';
