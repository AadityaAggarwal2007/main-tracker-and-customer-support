import { PoolClient } from 'pg';
import { queryOne, withTransaction } from '@/lib/db';
import { logChatEvent } from './team-routing';

// ── One chat per customer ──────────────────────────────────────
// Asked for by the owner on 2026-09-30: a customer who verifies (order ID + full
// phone) while an older chat of theirs exists must end up with ONE chat that holds
// the whole history, not two. The older chat is the one that stays (it has the
// history and the customer's place in the inbox); the newer one's messages are
// MOVED into it, and the newer chat stays as an empty, Closed shell with
// merged_into set (nothing is deleted; chat-merge.sql). Widget routes follow
// merged_into (widget-api.ts conversationForSite), so a device that still holds the
// shell's id keeps working, in the merged chat.

interface ChatRow {
  id: string; site_id: string; status: string; unread_count: number;
  visitor_id: string | null; visitor_name: string | null;
  verified_order_id: string | null; verified_via: string | null; customer_key: string | null;
  source: string; merged_into: string | null;
  assigned_to?: string | null;
}

async function tableExists(name: string): Promise<boolean> {
  const r = await queryOne<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
  return !!r?.ok;
}

// Moves everything from `fromId` into `targetId`. The target is reopened when the
// customer is talking again (a Closed chat goes back to the AI, or to Needs you when
// the moved chat was already waiting for a person). The mark that the auto-close
// closed it stays, so the inbox shows it as "Came back" until a person acts.
// Who holds it (chat-team.sql): the target keeps its own holder; a target nobody holds takes the
// merged chat's, so the person who was answering the customer still has them (logged as 'merge').
export async function mergeChats(targetId: string, fromId: string): Promise<boolean> {
  if (!targetId || !fromId || targetId === fromId) return false;
  const withRevisions = await tableExists('message_revisions');
  const withAttachments = await tableExists('chat_attachments');

  return withTransaction(async (client: PoolClient) => {
    // Both rows locked in a fixed order, so two merges cannot deadlock.
    const ids = [targetId, fromId].sort();
    const locked = await client.query<ChatRow & { ai_enabled: boolean | null }>(
      `SELECT c.id, c.site_id, c.status, c.unread_count, c.visitor_id, c.visitor_name,
              c.verified_order_id, c.verified_via, c.customer_key, c.source, c.merged_into, s.ai_enabled,
              c.assigned_to
         FROM conversations c JOIN sites s ON s.id = c.site_id
        WHERE c.id = ANY($1::text[])
        ORDER BY c.id
          FOR UPDATE OF c`,
      [ids]
    );
    const target = locked.rows.find((r) => r.id === targetId);
    const from = locked.rows.find((r) => r.id === fromId);
    // Never across sites, never into or out of a chat that was already merged.
    if (!target || !from || target.site_id !== from.site_id || target.merged_into || from.merged_into) return false;

    await client.query(`UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2`, [targetId, fromId]);
    if (withAttachments) {
      await client.query(`UPDATE chat_attachments SET conversation_id = $1 WHERE conversation_id = $2`, [targetId, fromId]);
    }
    if (withRevisions) {
      await client.query(`UPDATE message_revisions SET conversation_id = $1 WHERE conversation_id = $2`, [targetId, fromId]);
    }

    const reopen = target.ai_enabled ? 'ai_handling' : 'human_needed';
    await client.query(
      `UPDATE conversations
          SET status = CASE WHEN $3 = 'human_needed' THEN 'human_needed'
                            WHEN status = 'resolved' AND case_kind IS NOT NULL THEN 'agent_handling'
                            WHEN status = 'resolved' THEN $4
                            ELSE status END,
              unread_count = unread_count + $5::int,
              visitor_id = COALESCE($6, visitor_id),
              visitor_name = COALESCE(visitor_name, $7),
              last_message_at = GREATEST(COALESCE(last_message_at, now()), now()),
              assigned_to = COALESCE(assigned_to, $8),
              assigned_at = CASE WHEN assigned_to IS NULL AND $8::text IS NOT NULL THEN now() ELSE assigned_at END,
              updated_at = now()
        WHERE id = $1 AND id <> $2`,
      [targetId, fromId, from.status, reopen, from.unread_count || 0, from.visitor_id, from.visitor_name, from.assigned_to ?? null]
    );
    if (!target.assigned_to && from.assigned_to) {
      await logChatEvent(client, 'system', {
        conversationId: targetId, siteId: target.site_id, kind: 'merge', fromOwner: null, toOwner: from.assigned_to,
        reason: 'merge', meta: { merged_from: fromId },
      });
    }
    await client.query(
      `UPDATE conversations SET merged_into = $1, status = 'resolved', unread_count = 0, updated_at = now() WHERE id = $2`,
      [targetId, fromId]
    );
    return true;
  });
}

// After a customer proved an order IN THE CHAT (verified_via 'chat_phone': order ID +
// full phone), fold this chat into the customer's earlier chat for the same order,
// if there is one. Returns the id the conversation now lives under (the same id when
// nothing was merged). Never throws: a failed merge must not lose the reply.
export async function mergeIntoCustomerChat(conversationId: string): Promise<string> {
  try {
    const me = await queryOne<ChatRow>(
      `SELECT id, site_id, status, unread_count, visitor_id, visitor_name, verified_order_id, verified_via, customer_key, source, merged_into
         FROM conversations WHERE id = $1`,
      [conversationId]
    );
    if (!me || me.merged_into || me.source !== 'chat' || me.verified_via !== 'chat_phone' || !me.verified_order_id || !me.customer_key) {
      return conversationId;
    }
    const target = await queryOne<{ id: string }>(
      `SELECT id FROM conversations
        WHERE site_id = $1 AND source = 'chat' AND customer_key = $2 AND verified_order_id = $3
          AND verified_via IN ('form', 'chat_phone') AND merged_into IS NULL AND id <> $4
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      [me.site_id, me.customer_key, me.verified_order_id, me.id]
    );
    if (!target) return conversationId;
    const merged = await mergeChats(target.id, me.id);
    if (merged) console.log(`[chat] merged chat ${me.id} into the customer's chat ${target.id}`);
    return merged ? target.id : conversationId;
  } catch (err) {
    console.error('[chat] merge into customer chat failed:', (err as Error).message);
    return conversationId;
  }
}

// After the widget form verified a customer and gave them their earlier chat: the
// chat this browser had been using as a visitor (open, not verified) is folded into
// it, so what they typed before verifying is in the same chat. Only the most recent
// one, and never one that was verified for somebody else. Never throws.
export async function mergeVisitorChatInto(targetId: string, siteId: string, visitorId: string): Promise<void> {
  try {
    const own = await queryOne<{ id: string }>(
      `SELECT id FROM conversations
        WHERE site_id = $1 AND visitor_id = $2 AND source = 'chat' AND id <> $3
          AND status <> 'resolved' AND verified_order_id IS NULL AND merged_into IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [siteId, visitorId, targetId]
    );
    if (!own) return;
    if (await mergeChats(targetId, own.id)) console.log(`[chat] merged visitor chat ${own.id} into ${targetId}`);
  } catch (err) {
    console.error('[chat] merge visitor chat failed:', (err as Error).message);
  }
}

// The id a conversation id stands for now (follows merged_into, a few hops at most).
export async function canonicalConversationId(id: string): Promise<string> {
  let cur = id;
  for (let i = 0; i < 5; i++) {
    const r = await queryOne<{ merged_into: string | null }>(`SELECT merged_into FROM conversations WHERE id = $1`, [cur]);
    if (!r?.merged_into) return cur;
    cur = r.merged_into;
  }
  return cur;
}

