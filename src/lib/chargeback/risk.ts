// ── Chargeback Shield: the server side (owner 2026-10-10) ──
// Reads only. For the panels a login may see: every PREPAID order of the last RISK_DAYS days that is not cancelled, the
// customer's chats on every channel tied to it (the verified order, the customer key / phone, the WhatsApp number, the
// email address), their messages, the chats' health / Refund / Ship again state and the chargebacks already raised ->
// risk-rules.ts scoreOrder. Also the study: every real chargeback mail -> its order (the order number, else the email /
// phone / amount in the mail) -> what the engine would have said 3 days before and on the day. Each read is in its own
// try (a missing table only leaves its part empty); nothing is written.
import { query } from '@/lib/db';
import { chargebackKind } from './parse';
import { SIGNAL_NAME, contactCandidates, levelOf, scoreOrder, type Channel, type RiskMsg, type RiskOrder, type RiskResult, type SignalKey } from './risk-rules';

export const RISK_DAYS = 45;
const MATCH_DAYS = 120;
const missing = (e: unknown) => ['42P01', '42703'].includes((e as { code?: string })?.code || '');
async function safe<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e) { if (!missing(e)) console.error(`[risk] ${what}:`, (e as Error).message); return fallback; }
}
const digits = (s: unknown) => String(s ?? '').replace(/[^0-9]/g, '');
const NOT_COD = `NOT (lower(COALESCE(o.payment_method, '')) = 'cod' OR lower(COALESCE(o.payment_method, '')) LIKE '%cash on delivery%')`;
const ORDER_COLS = `o.order_id, o.business_id::text AS business_id, b.name AS panel_name, o.customer_name, o.created_at,
       o.estimated_delivery::text AS estimated_delivery, o.tracking_status, o.delivered_at, o.order_total::float AS total,
       lower(COALESCE(o.customer_email, '')) AS email, right(regexp_replace(COALESCE(o.customer_mobile, ''), '[^0-9]', '', 'g'), 10) AS phone10,
       o.payment_method`;

interface OrderRow {
  order_id: string; business_id: string; panel_name: string | null; customer_name: string | null; created_at: string;
  estimated_delivery: string | null; tracking_status: string | null; delivered_at: string | null; total: number;
  email: string; phone10: string; payment_method: string | null;
}
interface ChatRow {
  id: string; business_id: string; source: string; status: string; verified_order_id: string | null; customer_key: string | null;
  visitor_id: string; visitor_phone: string | null; health_score: number | null; case_kind: 'refund' | 'reship' | null;
  reshipped_at: string | null; assigned_to: string | null; last_message_at: string | null;
}
export interface RiskItem extends RiskResult {
  orderId: string; businessId: string; panelName: string; customerName: string; placedAt: string; total: number;
  status: string; chatId: string | null; holder: string | null; caseKind: 'refund' | 'reship' | null;
}

const isDelivered = (o: OrderRow) => !!o.delivered_at || String(o.tracking_status || '').trim().toLowerCase() === 'delivered';
const channelOf = (source: string): Channel => (source === 'email' ? 'email' : source === 'whatsapp' ? 'whatsapp' : 'chat');

// ── The chats and messages behind a set of orders ──
interface Gathered { chatsOf: Map<string, ChatRow[]>; msgsOf: Map<string, RiskMsg[]> }
const okey = (o: { business_id: string; order_id: string }) => `${o.business_id}|${digits(o.order_id)}`;

async function gather(orders: OrderRow[]): Promise<Gathered> {
  const chatsOf = new Map<string, ChatRow[]>(), msgsOf = new Map<string, RiskMsg[]>();
  if (!orders.length) return { chatsOf, msgsOf };
  const panels = Array.from(new Set(orders.map((o) => o.business_id)));
  const nums = Array.from(new Set(orders.map((o) => digits(o.order_id)).filter(Boolean)));
  const phones = Array.from(new Set(orders.map((o) => o.phone10).filter((p) => p.length === 10)));
  const emails = Array.from(new Set(orders.map((o) => o.email).filter((e) => e.includes('@')))).map((e) => `email:${e}`);
  const chats = await safe('chats', async () => (await query<ChatRow>(
    `SELECT c.id, s.tracker_business_id::text AS business_id, c.source, c.status, c.verified_order_id, c.customer_key, c.visitor_id,
            c.visitor_phone, c.health_score, c.case_kind, c.reshipped_at, c.assigned_to, c.last_message_at
       FROM conversations c JOIN sites s ON s.id = c.site_id
      WHERE s.tracker_business_id::text = ANY($1::text[]) AND c.merged_into IS NULL
        AND (regexp_replace(COALESCE(c.verified_order_id, ''), '[^0-9]', '', 'g') = ANY($2::text[])
             OR c.customer_key = ANY($3::text[])
             OR right(regexp_replace(COALESCE(c.visitor_phone, ''), '[^0-9]', '', 'g'), 10) = ANY($3::text[])
             OR lower(c.visitor_id) = ANY($4::text[]))`, [panels, nums, phones, emails])).rows, [] as ChatRow[]);
  if (!chats.length) return { chatsOf, msgsOf };

  // Each chat belongs to ONE order: its verified order, else the customer's latest order placed before the chat's last message.
  const byPanel = new Map<string, OrderRow[]>();
  for (const o of orders) byPanel.set(o.business_id, [...(byPanel.get(o.business_id) || []), o]);
  for (const c of chats) {
    const list = byPanel.get(c.business_id) || [];
    const v = digits(c.verified_order_id);
    let o = v ? list.find((x) => digits(x.order_id) === v) : undefined;
    if (!o) {
      const phone = c.customer_key || digits(c.visitor_phone).slice(-10);
      const mail = c.visitor_id.toLowerCase().startsWith('email:') ? c.visitor_id.slice(6).toLowerCase() : '';
      const last = c.last_message_at ? Date.parse(c.last_message_at) : Infinity;
      o = list.filter((x) => ((phone && x.phone10 === phone) || (mail && x.email === mail)) && Date.parse(x.created_at) <= last)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    }
    if (o) chatsOf.set(okey(o), [...(chatsOf.get(okey(o)) || []), c]);
  }
  const ids = Array.from(new Set(Array.from(chatsOf.values()).flat().map((c) => c.id)));
  if (!ids.length) return { chatsOf, msgsOf };
  const rows = await safe('messages', async () => (await query<{ conversation_id: string; sender: string; content: string; created_at: string; hidden: boolean }>(
    `SELECT m.conversation_id, m.sender, left(m.content, 1500) AS content, m.created_at,
            (COALESCE(m.metadata->>'hidden', 'false') = 'true' OR COALESCE(m.metadata->>'withheld', '') <> '') AS hidden
       FROM messages m
      WHERE m.conversation_id = ANY($1::text[]) AND m.deleted_at IS NULL AND m.sender IN ('visitor', 'agent', 'ai')
      ORDER BY m.created_at DESC LIMIT 60000`, [ids])).rows, []);
  const chatById = new Map(chats.map((c) => [c.id, c]));
  for (const r of rows) {
    const c = chatById.get(r.conversation_id);
    if (!c) continue;
    msgsOf.set(c.id, [...(msgsOf.get(c.id) || []), { sender: r.sender, content: r.content || '', at: Date.parse(r.created_at), channel: channelOf(c.source), chatId: c.id, hidden: r.hidden }]);
  }
  return { chatsOf, msgsOf };
}

// ── Chargebacks already raised: order -> customer, and the alert -> order match ──
interface AlertRow { id: string; business_id: string; received_at: string; subject: string; snippet: string; gateway: string; order_id: string | null; status: string }
export interface Match { orderId: string; by: 'order' | 'email' | 'phone' | 'amount' }

// The order a chargeback mail is about, inside ONE panel: the order number it names, else ONE order of the email / phone
// in it (the latest placed before the mail, within 120 days), else ONE prepaid order of that exact amount in the 45 days
// before. Two different orders = no match (never a guess).
export async function matchOrder(businessId: string, subjectAndText: string, receivedAt: number, storedOrderId: string | null): Promise<Match | null> {
  if (storedOrderId) return { orderId: storedOrderId, by: 'order' };
  const { emails, phones, amounts } = contactCandidates(subjectAndText);
  const before = new Date(receivedAt).toISOString();
  const pick = async (by: 'email' | 'phone', where: string, vals: string[]): Promise<Match | null> => {
    if (!vals.length) return null;
    const r = await safe(`match ${by}`, async () => (await query<{ order_id: string }>(
      `SELECT DISTINCT ON (k) order_id FROM (
         SELECT o.order_id, ${where} AS k, o.created_at FROM orders o
          WHERE o.business_id::text = $1 AND ${where} = ANY($2::text[]) AND o.created_at <= $3::timestamptz
            AND o.created_at > $3::timestamptz - interval '${MATCH_DAYS} days') x
        ORDER BY k, created_at DESC`, [businessId, vals, before])).rows, []);
    const ids = Array.from(new Set(r.map((x) => x.order_id)));
    return ids.length === 1 ? { orderId: ids[0], by } : null;
  };
  const m = await pick('email', `lower(COALESCE(o.customer_email, ''))`, emails)
    ?? await pick('phone', `right(regexp_replace(COALESCE(o.customer_mobile, ''), '[^0-9]', '', 'g'), 10)`, phones);
  if (m) return m;
  for (const amt of amounts) {
    const r = await safe('match amount', async () => (await query<{ order_id: string }>(
      `SELECT o.order_id FROM orders o WHERE o.business_id::text = $1 AND ${NOT_COD} AND abs(o.order_total - $2) < 1
          AND o.created_at <= $3::timestamptz AND o.created_at > $3::timestamptz - interval '${RISK_DAYS} days' LIMIT 2`,
      [businessId, amt, before])).rows, []);
    if (r.length === 1) return { orderId: r[0].order_id, by: 'amount' };
  }
  return null;
}

// For the poller (poll.ts): a new mail that names no order number -> the order by contact, per panel of its Gmail group.
export async function matchByContact(panelIds: string[], text: string, receivedAt: number): Promise<{ business_id: string; order_id: string }[]> {
  const out: { business_id: string; order_id: string }[] = [];
  for (const p of panelIds) {
    const m = await matchOrder(p, text, receivedAt, null);
    if (m && m.by !== 'amount') out.push({ business_id: p, order_id: m.orderId });
  }
  return out;
}

async function realAlerts(scope: string[] | null, days: number): Promise<AlertRow[]> {
  const rows = await safe('alerts', async () => (await query<AlertRow>(
    `SELECT a.id, a.business_id, a.received_at, a.subject, a.snippet, a.gateway, a.order_id, a.status FROM chargeback_alerts a
      WHERE ($1::text[] IS NULL OR a.business_id = ANY($1::text[])) AND a.received_at > now() - interval '${days} days'
      ORDER BY a.received_at DESC LIMIT 300`, [scope])).rows, [] as AlertRow[]);
  return rows.filter((a) => chargebackKind(a.subject, a.snippet) === 'chargeback');
}

async function ordersByKeys(keys: { business_id: string; order_id: string }[]): Promise<OrderRow[]> {
  if (!keys.length) return [];
  return safe('orders by key', async () => (await query<OrderRow>(
    `SELECT ${ORDER_COLS} FROM orders o LEFT JOIN businesses b ON b.id = o.business_id
      WHERE (o.business_id::text || '|' || o.order_id) = ANY($1::text[])`, [keys.map((k) => `${k.business_id}|${k.order_id}`)])).rows, []);
}

function factsFor(o: OrderRow, chats: ChatRow[], cbOrders: OrderRow[]) {
  const others = cbOrders.filter((x) => okey(x) !== okey(o) && ((o.phone10.length === 10 && x.phone10 === o.phone10) || (o.email.includes('@') && x.email === o.email)));
  const latest = [...chats].sort((a, b) => Date.parse(b.last_message_at || '0') - Date.parse(a.last_message_at || '0'))[0];
  return {
    healthMax: Math.max(0, ...chats.map((c) => c.health_score ?? 0)),
    caseKind: (chats.find((c) => c.case_kind)?.case_kind ?? null) as 'refund' | 'reship' | null,
    reshipped: chats.some((c) => !!c.reshipped_at),
    priorChargebacks: new Set(others.map(okey)).size,
    chargedBack: cbOrders.some((x) => okey(x) === okey(o)),
    latest,
  };
}

function itemOf(o: OrderRow, r: RiskResult, chats: ChatRow[], f: ReturnType<typeof factsFor>): RiskItem {
  const open = chats.filter((c) => c.status !== 'resolved');
  const best = [...(open.length ? open : chats)].sort((a, b) => Date.parse(b.last_message_at || '0') - Date.parse(a.last_message_at || '0'))[0];
  return {
    ...r, orderId: o.order_id, businessId: o.business_id, panelName: o.panel_name || 'Panel', customerName: (o.customer_name || '').replace(/\.$/, ''),
    placedAt: o.created_at, total: o.total, status: isDelivered(o) ? 'Delivered' : String(o.tracking_status || 'Order Placed'),
    chatId: best?.id ?? null, holder: best?.assigned_to ?? null, caseKind: f.caseKind,
  };
}

const toRiskOrder = (o: OrderRow): RiskOrder => ({
  orderId: o.order_id, businessId: o.business_id, placedAt: Date.parse(o.created_at), estimatedDelivery: o.estimated_delivery,
  delivered: isDelivered(o), total: Number(o.total) || 0,
});

// Chargebacks matched to orders (the stored order, else by contact), for the "raised before" / "already raised" facts.
async function chargebackOrders(scope: string[] | null): Promise<{ alerts: AlertRow[]; matches: Map<string, Match | null>; orders: OrderRow[] }> {
  const alerts = await realAlerts(scope, MATCH_DAYS);
  const matches = new Map<string, Match | null>();
  for (const a of alerts) matches.set(a.id, await matchOrder(a.business_id, `${a.subject}\n${a.snippet}`, Date.parse(a.received_at), a.order_id));
  const keys = alerts.flatMap((a) => { const m = matches.get(a.id); return m ? [{ business_id: a.business_id, order_id: m.orderId }] : []; });
  return { alerts, matches, orders: await ordersByKeys(keys) };
}

// ── The list: every prepaid order of the last 45 days scored now, Watch and above, riskiest first ──
export interface RiskList { at: string; items: RiskItem[]; counts: Record<'watch' | 'high' | 'critical', number>; scanned: number }
const G = globalThis as unknown as { __riskCache?: Map<string, { at: number; value: RiskList }> };
const CACHE_MS = 2 * 60_000;

export async function loadRiskList(scope: string[] | null, now = Date.now(), fresh = false): Promise<RiskList> {
  const key = scope ? [...scope].sort().join(',') : '*';
  const cache = (G.__riskCache ??= new Map());
  const hit = cache.get(key);
  if (!fresh && hit && now - hit.at < CACHE_MS) return hit.value;

  const orders = await safe('orders', async () => (await query<OrderRow>(
    `SELECT ${ORDER_COLS} FROM orders o LEFT JOIN businesses b ON b.id = o.business_id
      WHERE NOT COALESCE(o.is_cancelled, false) AND ${NOT_COD}
        AND o.created_at > $2::timestamptz - interval '${RISK_DAYS} days'
        AND ($1::text[] IS NULL OR o.business_id::text = ANY($1::text[]))`, [scope, new Date(now).toISOString()])).rows, [] as OrderRow[]);
  const [g, cb] = await Promise.all([gather(orders), chargebackOrders(scope)]);
  const items: RiskItem[] = [];
  for (const o of orders) {
    const chats = g.chatsOf.get(okey(o)) || [];
    const msgs = chats.flatMap((c) => g.msgsOf.get(c.id) || []);
    const f = factsFor(o, chats, cb.orders);
    const r = scoreOrder(toRiskOrder(o), msgs, f, now);
    if (r.level !== 'low') items.push(itemOf(o, r, chats, f));
  }
  items.sort((a, b) => b.score - a.score || (b.lastCustomerAt ?? 0) - (a.lastCustomerAt ?? 0));
  const value: RiskList = {
    at: new Date(now).toISOString(), items: items.slice(0, 300), scanned: orders.length,
    counts: { watch: items.filter((i) => i.level === 'watch').length, high: items.filter((i) => i.level === 'high').length, critical: items.filter((i) => i.level === 'critical').length },
  };
  cache.set(key, { at: now, value });
  return value;
}

// ── The study: would the engine have seen each chargeback coming? ──
export interface StudyRow {
  alertId: string; receivedAt: string; gateway: string; panelName: string; status: string;
  matchedBy: Match['by'] | null; orderId: string | null; cod: boolean | null; placedAt: string | null;
  daysFromOrder: number | null; contacted: boolean; channels: Channel[]; firstContactAt: string | null;
  before3: { score: number; level: string; signals: string[] } | null;  // 3 days before the mail
  onDay: { score: number; level: string; signals: string[]; action: string } | null;
}
export interface Study {
  rows: StudyRow[];
  summary: { chargebacks: number; matched: number; cod: number; contacted: number; flaggedBefore: number; flaggedOnDay: number; silent: number; signals: { text: string; count: number }[] };
}

export async function loadStudy(scope: string[] | null): Promise<Study> {
  const cb = await chargebackOrders(scope);
  const g = await gather(cb.orders);
  const panelNames = new Map<string, string>();
  const pn = await safe('panels', async () => (await query<{ id: string; name: string }>(`SELECT id::text AS id, name FROM businesses`)).rows, []);
  for (const p of pn) panelNames.set(p.id, p.name);
  // When each charged-back order's first chargeback came: a chargeback counts as "raised before" only if it came earlier.
  const cbFirst = new Map<string, number>();
  for (const a of cb.alerts) {
    const m = cb.matches.get(a.id);
    if (!m) continue;
    const k = okey({ business_id: a.business_id, order_id: m.orderId });
    cbFirst.set(k, Math.min(cbFirst.get(k) ?? Infinity, Date.parse(a.received_at)));
  }
  const rows: StudyRow[] = [];
  const signalCount = new Map<string, number>();
  for (const a of cb.alerts) {
    const m = cb.matches.get(a.id) || null;
    const o = m ? cb.orders.find((x) => x.business_id === a.business_id && x.order_id === m.orderId) : undefined;
    const at = Date.parse(a.received_at);
    const base: StudyRow = {
      alertId: a.id, receivedAt: a.received_at, gateway: a.gateway, panelName: panelNames.get(a.business_id) || 'Panel', status: a.status,
      matchedBy: m?.by ?? null, orderId: m?.orderId ?? null, cod: null, placedAt: null, daysFromOrder: null, contacted: false, channels: [],
      firstContactAt: null, before3: null, onDay: null,
    };
    if (o) {
      const chats = g.chatsOf.get(okey(o)) || [];
      const msgs = chats.flatMap((c) => g.msgsOf.get(c.id) || []).filter((x) => x.at <= at);
      // On the day: everything before the mail; the chargeback itself (and others on this customer) does not count as a reason.
      const earlier = cb.orders.filter((x) => okey(x) !== okey(o) && (cbFirst.get(okey(x)) ?? Infinity) < at);
      const f = { ...factsFor(o, chats, earlier), chargedBack: false };
      const mine = msgs.filter((x) => x.sender === 'visitor' && !x.hidden && x.content.trim());
      const day = scoreOrder(toRiskOrder(o), msgs, f, at);
      const b3 = scoreOrder(toRiskOrder(o), msgs, f, at - 3 * 86_400_000);
      for (const s of day.signals) if (s.points > 0) signalCount.set(s.key, (signalCount.get(s.key) || 0) + 1);
      Object.assign(base, {
        cod: /^cod$|cash on delivery/i.test(String(o.payment_method || '').trim()), placedAt: o.created_at,
        daysFromOrder: Math.floor((at - Date.parse(o.created_at)) / 86_400_000),
        contacted: mine.length > 0, channels: Array.from(new Set(mine.map((x) => x.channel))),
        firstContactAt: mine.length ? new Date(mine[0].at).toISOString() : null,
        before3: { score: b3.score, level: b3.level, signals: b3.signals.filter((s) => s.points > 0).map((s) => s.text) },
        onDay: { score: day.score, level: day.level, signals: day.signals.filter((s) => s.points > 0).map((s) => s.text), action: day.action.text },
      });
    }
    rows.push(base);
  }
  const flagged = (x: StudyRow['before3']) => !!x && (levelOf(x.score) === 'high' || levelOf(x.score) === 'critical');
  return {
    rows,
    summary: {
      chargebacks: rows.length, matched: rows.filter((r) => r.orderId).length, cod: rows.filter((r) => r.cod).length,
      contacted: rows.filter((r) => r.contacted).length, silent: rows.filter((r) => r.orderId && !r.contacted).length,
      flaggedBefore: rows.filter((r) => flagged(r.before3)).length, flaggedOnDay: rows.filter((r) => flagged(r.onDay)).length,
      signals: Array.from(signalCount.entries()).map(([key, count]) => ({ text: SIGNAL_NAME[key as SignalKey] || key, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    },
  };
}
