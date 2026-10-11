-- ============================================================
-- Mail store (owner 2026-10-11: "dubara build kar scratch se aur history ko load karke rakh, baar baar read karega
-- toh kaise baat banegi"). The Mail tab used to ask Gmail on every click; from this server a Gmail sign-in takes
-- 3-14 s and one SEARCH 7-27 s, so the conversation and even the mail itself kept spinning on every panel.
-- Now ONE background sync per mailbox (src/lib/chat/mail-sync.ts, from the every-minute cron) copies the support
-- Gmail's INBOX and Sent mails of the last 30 days, and every new one after, into these tables: headers first,
-- then each mail's text / HTML / attachment list. The screen reads only from here, so a click never waits for
-- Gmail. Gmail stays the truth: read / answered flags come back from Gmail (CONDSTORE), a mail that left the
-- folder is marked gone, and what the screen changes (mark read / unread, answered) is written to Gmail by the
-- sync from mail_actions.
--   mail_store       one row per mail per folder ('inbox' / 'sent'); uid + uidvalidity are Gmail's; thread_id =
--                    Gmail's X-GM-THRID (the conversation); body_state none / done / failed / pruned;
--                    attachments = [{index, filename, contentType, size, inline}] (the bytes stay in Gmail and are
--                    fetched only when someone downloads one); local = a reply sent from ShipTrack shown at once,
--                    until the sync brings Gmail's own copy (same message_id).
--   mail_sync        per mailbox + folder: uidvalidity, the highest UID copied, Gmail's modseq, when the folder was
--                    last fully checked, the last error.
--   mail_sync_lease  per mailbox: which server process syncs it now (the app runs two PM2 processes).
--   mail_actions     flags the screen changed, waiting to be written to Gmail.
-- Staff only: never read by the widget, the AI reply path or a customer's screen. The App Password is NOT stored
-- here (it stays in site_emails). Additive, safe to run twice, never deletes (tracker_user gets no DELETE).
-- Until it is run the Mail tab keeps working the old way (live Gmail + the memory copy).
--   psql -v ON_ERROR_STOP=1 -f mail-store.sql
-- ============================================================
CREATE TABLE IF NOT EXISTS mail_store (
  id            bigserial PRIMARY KEY,
  box_id        text        NOT NULL,
  folder        text        NOT NULL CHECK (folder IN ('inbox', 'sent')),
  uidvalidity   bigint      NOT NULL,
  uid           bigint      NOT NULL,
  thread_id     text,
  message_id    text,
  in_reply_to   text,
  refs          text,
  from_name     text        NOT NULL DEFAULT '',
  from_addr     text        NOT NULL DEFAULT '',
  to_list       text        NOT NULL DEFAULT '',
  to_addrs      text[]      NOT NULL DEFAULT '{}',
  cc_list       text        NOT NULL DEFAULT '',
  reply_to      text        NOT NULL DEFAULT '',
  subject       text        NOT NULL DEFAULT '',
  sent_at       timestamptz NOT NULL,
  seen          boolean     NOT NULL DEFAULT false,
  answered      boolean     NOT NULL DEFAULT false,
  has_attach    boolean     NOT NULL DEFAULT false,
  auth_pass     boolean     NOT NULL DEFAULT false,
  size          integer,
  body_state    text        NOT NULL DEFAULT 'none' CHECK (body_state IN ('none', 'done', 'failed', 'pruned')),
  body_tries    integer     NOT NULL DEFAULT 0,
  body_text     text,
  body_html     text,
  attachments   jsonb       NOT NULL DEFAULT '[]',
  cut           boolean     NOT NULL DEFAULT false,
  gone          boolean     NOT NULL DEFAULT false,
  local         boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (box_id, folder, uidvalidity, uid)
);
CREATE INDEX IF NOT EXISTS mail_store_list_idx   ON mail_store (box_id, folder, sent_at DESC) WHERE NOT gone;
CREATE INDEX IF NOT EXISTS mail_store_thread_idx ON mail_store (box_id, thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_store_from_idx   ON mail_store (box_id, from_addr);
CREATE INDEX IF NOT EXISTS mail_store_body_idx   ON mail_store (box_id, sent_at DESC) WHERE body_state = 'none' AND NOT gone;
CREATE INDEX IF NOT EXISTS mail_store_msgid_idx  ON mail_store (box_id, message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_sync (
  box_id       text        NOT NULL,
  folder       text        NOT NULL CHECK (folder IN ('inbox', 'sent')),
  path         text,
  uidvalidity  bigint,
  last_uid     bigint      NOT NULL DEFAULT 0,
  modseq       text,
  full_at      timestamptz,
  flags_at     timestamptz,
  ok_at        timestamptz,
  error        text,
  error_at     timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (box_id, folder)
);

CREATE TABLE IF NOT EXISTS mail_sync_lease (
  box_id       text PRIMARY KEY,
  lease_by     text        NOT NULL,
  lease_until  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_actions (
  id           bigserial PRIMARY KEY,
  box_id       text        NOT NULL,
  folder       text        NOT NULL DEFAULT 'inbox',
  uidvalidity  bigint      NOT NULL,
  uid          bigint      NOT NULL,
  action       text        NOT NULL CHECK (action IN ('seen', 'unseen', 'answered')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz,
  tries        integer     NOT NULL DEFAULT 0,
  error        text
);
CREATE INDEX IF NOT EXISTS mail_actions_todo_idx ON mail_actions (box_id, id) WHERE done_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_user') THEN
    GRANT SELECT, INSERT, UPDATE ON mail_store, mail_sync, mail_sync_lease, mail_actions TO tracker_user;
    GRANT USAGE, SELECT ON SEQUENCE mail_store_id_seq, mail_actions_id_seq TO tracker_user;
  END IF;
END $$;

SELECT 'mail store ready' AS result, (SELECT count(*) FROM mail_store) AS mails, (SELECT count(*) FROM mail_sync) AS folders;
