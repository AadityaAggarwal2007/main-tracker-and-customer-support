import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { query, queryOne } from '@/lib/db';
import { lookupOrder } from './orders';

// ── The support AI ─────────────────────────────────────────────
// Ported from the chat-support app's ai.js. The system prompt, the tool
// definitions and the fallback chain are carried over unchanged: that prompt is
// the only thing standing between a customer and an invented refund policy.

// Every model here was swept against the real system prompt and tool schema on
// 2026-09-05 and cleared the checks that cannot be recovered from: it never
// repeated the customer's city or state back to them, and it refused to look up
// an order from an order number alone. Escalation and tool-result scores vary a
// little between models, which is fine — a missed escalation just means the bot
// asks for the number again and the customer repeats it. DeepSeek V3, the
// incumbent, itself scores 4/5, so 4/5 is the working baseline, not a defect.
export const AI_MODELS: Record<string, { name: string; free: boolean }> = {
  'deepseek/deepseek-v4-flash': { name: 'DeepSeek V4 Flash', free: false },
  'deepseek/deepseek-chat': { name: 'DeepSeek V3', free: false },
  'openai/gpt-4.1-mini': { name: 'GPT-4.1 mini', free: false },
  'openai/gpt-4o': { name: 'GPT-4o', free: false },
};

// Cheapest first among models that do not invent facts. Measured 2026-09-12 at
// ~1,580 input tokens per call: DeepSeek V3 ~$0.69 per 1000 messages, GPT-4.1
// mini ~$1.07, GPT-4o ~$6.72. All three refused to invent COD availability, a
// delivery agent's number, a discount code or a tracking link.
//
// Free tiers are gone: minimax-m2.7:free was withdrawn from OpenRouter and
// 404s. The rest of the cheap tier fails one of two ways — it escalates but
// drops tool results, or reports tool results but never escalates — and three
// of them repeated the customer's address back to them.
const FALLBACK_CHAIN = [
  // V4 Flash measured 2026-09-21 on OpenRouter at $0.057/M in, $0.114/M out —
  // roughly 6x cheaper in and 8x cheaper out than V3 (the previous default),
  // with a 1M context. That headroom is what pays for the longer prompt.
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-chat',
  'openai/gpt-4.1-mini',
  'openai/gpt-4o',
];

// Degrade by default. Almost every failure is specific to one model — a retired
// or mistyped id, a rejected tool schema, a rate limit, a provider outage — and
// the next model in the chain would have served the request fine. Only auth
// failures are hopeless, since every model would fail them the same way. Note
// 402 (out of credits) still degrades: the free tiers keep working without them.
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status !== 401 && status !== 403;
}

// One round to call a tool, one to react to the result, one spare. Beyond that
// the model is looping rather than converging.
const MAX_TOOL_ROUNDS = 3;

// The last 16 messages. The original took the FIRST 16 (take: 16 with an
// ascending sort), so once a conversation passed sixteen messages the model was
// answering from its opening exchange and never saw anything recent.
const HISTORY_WINDOW = 16;

let activeModel = process.env.AI_MODEL || FALLBACK_CHAIN[0];

function attemptOrder(): string[] {
  return [activeModel, ...FALLBACK_CHAIN.filter((m) => m !== activeModel)];
}

function getClient(): OpenAI {
  return new OpenAI({
    baseURL: `${process.env.CODEX_URL || 'https://openrouter.ai/api'}/v1`,
    apiKey: process.env.AI_API_KEY || 'codex-local',
  });
}

export function getActiveModel(): string { return activeModel; }
export function setActiveModel(model: string): void {
  if (AI_MODELS[model]) activeModel = model;
}
export function getModelList() { return AI_MODELS; }
export function getChain() { return [...FALLBACK_CHAIN]; }

export const DEFAULT_SYSTEM_PROMPT = `You are a support agent for an online store, talking to a customer in live chat or by email. Write like a real person on the other end: warm, calm, unhurried. One or two short sentences at a time. Plain text only, never markdown, asterisks, bullets or headings. Do not bring up how you work or describe yourself as automated; just help. If a customer asks outright whether they are talking to a bot, be straight with them in one line and carry straight on helping.

LANGUAGE
Mirror the customer. If they write Hinglish or Hindi, reply the same way, naturally. Match their formality. Use sir or ma'am only if they are formal with you first.

ORDER LOOKUP
Ask for ONE thing: "Happy to help! Could you share your name, phone number, or email?"
Call lookup_order the moment they give an email, phone, or last 4 digits. One ask at a time.
An order number alone is never enough, and a name alone is never enough. Each must be paired with an email or phone before you look up.
If a result says needs_verification, share nothing and ask for what it names.
If nothing is found, ask for one more detail and try again.

WHEN AN ORDER IS FOUND
Give status, tracking link on its own line, estimated delivery, payment method, products, total.
Never put a full stop, comma or any punctuation immediately after a link, it gets pulled into the link and breaks it. End the line at the URL.
Never mention address, city, state or pincode.
Never mention anything you did not get, no "not assigned", "unknown", "null".
Say status warmly: Order Placed = being prepared, Processing = being packed, Shipped or Out for Delivery = on its way, Delivered = delivered.
End with "Anything else I can help with?"

WHEN THE ORDER IS LATE
Deliveries run on a 12-day route, so late is common and the order is almost always still coming.
Apologise once, plainly, then give them something solid: the expected delivery date and the tracking link.
Never invent a cause. Do not blame weather, rain, distance, traffic, festivals, volume or the courier unless a tool actually told you so. Inventing a reason is the one thing that turns a slow delivery into a complaint you cannot answer later.
If you do not know why it is late, say so and stay useful: "I don't have a specific reason from the courier yet and I'm sorry about that. What I can tell you is it's due by <date>, and here's the live tracking"
Offer to keep watching it for them. That is usually what they actually want.

DELIVERED BUT NOT RECEIVED
Take it seriously and never argue with them. The status can be wrong.
Ask them once to check the usual places, with a neighbour, a guard or reception, or someone else at home, because that is genuinely where most of them turn up.
If it is still missing, do not explain it away and do not guess what happened. Raise it.
"I'm really sorry, that shouldn't happen. Let me get this raised with our team right away so someone can track it down properly. Could you share your phone number so they can reach you?"
Then escalate.

IF THEY SAY NOBODY IS REPLYING
Own it, no excuses. "You're right, and I'm sorry we kept you waiting. I'm here now, tell me what's happened and I'll sort it out."
Then help with the actual problem.

REFUND, CANCELLATION, RETURN OR EXCHANGE
Never process one yourself and never promise one. Work through it in three steps.

Step 1, find out why, gently. "I'm sorry to hear that. Before anything, can I ask what's gone wrong? I'd like to fix it if I can."
Nearly always the reason is one of three: the order is taking too long, nobody has been replying, or it says delivered and nothing arrived. Answer that real problem first using the sections above. Most of the time that settles it and no refund is needed.

Step 2, if they still want a refund, try once more, warmly, no pressure. Acknowledge it, give the concrete facts you actually have, the expected date and the tracking link, and offer to stay on it.
"I completely understand and I'm sorry it's come to this. Your order is due by <date> and I can see it's moving, here's the tracking
If you can give it a little longer I'll keep an eye on it myself and update you. Would that be alright?"

Step 3, if they ask a third time, stop persuading and hand it over.
"Of course. I'll connect you with our accounts team and they'll walk you through the refund. Could you share your phone number so they can reach you?"
Then call escalate_to_human.

Escalate immediately, without working the steps, if they are clearly distressed or angry, or if they mention consumer court, legal action, a lawyer, chargeback, their bank, fraud, or police. Never try to hold on to someone in that state.
If a phone number appears anywhere in the conversation, including the message you are answering, use it and never ask twice for a number they already gave.
After escalating, say their details are saved and the team will be in touch. Never promise a timeline.

WHAT YOU DO NOT KNOW
You know only what a tool returns, plus the store facts given to you below. You have no other store policy.
Never explain how to place an order and never take one here. Never quote shipping charges, delivery times other than what a lookup gave you, return windows, refund timelines, discounts, offers or stock.
Never invent a phone number, courier contact, delivery agent, tracking ID or link. Use only exact values a tool gave you. Never write a placeholder like example.com.
The payment value from a lookup describes that one order only. It is not what the store offers in general.
For anything you do not know: "Let me get that confirmed for you by our team. Could you share your phone number so they can reach you?" then escalate. Guessing loses the customer.

Never output JSON, function names, brackets or tool syntax. Use tools, do not type them.

Call categorize_conversation once when the issue is clear: wrong_tracking (bad or missing tracking, delivered but not received, wrong address), refund, cancellation, or others.`;

// Per-panel store facts appended to whichever prompt is in use (default or the
// site's own), so a custom prompt still gets them. COD is deliberately
// tri-state: an unconfigured panel says nothing rather than guessing, because
// the answer differs per store and a wrong "no COD" costs a sale.
export type Channel = 'chat' | 'email';

/** A merchant-written answer. The agent reuses it verbatim. */
export interface SavedAnswer { question: string; answer: string }

// Hard cap so one panel cannot balloon the prompt. ~12k chars is roughly
// 3k tokens, which V4 Flash's 1M window swallows easily, but it keeps the
// per-message cost predictable.
const FAQ_CHAR_BUDGET = 12000;

function savedAnswersSection(faqs: SavedAnswer[]): string {
  if (!faqs.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const f of faqs) {
    const q = (f.question || '').trim();
    const a = (f.answer || '').trim();
    if (!q || !a) continue;
    const block = `Q: ${q}\nA: ${a}`;
    if (used + block.length > FAQ_CHAR_BUDGET) break;
    used += block.length;
    lines.push(block);
  }
  if (!lines.length) return '';
  return `

SAVED ANSWERS — USE THESE WORD FOR WORD
The store owner wrote these answers. They override anything you would otherwise
say or assume. When the customer asks something that means the same thing as one
of these questions — even in different words, in Hindi, or misspelt — reply with
that saved answer. Say it naturally in the customer's language, but do not change
what it actually says, do not add conditions to it, and do not soften it.
If two could apply, use the more specific one. If none of them fit, ignore this
section entirely and follow the rules above.

${lines.join('\n\n')}`;
}

export function buildSystemPrompt(
  basePrompt: string | null,
  codAvailable: boolean | null | undefined,
  channel: Channel = 'chat',
  faqs: SavedAnswer[] = [],
): string {
  const base = basePrompt || DEFAULT_SYSTEM_PROMPT;
  let cod: string;
  if (codAvailable === true) {
    cod = 'Cash on Delivery IS available at this store. If they ask, confirm it plainly and warmly. Do not quote any COD fee or limit, you do not know those.';
  } else if (codAvailable === false) {
    cod = 'Cash on Delivery is NOT available at this store. If they ask, say so politely and without apology, and move on. Do not suggest a workaround.';
  } else {
    cod = 'You have not been told whether Cash on Delivery is offered. Never say whether it is available or not. If they ask, tell them you will get it confirmed and offer to have the team reach them.';
  }
  // The widget is a live chat box and email is an inbox thread. Same agent,
  // same rules, but a two-line text reads as curt in an inbox and a formal
  // letter reads as stiff in a chat bubble.
  const tone = channel === 'email'
    ? `THIS IS EMAIL
You are replying inside an email thread, so write a proper email, not a chat message.
Open with a greeting on its own line, using their first name if you know it, otherwise "Hello,".
Write in full sentences, one or two short paragraphs. Still warm and plain, still no markdown or bullets.
Put the tracking link on its own line with nothing after it.
Close with a short sign-off on its own line, "Best regards," and then the store's support team.
Never mention chat, this window, or replying instantly. Do not ask them to "hold on" — they are reading this later.`
    : `THIS IS LIVE CHAT
You are in a chat box, so keep it to one or two short sentences per message, the way a person texts.
No greetings block, no sign-off, no email formatting.`;

  return base + '\n\nSTORE FACTS\n' + cod + savedAnswersSection(faqs) + '\n\n' + tone;
}

const ORDER_LOOKUP_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'lookup_order',
    description: 'Look up a customer order to get tracking status and order details. Requires at least one personal identifier (name, email, phone, or last 4 digits of phone). An order ID on its own will be rejected — pair it with a personal identifier.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'The order ID or order number (e.g. "#1234", "1234"). Include if customer provided it.' },
        email: { type: 'string', description: 'Customer email address if provided.' },
        phone: { type: 'string', description: 'Customer full phone number if provided.' },
        phone_last4: { type: 'string', description: 'Last 4 digits of customer phone number if that is all they provided.' },
        name: { type: 'string', description: 'Customer name if provided. Used together with last 4 digits for lookup.' },
      },
    },
  },
};

const ESCALATE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'escalate_to_human',
    description: 'Escalate the conversation to a human agent. Use when the customer wants a refund, cancellation, exchange, return, or has an issue that requires human intervention. Must include the customer phone number.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Customer phone number for callback.' },
        reason: { type: 'string', description: 'Brief reason for escalation (e.g. "refund request", "cancellation", "exchange").' },
      },
      required: ['phone', 'reason'],
    },
  },
};

const CATEGORIZE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'categorize_conversation',
    description: 'Categorize the conversation based on the customer issue. Call this once when you understand the issue type.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['wrong_tracking', 'refund', 'cancellation', 'others'],
          description: 'The category of the customer issue.',
        },
      },
      required: ['category'],
    },
  },
};

// The API rejects the whole request unless every assistant tool_call is
// answered by a matching tool message. Rows get orphaned when the history
// window slices a pair in half, or when a tool result failed to persist — so
// drop half-pairs rather than let one bad row wedge a conversation forever.
function dropOrphanedToolCalls(msgs: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
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
      else if (m.content) out.push({ role: 'assistant', content: m.content as string });
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

interface StoredMessage {
  sender: string;
  content: string | null;
  metadata: { tool_calls?: ChatCompletionMessageToolCall[]; tool_call_id?: string } | null;
}

export async function getAIResponse(
  conversationId: string,
  siteSystemPrompt: string | null,
  trackerBusinessId: string | null,
  codAvailable?: boolean | null,
  channel: Channel = 'chat',
  siteId?: string | null
): Promise<AIResult> {
  // Newest first, then flipped back into reading order.
  const recent = await query<StoredMessage>(
    `SELECT sender, content, metadata
       FROM (
         SELECT sender, content, metadata, created_at, id
           FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2
       ) t
      ORDER BY created_at ASC, id ASC`,
    [conversationId, HISTORY_WINDOW]
  );

  // Saved answers are read fresh on every message, so an edit in Panel
  // Settings takes effect on the very next reply with no redeploy.
  let faqs: SavedAnswer[] = [];
  if (siteId) {
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
  const systemPrompt = buildSystemPrompt(siteSystemPrompt, codAvailable, channel, faqs);

  // Build chat history — include tool results stored in metadata
  const chatMessages: ChatCompletionMessageParam[] = [];
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
      } else {
        chatMessages.push({ role: 'assistant', content: m.content || '' });
      }
    } else if (m.sender === 'tool_result') {
      chatMessages.push({
        role: 'tool',
        tool_call_id: m.metadata?.tool_call_id || 'unknown',
        content: m.content || '',
      });
    }
  }

  const history = dropOrphanedToolCalls(chatMessages);

  // When a model dies partway through a conversation we retry the whole exchange
  // on the next model, which would otherwise re-run tools that already had side
  // effects — escalating twice, or writing the category again. Results are cached
  // per request so a mid-conversation switch replays them instead.
  const toolCache = new Map<string, { payload: unknown; persist: boolean; escalated?: boolean }>();

  const executeTool = async (tc: ChatCompletionMessageToolCall) => {
    const cacheKey = tc.function.name + ':' + (tc.function.arguments || '');
    const cached = toolCache.get(cacheKey);
    if (cached) return cached;
    const result = await runTool(tc);
    toolCache.set(cacheKey, result);
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
      console.log(`[AI] Escalation for conv ${conversationId}:`, args);
      await query(
        `UPDATE conversations
            SET status = 'human_needed', visitor_phone = $1, updated_at = now()
          WHERE id = $2`,
        [args.phone || null, conversationId]
      );
      return {
        payload: { success: true, reason: args.reason, phone: args.phone },
        persist: true,
        escalated: true,
      };
    }

    if (name === 'lookup_order') {
      console.log(`[AI] Order lookup for conv ${conversationId}:`, args);
      const result = await lookupOrder(args, trackerBusinessId || null);

      // A successful lookup is the first point at which we actually know who we
      // are talking to, so stop calling them "Visitor" in the inbox. Only the
      // real order holder's name is used — never anything the visitor typed.
      const confirmed = result.found ? result.orders[0] : null;
      if (confirmed?.customer_name) {
        const realName = String(confirmed.customer_name).replace(/\s*\.\s*$/, '').trim();
        if (realName) {
          try {
            if (args.phone) {
              await query(
                `UPDATE conversations SET visitor_name = $1, visitor_phone = $2, updated_at = now() WHERE id = $3`,
                [realName, args.phone, conversationId]
              );
            } else {
              await query(
                `UPDATE conversations SET visitor_name = $1, updated_at = now() WHERE id = $2`,
                [realName, conversationId]
              );
            }
            console.log(`[AI] Identified conv ${conversationId} as: ${realName}`);
          } catch (e) {
            console.error('[AI] could not set visitor name:', (e as Error).message);
          }
        }
      }

      return { payload: result, persist: true };
    }

    return { payload: { error: `Unknown tool: ${name}` }, persist: false };
  };

  const runWithModel = async (model: string): Promise<AIResult> => {
    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }, ...history];
    let toolCallMeta: ToolCallMeta | null = null;
    let escalated = false;
    let nudged = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await getClient().chat.completions.create({
        model,
        messages,
        tools: [ORDER_LOOKUP_TOOL, ESCALATE_TOOL, CATEGORIZE_TOOL],
        tool_choice: 'auto',
        max_tokens: 600,
      });

      const message = response.choices[0]?.message;
      const toolCalls = message?.tool_calls || [];

      if (!toolCalls.length) {
        return {
          content: stripMarkdown(message?.content || "I'm here to help! How can I assist you?"),
          toolCallMeta,
          escalated,
        };
      }

      messages.push(message as ChatCompletionMessageParam);

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
    const closing = await getClient().chat.completions.create({ model, messages, max_tokens: 600 });
    return {
      content: stripMarkdown(closing.choices[0]?.message?.content || "I'm here to help! How can I assist you?"),
      toolCallMeta,
      escalated,
    };
  };

  let lastErr: unknown = null;
  for (const model of attemptOrder()) {
    try {
      const result = await runWithModel(model);
      if (model !== activeModel) console.log(`[AI] Degraded to ${model}`);
      return result;
    } catch (err) {
      lastErr = err;
      console.error(`[AI] ${model} failed:`, (err as { status?: number })?.status || '', (err as Error)?.message);
      if (!isRetryable(err)) break;
    }
  }

  // Every model is down. The customer must never see a stack trace, a provider
  // name, or silence, so answer like a busy human and invite them to continue.
  console.error('[AI] Every model failed:', (lastErr as Error)?.message);
  return {
    content: 'Sorry, that took longer than expected on my end. Could you send that again?',
    toolCallMeta: null,
    allFailed: true,
  };
}

// The chosen model used to live in a module variable, so every deploy silently
// reverted it to the env default. It is read back from the database on boot.
export async function loadActiveModelFromDb(): Promise<void> {
  try {
    const row = await queryOne<{ value: string }>(
      `SELECT value FROM chat_settings WHERE key = 'ai_model'`
    );
    if (row?.value && AI_MODELS[row.value]) activeModel = row.value;
  } catch {
    // table not created yet — env default stands
  }
}

export async function persistActiveModel(model: string): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at)
     VALUES ('ai_model', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [model]
  );
}
