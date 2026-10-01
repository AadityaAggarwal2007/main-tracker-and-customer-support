-- ============================================================
-- Brain, part 3: how OUR TEAM handles difficult customers. 2026-10-01 (owner's request).
--
-- brain_examples: a real reply a team member sent to a customer in a difficult situation
-- (refund / cancel, wrong tracking, late order, anger, fraud claim, payment ...), after which
-- the customer calmed down. Personal details are masked before it is stored. The AI is shown
-- 1-2 APPROVED examples of the same situation as a guide to tone and manner, never to copy
-- facts or promises. Drafted by /api/cron/brain-suggest, approved by an admin in Panel Settings.
-- Additive only.
-- ============================================================
CREATE TABLE IF NOT EXISTS brain_examples (
  id              uuid PRIMARY KEY,
  site_id         text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  situation       text NOT NULL,
  customer_said   text NOT NULL,
  team_replied    text NOT NULL,
  why             text,
  source          text NOT NULL DEFAULT 'team_reply',   -- 'team_reply' | 'team_edit' | 'owner'
  conversation_id text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  is_enabled      boolean NOT NULL DEFAULT true,
  shown_count     integer NOT NULL DEFAULT 0,
  last_shown_at   timestamptz,
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brain_examples_site_idx ON brain_examples (site_id, status, situation);
GRANT SELECT, INSERT, UPDATE, DELETE ON brain_examples TO tracker_user;

-- Chats reviewed before examples existed are reviewed again once for examples (v = 2).
ALTER TABLE brain_reviewed ADD COLUMN IF NOT EXISTS v integer NOT NULL DEFAULT 1;
