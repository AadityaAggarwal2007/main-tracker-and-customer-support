-- ============================================================
-- UNDO of chat-tracking-reship-move.sql (one-off, 2026-10-02, owner answer 5).
-- Same id list as the move. Only chats that still carry THAT mark are touched: Ship again, marked by
-- "Chikki (auto)", and the latest Ship again mark event is the move's ('backfill'). A chat a person re-marked,
-- removed or switched to Refund since is left alone. Each undone chat goes back to a person: With team if a
-- person had taken it before the move, else Needs you; never back to the AI with an open complaint (a Closed
-- one stays Closed). Each gets a 'remove' event, as the inbox's Remove button does.
-- CHANGES EXISTING ROWS: apply only after the owner has OK'd the undo in plain words.
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-tracking-reship-move-undo.sql
-- Reminders already sent to those customers cannot be unsent: list them read-only for the team before undoing.
-- After the undo the live code never marks these chats by itself again (they now have a Ship again 'remove').
--
-- TEMPLATE: put the same reviewed ids as in the move file in place of '<id>'. The DO block stops the run
-- (nothing is changed) while any placeholder is left.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('shiptrack.actor', 'system', true), set_config('shiptrack.actor_name', 'Chikki (auto)', true),
       set_config('shiptrack.reason', 'case_backfill_undo', true);
CREATE TEMP TABLE undo_ids (id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO undo_ids (id) VALUES ('<id>'), ('<id>');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM undo_ids WHERE id !~ '^[A-Za-z0-9_-]+$') THEN
    RAISE EXCEPTION 'chat-tracking-reship-move-undo.sql: put the reviewed chat ids in place of the placeholders first';
  END IF;
END $$;
WITH target AS (
  SELECT c.id, c.site_id, c.case_order_id, c.status AS from_status FROM conversations c JOIN undo_ids u ON u.id = c.id
   WHERE c.case_kind = 'reship' AND c.case_marked_by = 'Chikki (auto)'
     AND (SELECT e.actor_role FROM chat_case_events e WHERE e.conversation_id = c.id AND e.kind = 'reship'
           AND e.action = 'mark' ORDER BY e.created_at DESC LIMIT 1) = 'backfill'
   ORDER BY c.id FOR NO KEY UPDATE OF c
), undone AS (
  UPDATE conversations c
     SET status = CASE WHEN c.status = 'resolved' THEN c.status WHEN c.case_prev_status = 'agent_handling' THEN 'agent_handling' ELSE 'human_needed' END,
         case_kind = NULL, case_marked_by = NULL, case_marked_at = NULL, case_order_id = NULL, case_prev_status = NULL,
         updated_at = now()
    FROM target t WHERE c.id = t.id
  RETURNING c.id, t.site_id, t.case_order_id, t.from_status, c.status
), ev AS (
  INSERT INTO chat_case_events (id, conversation_id, site_id, kind, action, order_id, actor, actor_role)
  SELECT gen_random_uuid(), id, site_id, 'reship', 'remove', case_order_id, 'Chikki (auto)', 'backfill_undo' FROM undone
  RETURNING conversation_id
)
-- The staff history row, as the inbox's Remove writes one ('case_remove'; the move wrote 'case_mark').
INSERT INTO chat_events (conversation_id, site_id, kind, actor, actor_name, from_status, to_status, reason, meta)
SELECT id, site_id, 'case_remove', 'system', 'System', from_status, status, 'case_backfill_undo',
       '{"case":"reship","auto":true,"backfill_undo":"2026-10-02"}'::jsonb FROM undone;
-- This run only (now() is the transaction's start, the default of chat_case_events.created_at).
SELECT count(*) AS undone FROM chat_case_events WHERE actor_role = 'backfill_undo' AND created_at = now();
COMMIT;
