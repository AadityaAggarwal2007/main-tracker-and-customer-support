-- ============================================================
-- Refund form (owner, 2026-10-02). ShipTrack's own refund form replaces the Google Form.
-- Only the Super Admin sends it, only from a chat in the Refund section (conversations.case_kind =
-- 'refund'). The system posts the link in that chat as "Vastora Support" (messages.sender =
-- 'system'; an email chat also gets it as an email reply on the thread). The customer fills it
-- once on /refund within 7 days. Only the Super Admin sees what comes in (admin > Refund requests).
--   refund_links       one row per link sent; ONLY sha256(token) is stored here
--   refund_requests    one row per submitted form; UPI / bank ONLY encrypted by the app
--                      (AES-256-GCM, REFUND_DATA_KEY, AAD = request id) + a mask + HMAC
--                      fingerprints; status new -> approved / rejected -> refunded (+ cancelled)
--   refund_files       NOT USED: the owner dropped photo / video upload (2026-10-02 ~15:00, "upload
--   refund_file_parts  yeh sab mat bana, humein sirf bank details mil jaye bahut hai"). Both stay
--                      EMPTY and read-only for the app (GRANT SELECT only, below): no code writes them
--                      and no route takes a file. They are kept only because scripts/refund-rekey.js
--                      still reads them; drop them together with that loop, never on their own.
--   refund_events      append-only history (sent, opened, submitted, viewed, revealed, status...)
-- Staff, the AI, the learner, search and the team score never read these tables: only
-- src/lib/refund/server.ts, through the Super Admin routes and the public form (by its token).
-- Additive + idempotent: safe to run twice. Apply BEFORE deploying the code that reads it:
--   sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -1 -f refund-forms.sql
-- Needs PostgreSQL 14+ (CREATE OR REPLACE TRIGGER). Error texts carry ids and status names only.
-- Owner answers 2026-10-02: UPI / bank for every order, COD and prepaid (Q1); nothing wiped (Q11).
-- Owner change ~15:00: no photo / video upload. The status moves below must match MOVES in src/lib/refund/rules.ts
-- (scripts/ai-tests/refund-unit.js pins both). Rolled-back trial: scripts/refund-sql-trial.sql.
-- ============================================================
SET lock_timeout = '5s';

-- ── Links ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refund_links (
  id              uuid PRIMARY KEY,
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  conversation_id text NOT NULL,                 -- the chat the link was sent in
  site_id         text NOT NULL,
  business_id     text NOT NULL,                 -- the chat's panel (sites.tracker_business_id)
  order_id        text NOT NULL,                 -- conversations.verified_order_id at send time
  order_uuid      uuid,                          -- orders.id at send time
  order_snapshot  jsonb NOT NULL,                -- what the form shows (spec 2.6)
  channel         text NOT NULL CHECK (channel IN ('chat', 'email')),
  lang            text NOT NULL CHECK (lang IN ('en', 'hinglish')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'submitted', 'revoked')),
  revoked_reason  text CHECK (revoked_reason IS NULL OR revoked_reason IN ('reissued', 'cancelled')),
  replaced_by     uuid,
  message_id      text,                          -- the 'system' message that carried the link
  created_by      text NOT NULL DEFAULT 'owner' CHECK (created_by = 'owner'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  opened_count    integer NOT NULL DEFAULT 0 CHECK (opened_count >= 0),
  first_opened_at timestamptz,
  last_opened_at  timestamptz,
  submitted_at    timestamptz,
  revoked_at      timestamptz,
  CONSTRAINT refund_link_life CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days 1 minute'),
  CONSTRAINT refund_link_revoked CHECK ((status = 'revoked') = (revoked_reason IS NOT NULL AND revoked_at IS NOT NULL)),
  CONSTRAINT refund_link_submitted CHECK ((status = 'submitted') = (submitted_at IS NOT NULL))
);
-- One live link per order (an expired one still counts until the next send revokes it).
CREATE UNIQUE INDEX IF NOT EXISTS refund_links_one_active ON refund_links (business_id, order_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS refund_links_order_idx ON refund_links (business_id, order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS refund_links_conv_idx  ON refund_links (conversation_id, created_at DESC);

-- ── Requests (one per submitted form) ───────────────────────
CREATE TABLE IF NOT EXISTS refund_requests (
  id              uuid PRIMARY KEY,
  ref_code        text NOT NULL UNIQUE CHECK (ref_code ~ '^RF-[0-9A-HJKMNP-TV-Z]{6}$'),
  link_id         uuid NOT NULL UNIQUE REFERENCES refund_links(id),
  client_nonce    uuid NOT NULL,                 -- the page's submit id: a retried submit gets the same answer
  conversation_id text NOT NULL,
  site_id         text NOT NULL,
  business_id     text NOT NULL,
  order_id        text NOT NULL,
  order_uuid      uuid,
  order_snapshot  jsonb NOT NULL,                -- the link's snapshot + tracking at submit
  phone_fp        text,                          -- HMAC of the order phone's last 10 digits; never the phone
  reason          text NOT NULL CHECK (reason IN ('damaged', 'wrong_missing', 'not_received', 'quality')),
  sub_reason      text,
  checked_around  boolean NOT NULL DEFAULT false,
  details         text NOT NULL CHECK (char_length(details) BETWEEN 0 AND 1000),    -- maskSensitive()'d; '' = none (optional, owner 2026-10-02)
  payout_method   text NOT NULL CHECK (payout_method IN ('upi', 'bank')),
  payout_mask     text NOT NULL CHECK (char_length(payout_mask) BETWEEN 4 AND 60),   -- 'ra•••ul@okaxis' / 'HDFC ••••4321'
  payout_enc      text NOT NULL CHECK (payout_enc ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  payout_key_id   text NOT NULL CHECK (payout_key_id ~ '^[0-9a-f]{8}$'),
  payout_fp       text NOT NULL CHECK (payout_fp ~ '^[A-Za-z0-9_-]{32}$'),
  holder_matches  boolean,                       -- holder name vs order name; NULL = could not tell
  consent_version text NOT NULL,
  consent_at      timestamptz NOT NULL,
  submit_ip_hash  text CHECK (submit_ip_hash IS NULL OR char_length(submit_ip_hash) <= 32),
  submit_device   text CHECK (submit_device IS NULL OR char_length(submit_device) <= 40),   -- 'Android · Chrome', never the full UA
  ack_message_id  text,                          -- the "form mil gaya" message, once posted
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'rejected', 'refunded', 'cancelled')),
  status_at       timestamptz NOT NULL DEFAULT now(),
  status_by       text CHECK (status_by IS NULL OR status_by = 'owner'),
  refund_amount   numeric(10,2) CHECK (refund_amount IS NULL OR refund_amount > 0),
  refund_date     date,
  utr             text CHECK (utr IS NULL OR utr ~ '^[A-Z0-9]{8,30}$'),
  gateway_checked boolean NOT NULL DEFAULT false,
  return_needed   boolean NOT NULL DEFAULT false,
  return_note     text CHECK (return_note IS NULL OR char_length(return_note) <= 300),
  return_told_at  timestamptz,
  seen_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_sub_reason_fits CHECK (
       (reason = 'damaged' AND sub_reason IS NULL)
    OR (reason = 'wrong_missing' AND sub_reason IN ('wrong_product', 'wrong_size', 'wrong_colour', 'item_missing'))
    OR (reason = 'not_received' AND sub_reason IN ('shows_delivered', 'never_came'))
    OR (reason = 'quality' AND sub_reason IN ('poor_quality', 'not_as_shown', 'did_not_like'))),
  CONSTRAINT refund_checked_around_fits CHECK (NOT checked_around OR (reason = 'not_received' AND sub_reason = 'shows_delivered')),
  CONSTRAINT refund_sent_has_proof CHECK (status <> 'refunded' OR (utr IS NOT NULL AND refund_amount IS NOT NULL AND refund_date IS NOT NULL))
);
-- One live or paid request per order: a second refund for the same order cannot be filed.
CREATE UNIQUE INDEX IF NOT EXISTS refund_requests_one_open ON refund_requests (business_id, order_id) WHERE status IN ('new', 'approved', 'refunded');
CREATE UNIQUE INDEX IF NOT EXISTS refund_requests_utr      ON refund_requests (utr) WHERE utr IS NOT NULL;
CREATE INDEX IF NOT EXISTS refund_requests_status_idx ON refund_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS refund_requests_unseen_idx ON refund_requests (created_at) WHERE status = 'new' AND seen_at IS NULL;
CREATE INDEX IF NOT EXISTS refund_requests_order_idx  ON refund_requests (business_id, order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS refund_requests_conv_idx   ON refund_requests (conversation_id);
CREATE INDEX IF NOT EXISTS refund_requests_fp_idx     ON refund_requests (payout_fp);
CREATE INDEX IF NOT EXISTS refund_requests_phone_idx  ON refund_requests (phone_fp, created_at) WHERE phone_fp IS NOT NULL;

-- ── Photos / video: NOT USED (owner change 2026-10-02 ~15:00, no upload; see the header) ──
-- Kept empty and read-only (GRANT SELECT only) so scripts/refund-rekey.js keeps working unchanged.
CREATE TABLE IF NOT EXISTS refund_files (
  id          uuid PRIMARY KEY,
  link_id     uuid NOT NULL REFERENCES refund_links(id),
  request_id  uuid REFERENCES refund_requests(id),          -- NULL = staged (not submitted yet)
  kind        text NOT NULL CHECK (kind IN ('image', 'video')),
  mime_type   text NOT NULL,                                -- from the file's bytes (part 0), never its name
  size_bytes  integer NOT NULL CHECK (size_bytes > 0),
  parts       integer NOT NULL CHECK (parts BETWEEN 1 AND 25),
  parts_done  integer NOT NULL DEFAULT 0 CHECK (parts_done >= 0),
  n           smallint NOT NULL CHECK (n BETWEEN 1 AND 6),   -- shown as photo-<n>.jpg / video-1.mp4
  status      text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready')),
  key_id      text NOT NULL CHECK (key_id ~ '^[0-9a-f]{8}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_file_type CHECK (
       (kind = 'image' AND mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic') AND size_bytes <= 10485760)
    OR (kind = 'video' AND mime_type IN ('video/mp4', 'video/quicktime', 'video/3gpp', 'video/webm') AND size_bytes <= 52428800)),
  CONSTRAINT refund_file_parts_math CHECK (parts = (size_bytes + 2097151) / 2097152),
  CONSTRAINT refund_file_ready CHECK ((status = 'ready') = (parts_done = parts))
);
CREATE UNIQUE INDEX IF NOT EXISTS refund_files_slot ON refund_files (link_id, kind, n);
CREATE INDEX IF NOT EXISTS refund_files_req_idx    ON refund_files (request_id);
CREATE INDEX IF NOT EXISTS refund_files_staged_idx ON refund_files (created_at) WHERE request_id IS NULL;

CREATE TABLE IF NOT EXISTS refund_file_parts (
  file_id  uuid NOT NULL REFERENCES refund_files(id) ON DELETE CASCADE,
  part     integer NOT NULL CHECK (part BETWEEN 0 AND 24),
  data     bytea NOT NULL CHECK (octet_length(data) BETWEEN 29 AND 2097180),   -- iv(12) | tag(16) | ciphertext
  PRIMARY KEY (file_id, part)
);

-- ── History (append-only) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS refund_events (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  link_id         uuid,
  request_id      uuid,
  conversation_id text,
  kind            text NOT NULL CHECK (kind IN ('link_sent', 'link_revoked', 'link_opened', 'file_added', 'file_rejected',
                    'file_deleted', 'submitted', 'viewed', 'revealed', 'file_viewed', 'status', 'note', 'return_flag',
                    'return_told', 'message_posted', 'message_failed', 'email_sent', 'email_failed', 'rekey')),
  actor           text NOT NULL CHECK (actor IN ('owner', 'customer', 'system')),
  from_status     text,
  to_status       text,
  note            text CHECK (note IS NULL OR char_length(note) <= 500),   -- the Super Admin's internal note; never sent
  ip_hash         text CHECK (ip_hash IS NULL OR char_length(ip_hash) <= 32),
  meta            jsonb                                                   -- ids, counts, step, device; NEVER payout / token / details
);
CREATE INDEX IF NOT EXISTS refund_events_req_idx  ON refund_events (request_id, id);
CREATE INDEX IF NOT EXISTS refund_events_link_idx ON refund_events (link_id, id);

-- ── Guards: what the customer sent is fixed, status only moves forward, evidence is kept ──
CREATE OR REPLACE FUNCTION refund_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rekey boolean := COALESCE(current_setting('shiptrack.refund_rekey', true), '') = 'on';
BEGIN
  IF NEW.id <> OLD.id OR NEW.ref_code <> OLD.ref_code OR NEW.link_id <> OLD.link_id OR NEW.client_nonce <> OLD.client_nonce
     OR NEW.conversation_id <> OLD.conversation_id OR NEW.site_id <> OLD.site_id OR NEW.business_id <> OLD.business_id
     OR NEW.order_id <> OLD.order_id OR NEW.order_uuid IS DISTINCT FROM OLD.order_uuid OR NEW.order_snapshot <> OLD.order_snapshot
     OR NEW.reason <> OLD.reason OR NEW.sub_reason IS DISTINCT FROM OLD.sub_reason OR NEW.checked_around <> OLD.checked_around
     OR NEW.details <> OLD.details OR NEW.payout_method <> OLD.payout_method OR NEW.payout_mask <> OLD.payout_mask
     OR NEW.holder_matches IS DISTINCT FROM OLD.holder_matches OR NEW.consent_version <> OLD.consent_version
     OR NEW.consent_at <> OLD.consent_at OR NEW.submit_ip_hash IS DISTINCT FROM OLD.submit_ip_hash
     OR NEW.submit_device IS DISTINCT FROM OLD.submit_device OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'refund request % keeps what the customer sent', OLD.id USING ERRCODE = '23514';
  END IF;
  IF (NEW.payout_enc <> OLD.payout_enc OR NEW.payout_key_id <> OLD.payout_key_id OR NEW.payout_fp <> OLD.payout_fp
      OR NEW.phone_fp IS DISTINCT FROM OLD.phone_fp) AND NOT rekey THEN
    RAISE EXCEPTION 'refund request %: payout details are written once', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.ack_message_id IS NOT NULL AND NEW.ack_message_id IS DISTINCT FROM OLD.ack_message_id THEN
    RAISE EXCEPTION 'refund request %: the received message is already posted', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'new'      AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('refunded', 'rejected', 'cancelled'))
    OR (OLD.status = 'rejected' AND NEW.status = 'approved')) THEN
    RAISE EXCEPTION 'refund request %: % -> % is not allowed', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'refunded' AND (NEW.utr IS NOT NULL OR NEW.refund_amount IS NOT NULL OR NEW.refund_date IS NOT NULL) THEN
    RAISE EXCEPTION 'refund request %: UTR, amount and date belong to a sent refund', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'refunded' AND (NEW.utr IS DISTINCT FROM OLD.utr OR NEW.refund_amount IS DISTINCT FROM OLD.refund_amount
       OR NEW.refund_date IS DISTINCT FROM OLD.refund_date OR NEW.gateway_checked <> OLD.gateway_checked) THEN
    RAISE EXCEPTION 'refund request %: a sent refund keeps its UTR, amount and date', OLD.id USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_refund_request_guard BEFORE UPDATE ON refund_requests
  FOR EACH ROW EXECUTE FUNCTION refund_request_guard();

CREATE OR REPLACE FUNCTION refund_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.token_hash <> OLD.token_hash OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.site_id <> OLD.site_id OR NEW.business_id <> OLD.business_id OR NEW.order_id <> OLD.order_id
     OR NEW.order_snapshot <> OLD.order_snapshot OR NEW.channel <> OLD.channel OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
     OR (OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id) THEN
    RAISE EXCEPTION 'refund link % is fixed once sent', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'active' AND NEW.status IN ('submitted', 'revoked')) THEN
    RAISE EXCEPTION 'refund link %: % -> % is not allowed', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_refund_link_guard BEFORE UPDATE ON refund_links
  FOR EACH ROW EXECUTE FUNCTION refund_link_guard();

CREATE OR REPLACE FUNCTION refund_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rekey boolean := COALESCE(current_setting('shiptrack.refund_rekey', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.request_id IS NOT NULL THEN
      RAISE EXCEPTION 'refund file % belongs to a submitted request', OLD.id USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.link_id <> OLD.link_id OR NEW.kind <> OLD.kind OR NEW.size_bytes <> OLD.size_bytes
     OR NEW.parts <> OLD.parts OR NEW.n <> OLD.n OR NEW.created_at <> OLD.created_at
     OR (OLD.request_id IS NOT NULL AND NEW.request_id IS DISTINCT FROM OLD.request_id)
     OR (OLD.request_id IS NOT NULL AND (NEW.mime_type <> OLD.mime_type OR NEW.status <> OLD.status OR NEW.parts_done <> OLD.parts_done))
     OR (NEW.key_id <> OLD.key_id AND NOT rekey) THEN
    RAISE EXCEPTION 'refund file % is fixed', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_refund_file_guard BEFORE UPDATE OR DELETE ON refund_files
  FOR EACH ROW EXECUTE FUNCTION refund_file_guard();

CREATE OR REPLACE FUNCTION refund_part_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF COALESCE(current_setting('shiptrack.refund_rekey', true), '') <> 'on'
       OR NEW.file_id <> OLD.file_id OR NEW.part <> OLD.part THEN
      RAISE EXCEPTION 'refund file part %/% is written once', OLD.file_id, OLD.part USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM refund_files f WHERE f.id = OLD.file_id AND f.request_id IS NOT NULL) THEN
    RAISE EXCEPTION 'refund file % belongs to a submitted request', OLD.file_id USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE OR REPLACE TRIGGER trg_refund_part_guard BEFORE UPDATE OR DELETE ON refund_file_parts
  FOR EACH ROW EXECUTE FUNCTION refund_part_guard();

-- ── Grants (the app connects as tracker_user) ───────────────
GRANT SELECT, INSERT, UPDATE         ON refund_links      TO tracker_user;   -- no DELETE
GRANT SELECT, INSERT, UPDATE         ON refund_requests   TO tracker_user;   -- no DELETE: payment record + chargeback evidence
GRANT SELECT                         ON refund_files      TO tracker_user;   -- no upload (owner change): read-only, always empty
GRANT SELECT                         ON refund_file_parts TO tracker_user;   -- the same; refund-rekey.js only reads / counts them
GRANT SELECT, INSERT                 ON refund_events     TO tracker_user;   -- append-only
GRANT USAGE, SELECT ON SEQUENCE refund_events_id_seq      TO tracker_user;

-- ── Undo (owner's plain-words OK only; these tables hold refund evidence and bank details) ──
-- Stop new links: deploy the revert, or set REFUND_FORMS=off (spec 12).
-- Close open links:  UPDATE refund_links SET status = 'revoked', revoked_reason = 'cancelled', revoked_at = now()
--                     WHERE status = 'active';
-- Freeze writes:      REVOKE INSERT, UPDATE ON refund_links, refund_requests FROM tracker_user;
-- Remove the guards:  DROP TRIGGER IF EXISTS trg_refund_request_guard ON refund_requests;  (and the 3 others)
-- NEVER drop the tables without his explicit OK.
