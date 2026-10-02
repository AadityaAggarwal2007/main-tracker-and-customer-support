-- ============================================================
-- Chat team: the Super Admin's customers go to the team (owner answer A5, 2026-10-02).
-- Needs chat-team.sql (part 3). Additive only; safe to run twice. Apply BEFORE deploying the code
-- that describes it (rulebook 7.7):
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f chat-team-owner-back.sql
-- Old code ignores everything here.
--
-- 1. chat_inherit_owner (replaces chat-team.sql's version, same rules otherwise): a returning
--    customer whose latest held chat is the Super Admin's ('owner') inherits nothing: the chat stays
--    in the open pool (an older member's chat does not win either). Except while he still has one of
--    that customer's chats OPEN: then the new chat is his too (one person per customer, never a
--    junior answering the same customer beside him). Released / "Nobody" chats still stay in the
--    pool, switched-off members are still never picked, a failure still only WARNs.
-- 2. trg_chat_owner_back: a Closed chat he holds that the CUSTOMER reopens (a widget message, an
--    email reply, the verify form, the customer's own merge after proving an order) goes back to the
--    open pool, with one transfer event (actor 'system', to nobody, reason 'owner_customer_back').
--    That event is also what keeps the chat in the pool afterwards: trg_chat_inherit_owner never
--    gives a chat with a transfer to nobody back to anyone. A staff action names its person
--    (team-routing.ts setActor: shiptrack.actor) before it changes the status, so his own reply,
--    Take over or Hand to AI on his Closed chat keeps it his (his own replies still claim chats).
--    His OPEN chats stay his ("Give all N to the team" still exists).
-- Trigger order (BEFORE triggers fire in name order; each WHEN sees the row the earlier ones left):
--    trg_chat_inherit_owner, then trg_chat_owner_back. Inherit only fills an EMPTY holder, and
--    trg_chat_owner_back only acts on a chat that was already his BEFORE the update (OLD.assigned_to),
--    so the two never act on the same update, and a chat that becomes his in that same update (an
--    inherit while his chat is open, or a merge target taking his chat's holder) stays his.
--    AFTER triggers see the final row: trg_chat_status_event logs the reopen (from_owner 'owner',
--    to_owner NULL, actor 'customer') and team-score.sql's trg_team_holder_log (when installed)
--    logs 'owner' -> NULL.
-- Undo (owner's OK): DROP TRIGGER IF EXISTS trg_chat_owner_back ON conversations; then run
--    chat-team.sql again (it restores its own chat_inherit_owner). The events stay.
-- Re-running chat-team.sql for any other reason ALSO restores its own chat_inherit_owner (A5 then
--    only half applies): always run this file again right after it.
-- ============================================================
SET lock_timeout = '5s';   -- fail fast instead of queueing the live app behind a trigger change

-- Owner decision 4 + owner answer A5: a returning customer goes to whoever held their latest chat,
-- unless that is the Super Admin: then nobody (the open pool), while none of his chats with that
-- customer is still open. Only fills an EMPTY holder, never changes status, never picks a
-- switched-off member, never blocks the update.
-- Emptied on purpose: only a transfer to nobody ever clears a holder (the Super Admin's "Give all my
-- open chats to the team", POST /api/chat/team/release, a transfer to "Nobody", or trg_chat_owner_back
-- below), and each logs it. Such a chat stays in the open pool: only a reply, a Take over or a
-- transfer gives it a holder again, never this trigger. As the customer's latest chat it means "held
-- by nobody", so an older Closed chat's holder does not win either. A later claim makes the holder
-- non-NULL, so a NULL holder with such a row is always emptied.
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
    -- Owner answer A5: the latest held chat is the Super Admin's: nothing is inherited, the chat
    -- stays in the open pool for the team. Unless he still has one of this customer's chats open:
    -- then it stays with him (one person per customer).
    IF prev = 'owner' AND NOT EXISTS (
         SELECT 1 FROM conversations x
          WHERE x.site_id = NEW.site_id AND x.customer_key = NEW.customer_key AND x.source = 'chat'
            AND x.id <> NEW.id AND x.merged_into IS NULL
            AND x.assigned_to = 'owner' AND x.status <> 'resolved') THEN
      prev := NULL;
    END IF;
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

-- Owner answer A5: a Closed chat the Super Admin holds that the customer reopens goes to the open
-- pool. Only a reopen with no staff person named in the transaction (the customer's own writes:
-- /api/widget/message, /api/widget/verify, email.ts, mergeIntoCustomerChat); every staff route calls
-- setActor before it changes the status. Only a chat that was his before this update (OLD): a
-- Closed chat nobody held that takes his open chat's holder in a merge stays his. The event row
-- comes first, then the holder is cleared; a failure only WARNs and leaves the row as it was (never
-- blocks the customer's message).
CREATE OR REPLACE FUNCTION chat_owner_back() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF NULLIF(current_setting('shiptrack.actor', true), '') IS NOT NULL THEN
      RETURN NEW;   -- a staff action (his own reply, Take over, Hand to AI): he keeps it
    END IF;
    INSERT INTO chat_events (conversation_id, site_id, kind, actor, actor_name, from_owner, to_owner,
                             from_status, to_status, reason, meta)
    VALUES (NEW.id, NEW.site_id, 'transfer', 'system', 'System', 'owner', NULL,
            OLD.status, NEW.status, 'owner_customer_back', '{"auto":true}'::jsonb);
    NEW.assigned_to := NULL;      -- only after its event row exists
    NEW.assigned_at := now();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_owner_back skipped for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_chat_owner_back
  BEFORE UPDATE OF status ON conversations
  FOR EACH ROW
  WHEN (OLD.status = 'resolved' AND NEW.status <> 'resolved' AND OLD.assigned_to = 'owner' AND NEW.assigned_to = 'owner' AND NEW.merged_into IS NULL)
  EXECUTE FUNCTION chat_owner_back();
