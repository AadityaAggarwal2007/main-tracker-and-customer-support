-- ============================================================
-- Per-panel saved answers (Q&A) for the chat agent.
-- The merchant writes the exact answer; the agent reuses it verbatim
-- instead of improvising. This is the ONLY sanctioned way to give the
-- agent product/policy knowledge it cannot get from a tool.
-- Additive + idempotent.
-- ============================================================
CREATE TABLE IF NOT EXISTS site_faqs (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  sort_order  INT  NOT NULL DEFAULT 0,
  is_enabled  BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_faqs_site ON site_faqs (site_id, sort_order);

-- The app connects as tracker_user, not postgres. A NEW table gets no grants
-- automatically, so without this the API returns "permission denied for table
-- site_faqs" and every save silently fails. (ALTER TABLE ADD COLUMN on an
-- existing table inherits its grants, which is why earlier migrations did not
-- need this.)
GRANT SELECT, INSERT, UPDATE, DELETE ON site_faqs TO tracker_user;
