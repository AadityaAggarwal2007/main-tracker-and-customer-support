import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { query, queryOne } from '@/lib/db';

// Every model here was swept against the real system prompt and tool schema on
// 2026-09-05 and cleared the checks that cannot be recovered from: it never
// repeated the customer's city or state back to them, and it refused to look up
// an order from an order number alone. Escalation and tool-result scores vary a
// little between models, which is fine — a missed escalation just means the bot
// asks for the number again and the customer repeats it. DeepSeek V3, the
// incumbent, itself scores 4/5, so 4/5 is the working baseline, not a defect.
export const AI_MODELS: Record<string, { name: string; free: boolean }> = {
  'deepseek/deepseek-v4-pro': { name: 'DeepSeek V4 Pro', free: false },
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
// 2026-10-01: deepseek-v4-flash stopped answering verified customers (it called lookup_order again
// and again and then sent only the greeting; 10+ of 37 golden conversations failed, with the old
// prompt too). On the same tests V4 Pro passed 36/37, V3 36/37. Owner chose V4 Pro.
const FALLBACK_CHAIN = [
  'deepseek/deepseek-v4-pro',
  // (History) V4 Flash measured 2026-09-21 on OpenRouter at $0.057/M in, $0.114/M out —
  // roughly 6x cheaper in and 8x cheaper out than V3 (the previous default),
  // with a 1M context. That headroom is what pays for the longer prompt.
  'deepseek/deepseek-chat',
  'deepseek/deepseek-v4-flash',
  'openai/gpt-4.1-mini',
  'openai/gpt-4o',
];

// Degrade by default. Almost every failure is specific to one model — a retired
// or mistyped id, a rejected tool schema, a rate limit, a provider outage — and
// the next model in the chain would have served the request fine. Only auth
// failures are hopeless, since every model would fail them the same way. Note
// 402 (out of credits) still degrades: the free tiers keep working without them.
export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status !== 401 && status !== 403;
}

// A model that answered with no text and no tool call. It is a model failure
// like any other (502, so isRetryable passes it on): the next model gets the
// request instead of the customer getting a blank bubble or a filler line.
export class BlankReplyError extends Error {
  status = 502;
  constructor(model: string, finish: string | null | undefined) {
    super(`blank reply (finish=${finish})`);
    console.log(`[AI] ${model} sent a blank reply (finish=${finish})`);
  }
}

// On 2026-09-29 deepseek-v4-flash sometimes spent all of max_tokens=600 on
// reasoning (usage 7877/600, finish=length) and sent only whitespace, which
// went out as 71 blank replies in a day. A normal turn reasons for ~30 tokens
// and only generated tokens are billed, so the headroom costs nothing until
// it is needed.
export const MAX_REPLY_TOKENS = 1500;

// deepseek-v4-flash thinks before it answers unless told not to, and with the long prompt
// and history it often spent all of MAX_REPLY_TOKENS on thinking (usage ~8000/1500,
// finish=length) and sent nothing. Each such blank moved the customer to a weaker model
// (deepseek-chat), which then answered an old question, asked for the order again, or
// went to Needs you (seen 2026-10-01 on several chats). The prompt and the test sweeps
// were all run with thinking off, so this is what was tested. An OpenRouter field the SDK
// does not type; other providers ignore it.
export function withoutThinking<T extends object>(model: string, params: T): ChatCompletionCreateParamsNonStreaming {
  const body = model.startsWith('deepseek/deepseek-v4') ? { ...params, reasoning: { enabled: false } } : params;
  return body as unknown as ChatCompletionCreateParamsNonStreaming;
}

// High and Max effort (effort.ts): the model thinks before it writes, with more room
// (thinking counts against max_tokens). Normal is withoutThinking with MAX_REPLY_TOKENS, as
// every reply was before 2026-10-01. Models without a thinking switch just get the room.
export function withThinking<T extends object>(model: string, params: T, maxTokens: number): ChatCompletionCreateParamsNonStreaming {
  const body = model.startsWith('deepseek/deepseek-v4')
    ? { ...params, max_tokens: maxTokens, reasoning: { enabled: true } }
    : { ...params, max_tokens: maxTokens };
  return body as unknown as ChatCompletionCreateParamsNonStreaming;
}
// A thinking call that takes longer than this is dropped and asked again without thinking,
// so the customer still gets a reply well inside the widget's 60 s (nginx).
export const THINKING_TIMEOUT_MS = 30_000;
// The Max self-check: one short call; a slower one is skipped and the draft goes as it was.
export const SELF_CHECK_TIMEOUT_MS = 15_000;
export const SELF_CHECK_MAX_TOKENS = 800;

let activeModel = process.env.AI_MODEL || FALLBACK_CHAIN[0];

export function attemptOrder(): string[] {
  return [activeModel, ...FALLBACK_CHAIN.filter((m) => m !== activeModel)];
}

export function getClient(): OpenAI {
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
