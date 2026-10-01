import { query } from '@/lib/db';
import type { EffortUsage } from './effort';

// One row per AI reply (chikki_runs, chikki-effort.sql): the effort level it got, why (group and
// score) and what it cost (calls, tokens, time), for Panel Settings > Chikki > Logic. Staff only,
// kept out of messages.metadata because the widget returns that to the customer. Never throws:
// a failure here must not touch the reply.
export async function recordChikkiRun(
  messageId: string | null | undefined,
  conversationId: string,
  siteId: string | null | undefined,
  u: EffortUsage | undefined,
): Promise<void> {
  if (!messageId || !u) return;
  try {
    await query(
      `INSERT INTO chikki_runs (message_id, conversation_id, site_id, level, grp, score, model, calls,
                                prompt_tokens, completion_tokens, reasoning_tokens, thinking, checked, changed, ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, conversationId, siteId || null, u.level, u.group, Math.round(u.score), u.model, u.calls,
        u.promptTokens, u.completionTokens, u.reasoningTokens, u.thinking, u.checked, u.changed, Math.round(u.ms)]
    );
  } catch (err) {
    console.error('[chikki] run not recorded:', (err as Error)?.message);
  }
}
