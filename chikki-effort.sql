-- ============================================================
-- Chikki's effort levels. 2026-10-01 (owner).
-- Like Claude's effort setting: how hard the AI thinks for a reply. Visitors stay as they are
-- (Normal; a visitor / sales AI is built later). A verified customer gets a level by how upset
-- they are (frustration score): Calm and Uneasy = Normal, Frustrated = High (thinks first),
-- Critical = Max (thinks, then checks its reply against the rules and the order facts).
--
--   sites.chikki_effort   the panel's choice per group, e.g.
--                         {"calm":"normal","uneasy":"normal","frustrated":"high","critical":"max"};
--                         NULL = those defaults (src/lib/chat/effort.ts DEFAULT_EFFORT)
--   chikki_runs           one row per AI reply: level, group, score, model, calls, tokens, time,
--                         whether the self-check ran and changed it. Staff only (Logic tab).
-- Additive only.
-- ============================================================
ALTER TABLE sites ADD COLUMN IF NOT EXISTS chikki_effort jsonb;

CREATE TABLE IF NOT EXISTS chikki_runs (
  message_id        text PRIMARY KEY,
  conversation_id   text NOT NULL,
  site_id           text,
  level             text NOT NULL,
  grp               text NOT NULL,
  score             int,
  model             text,
  calls             int NOT NULL DEFAULT 0,
  prompt_tokens     int NOT NULL DEFAULT 0,
  completion_tokens int NOT NULL DEFAULT 0,
  reasoning_tokens  int NOT NULL DEFAULT 0,
  thinking          boolean NOT NULL DEFAULT false,
  checked           boolean NOT NULL DEFAULT false,
  changed           boolean NOT NULL DEFAULT false,
  ms                int,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chikki_runs_site_idx ON chikki_runs (site_id, created_at DESC);

-- The app connects as tracker_user.
GRANT SELECT, INSERT ON chikki_runs TO tracker_user;
