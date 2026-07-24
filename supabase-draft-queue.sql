-- ============================================
-- Draft Queue Table
-- Stores pending Gmail draft creation jobs.
-- Apps Script polls /api/draft-queue/next every
-- minute to fetch and process 5 at a time.
-- Run this in your Supabase SQL Editor.
-- ============================================

CREATE TABLE IF NOT EXISTS draft_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  email_status  TEXT NOT NULL DEFAULT 'Order Placed',  -- tracking status used in email template
  status        TEXT NOT NULL DEFAULT 'pending',        -- pending | processing | done | failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

-- Index for efficient queue polling (fetch oldest pending first)
CREATE INDEX IF NOT EXISTS idx_draft_queue_status_created
  ON draft_queue (status, created_at ASC);

-- Index for order_id lookups (dedup checks)
CREATE INDEX IF NOT EXISTS idx_draft_queue_order_id
  ON draft_queue (order_id);

-- RLS: allow service role full access
ALTER TABLE draft_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access on draft_queue" ON draft_queue
  FOR ALL USING (true) WITH CHECK (true);
