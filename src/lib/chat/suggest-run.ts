// ── Suggested replies and "Sudharo" for the team: the database and the model ─────────
// suggest.ts has the pure parts (instructions, parser, guards). Here: read the chat, Chikki's
// knowledge (the panel prompt, saved answers, Brain notes, team examples) and the verified order,
// ask the model, guard the options, record the row (chat-reply-suggestions.sql). Staff only:
// called by GET /api/chat/conversations/[id]/suggest and POST /api/chat/polish, never by the
// widget or the AI reply path. Nothing here is ever sent to the customer by itself.
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { query, queryOne } from '@/lib/db';
import { afterHours } from '@/lib/office-hours';
import { getClient, isRetryable, sideAttemptOrder, withoutThinking } from './ai-models';
import { buildSystemPrompt, type SavedAnswer } from './ai-prompt';
import { brainSection, selectNotes, type BrainNote } from './brain';
import { detectSituations, examplesSection, pickExamples, type Example } from './brain-examples';
import { lookupVerifiedOrder } from './orders';
import {
  POLISH_INSTRUCTION, POLISH_MAX_CHARS, POLISH_TIMEOUT_MS, SUGGEST_HISTORY, SUGGEST_MAX_TOKENS, SUGGEST_TIMEOUT_MS,
  acceptPolish, guardOptions, parseOptions, polishUserMessage, suggestInstruction, type SuggestLang,
} from './suggest';

export interface SuggestConv {
  id: string; site_id: string; tracker_business_id: string | null; source: string; status: string;
  verified_order_id: string | null; phone_match_order_id: string | null; case_kind: string | null;
}

export interface Suggestion {
  id: string | null;
  after_message_id: string | null;
  lang: SuggestLang;
  options: string[];
  created_at: string;
  cached: boolean;
}

interface Row { id: string; sender: string; content: string | null }

// The chat as the drafts see it: the last SUGGEST_HISTORY visible messages, oldest first.
async function loadHistory(conversationId: string): Promise<Row[]> {
  const r = await query<Row>(
    `SELECT id, sender, content FROM (
       SELECT id, sender, content, created_at FROM messages
        WHERE conversation_id = $1 AND deleted_at IS NULL
          AND COALESCE(metadata->>'hidden', 'false') <> 'true'
          AND COALESCE(metadata->>'withheld', '') = ''
          AND btrim(COALESCE(content, '')) <> ''
        ORDER BY created_at DESC, id DESC LIMIT $2
     ) t ORDER BY created_at ASC, id ASC`,
    [conversationId, SUGGEST_HISTORY]
  );
  return r.rows;
}

const lastCustomer = (rows: Row[]) => [...rows].reverse().find((r) => r.sender === 'visitor') || null;

// One model answer, the chain in order, no thinking (a draft needs none), no retries on a model
// that answered. Returns null when every model failed.
async function ask(messages: ChatCompletionCreateParamsNonStreaming['messages'], maxTokens: number, temperature: number, timeout: number) {
  let lastErr: unknown = null;
  for (const model of sideAttemptOrder()) {
    try {
      const t0 = Date.now();
      const res = await getClient().chat.completions.create(
        withoutThinking(model, { model, messages, max_tokens: maxTokens, temperature }),
        { timeout, maxRetries: 0 },
      );
      const content = res?.choices?.[0]?.message?.content || '';
      const u = (res?.usage || {}) as { prompt_tokens?: number; completion_tokens?: number };
      if (content.trim()) return { content, model: res?.model || model, prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0, ms: Date.now() - t0 };
      lastErr = new Error(`${model} answered blank`);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) console.error('[suggest] model error:', (err as Error)?.message);
    }
  }
  console.error('[suggest] every model failed:', (lastErr as Error)?.message);
  return null;
}

export async function suggestReplies(conv: SuggestConv, actorKey: string, lang: SuggestLang, refresh: boolean): Promise<Suggestion | { error: string }> {
  const orderId = conv.verified_order_id || conv.phone_match_order_id;
  if (!orderId) return { error: 'Suggestions are for verified customers only' };
  const rows = await loadHistory(conv.id);
  const afterId = lastCustomer(rows)?.id || null;

  if (!refresh) {
    try {
      const hit = await queryOne<{ id: string; options: unknown; created_at: string }>(
        `SELECT id, options, created_at FROM reply_suggestions
          WHERE conversation_id = $1 AND kind = 'suggest' AND lang = $2 AND after_message_id IS NOT DISTINCT FROM $3
          ORDER BY created_at DESC LIMIT 1`,
        [conv.id, lang, afterId]
      );
      if (hit && Array.isArray(hit.options) && hit.options.length) {
        return { id: hit.id, after_message_id: afterId, lang, options: hit.options as string[], created_at: new Date(hit.created_at).toISOString(), cached: true };
      }
    } catch (err) {
      // Before chat-reply-suggestions.sql: draft without a cache.
      console.error('[suggest] cache read failed:', (err as Error)?.message);
    }
  }

  // Chikki's knowledge, read fresh like getAIResponse does (ai.ts): each part is optional.
  const site = await queryOne<{ system_prompt: string | null; cod_available: boolean | null; cod_states: string | null }>(
    `SELECT system_prompt, cod_available, cod_states FROM sites WHERE id = $1`, [conv.site_id]
  ).catch(() => null);
  let faqs: SavedAnswer[] = [];
  try {
    faqs = (await query<SavedAnswer>(`SELECT question, answer FROM site_faqs WHERE site_id = $1 AND is_enabled = true ORDER BY sort_order, created_at`, [conv.site_id])).rows;
  } catch (err) { console.error('[suggest] saved answers failed:', (err as Error)?.message); }
  const customerTexts = rows.filter((r) => r.sender === 'visitor').map((r) => r.content || '');
  const asked = customerTexts.slice(-3).join('\n');
  let brain = '';
  try {
    const notes = await query<BrainNote>(
      `SELECT id, kind, title, body, topics, always, audience, sort_order FROM brain_notes
        WHERE is_enabled = true AND (site_id = $1 OR site_id IS NULL) ORDER BY sort_order, created_at`,
      [conv.site_id]
    );
    brain = brainSection(selectNotes(notes.rows, asked, undefined, undefined, true));
  } catch (err) { console.error('[suggest] brain read failed:', (err as Error)?.message); }
  let examples = '';
  try {
    const situations = detectSituations(customerTexts.slice(-3));
    if (situations.length) {
      const ex = await query<Example>(
        `SELECT id, situation, customer_said, team_replied FROM brain_examples
          WHERE site_id = $1 AND status = 'approved' AND is_enabled = true AND situation = ANY($2::text[])
          ORDER BY created_at DESC LIMIT 40`,
        [conv.site_id, situations]
      );
      examples = examplesSection(pickExamples(ex.rows, situations, 3));
    }
  } catch (err) { console.error('[suggest] team examples failed:', (err as Error)?.message); }

  // The order as Chikki's lookup shows it (status as the tracking page, the revised date when late,
  // the tracking link). The courier's name is kept out of the facts and out of every option.
  let orderJson: string | null = null;
  const courierNames: string[] = [];
  try {
    const found = await lookupVerifiedOrder(orderId, conv.tracker_business_id);
    if (found.found && found.orders[0]) {
      const { courier, ...rest } = found.orders[0];
      if (courier) courierNames.push(courier);
      orderJson = JSON.stringify(rest);
    }
  } catch (err) { console.error('[suggest] order lookup failed:', (err as Error)?.message); }

  const system = buildSystemPrompt(site?.system_prompt || null, site?.cod_available, 'chat', faqs, site?.cod_states?.trim() || null, asked)
    + brain + examples
    + suggestInstruction({ lang, after: afterHours(Date.now()), caseKind: conv.case_kind === 'refund' || conv.case_kind === 'reship' ? conv.case_kind : null, orderJson });
  const history: ChatCompletionCreateParamsNonStreaming['messages'] = rows.map((r) => (
    r.sender === 'visitor'
      ? { role: 'user' as const, content: r.content || '' }
      : { role: 'assistant' as const, content: r.content || '' }
  ));
  const messages: ChatCompletionCreateParamsNonStreaming['messages'] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: '[Team member: draft the 3 options for my next reply now, as JSON.]' },
  ];

  const res = await ask(messages, SUGGEST_MAX_TOKENS, 0.5, SUGGEST_TIMEOUT_MS);
  if (!res) return { error: 'Chikki could not draft right now. Try again in a moment.' };
  const options = guardOptions(parseOptions(res.content), { customerTexts, courierNames });
  if (!options.length) return { error: 'Chikki had no reply that passes the rules here. Type your own.' };

  let id: string | null = null;
  try {
    const ins = await queryOne<{ id: string }>(
      `INSERT INTO reply_suggestions (conversation_id, site_id, kind, after_message_id, lang, options, model, prompt_tokens, completion_tokens, ms, created_by)
       VALUES ($1, $2, 'suggest', $3, $4, $5::jsonb, $6, $7, $8, $9, $10) RETURNING id`,
      [conv.id, conv.site_id, afterId, lang, JSON.stringify(options), res.model, res.prompt, res.completion, res.ms, actorKey]
    );
    id = ins?.id || null;
  } catch (err) { console.error('[suggest] not recorded:', (err as Error)?.message); }
  console.log(`[suggest] ${options.length} options for conv ${conv.id} (${res.model}, ${res.ms} ms)`);
  return { id, after_message_id: afterId, lang, options, created_at: new Date().toISOString(), cached: false };
}

export async function recordPick(conversationId: string, suggestionId: string, index: number): Promise<void> {
  await query(
    `UPDATE reply_suggestions SET picked_index = $3, picked_at = now() WHERE id = $1::uuid AND conversation_id = $2`,
    [suggestionId, conversationId, index]
  ).catch((err) => console.error('[suggest] pick not recorded:', (err as Error)?.message));
}

// After a reply was saved: which option it came from and whether it was edited first. Runs outside
// the reply's transaction, so a missing table never touches the reply.
export async function recordSent(conversationId: string, suggestionId: string, index: number, messageId: string, sentText: string): Promise<void> {
  await query(
    `UPDATE reply_suggestions
        SET sent_message_id = $4, sent_at = now(), picked_index = COALESCE(picked_index, $3),
            sent_edited = (btrim(COALESCE(options->>$3::int, '')) <> btrim($5))
      WHERE id = $1::uuid AND conversation_id = $2`,
    [suggestionId, conversationId, index, messageId, sentText]
  ).catch((err) => console.error('[suggest] sent not recorded:', (err as Error)?.message));
}

// "Sudharo": the team member's draft with its spelling and grammar fixed. The draft itself comes
// back whenever the model's answer is not a plain correction (acceptPolish). Recorded as a
// 'polish' row; never throws.
export async function polishDraft(conv: SuggestConv, actorKey: string, draft: string): Promise<string> {
  const text = draft.trim().slice(0, POLISH_MAX_CHARS);
  if (!text) return text;
  let latest: string | null = null;
  try { latest = lastCustomer(await loadHistory(conv.id))?.content || null; } catch { /* context only */ }
  const res = await ask(
    [{ role: 'system', content: POLISH_INSTRUCTION }, { role: 'user', content: polishUserMessage(text, latest) }],
    Math.min(1200, Math.ceil(text.length / 2) + 200), 0, POLISH_TIMEOUT_MS,
  );
  const out = acceptPolish(text, res?.content);
  try {
    await query(
      `INSERT INTO reply_suggestions (conversation_id, site_id, kind, lang, input_text, options, model, prompt_tokens, completion_tokens, ms, created_by)
       VALUES ($1, $2, 'polish', 'auto', $3, $4::jsonb, $5, $6, $7, $8, $9)`,
      [conv.id, conv.site_id, text, JSON.stringify([out]), res?.model || null, res?.prompt || 0, res?.completion || 0, res?.ms || 0, actorKey]
    );
  } catch (err) { console.error('[suggest] polish not recorded:', (err as Error)?.message); }
  return out;
}
