-- Read-only audit of what the live AI actually said, counted by known problem. Run on the server:
--   ssh shiptrack-vps "sudo -u postgres psql -d tracking_crm -f -" < scripts/ai-tests/audit.sql
-- Change the two timestamps to compare "before" and "after" a deploy. Counts AI replies in widget
-- chats only; nothing is written.
\set cut '''2026-09-30 19:30+00'''
\set since '''2026-09-28 00:00+00'''
WITH ai AS (
  SELECT m.id, m.created_at, m.content, c.verified_order_id IS NOT NULL AS verified,
         (m.created_at >= :cut::timestamptz) AS after_fix
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
   WHERE m.sender = 'ai' AND m.deleted_at IS NULL AND m.created_at >= :since::timestamptz
     AND COALESCE(m.metadata->>'hidden','false') <> 'true' AND btrim(m.content) <> ''
), flags AS (
  SELECT after_fix, verified,
    (content ~* '(aaj|today|tonight|tomorrow)[^.!?]{0,40}(deliver|aayega|milega|arriv|reach|pahunch|hone wali)|(deliver|aayega|milega|arriv|reach)[^.!?]{0,40}\m(today|tonight|aaj)\M') AS promises_today,
    (verified AND content ~* '(share|send|provide|dijiye|batayein|bata dijiye)[^.!?]{0,60}(order id|order number|phone number|registered)') AS asks_again_when_verified,
    (content ~* '(upi|utr|transaction id|payment reference|screenshot|account number)[^.!?]{0,40}(share|send|provide|bhej|dijiye)|(share|send|provide|bhej|dijiye)[^.!?]{0,40}(upi|utr|transaction id|payment reference|screenshot|account number)') AS asks_payment_details,
    (content ~* 'try (the )?payment again|pay again|dobara pay|payment (dobara|again) kar') AS says_pay_again,
    (content ~* 'we.?re experiencing high demand|took longer than expected|abhi thoda busy') AS busy_reply,
    (content ~ '\*\*|^#{1,3} ') AS markdown
  FROM ai
)
SELECT CASE WHEN after_fix THEN 'AFTER fix' ELSE 'BEFORE fix' END AS period,
       count(*) AS ai_replies,
       count(*) FILTER (WHERE promises_today) AS promises_today,
       count(*) FILTER (WHERE asks_again_when_verified) AS asks_again_when_verified,
       count(*) FILTER (WHERE asks_payment_details) AS asks_payment_details,
       count(*) FILTER (WHERE says_pay_again) AS says_pay_again,
       count(*) FILTER (WHERE busy_reply) AS busy_reply,
       count(*) FILTER (WHERE markdown) AS markdown
  FROM flags GROUP BY after_fix ORDER BY after_fix;
