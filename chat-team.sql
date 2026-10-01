-- ============================================================
-- Chat team (owner, 2026-10-01): who holds a chat, transfers, presence, event log.
-- Super Admin > Senior (permission tick chat.senior, set in Team) > Junior.
-- Additive only. Apply BEFORE deploying the code that reads it:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-team.sql
-- Old code ignores everything here.
--
-- conversations.assigned_to : who holds the chat: team_users.id::text, or 'owner' (the Super Admin,
--   who has no team_users row). NULL = nobody (open pool). Set by the first reply or Take over on a
--   chat nobody holds (a member's or the Super Admin's: owner answer Q2, 2026-10-01), "Take from X",
--   Transfer, a merge, and trg_chat_inherit_owner. NEVER cleared by Close, auto-close or Hand to AI
--   (owner decision 4). Cleared only by a transfer to "Nobody" or the Super Admin's "Give all my open
--   chats to the team" (POST /api/chat/team/release: his open chats only, status unchanged).
-- conversations.assigned_at : when it got its current holder.
-- staff_presence : when each person was last active in ShipTrack (flushed from memory every 30 s at most).
-- chat_events    : append-only, STAFF ONLY log from deploy day (per-member report, part 4). Never read
--   by the AI, the widget, the learner or search. tracker_user may only SELECT and INSERT.
-- trg_chat_status_event  : one row per real status change, whoever made it.
-- trg_chat_inherit_owner : a returning customer's new chat (customer_key set for the first time) or a
--   hand-off to Needs you of an unheld chat goes to whoever held their latest chat. A chat put back in
--   the open pool on purpose (Super Admin release, transfer to "Nobody") stays there, and counts as
--   "held by nobody" when it is the customer's latest chat.
-- ============================================================
SET lock_timeout = '5s';   -- fail fast instead of queueing the live app behind an ALTER

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_to text
  CHECK (assigned_to IS NULL OR assigned_to = 'owner'
         OR assigned_to ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
CREATE INDEX IF NOT EXISTS conversations_assigned_open_idx
  ON conversations (assigned_to) WHERE assigned_to IS NOT NULL AND status <> 'resolved';

CREATE TABLE IF NOT EXISTS staff_presence (
  actor        text PRIMARY KEY,          -- team_users.id::text or 'owner'
  last_seen_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE ON staff_presence TO tracker_user;

CREATE TABLE IF NOT EXISTS chat_events (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  conversation_id text NOT NULL,
  site_id         text,
  kind            text NOT NULL,   -- claim | take | transfer | inherit | merge | reply | case_mark | case_remove | status
  actor           text NOT NULL,   -- team_users.id::text | 'owner' | 'system' | 'ai' | 'customer'
  actor_name      text,            -- display name at that moment (names change; group the report by actor)
  from_owner      text,
  to_owner        text,
  from_status     text,
  to_status       text,
  reason          text,            -- reply | take_over | take | hand_to_ai | close | transfer | case | handover | reopen | auto_close | merged_away | same_customer_new_chat | same_customer_handover
  note            text CHECK (note IS NULL OR char_length(note) BETWEEN 3 AND 200),   -- transfer note: STAFF ONLY
  message_id      text,            -- reply: the staff message
  meta            jsonb            -- {"tier":"owner|senior|junior"}, {"take":"senior|owner|holder_away"}, {"group":[ids]}, {"case":"refund","override":"senior_away"}, {"bulk":true} (release)
);
CREATE INDEX IF NOT EXISTS chat_events_conv_idx  ON chat_events (conversation_id, id);
CREATE INDEX IF NOT EXISTS chat_events_time_idx  ON chat_events (created_at);
CREATE INDEX IF NOT EXISTS chat_events_actor_idx ON chat_events (actor, created_at);
-- The thread names each staff reply by its writer's key (the 'reply' row of that message), so a
-- member's replies keep their name after a rename or a removal.
CREATE INDEX IF NOT EXISTS chat_events_message_idx ON chat_events (message_id) WHERE message_id IS NOT NULL;
-- Chats put back in the open pool on purpose (a transfer to nobody: the Super Admin's release, one row
-- per chat, or "Nobody", one row with the other chats in meta.group); read by trg_chat_inherit_owner.
CREATE INDEX IF NOT EXISTS chat_events_emptied_idx ON chat_events (conversation_id)
  WHERE kind = 'transfer' AND to_owner IS NULL;
GRANT SELECT, INSERT ON chat_events TO tracker_user;               -- no UPDATE / DELETE: history cannot be edited
GRANT USAGE, SELECT ON SEQUENCE chat_events_id_seq TO tracker_user;

-- Every real status change, from any of the ~16 writers. Staff routes name themselves inside their
-- transaction with set_config('shiptrack.actor' / 'shiptrack.actor_name' / 'shiptrack.reason', ..., true).
-- A logging failure only warns: it never blocks a hand-off, a close or a reply.
CREATE OR REPLACE FUNCTION chat_log_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE who text := NULLIF(current_setting('shiptrack.actor', true), '');
BEGIN
  BEGIN
    INSERT INTO chat_events (conversation_id, site_id, kind, actor, actor_name,
                             from_owner, to_owner, from_status, to_status, reason)
    VALUES (NEW.id, NEW.site_id, 'status',
            COALESCE(who, CASE WHEN OLD.status = 'resolved' THEN 'customer'
                               WHEN OLD.status = 'ai_handling' AND NEW.status = 'human_needed' THEN 'ai'
                               ELSE 'system' END),
            NULLIF(current_setting('shiptrack.actor_name', true), ''),
            OLD.assigned_to, NEW.assigned_to, OLD.status, NEW.status,
            COALESCE(NULLIF(current_setting('shiptrack.reason', true), ''),
                     CASE WHEN NEW.merged_into IS NOT NULL AND OLD.merged_into IS NULL THEN 'merged_away'
                          WHEN NEW.status = 'resolved' AND NEW.auto_closed_at IS NOT NULL
                               AND NEW.auto_closed_at IS DISTINCT FROM OLD.auto_closed_at THEN 'auto_close'
                          WHEN OLD.status = 'resolved' THEN 'reopen'
                          WHEN NEW.case_kind IS DISTINCT FROM OLD.case_kind THEN 'case'
                          WHEN NEW.status = 'human_needed' THEN 'handover' END));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_log_status skipped for %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_chat_status_event
  AFTER UPDATE OF status ON conversations
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION chat_log_status();

-- Owner decision 4: a returning customer goes to whoever held their latest chat. Only fills an EMPTY
-- holder, never changes status, never picks a switched-off member, never blocks the update.
-- Emptied on purpose: only a transfer to nobody ever clears a holder (the Super Admin's "Give all my
-- open chats to the team", POST /api/chat/team/release, or a transfer to "Nobody"), and both log it
-- (owner answer 3). Such a chat stays in the open pool: only a reply, a Take over or a transfer gives
-- it a holder again, never this trigger. Without this, the AI's next hand-off would give it straight
-- back to the old holder through one of the customer's Closed chats (a Close keeps the holder). As the
-- customer's latest chat it means "held by nobody", so an older Closed chat's holder does not win
-- either. A later claim makes the holder non-NULL, so a NULL holder with such a row is always emptied.
CREATE OR REPLACE FUNCTION chat_inherit_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev text;
BEGIN
  BEGIN
    IF EXISTS (SELECT 1 FROM chat_events e
                WHERE e.kind = 'transfer' AND e.to_owner IS NULL
                  AND (e.conversation_id = NEW.id OR e.meta->'group' ? NEW.id)) THEN
      RETURN NEW;   -- put back in the open pool on purpose: stays there
    END IF;
    SELECT o.assigned_to INTO prev
      FROM conversations o
     WHERE o.site_id = NEW.site_id AND o.customer_key = NEW.customer_key AND o.source = 'chat'
       AND o.id <> NEW.id AND o.merged_into IS NULL
       AND (o.assigned_to = 'owner'
            OR EXISTS (SELECT 1 FROM team_users t WHERE t.id::text = o.assigned_to AND t.is_active)
            OR (o.assigned_to IS NULL
                AND EXISTS (SELECT 1 FROM chat_events e
                             WHERE e.kind = 'transfer' AND e.to_owner IS NULL
                               AND (e.conversation_id = o.id OR e.meta->'group' ? o.id))))
     ORDER BY COALESCE(o.last_message_at, o.created_at) DESC
     LIMIT 1;   -- the latest chat emptied on purpose: prev is NULL, nothing is inherited
    IF prev IS NOT NULL THEN
      INSERT INTO chat_events (conversation_id, site_id, kind, actor, actor_name, to_owner, from_status, to_status, reason)
      VALUES (NEW.id, NEW.site_id, 'inherit', 'system', 'System', prev, OLD.status, NEW.status,
              CASE WHEN OLD.customer_key IS NULL THEN 'same_customer_new_chat' ELSE 'same_customer_handover' END);
      NEW.assigned_to := prev;      -- only after its event row exists
      NEW.assigned_at := now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_inherit_owner skipped for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_chat_inherit_owner
  BEFORE UPDATE OF status, customer_key ON conversations
  FOR EACH ROW
  WHEN (NEW.assigned_to IS NULL AND NEW.customer_key IS NOT NULL AND NEW.source = 'chat' AND NEW.merged_into IS NULL
        AND (OLD.customer_key IS NULL
             OR (NEW.status = 'human_needed' AND OLD.status IS DISTINCT FROM 'human_needed')))
  EXECUTE FUNCTION chat_inherit_owner();
