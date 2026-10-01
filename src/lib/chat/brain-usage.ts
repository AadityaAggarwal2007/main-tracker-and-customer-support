import { query } from '@/lib/db';

// Which Brain notes the agent was shown for one reply (brain_usage, chat-brain-usage.sql). Staff
// read it in the inbox ("why did it answer like that"). Kept out of messages.metadata because the
// widget returns that to the customer. Never throws: a failure must not touch the reply.
export async function recordBrainUsage(messageId: string | null | undefined, notes: { id: string; title: string }[]): Promise<void> {
  if (!messageId || !notes.length) return;
  try {
    await query(
      `INSERT INTO brain_usage (message_id, notes) VALUES ($1, $2::jsonb) ON CONFLICT (message_id) DO NOTHING`,
      [messageId, JSON.stringify(notes)]
    );
  } catch (err) {
    console.error('[brain] usage not recorded:', (err as Error)?.message);
  }
}
