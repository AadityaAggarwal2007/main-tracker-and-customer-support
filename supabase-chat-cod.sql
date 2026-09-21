-- ============================================================
-- Per-panel COD availability for the chat agent
-- Additive + idempotent. Safe to re-run.
-- ============================================================

-- Tri-state on purpose:
--   NULL  = not configured -> the agent does not answer COD questions at all
--           (this is today's behaviour, so existing panels change nothing)
--   TRUE  = COD is offered  -> agent confirms COD is available
--   FALSE = COD not offered -> agent says COD is not available
-- A plain boolean defaulting to false would make every unconfigured panel
-- start telling customers "no COD", which would be wrong for most of them.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS cod_available BOOLEAN;

COMMENT ON COLUMN sites.cod_available IS
  'Chat agent COD answer: NULL = stay silent, true = available, false = not available';
