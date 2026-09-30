import { NextRequest } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { getAIResponse } from '@/lib/chat/ai';
import { updateConversationSubject } from '@/lib/chat/subject';
import { updateConversationHealth } from '@/lib/chat/health';
import { maskSensitive, withSensitiveWarning, type MaskResult } from '@/lib/chat/sensitive';
import { handoffReply, isCourtesyOnly, isRepeatedReply, routineHandOverKind, routineLine, saysRefundTime, teamWillReplyLine, urgentAck, urgentKind } from '@/lib/chat/escalation';
import { conversationForSite, siteByKey, widgetJson, widgetPreflight } from '@/lib/chat/widget-api';
import { mergeIntoCustomerChat } from '@/lib/chat/merge-chats';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

interface StoredMessage {
  id: string; conversation_id: string; sender: string; content: string;
  metadata: Record<string, unknown> | null; created_at: string;
}

// The last few things we told this customer, for the "same answer again" check.
async function recentAiReplies(conversationId: string): Promise<string[]> {
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

// POST /api/widget/message — visitor sends a message, AI answers inline
export async function POST(request: NextRequest) {
  try {
    const { conversationId: requestedConversationId, siteKey, content } = await request.json();
    if (!requestedConversationId || !siteKey || !content) {
      return widgetJson({ error: 'conversationId, siteKey, content required' }, 400);
    }

    const site = await siteByKey(siteKey);
    if (!site) return widgetJson({ error: 'Invalid site key' }, 404);

    const conversation = await conversationForSite(requestedConversationId, site.id);
    if (!conversation) return widgetJson({ error: 'Forbidden' }, 403);
    // The chat this one stands for: after a merge (merge-chats.ts) a device that still
    // holds the old id writes into the customer's own chat. `let`: a customer who
    // proves an order in this very message may be folded into their earlier chat below.
    let conversationId: string = conversation.id;

    // Card number, CVV, expiry, OTP, UPI PIN or a password typed by the
    // customer is hidden BEFORE it is stored (master rules section 20), so the
    // database, the AI provider and the team only ever see the masked text.
    const masked: MaskResult = typeof content === 'string' ? maskSensitive(content) : { text: content, kinds: [] };
    if (masked.kinds.length) console.log(`[widget] hid ${masked.kinds.join(', ')} in a message on conv ${conversationId}`);

    // What the customer is told back. With payment details in their message the
    // "please do not share these" line goes first.
    const aiReply = (reply: string): string => withSensitiveWarning(reply, masked.kinds, String(masked.text));

    // A threat or a fraud claim is marked on the message itself: the inbox ranks
    // the chat first while no person has answered, whatever the chat's status
    // (master rules sections 15 and 16).
    const urgent = urgentKind(String(masked.text));
    // A refund, cancellation or payment problem is marked too: the auto-close never
    // closes such a chat (master rules section 24).
    const routine = routineHandOverKind(String(masked.text));
    const markers = { ...(masked.kinds.length ? { sensitive_hidden: masked.kinds } : {}), ...(urgent ? { urgent } : {}), ...(routine ? { routine } : {}) };

    // Save visitor message
    const visitorMessage = await queryOne<StoredMessage>(
      `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
       VALUES (gen_random_uuid()::text, $1, 'visitor', $2, $3::jsonb, now())
       RETURNING id, conversation_id, sender, content, metadata, created_at`,
      [conversationId, masked.text, Object.keys(markers).length ? JSON.stringify(markers) : null]
    );

    // A customer writing into a chat staff had Closed opens it again and the
    // AI answers, instead of the message sitting unanswered in a closed chat.
    // On a site with the AI switched off nobody would answer under "AI
    // handling", so there it goes to Needs you instead. Only widget chats, and
    // only 'resolved': a chat waiting on a person ('human_needed') or taken
    // over by one ('agent_handling') keeps its status.
    const updated = await queryOne<{ status: string }>(
      `UPDATE conversations
          SET unread_count = unread_count + 1, last_message_at = now(), updated_at = now(),
              status = CASE WHEN status = 'resolved' AND source = 'chat'
                            THEN CASE WHEN $2::boolean THEN 'ai_handling' ELSE 'human_needed' END
                            ELSE status END
        WHERE id = $1
        RETURNING status`,
      [conversationId, !!site.ai_enabled]
    );
    const status = updated?.status ?? conversation.status;
    if (status !== conversation.status) console.log(`[widget] reopened conv ${conversationId} on a new message`);

    // AI response if in ai_handling mode
    let aiMessage: StoredMessage | null = null;
    if (status === 'ai_handling' && site.ai_enabled) {
      const said = String(masked.text);
      // Needs you. Only from AI handling: a chat a team member already took
      // keeps its owner. Tried twice: the customer is about to be told a person
      // has the chat, so a failed update must not go unnoticed.
      const handOver = async (why: string) => {
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
      };
      const saveAiMessage = (text: string) => queryOne<StoredMessage>(
        `INSERT INTO messages (id, conversation_id, sender, content, created_at)
         VALUES (gen_random_uuid()::text, $1, 'ai', $2, now())
         RETURNING id, conversation_id, sender, content, metadata, created_at`,
        [conversationId, text]
      );

      try {
        if (urgent === 'threat') {
          // No AI text at all: nothing to argue, nothing to defend.
          await handOver('threat');
          aiMessage = await saveAiMessage(aiReply(urgentAck(said)));
        } else {
          const aiResult = await getAIResponse(conversationId, site.system_prompt, site.tracker_business_id, site.cod_available, 'chat', site.id);

          // The customer may just have proved an order in this chat (order ID + full
          // phone). If they already have a chat for that order, this one is folded into
          // it now: one chat, with the history, and everything below is saved there.
          const beforeMerge = conversationId;
          conversationId = await mergeIntoCustomerChat(conversationId);
          const merged = conversationId !== beforeMerge;

          // Store the tool exchange as hidden messages so the next turn still
          // knows which order was looked up.
          if (aiResult.toolCallMeta) {
            const { tool_calls, tool_call_id, tool_result } = aiResult.toolCallMeta;
            await query(
              `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
               VALUES (gen_random_uuid()::text, $1, 'ai', '', $2::jsonb, now())`,
              [conversationId, JSON.stringify({ tool_calls, hidden: true })]
            );
            await query(
              `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
               VALUES (gen_random_uuid()::text, $1, 'tool_result', $2, $3::jsonb, now())`,
              [conversationId, tool_result, JSON.stringify({ tool_call_id, hidden: true })]
            );
          }

          let text = aiResult.content;
          if (aiResult.allFailed) {
            // Every model is down (master rules section 13): a person takes it,
            // and the customer is told so instead of "please send that again".
            text = handoffReply(said);
            await handOver('AI failure');
          } else if (!aiResult.escalated && !merged && !isCourtesyOnly(said) && isRepeatedReply(text, await recentAiReplies(conversationId))) {
            // The same answer again (section 12): stop, and let a person take it.
            text = handoffReply(said);
            await handOver('repeated answer');
          } else if (urgent === 'accusation') {
            // A fraud or fake-site claim (section 16): the AI answered with what
            // it can prove (tracking link, order status); a person takes it now.
            text = `${text}\n\n${teamWillReplyLine(said)}`;
            await handOver('fraud claim');
          } else if (!aiResult.escalated && routineHandOverKind(said)) {
            // A refund or cancellation request, or a payment problem (sections
            // 11 and 17): noted and handed to a person, whatever the AI said.
            const kind = routineHandOverKind(said)!;
            if (kind !== 'refund' || !saysRefundTime(text)) text = `${text}\n\n${routineLine(kind, said)}`;
            await handOver(kind);
          }

          // Save the visible reply. When the customer sent payment details, the
          // "please do not share these" line goes first (added here, not left
          // to the model).
          aiMessage = await saveAiMessage(aiReply(text));
        }

        await query(
          `UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
          [conversationId]
        );
      } catch (aiErr) {
        // Never leave the visitor with a spinning typing indicator and no reply,
        // and never leave the chat with nobody looking at it (section 13).
        console.error('[widget] AI error:', (aiErr as Error).message);
        await handOver('AI error');
        try {
          aiMessage = await saveAiMessage(aiReply(handoffReply(said)));
        } catch (saveErr) {
          console.error('[widget] fallback save failed:', (saveErr as Error).message);
        }
      }
    }

    // The chat's subject line for the inbox (src/lib/chat/subject.ts), now
    // that the reply is saved. Not awaited: the visitor never waits on it, and
    // it never throws.
    void updateConversationSubject(conversationId);
    // How upset the customer is (src/lib/chat/health.ts): same rules, same care.
    void updateConversationHealth(conversationId);

    // conversationId: the chat the widget should be on (after a merge it is another id).
    return widgetJson({ message: visitorMessage, aiResponse: aiMessage, conversationId }, 201);
  } catch (err) {
    console.error('[widget] message error:', err);
    return widgetJson({ error: 'Could not send that message' }, 500);
  }
}
