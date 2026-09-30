-- ============================================================
-- Cash on Delivery only in some states, 2026-09-30.
-- Asked for by the owner in chat on 2026-09-30: Vastora offers COD only for
-- addresses in Gujarat. With only "COD available" / "No COD" the agent either
-- told customers everywhere that COD is available (they then found no COD
-- option at checkout and got angry) or kept repeating "COD is not available".
--
--   sites.cod_states  NULL = not used. Otherwise the states where COD works,
--                     e.g. 'Gujarat' or 'Gujarat, Maharashtra'. When set, the
--                     agent says COD is available ONLY for addresses in those
--                     states (once, briefly, and only when the customer asks)
--                     and cod_available is not used for that answer.
--
-- Set from Panel Settings > Cash on Delivery > "Only in some states".
-- Apply BEFORE the code deploy: the chat agent and Panel Settings read it.
-- On the VPS after git pull:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-cod-states.sql
-- Additive + idempotent: no existing value is changed or deleted.
-- ============================================================
ALTER TABLE sites ADD COLUMN IF NOT EXISTS cod_states TEXT;

COMMENT ON COLUMN sites.cod_states IS
  'COD only for these states (comma separated), e.g. Gujarat. NULL = not used; then cod_available decides.';
