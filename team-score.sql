-- ============================================================
-- Team score (owner, 2026-10-01, part 4): per-member daily report and incentive points.
-- STAFF ONLY: the Super Admin sees everyone, a member who can reply sees only their own score.
-- Read and written only by src/lib/team-score/*, /api/team/score/*
-- and /api/cron/team-score. Never read by the widget, the AI (ai.ts), the learner (brain-*),
-- inbox search or Chikki. Nothing here changes a row of messages, conversations, chat_events,
-- chat_case_events, staff_presence or team_users: the triggers only INSERT into their own log
-- tables, and a logging failure only WARNs (a reply, close, transfer, health update or presence
-- flush is never blocked).
-- Needs chat-team.sql (part 3). Additive only; safe to run twice. Apply BEFORE deploying the code:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -f team-score.sql
-- Undo (owner's OK): drop the 4 triggers (section 9 of the spec); keep the tables.
-- ============================================================
SET lock_timeout = '5s';   -- a busy moment fails fast; just run the file again

-- 0. Who wrote a staff reply: chat_events 'reply' rows looked up by message id.
CREATE INDEX IF NOT EXISTS chat_events_message_idx ON chat_events (message_id) WHERE message_id IS NOT NULL;

-- 1. Every holder change, whoever made it: reply-claim, Take over, Take, Transfer, release,
--    merge, AND the inherit trigger (which sets NEW.assigned_to in a BEFORE trigger, so a
--    trigger "UPDATE OF assigned_to" would miss it: no column list on purpose).
CREATE TABLE IF NOT EXISTS chat_holder_log (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  conversation_id text NOT NULL,
  from_owner      text,
  to_owner        text,
  actor           text,      -- shiptrack.actor of the transaction (setActor), NULL = system
  reason          text,      -- shiptrack.reason (reply | take | take_over | transfer | ...), NULL = system
  source          text NOT NULL DEFAULT 'trigger' CHECK (source IN ('trigger', 'events'))
);
CREATE INDEX IF NOT EXISTS chat_holder_log_conv_idx ON chat_holder_log (conversation_id, at, id);
CREATE INDEX IF NOT EXISTS chat_holder_log_at_idx   ON chat_holder_log (at);
GRANT SELECT, INSERT ON chat_holder_log TO tracker_user;
GRANT USAGE, SELECT ON SEQUENCE chat_holder_log_id_seq TO tracker_user;

CREATE OR REPLACE FUNCTION team_log_holder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO chat_holder_log (conversation_id, from_owner, to_owner, actor, reason)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.assigned_to END, NEW.assigned_to,
            NULLIF(current_setting('shiptrack.actor', true), ''),
            NULLIF(current_setting('shiptrack.reason', true), ''));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'team_log_holder skipped for %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_team_holder_log
  AFTER UPDATE ON conversations
  FOR EACH ROW WHEN (OLD.assigned_to IS DISTINCT FROM NEW.assigned_to)
  EXECUTE FUNCTION team_log_holder();
CREATE OR REPLACE TRIGGER trg_team_holder_log_ins
  AFTER INSERT ON conversations
  FOR EACH ROW WHEN (NEW.assigned_to IS NOT NULL)
  EXECUTE FUNCTION team_log_holder();

-- Holder changes made between the part-3 deploy and this file, rebuilt from chat_events (the main
-- chat + every sibling id in meta.group). A claim's siblings had no holder before (part 3 claims
-- only unheld siblings); a take's / transfer's siblings had the main chat's holder. A re-run, or an
-- event the trigger also caught (same transaction => same now()), is skipped.
INSERT INTO chat_holder_log (at, conversation_id, from_owner, to_owner, actor, reason, source)
SELECT e.created_at, g.conv,
       CASE WHEN g.conv = e.conversation_id OR e.kind <> 'claim' THEN e.from_owner END,
       e.to_owner, NULLIF(e.actor, 'system'), COALESCE(e.reason, e.kind), 'events'
  FROM chat_events e
  CROSS JOIN LATERAL (
    SELECT e.conversation_id AS conv
    UNION
    SELECT x FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(e.meta->'group') = 'array' THEN e.meta->'group' ELSE '[]'::jsonb END) AS x
  ) g
 WHERE e.kind IN ('claim', 'take', 'transfer', 'inherit', 'merge')
   AND NOT EXISTS (SELECT 1 FROM chat_holder_log h
                    WHERE h.conversation_id = g.conv AND h.at = e.created_at
                      AND h.to_owner IS NOT DISTINCT FROM e.to_owner);

-- 2. Health history (conversations keep only the current score). Fires only when health.ts (or
--    its backfill script) writes a new score: health_updated_at is in its SET list.
CREATE TABLE IF NOT EXISTS chat_health_log (
  id              bigserial PRIMARY KEY,
  conversation_id text NOT NULL,
  score           smallint NOT NULL,
  at              timestamptz NOT NULL,     -- health_updated_at of that write (the read it is based on)
  source          text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'seed')),
  logged_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_health_log_conv_idx ON chat_health_log (conversation_id, at, id);
GRANT SELECT, INSERT ON chat_health_log TO tracker_user;
GRANT USAGE, SELECT ON SEQUENCE chat_health_log_id_seq TO tracker_user;

CREATE OR REPLACE FUNCTION team_log_health() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    -- ::timestamptz reads the naive column in the session time zone, the one the writer used.
    INSERT INTO chat_health_log (conversation_id, score, at)
    VALUES (NEW.id, NEW.health_score, COALESCE(NEW.health_updated_at::timestamptz, now()));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'team_log_health skipped for %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_team_health_log
  AFTER UPDATE OF health_updated_at ON conversations
  FOR EACH ROW WHEN (NEW.health_score IS NOT NULL AND NEW.health_updated_at IS DISTINCT FROM OLD.health_updated_at)
  EXECUTE FUNCTION team_log_health();
-- Seed: every scored chat's current score, once (valid from its own read time until the next write).
INSERT INTO chat_health_log (conversation_id, score, at, source)
SELECT c.id, c.health_score, c.health_updated_at::timestamptz, 'seed'
  FROM conversations c
 WHERE c.health_score IS NOT NULL AND c.health_updated_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM chat_health_log h WHERE h.conversation_id = c.id);

-- 3. Who was in ShipTrack on which India day (from part 3's staff_presence flush, every <= 30 s,
--    real activity only: auth.ts notePresence). No app change.
CREATE TABLE IF NOT EXISTS staff_presence_days (
  actor      text NOT NULL,              -- team_users.id::text | 'owner'
  day        date NOT NULL,              -- India day
  first_seen timestamptz NOT NULL,
  last_seen  timestamptz NOT NULL,
  PRIMARY KEY (actor, day)
);
GRANT SELECT, INSERT, UPDATE ON staff_presence_days TO tracker_user;
CREATE OR REPLACE FUNCTION team_presence_day() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO staff_presence_days (actor, day, first_seen, last_seen)
    VALUES (NEW.actor, (NEW.last_seen_at AT TIME ZONE 'Asia/Kolkata')::date, NEW.last_seen_at, NEW.last_seen_at)
    ON CONFLICT (actor, day) DO UPDATE
      SET first_seen = LEAST(staff_presence_days.first_seen, EXCLUDED.first_seen),
          last_seen  = GREATEST(staff_presence_days.last_seen, EXCLUDED.last_seen);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'team_presence_day skipped for %: %', NEW.actor, SQLERRM;
  END;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_team_presence_day
  AFTER INSERT OR UPDATE ON staff_presence
  FOR EACH ROW EXECUTE FUNCTION team_presence_day();

-- 4. The AI's verdict on a customer message the keywords could not decide. One row per message,
--    ever: no UPDATE / DELETE grant, so a verdict is never re-rolled and never paid for twice.
CREATE TABLE IF NOT EXISTS team_score_verdicts (
  message_id      text PRIMARY KEY,          -- messages.id of the CUSTOMER's message
  conversation_id text NOT NULL,             -- where it was when judged (a merge moves messages)
  thanks          boolean,                   -- NULL only for 'ai_failed'
  convinced       boolean,
  source          text NOT NULL CHECK (source IN ('ai', 'ai_unclear', 'ai_failed')),
  model           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_score_verdicts_time_idx ON team_score_verdicts (created_at);
GRANT SELECT, INSERT ON team_score_verdicts TO tracker_user;

-- 5. Point weights and the points start day. Append-only: a change is a new row whose
--    effective_from is today or later (the API refuses earlier), so past days keep their points.
--    The FIRST row's created_at is the install time: the holder/health/presence logs start then.
--    Default row = the owner's answers of 2026-10-02: convinced +2, closed while the customer waited
--    -2, and points start on the India day this file is applied (not the day after).
CREATE TABLE IF NOT EXISTS team_score_settings (
  id             bigserial PRIMARY KEY,
  weights        jsonb NOT NULL,
  effective_from date NOT NULL,             -- India day the weights apply from
  points_from    date NOT NULL,             -- India day points start (the latest row's value is used)
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  note           text
);
GRANT SELECT, INSERT ON team_score_settings TO tracker_user;
GRANT USAGE, SELECT ON SEQUENCE team_score_settings_id_seq TO tracker_user;
INSERT INTO team_score_settings (weights, effective_from, points_from, created_by, note)
SELECT '{"thanks":3,"solved":2,"fast_reply":1,"unanswered_2h":-3,"angry":-2,"convinced":2,"closed_waiting":-2,"customer_answered":0}'::jsonb,
       DATE '2026-01-01', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'system',
       'Owner answers 2026-10-02 (A2 weights, A4 points from the install day)'
 WHERE NOT EXISTS (SELECT 1 FROM team_score_settings);

-- 6. Frozen days. The cron writes one 'auto' row per India day once it is settled (D+2 01:00 IST,
--    later if AI checks are pending); the Super Admin may add a 'recompute' row with a reason.
--    The latest row of a day is the one shown. INSERT-only: a frozen day cannot be edited.
CREATE TABLE IF NOT EXISTS team_score_days (
  id             bigserial PRIMARY KEY,
  day            date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('auto', 'recompute')),
  engine_version text NOT NULL,
  settings_id    bigint NOT NULL,
  summary        jsonb NOT NULL,            -- DayResult without items (small)
  items          jsonb NOT NULL,            -- ScoreItem[] (no customer text)
  ai_pending     int NOT NULL DEFAULT 0,
  by_actor       text NOT NULL,             -- 'cron' | 'owner'
  reason         text CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'recompute') = (reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS team_score_days_one_auto ON team_score_days (day) WHERE kind = 'auto';
CREATE INDEX IF NOT EXISTS team_score_days_day_idx ON team_score_days (day, id DESC);
GRANT SELECT, INSERT ON team_score_days TO tracker_user;
GRANT USAGE, SELECT ON SEQUENCE team_score_days_id_seq TO tracker_user;
