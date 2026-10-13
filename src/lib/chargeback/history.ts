// ── Chargeback history, the database side (owner 2026-10-13; shape and text in history-rules.ts) ──
// Read only. For one chargeback alert (or one order from the Stop them list): the order (the alert's, else matched by
// the email / phone / amount in the mail, risk.ts matchOrder), else up to 8 orders it could be; then everything tied to
// that order: the customer's chats on every channel (risk.ts gather: the verified order, the customer key / phone, the
// WhatsApp number, the email address), the Gmail mails to and from the order's email in the panel's support Gmail
// (mail_store, mail-store.sql), the automatic WhatsApp messages of the order (wa_auto_sends) and the chargeback mails.
// Every part in its own try: a table that is not there leaves only its part empty. The routes check who may read it.
import { query, queryOne } from '@/lib/db';
import { chargebackKind, orderForms } from './parse';
import { contactCandidates } from './risk-rules';
import { MATCH_DAYS, NOT_COD, ORDER_COLS, gather, isDelivered, matchOrder, type OrderRow } from './risk';
import {
  TEXT_MAX, dropEmailChatCopies, sortTimeline,
  type ChargebackHistory, type HistoryCandidate, type HistoryEntry, type HistoryOrder, type HistorySource,
} from './history-rules';

const missing = (e: unknown) => ['42P01', '42703'].includes((e as { code?: string })?.code || '');
async function safe<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e) { if (!missing(e)) console.error(`[cb-history] ${what}:`, (e as Error).message); return fallback; }
}
const digits = (s: unknown) => String(s ?? '').replace(/[^0-9]/g, '');
const isoOf = (v: unknown) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString(); };
const clip = (s: unknown) => String(s ?? '').replace(/\r/g, '').trim().slice(0, TEXT_MAX + 1);

interface AlertRow { id: string; business_id: string; received_at: string; subject: string; snippet: string; gateway: string; order_id: string | null; status: string; panel_name: string | null }

export type HistoryResult = { ok: true; history: ChargebackHistory } | { ok: false; status: number; error: string };

// alertId, or businessId + orderId (an order of the Stop them list). scope = the panels the login may see (null = all).
export async function loadHistory(opts: { alertId?: string | null; businessId?: string | null; orderId?: string | null }, scope: string[] | null): Promise<HistoryResult> {
  let alert: AlertRow | null = null;
  let businessId = '';
  if (opts.alertId) {
    if (!/^[0-9a-f-]{36}$/i.test(opts.alertId)) return { ok: false, status: 400, error: 'Bad alert id' };
    alert = await safe('alert', () => queryOne<AlertRow>(
      `SELECT a.id, a.business_id, a.received_at, a.subject, a.snippet, a.gateway, a.order_id, a.status, b.name AS panel_name
         FROM chargeback_alerts a LEFT JOIN businesses b ON b.id::text = a.business_id
        WHERE a.id = $1 AND ($2::text[] IS NULL OR a.business_id = ANY($2::text[]))`, [opts.alertId, scope]), null);
    if (!alert) return { ok: false, status: 404, error: 'Chargeback not found' };
    businessId = alert.business_id;
  } else {
    businessId = String(opts.businessId || '');
    if (!/^[0-9a-f-]{36}$/i.test(businessId) || !digits(opts.orderId)) return { ok: false, status: 400, error: 'businessId and orderId are needed' };
    if (scope && !scope.includes(businessId)) return { ok: false, status: 404, error: 'Not found' };
  }

  // ── The order ──
  let orderId: string | null = null;
  let matchedBy: ChargebackHistory['matchedBy'] = null;
  if (alert) {
    const m = await safe('match', () => matchOrder(businessId, `${alert!.subject}\n${alert!.snippet}`, Date.parse(alert!.received_at), alert!.order_id), null);
    if (m) { orderId = m.orderId; matchedBy = m.by; }
  } else {
    orderId = String(opts.orderId);
    matchedBy = 'typed';
  }
  const o = orderId ? await safe('order', () => queryOne<OrderRow & { is_cancelled: boolean | null; tracking_token: string | null; tracking_domain: string | null }>(
    `SELECT ${ORDER_COLS}, o.is_cancelled, o.tracking_token, b.tracking_domain
       FROM orders o LEFT JOIN businesses b ON b.id = o.business_id
      WHERE o.business_id::text = $1::text AND o.order_id = ANY($2::text[]) ORDER BY o.created_at DESC LIMIT 1`,
    [businessId, orderForms([digits(orderId)])]), null) : null;
  const panelName = alert?.panel_name || o?.panel_name || (await safe('panel', () => queryOne<{ name: string }>(`SELECT name FROM businesses WHERE id::text = $1`, [businessId]), null))?.name || 'Panel';

  const entries: HistoryEntry[] = [];
  const sources: ChargebackHistory['sources'] = { chats: [], gmail: 0, waAuto: 0, chargebacks: 0 };
  let order: HistoryOrder | null = null;
  let candidates: HistoryCandidate[] = [];

  if (!o) {
    if (alert) candidates = await findCandidates(businessId, `${alert.subject}\n${alert.snippet}`, Date.parse(alert.received_at));
    if (alert) { entries.push(alertEntry(alert)); sources.chargebacks = 1; }
  } else {
    const base = (o.tracking_domain || process.env.TRACKING_BASE_URL || 'https://shiptrack.store').replace(/\/+$/, '');
    order = {
      orderId: o.order_id, panelName, customerName: String(o.customer_name || '').replace(/\.$/, ''), placedAt: isoOf(o.created_at),
      total: Number(o.total) || 0, payment: /^cod$|cash on delivery/i.test(String(o.payment_method || '').trim()) ? 'COD' : 'Prepaid',
      status: isDelivered(o) ? 'Delivered' : String(o.tracking_status || 'Order Placed'), estimatedDelivery: o.estimated_delivery,
      deliveredAt: o.delivered_at ? isoOf(o.delivered_at) : null, trackingLink: o.tracking_token ? `${base}/track/${o.tracking_token}` : null,
      email: o.email, phone: o.phone10, cancelled: !!o.is_cancelled,
    };

    // The chats on every channel and their messages.
    const g = await safe('chats', () => gather([o]), { chatsOf: new Map(), msgsOf: new Map() });
    const chats = Array.from(g.chatsOf.values()).flat();
    for (const c of chats) {
      const msgs = (g.msgsOf.get(c.id) || []).filter((x) => !x.hidden && x.content.trim());
      const kind: HistorySource['kind'] = c.source === 'whatsapp' ? 'whatsapp' : c.source === 'email' ? 'email' : 'chat';
      const link = kind === 'chat' ? `/admin/chat?open=${encodeURIComponent(c.id)}` : kind === 'whatsapp' ? '/admin?tab=whatsapp' : '/admin?tab=mail';
      sources.chats.push({ kind, id: c.id, status: c.status === 'resolved' ? 'Closed' : c.status === 'human_needed' ? 'Needs you' : c.status === 'agent_handling' ? 'With team' : 'With AI', messages: msgs.length, link });
      for (const x of msgs) {
        entries.push({
          at: new Date(x.at).toISOString(), channel: kind, link,
          who: x.sender === 'visitor' ? 'customer' : x.sender === 'ai' ? 'chikki' : 'team', text: clip(x.content),
        });
      }
    }

    // Gmail: the mails to and from the order's email in this panel's support Gmail(s).
    if (order.email.includes('@')) {
      const mails = await safe('gmail', async () => (await query<{ box_id: string; uid: string; folder: string; subject: string; sent_at: string; body: string | null }>(
        `SELECT m.box_id, m.uid::text AS uid, m.folder, m.subject, m.sent_at, left(m.body_text, ${TEXT_MAX + 1}) AS body
           FROM mail_store m
          WHERE m.box_id IN (SELECT se.id::text FROM site_emails se JOIN sites s ON s.id = se.site_id WHERE s.tracker_business_id::text = $1::text)
            AND NOT m.gone
            AND ((m.folder = 'inbox' AND lower(m.from_addr) = $2)
                 OR (m.folder = 'sent' AND EXISTS (SELECT 1 FROM unnest(m.to_addrs) t WHERE lower(t) = $2)))
          ORDER BY m.sent_at DESC LIMIT 120`, [businessId, order.email])).rows, []);
      sources.gmail = mails.length;
      for (const x of mails) {
        entries.push({
          at: isoOf(x.sent_at), channel: 'gmail', who: x.folder === 'inbox' ? 'customer' : 'team', subject: x.subject || '(no subject)',
          text: clip(x.body) || '(the text of this mail is not saved yet)',
          link: x.folder === 'inbox' ? `/admin?tab=mail&box=${encodeURIComponent(x.box_id)}&uid=${x.uid}` : '/admin?tab=mail',
        });
      }
    }

    // The automatic WhatsApp messages of this order.
    const auto = await safe('wa auto', async () => (await query<{ kind: string; status: string; body_text: string | null; error: string | null; sent_at: string | null; due_at: string; updated_at: string }>(
      `SELECT kind, status, body_text, error, sent_at, due_at, updated_at FROM wa_auto_sends
        WHERE business_id = $1 AND order_id = $2 ORDER BY created_at`, [businessId, o.order_id])).rows, []);
    sources.waAuto = auto.length;
    for (const a of auto) {
      entries.push({
        at: isoOf(a.sent_at || (a.status === 'pending' ? a.due_at : a.updated_at)), channel: 'wa_auto', who: 'system', status: a.status,
        text: clip(a.body_text || `${a.kind === 'placed' ? 'Order placed' : 'Tracking link'} message${a.error ? `: ${a.error}` : ''}`),
        link: '/admin?tab=whatsapp',
      });
    }

    // Every chargeback mail on this order (the opened one too).
    const cbs = await safe('alerts', async () => (await query<AlertRow>(
      `SELECT a.id, a.business_id, a.received_at, a.subject, a.snippet, a.gateway, a.order_id, a.status, NULL::text AS panel_name
         FROM chargeback_alerts a WHERE a.business_id = $1 AND a.order_id = $2`, [businessId, o.order_id])).rows, []);
    const all = [...cbs.filter((x) => chargebackKind(x.subject, x.snippet) === 'chargeback')];
    if (alert && !all.some((x) => x.id === alert!.id)) all.push(alert);
    sources.chargebacks = all.length;
    for (const a of all) entries.push(alertEntry(a));
  }

  const { timeline, cut } = sortTimeline(dropEmailChatCopies(entries));
  return {
    ok: true,
    history: {
      alert: alert ? { id: alert.id, gateway: alert.gateway, receivedAt: isoOf(alert.received_at), subject: alert.subject, status: alert.status } : null,
      panelName, order, matchedBy: order ? matchedBy : null, candidates, sources, timeline, cut,
    },
  };
}

function alertEntry(a: AlertRow): HistoryEntry {
  return { at: isoOf(a.received_at), channel: 'chargeback', who: 'gateway', subject: a.subject, text: clip(a.snippet) || '(no text)', link: '/admin?tab=chargebacks' };
}

// The mail named no order of ours: the panel's not-cancelled prepaid orders of that exact amount (45 days before the
// mail), and its orders of the email / phone written in the mail (120 days), at most 8, newest first.
async function findCandidates(businessId: string, text: string, receivedAt: number): Promise<HistoryCandidate[]> {
  const { emails, phones, amounts } = contactCandidates(text);
  if (!emails.length && !phones.length && !amounts.length) return [];
  const before = new Date(Number.isFinite(receivedAt) ? receivedAt : Date.now()).toISOString();
  const rows = await safe('candidates', async () => (await query<OrderRow & { why: string }>(
    `SELECT ${ORDER_COLS},
            CASE WHEN lower(COALESCE(o.customer_email, '')) = ANY($3::text[]) THEN 'same email in the mail'
                 WHEN right(regexp_replace(COALESCE(o.customer_mobile, ''), '[^0-9]', '', 'g'), 10) = ANY($4::text[]) THEN 'same phone in the mail'
                 ELSE 'same amount as the mail' END AS why
       FROM orders o LEFT JOIN businesses b ON b.id = o.business_id
      WHERE o.business_id::text = $1::text AND NOT COALESCE(o.is_cancelled, false)
        AND o.created_at <= $2::timestamptz AND o.created_at > $2::timestamptz - interval '${MATCH_DAYS} days'
        AND (lower(COALESCE(o.customer_email, '')) = ANY($3::text[])
             OR right(regexp_replace(COALESCE(o.customer_mobile, ''), '[^0-9]', '', 'g'), 10) = ANY($4::text[])
             OR (${NOT_COD} AND o.created_at > $2::timestamptz - interval '45 days'
                 AND EXISTS (SELECT 1 FROM unnest($5::float8[]) amt WHERE abs(o.order_total - amt) < 1)))
      ORDER BY o.created_at DESC LIMIT 8`, [businessId, before, emails, phones, amounts])).rows, []);
  return rows.map((r) => ({
    orderId: r.order_id, customerName: String(r.customer_name || '').replace(/\.$/, ''), placedAt: isoOf(r.created_at), total: Number(r.total) || 0,
    status: isDelivered(r) ? 'Delivered' : String(r.tracking_status || 'Order Placed'), why: r.why,
  }));
}

// "Copy all for Claude": every real chargeback of the panels in scope of the last 120 days (at most 30, newest first).
export async function recentAlertIds(scope: string[] | null): Promise<string[]> {
  const rows = await safe('recent', async () => (await query<{ id: string; subject: string; snippet: string }>(
    `SELECT id, subject, snippet FROM chargeback_alerts
      WHERE ($1::text[] IS NULL OR business_id = ANY($1::text[])) AND received_at > now() - interval '${MATCH_DAYS} days'
      ORDER BY received_at DESC LIMIT 200`, [scope])).rows, []);
  return rows.filter((r) => chargebackKind(r.subject, r.snippet) === 'chargeback').slice(0, 30).map((r) => r.id);
}
