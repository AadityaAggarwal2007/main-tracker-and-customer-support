-- ============================================================
-- 12-DAY JOURNEY ENGINE — schema migration
-- Run this in the production DB BEFORE deploying the new build.
-- Safe / additive only. See src/lib/journey.ts.
-- ============================================================

-- Team-confirmed delivery. The day-13 auto-delivery deliberately leaves
-- these NULL, so the app can distinguish a scheduled completion from a
-- delivery a human actually confirmed.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_by TEXT;

-- The journey engine derives each order's stage purely from created_at, so a
-- fast index on (tracking_status, created_at) keeps the cron sweep cheap.
CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders (tracking_status, created_at)
  WHERE is_cancelled = false;

-- ------------------------------------------------------------
-- NOTE: progression_settings is no longer the driver of order
-- progression. The 12-day schedule in src/lib/journey.ts is now the single
-- source of truth (used by the upload importer, the Shopify webhook path,
-- the progress-orders cron and the customer track page alike). The
-- progression_settings table + its admin screen are left in place but have
-- no effect on stage advancement. No data migration is required — existing
-- orders re-derive their correct stage from their own created_at on the next
-- cron run.
-- ------------------------------------------------------------
