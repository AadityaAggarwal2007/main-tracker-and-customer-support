import { query } from '@/lib/db';
import { OVERDUE_MS } from './corrections-rules';

// ── Corrections: the light reads (owner 2026-10-11) ────────────────────────────────────────────────
// The reads the inbox list, the open thread, the Mail tab and the Today board add AFTER their own query, like the
// chargeback tag (openChargebackKeys): one small query each, never inside the list, and a missing table
// (order-corrections.sql not run yet, 42P01) or a failed read means "none" / zero, never a broken inbox. Imports
// only the database: the board's and the route suites' fakes answer it with nothing. The writes and the full list
// (with rights) are in corrections.ts.

export interface CorrectionRow {
  id: string; business_id: string; source: 'chat' | 'email' | 'mail';
  conversation_id: string | null; mail_box_id: string | null; mail_uid: number | null; customer_email: string | null;
  order_id: string; kinds: string[]; note: string; status: 'pending' | 'done' | 'cancelled';
  created_by: string | null; created_by_name: string | null; created_at: string;
  done_by: string | null; done_by_name: string | null; done_at: string | null; done_note: string | null;
  updated_at: string;
}

export const CORRECTION_COLS = `x.id::text AS id, x.business_id, x.source, x.conversation_id, x.mail_box_id, x.mail_uid::int AS mail_uid, x.customer_email,
            x.order_id, x.kinds, x.note, x.status, x.created_by, x.created_by_name, x.created_at, x.done_by, x.done_by_name, x.done_at, x.done_note, x.updated_at`;

export const missingCorrections = (e: unknown) => (e as { code?: string })?.code === '42P01';

// ── Active / Changed (owner 2026-10-12: "kuch bhi changes ke baad ... replied aur active jaisa segment") ──────────
// A pending correction is CHANGED once the team edited that order's address or items in ShipTrack AFTER the correction
// was written (order_address_changes / order_item_changes, the Edit address / Edit items history, same panel); else it
// is ACTIVE. Nothing is stored: a Changed row still waits for Mark done. The badge, the row chip and the Today board
// count Active only. The two history tables come with order-address-edit.sql / order-items-edit.sql; if one is missing
// (42P01 naming it) every read falls back to "nothing changed".
const changeWhere = (alias: string) =>
  `${alias}.order_id = x.order_id AND ${alias}.business_id::text = x.business_id AND ${alias}.created_at > x.created_at`;
export const CHANGED_SQL = `(EXISTS (SELECT 1 FROM order_address_changes ca WHERE ${changeWhere('ca')}) OR EXISTS (SELECT 1 FROM order_item_changes ci WHERE ${changeWhere('ci')}))`;
// The list's three columns: when the address / the items were last changed after the correction, and by whom (the latest).
export const CHANGE_COLS = `(SELECT max(ca.created_at) FROM order_address_changes ca WHERE ${changeWhere('ca')}) AS address_changed_at,
              (SELECT max(ci.created_at) FROM order_item_changes ci WHERE ${changeWhere('ci')}) AS items_changed_at,
              (SELECT z.n FROM (SELECT ca.created_at AS t, ca.changed_by_name AS n FROM order_address_changes ca WHERE ${changeWhere('ca')}
                                UNION ALL SELECT ci.created_at, ci.changed_by_name FROM order_item_changes ci WHERE ${changeWhere('ci')}) z
                ORDER BY z.t DESC LIMIT 1) AS changed_by_name`;
export const NO_CHANGE_COLS = `NULL::timestamptz AS address_changed_at, NULL::timestamptz AS items_changed_at, NULL::text AS changed_by_name`;
const missingChangeTable = (e: unknown) => missingCorrections(e) && /order_(address|item)_changes/.test(String((e as Error)?.message || ''));
// Runs the SQL with the change test; without the history tables, with "nothing changed".
export async function withChanges<T>(build: (changed: string, cols: string) => string, params: unknown[]): Promise<{ rows: T[] }> {
  try { return await query<T>(build(CHANGED_SQL, CHANGE_COLS), params); }
  catch (e) { if (missingChangeTable(e)) return query<T>(build('false', NO_CHANGE_COLS), params); throw e; }
}
const quiet = (what: string, e: unknown) => { if (!missingCorrections(e)) console.error(`[correction] ${what}:`, (e as Error).message); };

// The open chat's own corrections, newest first (the thread's answer `corrections`; pending and done).
export async function listForConversation(conversationId: string): Promise<CorrectionRow[]> {
  try {
    const r = await query<CorrectionRow>(
      `SELECT ${CORRECTION_COLS} FROM order_corrections x WHERE x.conversation_id = $1 ORDER BY (x.status = 'pending') DESC, x.created_at DESC LIMIT 20`,
      [conversationId]);
    return r.rows;
  } catch (e) { quiet('thread', e); return []; }
}

// The open mail's own corrections (the Mail tab's "Correction pending" line).
export async function listForMail(boxId: string, uid: number): Promise<CorrectionRow[]> {
  try {
    const r = await query<CorrectionRow>(
      `SELECT ${CORRECTION_COLS} FROM order_corrections x WHERE x.mail_box_id = $1 AND x.mail_uid = $2 ORDER BY (x.status = 'pending') DESC, x.created_at DESC LIMIT 20`,
      [boxId, uid]);
    return r.rows;
  } catch (e) { quiet('mail', e); return []; }
}

// For the inbox rows: which of these chats carry an ACTIVE correction (the small "Correction" chip).
export async function pendingCorrectionConvIds(conversationIds: (string | null | undefined)[]): Promise<Set<string>> {
  const ids = Array.from(new Set(conversationIds.filter((x): x is string => !!x)));
  const out = new Set<string>();
  if (ids.length === 0) return out;
  try {
    const r = await withChanges<{ conversation_id: string }>((changed) =>
      `SELECT DISTINCT x.conversation_id FROM order_corrections x WHERE x.status = 'pending' AND NOT ${changed} AND x.conversation_id = ANY($1::text[])`, [ids]);
    for (const row of r.rows) out.add(row.conversation_id);
  } catch (e) { quiet('row chips', e); }
  return out;
}

// For the sidebar badge: ACTIVE corrections in the login's panels (null = every panel). A failure is 0.
export async function pendingCorrectionCount(scope: string[] | null): Promise<number> {
  try {
    const r = await withChanges<{ n: number }>((changed) =>
      `SELECT count(*)::int AS n FROM order_corrections x WHERE x.status = 'pending' AND NOT ${changed} AND ($1::text[] IS NULL OR x.business_id = ANY($1::text[]))`, [scope]);
    return r.rows[0]?.n ?? 0;
  } catch (e) { quiet('count', e); return 0; }
}

// For the Today board: ACTIVE corrections and those over 24 h per panel. A missing table = an empty map (zero everywhere).
export async function correctionsByPanel(businessIds: string[]): Promise<Map<string, { pending: number; overdue: number }>> {
  const out = new Map<string, { pending: number; overdue: number }>();
  if (businessIds.length === 0) return out;
  try {
    const r = await withChanges<{ business_id: string; pending: number; overdue: number }>((changed) =>
      `SELECT x.business_id, count(*)::int AS pending,
              count(*) FILTER (WHERE x.created_at <= now() - interval '${Math.round(OVERDUE_MS / 3600000)} hours')::int AS overdue
         FROM order_corrections x WHERE x.status = 'pending' AND NOT ${changed} AND x.business_id = ANY($1::text[]) GROUP BY x.business_id`, [businessIds]);
    for (const row of r.rows) out.set(String(row.business_id), { pending: Number(row.pending) || 0, overdue: Number(row.overdue) || 0 });
  } catch (e) { quiet('board', e); }
  return out;
}
