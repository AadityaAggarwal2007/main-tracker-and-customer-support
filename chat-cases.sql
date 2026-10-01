-- ============================================================
-- Refund / Ship again cases. 2026-10-01 (owner).
-- A team member marks a verified customer's chat for a Refund or to Ship the order again. The chat
-- then shows ONLY under that section of the inbox (Refund / Ship again, below AI handling), the AI
-- stops answering it (status agent_handling), and nothing is sent to the customer. The owner's
-- experts open the section to see who marked how many, per day, to stop chargebacks and refunds
-- given without reason. Anyone (not a viewer) can Remove a mark: the chat goes back to the status
-- it had, and the history below keeps both.
--
--   conversations.case_kind        'refund' | 'reship' | NULL
--   conversations.case_marked_by   the team member's name; case_marked_at when
--   conversations.case_order_id    the chat's verified (or phone-matched) order at that moment
--   conversations.case_prev_status the status before the mark, restored by Remove
--   chat_case_events               every mark and remove: who, when, which order
-- Additive only.
-- ============================================================
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS case_kind text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS case_marked_by text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS case_marked_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS case_order_id text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS case_prev_status text;
DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_case_kind_check CHECK (case_kind IN ('refund', 'reship'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS conversations_case_idx ON conversations (case_kind, case_marked_at DESC) WHERE case_kind IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_case_events (
  id              uuid PRIMARY KEY,
  conversation_id text NOT NULL,
  site_id         text,
  kind            text NOT NULL CHECK (kind IN ('refund', 'reship')),
  action          text NOT NULL CHECK (action IN ('mark', 'remove')),
  order_id        text,
  actor           text NOT NULL,
  actor_role      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_case_events_conv_idx ON chat_case_events (conversation_id, created_at);
GRANT SELECT, INSERT ON chat_case_events TO tracker_user;
