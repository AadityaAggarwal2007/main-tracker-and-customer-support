import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { query, queryOne } from '@/lib/db';
import { attemptOrder, getClient, isRetryable } from './ai';
import { lookupVerifiedOrder } from './orders';
import { VISIBLE_MESSAGE_SQL } from './widget-api';
import {
  HEALTH_INSTRUCTION, buildHealthTranscript, combineHealth, healthOrderFacts, heuristicReason,
  parseHealthReply, scanSignals, type HealthRow,
} from './health-rules';

// ── How upset is this customer? ────────────────────────────────
// Asked for by the owner on 2026-09-30 (chat-health.sql, health-rules.ts):
// every chat carries a 0-100 frustration / chargeback-risk score that the
// inbox shows in the thread header and uses to keep the angriest OPEN chats at
// the top until they are Closed.
//
// It is worked out from the customer's recent messages across ALL their chats
// on this site (customer_key, see chat-customer-key.sql), so a customer who
// opens a fresh chat each time still carries what happened before. One small
// model call (no tools) reads them with the facts of their verified order; the
// counts in health-rules.ts (swearing, threats, refund demands, repeats, days
// waiting) are added to it and set a floor when the customer's last messages
// swear or threaten. If the model is down, the counts alone are used.
//
// Like the subject line (subject.ts) it is fired without awaiting after each
// new customer message (/api/widget/message once the reply is saved, and
// email.ts once an inbound email is stored), never throws, and writes only its
// own four columns.

// Customer messages plus replies the model reads, newest last, across chats.
const HEALTH_WINDOW = 40;
const HEALTH_CHATS = 8;
// ~30 tokens of answer; the rest is room for deepseek-v4-flash's reasoning
// (which returns nothing at all when it runs out, see MAX_REPLY_TOKENS in ai.ts).
const HEALTH_MAX_TOKENS = 800;
const HEALTH_TIMEOUT_MS = 20_000;

// Conversations with an update running, and whether another was asked for
// meanwhile (then it runs once more when the first finishes). One PM2 process
// runs the app, so this is the only place two updates could meet.
const inFlight = new Map<string, { again: boolean }>();

class BlankHealthError extends Error {
  status = 502; // a model failure like any other, so the next model is tried
}

async function askModel(transcript: string): Promise<{ score: number; reason: string }> {
  let lastErr: unknown = null;
  for (const model of attemptOrder()) {
    try {
      const body = {
        model,
        messages: [
          { role: 'system' as const, content: HEALTH_INSTRUCTION },
          { role: 'user' as const, content: transcript },
        ],
        max_tokens: HEALTH_MAX_TOKENS,
        // The same story should get the same score every time (a temperature above
        // 0 moved one chat between 15 and 65 in tests), or chats jump in and out of the top.
        temperature: 0,
        // A one-line score needs no thinking; with reasoning on, this model
        // sometimes answered blank (see the same note in subject.ts). An
        // OpenRouter field the SDK does not type; providers without it ignore it.
        reasoning: { enabled: false },
      };
      const res = await getClient().chat.completions.create(
        body as ChatCompletionCreateParamsNonStreaming,
        { timeout: HEALTH_TIMEOUT_MS, maxRetries: 0 }
      );
      const parsed = parseHealthReply(res.choices?.[0]?.message?.content);
      if (!parsed) throw new BlankHealthError(`${model} gave no score (finish=${res.choices?.[0]?.finish_reason})`);
      return parsed;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('no model answered');
}

async function runOnce(conversationId: string): Promise<void> {
  // read_at becomes health_updated_at: a customer message that arrives while
  // the model is thinking is newer than it, so the next trigger still sees
  // something new (now() at the UPDATE would be later than that message).
  const conv = await queryOne<{
    site_id: string; customer_key: string | null; source: string; status: string;
    verified_order_id: string | null; tracker_business_id: string | null; created_at: Date;
    read_at: string; has_visitor: boolean; fresh: boolean;
  }>(
    `SELECT c.site_id, c.customer_key, c.source, c.status, c.verified_order_id, c.created_at,
            s.tracker_business_id,
            now()::timestamp(3)::text AS read_at,
            v.last_visitor_at IS NOT NULL AS has_visitor,
            COALESCE(c.health_updated_at > v.last_visitor_at, false) AS fresh
       FROM conversations c
       JOIN sites s ON s.id = c.site_id
       CROSS JOIN LATERAL (
         SELECT max(m.created_at) AS last_visitor_at
           FROM messages m
          WHERE m.conversation_id = c.id
            AND m.sender = 'visitor'
            AND ${VISIBLE_MESSAGE_SQL}
       ) v
      WHERE c.id = $1`,
    [conversationId]
  );
  // Gone, never written in by the customer, or nothing new since the last score.
  if (!conv || !conv.has_visitor || conv.fresh) return;

  // This customer's chats on the site, oldest first (a verified customer's
  // widget chats share customer_key); otherwise just this one.
  const chatRows = conv.customer_key && conv.source === 'chat'
    ? (await query<{ id: string; status: string; created_at: Date }>(
        `SELECT id, status, created_at FROM conversations
          WHERE site_id = $1 AND customer_key = $2 AND source = 'chat'
          ORDER BY created_at DESC LIMIT ${HEALTH_CHATS}`,
        [conv.site_id, conv.customer_key]
      )).rows.reverse()
    : [{ id: conversationId, status: conv.status, created_at: conv.created_at }];
  const chatIndex = new Map(chatRows.map((c, i) => [c.id, i]));

  const msgs = await query<{ conversation_id: string; sender: string; content: string; created_at: Date }>(
    `SELECT m.conversation_id, m.sender, m.content, m.created_at
       FROM (
         SELECT id, conversation_id, sender, content, created_at
           FROM messages
          WHERE conversation_id = ANY($1::text[])
            AND sender IN ('visitor', 'ai', 'agent')
            AND ${VISIBLE_MESSAGE_SQL}
          ORDER BY created_at DESC, id DESC
          LIMIT ${HEALTH_WINDOW}
       ) m
      ORDER BY m.created_at ASC, m.id ASC`,
    [chatRows.map((c) => c.id)]
  );
  const rows: HealthRow[] = msgs.rows.map((m) => ({
    sender: m.sender, content: m.content, at: new Date(m.created_at).toISOString(), chat: chatIndex.get(m.conversation_id),
  }));
  if (!rows.some((r) => r.sender === 'visitor')) return;

  // How long the customer has been waiting: since their oldest chat that is
  // still open began.
  const open = chatRows.filter((c) => c.status !== 'resolved');
  const openSince = (open[0] || chatRows[chatRows.length - 1]).created_at;

  // The verified order's age and status; a failed lookup only means no facts.
  let facts = '';
  if (conv.verified_order_id) {
    try {
      const found = await lookupVerifiedOrder(conv.verified_order_id, conv.tracker_business_id);
      if (found.found) facts = healthOrderFacts(found.orders[0]);
    } catch { /* the model still has the chat */ }
  }

  const now = Date.now();
  const signals = scanSignals(rows, { chats: chatRows.length, openSince: new Date(openSince).toISOString(), now });

  // The model is one voice among the counts: if it is down, the counts stand.
  let llm: { score: number; reason: string } | null = null;
  try {
    llm = await askModel(buildHealthTranscript(rows, facts, now));
  } catch (err) {
    console.error(`[health] ${conversationId} model failed, using the counts: ${(err as Error)?.message || String(err)}`);
  }

  const score = combineHealth(llm ? llm.score : null, signals);
  const reason = (llm && llm.reason) || (score >= 25 ? heuristicReason(signals) : '');

  // Only its own columns: updated_at stays, so the inbox order by activity does
  // not move. Never replaces a score written from a later read (the backfill
  // script can run beside the app).
  await query(
    `UPDATE conversations
        SET health_score = $2, health_reason = $3, health_signals = $4::jsonb,
            health_updated_at = $5::timestamp(3)
      WHERE id = $1
        AND (health_updated_at IS NULL OR health_updated_at < $5::timestamp(3))`,
    [conversationId, score, reason || null, JSON.stringify(signals), conv.read_at]
  );
  console.log(`[health] ${conversationId}: ${score}${llm ? '' : ' (counts only)'}`);
}

// Fire and forget: `void updateConversationHealth(id)`. Never throws.
export async function updateConversationHealth(conversationId: string): Promise<void> {
  try {
    if (!conversationId) return;
    const running = inFlight.get(conversationId);
    if (running) { running.again = true; return; }
    const entry = { again: false };
    inFlight.set(conversationId, entry);
    try {
      do {
        entry.again = false;
        try {
          await runOnce(conversationId);
        } catch (err) {
          console.error(`[health] ${conversationId} failed: ${(err as Error)?.message || String(err)}`);
        }
      } while (entry.again);
    } finally {
      inFlight.delete(conversationId);
    }
  } catch (err) {
    console.error(`[health] ${conversationId} failed: ${(err as Error)?.message || String(err)}`);
  }
}
