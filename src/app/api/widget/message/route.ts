import { recordBrainUsage } from '@/lib/chat/brain-usage';
import { recordChikkiRun } from '@/lib/chat/chikki-runs';
import type { EffortUsage } from '@/lib/chat/effort';
import { NextRequest } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { AI_BUSY_REPLY, getAIResponse } from '@/lib/chat/ai';
import { updateConversationSubject } from '@/lib/chat/subject';
import { updateConversationHealth } from '@/lib/chat/health';
import { maskSensitive, withSensitiveWarning, type MaskResult } from '@/lib/chat/sensitive';
import { handoffReply, isCourtesyOnly, looksHinglish, isRepeatedReply, routineHandOverKind, urgentAck, urgentKind, withHandOverLine } from '@/lib/chat/escalation';
import { afterHours } from '@/lib/office-hours';
import { conversationForSite, siteByKey, widgetJson, widgetPreflight } from '@/lib/chat/widget-api';
import { mergeIntoCustomerChat } from '@/lib/chat/merge-chats';
import { chatIsVerified } from '@/lib/chat/verified';
import { addressConflict, addressConflictReply } from '@/lib/chat/address-conflict';
import { recentVisitorMessages } from '@/lib/chat/chat-history';
import { earlierVisitorMessages, reshipFollowUp, trackingClaimTurn, type ClaimTurn } from '@/lib/chat/case-auto';
import { mentionsTracking, trackingClaimKind } from '@/lib/chat/tracking-claim';

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
    const updated = await queryOne<{ status: string; case_kind: string | null }>(
      `UPDATE conversations
          SET unread_count = unread_count + 1, last_message_at = now(), updated_at = now(),
              status = CASE WHEN status = 'resolved' AND source = 'chat'
                            -- A Refund / Ship again chat (chat-cases.sql) stays with the team: no AI.
                            THEN CASE WHEN case_kind IS NOT NULL THEN 'agent_handling'
                                      WHEN $2::boolean THEN 'ai_handling' ELSE 'human_needed' END
                            ELSE status END
        WHERE id = $1
        RETURNING status, case_kind`,
      [conversationId, !!site.ai_enabled]
    );
    const status = updated?.status ?? conversation.status;
    if (status !== conversation.status) console.log(`[widget] reopened conv ${conversationId} on a new message`);

    // Night (19:30-10:00 IST, owner 2026-10-01): the 1-hour and 24-hour lines say the
    // team replies in the morning instead (escalation.ts AfterHours). Read once, when
    // the customer's message came in, so one reply never mixes day and night lines.
    const after = afterHours(Date.now());

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
    let aiMessage: StoredMessage | null = null;

    // Owner 2026-10-02 (answers 4 and 8): a Ship again chat. The AI stays off; code may remind
    // the customer once or flag the chat red (case-auto.ts reshipFollowUp). The red flag is
    // saved before any text.
    if (status === 'agent_handling' && updated?.case_kind === 'reship') {
      try {
        const f = await reshipFollowUp({
          convId: conversationId, said: String(masked.text), urgent, routine, after,
          aiOn: !!site.ai_enabled, earlierAi: () => recentAiReplies(conversationId),
        });
        if (f?.text) {
          aiMessage = await saveAiMessage(aiReply(f.text));
          await query(`UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [conversationId]);
        }
      } catch (err) {
        // The customer's message is saved and the chat is unread in its section, as today.
        console.error('[widget] Ship again follow-up failed:', (err as Error).message);
      }
    }

    // AI response if in ai_handling mode
    if (status === 'ai_handling' && site.ai_enabled) {
      const said = String(masked.text);

      // Only a VERIFIED customer goes to Needs you (owner, 2026-09-30). A visitor stays
      // a visitor: the AI answers (and asks them to verify), nobody moves the chat,
      // and no "our team will reply" line is sent. Read again after the AI turn: the
      // customer may have verified in this very message.
      let verified = await chatIsVerified(conversationId);
      // What this first read found, kept for the tracking claim below (the read after the AI turn
      // overwrites `verified`): a chat verified only in this turn also has its earlier messages read.
      const verifiedAtStart = verified;

      // Two different addresses from one customer (master rules section 10): the AI must
      // not pick one. A verified customer's chat goes to a person; nobody else is moved.
      let addressClash = false;
      if (verified && urgent !== 'threat') {
        try {
          const said_all = await recentVisitorMessages(conversationId);
          addressClash = addressConflict(said_all.slice(1), said);
        } catch (err) {
          console.error('[widget] address check failed:', (err as Error).message);
        }
      }

      try {
        if (addressClash) {
          await handOver('address conflict');
          aiMessage = await saveAiMessage(aiReply(addressConflictReply(looksHinglish(said))));
        } else if (urgent === 'threat' && verified) {
          // No AI text at all: nothing to argue, nothing to defend.
          await handOver('threat');
          aiMessage = await saveAiMessage(aiReply(urgentAck(said, after)));
        } else {
          const brainUsage: { brain: { id: string; title: string }[]; effort?: EffortUsage } = { brain: [] };
          const aiStarted = Date.now();
          const aiResult = await getAIResponse(conversationId, site.system_prompt, site.tracker_business_id, site.cod_available, 'chat', site.id, brainUsage);
          if (brainUsage.effort) brainUsage.effort.ms = Date.now() - aiStarted;

          // The customer may just have proved an order in this chat (order ID + full
          // phone). If they already have a chat for that order, this one is folded into
          // it now: one chat, with the history, and everything below is saved there.
          const beforeMerge = conversationId;
          conversationId = await mergeIntoCustomerChat(conversationId);
          const merged = conversationId !== beforeMerge;
          verified = await chatIsVerified(conversationId);

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

          let text: string | null = aiResult.content;
          // Owner 2026-10-02: a fake / invalid / stuck tracking claim from a verified customer gets a
          // fixed reply by code, and a dispatched order goes to Ship again by itself (case-auto.ts,
          // tracking-claim.ts). No SQL unless the words match. Never throws: null = not this path.
          let claim: ClaimTurn | null = null;
          let earlierSaid: string[] = [];
          if (!aiResult.allFailed && verified) {
            claim = await trackingClaimTurn({
              convId: conversationId, trackerBusinessId: site.tracker_business_id, said, urgent, after,
              // Only this conversation's own recent messages: after a merge, never the older chat's history.
              lookBack: async () => (earlierSaid = verifiedAtStart ? [] : await earlierVisitorMessages(conversationId, beforeMerge)),
              toolResult: aiResult.toolCallMeta?.tool_result ?? null,
              aiText: text, aiEscalated: !!aiResult.escalated, merged,
              earlierAi: () => recentAiReplies(conversationId),
            });
            // Wordings the detector missed: the AI handed a tracking question over. Logged with the
            // chat id only, for the lead's weekly check (never the customer's words).
            if (!claim && aiResult.escalated && mentionsTracking(said) && !trackingClaimKind(said)) {
              console.log(`[widget] tracking words, no claim: conv ${conversationId}`);
            }
          }
          // Owner answer 4: the turn ended in a Ship again chat (merged into one, or Chikki marked it
          // while the model answered) and is no tracking claim (row 4 above has those). The AI is off
          // there: the model's text is dropped and the message gets what it gets in that chat
          // (case-auto.ts reshipFollowUp: red with the line for the case, or the one reminder; the red
          // flag is saved first). null = not a Ship again chat. A failed read keeps today's path.
          let shipAgain: { text: string | null } | null = null;
          if (verified && !claim && ![said, ...earlierSaid].some((t) => trackingClaimKind(t))) {
            try {
              shipAgain = await reshipFollowUp({
                convId: conversationId, said, urgent, routine, after, aiOn: true,
                earlierAi: () => recentAiReplies(conversationId),
              });
              if (shipAgain) console.log(`[widget] conv ${conversationId} turn ended in a Ship again chat: ${shipAgain.text ? 'its line' : 'no message'}`);
            } catch (err) {
              console.error(`[widget] Ship again check after the AI turn failed on conv ${conversationId}:`, (err as Error).message);
            }
          }
          if (shipAgain) {
            text = shipAgain.text;
          } else if (aiResult.allFailed) {
            if (verified) {
              // Every model is down (master rules section 13): a person takes it,
              // and the customer is told so instead of "please send that again".
              text = handoffReply(said);
              await handOver('AI failure');
            } else {
              // A visitor stays a visitor: the plain apology, nobody is told a team has it.
              text = AI_BUSY_REPLY;
            }
          } else if (!verified) {
            // A visitor: whatever the message was about (a refund, a threat, a fraud
            // claim, the same answer again), the AI's own reply stands. Nothing moves
            // the chat out of Visitors until the customer has verified.
          } else if (claim) {
            // The fixed text replaces the model's; the Ship again mark or red flag is already saved
            // (case-auto.ts). text null: the order could not be loaded and the AI handed over, so
            // its own text stands, with the night line as today.
            if (claim.handOver) await handOver(claim.handOver);
            text = claim.text ?? withHandOverLine(text, said, 'escalated', after);
          } else if (!aiResult.escalated && !merged && !isCourtesyOnly(said) && isRepeatedReply(text, await recentAiReplies(conversationId))) {
            // The same answer again (section 12): stop, and let a person take it.
            text = handoffReply(said);
            await handOver('repeated answer');
          } else if (urgent === 'accusation') {
            // A fraud or fake-site claim (section 16): the AI answered with what
            // it can prove (tracking link, order status); a person takes it now.
            text = withHandOverLine(text, said, 'accusation', after);
            await handOver('fraud claim');
          } else if (!aiResult.escalated && routineHandOverKind(said)) {
            // A refund or cancellation request, or a payment problem (sections
            // 11 and 17): noted and handed to a person, whatever the AI said.
            const kind = routineHandOverKind(said)!;
            text = withHandOverLine(text, said, kind, after);
            await handOver(kind);
          } else if (aiResult.escalated) {
            // The AI (or a guard) handed a verified customer over and already said the
            // team replies. By day the text stands as it is; at night an hour promise
            // the AI wrote is swapped for the morning line. A guard's fixed hand-over
            // text has no hours, so it comes back unchanged.
            text = withHandOverLine(text, said, 'escalated', after);
          }

          // Save the visible reply. When the customer sent payment details, the
          // "please do not share these" line goes first (added here, not left
          // to the model). null: a Ship again chat that sends nothing for this message.
          if (text !== null) {
            aiMessage = await saveAiMessage(aiReply(text));
            await recordBrainUsage(aiMessage?.id, brainUsage.brain);
            await recordChikkiRun(aiMessage?.id, conversationId, site.id, brainUsage.effort);
          }
        }

        await query(
          `UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
          [conversationId]
        );
      } catch (aiErr) {
        // Never leave the visitor with a spinning typing indicator and no reply,
        // and never leave the chat with nobody looking at it (section 13).
        console.error('[widget] AI error:', (aiErr as Error).message);
        if (verified) await handOver('AI error');
        try {
          aiMessage = await saveAiMessage(aiReply(verified ? handoffReply(said) : AI_BUSY_REPLY));
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
