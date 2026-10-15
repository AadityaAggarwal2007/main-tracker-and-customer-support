// ── Another app on the WhatsApp number: the counter (owner 2026-10-15; the rules and the words are in
// whatsapp-foreign-rules.ts) ──
// storeWaStatus (whatsapp-inbound.ts) calls noteForeignStatus for a delivery report that matched none of our messages.
// It never blocks the webhook's fast 200: the work runs after FOREIGN_RECHECK_MS (a report can reach us before our own
// send wrote the wamid), looks AGAIN in messages / wa_auto_sends / the alert and test records, and only then adds the
// report to today's row `wa_foreign:<India day>` with ONE atomic INSERT ... ON CONFLICT DO UPDATE in jsonb (both PM2
// processes add up, nothing is lost). Never throws. A failed read of one table = not ours by that table.
import { query, queryOne } from '@/lib/db';
import { FOREIGN_RECHECK_MS, foreignAdd, foreignKey, foreignSummary, parseForeignDay, type ForeignToday } from './whatsapp-foreign-rules';
import { codeIn, failureSide } from './whatsapp-auto-rules';
import { safetyStop } from './whatsapp-safety-stop';

export const ALERT_SENT_PREFIX = 'wa_alert_sent:';
export const TEST_SENT_PREFIX = 'wa_test_sent:';

let recheckMs = FOREIGN_RECHECK_MS;
export function setForeignRecheckMs(ms: number): void { recheckMs = Math.max(0, ms); }
const pending = new Set<Promise<void>>();
// Tests: wait for every report still being looked at.
export async function foreignSettled(): Promise<void> { await Promise.all([...pending]); }

// "Send both as a test" sends through the Cloud API without a row anywhere: its wamid is kept so its reports are ours.
// Since 2026-10-15 night (owner: a test said "sent" but never reached the phone and nothing recorded what Meta said) the
// record also keeps the template, the panel and the order it was filled from, and every delivery report Meta sends for
// it (noteTestStatus): the Automation tab shows the last TEST_REPORTS under the test boxes, the PM2 log one line each.
export interface TestRecord {
  to: string; at: string;                                   // the number masked to its last 4, when it was sent (ISO)
  template?: string | null; language?: string | null; panel?: string | null; panelName?: string | null; order?: string | null;
  status?: 'sent' | 'delivered' | 'read' | 'failed'; reportAt?: string | null; code?: number | null; words?: string | null;
}
export const TEST_REPORTS = 5;
const TEST_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };
export async function noteTestSent(waId: string | null | undefined, to: string, extra: Partial<TestRecord> = {}, now = Date.now()): Promise<void> {
  if (!waId) return;
  try {
    const rec: TestRecord = { template: extra.template ?? null, language: extra.language ?? null, panel: extra.panel ?? null, panelName: extra.panelName ?? null, order: extra.order ?? null, to: `••••${to.slice(-4)}`, at: new Date(now).toISOString(), status: 'sent' };
    await query(`INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING`, [TEST_SENT_PREFIX + waId, JSON.stringify(rec)]);
  } catch (e) { console.error('[whatsapp] test send record:', (e as Error).message); }
}
export function parseTestRecord(value: string | null | undefined): TestRecord | null {
  try {
    const j = JSON.parse(String(value || ''));
    if (!j || typeof j !== 'object' || typeof j.to !== 'string' || typeof j.at !== 'string') return null;
    return { to: j.to, at: j.at, template: j.template ?? null, language: j.language ?? null, panel: j.panel ?? null, panelName: j.panelName ?? null, order: j.order ?? null,
      status: TEST_RANK[j.status] ? j.status : 'sent', reportAt: j.reportAt ?? null, code: Number.isFinite(Number(j.code)) && j.code !== null && j.code !== '' ? Number(j.code) : null, words: j.words ?? null };
  } catch { return null; }
}
// Meta's delivery report for a test message (whatsapp-inbound.ts storeWaStatus): the record follows it (never backwards:
// sent -> delivered -> read; failed wins), the PM2 log says it, and a failed report on META's side (whatsapp-auto-rules.ts
// failureSide) stops the order messages like any other (the test proved the number cannot send). false = not a test.
export async function noteTestStatus(s: { id: string; status: string; error: string | null }, now = Date.now()): Promise<boolean> {
  if (!s.id || !TEST_RANK[s.status]) return false;
  let rec: TestRecord | null = null;
  try { rec = parseTestRecord((await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [TEST_SENT_PREFIX + s.id]))?.value); } catch { rec = null; }
  if (!rec) return false;
  const words = s.error ? String(s.error).replace(/[\r\n\t]+/g, ' ').slice(0, 300) : null;
  console.warn(`[whatsapp] test message to ${rec.to}: ${s.status}${words ? ` ${words}` : ''}`);
  if (TEST_RANK[s.status] > TEST_RANK[rec.status || 'sent']) {
    const next: TestRecord = { ...rec, status: s.status as TestRecord['status'], reportAt: new Date(now).toISOString(), code: s.status === 'failed' ? codeIn(null, words) : null, words: s.status === 'failed' ? words : null };
    try {
      await query(`INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [TEST_SENT_PREFIX + s.id, JSON.stringify(next)]);
    } catch (e) { console.error('[whatsapp] test report:', (e as Error).message); }
  }
  if (s.status === 'failed' && failureSide(null, words) === 'meta') {
    await safetyStop({ code: codeIn(null, words), words: words || 'WhatsApp could not deliver it', order: rec.order ?? null, kind: 'test' }, now, Date.parse(rec.at) || null);
  }
  return true;
}
// The last TEST_REPORTS test messages, newest first (the Automation tab). A failed read = none.
export async function loadTestReports(max = TEST_REPORTS): Promise<TestRecord[]> {
  try {
    const r = await query<{ value: string }>(`SELECT value FROM chat_settings WHERE key LIKE $1 ORDER BY updated_at DESC LIMIT 20`, [TEST_SENT_PREFIX + '%']);
    return r.rows.map((x) => parseTestRecord(x.value)).filter((x): x is TestRecord => !!x).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, max);
  } catch { return []; }
}

// Is this wamid one of ours? A chat message (team reply, auto reply, STOP reply, test-send), an automation row, an
// alert, a test send.
export async function isOurWaId(waId: string): Promise<boolean> {
  if (!waId) return true;   // nothing to count
  const found = async (sql: string, p: unknown[]) => { try { return !!(await queryOne(sql, p)); } catch { return false; } };
  if (await found(`SELECT 1 FROM messages WHERE metadata->>'wa_id' = $1 LIMIT 1`, [waId])) return true;
  if (await found(`SELECT 1 FROM wa_auto_sends WHERE wa_id = $1 LIMIT 1`, [waId])) return true;
  if (await found(`SELECT 1 FROM chat_settings WHERE key IN ($1, $2) LIMIT 1`, [ALERT_SENT_PREFIX + waId, TEST_SENT_PREFIX + waId])) return true;
  return false;
}

// The atomic add: the fresh row for the first report of the day; else the hour's counter (+ failed130429) and the
// top-level "last" fields in jsonb, in one statement. `value` is text in chat_settings, so it is cast both ways.
const ADD_SQL = `
  INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
  ON CONFLICT (key) DO UPDATE SET updated_at = now(), value = (
    jsonb_set(
      ('{"hours":{}}'::jsonb || COALESCE(NULLIF(chat_settings.value, '')::jsonb, '{}'::jsonb)) || $3::jsonb,
      ARRAY['hours', $4::text],
      COALESCE(chat_settings.value::jsonb #> ARRAY['hours', $4::text], '{}'::jsonb)
        || jsonb_build_object($5::text, COALESCE((chat_settings.value::jsonb #>> ARRAY['hours', $4::text, $5::text])::int, 0) + 1)
        || CASE WHEN $6::boolean THEN jsonb_build_object('failed130429', COALESCE((chat_settings.value::jsonb #>> ARRAY['hours', $4::text, 'failed130429'])::int, 0) + 1) ELSE '{}'::jsonb END,
      true)
  )::text`;
export { ADD_SQL as FOREIGN_ADD_SQL };

// The PM2 line: the first foreign report, then at most one line a minute per process with the count since (another app
// sending hundreds must not flood the log).
export const FOREIGN_LOG_EVERY_MS = 60_000;
let logAt = 0, logHeld = 0;
export function resetForeignLog(): void { logAt = 0; logHeld = 0; }

// Count one report now (the re-check already done). Exported for the tests; the webhook path uses noteForeignStatus.
export async function countForeign(status: string, error: string | null | undefined, to: string | null | undefined, nowMs = Date.now()): Promise<boolean> {
  const add = foreignAdd(status, error, to, nowMs);
  if (!add) return false;
  try {
    await query(ADD_SQL, [add.key, add.fresh, add.top, add.hour, add.status, add.rateLimited]);
    if (nowMs - logAt >= FOREIGN_LOG_EVERY_MS) {
      console.warn(`[whatsapp] a delivery report for a message ShipTrack never sent (${add.status}${add.rateLimited ? ', 130429' : ''}, to ${to ? `••••${String(to).slice(-4)}` : '?'}${logHeld ? `; ${logHeld} more since the last line` : ''}): another app may be sending from this number (WhatsApp > Automation > Number status)`);
      logAt = nowMs; logHeld = 0;
    } else logHeld++;
    return true;
  } catch (e) { console.error('[whatsapp] foreign report:', (e as Error).message); return false; }
}

// From storeWaStatus, NOT awaited: wait, look again, count. The webhook has long answered 200 by then.
export function noteForeignStatus(s: { id: string; status: string; error: string | null; recipient: string | null }, nowMs = Date.now()): Promise<void> {
  const job = (async () => {
    try {
      if (recheckMs > 0) await new Promise<void>((r) => { const t = setTimeout(r, recheckMs); (t as { unref?: () => void }).unref?.(); });
      if (await isOurWaId(s.id)) return;
      await countForeign(s.status, s.error, s.recipient, nowMs);
    } catch (e) { console.error('[whatsapp] foreign report:', (e as Error).message); }
  })();
  pending.add(job);
  void job.finally(() => pending.delete(job));
  return job;
}

// Today's summary (India day) for the Automation overview and the Today board; a failed read = nothing seen.
export async function loadForeignToday(nowMs = Date.now()): Promise<ForeignToday> {
  try {
    const r = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [foreignKey(nowMs)]);
    return foreignSummary(parseForeignDay(r?.value));
  } catch { return foreignSummary(null); }
}
