-- ============================================================
-- Refund form: ROLLED-BACK trial of refund-forms.sql (spec 11.4). Never applied for real.
-- Run only like this (with the owner's OK), from a pushed branch or main, BEFORE refund-forms.sql is applied:
--   ssh shiptrack-vps 'cd /var/www/tracker && git fetch -q origin && git show origin/main:refund-forms.sql > /tmp/rf.sql && git show origin/main:scripts/refund-sql-trial.sql > /tmp/rft.sql && (echo "BEGIN;"; cat /tmp/rf.sql /tmp/rft.sql; echo "ROLLBACK;") | sudo -u postgres psql -d tracking_crm -v ON_ERROR_STOP=1 -q; rm -f /tmp/rf.sql /tmp/rft.sql'
-- Everything (the tables, the fake rows) disappears at the ROLLBACK. Fake rows only: orders #TRIAL-1 /
-- #TRIAL-2 of the made-up panel 'trial-business'. No customer data is read or printed.
-- It runs as tracker_user (SET LOCAL ROLE), so the GRANTs are tested too. Each check prints
-- "Tn PASS ..."; a check that does not get exactly its expected SQLSTATE stops psql (ON_ERROR_STOP).
-- ============================================================

-- Refuse to run outside the BEGIN ... ROLLBACK above (the fake rows would stay).
DO $$
BEGIN
  IF txid_current_if_assigned() IS NULL THEN
    RAISE EXCEPTION 'refund-sql-trial: run it only inside BEGIN; refund-forms.sql; this file; ROLLBACK;';
  END IF;
END $$;

SET LOCAL ROLE tracker_user;
SET LOCAL lock_timeout = '5s';

-- ── T1: one active link per order ───────────────────────────
INSERT INTO refund_links (id, token_hash, conversation_id, site_id, business_id, order_id, order_snapshot, channel, lang, expires_at)
VALUES ('00000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'trial-conv-1', 'trial-site', 'trial-business', '#TRIAL-1',
        '{"trial": true}', 'chat', 'en', now() + interval '7 days');
DO $$
BEGIN
  INSERT INTO refund_links (id, token_hash, conversation_id, site_id, business_id, order_id, order_snapshot, channel, lang, expires_at)
  VALUES ('00000000-0000-4000-8000-0000000000a9', repeat('9', 64), 'trial-conv-1', 'trial-site', 'trial-business', '#TRIAL-1',
          '{"trial": true}', 'chat', 'en', now() + interval '7 days');
  RAISE EXCEPTION 'T1 FAIL: a second active link for one order was accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'T1 PASS: a second active link for the same order is refused';
END $$;

-- ── T2: a link lives at most 7 days ─────────────────────────
DO $$
BEGIN
  INSERT INTO refund_links (id, token_hash, conversation_id, site_id, business_id, order_id, order_snapshot, channel, lang, expires_at)
  VALUES ('00000000-0000-4000-8000-0000000000a8', repeat('8', 64), 'trial-conv-1', 'trial-site', 'trial-business', '#TRIAL-9',
          '{"trial": true}', 'chat', 'en', now() + interval '8 days');
  RAISE EXCEPTION 'T2 FAIL: an 8-day link was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'T2 PASS: an 8-day link is refused';
END $$;

-- ── T3: request R1 on L1; bad details / sub-reason / ref refused ──
INSERT INTO refund_requests (id, ref_code, link_id, client_nonce, conversation_id, site_id, business_id, order_id, order_snapshot,
                             reason, sub_reason, details, payout_method, payout_mask, payout_enc, payout_key_id, payout_fp,
                             consent_version, consent_at)
VALUES ('00000000-0000-4000-8000-0000000000b1', 'RF-000001', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000d1',
        'trial-conv-1', 'trial-site', 'trial-business', '#TRIAL-1', '{"trial": true}',
        'wrong_missing', 'wrong_size', 'Trial details text', 'upi', 'tr•••al@ybl', 'v1.0123abcd.aa.bb.cc', '0123abcd', repeat('a', 32),
        'v1-2026-10-02', now());
UPDATE refund_links SET status = 'submitted', submitted_at = now() WHERE id = '00000000-0000-4000-8000-0000000000a1';
DO $$
BEGIN
  BEGIN
    INSERT INTO refund_requests (id, ref_code, link_id, client_nonce, conversation_id, site_id, business_id, order_id, order_snapshot,
                                 reason, sub_reason, details, payout_method, payout_mask, payout_enc, payout_key_id, payout_fp,
                                 consent_version, consent_at)
    VALUES ('00000000-0000-4000-8000-0000000000b2', 'RF-000003', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000d2',
            'trial-conv-1', 'trial-site', 'trial-business', '#TRIAL-8', '{"trial": true}',
            'damaged', NULL, repeat('x', 1001), 'upi', 'tr•••al@ybl', 'v1.0123abcd.aa.bb.cc', '0123abcd', repeat('a', 32), 'v1-2026-10-02', now());
    RAISE EXCEPTION 'T3 FAIL: 1001-character details were accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO refund_requests (id, ref_code, link_id, client_nonce, conversation_id, site_id, business_id, order_id, order_snapshot,
                                 reason, sub_reason, details, payout_method, payout_mask, payout_enc, payout_key_id, payout_fp,
                                 consent_version, consent_at)
    VALUES ('00000000-0000-4000-8000-0000000000b3', 'RF-000004', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000d3',
            'trial-conv-1', 'trial-site', 'trial-business', '#TRIAL-8', '{"trial": true}',
            'damaged', 'wrong_size', 'Trial details text', 'upi', 'tr•••al@ybl', 'v1.0123abcd.aa.bb.cc', '0123abcd', repeat('a', 32), 'v1-2026-10-02', now());
    RAISE EXCEPTION 'T3 FAIL: sub-reason wrong_size with reason damaged was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO refund_requests (id, ref_code, link_id, client_nonce, conversation_id, site_id, business_id, order_id, order_snapshot,
                                 reason, sub_reason, details, payout_method, payout_mask, payout_enc, payout_key_id, payout_fp,
                                 consent_version, consent_at)
    VALUES ('00000000-0000-4000-8000-0000000000b5', 'RF-00000I', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000d5',
            'trial-conv-1', 'trial-site', 'trial-business', '#TRIAL-8', '{"trial": true}',
            'damaged', NULL, 'Trial details text', 'upi', 'tr•••al@ybl', 'v1.0123abcd.aa.bb.cc', '0123abcd', repeat('a', 32), 'v1-2026-10-02', now());
    RAISE EXCEPTION 'T3 FAIL: a ref with the letter I was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'T3 PASS: R1 stored; 1001-character details, a sub-reason of another reason and a ref with I are refused';
END $$;

-- ── T4: new -> refunded is not a move (trigger) ─────────────
DO $$
BEGIN
  UPDATE refund_requests SET status = 'refunded', utr = 'TRIAL0000001', refund_amount = 1, refund_date = current_date
   WHERE id = '00000000-0000-4000-8000-0000000000b1';
  RAISE EXCEPTION 'T4 FAIL: new -> refunded was accepted';
EXCEPTION WHEN check_violation THEN
  IF SQLERRM NOT LIKE '%is not allowed%' THEN RAISE EXCEPTION 'T4 FAIL: refused for another reason (%)', SQLERRM; END IF;
  RAISE NOTICE 'T4 PASS: new -> refunded is refused by the trigger';
END $$;

-- ── T5: new -> approved -> refunded (proof needed), then final ──
DO $$
DECLARE n integer;
BEGIN
  UPDATE refund_requests SET status = 'approved', status_at = now(), status_by = 'owner'
   WHERE id = '00000000-0000-4000-8000-0000000000b1' AND status = 'new';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'T5 FAIL: new -> approved updated % rows', n; END IF;
  BEGIN
    UPDATE refund_requests SET status = 'refunded' WHERE id = '00000000-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'T5 FAIL: refunded without a UTR was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE refund_requests SET status = 'refunded', status_at = now(), status_by = 'owner', utr = 'TRIAL1234567', refund_amount = 1,
         refund_date = current_date, gateway_checked = true
   WHERE id = '00000000-0000-4000-8000-0000000000b1' AND status = 'approved';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'T5 FAIL: approved -> refunded updated % rows', n; END IF;
  BEGIN
    UPDATE refund_requests SET status = 'rejected', utr = NULL, refund_amount = NULL, refund_date = NULL
     WHERE id = '00000000-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'T5 FAIL: refunded -> rejected was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE refund_requests SET utr = 'TRIAL7654321' WHERE id = '00000000-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'T5 FAIL: a sent refund''s UTR was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'T5 PASS: new -> approved -> refunded (UTR, amount, date needed); refunded is final and keeps its UTR';
END $$;

-- ── T6: payout details are written once, except during a re-key ──
DO $$
DECLARE n integer;
BEGIN
  BEGIN
    UPDATE refund_requests SET payout_enc = 'v1.0123abcd.dd.ee.ff' WHERE id = '00000000-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'T6 FAIL: payout_enc changed without the re-key switch';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM set_config('shiptrack.refund_rekey', 'on', true);
  UPDATE refund_requests SET payout_enc = 'v1.0123abcd.dd.ee.ff' WHERE id = '00000000-0000-4000-8000-0000000000b1';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('shiptrack.refund_rekey', 'off', true);
  IF n <> 1 THEN RAISE EXCEPTION 'T6 FAIL: the re-key update changed % rows', n; END IF;
  RAISE NOTICE 'T6 PASS: payout_enc is fixed, and changes only with shiptrack.refund_rekey = on';
END $$;

-- ── T7: no DELETE on requests; events are append-only ───────
INSERT INTO refund_events (request_id, kind, actor, meta) VALUES ('00000000-0000-4000-8000-0000000000b1', 'note', 'system', '{"trial": true}');
DO $$
BEGIN
  DELETE FROM refund_requests WHERE id = '00000000-0000-4000-8000-0000000000b1';
  RAISE EXCEPTION 'T7 FAIL: tracker_user deleted a refund request';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'T7 PASS: tracker_user cannot DELETE refund_requests';
END $$;
DO $$
BEGIN
  UPDATE refund_events SET note = 'changed' WHERE request_id = '00000000-0000-4000-8000-0000000000b1';
  RAISE EXCEPTION 'T7 FAIL: tracker_user updated refund_events';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'T7 PASS: tracker_user cannot UPDATE refund_events';
END $$;
DO $$
BEGIN
  DELETE FROM refund_events WHERE request_id = '00000000-0000-4000-8000-0000000000b1';
  RAISE EXCEPTION 'T7 FAIL: tracker_user deleted refund_events';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'T7 PASS: tracker_user cannot DELETE refund_events';
END $$;

-- ── T8: no photo / video upload (owner change 2026-10-02 ~15:00): the file tables are read-only ──
-- tracker_user may only SELECT refund_files / refund_file_parts (scripts/refund-rekey.js reads them);
-- no INSERT, UPDATE or DELETE, so no file can ever be stored, even by a code path that came back.
INSERT INTO refund_links (id, token_hash, conversation_id, site_id, business_id, order_id, order_snapshot, channel, lang, expires_at)
VALUES ('00000000-0000-4000-8000-0000000000a2', repeat('b', 64), 'trial-conv-1', 'trial-site', 'trial-business', '#TRIAL-1',
        '{"trial": true}', 'chat', 'hinglish', now() + interval '7 days');
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM refund_files;
  IF n <> 0 THEN RAISE EXCEPTION 'T8 FAIL: refund_files has % rows', n; END IF;
  SELECT count(*) INTO n FROM refund_file_parts;
  IF n <> 0 THEN RAISE EXCEPTION 'T8 FAIL: refund_file_parts has % rows', n; END IF;
  BEGIN
    INSERT INTO refund_files (id, link_id, kind, mime_type, size_bytes, parts, n, key_id)
    VALUES ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a2', 'image', 'image/jpeg', 100, 1, 1, '0123abcd');
    RAISE EXCEPTION 'T8 FAIL: tracker_user stored a refund file';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO refund_file_parts (file_id, part, data) VALUES ('00000000-0000-4000-8000-0000000000c1', 0, decode(repeat('00', 29), 'hex'));
    RAISE EXCEPTION 'T8 FAIL: tracker_user stored a refund file part';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE refund_files SET key_id = '0123abcd' WHERE id = '00000000-0000-4000-8000-0000000000c1';
    RAISE EXCEPTION 'T8 FAIL: tracker_user updated refund_files';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM refund_files WHERE id = '00000000-0000-4000-8000-0000000000c1';
    RAISE EXCEPTION 'T8 FAIL: tracker_user deleted from refund_files';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'T8 PASS: the file tables are empty and tracker_user can only read them (no upload)';
END $$;

-- ── T9: one live or paid request per order ──────────────────
DO $$
BEGIN
  INSERT INTO refund_requests (id, ref_code, link_id, client_nonce, conversation_id, site_id, business_id, order_id, order_snapshot,
                               reason, sub_reason, details, payout_method, payout_mask, payout_enc, payout_key_id, payout_fp,
                               consent_version, consent_at)
  VALUES ('00000000-0000-4000-8000-0000000000b4', 'RF-000002', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000d4',
          'trial-conv-1', 'trial-site', 'trial-business', '#TRIAL-1', '{"trial": true}',
          'damaged', NULL, 'Trial details text', 'bank', 'TRIA ••••0000', 'v1.0123abcd.aa.bb.cc', '0123abcd', repeat('b', 32), 'v1-2026-10-02', now());
  RAISE EXCEPTION 'T9 FAIL: a second request for a refunded order was accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'T9 PASS: a second request for an order with a refunded request is refused';
END $$;

-- ── T10: the events sequence works for tracker_user ─────────
DO $$
BEGIN
  PERFORM nextval('refund_events_id_seq');
  RAISE NOTICE 'T10 PASS: tracker_user can use refund_events_id_seq';
END $$;

-- ── T11: a submitted link never becomes active again ────────
DO $$
BEGIN
  UPDATE refund_links SET status = 'active', submitted_at = NULL WHERE id = '00000000-0000-4000-8000-0000000000a1';
  RAISE EXCEPTION 'T11 FAIL: submitted -> active was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'T11 PASS: a link status submitted -> active is refused';
END $$;

-- ── Extra checks (same rules, other paths) ──────────────────
-- T12: no DELETE on links.
DO $$
BEGIN
  DELETE FROM refund_links WHERE id = '00000000-0000-4000-8000-0000000000a2';
  RAISE EXCEPTION 'T12 FAIL: tracker_user deleted a refund link';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'T12 PASS: tracker_user cannot DELETE refund_links';
END $$;
-- T13: the "form received" message id is written once; what the customer sent is fixed.
DO $$
BEGIN
  UPDATE refund_requests SET ack_message_id = 'trial-message-1' WHERE id = '00000000-0000-4000-8000-0000000000b1';
  BEGIN
    UPDATE refund_requests SET ack_message_id = 'trial-message-2' WHERE id = '00000000-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'T13 FAIL: ack_message_id was written twice';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE refund_requests SET details = 'Changed details text' WHERE id = '00000000-0000-4000-8000-0000000000b1';
    RAISE EXCEPTION 'T13 FAIL: the customer''s details were changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'T13 PASS: ack_message_id is written once and the details are fixed';
END $$;
-- T14: new -> rejected -> approved -> cancelled, then cancelled is final (MOVES in rules.ts).
-- Its request has an EMPTY details text: the details are optional (owner change 2026-10-02).
INSERT INTO refund_links (id, token_hash, conversation_id, site_id, business_id, order_id, order_snapshot, channel, lang, expires_at)
VALUES ('00000000-0000-4000-8000-0000000000a3', repeat('c', 64), 'trial-conv-2', 'trial-site', 'trial-business', '#TRIAL-2',
        '{"trial": true}', 'email', 'en', now() + interval '7 days');
INSERT INTO refund_requests (id, ref_code, link_id, client_nonce, conversation_id, site_id, business_id, order_id, order_snapshot,
                             reason, sub_reason, checked_around, details, payout_method, payout_mask, payout_enc, payout_key_id, payout_fp,
                             consent_version, consent_at)
VALUES ('00000000-0000-4000-8000-0000000000b6', 'RF-000005', '00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000d6',
        'trial-conv-2', 'trial-site', 'trial-business', '#TRIAL-2', '{"trial": true}',
        'not_received', 'shows_delivered', true, '', 'upi', 'tr•••al@ybl', 'v1.0123abcd.aa.bb.cc', '0123abcd', repeat('c', 32),
        'v1-2026-10-02', now());
DO $$
BEGIN
  UPDATE refund_requests SET status = 'rejected' WHERE id = '00000000-0000-4000-8000-0000000000b6';
  UPDATE refund_requests SET status = 'approved' WHERE id = '00000000-0000-4000-8000-0000000000b6';
  UPDATE refund_requests SET status = 'cancelled' WHERE id = '00000000-0000-4000-8000-0000000000b6';
  BEGIN
    UPDATE refund_requests SET status = 'approved' WHERE id = '00000000-0000-4000-8000-0000000000b6';
    RAISE EXCEPTION 'T14 FAIL: cancelled -> approved was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE refund_requests SET checked_around = true, sub_reason = 'never_came' WHERE id = '00000000-0000-4000-8000-0000000000b6';
    RAISE EXCEPTION 'T14 FAIL: the sub-reason was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'T14 PASS: new -> rejected -> approved -> cancelled works; cancelled is final';
END $$;

DO $$ BEGIN RAISE NOTICE 'refund-sql-trial: ALL PASS (the ROLLBACK removes everything)'; END $$;
