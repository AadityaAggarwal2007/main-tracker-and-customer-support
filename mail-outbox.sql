-- ============================================================
-- Mail outbox (owner 2026-10-11: "Send and open next" sat spinning for minutes and the reply never went; from this
-- server Gmail's SMTP sometimes hangs and nodemailer had no timeout, so the screen waited inside the HTTP request).
-- Now a reply from the Mail tab is only QUEUED here by /api/mail/send (the screen gets its answer at once and moves
-- to the next mail) and a background worker (src/lib/chat/mail-outbox.ts) sends it over a kept-open SMTP connection
-- with timeouts, from whichever of the two PM2 processes claims the row first; a send that fails is tried again
-- (5 times, then 'failed' with the reason, and "Try again" in the conversation puts it back to pending).
--   mail_outbox   one row per reply: the mailbox, the mail it answers (uid + uidvalidity), the finished text and
--                 HTML (the quote is already in), our Message-ID (the conversation shows the reply by it), the
--                 files as base64 (at most 5 / 10 MB, the route checks them), status pending / sending / sent /
--                 failed, how many tries, the last error, who sent it.
-- Staff only: never read by the widget, the AI reply path or a customer's screen. The App Password is NOT stored
-- here. Additive, safe to run twice, never deletes (tracker_user gets no DELETE). Until it is run a reply is sent
-- the old way, inside the request.
--   psql -v ON_ERROR_STOP=1 -f mail-outbox.sql
-- ============================================================
CREATE TABLE IF NOT EXISTS mail_outbox (
  id            bigserial PRIMARY KEY,
  box_id        text        NOT NULL,
  reply_uid     bigint,
  uidvalidity   bigint,
  to_addr       text        NOT NULL,
  subject       text        NOT NULL DEFAULT '',
  text_body     text        NOT NULL DEFAULT '',
  html_body     text        NOT NULL DEFAULT '',
  message_id    text        NOT NULL,
  in_reply_to   text,
  refs          text,
  files         jsonb       NOT NULL DEFAULT '[]',
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  tries         integer     NOT NULL DEFAULT 0,
  error         text,
  claimed_at    timestamptz,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_outbox_status_idx ON mail_outbox (status, id);
CREATE INDEX IF NOT EXISTS mail_outbox_msgid_idx  ON mail_outbox (box_id, message_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_user') THEN
    GRANT SELECT, INSERT, UPDATE ON mail_outbox TO tracker_user;
    GRANT USAGE, SELECT ON SEQUENCE mail_outbox_id_seq TO tracker_user;
  END IF;
END $$;

SELECT 'mail outbox ready' AS result, (SELECT count(*) FROM mail_outbox) AS queued_ever, (SELECT count(*) FROM mail_outbox WHERE status IN ('pending', 'sending')) AS waiting;
