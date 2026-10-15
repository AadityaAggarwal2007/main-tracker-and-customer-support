// ── ShipTrack's own WhatsApp alerts survive Meta's rate limit (owner 2026-10-15: a chargeback on VASTRIKA, the alert
// number saved, and no WhatsApp came: Meta was answering "130429 Rate limit hit" for the number) ──
// Every "shiptrack_alert" send (the chargeback alert, the AI-credit alert, the chargeback-risk alert, the stuck-promise
// alert) goes through sendAlert. Alerts go FIRST (owner 2026-10-15: "chargeback aur test message sabse pehle jaye"):
//   - a pause of the number (whatsapp-pause.ts) never holds an alert back: it is sent at once;
//   - Meta answers 130429 now: the number pauses (order messages wait) and the alert waits in a queue (chat_settings
//     `wa_alert_q:<id>`) that is tried again EVERY minute, pause or not, and order messages wait while any alert does;
//   - Meta takes it: its message id is kept (`wa_alert_sent:<wamid>`, 12 hours) so a LATER failed delivery report with
//     130429 (noteAlertStatus, from the webhook) puts it back in the queue; a chargeback alert's own line in ShipTrack
//     follows ("WhatsApp waiting ...", "WhatsApp delivered", "WhatsApp failed: ...").
// runAlertQueue (the minute cron) sends what waits, 2 s apart, each alert at most ALERT_MAX_TRIES times and never after
// 12 hours. A queued alert answers like a sent one (`ok: true, id: null`), so the
// callers' "one alert a day / per order" claims stay as they were. Never throws.
import { randomUUID } from 'crypto';
import { query, queryOne } from '@/lib/db';
import { sendWhatsAppTemplate, type WaSendResult } from '@/lib/chat/whatsapp';
import { isRateLimited, SEND_GAP_MS } from '@/lib/chat/whatsapp-auto-rules';
import { pauseWhatsApp } from '@/lib/chat/whatsapp-pause';

export interface AlertJob { to: string; name: string; language: string; text: string; chargebackId?: string | null; tries?: number; first?: string }
const SENT = 'wa_alert_sent:';
const QUEUE = 'wa_alert_q:';
export const ALERT_KEEP_MS = 12 * 3600 * 1000;
// An alert is tried once a minute while Meta refuses: up to two hours of tries (then the 12-hour limit still holds).
export const ALERT_MAX_TRIES = 120;
export const ALERT_WAITING = 'waiting: Meta refused it for a moment (rate limit 130429); it is tried again every minute';

let gap = SEND_GAP_MS;
export function setAlertGap(ms: number): void { gap = ms; }

async function setChargeback(id: string | null | undefined, status: string, onlyFrom?: string[]): Promise<void> {
  if (!id) return;
  try {
    await query(
      `UPDATE chargeback_alerts SET notify_status = $2 WHERE id::text = $1${onlyFrom ? ' AND (notify_status = ANY($3) OR notify_status LIKE \'waiting%\')' : ''}`,
      onlyFrom ? [id, status, onlyFrom] : [id, status]);
  } catch { /* the alert's line only */ }
}

async function enqueue(job: AlertJob): Promise<void> {
  try {
    const { done: _d, ...clean } = job as AlertJob & { done?: boolean };   // a job taken from the queue carries done: never into a new entry
    void _d;
    const value = JSON.stringify({ ...clean, first: job.first || new Date().toISOString() });
    await query(`INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING`, [QUEUE + randomUUID(), value]);
  } catch (e) { console.error('[wa-alert] queue:', (e as Error).message); }
}

// One alert to one number: sent, queued (both ok), or Meta's refusal.
export async function sendAlert(job: AlertJob): Promise<WaSendResult> {
  const tries = (job.tries || 0) + 1;
  const r = await sendWhatsAppTemplate(job.to, job.name, job.language, [job.text]);
  if (!('error' in r)) {
    if (r.id) {
      await query(`INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING`,
        [SENT + r.id, JSON.stringify({ ...job, tries, first: job.first || new Date().toISOString() })]).catch(() => undefined);
    }
    return r;
  }
  if (isRateLimited(r.code, r.error) && tries < ALERT_MAX_TRIES) {
    await pauseWhatsApp(`${r.code ?? ''} ${r.error}`.trim());
    await enqueue({ ...job, tries });
    return { ok: true, id: null };
  }
  return r;
}

// How many alerts wait (order messages hold back while any does: alerts first). A failed read = none.
export async function alertsWaiting(): Promise<number> {
  try {
    const r = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM chat_settings WHERE key LIKE $1 AND (CASE WHEN key LIKE $1 THEN value::jsonb->>'done' END) IS NULL`, [QUEUE + '%']);
    return Number(r?.n || 0);
  } catch { return 0; }
}

// Meta's later delivery report for one of our alerts (whatsapp-inbound.ts storeWaStatus). false = not an alert.
export async function noteAlertStatus(waId: string, status: string, error: string | null): Promise<boolean> {
  if (!waId) return false;
  let job: AlertJob | null = null;
  try {
    const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [SENT + waId]);
    job = row ? JSON.parse(row.value) as AlertJob : null;
  } catch { job = null; }
  if (!job) return false;
  if (status === 'failed') {
    const tries = job.tries || 1;
    const fresh = Date.now() - (Date.parse(job.first || '') || 0) < ALERT_KEEP_MS;
    if (isRateLimited(null, error) && tries < ALERT_MAX_TRIES && fresh) {
      await pauseWhatsApp(String(error || '130429 rate limit'));
      await enqueue({ ...job, tries });
      await setChargeback(job.chargebackId, ALERT_WAITING);
    } else {
      await setChargeback(job.chargebackId, `failed: ${String(error || 'WhatsApp could not deliver it').slice(0, 160)}`);
    }
  } else if (status === 'delivered' || status === 'read') {
    await setChargeback(job.chargebackId, status, ['sent', 'delivered']);
  }
  return true;
}

// The alerts that wait (the minute cron), pause or not. Each one is claimed first (both processes).
export async function runAlertQueue(now = Date.now()): Promise<number> {
  let sent = 0;
  try {
    const rows = await query<{ key: string }>(
      `SELECT key FROM chat_settings WHERE key LIKE $1 AND (CASE WHEN key LIKE $1 THEN value::jsonb->>'done' END) IS NULL ORDER BY updated_at ASC LIMIT 10`, [QUEUE + '%']);
    for (const { key } of rows.rows) {
      const claim = await queryOne<{ value: string }>(
        `UPDATE chat_settings SET value = (value::jsonb || '{"done":true}'::jsonb)::text, updated_at = now()
          WHERE key = $1 AND (value::jsonb->>'done') IS NULL RETURNING value`, [key]).catch(() => null);
      if (!claim) continue;
      let job: AlertJob;
      try { const { done: _d, ...j } = JSON.parse(claim.value) as AlertJob & { done?: boolean }; void _d; job = j; } catch { continue; }
      if (now - (Date.parse(job.first || '') || 0) > ALERT_KEEP_MS) {
        await setChargeback(job.chargebackId, 'failed: WhatsApp stayed rate limited for 12 hours, so the alert was dropped');
        continue;
      }
      if (sent > 0 && gap > 0) await new Promise((r) => setTimeout(r, gap));
      const r = await sendAlert(job);
      if ('error' in r) await setChargeback(job.chargebackId, `failed: ${r.error.slice(0, 160)}`);
      else if (r.id) { sent++; await setChargeback(job.chargebackId, 'sent'); }
    }
  } catch (e) { console.error('[wa-alert] queue run:', (e as Error).message); }
  return sent;
}
