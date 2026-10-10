import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions';
import { query, queryOne } from '@/lib/db';
import { customerKeyForOrderSql, lookupOrder, lookupVerifiedOrder, normalizePhone } from './orders';
import { LIMITS, isLimited, release, reserve } from './lookup-limits';
import { chatIsVerified } from './verified';
import { loadOrderFacts } from './order-facts';
import { delayAsksIn, delayNote, delayStage, isDelayAsk } from './delay-ladder';
import { ALREADY_REPLIED_NOTE, dropRepeatedIntroduction } from './introduction';
import {
  asksAgainAfterFailedLookups, consecutiveAsks, findPendingLookup, handOverReply, keptAskingForMissingOrderId, notFoundReply, verifyAgainReply,
  lastReplyReasked, mentionsAnotherOrder, normId, normaliseDigits, reasksForOrderDetails, reasksForPhone, typedByVisitor, isBarePhone, orderIdAfterPhoneReply, asksForPhone,
  type LookupOutcome,
} from './lookup-guard';
import { stripMarkdownEmphasis } from './plain-text';
import { dropTodayPromise, promisesToday } from './today-promise';
import { fixOrderMentions } from './order-mention';
import { asksAboutCourier, COURIER_NAME_FROM_ASK, dropAddressEcho, stripLinkJunk, withCheckAround, withExactTrackingLinks, withoutUnaskedCourier } from './reply-guards';
import { looksHinglish } from './escalation';
import { FORM_VERIFY_ASK, dropFormMentions } from '@/lib/refund/link-mask';
import { dropDisputeAdvice } from './dispute-advice';
import { codAlreadyToldNote } from './cod';
import { brainSection, selectNotes, type BrainNote } from './brain';
import { detectSituations, examplesSection, pickExamples, type Example } from './brain-examples';
import { EFFORT_PLAN, effortFor, effortScore, groupFor, newEffortUsage, type EffortUsage } from './effort';
import { CHECK_NOTE, latestOrderFacts, parseCheck } from './self-check';
import { BlankReplyError, MAX_REPLY_TOKENS, SELF_CHECK_MAX_TOKENS, SELF_CHECK_TIMEOUT_MS, THINKING_TIMEOUT_MS, attemptOrder, getActiveModel, getClient, isRetryable, withThinking, withoutThinking } from './ai-models';
import { noteAiFailure, noteAiSuccess } from './ai-health';
import { buildSystemPrompt, type Channel, type SavedAnswer } from './ai-prompt';
import { CATEGORIZE_TOOL, ESCALATE_TOOL, ORDER_LOOKUP_TOOL } from './ai-tools';
import { UNPROVEN_LOOKUP, VERIFICATION_DEPLOYED_AT, courierAsksSoFar, couriersInLookups, dropOrphanedToolCalls, isProvenLookup, type StoredMessage } from './ai-history';

// Moved out of this file on 2026-10-02 (pure move); re-exported so no importer changes.
export { AI_MODELS, attemptOrder, getActiveModel, getChain, getClient, getModelList, isRetryable, loadActiveModelFromDb, persistActiveModel, setActiveModel, sideAttemptOrder, sideModel } from './ai-models';
export { DEFAULT_SYSTEM_PROMPT, SAVED_ANSWERS_BUDGET, buildSystemPrompt, getLockedRules } from './ai-prompt';
export type { Channel, SavedAnswer } from './ai-prompt';

// ── The support AI ─────────────────────────────────────────────
// Ported from the chat-support app's ai.js. The system prompt, the tool
// definitions and the fallback chain are carried over unchanged: that prompt is
// the only thing standing between a customer and an invented refund policy.

// A reply that promises arrival today, tonight or tomorrow loses that sentence (today-promise.ts).
function withoutTodayPromise(text: string): string {
  if (!promisesToday(text)) return text;
  const kept = dropTodayPromise(text, '');
  if (kept) return kept;
  return looksHinglish(text)
    ? 'Aapka order delivery ke final stage me hai. Estimated delivery date aapke tracking page par dikh rahi hai. Kuch aur madad chahiye? 😊'
    : 'Your order is in the final delivery stage, and the estimated delivery date is on your tracking page. Is there anything else I can help with? 😊';
}

// One round to call a tool, one to react to the result, one spare. Beyond that
// the model is looping rather than converging.
const MAX_TOOL_ROUNDS = 3;

// What the model reads before each reply: the last 120 messages, which is the
// whole chat for 99.7% of chats (2026-09-30: 22 of 3,920 are longer). The owner's
// rule (SHIPTRACK_MASTER_RULES.md 5.1, 10) is that the AI reads the whole chat and
// never asks again for what it was told. It used to be 16, and 1 chat in 5 is
// longer than that (a lookup alone is 3 rows). The original took the FIRST 16
// (take: 16 with an ascending sort), so once a conversation passed sixteen
// messages the model was answering from its opening exchange.
const HISTORY_WINDOW = 120;
// The hand-over guards (H1-H6, lookup-guard.ts) still read only the last 16, as
// they always did, so a longer history does not change when they fire.
const GUARD_WINDOW = 16;
// A lookup made in this chat within the last ten minutes is still current; an older one is
// not (see the stale-lookup block in getAIResponse).
const FRESH_LOOKUP_MS = 10 * 60 * 1000;
const STALE_STATUS_NOTE = 'An older lookup: the current stage and date are not known from it. Never quote a stage or date from this result.';

// Said when every model is down, and by the widget route when the AI call
// itself throws. Not a real reply, so it does not count as having talked to the
// customer yet.
export const AI_BUSY_REPLY = 'Sorry, that took longer than expected on my end. Could you send that again?';

// Sent when a model answered with no text at all, until 2026-09-30; a blank
// reply now moves on to the next model (BlankReplyError). Kept so the rows it
// left in old chats do not count as a question the customer is answering.
const EMPTY_REPLY = "I'm here to help! How can I assist you?";

// Appended for the one H4 retry only, never stored or sent every message.
const VERIFIED_NOTE = "(Note from the system, not the customer: this customer's order is already verified - it is in the lookup above. Do not ask for the order ID or phone digits again. Answer their last message using that order. If their message is short or unclear about the order (like \"date\", \"status\", \"kab\", \"order\", \"?\"), answer with the order's current stage, its estimated delivery date and the tracking link; never reply with only a greeting.)";

// Courier name only on the customer's 3rd ask about which courier delivers (owner, 2026-10-02
// 10:55; reply-guards.ts counts the asks and removes a name given too early). Added to the prompt
// only on a turn whose latest messages ask; a panel's own prompt (sites.system_prompt) may still
// say "name the courier if you have it", so the note says it overrides that.
const COURIER_NAME_NOT_YET_NOTE = '\n\nCOURIER NAME (from the system, for this reply only; it overrides any line above about the courier): do not name the courier in this reply. If the courier comes up, for example the customer asks which courier delivers, say in one whole sentence that their order is with our courier partner (in Hinglish: "Aapka order hamare courier partner ke paas hai."). Do not say that you cannot or will not share the name.';
const COURIER_NAME_OK_NOTE = '\n\nCOURIER NAME (from the system, for this reply only): the customer has now asked three times or more which courier delivers their order, so when they ask, name the courier exactly as the order lookup gives it, in one short line. Never guess a courier you were not given.';

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
    .replace(/\*(.+?)\*/g, '$1')        // italic
    .replace(/^[-*•]\s+/gm, '')         // bullet points
    .replace(/^\d+\.\s+/gm, '')         // numbered lists
    .replace(/^#{1,6}\s+/gm, '')        // headers
    .replace(/`(.+?)`/g, '$1')          // inline code
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1: $2') // links → "text: url"
    .trim();
}

export interface ToolCallMeta {
  tool_calls: ChatCompletionMessageToolCall[];
  tool_call_id: string;
  tool_result: string;
}

export interface AIResult {
  content: string;
  toolCallMeta: ToolCallMeta | null;
  escalated?: boolean;
  allFailed?: boolean;
}

export async function getAIResponse(
  conversationId: string,
  siteSystemPrompt: string | null,
  trackerBusinessId: string | null,
  codAvailable?: boolean | null,
  channel: Channel = 'chat',
  siteId?: string | null,
  // Filled with the Brain notes shown for this reply, so the caller can record them for staff,
  // and with the effort level and the tokens it used (effort.ts, chikki-runs.ts).
  usage?: { brain: { id: string; title: string }[]; effort?: EffortUsage }
): Promise<AIResult> {
  // Newest first, then flipped back into reading order. A message the team
  // edited is read as it reads now; one they deleted is left out, so the model
  // never builds on a reply the customer no longer sees.
  const recent = await query<StoredMessage>(
    `SELECT sender, content, metadata, created_at
       FROM (
         SELECT sender, content, metadata, created_at, id
           FROM messages
          WHERE conversation_id = $1
            AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT $2
       ) t
      ORDER BY created_at ASC, id ASC`,
    [conversationId, HISTORY_WINDOW]
  );

  // Saved answers are read fresh on every message, so an edit in Panel
  // Settings takes effect on the very next reply with no redeploy.
  let faqs: SavedAnswer[] = [];
  // The states COD works in, if the owner set some (read fresh like the saved answers).
  let codStates: string | null = null;
  if (siteId) {
    try {
      const c = await queryOne<{ cod_states: string | null }>(`SELECT cod_states FROM sites WHERE id = $1`, [siteId]);
      codStates = c?.cod_states?.trim() || null;
    } catch (err) {
      // Before chat-cod-states.sql is applied the column does not exist yet.
      console.error('[AI] COD states lookup failed:', (err as Error)?.message);
    }
    try {
      const r = await query<SavedAnswer>(
        `SELECT question, answer FROM site_faqs
          WHERE site_id = $1 AND is_enabled = true
          ORDER BY sort_order, created_at`,
        [siteId]
      );
      faqs = r.rows;
    } catch (err) {
      // A broken FAQ read must never take the whole reply down.
      console.error('[AI] saved answers lookup failed:', (err as Error)?.message);
    }
  }
  // Anything we already said here counts — the AI's own replies or a team
  // member's — except the busy apology and drafts the customer never got. Asked
  // of the whole conversation, not the history window, which a long chat
  // scrolls the first greeting out of.
  const replied = await queryOne<{ yes: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM messages
        WHERE conversation_id = $1
          AND sender IN ('ai', 'agent')
          AND deleted_at IS NULL
          AND COALESCE(metadata->>'hidden', 'false') <> 'true'
          AND COALESCE(metadata->>'withheld', '') = ''
          AND btrim(content) <> ''
          AND content <> $2
     ) AS yes`,
    [conversationId, AI_BUSY_REPLY]
  );
  const alreadyReplied = !!replied?.yes;

  // COD only in some states: once we have said where it works, say it once.
  const codAlreadyTold = !!codStates
    && recent.rows.some((r) => (r.sender === 'ai' || r.sender === 'agent') && /\b(cod|cash on delivery)\b/i.test(r.content || ''));

  // The customer's latest messages: when the saved answers are more than fit, the closest go first.
  const askedNow = recent.rows.filter((r) => r.sender === 'visitor').slice(-3).map((r) => r.content || '').join('\n');
  // Courier name only on the customer's 3rd ask (owner, 2026-10-02): counted only when the
  // latest messages ask (no query otherwise); below 3, or unknown, the name stays hidden.
  const visitorAll = recent.rows.filter((r) => r.sender === 'visitor').map((r) => r.content || '');
  const knownCouriers = couriersInLookups(recent.rows);
  const courierAskedNow = asksAboutCourier(visitorAll.slice(-2).join('\n'), knownCouriers);
  const courierAsks: number | null = courierAskedNow ? await courierAsksSoFar(conversationId, visitorAll, knownCouriers) : 0;
  if (courierAskedNow) console.log(`[AI] Courier asked for conv ${conversationId}: ask ${courierAsks ?? 'unknown'}`);
  const courierNote = !courierAskedNow ? ''
    : courierAsks !== null && courierAsks >= COURIER_NAME_FROM_ASK ? COURIER_NAME_OK_NOTE : COURIER_NAME_NOT_YET_NOTE;

  let systemPrompt = buildSystemPrompt(siteSystemPrompt, codAvailable, channel, faqs, codStates, askedNow)
    + (alreadyReplied ? ALREADY_REPLIED_NOTE : '')
    + (codAlreadyTold && codStates ? codAlreadyToldNote(codStates) : '');

  // Build chat history — include tool results stored in metadata
  const chatMessages: ChatCompletionMessageParam[] = [];
  // When each tool result was stored (see UNPROVEN_LOOKUP below).
  const storedAt = new WeakMap<object, number>();
  for (const m of recent.rows) {
    if (m.sender === 'visitor') {
      chatMessages.push({ role: 'user', content: m.content || '' });
    } else if (m.sender === 'ai' || m.sender === 'agent') {
      // Check if this message has a tool call stored in metadata
      if (m.metadata?.tool_calls) {
        chatMessages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.metadata.tool_calls,
        } as ChatCompletionMessageParam);
      } else if (m.sender === 'ai' && !(m.content || '').trim()) {
        // A blank reply stored before BlankReplyError: the customer got
        // nothing, and the model must not take it as a way to answer.
        continue;
      } else {
        chatMessages.push({ role: 'assistant', content: m.content || '' });
      }
    } else if (m.sender === 'tool_result') {
      const t: ChatCompletionMessageParam = {
        role: 'tool',
        tool_call_id: m.metadata?.tool_call_id || 'unknown',
        content: m.content || '',
      };
      storedAt.set(t, new Date(m.created_at).getTime());
      chatMessages.push(t);
    }
  }

  const history = dropOrphanedToolCalls(chatMessages);

  // ── The order this chat already verified ──────────────────────
  // Set by the widget's verify form (order ID + full phone) or by an earlier
  // found lookup in this chat. A long chat scrolls that lookup out of the
  // history window, and a form-verified chat never had one, so the model would
  // ask for the order ID and last 4 all over again. Only this conversation's
  // own verified order, only within its panel, and only when it is missing
  // from the window (it costs tokens on every message).
  // verified_via 'legacy' (chat-verified-legacy.sql) counts too: the owner
  // asked on 2026-09-30 that a customer who verified once is never asked for
  // the order ID and last 4 again (seen live: an "Old check" chat asked a
  // customer who had typed their full phone). That order was found in this
  // same chat from the full phone the customer typed and was already shown
  // here, and /api/widget/resume clears the tag when another browser picks
  // the chat up by phone alone, so it is only ever re-served where it was.
  let verifiedOrderId: string | null = null;
  try {
    const v = await queryOne<{ verified_order_id: string | null }>(
      `SELECT verified_order_id FROM conversations WHERE id = $1`,
      [conversationId]
    );
    verifiedOrderId = v?.verified_order_id || null;
  } catch (err) {
    // Before chat-verified.sql is applied the column does not exist yet.
    console.error('[AI] verified order read failed:', (err as Error)?.message);
  }

  // ── How hard to think (effort.ts, owner 2026-10-01) ───────────
  // A visitor stays at Normal (as before). A verified customer (or an old phone match) gets the
  // level this panel set for how upset they are: the stored frustration score or the quick
  // count over this chat, whichever is higher. A read failure means Normal, never no reply.
  let isCustomer = !!verifiedOrderId;
  let storedScore: number | null = null;
  try {
    const c = await queryOne<{ phone_match_order_id: string | null; health_score: number | null }>(
      `SELECT phone_match_order_id, health_score FROM conversations WHERE id = $1`,
      [conversationId]
    );
    isCustomer = isCustomer || !!c?.phone_match_order_id;
    storedScore = c?.health_score ?? null;
  } catch (err) {
    console.error('[AI] effort score read failed:', (err as Error)?.message);
  }
  let effortSettings: unknown = null;
  if (siteId && isCustomer) {
    try {
      effortSettings = (await queryOne<{ chikki_effort: unknown }>(`SELECT chikki_effort FROM sites WHERE id = $1`, [siteId]))?.chikki_effort ?? null;
    } catch (err) {
      // Before chikki-effort.sql is applied the column does not exist: the defaults stand.
      console.error('[AI] effort settings read failed:', (err as Error)?.message);
    }
  }
  const scoreNow = effortScore(storedScore, recent.rows.map((r) => ({ sender: r.sender, content: r.content || '' })));
  const effortGroup = groupFor(isCustomer, scoreNow);
  const effort = effortFor(effortGroup, effortSettings);
  const plan = EFFORT_PLAN[effort];
  const spent = newEffortUsage(effort, effortGroup, scoreNow);
  if (usage) usage.effort = spent;
  // Counts the tokens of every model call made for this reply.
  const track = <R extends { model?: string; usage?: unknown }>(res: R): R => {
    const u = (res?.usage || {}) as { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    spent.calls++;
    spent.promptTokens += u.prompt_tokens || 0;
    spent.completionTokens += u.completion_tokens || 0;
    spent.reasoningTokens += u.completion_tokens_details?.reasoning_tokens || 0;
    if (res?.model) spent.model = res.model;
    return res;
  };
  // Turned off for the rest of this reply when a thinking call answers blank or too slowly.
  let thinkingOn = plan.thinking;
  if (effort !== 'normal') console.log(`[AI] Effort ${effort} (${effortGroup}, score ${scoreNow}) for conv ${conversationId}`);

  // The delay ladder (delay-ladder.ts): for a verified customer asking about timing, the
  // reason to give is chosen here from how late the order is and how often they have
  // asked, so it is never the same sentence again and never made up by the model. Not
  // for a cancelled, returned or delivered order.
  if (verifiedOrderId) {
    try {
      const lastVisitor = [...recent.rows].reverse().find((r) => r.sender === 'visitor')?.content || '';
      if (isDelayAsk(lastVisitor)) {
        const facts = await loadOrderFacts(verifiedOrderId, trackerBusinessId, 'verified');
        // The ladder counts from the order's own date (facts.eta is the revised one once the
        // page shows the order late) and starts at the step the page shows (journey.ts "Late orders").
        const ladderEta = facts?.eta_original || facts?.eta;
        if (facts && facts.mode === 'normal' && !facts.delivered && ladderEta) {
          const daysToEta = (Date.parse(ladderEta) - Date.now()) / 86_400_000;
          if (!Number.isNaN(daysToEta)) {
            const stage = delayStage({ daysToEta, asks: delayAsksIn(recent.rows), pageStage: facts.late?.stage });
            if (stage > 0) {
              systemPrompt += delayNote(stage);
              console.log(`[AI] Delay ladder stage ${stage} for conv ${conversationId}`);
            }
          }
        }
      }
    } catch (err) {
      console.error('[AI] delay ladder failed:', (err as Error)?.message);
    }
  }

  // The Brain (brain.ts): the owner's notes that fit what the customer just wrote, this
  // panel's and the common ones, for this kind of chat (verified or not). Read fresh on every
  // message, like the saved answers, so an edit in Panel Settings is live on the next reply.
  // Which notes were shown is handed back through `usage` for the inbox. Never stops a reply.
  if (siteId) {
    try {
      const notes = await query<BrainNote>(
        `SELECT id, kind, title, body, topics, always, audience, sort_order
           FROM brain_notes
          WHERE is_enabled = true AND (site_id = $1 OR site_id IS NULL)
          ORDER BY sort_order, created_at`,
        [siteId]
      );
      const asked = recent.rows.filter((r) => r.sender === 'visitor').slice(-3).map((r) => r.content || '').join('\n');
      const chosen = selectNotes(notes.rows, asked, undefined, undefined, !!verifiedOrderId);
      systemPrompt += brainSection(chosen);
      if (usage) usage.brain = chosen.filter((n) => n.id).map((n) => ({ id: n.id as string, title: n.title }));
      if (chosen.length) {
        // Counters for the Brain card; a failure here must never touch the reply.
        query(`UPDATE brain_notes SET shown_count = shown_count + 1, last_shown_at = now() WHERE id = ANY($1::uuid[])`, [chosen.filter((n) => n.id).map((n) => n.id)])
          .catch((err) => console.error('[AI] brain counters failed:', (err as Error)?.message));
      }
    } catch (err) {
      // Before chat-brain.sql / chat-brain-usage.sql is applied the table or a column is missing.
      console.error('[AI] brain read failed:', (err as Error)?.message);
    }
  }

  // How our team handles this situation (brain-examples.ts): 1-2 approved replies from the
  // store's own team to a customer in the same situation (refund, wrong tracking, anger...), as a
  // guide to tone. Only this panel's. Never stops a reply.
  if (siteId) {
    try {
      const said = recent.rows.filter((r) => r.sender === 'visitor').slice(-3).map((r) => r.content || '');
      const situations = detectSituations(said);
      if (situations.length) {
        const ex = await query<Example>(
          `SELECT id, situation, customer_said, team_replied FROM brain_examples
            WHERE site_id = $1 AND status = 'approved' AND is_enabled = true AND situation = ANY($2::text[])
            ORDER BY created_at DESC LIMIT 40`,
          [siteId, situations]
        );
        const chosen = pickExamples(ex.rows, situations, plan.examples);
        systemPrompt += examplesSection(chosen);
        if (usage) usage.brain.push(...chosen.filter((e) => e.id).map((e) => ({ id: e.id as string, title: `Team example: ${e.situation.replace(/_/g, ' ')}` })));
        if (chosen.length) {
          query(`UPDATE brain_examples SET shown_count = shown_count + 1, last_shown_at = now() WHERE id = ANY($1::uuid[])`, [chosen.map((e) => e.id)])
            .catch((err) => console.error('[AI] example counters failed:', (err as Error)?.message));
        }
      }
    } catch (err) {
      // Before chat-brain-examples.sql is applied the table is missing.
      console.error('[AI] team examples read failed:', (err as Error)?.message);
    }
  }

  // Last, so no Brain note or team example after it can name the courier too early.
  systemPrompt += courierNote;

  // A found lookup_order result in the window that was not proof (see
  // isProvenLookup) is swapped for UNPROVEN_LOOKUP before the model sees it,
  // and its orders do not count as known. Also kept: a result holding only
  // this chat's verified order (the re-read below stores order ID only).
  const callArgs = new Map<string, { name: string; args: string }>();
  for (let i = 0; i < history.length; i++) {
    const m = history[i] as ChatCompletionMessageParam & { tool_calls?: ChatCompletionMessageToolCall[] };
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) callArgs.set(tc.id, { name: tc.function?.name, args: tc.function?.arguments });
      continue;
    }
    if (m.role !== 'tool') continue;
    const call = callArgs.get(m.tool_call_id);
    if (call?.name !== 'lookup_order') continue;
    if (isProvenLookup(call.args) && (storedAt.get(m) ?? 0) >= VERIFICATION_DEPLOYED_AT) continue;
    let r: { found?: boolean; orders?: { order_id?: string }[] } | null = null;
    try { r = JSON.parse(String(m.content || '')); } catch { continue; }
    if (r?.found !== true) continue;
    const onlyVerified = !!verifiedOrderId && Array.isArray(r.orders) && r.orders.length > 0
      && r.orders.every((o) => o?.order_id === verifiedOrderId);
    if (!onlyVerified) history[i] = { ...m, content: UNPROVEN_LOOKUP };
  }

  // An order's stage and date change every day, and a lookup stored days ago still said
  // "Order Placed" for an order that was In Transit (2026-10-01: a customer was told their
  // order had not moved, from a lookup made on 24 September). So no old lookup is ever
  // read as the order's status:
  //  - the verified order's results are replaced by a fresh read of it (one query);
  //  - any other found result older than FRESH_LOOKUP_MS loses its status and date.
  let verifiedFresh: Awaited<ReturnType<typeof lookupVerifiedOrder>> | null = null;
  if (verifiedOrderId) verifiedFresh = await lookupVerifiedOrder(verifiedOrderId, trackerBusinessId || null);
  for (let i = 0; i < history.length; i++) {
    const m = history[i] as ChatCompletionMessageParam & { tool_call_id?: string };
    if (m.role !== 'tool' || callArgs.get(m.tool_call_id || '')?.name !== 'lookup_order') continue;
    let r: { found?: boolean; orders?: Record<string, unknown>[] } | null = null;
    try { r = JSON.parse(String(m.content || '')); } catch { continue; }
    if (r?.found !== true || !Array.isArray(r.orders) || !r.orders.length) continue;
    const onlyVerified = !!verifiedOrderId && r.orders.every((o) => o?.order_id === verifiedOrderId);
    if (onlyVerified && verifiedFresh?.found) {
      history[i] = { ...m, content: JSON.stringify(verifiedFresh) };
    } else if (Date.now() - (storedAt.get(m) ?? 0) > FRESH_LOOKUP_MS) {
      history[i] = {
        ...m,
        content: JSON.stringify({
          ...r,
          orders: r.orders.map((o) => ({ ...o, status: undefined, estimated_delivery: undefined, status_note: STALE_STATUS_NOTE })),
        }),
      };
    }
  }

  // Every order a found lookup in the window returned: its ID and tracking ID
  // (normalised with normId). verifiedIds: the same two for the verified order.
  const knownOrderIds = new Set<string>();
  const verifiedIds = new Set<string>(verifiedOrderId ? [normId(verifiedOrderId)] : []);
  const noteFoundOrders = (content: unknown) => {
    let r: { found?: boolean; orders?: { order_id?: string; tracking_id?: string | null }[] } | null = null;
    try { r = JSON.parse(String(content || '')); } catch { return false; }
    if (r?.found !== true || !Array.isArray(r.orders)) return false;
    let hasVerified = false;
    for (const o of r.orders) {
      if (o?.order_id) knownOrderIds.add(normId(o.order_id));
      if (o?.tracking_id) knownOrderIds.add(normId(o.tracking_id));
      if (verifiedOrderId && o?.order_id === verifiedOrderId) {
        hasVerified = true;
        if (o.tracking_id) verifiedIds.add(normId(o.tracking_id));
      }
    }
    return hasVerified;
  };
  let verifiedInView = false;
  for (const m of history) {
    if (m.role === 'tool' && noteFoundOrders(m.content)) verifiedInView = true;
  }
  let verifiedResult: Awaited<ReturnType<typeof lookupVerifiedOrder>> | null = verifiedFresh;
  if (verifiedOrderId && !verifiedInView) {
    const verified = verifiedFresh ?? await lookupVerifiedOrder(verifiedOrderId, trackerBusinessId || null);
    verifiedResult = verified;
    if (verified.found) {
      noteFoundOrders(JSON.stringify(verified));
      verifiedInView = true;
      // Never stored, and not in guardRows, so the guard never takes it for
      // a lookup the customer asked for.
      history.unshift(
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'verified_order',
            type: 'function',
            function: { name: 'lookup_order', arguments: JSON.stringify({ order_id: verifiedOrderId }) },
          }],
        },
        { role: 'tool', tool_call_id: 'verified_order', content: JSON.stringify(verified) },
      );
    }
  }

  // Since 2026-09-28 the model often answers an order ID and last 4 sent in
  // separate messages by asking for them again, and nothing ever broke that
  // loop. When the customer has typed both and we have not looked them up yet,
  // the first round must call lookup_order, only with values they typed, and a
  // reply that still is not a real lookup goes to a person (see lookup-guard.ts).
  // The busy apology and the empty-reply filler ask for nothing, so they must
  // not hide the question the customer is still answering.
  const guardRows = recent.rows.slice(-GUARD_WINDOW).filter((r) => r.content !== AI_BUSY_REPLY && r.content !== EMPTY_REPLY);
  const pending = findPendingLookup(guardRows);
  // Per model: runWithModel resets them, and executeTool records cached
  // lookups again, so a fallback model is judged on what its own run used.
  let typedLookupRan = false;
  const lookupOutcomes: LookupOutcome[] = [];
  // Set while the H4 retry runs: it may only restate orders already found.
  let h4Retry = false;
  // Unlike the two above, not per model: once escalate_to_human has set the
  // chat to human_needed, a fallback model after a blank reply must still
  // report the escalation, or email sends the draft it should hold.
  let escalatedThisRequest = false;

  // When a model dies partway through a conversation we retry the whole exchange
  // on the next model, which would otherwise re-run tools that already had side
  // effects — escalating twice, or writing the category again. Results are cached
  // per request so a mid-conversation switch replays them instead.
  const toolCache = new Map<string, { payload: unknown; persist: boolean; escalated?: boolean; lookup?: LookupOutcome & { typed: boolean } }>();

  const executeTool = async (tc: ChatCompletionMessageToolCall) => {
    const cacheKey = tc.function.name + ':' + (tc.function.arguments || '');
    let result = toolCache.get(cacheKey);
    if (!result) {
      result = await runTool(tc);
      toolCache.set(cacheKey, result);
    }
    if (result.escalated) escalatedThisRequest = true;
    if (result.lookup) {
      lookupOutcomes.push(result.lookup);
      if (result.lookup.typed) typedLookupRan = true;
    }
    return result;
  };

  const runTool = async (tc: ChatCompletionMessageToolCall) => {
    const name = tc.function.name;
    let args: Record<string, string> = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* model sent junk */ }

    if (name === 'categorize_conversation') {
      const valid = ['wrong_tracking', 'refund', 'cancellation', 'others'];
      if (valid.includes(args.category)) {
        await query(
          `UPDATE conversations SET category = $1, updated_at = now() WHERE id = $2`,
          [args.category, conversationId]
        );
        console.log(`[AI] Categorized conv ${conversationId} as: ${args.category}`);
      }
      return { payload: { success: true }, persist: false };
    }

    if (name === 'escalate_to_human') {
      // Only a VERIFIED customer goes to Needs you (owner, 2026-09-30). A visitor stays
      // in Visitors: the model is told to ask for the order ID and phone instead.
      if (!(await chatIsVerified(conversationId))) {
        console.log(`[AI] Escalation refused for conv ${conversationId}: not verified`);
        return {
          payload: {
            success: false,
            message: 'This customer has not verified an order yet, so the chat cannot be handed to the team and nobody will take it over. Do not say a team member will help. Ask for the order ID and the phone number on the order, both, and say the team can only help once the order is verified.',
          },
          persist: true,
        };
      }
      console.log(`[AI] Escalation for conv ${conversationId}:`, args.reason);
      // No phone is collected any more — the colleague answers in this chat,
      // nobody calls the customer, so there is nothing to store here.
      await query(
        `UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1`,
        [conversationId]
      );
      return {
        payload: { success: true, reason: args.reason },
        persist: true,
        escalated: true,
      };
    }

    if (name === 'lookup_order') {
      // A forced call must not guess, and the model does fill in the wrong
      // values even when forced (seen live: order_id "1234", an empty phone
      // after "#999999" then "1234"). The customer typed both, so look up the
      // pair the guard read from their messages instead; lookupOrder still
      // needs both to match. The call is rewritten to what actually ran, so
      // the stored exchange marks this pair as tried and repeat misses reach H3.
      if (pending && !typedByVisitor(args, guardRows)) {
        console.log(`[AI] Guard used the typed pair for conv ${conversationId}`);
        args = { order_id: pending.identifier, phone_number: pending.phone };
        tc.function.arguments = JSON.stringify(args);
      }
      // ३३३५ is how some customers type 3335, and the model copies it as is.
      // The model sometimes sends the phone as a JSON number.
      for (const k of ['order_id', 'phone_number'] as const) {
        if (args[k] != null) args[k] = normaliseDigits(String(args[k]));
      }
      // The order this chat already proved it owns. The model copies the
      // injected call above (order ID only) to refresh the status, and
      // lookupOrder would answer needs_verification and make it ask the
      // verified customer for their digits again.
      if (verifiedOrderId && verifiedIds.has(normId(args.order_id))) {
        verifiedResult = verifiedResult || await lookupVerifiedOrder(verifiedOrderId, trackerBusinessId || null);
        if (verifiedResult.found) {
          console.log(`[AI] Verified order re-read for conv ${conversationId}`);
          return { payload: verifiedResult, persist: true, lookup: { found: true, needs_verification: false, typed: true } };
        }
      }
      // The H4 retry is told not to ask for digits, so it must not look up an
      // order nobody proved in this chat with digits it did not collect now.
      if (h4Retry && !knownOrderIds.has(normId(args.order_id))) {
        const refused = {
          found: false,
          needs_verification: true,
          message: 'Only the order already verified in this chat can be looked up now. Answer about that order.',
        };
        return { payload: refused, persist: false, lookup: { ...refused, typed: false } };
      }
      // The order only: the phone number the customer typed stays out of the logs.
      console.log(`[AI] Order lookup for conv ${conversationId}: order ${String(args.order_id ?? '')}`);
      // Guessing limit (the same counters as the verify form): one order or one
      // phone number can only be tried so many times a day, however many chats
      // the caller opens. A match gives the attempt back.
      const limitScope = String(trackerBusinessId || siteId || '');
      const oid = normId(args.order_id);
      const ph10 = normalizePhone(args.phone_number);
      const limitKeys: [string, { max: number; windowMs: number }][] = oid && ph10 && /^\d{10}$/.test(ph10)
        ? [[`co:${limitScope}:${oid}`.slice(0, 200), LIMITS.order], [`cp:${limitScope}:${ph10}`.slice(0, 200), LIMITS.phone]]
        : [];
      if (limitKeys.some(([k, l]) => isLimited(k, l.max))) {
        console.log(`[AI] Lookup limit reached for conv ${conversationId}`);
        const limited = {
          found: false,
          needs_verification: true,
          message: 'Too many attempts were made for this order or phone number. Do not try again. Tell the customer you are passing this to the team, and call escalate_to_human.',
        };
        return { payload: limited, persist: false, lookup: { ...limited, typed: false } };
      }
      for (const [k, l] of limitKeys) reserve(k, l.windowMs);
      const result = await lookupOrder(args, trackerBusinessId || null);
      if (result.found) for (const [k] of limitKeys) release(k);
      const needsVerification = 'needs_verification' in result && !!result.needs_verification;
      // Only a lookup that reached the database counts as having looked.
      const lookup = { found: result.found, needs_verification: needsVerification, typed: !needsVerification, order_id: args.order_id };

      // A successful lookup is the first point at which we actually know who we
      // are talking to, so stop calling them "Visitor" in the inbox. Only the
      // real order holder's name is used — never anything the visitor typed.
      const confirmed = result.found ? result.orders[0] : null;
      if (result.found) {
        for (const o of result.orders) {
          knownOrderIds.add(normId(o.order_id));
          if (o.tracking_id) knownOrderIds.add(normId(o.tracking_id));
        }
      }
      if (confirmed?.customer_name) {
        const realName = String(confirmed.customer_name).replace(/\s*\.\s*$/, '').trim();
        if (realName) {
          try {
            await query(
              `UPDATE conversations SET visitor_name = $1, updated_at = now() WHERE id = $2`,
              [realName, conversationId]
            );
            console.log(`[AI] Identified conv ${conversationId} as: ${realName}`);
          } catch (e) {
            console.error('[AI] could not set visitor name:', (e as Error).message);
          }
        }
      }

      // Proved in this chat: moves it from Visitors to Customers in the inbox
      // and keeps this order in view for the rest of the chat. The first order
      // proved stays the verified one: a second order looked up later does not
      // replace it (nor a form-verified one, whose verified_via says 'form').
      // 'chat_phone' = order ID + the FULL phone typed in the chat (since 2026-09-30),
      // the same proof as the form; older chat proofs ('chat') were a last 4.
      // A 'legacy' tag was never proof, so a real proof replaces it. Every
      // expression in SET sees the old row, so the CASEs agree.
      // customer_key (chat-customer-key.sql) follows the verified order, for
      // widget chats only: it groups this customer's chats in the inbox. A
      // chat proved with the last 4 never takes over an older chat, though;
      // only the widget form (full phone) does that.
      if (confirmed?.order_id) {
        try {
          await query(
            `UPDATE conversations
                SET verified_order_id = CASE WHEN verified_order_id IS NULL OR verified_via = 'legacy'
                                             THEN $1 ELSE verified_order_id END,
                    verified_at = CASE WHEN verified_order_id IS NULL OR verified_via = 'legacy'
                                       THEN now() ELSE verified_at END,
                    verified_via = CASE WHEN verified_order_id IS NULL OR verified_via = 'legacy'
                                        THEN 'chat_phone' ELSE verified_via END,
                    customer_key = CASE WHEN (verified_order_id IS NULL OR verified_via = 'legacy')
                                             AND source = 'chat'
                                        THEN ${customerKeyForOrderSql('$1', 'conversations.site_id')}
                                        ELSE customer_key END
              WHERE id = $2`,
            [confirmed.order_id, conversationId]
          );
        } catch (e) {
          console.error('[AI] could not mark conversation verified:', (e as Error).message);
        }
      }

      return { payload: result, persist: true, lookup };
    }

    return { payload: { error: `Unknown tool: ${name}` }, persist: false };
  };

  // The messages the last runWithModel ended on (its tool exchange included),
  // which the H4 retry carries on from.
  let lastRunMessages: ChatCompletionMessageParam[] = [];
  // A reply may only name an order found in this chat or one the customer typed (order-mention.ts).
  const customerTyped = recent.rows.filter((r) => r.sender === 'visitor').map((r) => r.content || '').join('\n');
  const withRightOrderNumbers = (text: string): string => {
    const ids = new Set<string>(verifiedOrderId ? [verifiedOrderId] : []);
    for (const m of lastRunMessages) {
      if (m.role !== 'tool') continue;
      try {
        const r = JSON.parse(String(m.content || ''));
        if (r?.found && Array.isArray(r.orders)) for (const o of r.orders) if (o?.order_id) ids.add(String(o.order_id));
      } catch { /* not a lookup result */ }
    }
    const fixed = fixOrderMentions(text, Array.from(ids), customerTyped);
    if (fixed.changed) console.log(`[AI] Wrong order number corrected for conv ${conversationId}`);
    return fixed.text;
  };
  // reply-guards.ts: no address the customer typed is repeated back, and a customer whose
  // Delivered order did not reach them is asked once to check with family / neighbours / security.
  const visitorTexts = recent.rows.filter((r) => r.sender === 'visitor').map((r) => r.content || '');
  const agentTexts = recent.rows.filter((r) => r.sender === 'ai' || r.sender === 'agent').map((r) => r.content || '');
  // What the form guard did in the latest withReplyGuards call (formFollowUp below reads it).
  let formDropped = false, formEmptied = false;
  // ... and the dispute-advice guard (disputeFollowUp below).
  let disputeDropped = false;
  const withReplyGuards = (text: string): string => {
    let out = text;
    // Chikki never sends or mentions a refund / return form, and never any Google Form link (owner,
    // 2026-10-02, Q7; link-mask.ts): such sentences are dropped, and a reply left empty becomes
    // "our team will help you here in this chat" - never sent on its own: formFollowUp hands a verified
    // chat to the team and asks a visitor for the order ID + phone (review fix 2026-10-02).
    const form = dropFormMentions(out, looksHinglish(visitorTexts.slice(-2).join('\n')));
    formDropped = form.changed; formEmptied = form.emptied;
    if (form.changed) { out = form.text; console.log(`[AI] Form mention removed for conv ${conversationId}`); }
    // Chikki never advises a chargeback, a bank / UPI dispute or complaint, a cyber-crime or police
    // report or a consumer forum (the store's first rule; seen live 1-3 Oct on paid-but-no-order
    // chats; dispute-advice.ts): such sentences are dropped and disputeFollowUp hands a verified chat
    // to the team / asks a visitor for the order ID + phone. Emptied: the hand-over line, so a
    // model that escalated itself still sends something.
    const dispute = dropDisputeAdvice(out);
    disputeDropped = dispute.changed;
    if (dispute.changed) { out = dispute.emptied ? handOverReply(guardRows) : dispute.text; console.log(`[AI] Dispute advice removed for conv ${conversationId}`); }
    const echo = dropAddressEcho(out, visitorTexts.slice(-8));
    if (echo.changed) { out = echo.text; console.log(`[AI] Address echo removed for conv ${conversationId}`); }
    let delivered = false;
    const couriers: string[] = [];
    for (const m of lastRunMessages) {
      if (m.role !== 'tool') continue;
      try {
        const r = JSON.parse(String(m.content || ''));
        if (!r?.found || !Array.isArray(r.orders)) continue;
        for (const o of r.orders as { status?: string; courier?: string | null }[]) {
          if (String(o?.status || '').toLowerCase() === 'delivered') delivered = true;
          if (o?.courier) couriers.push(String(o.courier));
        }
      } catch { /* not a lookup result */ }
    }
    // The courier is named only on the customer's 3rd ask about which courier delivers (owner,
    // 2026-10-02; courierAsks above). Before that, or when the count could not be read, the name
    // becomes "our courier partner" and a "Courier: X" line is dropped.
    const courier = withoutUnaskedCourier(out, visitorTexts.slice(-2).join('\n'), [...couriers, ...knownCouriers], courierAsks);
    if (courier.changed) { out = courier.text; console.log(`[AI] Unasked courier name removed for conv ${conversationId}`); }
    const around = withCheckAround(out, { customerLatest: visitorTexts.slice(-2).join('\n'), orderDelivered: delivered, earlierAgentReplies: agentTexts });
    if (around.changed) { out = around.text; console.log(`[AI] Check-around line added for conv ${conversationId}`); }
    // The model retypes the tracking link and sometimes changes a character (6 dead links in the
    // 1-3 Oct chats; owner 2026-10-03): every tracking link in the reply becomes the exact link from
    // the lookup results of this chat and the verified order (reply-guards.ts withExactTrackingLinks).
    const knownLinks: string[] = [];
    const addLinks = (r: unknown) => {
      const j = r as { found?: boolean; orders?: { tracking_link?: unknown }[] } | null;
      if (j?.found && Array.isArray(j.orders)) for (const o of j.orders) if (typeof o?.tracking_link === 'string' && o.tracking_link) knownLinks.push(o.tracking_link);
    };
    for (const m of lastRunMessages) {
      if (m.role !== 'tool') continue;
      try { addLinks(JSON.parse(String(m.content || ''))); } catch { /* not a lookup result */ }
    }
    if (verifiedResult) addLinks(verifiedResult);
    const links = withExactTrackingLinks(out, knownLinks);
    if (links.changed) { out = links.text; console.log(`[AI] Tracking link corrected (${links.fixed}) for conv ${conversationId}`); }
    // A link copied from ChatGPT or an ad earlier in the chat (utm_source=chatgpt.com ...) loses that
    // tag (reply-guards.ts stripLinkJunk, owner 2026-10-05).
    const junk = stripLinkJunk(out);
    if (junk.changed) { out = junk.text; console.log(`[AI] Link tracking parameters removed for conv ${conversationId}`); }
    return out;
  };

  // extra: messages after the history (only the H4 retry passes any); that
  // retry is never forced, the forced lookup already ran in the first run.
  const runWithModel = async (model: string, extra: ChatCompletionMessageParam[] = []): Promise<AIResult> => {
    // A verified customer's first reply is told so up front; the model otherwise often asks
    // them for the order ID and phone again and only the H4 retry below sets it right (or a
    // person takes over: seen 2026-10-01 on a customer who only asked "Date").
    const verifiedTail: ChatCompletionMessageParam[] = verifiedOrderId && verifiedInView && !extra.length
      ? [{ role: 'user', content: VERIFIED_NOTE }] : [];
    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }, ...history, ...verifiedTail, ...extra];
    lastRunMessages = messages;
    let toolCallMeta: ToolCallMeta | null = null;
    let escalated = escalatedThisRequest;
    let nudged = false;
    typedLookupRan = false;
    lookupOutcomes.length = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Only the first round is forced, so the model can still react to the
      // result (or escalate) in the rounds after it. No extra API call.
      const forced = !!pending && round === 0 && !extra.length;
      const params = {
        model,
        messages,
        tools: [ORDER_LOOKUP_TOOL, ESCALATE_TOOL, CATEGORIZE_TOOL],
        max_tokens: MAX_REPLY_TOKENS,
      };
      const ask = (toolChoice: ChatCompletionToolChoiceOption) => (thinkingOn
        ? getClient().chat.completions.create(withThinking(model, { ...params, tool_choice: toolChoice }, plan.maxTokens), { timeout: THINKING_TIMEOUT_MS, maxRetries: 0 })
        : getClient().chat.completions.create(withoutThinking(model, { ...params, tool_choice: toolChoice }))
      ).then((res) => { if (thinkingOn) spent.thinking = true; return track(res); });
      let response;
      try {
        response = await ask(forced ? { type: 'function', function: { name: 'lookup_order' } } : 'auto');
      } catch (err) {
        // A provider that does not take a named tool_choice answers 400. Ask
        // unforced rather than lose the model; H1 still covers a reply without
        // a lookup.
        if (!forced || (err as { status?: number })?.status !== 400) throw err;
        console.log(`[AI] ${model} refused a forced lookup_order, asking unforced`);
        response = await ask('auto');
      }

      const message = response.choices[0]?.message;
      const toolCalls = message?.tool_calls || [];

      // Why a lookup did not happen, without logging what the customer wrote.
      if ((!toolCalls.length && !message?.content?.trim())
        || (forced && !toolCalls.some((tc) => tc.function?.name === 'lookup_order'))) {
        console.log(`[AI] no lookup: conv=${conversationId} model=${response.model} finish=${response.choices[0]?.finish_reason} usage=${response.usage?.prompt_tokens}/${response.usage?.completion_tokens}`);
      }

      if (!toolCalls.length) {
        // Whitespace is no reply: stored, it showed as a blank bubble.
        const content = stripMarkdown(message?.content || '');
        if (!content) throw new BlankReplyError(model, response.choices[0]?.finish_reason);
        return { content, toolCallMeta, escalated };
      }

      // Kept without the text the model wrote next to its tool calls: the customer never sees
      // that text, and it is often cut where the tool call starts. Left in, the next round took
      // it as already said and sent only a short "the team will update you", or carried on
      // mid-word ("egi. Aapko jawab..."): live tests 2026-10-01, more often with thinking on.
      messages.push({ ...(message as ChatCompletionMessageParam & object), content: null } as ChatCompletionMessageParam);

      for (const tc of toolCalls) {
        const { payload, persist, escalated: didEscalate } = await executeTool(tc);
        if (didEscalate) escalated = true;
        if (persist) {
          toolCallMeta = {
            tool_calls: toolCalls,
            tool_call_id: tc.id,
            tool_result: JSON.stringify(payload),
          };
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(payload) });
      }

      if (!nudged) {
        nudged = true;
        messages.push({
          role: 'user',
          content: 'IMPORTANT: Reply in plain conversational text only. No asterisks, no bullet points, no bold, no JSON. Just talk naturally like a human.',
        });
      }
    }

    // Spent the tool budget — take the tools away and ask plainly for prose.
    const closing = track(await (thinkingOn
      ? getClient().chat.completions.create(withThinking(model, { model, messages }, plan.maxTokens), { timeout: THINKING_TIMEOUT_MS, maxRetries: 0 })
      : getClient().chat.completions.create(withoutThinking(model, { model, messages, max_tokens: MAX_REPLY_TOKENS }))));
    const content = stripMarkdown(closing.choices[0]?.message?.content || '');
    if (!content) throw new BlankReplyError(model, closing.choices[0]?.finish_reason);
    return { content, toolCallMeta, escalated };
  };

  // The same status change escalate_to_human makes, with a fixed reply that
  // says nothing about any order. Callers treat it as an escalation: the widget
  // stops answering, and email holds the draft for the team.
  const handOver = async (why: 'H1' | 'H3' | 'H4' | 'H5' | 'H6' | 'FORM' | 'DISPUTE', result: AIResult): Promise<AIResult> => {
    // A visitor is never handed to the team (owner, 2026-09-30): the chat stays as it
    // is and the customer is told what is still needed.
    if (!(await chatIsVerified(conversationId))) {
      console.log(`[AI] Guard ${why} for conv ${conversationId}: not verified, stays in Visitors`);
      return { content: verifyAgainReply(guardRows), toolCallMeta: result.toolCallMeta };
    }
    await query(
      `UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1`,
      [conversationId]
    );
    console.log(`[AI] Guard hand-over for conv ${conversationId}: ${why}`);
    return { content: handOverReply(guardRows), toolCallMeta: result.toolCallMeta, escalated: true };
  };

  // FORM (review fix 2026-10-02): after the form guard dropped something from a reply that did not
  // escalate. Its "our team will help you here" line never goes out on its own: nothing else hands
  // the chat over for a return / exchange question, so the customer would wait for nobody.
  //   - verified, reply emptied: handed to the team like H1-H6 (Needs you; the routes add their lines).
  //   - not verified (a visitor is never told the team will reply, rulebook 2.9): asked for the order
  //     ID + phone, in place of the emptied reply, or after what is left when it no longer asks.
  // Answers the hand-over to return, or null to go on (r.content may have changed).
  const formFollowUp = async (r: AIResult): Promise<AIResult | null> => {
    if (r.escalated || !formDropped) return null;
    const emptied = formEmptied;
    if (await chatIsVerified(conversationId)) return emptied ? handOver('FORM', r) : null;
    const ask = FORM_VERIFY_ASK[looksHinglish(visitorTexts.slice(-2).join('\n')) ? 'hinglish' : 'en'];
    if (emptied) r.content = ask;
    else if (!reasksForOrderDetails(r.content, Array.from(knownOrderIds)).orderId) r.content = `${r.content}\n\n${ask}`;
    else return null;
    console.log(`[AI] Guard FORM for conv ${conversationId}: not verified, asked for the order ID and phone`);
    return null;
  };

  // DISPUTE (2026-10-03, chat report): the dispute-advice guard dropped part or all of a reply that
  // did not escalate. Whatever is left is not sent: a verified chat goes to the team with the fixed
  // hand-over line (money was taken and only a person can find the payment); a visitor is asked
  // for the order ID + phone (rules 5.6 and 2.9), both by handOver.
  const disputeFollowUp = async (r: AIResult): Promise<AIResult | null> => {
    if (r.escalated || !disputeDropped) return null;
    return handOver('DISPUTE', r);
  };

  // Asking for the order ID or last 4 once the order is known, unless the
  // customer's latest message is about some other order.
  const latestVisitor = [...recent.rows].reverse().find((r) => r.sender === 'visitor')?.content || '';
  const asksAgain = (reply: string) => {
    const ask = reasksForOrderDetails(reply, Array.from(knownOrderIds));
    // ... or the phone number, which the verified chat already proved (seen live 2026-10-01).
    return (ask.orderId || ask.last4 || reasksForPhone(reply)) && !mentionsAnotherOrder(latestVisitor, Array.from(knownOrderIds));
  };
  // H4 is for the verified order only. It stays off while the customer is
  // busy with some other order: a lookup this turn that did not find one (a
  // typo in the second order's ID is theirs to fix), or, when nothing was
  // found this turn, our last reply already asking for another order's details
  // and the customer answering it ("1400", then "5678").
  const h4Applies = () => {
    const foundNow = lookupOutcomes.some((o) => o.found === true);
    if (lookupOutcomes.some((o) => o.found !== true)) return false;
    if (!foundNow && lastReplyReasked(guardRows, Array.from(knownOrderIds))) return false;
    return verifiedInView || foundNow;
  };

  // Max effort (self-check.ts): the finished reply is read once more against the locked rules
  // and the order facts, and fixed before it goes. The fix runs through the same guards. A
  // failed, slow or unusable check leaves the reply as it was.
  const finish = async (r: AIResult, model: string): Promise<AIResult> => {
    if (!plan.selfCheck || !(r.content || '').trim()) return r;
    try {
      const facts = latestOrderFacts(lastRunMessages.filter((m) => m.role === 'tool').map((m) => String(m.content || '')));
      // The same conversation the reply was written from, the reply, then the check note.
      const messages: ChatCompletionMessageParam[] = [...lastRunMessages, { role: 'assistant', content: r.content }, { role: 'user', content: CHECK_NOTE }];
      spent.draft = r.content;
      const res = track(await getClient().chat.completions.create(
        withoutThinking(model, { model, messages, tools: [ORDER_LOOKUP_TOOL, ESCALATE_TOOL, CATEGORIZE_TOOL], tool_choice: 'none', max_tokens: SELF_CHECK_MAX_TOKENS }),
        { timeout: SELF_CHECK_TIMEOUT_MS, maxRetries: 0 }
      ));
      spent.checked = true;
      const out = parseCheck(res.choices?.[0]?.message?.content, r.content, `${facts}\n${customerTyped}`);
      if (!out.changed) {
        if (out.reason !== 'ok') console.log(`[AI] Self-check for conv ${conversationId}: kept the draft (${out.reason})`);
        return r;
      }
      let fixed = withReplyGuards(withRightOrderNumbers(withoutTodayPromise(stripMarkdownEmphasis(stripMarkdown(out.text)))));
      // A fix that brings a form mention back is refused: the draft already went through formFollowUp.
      if (formDropped) {
        console.log(`[AI] Self-check for conv ${conversationId}: the fix mentioned a form, the draft goes`);
        return r;
      }
      if (alreadyReplied) fixed = dropRepeatedIntroduction(fixed);
      if (!fixed.trim()) return r;
      spent.changed = true;
      console.log(`[AI] Self-check fixed the reply for conv ${conversationId}`);
      return { ...r, content: fixed };
    } catch (err) {
      console.error(`[AI] Self-check failed for conv ${conversationId}, the reply goes as it was:`, (err as Error)?.message);
      return r;
    }
  };

  let lastErr: unknown = null;
  for (const model of attemptOrder()) {
    let result: AIResult;
    try {
      result = await runWithModel(model);
    } catch (err) {
      // A thinking call that answered blank (thinking used all the room) or too slowly:
      // the same model once more without thinking, before any fallback.
      if (thinkingOn && (err instanceof BlankReplyError || /timed? ?out/i.test(String((err as Error)?.message)))) {
        console.log(`[AI] ${model} thinking failed (${(err as Error)?.message}), again without thinking`);
        thinkingOn = false;
        spent.thinking = false;
        try {
          result = await runWithModel(model);
        } catch (err2) {
          lastErr = err2;
          console.error(`[AI] ${model} failed:`, (err2 as { status?: number })?.status || '', (err2 as Error)?.message);
          if (!isRetryable(err2)) break;
          continue;
        }
      } else {
        lastErr = err;
        console.error(`[AI] ${model} failed:`, (err as { status?: number })?.status || '', (err as Error)?.message);
        if (!isRetryable(err)) break;
        continue;
      }
    }
    if (model !== getActiveModel()) console.log(`[AI] Degraded to ${model}`);
    // stripMarkdown misses a ** left without its partner.
    result.content = stripMarkdownEmphasis(result.content);
    result.content = withReplyGuards(withRightOrderNumbers(withoutTodayPromise(result.content)));
    if (alreadyReplied) result.content = dropRepeatedIntroduction(result.content);
    // A model that escalated itself has already handed over.
    if (!result.escalated) {
      // H1: they typed both and no lookup with those values happened. (A
      // model that then said nothing no longer gets here: see BlankReplyError.)
      if (pending && !typedLookupRan) return handOver('H1', result);
      // FORM: the form guard dropped part or all of the reply (formFollowUp above).
      const formHandOver = await formFollowUp(result);
      if (formHandOver) return formHandOver;
      const disputeHandOver = await disputeFollowUp(result);
      if (disputeHandOver) return disputeHandOver;
      // H3: asking yet again after lookups that keep coming back not found.
      if (asksAgainAfterFailedLookups(result.content, guardRows, lookupOutcomes)) return handOver('H3', result);
      // The lookup ran and matched nothing, yet the reply only asks for the
      // details again (seen live even with a plain not-found result), so the
      // customer never learns the pair was wrong. Say it for the model.
      const misses = lookupOutcomes.filter((o) => o.found === false && !o.needs_verification);
      if (misses.length && !lookupOutcomes.some((o) => o.found)) {
        const again = reasksForOrderDetails(result.content, Array.from(knownOrderIds));
        if (again.orderId || again.last4) {
          result.content = notFoundReply(guardRows, misses[misses.length - 1].order_id || '');
          return result;
        }
      }
      // H7 (seen live 4 Oct, test visitor-phone-only): not verified, the customer's latest message
      // is only their phone number, and the reply asks for the phone number again without asking
      // for the order ID (the model read the 10 digits as an order ID). Say what is missing instead.
      if (!verifiedOrderId && !lookupOutcomes.length && isBarePhone(latestVisitor)
          && asksForPhone(result.content) && !reasksForOrderDetails(result.content, Array.from(knownOrderIds)).orderId) {
        console.log(`[AI] Guard H7 for conv ${conversationId}: phone typed, asked for the phone again`);
        result.content = orderIdAfterPhoneReply(guardRows);
        return result;
      }
      // H4: the order is verified and in view, yet the reply asks for the
      // order ID or last 4 anyway. Ask the same model once more with a note;
      // if it still asks, a person takes over. Not when the customer has just
      // brought up a different order, which is a fair reason to ask.
      if (h4Applies() && asksAgain(result.content)) {
        console.log(`[AI] Guard retry for conv ${conversationId}: H4`);
        // (the up-front verified note, if it was sent, is re-added below)
        const firstRun = lastRunMessages.slice(1 + history.length).filter((m) => !(m.role === 'user' && m.content === VERIFIED_NOTE));
        let retry: AIResult | null = null;
        // This model, then once more on the next one if the provider hiccups.
        const retryModels = [model, ...attemptOrder().filter((m) => m !== model)].slice(0, 2);
        h4Retry = true;
        try {
          for (const m of retryModels) {
            try {
              retry = await runWithModel(m, [...firstRun, { role: 'user', content: VERIFIED_NOTE }]);
              break;
            } catch (err) {
              console.error(`[AI] H4 retry on ${m} failed:`, (err as Error)?.message);
              if (!isRetryable(err)) break;
            }
          }
        } finally {
          h4Retry = false;
        }
        if (!retry) return handOver('H4', result);
        // The first run's lookup still has to be stored if the retry used none.
        retry.toolCallMeta = retry.toolCallMeta || result.toolCallMeta;
        retry.content = withReplyGuards(withRightOrderNumbers(withoutTodayPromise(stripMarkdownEmphasis(retry.content))));
        if (alreadyReplied) retry.content = dropRepeatedIntroduction(retry.content);
        const retryHandOver = await formFollowUp(retry);
        if (retryHandOver) return retryHandOver;
        const retryDispute = await disputeFollowUp(retry);
        if (retryDispute) return retryDispute;
        if (!retry.escalated && asksAgain(retry.content)) return handOver('H4', retry);
        return finish(retry, model);
      }
      const known = Array.from(knownOrderIds);
      const ask = reasksForOrderDetails(result.content, known);
      // H5: asking for the order ID again although they have told us they do
      // not have it. The prompt says to point them to the order confirmation
      // message once and then escalate; models keep asking instead.
      // H6: this would be the third ask in a row with no lookup at all.
      // When a lookup ran this turn, H3/H4 decide instead of either: asking
      // to double-check after one miss is what the prompt allows.
      if (!lookupOutcomes.length) {
        if (ask.orderId && keptAskingForMissingOrderId(guardRows, known)) return handOver('H5', result);
        if ((ask.orderId || ask.last4) && consecutiveAsks(guardRows, known) >= 2) return handOver('H6', result);
      }
    }
    noteAiSuccess();
    return finish(result, model);
  }

  // Every model is down. The customer must never see a stack trace, a provider
  // name, or silence, so answer like a busy human and invite them to continue.
  console.error('[AI] Every model failed:', (lastErr as Error)?.message);
  noteAiFailure((lastErr as { status?: number })?.status, String((lastErr as Error)?.message || ''));   // the Today board's red banner (ai-health.ts)
  return {
    content: AI_BUSY_REPLY,
    toolCallMeta: null,
    allFailed: true,
  };
}
