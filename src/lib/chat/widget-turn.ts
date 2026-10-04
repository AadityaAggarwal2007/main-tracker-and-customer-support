import { query, queryOne } from '@/lib/db';

export interface StoredMessage {
  id: string; conversation_id: string; sender: string; content: string;
  metadata: Record<string, unknown> | null; created_at: string;
}

// The last few things we told this customer, for the "same answer again" check.
export async function recentAiReplies(conversationId: string): Promise<string[]> {
  const r = await query<{ content: string }>(
    `SELECT content FROM messages
      WHERE conversation_id = $1 AND sender = 'ai' AND deleted_at IS NULL
        AND COALESCE(metadata->>'hidden', 'false') <> 'true'
        AND COALESCE(metadata->>'withheld', '') = ''
        AND btrim(content) <> ''
      ORDER BY created_at DESC, id DESC
      LIMIT 3`,
    [conversationId]
  );
  return r.rows.map((x) => x.content);
}

export async function handOverToPerson(conversationId: string, why: string): Promise<void> {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await query(
            `UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1 AND status = 'ai_handling'`,
            [conversationId]
          );
          console.log(`[widget] conv ${conversationId} handed to a person: ${why}`);
          return;
        } catch (err) {
          console.error(`[widget] hand-over (${why}) failed, attempt ${attempt}:`, (err as Error).message);
        }
      }
}

// `metadata`: only the closed-hours note marker today ({ closed_note: 'full' | 'short' },
// closed-hours.ts), which the widget returns to the customer like any metadata: nothing private.
export function saveAiMessageTo(conversationId: string, text: string, metadata?: Record<string, string> | null) {
  if (metadata) {
    return queryOne<StoredMessage>(
      `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
       VALUES (gen_random_uuid()::text, $1, 'ai', $2, $3::jsonb, now())
       RETURNING id, conversation_id, sender, content, metadata, created_at`,
      [conversationId, text, JSON.stringify(metadata)]
    );
  }
  return queryOne<StoredMessage>(
      `INSERT INTO messages (id, conversation_id, sender, content, created_at)
       VALUES (gen_random_uuid()::text, $1, 'ai', $2, now())
       RETURNING id, conversation_id, sender, content, metadata, created_at`,
      [conversationId, text]
  );
}
