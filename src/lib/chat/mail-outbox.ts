// ── Mail outbox: a reply from the Mail tab is queued, then sent in the background (owner 2026-10-11, "Send and open
// next" spun for minutes and nothing went: Gmail's SMTP hung and nodemailer had no timeout, inside the HTTP request) ──
// /api/mail/send only writes the finished reply into mail_outbox (mail-outbox.sql) and answers at once; runOutbox()
// (kicked right after, and from the sync loop every 30 s and the minute cron for retries) sends the rows one by one:
//   - a row is CLAIMED first (status 'sending' + claimed_at, WHERE it is still pending, or 'sending' from a process that
//     died more than 3 minutes ago), so the two PM2 processes never send the same reply twice;
//   - sent over ONE kept-open pooled SMTP connection per mailbox, with timeouts (sign-in 20 s, greeting 20 s, socket
//     60 s), dropped after any error (an auth error too) so the next try signs in again;
//   - success = 'sent' + sent_at; a failure puts it back to 'pending' with the reason, tried again 30 s later, and after
//     5 tries it is 'failed' (the conversation shows "Not sent: ... · Try again", which sets it pending again).
// The message itself (From, In-Reply-To, References, our Message-ID) is reply-mail.ts, the same as Chat Support's own
// sending. Imports no other mail module (email.ts and mail-sync.ts call this one). Until mail-outbox.sql is run
// (42P01) outboxInstalled() is false and the route sends the old way, inside the request.
import nodemailer from 'nodemailer';
import { query, queryOne } from '@/lib/db';
import { cbBoxRows, isCbBox } from './mail-cb-box';
import { replyMailMessage } from './reply-mail';

interface ErrCode { code?: string }
const missing = (e: unknown) => ['42P01', '42703'].includes((e as ErrCode)?.code || '');

export const OUTBOX_MAX_TRIES = 5;
export const OUTBOX_RETRY_MS = 30_000;          // a failed send waits this long before the next try
export const OUTBOX_STALE_MS = 3 * 60_000;      // a 'sending' row older than this = its process died: claimed again
const SEND_CAP_MS = 90_000;                     // never wait longer than this on one send, whatever the socket does

export interface OutboxFile { filename: string; contentType: string; content: string }   // content = base64
export interface OutboxReply {
  boxId: string; replyUid: number | null; uidvalidity: string | null; to: string; subject: string; textBody: string; htmlBody: string;
  messageId: string; inReplyTo: string | null; references: string | null; files: OutboxFile[]; createdBy: string;
}
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed';
export interface OutboxState { id: string; messageId: string; status: OutboxStatus; error: string | null; tries: number }

// Is the outbox installed? (the table exists) Cached a minute per process.
let installed: { at: number; ok: boolean } | null = null;
export async function outboxInstalled(now = Date.now()): Promise<boolean> {
  if (installed && now - installed.at < 60_000) return installed.ok;
  let ok = false;
  try { await query(`SELECT 1 FROM mail_outbox LIMIT 1`); ok = true; }
  catch (e) { if (!missing(e)) console.error('[mail-outbox] check:', (e as Error).message); }
  installed = { at: now, ok };
  return ok;
}
export function forgetOutboxInstalled(): void { installed = null; }

// The row the route writes. Returns its id.
export async function enqueueReply(r: OutboxReply): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO mail_outbox (box_id, reply_uid, uidvalidity, to_addr, subject, text_body, html_body, message_id, in_reply_to, refs, files, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12) RETURNING id::text AS id`,
    [r.boxId, r.replyUid, r.uidvalidity, r.to.toLowerCase(), r.subject, r.textBody, r.htmlBody, r.messageId, r.inReplyTo, r.references, JSON.stringify(r.files), r.createdBy]);
  return row!.id;
}

// The state of the replies with these Message-IDs (the conversation shows Sending… / Sent / Not sent). Empty when the
// outbox is not installed.
export async function outboxStates(boxId: string, messageIds: string[]): Promise<Map<string, OutboxState>> {
  const out = new Map<string, OutboxState>();
  if (!messageIds.length) return out;
  try {
    const r = await query<{ id: string; message_id: string; status: OutboxStatus; error: string | null; tries: number }>(
      `SELECT id::text AS id, message_id, status, error, tries FROM mail_outbox WHERE box_id = $1 AND message_id = ANY($2::text[])`, [boxId, messageIds]);
    for (const x of r.rows) out.set(x.message_id, { id: x.id, messageId: x.message_id, status: x.status, error: x.error, tries: x.tries });
  } catch (e) { if (!missing(e)) console.error('[mail-outbox] states:', (e as Error).message); }
  return out;
}

// "Try again" on a failed reply: pending again with fresh tries. Only a row of that mailbox (the route checked the login
// may reply in it). false = no such failed row.
export async function retryOutbox(id: string, boxId: string): Promise<boolean> {
  const r = await query(`UPDATE mail_outbox SET status = 'pending', tries = 0, claimed_at = NULL, updated_at = now() WHERE id = $1 AND box_id = $2 AND status = 'failed'`, [id, boxId]);
  return (r.rowCount ?? 0) > 0;
}

interface OutboxRow {
  id: string; box_id: string; to_addr: string; subject: string; text_body: string; html_body: string; message_id: string;
  in_reply_to: string | null; refs: string | null; files: OutboxFile[] | null; tries: number; reply_uid?: string | number | null;
}

// The claim: one process gets the row, the other sees nothing back.
export async function claimOutbox(id: string): Promise<OutboxRow | null> {
  return queryOne<OutboxRow>(
    `UPDATE mail_outbox SET status = 'sending', claimed_at = now(), tries = tries + 1, updated_at = now()
      WHERE id = $1 AND (status = 'pending' OR (status = 'sending' AND claimed_at < now() - $2 * interval '1 millisecond'))
      RETURNING id::text AS id, box_id, to_addr, subject, text_body, html_body, message_id, in_reply_to, refs, files, tries, reply_uid`,
    [id, OUTBOX_STALE_MS]);
}

// The mailbox's own address, name and App Password (site_emails), read for one send and never returned. Not through
// mail-inbox.ts (that file imports email.ts, which calls this one: no import cycle).
interface BoxRow { email: string; app_password: string; site_name: string }
// A chargeback Gmail (`cb:<row id>`, mail-cb-box.ts) answers from itself, as "<panel> Support".
async function boxSecret(boxId: string): Promise<BoxRow | null> {
  if (isCbBox(boxId)) {
    const r = (await cbBoxRows(boxId))[0];
    return r ? { email: r.email, app_password: r.app_password, site_name: r.site_name } : null;
  }
  return queryOne<BoxRow>(`SELECT se.email, se.app_password, s.name AS site_name FROM site_emails se JOIN sites s ON s.id = se.site_id WHERE se.id = $1`, [boxId]);
}

// One pooled SMTP connection per mailbox, kept in the process; dropped after any error.
interface Transport { sendMail: (o: unknown) => Promise<unknown>; close?: () => void }
const transports = new Map<string, { pass: string; t: Transport }>();
function transportFor(boxId: string, box: BoxRow): Transport {
  const have = transports.get(boxId);
  if (have && have.pass === box.app_password) return have.t;
  if (have) { try { have.t.close?.(); } catch { /* gone */ } }
  const t = nodemailer.createTransport({
    pool: true, host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: box.email, pass: box.app_password }, tls: { rejectUnauthorized: false },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
  } as never) as unknown as Transport;
  transports.set(boxId, { pass: box.app_password, t });
  return t;
}
function dropTransport(boxId: string): void {
  const have = transports.get(boxId);
  if (!have) return;
  transports.delete(boxId);
  try { have.t.close?.(); } catch { /* gone */ }
}
export function closeOutboxTransports(): void { for (const id of Array.from(transports.keys())) dropTransport(id); }

async function sendRow(row: OutboxRow): Promise<void> {
  const box = await boxSecret(row.box_id);
  if (!box) throw new Error('the mailbox is no longer connected');
  const files = (Array.isArray(row.files) ? row.files : []).map(f => ({ filename: f.filename, contentType: f.contentType, content: Buffer.from(f.content, 'base64') }));
  const msg = replyMailMessage({
    fromEmail: box.email, fromName: `${box.site_name} Support`, toEmail: row.to_addr, subject: row.subject,
    htmlBody: row.html_body, textBody: row.text_body, replyToMessageId: row.in_reply_to, references: row.refs,
    attachments: files.length ? files : undefined, messageId: row.message_id,
    // A row that answers no mail (no uid, no In-Reply-To) is a new mail: a chat reply sent by Gmail too (chat-mail.ts).
    fresh: row.reply_uid == null && !row.in_reply_to,
  });
  const t = transportFor(row.box_id, box);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      t.sendMail(msg),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('Gmail did not answer in time (SMTP)'), { capped: true })), SEND_CAP_MS); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

// Plain words for the conversation ("Not sent: ..."), never the App Password or a server dump.
export function outboxErrorText(e: unknown): string {
  const m = String((e as Error)?.message || e || 'unknown error').replace(/\s+/g, ' ').trim();
  if (/invalid login|username and password not accepted|auth/i.test(m)) return 'Gmail rejected the App Password for this mailbox. Connect it again in Settings → Email Support.';
  if (/did not answer in time|timeout|timed out|ETIMEDOUT|ECONNRESET|socket/i.test(m)) return 'Gmail did not answer in time.';
  return m.slice(0, 300);
}

async function sendOne(id: string): Promise<'sent' | 'failed' | 'pending' | 'taken'> {
  const row = await claimOutbox(id);
  if (!row) return 'taken';
  try {
    await sendRow(row);
    await query(`UPDATE mail_outbox SET status = 'sent', sent_at = now(), error = NULL, updated_at = now() WHERE id = $1`, [row.id]);
    console.log(`[mail-outbox] id=${row.id} box=${row.box_id} sent (try ${row.tries})`);
    return 'sent';
  } catch (e) {
    dropTransport(row.box_id);
    // Our own 90 s cap fired while Gmail still had the mail: it may have gone out after all, so it is never sent again by
    // itself (review 2026-10-14: a slow send could reach the customer twice). The team checks Sent, then Try again.
    const capped = !!(e as { capped?: boolean })?.capped;
    const text = capped ? 'Gmail did not confirm in time, so it may still have been sent. Check Gmail\'s Sent folder before pressing Try again.' : outboxErrorText(e);
    const final = capped || row.tries >= OUTBOX_MAX_TRIES;
    await query(`UPDATE mail_outbox SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [row.id, final ? 'failed' : 'pending', text]);
    console.error(`[mail-outbox] id=${row.id} box=${row.box_id} try ${row.tries}${final ? ' FAILED for good' : ''}: ${text}`);
    return final ? 'failed' : 'pending';
  }
}

// Every waiting row, one at a time. One run at a time per process (a second call joins the running one). Never throws.
const G = globalThis as unknown as { __mailOutboxRun?: Promise<number> | null };
export async function runOutbox(): Promise<number> {
  if (G.__mailOutboxRun) return G.__mailOutboxRun;
  const run = (async () => {
    let sent = 0;
    try {
      if (!(await outboxInstalled())) return 0;
      const todo = await query<{ id: string }>(
        `SELECT id::text AS id FROM mail_outbox
          WHERE (status = 'pending' AND (tries = 0 OR claimed_at IS NULL OR claimed_at < now() - $1 * interval '1 millisecond'))
             OR (status = 'sending' AND claimed_at < now() - $2 * interval '1 millisecond')
          ORDER BY id LIMIT 25`, [OUTBOX_RETRY_MS, OUTBOX_STALE_MS]);
      for (const r of todo.rows) if ((await sendOne(r.id)) === 'sent') sent++;
    } catch (e) { console.error('[mail-outbox] run:', (e as Error).message); }
    return sent;
  })();
  G.__mailOutboxRun = run;
  try { return await run; } finally { G.__mailOutboxRun = null; }
}
