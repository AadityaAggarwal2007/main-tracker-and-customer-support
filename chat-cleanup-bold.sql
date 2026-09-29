-- ============================================================
-- One-off, 2026-09-29: take markdown ** out of messages already sent.
-- Approved by the owner in chat on 2026-09-29. Replies sent from commit
-- 1d76ada on are cleaned in code (src/lib/chat/plain-text.ts); this does
-- the same to the ones sent before. Only the ** marks go, the words stay.
-- (No sent message had __bold__ or ### headings, so only ** is handled.)
-- Each message's text is first copied into message_revisions, so it can be
-- put back. Not marked Edited: nothing changes for the customer except the
-- stray symbols. Running it again finds nothing left to change.
-- ============================================================
BEGIN;

INSERT INTO message_revisions
  (message_id, conversation_id, action, previous_content, new_content, actor, actor_role)
SELECT id, conversation_id, 'edit', content, replace(content, '**', ''),
       'cleanup: markdown bold', 'system'
  FROM messages
 WHERE sender IN ('agent', 'ai') AND deleted_at IS NULL AND content LIKE '%**%';

UPDATE messages
   SET content = replace(content, '**', '')
 WHERE sender IN ('agent', 'ai') AND deleted_at IS NULL AND content LIKE '%**%';

COMMIT;
