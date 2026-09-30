-- ============================================================
-- The Brain: lessons and facts the support agent reads, kept in the database so the owner
-- can add and change them without a deploy. 2026-10-01 (owner's request).
--
--   site_id   the panel's chat site; NULL = common to every panel.
--   kind      'rule' (how to act), 'fact' (something true about the store), 'lesson'
--             (learned from a real chat).
--   topics    when the agent is shown it: any of refund, cancel, payment, delivery,
--             tracking, address, cod, contact, exchange, damaged, verify. A note with
--             `always` is shown on every message.
--   source    'owner' (typed in Panel Settings), 'seed' (written by the first import),
--             'learned' (suggested by the system and approved by the owner).
--
-- Additive only. The locked master rules (SHIPTRACK_MASTER_RULES.md) stay in code and
-- always win over any note.
-- ============================================================
CREATE TABLE IF NOT EXISTS brain_notes (
  id          uuid PRIMARY KEY,
  site_id     uuid REFERENCES sites(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'lesson' CHECK (kind IN ('rule', 'fact', 'lesson')),
  title       text NOT NULL,
  body        text NOT NULL,
  topics      text[] NOT NULL DEFAULT '{}',
  always      boolean NOT NULL DEFAULT false,
  is_enabled  boolean NOT NULL DEFAULT true,
  source      text NOT NULL DEFAULT 'owner',
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brain_notes_site_idx ON brain_notes (site_id, is_enabled);
