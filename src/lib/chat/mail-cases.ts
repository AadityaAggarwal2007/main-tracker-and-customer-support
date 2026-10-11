// ── Mail cases: Active / Closed per customer (owner 2026-10-11 afternoon: "active case aur close case ... jo customer dobara
// dobara email kar rahe na unko hum log ek active case mein jaake reply ... close case") ──
// One case per sender address per mailbox, kept in chat_settings (no SQL file: the table exists; tracker_user may SELECT /
// INSERT / UPDATE, never DELETE): key `mail_case:<box id>:<address>`, value JSON { closedAt, by, byName }; a reopen by hand
// writes { closedAt: null, reopenedAt, by, byName } (an UPDATE, never a DELETE). Whether a case is Active or Closed is the
// pure rule in mail-filters.ts (caseState, owner 2026-10-11 12:45: closed when our last mark, a reply after the
// customer's newest mail or this close, is not older than theirs, the newest mail or this reopen): a reply closes the
// case by itself, a customer who writes again is Active by himself, nothing here has to change. Staff only; nothing is
// sent to the customer.
import { query, queryOne } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { actorKey } from './mail-verify';
import { caseAddress, type CasesMap, type MailCase } from './mail-filters';

export const MAIL_CASE_PREFIX = 'mail_case:';
export const mailCaseKey = (boxId: string, address: string): string => `${MAIL_CASE_PREFIX}${boxId}:${caseAddress(address)}`;

// For the log line: never the whole address ("ab***@gmail.com").
export function maskAddress(address: string): string {
  const a = caseAddress(address);
  const i = a.indexOf('@');
  if (i < 0) return a.slice(0, 2) + '***';
  return `${a.slice(0, Math.min(2, i))}***${a.slice(i)}`;
}

function parseCase(value: string | null | undefined): MailCase | null {
  try {
    const v = JSON.parse(value || '') as Partial<MailCase> | null;
    if (!v || typeof v !== 'object') return null;
    return {
      closedAt: typeof v.closedAt === 'string' && !Number.isNaN(Date.parse(v.closedAt)) ? v.closedAt : null,
      by: typeof v.by === 'string' ? v.by : undefined,
      byName: typeof v.byName === 'string' ? v.byName : undefined,
      reopenedAt: typeof v.reopenedAt === 'string' ? v.reopenedAt : null,
    };
  } catch { return null; }
}

// Every case of one mailbox, by lower-case address. A failed read is {} (the list never breaks for it).
export async function loadMailCases(boxId: string): Promise<CasesMap> {
  const out: CasesMap = {};
  try {
    const prefix = `${MAIL_CASE_PREFIX}${boxId}:`;
    const r = await query<{ key: string; value: string }>(
      `SELECT key, value FROM chat_settings WHERE key LIKE $1`, [prefix.replace(/[\\%_]/g, '\\$&') + '%']);
    for (const row of r.rows) {
      const c = parseCase(row.value);
      if (c) out[row.key.slice(prefix.length)] = c;
    }
  } catch (e) { console.error('[mail-case] read:', (e as Error).message); }
  return out;
}

export async function mailCaseOf(boxId: string, address: string): Promise<MailCase | null> {
  const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [mailCaseKey(boxId, address)]);
  return parseCase(row?.value);
}

// Close / reopen by a person. Upsert (INSERT ... ON CONFLICT DO UPDATE): a reopened case keeps its row with closedAt null.
export async function setMailCase(boxId: string, address: string, action: 'close' | 'reopen', user: AuthUser, now = new Date()): Promise<MailCase> {
  const by = actorKey(user), byName = user.displayName || user.username;
  const c: MailCase = action === 'close'
    ? { closedAt: now.toISOString(), by, byName }
    : { closedAt: null, reopenedAt: now.toISOString(), by, byName };
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [mailCaseKey(boxId, address), JSON.stringify(c)]);
  console.log(`[mail-case] box=${boxId} address=${maskAddress(address)} ${action} by ${by}`);
  return c;
}
