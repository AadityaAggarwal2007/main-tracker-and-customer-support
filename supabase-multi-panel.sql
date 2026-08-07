-- ============================================================
-- Multi-Panel Migration — Run on VPS PostgreSQL
-- ============================================================

-- 1. Add Shopify + branding fields to businesses
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS shopify_domain       TEXT,
  ADD COLUMN IF NOT EXISTS shopify_api_token    TEXT,
  ADD COLUMN IF NOT EXISTS shopify_webhook_id   TEXT,
  ADD COLUMN IF NOT EXISTS shopify_webhook_secret TEXT,
  ADD COLUMN IF NOT EXISTS is_shopify_connected BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS tracking_domain      TEXT,      -- e.g. https://track.mybrand.com
  ADD COLUMN IF NOT EXISTS primary_color        TEXT DEFAULT '#4F46E5';

-- 2. Add panel access to team_users
--    NULL = admin access to all panels
--    UUID[] = specific panel IDs the user can access
ALTER TABLE team_users
  ADD COLUMN IF NOT EXISTS business_ids UUID[] DEFAULT NULL;

-- 3. Shopify webhook event log
CREATE TABLE IF NOT EXISTS shopify_webhook_logs (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id     UUID REFERENCES businesses(id) ON DELETE SET NULL,
  shopify_order_id TEXT,
  event           TEXT DEFAULT 'orders/create',
  status          TEXT DEFAULT 'received',
  error           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopify_webhook_logs_business ON shopify_webhook_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_shopify_webhook_logs_created  ON shopify_webhook_logs(created_at);

-- 4. Add source_store if missing (already used in orders route filter)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS source_store TEXT DEFAULT 'csv';

-- Verify
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'businesses'
ORDER BY ordinal_position;
