// ── The chargeback Gmail in the Mail tab (owner 2026-10-13: "jo email chargeback ka lia connect ki ha na uspa bhi
// email arha ha customers ka aur hum log dekh nai pa rha ... VASTRIKA aur kurtiya dono pa chargeback ki 1 hi mail ha
// ... agar tuh chhaant paaye toh bhut badhia, nai toh chargeback mail ka mail ma 1 option bana de"; answers: everyone
// with the Mail tick sees it, a reply goes from that same Gmail) ──
// Each panel's chargeback Gmail (chargeback_mailboxes) is one more mailbox in the Mail tab, id `cb:<row id>`, read and
// answered exactly like a support Gmail (mail store, sync, outbox, verify, cases), for that panel. The chargeback
// poller (chargeback/poll.ts) is untouched: it reads by uid (last_uid), so the Mail tab marking a mail read changes
// nothing for it. No Chikki, no email chats: these mails never reach Chat Support.
//
// One Gmail shared by two panels: each panel has its own box (its own copy in the mail store), and a mail PROVEN to be
// another panel's customer (the sender's address is on an order of the other panel, or verified there, and not on
// this one; else the order number it names exists only in the other panel) is left out of this panel's list. A mail
// we cannot place (a new customer, a gateway) shows in both: nobody is hidden by a guess.
import { query } from '@/lib/db';
import { orderCandidates, orderForms } from '@/lib/chargeback/parse';

export const CB_PREFIX = 'cb:';
export const isCbBox = (id: string | null | undefined) => typeof id === 'string' && id.startsWith(CB_PREFIX);
export const cbRowId = (id: string) => id.slice(CB_PREFIX.length);
const missing = (e: unknown) => ['42P01', '42703'].includes((e as { code?: string })?.code || '');

// The rows the Mail tab reads, shaped like mail-inbox.ts's site_emails rows (site = the panel's first chat site, for
// the reply's "<name> Support"; none = the panel's name). `shared_with` = the other panels on the same address.
// The App Password: the NEWEST one saved for that address (each connect checks it with Gmail first), so one panel's
// old, dead password never stops that panel's box from syncing or replying (review 2026-10-14; the poller tries every
// row's password, chargeback/poll.ts signIn).
export const CB_BOXES_SQL = `SELECT '${CB_PREFIX}' || m.id::text AS id, m.email,
        COALESCE((SELECT o.app_password FROM chargeback_mailboxes o WHERE lower(o.email) = lower(m.email)
                   ORDER BY o.created_at DESC LIMIT 1), m.app_password) AS app_password,
        (SELECT s.id FROM sites s WHERE s.tracker_business_id::text = m.business_id ORDER BY s.created_at ASC LIMIT 1) AS site_id,
        COALESCE((SELECT s.name FROM sites s WHERE s.tracker_business_id::text = m.business_id ORDER BY s.created_at ASC LIMIT 1), b.name, m.email) AS site_name,
        m.business_id AS panel_id, b.name AS panel_name,
        ARRAY(SELECT COALESCE(b2.name, o.business_id) FROM chargeback_mailboxes o LEFT JOIN businesses b2 ON b2.id::text = o.business_id
               WHERE lower(o.email) = lower(m.email) AND o.id <> m.id ORDER BY 1) AS shared_with
   FROM chargeback_mailboxes m LEFT JOIN businesses b ON b.id::text = m.business_id`;

export interface CbBoxRow { id: string; email: string; app_password: string; site_id: string | null; site_name: string; panel_id: string | null; panel_name: string | null; shared_with: string[] | null }

// Every chargeback box (or one by its `cb:` id). A missing table (chargeback-setup.sql not run) = none.
export async function cbBoxRows(id?: string): Promise<CbBoxRow[]> {
  try {
    const r = id
      ? await query<CbBoxRow>(`${CB_BOXES_SQL} WHERE m.id::text = $1`, [cbRowId(id)])
      : await query<CbBoxRow>(`${CB_BOXES_SQL} ORDER BY b.name NULLS LAST, m.created_at ASC`);
    return r.rows;
  } catch (e) {
    if (!missing(e)) console.error('[mail-cb] boxes:', (e as Error).message);
    return [];
  }
}

// Pure: is this mail another panel's? `addrPanels` = the panels (of the group) the sender's address belongs to,
// `orderPanels` = the panels that have an order the mail names. The address wins; unknown = keep.
export function belongsElsewhere(own: string, addrPanels: string[], orderPanels: string[]): boolean {
  if (addrPanels.length) return !addrPanels.includes(own);
  if (orderPanels.length) return !orderPanels.includes(own);
  return false;
}

interface Placeable { uid: number; fromAddress: string; subject: string; snippet?: string }

// The uids to leave out of a shared chargeback box's list for `own` panel. Not shared / not a chargeback box / any
// failed read = nothing hidden.
export async function hiddenForPanel(boxId: string, own: string | null, mails: Placeable[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (!isCbBox(boxId) || !own || !mails.length) return out;
  try {
    const g = await query<{ business_id: string }>(
      `SELECT o.business_id FROM chargeback_mailboxes m JOIN chargeback_mailboxes o ON lower(o.email) = lower(m.email)
        WHERE m.id::text = $1`, [cbRowId(boxId)]);
    const panels = Array.from(new Set(g.rows.map(r => String(r.business_id))));
    if (panels.length < 2) return out;
    const addrs = Array.from(new Set(mails.map(m => (m.fromAddress || '').trim().toLowerCase()).filter(Boolean)));
    const byAddr = new Map<string, Set<string>>();
    const note = (k: string, p: string) => { if (!byAddr.has(k)) byAddr.set(k, new Set()); byAddr.get(k)!.add(p); };
    if (addrs.length) {
      const o = await query<{ email: string; panel: string }>(
        `SELECT DISTINCT lower(btrim(customer_email)) AS email, business_id::text AS panel FROM orders
          WHERE business_id::text = ANY($1::text[]) AND lower(btrim(customer_email)) = ANY($2::text[])`, [panels, addrs]);
      for (const r of o.rows) note(r.email, r.panel);
      try {
        const v = await query<{ email: string; panel: string }>(
          `SELECT DISTINCT lower(email) AS email, business_id::text AS panel FROM mail_verifications
            WHERE business_id::text = ANY($1::text[]) AND lower(email) = ANY($2::text[]) AND removed_at IS NULL`, [panels, addrs]);
        for (const r of v.rows) note(r.email, r.panel);
      } catch (e) { if (!missing(e)) throw e; }
    }
    const named = new Map<number, string[]>();
    for (const m of mails) {
      const key = (m.fromAddress || '').trim().toLowerCase();
      if (byAddr.has(key)) continue;
      const c = orderCandidates(m.subject || '', m.snippet || '');
      if (c.length) named.set(m.uid, orderForms(c));
    }
    const forms = Array.from(new Set(Array.from(named.values()).flat()));
    const byOrder = new Map<string, Set<string>>();
    if (forms.length) {
      const o = await query<{ order_id: string; panel: string }>(
        `SELECT DISTINCT order_id, business_id::text AS panel FROM orders WHERE business_id::text = ANY($1::text[]) AND order_id = ANY($2::text[])`,
        [panels, forms]);
      for (const r of o.rows) {
        const k = String(r.order_id).replace(/^#/, '');
        if (!byOrder.has(k)) byOrder.set(k, new Set());
        byOrder.get(k)!.add(r.panel);
      }
    }
    for (const m of mails) {
      const a = Array.from(byAddr.get((m.fromAddress || '').trim().toLowerCase()) || []);
      const op = new Set<string>();
      for (const f of named.get(m.uid) || []) for (const p of Array.from(byOrder.get(f.replace(/^#/, '')) || [])) op.add(p);
      if (belongsElsewhere(own, a, Array.from(op))) out.add(m.uid);
    }
  } catch (e) {
    console.error('[mail-cb] split:', (e as Error).message);
    return new Set();
  }
  return out;
}
