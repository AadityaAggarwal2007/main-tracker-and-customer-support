import type { ImapFlow } from 'imapflow';
import { htmlToText } from '@/lib/chargeback/parse';
import { PoolTimeout, withPooledImap, type PoolSlot } from './imap-pool';
import { simpleParser } from 'mailparser';
import { query } from '@/lib/db';
import { canAccessPanel, type PermissionHolder } from '@/lib/permissions';
import { buildEmailHtml, sendEmailReply } from './email';
import { MAX_MAILS, MAIL_DAYS, addressLabel, firstAuthResults, frameHtml, gmailAuthPassed, hasRemoteImages, replyBodyHtml, replyBodyText, replySubject, sinceDate, sortMails, textToHtml, type MailListItem } from './mail-view';

// ── The Mail tab, server side (owner 2026-10-08) ──────────────────────────────────────────────
// Reads a panel's real Gmail inbox over IMAP when a screen asks, and sends a reply over SMTP. Nothing is
// stored: no mail text, no list. The App Password is read from site_emails for one call and never returned.
// Who may use it is decided by the routes (mail-access.ts) and by mailboxFor(): the Super Admin sees every
// panel's Gmail, a member only the panels they are limited to, and only with the Mail ticks.

export interface MailBoxInfo { id: string; email: string; siteName: string; panelId: string | null; panelName: string }
export interface MailBoxSecret extends MailBoxInfo { appPassword: string; siteId: string }

const ALL_BOXES_SQL = `SELECT se.id, se.email, se.app_password, s.id AS site_id, s.name AS site_name,
        s.tracker_business_id::text AS panel_id, b.name AS panel_name
   FROM site_emails se
   JOIN sites s ON s.id = se.site_id
   LEFT JOIN businesses b ON b.id::text = s.tracker_business_id::text`;

interface BoxRow { id: string; email: string; app_password: string; site_id: string; site_name: string; panel_id: string | null; panel_name: string | null }
const toBox = (r: BoxRow): MailBoxSecret => ({ id: r.id, email: r.email, appPassword: r.app_password, siteId: r.site_id, siteName: r.site_name, panelId: r.panel_id, panelName: r.panel_name || r.site_name });
const publicBox = ({ appPassword: _p, siteId: _s, ...rest }: MailBoxSecret): MailBoxInfo => rest;

// The mailboxes this login may open (the panel check is the real gate).
export async function mailboxesFor(user: PermissionHolder): Promise<MailBoxInfo[]> {
  const r = await query<BoxRow>(`${ALL_BOXES_SQL} ORDER BY b.name NULLS LAST, se.created_at ASC`);
  return r.rows.filter(x => canAccessPanel(user, x.panel_id)).map(x => publicBox(toBox(x)));
}

// One mailbox with its secret, only when this login may open it; null otherwise (the route answers 404).
export async function mailboxFor(user: PermissionHolder, id: string): Promise<MailBoxSecret | null> {
  if (!id) return null;
  const r = await query<BoxRow>(`${ALL_BOXES_SQL} WHERE se.id = $1`, [id]);
  const row = r.rows[0];
  if (!row || !canAccessPanel(user, row.panel_id)) return null;
  return toBox(row);
}

export class MailError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

// One IMAP session on the mailbox's kept-open connection (imap-pool.ts): 'list' for reading the list, 'read' for
// everything else, so opening a mail never waits for a list refresh. A session that hangs is cut after 25 s.
async function withImap<T>(box: MailBoxSecret, fn: (c: ImapFlow) => Promise<T>, slot: PoolSlot = 'read'): Promise<T> {
  try {
    return await withPooledImap(box, slot, fn);
  } catch (e) {
    if (e instanceof MailError) throw e;
    if (e instanceof PoolTimeout) throw new MailError('Gmail did not answer in time. Try again.', 504);
    const err = e as { authenticationFailed?: boolean; message?: string };
    if (err?.authenticationFailed || /credentials|authenticat/i.test(err?.message || '')) throw new MailError('Gmail rejected the App Password for this mailbox. Connect it again in Settings → Email Support.', 502);
    throw new MailError('Could not read Gmail right now. Try again in a moment.', 502);
  }
}

interface StructNode { disposition?: string; childNodes?: StructNode[] }
function hasAttachmentPart(node: StructNode | undefined): boolean {
  if (!node) return false;
  if (typeof node.disposition === 'string' && node.disposition.toLowerCase() === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachmentPart);
}

// The last 30 days, unread first (opts.from: only mails from that address). Headers only: no body is downloaded for the list.
export async function listMails(box: MailBoxSecret, now = Date.now(), opts: { from?: string } = {}): Promise<{ mails: MailListItem[]; unread: number; truncated: boolean; days: number }> {
  return withImap(box, async (c) => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      const seqs = await c.search(opts.from ? { since: sinceDate(now), from: opts.from } : { since: sinceDate(now) });
      if (!seqs || seqs.length === 0) return { mails: [], unread: 0, truncated: false, days: MAIL_DAYS };
      const truncated = seqs.length > MAX_MAILS;
      const wanted = seqs.slice(-MAX_MAILS);
      const out: MailListItem[] = [];
      for await (const m of c.fetch(wanted, { uid: true, flags: true, envelope: true, bodyStructure: true, headers: ['authentication-results'] })) {
        const from = m.envelope?.from?.[0];
        const flags = m.flags ?? new Set<string>();
        out.push({
          uid: m.uid,
          from: (from?.name || from?.address || '').trim() || '(unknown sender)',
          fromAddress: (from?.address || '').toLowerCase(),
          subject: (m.envelope?.subject || '').trim() || '(no subject)',
          date: (m.envelope?.date ? new Date(m.envelope.date) : new Date(now)).toISOString(),
          unread: !flags.has('\\Seen'),
          hasAttachment: hasAttachmentPart(m.bodyStructure as StructNode | undefined),
          answered: flags.has('\\Answered'),
          authPass: gmailAuthPassed(firstAuthResults(m.headers as Buffer | undefined)),
        });
      }
      const mails = sortMails(out);
      return { mails, unread: mails.filter(x => x.unread).length, truncated, days: MAIL_DAYS };
    } finally { lock.release(); }
  }, 'list');
}

export type MailFolder = 'inbox' | 'sent';

// Gmail's Sent folder path (it is called "[Gmail]/Sent Mail" in English and differs by language): found by its
// special-use flag and remembered per mailbox.
const SENT_PATHS = new Map<string, string>();
export function forgetSentPaths(): void { SENT_PATHS.clear(); }   // for the tests
async function sentPath(c: ImapFlow, boxId: string): Promise<string | null> {
  const known = SENT_PATHS.get(boxId);
  if (known) return known;
  try {
    const all = await c.list();
    const sent = all.find(b => b.specialUse === '\\Sent') ?? all.find(b => /sent/i.test(b.path) && !b.flags?.has('\\Noselect'));
    if (sent?.path) { SENT_PATHS.set(boxId, sent.path); return sent.path; }
  } catch { /* no Sent folder readable: the thread shows received mail only */ }
  return null;
}

export interface MailAttachmentInfo { index: number; filename: string; contentType: string; size: number; inline: boolean }
export interface MailFull {
  uid: number; subject: string; date: string;
  from: string; fromAddress: string; to: string; cc: string; replyTo: string;
  text: string; frame: string; remoteImages: boolean; imagesShown: boolean;
  attachments: MailAttachmentInfo[]; unread: boolean; answered: boolean;
  // Gmail's own dmarc=pass on this mail (the sender's address is real): automatic verification needs it.
  authPass: boolean;
}

async function fetchSource(c: ImapFlow, uid: number): Promise<{ source: Buffer; flags: Set<string> } | null> {
  const m = await c.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
  if (!m || !m.source) return null;
  return { source: m.source, flags: m.flags ?? new Set<string>() };
}

const MAX_INLINE_BYTES = 2 * 1024 * 1024;

// Opens one mail. markRead (default) sets Gmail's Seen flag, like opening it in Gmail.
export async function readMail(box: MailBoxSecret, uid: number, opts: { markRead?: boolean; images?: boolean; folder?: MailFolder } = {}): Promise<MailFull | null> {
  return withImap(box, async (c) => {
    const path = opts.folder === 'sent' ? await sentPath(c, box.id) : 'INBOX';
    if (!path) return null;
    const lock = await c.getMailboxLock(path, { readOnly: opts.markRead === false || opts.folder === 'sent' });
    try {
      const got = await fetchSource(c, uid);
      if (!got) return null;
      const wasUnread = !got.flags.has('\\Seen');
      if (opts.markRead !== false && wasUnread && opts.folder !== 'sent') { try { await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch { /* best effort */ } }
      const p = await simpleParser(got.source);
      let html = typeof p.html === 'string' && p.html.trim() ? p.html : '';
      // Pictures that came inside the mail (cid:) are shown from the mail itself, never from the internet.
      for (const a of p.attachments || []) {
        if (html && a.cid && a.content && a.content.length <= MAX_INLINE_BYTES) {
          const cid = a.cid.replace(/^<|>$/g, '');
          html = html.split(`cid:${cid}`).join(`data:${a.contentType};base64,${a.content.toString('base64')}`);
        }
      }
      // An HTML-only mail has no plain part: its text is made from the HTML (the quote and the order-number check need it).
      const text = p.text || (html ? htmlToText(html) : '');
      const from = p.from?.value?.[0];
      const list = (v: unknown) => {
        const arr = Array.isArray(v) ? v : v ? [v] : [];
        return arr.flatMap((x: { value?: { name?: string; address?: string }[] }) => x?.value || []).map(addressLabel).filter(Boolean).join(', ');
      };
      const remote = html ? hasRemoteImages(html) : false;
      return {
        uid,
        subject: (p.subject || '').trim() || '(no subject)',
        date: (p.date || new Date()).toISOString(),
        from: addressLabel(from) || '(unknown sender)', fromAddress: (from?.address || '').toLowerCase(),
        to: list(p.to), cc: list(p.cc), replyTo: list(p.replyTo),
        text: text.slice(0, 40_000),
        frame: frameHtml(html || textToHtml(text), !!opts.images),
        remoteImages: remote, imagesShown: !!opts.images,
        attachments: (p.attachments || []).map((a, i) => ({
          index: i, filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType || 'application/octet-stream',
          size: a.size ?? a.content?.length ?? 0, inline: !!a.cid && a.contentDisposition !== 'attachment',
        })),
        unread: false, answered: got.flags.has('\\Answered'),
        authPass: gmailAuthPassed((p.headerLines || []).find(h => h.key === 'authentication-results')?.line.replace(/^authentication-results:\s*/i, '') ?? null),
      };
    } finally { lock.release(); }
  });
}

// "Mark unread" / "Mark read" from the screen.
export async function setSeen(box: MailBoxSecret, uid: number, seen: boolean): Promise<boolean> {
  return withImap(box, async (c) => {
    const lock = await c.getMailboxLock('INBOX');
    try {
      const ok = seen
        ? await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
        : await c.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      return !!ok;
    } finally { lock.release(); }
  });
}

// One attachment's bytes (the route sends it as a download, never as a page).
export async function attachmentBytes(box: MailBoxSecret, uid: number, index: number): Promise<{ filename: string; content: Buffer } | null> {
  return withImap(box, async (c) => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      const got = await fetchSource(c, uid);
      if (!got) return null;
      const p = await simpleParser(got.source);
      const a = (p.attachments || [])[index];
      if (!a || !a.content) return null;
      return { filename: a.filename || `attachment-${index + 1}`, content: a.content };
    } finally { lock.release(); }
  });
}

export interface ReplyFile { filename: string; content: Buffer; contentType: string }

// A reply to one mail, sent from the mailbox's own Gmail address like a normal Gmail reply (owner 2026-10-08): the
// typed text, then Gmail's quote of the original after it (includeQuote), optional files, In-Reply-To /
// References so it stays in the same Gmail conversation. Gmail keeps the copy in Sent. The quote is built HERE from
// the mail itself, never taken from the browser.
export async function sendMailReply(box: MailBoxSecret, uid: number, text: string, opts: { includeQuote?: boolean; files?: ReplyFile[] } = {}): Promise<{ to: string }> {
  const orig = await withImap(box, async (c) => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      const got = await fetchSource(c, uid);
      if (!got) return null;
      const p = await simpleParser(got.source);
      const refs = Array.isArray(p.references) ? p.references.join(' ') : (p.references || '');
      const target = p.replyTo?.value?.[0]?.address || p.from?.value?.[0]?.address || '';
      return {
        to: target.toLowerCase(), subject: p.subject || '', messageId: p.messageId || '', references: refs,
        date: (p.date || new Date()).toISOString(), fromLabel: addressLabel(p.from?.value?.[0]) || target,
        text: p.text || (typeof p.html === 'string' ? htmlToText(p.html) : ''),
      };
    } finally { lock.release(); }
  });
  if (!orig) throw new MailError('That mail is no longer in the inbox.', 404);
  if (!orig.to) throw new MailError('That mail has no address to reply to.', 400);
  if (orig.to === box.email.toLowerCase()) throw new MailError('That mail came from this same Gmail address.', 400);
  const quote = opts.includeQuote === false ? null : { dateIso: orig.date, fromLabel: orig.fromLabel, original: orig.text };
  try {
    await sendEmailReply({
      fromEmail: box.email, fromName: `${box.siteName} Support`, appPassword: box.appPassword, toEmail: orig.to,
      subject: replySubject(orig.subject), htmlBody: replyBodyHtml(text, quote), textBody: replyBodyText(text, quote),
      replyToMessageId: orig.messageId || null, references: orig.references || null,
      attachments: opts.files && opts.files.length ? opts.files : undefined,
    });
  } catch {
    throw new MailError('Gmail did not accept the reply. Nothing was sent. Try again.', 502);
  }
  try { await setAnswered(box, uid); } catch { /* the reply is out; the flag is a courtesy */ }
  return { to: orig.to };
}

export interface ThreadItem { folder: MailFolder; uid: number; from: string; to: string; subject: string; date: string }

// The whole conversation with one address (owner 2026-10-08, "Gmail ki tarah conversation view"): what that address
// sent to this Gmail (INBOX, FROM) and what this Gmail sent to it (Sent, TO), the last 30 days, oldest first.
// Headers only; a body is read when one is opened (readMail with folder).
export async function listThread(box: MailBoxSecret, address: string, now = Date.now()): Promise<ThreadItem[]> {
  const since = sinceDate(now);
  const out: ThreadItem[] = [];
  const grab = async (c: ImapFlow, path: string, folder: MailFolder, criteria: Record<string, unknown>) => {
    const lock = await c.getMailboxLock(path, { readOnly: true });
    try {
      const seqs = await c.search(criteria as never);
      if (!seqs || seqs.length === 0) return;
      for await (const m of c.fetch(seqs.slice(-30), { uid: true, envelope: true })) {
        const f = m.envelope?.from?.[0], t = m.envelope?.to?.[0];
        out.push({
          folder, uid: m.uid,
          from: (f?.name || f?.address || '').trim() || '(unknown)', to: (t?.name || t?.address || '').trim(),
          subject: (m.envelope?.subject || '').trim() || '(no subject)',
          date: (m.envelope?.date ? new Date(m.envelope.date) : new Date(now)).toISOString(),
        });
      }
    } finally { lock.release(); }
  };
  await withImap(box, async (c) => {
    await grab(c, 'INBOX', 'inbox', { since, from: address });
    const sent = await sentPath(c, box.id);
    if (sent) await grab(c, sent, 'sent', { since, to: address });
  });
  return out.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0)).slice(-40);
}

async function setAnswered(box: MailBoxSecret, uid: number): Promise<void> {
  await withImap(box, async (c) => {
    const lock = await c.getMailboxLock('INBOX');
    try { await c.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true }); } finally { lock.release(); }
  });
}

// The secrets of every mailbox of one chat site this login may open (the chat thread's "Emails" list).
export async function mailboxesForSite(user: PermissionHolder, siteId: string): Promise<MailBoxSecret[]> {
  if (!siteId) return [];
  const r = await query<BoxRow>(`${ALL_BOXES_SQL} WHERE s.id = $1 ORDER BY se.created_at ASC`, [siteId]);
  return r.rows.filter(x => canAccessPanel(user, x.panel_id)).map(toBox);
}
