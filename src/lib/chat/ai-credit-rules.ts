// ── How much AI money is left (owner 2026-10-10: "A se shuru", after the Chikki review showed every "took longer" in 30
// days came from OpenRouter: 402 out of credits, 403 the key's monthly limit, on 6 different days) ──
// Pure. OpenRouter answers two questions with the same API key: GET /v1/key (this key: its limit, what is left of it,
// what it spent today / this week / this month) and GET /v1/credits (the account: credits bought and used). Chikki stops
// when EITHER runs out, so what counts is the smaller of the two, and how many days that lasts at the recent spend.
// The Today board shows it; a WhatsApp alert goes to the owner before it runs out (ai-credit.ts).

export type CreditLevel = 'ok' | 'warn' | 'danger' | 'unknown';
export interface AiCredit {
  level: CreditLevel;
  balance: number | null;          // account credits left (USD), null = not readable
  keyLimit: number | null;         // the key's limit (USD), null = no limit
  keyLeft: number | null;          // what is left of it
  keyReset: string | null;         // 'monthly' / 'weekly' / 'daily' / null
  perDay: number | null;           // recent spend per day (USD)
  daysLeft: number | null;         // the smaller of the two, at that spend
  binding: 'credits' | 'key' | null;   // which one runs out first
  lines: { tone: 'warn' | 'danger'; text: string }[];
  checkedAt: number | null;
  error: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const data = (j: unknown): Record<string, unknown> | null => {
  const d = j && typeof j === 'object' ? (j as Record<string, unknown>).data : null;
  return d && typeof d === 'object' ? d as Record<string, unknown> : null;
};

export interface KeyInfo { limit: number | null; left: number | null; reset: string | null; daily: number | null; weekly: number | null; monthly: number | null; usage: number | null }
export function parseKey(j: unknown): KeyInfo | null {
  const d = data(j);
  if (!d) return null;
  return {
    limit: num(d.limit), left: num(d.limit_remaining), reset: typeof d.limit_reset === 'string' ? d.limit_reset : null,
    daily: num(d.usage_daily), weekly: num(d.usage_weekly), monthly: num(d.usage_monthly), usage: num(d.usage),
  };
}
export function parseCredits(j: unknown): number | null {
  const d = data(j);
  if (!d) return null;
  const total = num(d.total_credits), used = num(d.total_usage);
  return total === null || used === null ? null : Math.round((total - used) * 100) / 100;
}

// Spend per day: the last week's average (today alone is a partial day), else this month's, else today's.
export function perDay(k: KeyInfo | null, dayOfMonth: number): number | null {
  if (!k) return null;
  if (k.weekly !== null && k.weekly > 0) return k.weekly / 7;
  if (k.monthly !== null && k.monthly > 0) return k.monthly / Math.max(1, dayOfMonth);
  if (k.daily !== null && k.daily > 0) return k.daily;
  return null;
}

export const WARN_DAYS = 5, DANGER_DAYS = 2, WARN_USD = 8, DANGER_USD = 2;
const usd = (n: number) => `$${n.toFixed(2)}`;

export function assessCredit(k: KeyInfo | null, balance: number | null, dayOfMonth: number, now: number, error: string | null = null): AiCredit {
  const spend = perDay(k, dayOfMonth);
  const keyLeft = k && k.limit !== null ? (k.left ?? Math.max(0, k.limit - (k.usage ?? 0))) : null;
  const sides: { kind: 'credits' | 'key'; left: number }[] = [];
  if (balance !== null) sides.push({ kind: 'credits', left: balance });
  if (keyLeft !== null) sides.push({ kind: 'key', left: keyLeft });
  const base: AiCredit = { level: 'unknown', balance, keyLimit: k?.limit ?? null, keyLeft, keyReset: k?.reset ?? null, perDay: spend, daysLeft: null, binding: null, lines: [], checkedAt: now, error };
  if (!sides.length) return base;
  const tight = sides.reduce((a, b) => (b.left < a.left ? b : a));
  const days = spend && spend > 0 ? tight.left / spend : null;
  const level: CreditLevel = tight.left <= DANGER_USD || (days !== null && days < DANGER_DAYS) ? 'danger'
    : tight.left <= WARN_USD || (days !== null && days < WARN_DAYS) ? 'warn' : 'ok';
  const lines: AiCredit['lines'] = [];
  if (level !== 'ok') {
    const when = days !== null ? `, about ${days < 1 ? 'less than a day' : `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}`} at ${usd(spend!)} a day` : '';
    const tone = level === 'danger' ? 'danger' : 'warn';
    if (tight.kind === 'credits') lines.push({ tone, text: `OpenRouter credits: ${usd(tight.left)} left${when}. Recharge at openrouter.ai (Credits), and turn on Auto top-up.` });
    else lines.push({ tone, text: `The AI key's ${k?.reset ? `${k.reset} ` : ''}limit: ${usd(tight.left)} of ${usd(k!.limit!)} left${when}. Raise or remove the limit at openrouter.ai (Keys).` });
  }
  return { ...base, level, daysLeft: days === null ? null : Math.round(days * 10) / 10, binding: tight.kind, lines };
}

// The one line the WhatsApp alert carries (a template variable: no new lines, at most 4 spaces in a row).
export function alertText(c: AiCredit): string | null {
  if (c.level !== 'warn' && c.level !== 'danger') return null;
  return (c.lines[0]?.text || 'OpenRouter credits are low.').replace(/\s+/g, ' ').slice(0, 300);
}
