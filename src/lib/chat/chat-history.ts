import { query } from '@/lib/db';

// What the customer themselves wrote in a chat, newest first (the message just stored
// is the first one). Only their own words: used to compare what they say now with
// what they said before (address-conflict.ts).
export async function recentVisitorMessages(conversationId: string, limit = 40): Promise<string[]> {
  const r = await query<{ content: string }>(
    `SELECT content FROM messages
      WHERE conversation_id = $1 AND sender = 'visitor' AND deleted_at IS NULL
        AND COALESCE(metadata->>'hidden', 'false') <> 'true' AND btrim(content) <> ''
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [conversationId, limit]
  );
  return r.rows.map((x) => x.content);
}
