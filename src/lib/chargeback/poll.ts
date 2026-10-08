import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { query, queryOne } from '@/lib/db';
import { friendlyMailError, noteMailboxCheck } from '@/lib/chat/mailbox-status';
import { gatewayOf, htmlToText, orderCandidates, orderForms, shortText, whatsappNumber } from './parse';
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
  let alerts = 0;
  for (const row of rows) alerts += await pollOne(row);
  return { boxes: rows.length, alerts };
}

async function pollOne(box: Row): Promise<number> {
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: box.email, pass: box.app_password }, logger: false });
  const last = Number(box.last_uid) || 0;
  let maxUid = last, made = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const seqs = await client.search({ uid: `${last + 1}:*` });
      noteMailboxCheck(`cb:${box.id}`, { ok: true });
      if (seqs && seqs.length > 0) {
        for await (const msg of client.fetch(seqs, { uid: true, source: true })) {
          if (msg.uid <= last) continue;
          maxUid = Math.max(maxUid, msg.uid);
          try { if (await record(box, msg.uid, msg.source)) made += 1; } catch (e) { console.error('[chargeback] alert failed:', (e as Error).message); }
        }
      }
    } finally { lock.release(); }
    if (maxUid > last) await query(`UPDATE chargeback_mailboxes SET last_uid = $1 WHERE id = $2`, [maxUid, box.id]);
    if (made > 0) noteMailboxCheck(`cb:${box.id}`, { ok: true, handled: made });
    await client.logout();
  } catch (e) {
    console.error(`[chargeback] IMAP error for ${box.email}:`, (e as Error).message);
    noteMailboxCheck(`cb:${box.id}`, { ok: false, error: friendlyMailError((e as Error).message) });
  } finally {
    try { client.close(); } catch { /* already closed */ }
  }
  return made;
}

async function record(box: Row, uid: number, source: Buffer): Promise<boolean> {
  const p = await simpleParser(source);
  const from = p.from?.value?.[0];
  const fromAddress = (from?.address || '').toLowerCase();
  const fromName = from?.name || '';
  if (fromAddress === box.email.toLowerCase()) return false;       // a copy of our own mail
  const subject = (p.subject || '').trim() || '(no subject)';
  const text = p.text || (typeof p.html === 'string' ? htmlToText(p.html) : '');
  const gateway = gatewayOf(fromAddress, fromName, subject, text);

  // The order it names, confirmed against THIS panel's orders (another panel's order number never matches).
  let orderId: string | null = null;
  const forms = orderForms(orderCandidates(subject, text));
  if (forms.length > 0) {
    const o = await queryOne<{ order_id: string }>(
      `SELECT order_id FROM orders WHERE business_id::text = $1::text AND order_id = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
      [box.business_id, forms]);
    orderId = o?.order_id ?? null;
  }

  const ins = await queryOne<{ id: string }>(
    `INSERT INTO chargeback_alerts (business_id, mailbox_id, uid, received_at, from_address, from_name, subject, snippet, gateway, order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (mailbox_id, uid) DO NOTHING RETURNING id`,
    [box.business_id, box.id, uid, (p.date || new Date()).toISOString(), fromAddress, fromName.slice(0, 120), subject.slice(0, 300), shortText(text), gateway, orderId]);
  if (!ins) return false;                                          // already recorded

  // The customer's chat for that order: the AI hands it to the team (verified customers only: it was matched by order).
  if (orderId) {
    try {
      await query(
        `UPDATE conversations c SET status = 'human_needed', updated_at = now()
           FROM sites s
          WHERE s.id = c.site_id AND s.tracker_business_id::text = $1::text AND c.verified_order_id = $2
            AND c.merged_into IS NULL AND c.status = 'ai_handling' AND c.case_kind IS NULL`,
        [box.business_id, orderId]);
    } catch (e) { console.error('[chargeback] chat tag:', (e as Error).message); }
  }

  // The WhatsApp message (never blocks the alert).
  let notify = 'no_number';
  try {
    const s = await queryOne<{ whatsapp_number: string }>(`SELECT whatsapp_number FROM panel_chargeback WHERE business_id = $1`, [box.business_id]);
    const to = whatsappNumber(s?.whatsapp_number || '');
    if (to) notify = await sendChargebackWhatsApp(to, { panel: box.panel_name || 'Panel', gateway, order: orderId || 'not found' });
  } catch (e) { notify = 'failed: could not send'; console.error('[chargeback] notify:', (e as Error).message); }
  await query(`UPDATE chargeback_alerts SET notify_status = $2 WHERE id = $1`, [ins.id, notify]).catch(() => undefined);
  return true;
}
