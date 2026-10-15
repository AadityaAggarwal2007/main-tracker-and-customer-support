import { query, queryOne } from '@/lib/db';
import { GATEWAY_KEYS, WHATSAPP_NUMBERS_MAX, chargebackKind, gatewayKeyOf, orderCandidates, orderForms, whatsappNumbers, type ChargebackKind } from './parse';
import { groupCases, isDigest } from './cases';
import { matchByContact } from './risk';
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
  // 'chargeback' = a real dispute mail; 'other' = the gateway's other mail in the same Gmail (owner 2026-10-09: the ₹100
  // payment mails). Read from the words each time (parse.ts chargebackKind), never stored: Open / Done / the badge and
  // the chat tag count only 'chargeback'; the "Other mail" view shows the rest so nothing is hidden.
  kind: ChargebackKind;
  // How the panel was chosen when two panels share the Gmail (routing.ts); null on a single-panel mailbox or before chargeback-shared.sql.
  routed_by?: string | null;
  // The other panels using the same chargeback Gmail, or ticking the mail's gateway: where an alert can be moved by hand.
  alt_panels?: { id: string; name: string }[];
  // One card per chargeback case (owner 2026-10-15, cases.ts): this row is the case's NEWEST mail; `mails` = how many
  // mails the gateway sent for it (the first notice + reminders), `mail_ids` all of them (Mark done / Move act on all),
  // `first_at` when the first came, `done_mails` how many were already marked done (a reminder after Done reopens it).
  mails?: number; mail_ids?: string[]; first_at?: string; done_mails?: number;
  // The mail's gateway is not ticked in this panel's checklist but is in another panel's (owner 2026-10-15: a PayGlocal
  // mail in vastora's Gmail, vastora uses Easebuzz): those panels, to check and move it.
  gateway_elsewhere?: { id: string; name: string }[];
  // The panel whose chargeback Gmail the mail came into, when that is not this panel's Gmail (the alert was sorted to
  // this panel by its gateway, owner 2026-10-15 "seprate kar"): shown as "Came into X's Gmail".
  gmail_panel?: string | null; gmail_panel_name?: string | null;
  // The gateway's daily list of open cases (cases.ts isDigest): one card for all of them.
  digest?: boolean;
}

export interface CaseCounts { installed: boolean; new: number; open: number; mails: number; panels: { id: string; name: string; open: number }[] }

// scope: the panels the login may see (null = every panel; the Manager limited to some panels, owner 2026-10-10).
// Counted per CASE (cases.ts): five reminders of one dispute are one pending chargeback; `mails` = the mails behind them.
export async function alertCounts(scope: string[] | null = null): Promise<CaseCounts> {
  try {
    // The open rows are few (a chargeback is rare, and Done takes it out); their words decide what counts.
    const r = await query<{ id: string; business_id: string; panel_name: string | null; gateway: string; order_id: string | null; received_at: string; status: string; subject: string; snippet: string }>(
      `SELECT a.id, a.business_id, b.name AS panel_name, a.gateway, a.order_id, a.received_at, a.status, a.subject, a.snippet
         FROM chargeback_alerts a LEFT JOIN businesses b ON b.id::text = a.business_id
        WHERE a.status <> 'done' AND ($1::text[] IS NULL OR a.business_id = ANY($1::text[]))`, [scope]);
    const real = r.rows.filter(a => chargebackKind(a.subject, a.snippet) === 'chargeback');
    const cases = groupCases(real);
    const panels: CaseCounts['panels'] = [];
    for (const g of cases) {
      const p = panels.find(x => x.id === g[0].business_id);
      if (p) p.open++; else panels.push({ id: g[0].business_id, name: g[0].panel_name || 'Panel', open: 1 });
    }
    panels.sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
    return { installed: true, new: cases.filter(g => g.some(a => a.status === 'new')).length, open: cases.length, mails: real.length, panels };
  } catch (e) {
    if (!missing(e)) console.error('[chargeback] counts:', (e as Error).message);
    return { installed: !missing(e), new: 0, open: 0, mails: 0, panels: [] };
  }
}

const LIST_SQL = (cols: string) => `SELECT a.id, a.business_id, b.name AS panel_name, a.received_at, a.from_address, a.from_name, a.subject, a.snippet,
              a.gateway, a.order_id, a.status, a.seen_by_name, a.seen_at, a.done_by_name, a.done_at, a.note, a.notify_status${cols},
              (SELECT mb.business_id FROM chargeback_mailboxes mb WHERE mb.id = a.mailbox_id) AS gmail_panel,
              (SELECT b2.name FROM chargeback_mailboxes mb JOIN businesses b2 ON b2.id::text = mb.business_id WHERE mb.id = a.mailbox_id) AS gmail_panel_name,
              (SELECT c.id FROM conversations c JOIN sites s ON s.id = c.site_id
                WHERE a.order_id IS NOT NULL AND s.tracker_business_id::text = a.business_id AND c.verified_order_id = a.order_id AND c.merged_into IS NULL
                ORDER BY (c.source = 'chat') DESC, c.last_message_at DESC NULLS LAST LIMIT 1) AS chat_id
         FROM chargeback_alerts a LEFT JOIN businesses b ON b.id::text = a.business_id
        WHERE ($1 IN ('all', 'other') OR ($1 = 'open' AND a.status <> 'done') OR ($1 = 'done' AND a.status = 'done'))
          AND ($3::text[] IS NULL OR a.business_id = ANY($3::text[]))
        ORDER BY (a.status = 'new') DESC, a.received_at DESC
        LIMIT $2`;

// Panels that read the same chargeback Gmail as each panel (by address): { panelId -> the OTHER panels }.
async function sharingMap(): Promise<Record<string, { id: string; name: string }[]>> {
  const out: Record<string, { id: string; name: string }[]> = {};
  try {
    const r = await query<{ business_id: string; email: string; name: string | null }>(
      `SELECT m.business_id, lower(m.email) AS email, b.name FROM chargeback_mailboxes m LEFT JOIN businesses b ON b.id::text = m.business_id`);
    for (const a of r.rows) out[a.business_id] = r.rows.filter(x => x.email === a.email && x.business_id !== a.business_id).map(x => ({ id: x.business_id, name: x.name || 'Panel' }));
  } catch { /* no table: nothing is shared */ }
  return out;
}

// Each panel's ticked gateways (Settings > Chargeback protection, step 3) with its name. A failure = no ticks known.
async function gatewayTicks(): Promise<{ id: string; name: string; keys: Set<string> }[]> {
  try {
    const r = await query<{ business_id: string; name: string | null; gateways: Record<string, { done?: boolean } | undefined> | null }>(
      `SELECT p.business_id, b.name, p.gateways FROM panel_chargeback p LEFT JOIN businesses b ON b.id::text = p.business_id`);
    return r.rows.map(x => ({ id: x.business_id, name: x.name || 'Panel',
      keys: new Set(Object.entries(x.gateways || {}).filter(([, v]) => v?.done === true).map(([k]) => k)) }));
  } catch { return []; }
}

// The panels (other than the alert's) that tick the mail's gateway, when the alert's own panel ticks other gateways but
// not this one. Nothing when the gateway is unknown or the panel ticked nothing (nobody filled the checklist yet).
function gatewayElsewhere(a: { business_id: string; gateway: string }, ticks: { id: string; name: string; keys: Set<string> }[]): { id: string; name: string }[] {
  const key = gatewayKeyOf(a.gateway);
  if (key === 'other') return [];
  const own = ticks.find(t => t.id === a.business_id);
  if (!own || own.keys.size === 0 || own.keys.has(key)) return [];
  return ticks.filter(t => t.id !== a.business_id && t.keys.has(key)).map(t => ({ id: t.id, name: t.name }));
}

export type AlertView = 'open' | 'done' | 'all' | 'other';
// Open / Done / All list the real chargebacks, ONE card per case (cases.ts): a case is Open while any of its mails is
// not done (a reminder after Done brings it back), Done when every mail is. Other lists the gateway's other mail from
// the same Gmail (any status), one row per mail.
export async function listAlerts(view: AlertView, limit = 100, scope: string[] | null = null): Promise<{ installed: boolean; alerts: AlertRow[] }> {
  const read = async (v: AlertView, n: number): Promise<AlertRow[]> => {
    const args = [v, Math.min(Math.max(n, 1), 400), scope];
    try { return (await query<AlertRow>(LIST_SQL(', a.routed_by'), args)).rows; }
    catch (e) {
      // routed_by exists only after chargeback-shared.sql: before it, the list is the same without it.
      if ((e as { code?: string })?.code !== '42703') throw e;
      return (await query<AlertRow>(LIST_SQL(''), args)).rows;
    }
  };
  try {
    let rows = await read(view, view === 'open' || view === 'done' ? 200 : 400);
    // The other side, so a case's mails are all in one card: Open needs the case's done mails, Done its open ones.
    if (view === 'open' || view === 'done') {
      const seen = new Set(rows.map(a => a.id));
      for (const a of await read(view === 'open' ? 'done' : 'open', 300)) if (!seen.has(a.id)) rows.push(a);
    }
    for (const a of rows) a.kind = chargebackKind(a.subject, a.snippet);
    rows = rows.filter(a => view === 'other' ? a.kind === 'other' : a.kind === 'chargeback');
    let out: AlertRow[];
    if (view === 'other') {
      out = rows.map(a => ({ ...a, mails: 1, mail_ids: [a.id], first_at: a.received_at, done_mails: a.status === 'done' ? 1 : 0 }));
    } else {
      out = [];
      for (const g of groupCases(rows)) {
        const open = g.filter(a => a.status !== 'done');
        if (view === 'open' && open.length === 0) continue;
        if (view === 'done' && open.length > 0) continue;
        // The card: the newest mail's words; the case's status from its open mails (New while any is unopened).
        const head = { ...g[0] };
        if (open.length) {
          head.status = open.some(a => a.status === 'new') ? 'new' : 'seen';
          head.done_by_name = null; head.done_at = null;
        }
        head.order_id = g.find(a => a.order_id)?.order_id ?? null;
        head.chat_id = g.find(a => a.chat_id)?.chat_id ?? null;
        if (!head.note) head.note = g.find(a => a.note)?.note ?? null;
        if (!head.done_by_name && !open.length) head.done_by_name = g.find(a => a.done_by_name)?.done_by_name ?? null;
        head.mails = g.length; head.mail_ids = g.map(a => a.id); head.digest = isDigest(head.subject);
        head.first_at = g[g.length - 1].received_at; head.done_mails = g.length - open.length;
        out.push(head);
      }
      out.sort((x, y) => Number(y.status === 'new') - Number(x.status === 'new') || Date.parse(y.received_at) - Date.parse(x.received_at));
    }
    out = out.slice(0, Math.min(Math.max(limit, 1), 200));
    const [share, ticks] = await Promise.all([sharingMap(), gatewayTicks()]);
    for (const a of out) {
      a.gateway_elsewhere = gatewayElsewhere(a, ticks);
      // An old "Panel unsure" (routed before the checklists were ticked): now this panel ticks the gateway and no other
      // panel on the same Gmail does, so it is not unsure any more.
      if (a.routed_by === 'unsure') {
        const key = gatewayKeyOf(a.gateway);
        const mine = ticks.find(t => t.id === a.business_id)?.keys.has(key);
        const others = (share[a.business_id] ?? []).some(p => ticks.find(t => t.id === p.id)?.keys.has(key));
        if (mine && !others) a.routed_by = 'gateway';
      }
      // Came into another panel's Gmail (sorted here by its gateway): say whose.
      if (!a.gmail_panel || a.gmail_panel === a.business_id || (share[a.business_id] ?? []).some(p => p.id === a.gmail_panel)) { a.gmail_panel = null; a.gmail_panel_name = null; }
      const alt = [...(share[a.business_id] ?? [])];
      for (const p of a.gateway_elsewhere) if (!alt.some(x => x.id === p.id)) alt.push(p);
      a.alt_panels = alt;
    }
    return { installed: true, alerts: out };
  } catch (e) {
    if (missing(e)) return { installed: false, alerts: [] };
    throw e;
  }
}

// "Move to <panel>": a Super Admin's correction. Only to a panel reading the same Gmail, or (owner 2026-10-15) a panel
// whose checklist ticks the mail's gateway. The order is looked up again in the new panel (an order number can exist in
// both): by the number in the mail, else ONE order of the customer's email / phone there (risk.ts, as the poller does).
export async function setAlertPanel(id: string, businessId: string, by: 'manual' | 'gateway' = 'manual'): Promise<{ ok: boolean; status?: number; error?: string; orderId?: string | null }> {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !businessId) return { ok: false, status: 400, error: 'id and businessId are required' };
  const a = await queryOne<{ business_id: string; subject: string; snippet: string; gateway?: string; received_at?: string; email: string | null }>(
    `SELECT a.business_id, a.subject, a.snippet, a.gateway, a.received_at, (SELECT lower(email) FROM chargeback_mailboxes WHERE id = a.mailbox_id) AS email FROM chargeback_alerts a WHERE a.id = $1`, [id]);
  if (!a) return { ok: false, status: 404, error: 'Alert not found.' };
  if (a.business_id === businessId) return { ok: true };
  const share = await sharingMap();
  const sameGmail = (share[a.business_id] ?? []).some(p => p.id === businessId);
  const byGateway = !sameGmail && a.gateway ? gatewayElsewhere({ business_id: a.business_id, gateway: a.gateway }, await gatewayTicks()).some(p => p.id === businessId) : false;
  if (!sameGmail && !byGateway) return { ok: false, status: 400, error: 'That panel does not use this Gmail or this gateway.' };
  const forms = orderForms(orderCandidates(a.subject, a.snippet));
  let o = forms.length ? await queryOne<{ order_id: string }>(`SELECT order_id FROM orders WHERE business_id::text = $1::text AND order_id = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`, [businessId, forms]) : null;
  if (!o) {
    try {
      const m = await matchByContact([businessId], `${a.subject}\n${a.snippet}`, a.received_at ? Date.parse(a.received_at) : Date.now());
      if (m.length === 1) o = { order_id: m[0].order_id };
    } catch (e) { console.error('[chargeback] move match:', (e as Error).message); }
  }
  await query(`UPDATE chargeback_alerts SET business_id = $2, order_id = $3, routed_by = $4 WHERE id = $1`, [id, businessId, o?.order_id ?? null, by]);
  return { ok: true, orderId: o?.order_id ?? null };
}

// Sort by gateway (owner 2026-10-15: "vastora payglocal ni sort hua"): a mail whose gateway the panel it came to does
// NOT tick (the panel ticks others) while exactly ONE other panel ticks it goes to that panel, wherever its Gmail is
// (a PayGlocal mail in vastora's chargeback Gmail, vastora = Easebuzz, kurtiya = PayGlocal -> kurtiya). Never a mail
// tied to an order of its panel, never one the Super Admin moved by hand, never when the panel ticked nothing or two panels tick the gateway. The poller runs it
// on each new mail BEFORE the WhatsApp (so the right panel's numbers get it) and once a minute over the open alerts.
export async function sortByGateway(onlyId?: string): Promise<{ id: string; businessId: string; panelName: string; orderId: string | null }[]> {
  type R = { id: string; business_id: string; gateway: string; order_id: string | null; routed_by?: string | null };
  const sql = (cols: string) => `SELECT id, business_id, gateway, order_id${cols} FROM chargeback_alerts WHERE status <> 'done' AND ($1::text IS NULL OR id::text = $1::text) LIMIT 500`;
  let rows: R[];
  try {
    try { rows = (await query<R>(sql(', routed_by'), [onlyId ?? null])).rows; }
    catch (e) { if ((e as { code?: string })?.code !== '42703') throw e; rows = (await query<R>(sql(''), [onlyId ?? null])).rows; }
  } catch (e) {
    if (!missing(e)) console.error('[chargeback] sort by gateway:', (e as Error).message);
    return [];
  }
  if (!rows.length) return [];
  const ticks = await gatewayTicks();
  const out: { id: string; businessId: string; panelName: string; orderId: string | null }[] = [];
  for (const a of rows) {
    // The Super Admin's own move, or an order of this panel the mail names (the order proves the panel), stays.
    if (a.routed_by === 'manual' || a.routed_by === 'order' || a.order_id) continue;
    const home = gatewayElsewhere(a, ticks);
    if (home.length !== 1) continue;
    try {
      const r = await setAlertPanel(a.id, home[0].id, 'gateway');
      if (r.ok) {
        out.push({ id: a.id, businessId: home[0].id, panelName: home[0].name, orderId: r.orderId ?? null });
        console.log(`[chargeback] alert ${a.id.slice(0, 8)} moved by its gateway (${a.gateway}) to ${home[0].name}`);
      }
    } catch (e) { console.error('[chargeback] sort by gateway move:', (e as Error).message); }
  }
  return out;
}

// "Link order" (owner 2026-10-11: the Study showed all 3 chargebacks "Order not found": the gateways' mails name no order
// number of ours): the Super Admin or the Manager types the order number; it must be an order of the alert's panel. The
// customer's verified chat goes from AI to Needs you, as the poller does for a matched mail. Returns the stored order id.
export async function setAlertOrder(id: string, typed: string, scope: string[] | null = null): Promise<{ ok: boolean; status?: number; error?: string; orderId?: string }> {
  const digits = String(typed || '').replace(/[^0-9]/g, '');
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d{3,8}$/.test(digits)) return { ok: false, status: 400, error: 'Type the order number, like 1553 or #1553.' };
  const a = await queryOne<{ business_id: string }>(
    `SELECT business_id FROM chargeback_alerts WHERE id = $1 AND ($2::text[] IS NULL OR business_id = ANY($2::text[]))`, [id, scope]);
  if (!a) return { ok: false, status: 404, error: 'Alert not found.' };
  const o = await queryOne<{ order_id: string }>(
    `SELECT order_id FROM orders WHERE business_id::text = $1::text AND order_id = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
    [a.business_id, orderForms([digits])]);
  if (!o) return { ok: false, status: 404, error: 'No order with that number in this panel.' };
  await query(`UPDATE chargeback_alerts SET order_id = $2 WHERE id = $1`, [id, o.order_id]);
  try {
    await query(
      `UPDATE conversations c SET status = 'human_needed', updated_at = now()
         FROM sites s
        WHERE s.id = c.site_id AND s.tracker_business_id::text = $1::text AND c.verified_order_id = $2
          AND c.merged_into IS NULL AND c.status = 'ai_handling' AND c.case_kind IS NULL`, [a.business_id, o.order_id]);
  } catch (e) { console.error('[chargeback] link chat tag:', (e as Error).message); }
  return { ok: true, orderId: o.order_id };
}

// Opening an alert marks it seen (once); "Done" closes it with an optional note. The red tag in the chat goes with Done.
export async function setAlertStatus(id: string, status: 'seen' | 'done', byName: string, note?: string, scope: string[] | null = null): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const r = status === 'seen'
    ? await query(`UPDATE chargeback_alerts SET status = 'seen', seen_by_name = $2, seen_at = now() WHERE id = $1 AND status = 'new' AND ($3::text[] IS NULL OR business_id = ANY($3::text[]))`, [id, byName, scope])
    : await query(`UPDATE chargeback_alerts SET status = 'done', done_by_name = $2, done_at = now(), note = NULLIF($3, '') WHERE id = $1 AND status <> 'done' AND ($4::text[] IS NULL OR business_id = ANY($4::text[]))`, [id, byName, (note || '').slice(0, 500), scope]);
  return (r.rowCount ?? 0) > 0;
}

// For the inbox: which (panel, order) pairs have an open chargeback. One light query after the list; a failure is "none".
export async function openChargebackKeys(pairs: { business_id: string | null; order_id: string | null }[]): Promise<Set<string>> {
  const wanted = pairs.filter(p => p.business_id && p.order_id);
  const out = new Set<string>();
  if (wanted.length === 0) return out;
  try {
    const r = await query<{ business_id: string; order_id: string; subject: string; snippet: string }>(
      `SELECT business_id, order_id, subject, snippet FROM chargeback_alerts
        WHERE status <> 'done' AND order_id = ANY($1::text[]) AND business_id = ANY($2::text[])`,
      [wanted.map(p => p.order_id), Array.from(new Set(wanted.map(p => String(p.business_id))))]
    );
    for (const x of r.rows) if (chargebackKind(x.subject, x.snippet) === 'chargeback') out.add(`${x.business_id}|${x.order_id}`);
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
  // Other panels that read this same chargeback Gmail (names).
  sharedWith: string[];
  whatsapp: string;
  gateways: Record<string, GatewayMark>;
}

export async function panelChargeback(businessId: string): Promise<PanelChargeback> {
  const out: PanelChargeback = { installed: true, mailbox: null, sharedWith: [], whatsapp: '', gateways: {} };
  try {
    const m = await queryOne<{ id: string; email: string; created_at: string }>(`SELECT id, email, created_at FROM chargeback_mailboxes WHERE business_id = $1`, [businessId]);
    if (m) {
      out.mailbox = { id: m.id, email: m.email, createdAt: new Date(m.created_at).toISOString(), status: getMailboxStatus(`cb:${m.id}`) };
      out.sharedWith = (await sharingMap())[businessId]?.map(p => p.name) ?? [];
      // The sign-in status is kept under the first-connected panel's row (the group is read once).
      const first = await queryOne<{ id: string }>(`SELECT id FROM chargeback_mailboxes WHERE lower(email) = lower($1) ORDER BY created_at LIMIT 1`, [m.email]);
      if (first && first.id !== m.id) out.mailbox.status = getMailboxStatus(`cb:${first.id}`);
    }
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
      // Up to 5 numbers, kept as "919876543210, 919812345678" in the same text column (owner 2026-10-14).
      const { numbers, bad } = whatsappNumbers(raw);
      if (bad.length) return { ok: false, status: 400, error: `"${bad[0].slice(0, 30)}" does not look like a WhatsApp number. Type each with the country code, e.g. 919876543210, and put a comma between numbers.` };
      if (numbers.length > WHATSAPP_NUMBERS_MAX) return { ok: false, status: 400, error: `At most ${WHATSAPP_NUMBERS_MAX} numbers.` };
      whatsapp = numbers.join(', ');
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
