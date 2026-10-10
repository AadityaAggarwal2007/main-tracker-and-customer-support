// ── The AI's money on the server (owner 2026-10-10; rules in ai-credit-rules.ts) ──
// loadAiCredit: asks OpenRouter with the same key Chikki uses (AI_API_KEY, CODEX_URL) for the key's limit / spend and the
// account's credits; cached 10 minutes per process; never throws (a failure = level 'unknown' with the reason).
// aiCreditAlert: from the minute cron; when the level is warn or danger, one WhatsApp alert to the owner's number
// (WhatsApp > Setup) through the approved template "shiptrack_alert", at most once per 12 hours per level (a worse
// level goes at once). Without the number or the approved template nothing is sent (the Today board still shows it).
// The key never leaves this file; nothing about it is logged.
import { query, queryOne } from '@/lib/db';
import { alertText, assessCredit, parseCredits, parseKey, type AiCredit } from './ai-credit-rules';
import { sendWhatsAppTemplate, waConfigured } from './whatsapp';
import { listTemplates } from './whatsapp-templates';
import { alertTo, templatesAccount } from './whatsapp-settings';

const TTL = 10 * 60_000;
const g = globalThis as unknown as { __aiCredit?: { at: number; v: AiCredit }; __aiCreditBusy?: boolean };

async function getJson(url: string, key: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; status: number; json: unknown }> {
  const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
}

export async function loadAiCredit(force = false, now = Date.now(), env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<AiCredit> {
  const c = g.__aiCredit;
  if (!force && c && now - c.at < TTL) return c.v;
  const base = (env.CODEX_URL || 'https://openrouter.ai/api').replace(/\/+$/, '');
  const key = env.AI_API_KEY || '';
  const day = Number(new Date(now + 330 * 60_000).toISOString().slice(8, 10));
  let v: AiCredit;
  if (!key || !/openrouter\.ai/i.test(base)) {
    v = assessCredit(null, null, day, now, !key ? 'No AI key on the server' : 'The AI is not on OpenRouter: nothing to read');
  } else {
    const [k, cr] = await Promise.all([
      getJson(`${base}/v1/key`, key, fetchImpl).catch(() => null),
      getJson(`${base}/v1/credits`, key, fetchImpl).catch(() => null),
    ]);
    const keyInfo = k?.ok ? parseKey(k.json) : null;
    const balance = cr?.ok ? parseCredits(cr.json) : null;
    const err = !keyInfo && balance === null ? `OpenRouter did not answer (${k?.status ?? 'no answer'})` : null;
    v = assessCredit(keyInfo, balance, day, now, err);
  }
  g.__aiCredit = { at: now, v };
  return v;
}

const ALERT_KEY = 'ai_credit_alert';
const RANK = { ok: 0, unknown: 0, warn: 1, danger: 2 } as const;
const AGAIN_MS = 12 * 3_600_000;

export async function aiCreditAlert(now = Date.now()): Promise<{ sent: boolean; why: string }> {
  if (g.__aiCreditBusy) return { sent: false, why: 'busy' };
  g.__aiCreditBusy = true;
  try {
    const c = await loadAiCredit(false, now);
    const text = alertText(c);
    if (!text) return { sent: false, why: c.level };
    const last = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [ALERT_KEY]).catch(() => null);
    let prev: { level?: string; at?: number } = {};
    try { prev = JSON.parse(last?.value || '{}'); } catch { /* none */ }
    const worse = RANK[c.level] > RANK[(prev.level as keyof typeof RANK) || 'ok'];
    if (!worse && prev.at && now - prev.at < AGAIN_MS) return { sent: false, why: 'already sent' };
    const to = await alertTo();
    if (!to || !waConfigured()) return { sent: false, why: 'no alert number' };
    const list = await listTemplates(await templatesAccount());
    const tpl = list.ok ? list.value.find((t) => t.name === 'shiptrack_alert' && t.status === 'APPROVED') : null;
    if (!tpl) return { sent: false, why: 'template not approved' };
    const r = await sendWhatsAppTemplate(to, tpl.name, tpl.language, [text]);
    if ('error' in r) { console.error('[ai-credit] alert not sent:', r.error); return { sent: false, why: r.error }; }
    await query(
      `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [ALERT_KEY, JSON.stringify({ level: c.level, at: now })]
    );
    console.log(`[ai-credit] alert sent (${c.level})`);
    return { sent: true, why: c.level };
  } catch (e) {
    console.error('[ai-credit] alert:', (e as Error).message);
    return { sent: false, why: 'error' };
  } finally {
    g.__aiCreditBusy = false;
  }
}
