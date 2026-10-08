import { query, queryOne } from '@/lib/db';
import { GATEWAY_KEYS, whatsappNumber } from './parse';
import { getMailboxStatus } from '@/lib/chat/mailbox-status';

// ── Chargeback data (chargeback.sql) ──────────────────────────────────────────────────────────
// Super Admin only (the routes check). Every read tolerates the SQL not being applied yet (42P01): the
// inbox and the admin page must never break because of this feature.
const missing = (e: unknown) => (e as { code?: string })?.code === '42P01';

export interface AlertRow {
  id: string; business_id: string; panel_name: string | null; received_at: string; from_address: string; from_name: string;
  subject: string; snippet: string; gateway: string; order_id: string | null; status: 'new' | 'seen' | 'done';
  seen_by_name: string | null; seen_at: string | null; done_by_name: string | null; done_at: string | null; note: string | null;
  notify_status: string; chat_id: string | null;
}

export async function alertCounts(): Promise<{ installed: boolean; new: number; open: number }> {
  try {
    const r = await queryOne<{ n: number; o: number }>(
      `SELECT count(*) FILTER (WHERE status = 'new')::int AS n, count(*) FILTER (WHERE status <> 'done')::int AS o FROM chargeback_alerts`);
    return { installed: true, new: r?.n ?? 0, open: r?.o ?? 0 };
  } catch (e) {
    if (!missing(e)) console.error('[chargeback] counts:', (e as Error).message);
    return { installed: !missing(e), new: 0, open: 0 };
  }
}

export async function listAlerts(view: 'open' | 'done' | 'all', limit = 100): Promise<{ installed: boolean; alerts: AlertRow[] }> {
  try {
    const r = await query<AlertRow>(
      `SELECT a.id, a.business_id, b.name AS panel_name, a.received_at, a.from_address, a.from_name, a.subject, a.snippet,
              a.gateway, a.order_id, a.status, a.seen_by_name, a.seen_at, a.done_by_name, a.done_at, a.note, a.notify_status,
              (SELECT c.id FROM conversations c JOIN sites s ON s.id = c.site_id
                WHERE a.order_id IS NOT NULL AND s.tracker_business_id::text = a.business_id AND c.verified_order_id = a.order_id AND c.merged_into IS NULL
                ORDER BY (c.source = 'chat') DESC, c.last_message_at DESC NULLS LAST LIMIT 1) AS chat_id
         FROM chargeback_alerts a LEFT JOIN businesses b ON b.id::text = a.business_id
        WHERE ($1 = 'all' OR ($1 = 'open' AND a.status <> 'done') OR ($1 = 'done' AND a.status = 'done'))
        ORDER BY (a.status = 'new') DESC, a.received_at DESC
        LIMIT $2`,
      [view, Math.min(Math.max(limit, 1), 200)]
    );
    return { installed: true, alerts: r.rows };
  } catch (e) {
    if (missing(e)) return { installed: false, alerts: [] };
    throw e;
  }
}

// Opening an alert marks it seen (once); "Done" closes it with an optional note. The red tag in the chat goes with Done.
export async function setAlertStatus(id: string, status: 'seen' | 'done', byName: string, note?: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const r = status === 'seen'
    ? await query(`UPDATE chargeback_alerts SET status = 'seen', seen_by_name = $2, seen_at = now() WHERE id = $1 AND status = 'new'`, [id, byName])
    : await query(`UPDATE chargeback_alerts SET status = 'done', done_by_name = $2, done_at = now(), note = NULLIF($3, '') WHERE id = $1 AND status <> 'done'`, [id, byName, (note || '').slice(0, 500)]);
  return (r.rowCount ?? 0) > 0;
}

// For the inbox: which (panel, order) pairs have an open chargeback. One light query after the list; a failure is "none".
export async function openChargebackKeys(pairs: { business_id: string | null; order_id: string | null }[]): Promise<Set<string>> {
  const wanted = pairs.filter(p => p.business_id && p.order_id);
  const out = new Set<string>();
  if (wanted.length === 0) return out;
  try {
    const r = await query<{ business_id: string; order_id: string }>(
      `SELECT DISTINCT business_id, order_id FROM chargeback_alerts
        WHERE status <> 'done' AND order_id = ANY($1::text[]) AND business_id = ANY($2::text[])`,
      [wanted.map(p => p.order_id), Array.from(new Set(wanted.map(p => String(p.business_id))))]
    );
    for (const x of r.rows) out.add(`${x.business_id}|${x.order_id}`);
  } catch (e) {
    if (!missing(e)) console.error('[chargeback] open keys:', (e as Error).message);
  }
  return out;
}
export const chargebackKey = (businessId: string | null | undefined, orderId: string | null | undefined) => `${businessId}|${orderId}`;

// ── per panel: the mailbox, the WhatsApp number and the gateway checklist ──
export interface GatewayMark { done: boolean; by: string; at: string }
export interface PanelChargeback {
  installed: boolean;
  mailbox: { id: string; email: string; createdAt: string; status: ReturnType<typeof getMailboxStatus> } | null;
  whatsapp: string;
  gateways: Record<string, GatewayMark>;
}

export async function panelChargeback(businessId: string): Promise<PanelChargeback> {
  const out: PanelChargeback = { installed: true, mailbox: null, whatsapp: '', gateways: {} };
  try {
    const m = await queryOne<{ id: string; email: string; created_at: string }>(`SELECT id, email, created_at FROM chargeback_mailboxes WHERE business_id = $1`, [businessId]);
    if (m) out.mailbox = { id: m.id, email: m.email, createdAt: new Date(m.created_at).toISOString(), status: getMailboxStatus(`cb:${m.id}`) };
    const s = await queryOne<{ whatsapp_number: string; gateways: Record<string, GatewayMark> }>(`SELECT whatsapp_number, gateways FROM panel_chargeback WHERE business_id = $1`, [businessId]);
    if (s) { out.whatsapp = s.whatsapp_number || ''; out.gateways = s.gateways || {}; }
  } catch (e) {
    if (missing(e)) out.installed = false; else throw e;
  }
  return out;
}

export async function savePanelSettings(
  businessId: string, byName: string,
  change: { whatsapp?: unknown; gateway?: { key: unknown; done: unknown } },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const cur = await panelChargeback(businessId);
  if (!cur.installed) return { ok: false, status: 503, error: 'Chargeback protection is not installed yet (chargeback.sql).' };
  let whatsapp = cur.whatsapp;
  const gateways = { ...cur.gateways };
  if (change.whatsapp !== undefined) {
    const raw = typeof change.whatsapp === 'string' ? change.whatsapp.trim() : '';
    if (raw === '') whatsapp = '';
    else {
      const n = whatsappNumber(raw);
      if (!n) return { ok: false, status: 400, error: 'That does not look like a WhatsApp number. Type it with the country code, e.g. 919876543210.' };
      whatsapp = n;
    }
  }
  if (change.gateway) {
    const key = String(change.gateway.key);
    if (!GATEWAY_KEYS.includes(key) || typeof change.gateway.done !== 'boolean') return { ok: false, status: 400, error: 'Unknown gateway.' };
    gateways[key] = { done: change.gateway.done, by: byName, at: new Date().toISOString() };
  }
  await query(
    `INSERT INTO panel_chargeback (business_id, whatsapp_number, gateways, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, now(), $4)
     ON CONFLICT (business_id) DO UPDATE SET whatsapp_number = EXCLUDED.whatsapp_number, gateways = EXCLUDED.gateways, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [businessId, whatsapp, JSON.stringify(gateways), byName]
  );
  return { ok: true };
}
