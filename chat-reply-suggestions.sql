-- ============================================================
-- Suggested replies for the team (owner 2026-10-04: "ladkon ke saath dikkat hai, bahut spelling
-- mistake, dhang se baat nahi karte ... 2-3-4 option, chun lo ya khud type karo"). When a team
-- member opens a verified customer's chat, Chikki drafts 3 replies in the team's own manner
-- (Chikki's notes, team examples, saved answers and locked rules) in the customer's language; a
-- click puts one in the reply box, "Sudharo" fixes the spelling and grammar of whatever the team
-- member typed. Every draft and every fix is recorded here (owner: "record toh kar le"):
--   reply_suggestions.kind            'suggest' (3 options) or 'polish' (one corrected text)
--   after_message_id                  the customer message the options answer (the cache key:
--                                     the same chat is not drafted twice for the same message)
--   lang                              'auto' (the customer's language), 'en' or 'hi' (Hinglish)
--   input_text                        the team member's own draft, for 'polish' rows only
--   options                           the drafted texts (jsonb array of strings)
--   picked_index / picked_at          which option the team member clicked
--   sent_message_id / sent_edited     the reply it became, and whether it was changed first
-- Staff only: never read by the widget, the AI reply path or the customer's screens.
-- Additive only, safe to run twice, never deletes.
-- ============================================================
CREATE TABLE IF NOT EXISTS reply_suggestions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  text NOT NULL,
  site_id          text,
  kind             text NOT NULL DEFAULT 'suggest' CHECK (kind IN ('suggest', 'polish')),
  after_message_id text,
  lang             text NOT NULL DEFAULT 'auto' CHECK (lang IN ('auto', 'en', 'hi')),
  input_text       text,
  options          jsonb NOT NULL DEFAULT '[]'::jsonb,
  model            text,
  prompt_tokens    integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  ms               integer NOT NULL DEFAULT 0,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  picked_index     integer,
  picked_at        timestamptz,
  sent_message_id  text,
  sent_edited      boolean,
  sent_at          timestamptz
);
CREATE INDEX IF NOT EXISTS reply_suggestions_conv_idx ON reply_suggestions (conversation_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON reply_suggestions TO tracker_user;
