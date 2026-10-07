import { query, queryOne } from '@/lib/db';
import { lookupVerifiedOrder } from '@/lib/chat/orders';
import { handoffReply, looksHinglish } from '@/lib/chat/escalation';

// Owner 2026-10-07: the API limit ran out, every model failed, and a verified customer who asked
// "when will my order be delivered" got only "I've passed your message to our team". The fixed
// hand-over text now carries the customer's own tracking link (the one the chat's lookup shows),
// nothing else: no status, no date, no reason (master rules 13 and 19: never invent). Only the
// order this chat PROVED (`verified_order_id`, never a phone match); any trouble reading it and
// the plain hand-over text goes out as before. Never throws.
export function withTrackingLink(text: string, said: string, link: string | null | undefined): string {
  if (!link || !/^https?:\/\/\S+$/.test(link)) return text;
  const line = looksHinglish(said)
    ? `Aap apne order ka status yahan dekh sakte hain: ${link}`
    : `You can check your order's current status here: ${link}`;
  return `${text}\n\n${line}`;
}

export async function handoffReplyWithLink(conversationId: string, said: string, trackerBusinessId: string | null | undefined): Promise<string> {
  const text = handoffReply(said);
  try {
    const row = await queryOne<{ verified_order_id: string | null }>(
      `SELECT verified_order_id FROM conversations WHERE id = $1`,
      [conversationId]
    );
    if (!row?.verified_order_id) return text;
    const found = await lookupVerifiedOrder(row.verified_order_id, trackerBusinessId || null);
    const link = found.found ? found.orders[0]?.tracking_link : null;
    return withTrackingLink(text, said, link);
  } catch (err) {
    console.error('[widget] tracking link for the hand-over failed:', (err as Error).message);
    return text;
  }
}

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
