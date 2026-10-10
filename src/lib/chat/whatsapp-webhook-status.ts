// What Meta's last webhook calls looked like (owner 2026-10-10: before switching on the signature check, "kahi popat
// na ho jaye"). Memory only, one process: the last accepted call and the last refused one (a wrong
// WHATSAPP_APP_SECRET refuses every call, and customers' messages would stop arriving), so the Setup tab can say at
// once whether the secret in .env is the right one. Never stores a body or a header.
export interface WebhookSeen { at: number; reason?: string }
const g = globalThis as unknown as { __waHook?: { ok: WebhookSeen | null; refused: WebhookSeen | null; refusedCount: number } };
const state = () => (g.__waHook ||= { ok: null, refused: null, refusedCount: 0 });

export function noteWebhookOk(now = Date.now()): void { const s = state(); s.ok = { at: now }; s.refusedCount = 0; }
export function noteWebhookRefused(reason: string, now = Date.now()): void { const s = state(); s.refused = { at: now, reason }; s.refusedCount++; }
export function webhookStatus(): { lastOk: number | null; lastRefused: number | null; refusedReason: string | null; refusedSinceOk: number } {
  const s = state();
  return { lastOk: s.ok?.at ?? null, lastRefused: s.refused?.at ?? null, refusedReason: s.refused?.reason ?? null, refusedSinceOk: s.refusedCount };
}
