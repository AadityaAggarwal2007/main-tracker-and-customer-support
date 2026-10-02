import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import { query } from '@/lib/db';
import { normaliseDigits } from './lookup-guard';
import { courierAskCount } from './reply-guards';

// Until 2026-09-24 lookup_order also found orders by a full phone, an email or
// a name, which is not proof of ownership (the 2026-09-11 incident came from
// those lookups), and old chats still hold such found results in the history
// window. Proof is an order ID + last 4 with no phone or email (the old code
// dropped the last 4 when one came along and matched on that instead).
// Before the chat-verification deploy that shape is not enough either: the
// bot often looked up an order ID that an old phone lookup had shown it.
// chat-verified-backfill.sql sorted those out and verified the real proofs,
// so an older result counts only when it holds this chat's verified order.
export const VERIFICATION_DEPLOYED_AT = Date.parse('2026-09-29T21:58:55Z');
export function isProvenLookup(argsJson: string | undefined): boolean {
  let a: unknown;
  try { a = JSON.parse(argsJson || '{}'); } catch { return false; }
  if (!a || typeof a !== 'object') return false;
  const arg = (k: string) => {
    const v = (a as Record<string, unknown>)[k];
    return v == null ? '' : String(v).trim();
  };
  // A full phone (new calls) or, in older chats, the 4 digits the old rule used.
  return !!arg('order_id')
    && (normaliseDigits(arg('phone_number')).replace(/\D/g, '').length >= 10
      || normaliseDigits(arg('phone_last4')).replace(/\D/g, '').length >= 4)
    && !arg('phone') && !arg('email');
}

// What the model reads instead of such a result.
export const UNPROVEN_LOOKUP = JSON.stringify({
  found: false,
  needs_verification: true,
  message: 'This earlier lookup is not proof of ownership. Share nothing from it. Ask for the order ID and the phone number on the order, then look up again with both.',
});

// The API rejects the whole request unless every assistant tool_call is
// answered by a matching tool message. Rows get orphaned when the history
// window slices a pair in half, or when a tool result failed to persist — so
// drop half-pairs rather than let one bad row wedge a conversation forever.
export function dropOrphanedToolCalls(msgs: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as ChatCompletionMessageParam & { tool_calls?: ChatCompletionMessageToolCall[] };

    if (m.role === 'assistant' && m.tool_calls?.length) {
      const answered = new Set<string>();
      for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) {
        answered.add((msgs[j] as { tool_call_id: string }).tool_call_id);
      }
      const kept = m.tool_calls.filter((tc) => answered.has(tc.id));
      if (kept.length) out.push({ ...m, tool_calls: kept });
      else if ((m.content as string | null)?.trim()) out.push({ role: 'assistant', content: m.content as string });
      continue;
    }

    if (m.role === 'tool') {
      let matched = false;
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k].role === 'tool') continue;
        const prev = out[k] as { role: string; tool_calls?: ChatCompletionMessageToolCall[] };
        matched = Boolean(prev.role === 'assistant' && prev.tool_calls?.some((tc) => tc.id === (m as { tool_call_id: string }).tool_call_id));
        break;
      }
      if (matched) out.push(m);
      continue;
    }

    out.push(m);
  }

  return out;
}

// The couriers in the lookup results stored in this chat (for a yes / no ask of a name).
export function couriersInLookups(rows: StoredMessage[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.sender !== 'tool_result') continue;
    try {
      const j = JSON.parse(r.content || '');
      if (j?.found && Array.isArray(j.orders)) for (const o of j.orders) if (o?.courier) out.push(String(o.courier));
    } catch { /* not a lookup result */ }
  }
  return out;
}

// How many times this customer has asked which courier delivers: this chat's messages (the
// history window, the latest included) plus every message of their other chats on this site
// (same customer_key, chat-customer-key.sql; NULL for visitors and email, so only this chat
// counts there). Only the count leaves this function, never the text. null = could not be read,
// which never allows the name.
export async function courierAsksSoFar(conversationId: string, thisChat: string[], names: string[]): Promise<number | null> {
  try {
    const other = await query<{ content: string | null }>(
      `SELECT left(m.content, 600) AS content
         FROM conversations me
         JOIN conversations c ON c.site_id = me.site_id AND c.customer_key = me.customer_key AND c.id <> me.id
         JOIN messages m ON m.conversation_id = c.id
        WHERE me.id = $1 AND me.customer_key IS NOT NULL
          AND m.sender = 'visitor' AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT 300`,
      [conversationId]
    );
    return courierAskCount(thisChat, names) + courierAskCount(other.rows.map((r) => r.content || ''), names);
  } catch (err) {
    console.error('[AI] courier ask count failed:', (err as Error)?.message);
    return null;
  }
}

export interface StoredMessage {
  sender: string;
  content: string | null;
  metadata: { tool_calls?: ChatCompletionMessageToolCall[]; tool_call_id?: string; hidden?: boolean; withheld?: string } | null;
  created_at: Date | string;
}
