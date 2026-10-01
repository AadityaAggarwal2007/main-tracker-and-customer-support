-- ============================================================
-- A panel's default courier. 2026-10-01 (owner: every Vastora order ships with Valmo).
-- Most orders arrive with no courier name (5,629 of Vastora's 6,500), so the chat agent could
-- not say which courier delivers. When an order has none, the agent is shown this one
-- (src/lib/chat/courier.ts). Orders themselves are not changed. Set per panel, e.g.
--   UPDATE businesses SET default_courier = 'Valmo' WHERE name = 'vastora';
-- Additive only.
-- ============================================================
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS default_courier text;
