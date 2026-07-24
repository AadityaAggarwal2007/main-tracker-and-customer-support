-- ============================================
-- AUTO-PROGRESSION: Run this in Supabase SQL Editor
-- Adds timed auto-progression for order statuses
-- ============================================

-- 1. Create progression_settings table
CREATE TABLE IF NOT EXISTS progression_settings (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  step_from TEXT NOT NULL,
  step_to TEXT NOT NULL,
  step_order INT NOT NULL,
  delay_minutes INT NOT NULL DEFAULT 180,
  is_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Insert default progression steps
INSERT INTO progression_settings (step_from, step_to, step_order, delay_minutes, is_enabled) VALUES
  ('Order Placed', 'Pickup', 1, 180, true),
  ('Pickup', 'In Transit', 2, 360, true),
  ('In Transit', 'Out for Delivery', 3, 720, true),
  ('Out for Delivery', 'Delivered', 4, 120, true)
ON CONFLICT DO NOTHING;

-- 3. Add status_updated_at column to orders (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'status_updated_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN status_updated_at TIMESTAMPTZ DEFAULT now();
    -- Backfill existing orders
    UPDATE orders SET status_updated_at = created_at WHERE status_updated_at IS NULL;
  END IF;
END $$;

-- 4. Create index for efficient cron queries
CREATE INDEX IF NOT EXISTS idx_orders_status_updated ON orders(tracking_status, status_updated_at)
  WHERE tracking_status NOT IN ('Delivered', 'Cancelled');

-- 5. RLS for progression_settings
ALTER TABLE progression_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read of progression_settings"
  ON progression_settings FOR SELECT
  USING (true);

CREATE POLICY "Allow service role full access to progression_settings"
  ON progression_settings FOR ALL
  USING (true)
  WITH CHECK (true);
