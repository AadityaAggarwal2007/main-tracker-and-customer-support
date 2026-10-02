-- ============================================================
-- One-off, owner-approved 2026-10-02 (answer 5): open, verified chats whose customer said the tracking ID /
-- link is invalid, fake, shows another order, does not open or is stuck, with the order dispatched and not
-- delivered, move to Ship again ONCE, marked "Chikki (auto)" (actor_role 'backfill'). No message to anyone.
-- CHANGES EXISTING ROWS: apply only after the owner has OK'd this run in plain words. Safe to run twice (a
-- marked chat is skipped). Undo: chat-tracking-reship-move-undo.sql.
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-tracking-reship-move.sql
-- A chat in Needs you now KEEPS its status (red: in Ship again and in Needs you) so nobody already promised a
-- team answer disappears from Needs you; any other open chat goes to agent_handling (only in Ship again).
-- case_prev_status is set as a live Chikki mark sets it: 'agent_handling' for a chat a person had taken,
-- else 'human_needed'. So Remove (or the undo file) sends a chat the AI was answering to Needs you, never
-- back to the AI with an open complaint.
--
-- TEMPLATE: the ids below are '<id>' until the lead has reviewed the read-only list. Order:
--   1. deploy the tracking-claim code first (a moved chat is AI-off; without the Ship again follow-up its
--      customer would get silence),
--   2. node scripts/tracking-reship-candidates.js (read only) and review its list,
--   3. back up the rows (spec 6.3), then put the reviewed ids in BOTH this file and the undo file
--      (the script prints them as ('id'), ('id')), commit, pull on the server, apply.
-- The DO block stops the run (nothing is changed) while any '<id>' placeholder is left.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('shiptrack.actor', 'system', true), set_config('shiptrack.actor_name', 'Chikki (auto)', true),
       set_config('shiptrack.reason', 'case_backfill', true);
CREATE TEMP TABLE move_ids (id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO move_ids (id) VALUES ('<id>'), ('<id>');                      -- the reviewed list
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM move_ids WHERE id !~ '^[A-Za-z0-9_-]+$') THEN
    RAISE EXCEPTION 'chat-tracking-reship-move.sql: put the reviewed chat ids in place of the placeholders first';
  END IF;
END $$;
SELECT c.id FROM conversations c JOIN move_ids m ON m.id = c.id ORDER BY c.id FOR NO KEY UPDATE OF c;
WITH before AS (
  SELECT c.id, c.site_id, c.status, c.verified_order_id FROM conversations c JOIN move_ids m ON m.id = c.id
   WHERE c.case_kind IS NULL AND c.merged_into IS NULL AND c.status <> 'resolved' AND c.source = 'chat'
     AND c.verified_order_id IS NOT NULL AND c.verified_via IN ('form', 'chat_phone')
), moved AS (
  UPDATE conversations c
     SET case_prev_status = CASE WHEN b.status = 'agent_handling' THEN 'agent_handling' ELSE 'human_needed' END,
         case_kind = 'reship', case_marked_by = 'Chikki (auto)', case_marked_at = now(), case_order_id = b.verified_order_id,
         status = CASE WHEN b.status = 'human_needed' THEN 'human_needed' ELSE 'agent_handling' END,
         auto_closed_at = NULL, updated_at = now()
    FROM before b
   WHERE c.id = b.id AND c.case_kind IS NULL
  RETURNING c.id, c.site_id, c.case_order_id, c.status, b.status AS from_status
), ev AS (
  INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
  SELECT gen_random_uuid(), id, site_id, 'reship', 'mark', case_order_id, 'Chikki (auto)', 'backfill' FROM moved
  RETURNING conversation_id
)
INSERT INTO chat_events (conversation_id, site_id, kind, actor, actor_name, from_status, to_status, reason, meta)
SELECT id, site_id, 'case_mark', 'system', 'System', from_status, status, 'case_backfill',
       '{"case":"reship","auto":true,"backfill":"2026-10-02"}'::jsonb FROM moved;
-- This run only (now() is the transaction's start, the default of chat_case_events.created_at).
SELECT count(*) AS moved FROM chat_case_events WHERE actor_role = 'backfill' AND created_at = now();
COMMIT;
-- Checks after: SELECT count(*) FROM chat_case_events WHERE actor_role = 'backfill'  equals the list;
-- spot-check the Ship again section in the inbox.
