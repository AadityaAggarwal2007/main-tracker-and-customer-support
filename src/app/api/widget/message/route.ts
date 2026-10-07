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
import { afterHours, closedWhy } from '@/lib/office-hours';
import { loadHolidays } from '@/lib/chat/holidays';
import { CLOSED_NOTE_KEY } from '@/lib/chat/closed-hours';
import { closedHoursTurn, withClosedNote } from '@/lib/chat/closed-hours-run';
import { conversationForSite, siteByKey, widgetJson, widgetPreflight } from '@/lib/chat/widget-api';
import { mergeIntoCustomerChat } from '@/lib/chat/merge-chats';
import { chatIsVerified } from '@/lib/chat/verified';
import { addressConflict, addressConflictReply } from '@/lib/chat/address-conflict';
import { recentVisitorMessages } from '@/lib/chat/chat-history';
import {
  earlierVisitorMessages, refundFollowUp, refundThreatTurn, reshipFollowUp, trackingClaimTurn, type ClaimTurn, type RefundThreatTurn,
} from '@/lib/chat/case-auto';
import { mentionsTracking, trackingClaimKind } from '@/lib/chat/tracking-claim';
import { refundThreatKind } from '@/lib/chat/refund-threat';
import { handOverToPerson, handoffReplyWithLink, recentAiReplies, saveAiMessageTo, type StoredMessage } from '@/lib/chat/widget-turn';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

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
    // (master rules sections 15 and 16). A chargeback / court / police threat that can move a chat
    // to Refund by itself (refund-threat.ts, owner 2026-10-02) is always a threat here too.
    const urgent = urgentKind(String(masked.text)) ?? (refundThreatKind(String(masked.text)) ? 'threat' : null);
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
    // Since 2026-10-05 the week counts too (office-hours.ts: Saturday to 14:00, Sunday and the
    // listed holidays off): "on Monday morning, after 10 AM". `why` = why the office is closed
    // now (closed-hours.ts: the note for an upset customer), null while it is open.
    const nowMs = Date.now();
    const holidays = await loadHolidays(nowMs);
    const after = afterHours(nowMs, holidays);
    const why = closedWhy(nowMs, holidays);

    // Needs you. Only from AI handling: a chat a team member already took
    // keeps its owner. Tried twice: the customer is about to be told a person
    // has the chat, so a failed update must not go unnoticed.
    const handOver = (why: string) => handOverToPerson(conversationId, why);
    const saveAiMessage = (text: string, metadata?: Record<string, string> | null) => saveAiMessageTo(conversationId, text, metadata);
    let aiMessage: StoredMessage | null = null;
    // Owner 2026-10-05: while the office is closed, an upset VERIFIED customer's reply ends in the
    // closed-hours note (why nobody can confirm anything now, the team sits down with their case first
    // thing when it opens) instead of the 1-hour / 24-hour / morning line, and the chat goes to the
    // team (closed-hours.ts, closed-hours-run.ts). Only the FULL note is possible here (the chat is
    // still in AI handling); the short line and the silence belong to the block below. The note's
    // marker on the message is what counts the notes and what the inbox reads for the "Promised" chip.
    let closedMeta: Record<string, string> | null = null;
    const closedWrap = async (text: string, said: string, verified: boolean): Promise<string> => {
      if (!verified || !why || !after || closedMeta) return text;
      try {
        const ct = await closedHoursTurn({ convId: conversationId, said, now: nowMs, holidays, after });
        if (!ct || ct.step !== 'full' || !ct.text) return text;
        closedMeta = { [CLOSED_NOTE_KEY]: 'full' };
        return withClosedNote(text, said, after, ct.text);
      } catch (err) {
        console.error(`[widget] closed-hours note failed on conv ${conversationId}:`, (err as Error).message);
        return text;
      }
    };

    // Owner 2026-10-02 (answers 4 and 8): a Ship again chat. The AI stays off; code may remind
    // the customer once or flag the chat red (case-auto.ts reshipFollowUp). The red flag is
    // saved before any text. Owner 2026-10-02 18:45: a chargeback / court / police threat on a late
    // order moves it to Refund first, with the promise (case-auto.ts refundThreatTurn; the mark is
    // saved before the text); any other threat keeps the Ship again rules. Review fix 2026-10-02: a RED
    // Ship again chat (status human_needed: flagged by an earlier follow-up, or kept in Needs you when
    // Chikki marked it) is switched too, and stays in Needs you; anything else in a red chat sends
    // nothing, as before (the team already owes the answer).
    if ((status === 'agent_handling' || status === 'human_needed') && updated?.case_kind === 'reship') {
      try {
        let f: { text: string | null } | null = null;
        if (site.ai_enabled && refundThreatKind(String(masked.text))) {
          const t = await refundThreatTurn({ convId: conversationId, said: String(masked.text), lookBack: null, toolResult: null, keepNeedsYou: true });
          if (t && t.act !== 'today') f = { text: t.text };
        }
        if (!f && status === 'agent_handling') {
          f = await reshipFollowUp({
            convId: conversationId, said: String(masked.text), urgent, routine, after,
            aiOn: !!site.ai_enabled, earlierAi: () => recentAiReplies(conversationId),
          });
        }
        if (f?.text) {
          aiMessage = await saveAiMessage(aiReply(f.text));
          await query(`UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [conversationId]);
        }
      } catch (err) {
        // The customer's message is saved and the chat is unread in its section, as today.
        console.error('[widget] Ship again follow-up failed:', (err as Error).message);
      }
    }

    // Owner 2026-10-02 18:45: a Refund chat Chikki marked itself. The AI stays off; when the customer
    // writes again they get ONE reminder (the refund proof comes in this chat and on their email), then
    // nothing until the team writes (case-auto.ts refundFollowUp). A chat a person marked, or one the
    // team has written in since, sends nothing, as before.
    if ((status === 'agent_handling' || status === 'human_needed') && updated?.case_kind === 'refund') {
      try {
        const f = await refundFollowUp({
          convId: conversationId, said: String(masked.text), aiOn: !!site.ai_enabled, earlierAi: () => recentAiReplies(conversationId),
        });
        if (f?.text) {
          aiMessage = await saveAiMessage(aiReply(f.text));
          await query(`UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [conversationId]);
        }
      } catch (err) {
        console.error('[widget] Refund follow-up failed:', (err as Error).message);
      }
    }

    // Owner 2026-10-05: an upset VERIFIED customer who writes again while the office is closed, into a
    // chat the team already holds (Needs you, or taken over) with no Refund / Ship again mark (those have
    // their own one reminder above): the full closed-hours note once per closed stretch, a short line on
    // the next message, then nothing (the team owes the answer; the chat stays waiting and the inbox
    // shows the promise). A calmer customer, a "thanks", or a team member active in the chat in the
    // last 30 minutes: nothing is sent, as before (closed-hours.ts closedNoteStep).
    if ((status === 'human_needed' || status === 'agent_handling') && !updated?.case_kind && site.ai_enabled && why && after) {
      try {
        if (await chatIsVerified(conversationId)) {
          const ct = await closedHoursTurn({ convId: conversationId, said: String(masked.text), now: nowMs, holidays, after });
          if (ct?.text) {
            aiMessage = await saveAiMessage(aiReply(ct.text), { [CLOSED_NOTE_KEY]: ct.step });
            await query(`UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [conversationId]);
            console.log(`[widget] conv ${conversationId}: closed-hours note (${ct.step})`);
          } else if (ct?.step === 'silent') {
            console.log(`[widget] conv ${conversationId}: closed hours, nothing more to say (the team has it)`);
          }
        }
      } catch (err) {
        // The customer's message is saved and the chat is unread in its section, as today.
        console.error('[widget] closed-hours follow-up failed:', (err as Error).message);
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
          // No AI text at all: nothing to argue, nothing to defend. Owner 2026-10-02 18:45: a
          // chargeback / court / police threat from a customer verified by order ID + full phone whose
          // order's estimated date has passed goes to Refund instead, with the fixed promise
          // (case-auto.ts refundThreatTurn: the mark is saved first). Anything else: Needs you as before.
          const t = refundThreatKind(said)
            ? await refundThreatTurn({ convId: conversationId, said, lookBack: null, toolResult: null, keepNeedsYou: true })
            : null;
          if (t && t.act !== 'today') {
            aiMessage = await saveAiMessage(aiReply(t.text));
          } else {
            await handOver('threat');
            aiMessage = await saveAiMessage(aiReply(await closedWrap(urgentAck(said, after), said, true)), closedMeta);
          }
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
          // "Complained first, verified next": this conversation's own last messages (24 hours, never an
          // older merged chat's history), read once for both checks below. [] when verified at the start.
          let earlierSaid: string[] = [];
          let earlierRead: Promise<string[]> | null = null;
          const lookBack = () => (earlierRead ??= (verifiedAtStart ? Promise.resolve([]) : earlierVisitorMessages(conversationId, beforeMerge))
            .then((rows) => (earlierSaid = rows)));
          // Owner 2026-10-02 18:45: a chargeback / court / police threat (this message, or an earlier one
          // when the customer verified in this turn) from a customer verified by order ID + full phone,
          // whose order's estimated date has passed: Refund by itself with the fixed promise; a Ship again
          // chat (merged into) switches to Refund (case-auto.ts refundThreatTurn, refund-threat.ts). It
          // wins over a tracking claim, as a threat always did. Never throws: null = not this path.
          let threatTurn: RefundThreatTurn | null = null;
          if (!aiResult.allFailed && verified) {
            threatTurn = await refundThreatTurn({
              convId: conversationId, said, lookBack, toolResult: aiResult.toolCallMeta?.tool_result ?? null,
              keepNeedsYou: merged || !aiResult.escalated,
            });
          }
          const toRefund = !!threatTurn && threatTurn.act !== 'today';
          // Owner 2026-10-02: a fake / invalid / stuck tracking claim from a verified customer gets a
          // fixed reply by code, and a dispatched order goes to Ship again by itself (case-auto.ts,
          // tracking-claim.ts). No SQL unless the words match. Never throws: null = not this path.
          let claim: ClaimTurn | null = null;
          if (!aiResult.allFailed && verified && !toRefund) {
            claim = await trackingClaimTurn({
              convId: conversationId, trackerBusinessId: site.tracker_business_id, said, urgent, after,
              // Only this conversation's own recent messages: after a merge, never the older chat's history.
              lookBack,
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
          if (verified && !toRefund && !claim && ![said, ...earlierSaid].some((t) => trackingClaimKind(t))) {
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
          // Owner 2026-10-02 18:45: the turn ended in a Refund chat Chikki marked (merged into it): the AI
          // is off there, the model's text is dropped; the one reminder, or nothing (refundFollowUp).
          // null = not such a chat: today's path.
          let refundChat: { text: string | null } | null = null;
          if (verified && !toRefund && !claim && !shipAgain) {
            try {
              refundChat = await refundFollowUp({ convId: conversationId, said, aiOn: true, earlierAi: () => recentAiReplies(conversationId) });
              if (refundChat) console.log(`[widget] conv ${conversationId} turn ended in a Refund chat: ${refundChat.text ? 'the reminder' : 'no message'}`);
            } catch (err) {
              console.error(`[widget] Refund check after the AI turn failed on conv ${conversationId}:`, (err as Error).message);
            }
          }
          if (threatTurn && threatTurn.act !== 'today') {
            // The mark (or switch) is already saved; the fixed text replaces the model's.
            text = threatTurn.text;
          } else if (shipAgain) {
            text = shipAgain.text;
          } else if (refundChat) {
            text = refundChat.text;
          } else if (aiResult.allFailed) {
            if (verified) {
              // Every model is down (master rules section 13): a person takes it,
              // and the customer is told so instead of "please send that again".
              text = await handoffReplyWithLink(conversationId, said, site.tracker_business_id);
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
          } else if (threatTurn?.act === 'today' && threatTurn.source === 'this') {
            // A chargeback / court / police threat in this message that is not for Refund (the order is
            // not late, delivered, another order ...), from a customer who verified in this turn: the
            // threat path, as for one verified before (no AI text, Needs you, the 1-hour line).
            text = urgentAck(said, after);
            await handOver('threat');
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

          // Owner 2026-10-05: the office is closed and this verified customer is upset enough (closed-hours.ts):
          // the reply ends in the closed-hours note and the chat goes to the team. Not over a Refund / Ship
          // again text or a tracking-claim text (each carries its own promise), never for a visitor.
          if (text !== null && verified && !toRefund && !shipAgain && !refundChat && !claim) {
            const wrapped = await closedWrap(text, said, true);
            if (closedMeta) {
              text = wrapped;
              await handOver('closed hours, upset customer');
            }
          }

          // Save the visible reply. When the customer sent payment details, the
          // "please do not share these" line goes first (added here, not left
          // to the model). null: a Ship again chat that sends nothing for this message.
          if (text !== null) {
            aiMessage = await saveAiMessage(aiReply(text), closedMeta);
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
          aiMessage = await saveAiMessage(aiReply(verified ? await handoffReplyWithLink(conversationId, said, site.tracker_business_id) : AI_BUSY_REPLY));
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
