import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { query, queryOne } from '@/lib/db';
import { friendlyMailError, mailErrorText, noteMailboxCheck } from '@/lib/chat/mailbox-status';
import { gmailHost } from '@/lib/chat/imap-pool';
import { matchByContact } from './risk';
import { chargebackKind, gatewayKeyOf, gatewayOf, htmlToText, orderCandidates, orderForms, shortText, whatsappNumber } from './parse';
import { routeToPanel, type RoutedBy } from './routing';
import { sendChargebackWhatsApp } from './notify';

// ── Reading each panel's chargeback Gmail (owner 2026-10-08) ──────────────────────────────────
// Called by the existing every-minute chat-email-poll cron (src/lib/chat/email.ts pollAllMailboxes), so the VPS
// crontab does not change. Mail already in the Gmail when it was connected is left alone (last_uid). Every
// new mail becomes ONE alert (unique per mailbox + uid), then: the order it names is matched against THIS
// panel's orders, the customer's chat for that order is moved to Needs you when the AI had it (a verified
// customer, so the rule "only verified customers reach Needs you" holds), and the panel's WhatsApp number is
// messaged. Nothing is ever sent FROM this Gmail and the AI never reads it. A failure of any step after the
// alert is saved only shows on the alert; one bad mailbox never stops the others.

interface Row { id: string; business_id: string; email: string; app_password: string; last_uid: string | number; panel_name: string | null }
// One Gmail, one or more panels (owner 2026-10-08: the same chargeback Gmail on two panels): the group is read ONCE,
// with the first-connected panel's row as the primary (its id keys the alerts, its password signs in), and every
// mail goes to the panel routing.ts picks. last_uid is moved on for every row of the group together.
interface Group { primary: Row; rows: Row[] }

export async function pollChargebackMailboxes(): Promise<{ boxes: number; alerts: number }> {
  let rows: Row[];
  try {
    rows = (await query<Row>(
      `SELECT m.id, m.business_id, m.email, m.app_password, m.last_uid, b.name AS panel_name
         FROM chargeback_mailboxes m LEFT JOIN businesses b ON b.id::text = m.business_id ORDER BY m.created_at`)).rows;
  } catch (e) {
    if ((e as { code?: string })?.code !== '42P01') console.error('[chargeback] mailboxes:', (e as Error).message);
    return { boxes: 0, alerts: 0 };
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const k = r.email.toLowerCase();
    const g = groups.get(k);
    if (g) g.rows.push(r); else groups.set(k, { primary: r, rows: [r] });
  }
  let alerts = 0;
  for (const g of Array.from(groups.values())) alerts += await pollOne(g);
  return { boxes: groups.size, alerts };
}

// One Gmail may carry a different App Password on each panel's row (each panel connected it with the password it was
// given then). Google keeps every App Password valid until it is deleted, but the one on the first row CAN be dead
// (owner 2026-10-08: a shared Gmail "cannot be read" although the second panel had just signed in fine). So the sign-in
// tries each row's password in turn, the first-connected panel's first, and stops at the first that Gmail accepts.
async function signIn(group: Group): Promise<ImapFlow> {
  const target = await gmailHost();
  const tried = new Set<string>();
  let lastErr: unknown = null;
  for (const row of group.rows) {
    if (tried.has(row.app_password)) continue;
    tried.add(row.app_password);
    const client = new ImapFlow({ ...target, port: 993, secure: true, auth: { user: row.email, pass: row.app_password }, logger: false });
    client.on('error', () => undefined);
    try {
      await client.connect();
      if (row.id !== group.primary.id) console.warn(`[chargeback] ${row.email}: the App Password on ${group.primary.panel_name || 'the first panel'} is refused; signed in with ${row.panel_name || 'another panel'}'s`);
      return client;
    } catch (e) {
      try { client.close(); } catch { /* never opened */ }
      lastErr = e;
      const x = e as { authenticationFailed?: boolean; responseText?: string; message?: string };
      const auth = x.authenticationFailed === true || /auth|credential/i.test(`${x.responseText || ''} ${x.message || ''}`);
      if (!auth) break;                                           // not the password: the network, Gmail down; try no further
    }
  }
  throw lastErr ?? new Error('Command failed');
}

async function pollOne(group: Group): Promise<number> {
  const box = group.primary;
  const last = Math.max(...group.rows.map(r => Number(r.last_uid) || 0), 0);
  let maxUid = last, made = 0;
  let client: ImapFlow | null = null;
  try {
    client = await signIn(group);
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const seqs = await client.search({ uid: `${last + 1}:*` });
      noteMailboxCheck(`cb:${box.id}`, { ok: true });
      if (seqs && seqs.length > 0) {
        for await (const msg of client.fetch(seqs, { uid: true, source: true })) {
          if (msg.uid <= last) continue;
          maxUid = Math.max(maxUid, msg.uid);
          try { if (await record(group, msg.uid, msg.source)) made += 1; } catch (e) { console.error('[chargeback] alert failed:', (e as Error).message); }
        }
      }
    } finally { lock.release(); }
    if (maxUid > last) await query(`UPDATE chargeback_mailboxes SET last_uid = $1 WHERE id = ANY($2::uuid[])`, [maxUid, group.rows.map(r => r.id)]);
    if (made > 0) noteMailboxCheck(`cb:${box.id}`, { ok: true, handled: made });
    await client.logout();
  } catch (e) {
    const why = mailErrorText(e);
    console.error(`[chargeback] IMAP error for ${box.email}:`, why);
    noteMailboxCheck(`cb:${box.id}`, { ok: false, error: friendlyMailError(why) });
  } finally {
    try { client?.close(); } catch { /* already closed */ }
  }
  return made;
}

async function record(group: Group, uid: number, source: Buffer): Promise<boolean> {
  const box = group.primary;
  const p = await simpleParser(source);
  const from = p.from?.value?.[0];
  const fromAddress = (from?.address || '').toLowerCase();
  const fromName = from?.name || '';
  if (fromAddress === box.email.toLowerCase()) return false;       // a copy of our own mail
  const subject = (p.subject || '').trim() || '(no subject)';
  const text = p.text || (typeof p.html === 'string' ? htmlToText(p.html) : '');
  const gateway = gatewayOf(fromAddress, fromName, subject, text);

  // The order it names, confirmed against the group's panels' orders (an order number can exist in several panels).
  const panelIds = group.rows.map(r => r.business_id);
  const forms = orderForms(orderCandidates(subject, text));
  const found = forms.length > 0
    ? (await query<{ business_id: string; order_id: string }>(
      `SELECT business_id::text AS business_id, order_id FROM orders
        WHERE business_id::text = ANY($1::text[]) AND order_id = ANY($2::text[]) ORDER BY created_at DESC`,
      [panelIds, forms])).rows
    : [];
  // No order number of these panels in the mail (owner 2026-10-10: 3 chargebacks were "order not found"): a gateway's
  // dispute mail names the customer's email or phone instead. ONE order of that email / phone per panel, or nothing.
  if (!found.length) {
    try { found.push(...await matchByContact(panelIds, `${subject}\n${text}`, (p.date || new Date()).getTime())); }
    catch (e) { console.error('[chargeback] match by contact:', (e as Error).message); }
  }

  // Which panel: the only one in the group, else by the order, else by the gateway ticked in its checklist (routing.ts).
  let target = group.primary, routedBy: RoutedBy = 'single';
  if (group.rows.length > 1) {
    const gw = (await query<{ business_id: string; gateways: Record<string, { done?: boolean }> | null }>(
      `SELECT business_id, gateways FROM panel_chargeback WHERE business_id = ANY($1::text[])`, [panelIds])).rows;
    const routed = routeToPanel(
      group.rows.map(r => ({ businessId: r.business_id, gateways: gw.find(x => x.business_id === r.business_id)?.gateways ?? {} })),
      gatewayKeyOf(gateway), Array.from(new Set(found.map(f => f.business_id))));
    if (routed) { target = group.rows.find(r => r.business_id === routed.businessId) ?? group.primary; routedBy = routed.by; }
  }
  const orderId = found.find(f => f.business_id === target.business_id)?.order_id ?? null;

  const base = [target.business_id, box.id, uid, (p.date || new Date()).toISOString(), fromAddress, fromName.slice(0, 120), subject.slice(0, 300), shortText(text), gateway, orderId];
  const ins = group.rows.length > 1
    ? await queryOne<{ id: string }>(
      `INSERT INTO chargeback_alerts (business_id, mailbox_id, uid, received_at, from_address, from_name, subject, snippet, gateway, order_id, routed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (mailbox_id, uid) DO NOTHING RETURNING id`, [...base, routedBy])
    : await queryOne<{ id: string }>(
      `INSERT INTO chargeback_alerts (business_id, mailbox_id, uid, received_at, from_address, from_name, subject, snippet, gateway, order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (mailbox_id, uid) DO NOTHING RETURNING id`, base);
  if (!ins) return false;                                          // already recorded

  // The gateway's other mail (payment received, settlement, OTP; owner 2026-10-09) is kept under "Other mail" and
  // nothing more happens: no chat tag, no WhatsApp. The list reads the same words again (parse.ts chargebackKind).
  if (chargebackKind(subject, shortText(text)) === 'other') {
    await query(`UPDATE chargeback_alerts SET notify_status = $2 WHERE id = $1`, [ins.id, 'not_chargeback']).catch(() => undefined);
    return true;
  }

  // The customer's chat for that order: the AI hands it to the team (verified customers only: it was matched by order).
  if (orderId) {
    try {
      await query(
        `UPDATE conversations c SET status = 'human_needed', updated_at = now()
           FROM sites s
          WHERE s.id = c.site_id AND s.tracker_business_id::text = $1::text AND c.verified_order_id = $2
            AND c.merged_into IS NULL AND c.status = 'ai_handling' AND c.case_kind IS NULL`,
        [target.business_id, orderId]);
    } catch (e) { console.error('[chargeback] chat tag:', (e as Error).message); }
  }

  // The WhatsApp message goes to the number of the panel it was routed to (never blocks the alert).
  let notify = 'no_number';
  try {
    const s = await queryOne<{ whatsapp_number: string }>(`SELECT whatsapp_number FROM panel_chargeback WHERE business_id = $1`, [target.business_id]);
    const to = whatsappNumber(s?.whatsapp_number || '');
    if (to) notify = await sendChargebackWhatsApp(to, { panel: target.panel_name || 'Panel', gateway, order: orderId || 'not found' });
  } catch (e) { notify = 'failed: could not send'; console.error('[chargeback] notify:', (e as Error).message); }
  await query(`UPDATE chargeback_alerts SET notify_status = $2 WHERE id = $1`, [ins.id, notify]).catch(() => undefined);
  return true;
}
