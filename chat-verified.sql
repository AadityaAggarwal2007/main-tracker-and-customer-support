-- ============================================================
-- Which order a chat has proved it owns.
-- Set when the customer fills the widget's "Verify yourself" form (order ID +
-- full phone, checked by /api/widget/verify) or when the AI's lookup_order
-- finds their order (order ID + last 4). From then on the AI keeps that order
-- in view and never asks for the order ID or phone digits again in that chat,
-- and the inbox shows the chat under Customers instead of Visitors.
-- Existing conversations are left as they are (NULL = visitor).
-- Apply after chat-tables.sql. Additive + idempotent.
-- ============================================================
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS verified_order_id TEXT;          -- orders.order_id, e.g. '#1234'
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS verified_at       TIMESTAMP(3);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS verified_via      TEXT;          -- 'form' | 'chat'

-- The inbox lists Visitors / Customers per site, newest first.
CREATE INDEX IF NOT EXISTS conversations_verified_idx
  ON conversations (site_id, (verified_order_id IS NOT NULL), last_message_at DESC);
