// ── Is Chikki able to answer right now? (owner 2026-10-10: OpenRouter's credits ran out at night and for three hours
// every visitor on every panel got "Sorry, that took longer than expected" and nobody knew) ──
// Memory only, one PM2 process: getAIResponse notes every "every model failed" and every reply that went out, and the
// Today board shows a red banner while the last failure is newer than the last success. Pure except the two notes.

export type AiReason = 'credits' | 'auth' | 'rate' | 'timeout' | 'down';
export interface AiHealth {
  ok: boolean;                 // the last thing that happened was a reply, or nothing has happened yet
  reason: AiReason | null;     // why the last failure happened, in one word
  detail: string;              // the first line of the provider's message, safe for the screen (no key, no link)
  lastFailAt: number | null;
  lastOkAt: number | null;
  failsLastHour: number;
}

const state = { lastFailAt: null as number | null, lastOkAt: null as number | null, reason: null as AiReason | null, detail: '', fails: [] as number[] };

// The provider's status and message, read into one word. 402 "requires more credits" = the OpenRouter balance or the
// key's monthly limit; 401 / 403 = the key; 429 = rate limit; a timeout = too slow; anything else = down.
export function aiReasonOf(status: number | undefined, message: string): AiReason {
  const m = (message || '').toLowerCase();
  if (status === 402 || /more credits|insufficient credits|monthly limit|quota/.test(m)) return 'credits';
  if (status === 401 || status === 403 || /invalid api key|unauthori[sz]ed|forbidden/.test(m)) return 'auth';
  if (status === 429 || /rate limit/.test(m)) return 'rate';
  if (/timed? ?out|timeout/.test(m)) return 'timeout';
  return 'down';
}
// The first sentence of the provider's message without URLs, key ids or the token numbers nobody on the screen needs.
export function aiDetailOf(message: string): string {
  return (message || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').split(/[.!]\s/)[0].trim().slice(0, 140);
}
export const AI_REASON_TEXT: Record<AiReason, string> = {
  credits: 'OpenRouter credits are finished or the key\'s monthly limit is reached: recharge at openrouter.ai and check the key\'s limit',
  auth: 'OpenRouter refuses the API key (AI_API_KEY in /etc/tracker/.env)',
  rate: 'OpenRouter is rate-limiting the key',
  timeout: 'the models are not answering in time',
  down: 'every model failed',
};

export function noteAiFailure(status: number | undefined, message: string, now = Date.now()): void {
  state.lastFailAt = now; state.reason = aiReasonOf(status, message); state.detail = aiDetailOf(message);
  state.fails = state.fails.filter(t => now - t < 3_600_000); state.fails.push(now);
}
export function noteAiSuccess(now = Date.now()): void { state.lastOkAt = now; }
export function aiHealth(now = Date.now()): AiHealth {
  const fails = state.fails.filter(t => now - t < 3_600_000);
  const failing = state.lastFailAt !== null && (state.lastOkAt === null || state.lastFailAt > state.lastOkAt);
  return { ok: !failing, reason: failing ? state.reason : null, detail: failing ? state.detail : '', lastFailAt: state.lastFailAt, lastOkAt: state.lastOkAt, failsLastHour: fails.length };
}
export function resetAiHealth(): void { state.lastFailAt = null; state.lastOkAt = null; state.reason = null; state.detail = ''; state.fails = []; }
