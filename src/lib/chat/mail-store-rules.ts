// ── Mail store: the pure parts (owner 2026-10-11, "history ko load karke rakh") ──
// What a stored mail row becomes on the screen (the list item, the opened mail, the conversation), and how a
// parsed mail becomes the row's body. No database and no Gmail here: mail-store.ts reads / writes the rows,
// mail-sync.ts copies Gmail into them.
import { htmlToText } from '@/lib/chargeback/parse';
import { addressLabel, frameHtml, hasRemoteImages, textToHtml, type MailListItem } from './mail-view';

export type StoreFolder = 'inbox' | 'sent';
export interface StoreAttachment { index: number; filename: string; contentType: string; size: number; inline: boolean }
export interface StoreRow {
  id: string; box_id: string; folder: StoreFolder; uidvalidity: string; uid: string; thread_id: string | null;
  message_id: string | null; in_reply_to: string | null; refs: string | null;
  from_name: string; from_addr: string; to_list: string; to_addrs: string[]; cc_list: string; reply_to: string;
  subject: string; sent_at: string | Date; seen: boolean; answered: boolean; has_attach: boolean; auth_pass: boolean;
  body_state: 'none' | 'done' | 'failed' | 'pruned'; body_text: string | null; body_html: string | null;
  attachments: StoreAttachment[] | null; cut: boolean; local?: boolean;
}

export const STORE_TEXT_MAX = 40_000;
export const STORE_HTML_MAX = 2 * 1024 * 1024;          // an HTML part bigger than this is kept as its text only
export const INLINE_IMAGE_MAX = 512 * 1024;             // a picture inside the mail (cid:) bigger than this is not inlined
export const INLINE_TOTAL_MAX = 1536 * 1024;            // nor once the inlined pictures add up to this

const iso = (d: string | Date) => (d instanceof Date ? d : new Date(d)).toISOString();

export function rowToListItem(r: StoreRow & { snippet?: string | null; replied?: boolean | null; replied_at?: string | Date | null; thread_count?: number | null; any_unread?: boolean | null }): MailListItem {
  return {
    ...(r.snippet != null ? { snippet: String(r.snippet) } : {}),
    ...(r.replied != null ? { replied: !!r.replied } : {}),
    ...(r.replied_at != null ? { repliedAt: iso(r.replied_at) } : {}),      // when we last wrote after it (the Cases rule, owner 2026-10-11)
    ...(r.thread_count != null ? { threadCount: Number(r.thread_count) } : {}),
    uid: Number(r.uid),
    from: (r.from_name || r.from_addr || '').trim() || '(unknown sender)',
    fromAddress: (r.from_addr || '').toLowerCase(),
    subject: (r.subject || '').trim() || '(no subject)',
    date: iso(r.sent_at),
    unread: r.any_unread != null ? !!r.any_unread : !r.seen,
    hasAttachment: !!r.has_attach,
    answered: !!r.answered,
    authPass: !!r.auth_pass,
  };
}

// The opened mail, exactly the shape the screen already knows (mail-inbox.ts MailFull). null = the body is not copied yet.
export function rowToMailFull(r: StoreRow, images: boolean) {
  if (r.body_state !== 'done') return null;
  const html = r.body_html || '';
  const text = r.body_text || (html ? htmlToText(html) : '');
  return {
    uid: Number(r.uid),
    subject: (r.subject || '').trim() || '(no subject)',
    date: iso(r.sent_at),
    from: r.from_name && r.from_addr ? `${r.from_name} <${r.from_addr}>` : (r.from_name || r.from_addr || '(unknown sender)'),
    fromAddress: (r.from_addr || '').toLowerCase(),
    to: r.to_list || '', cc: r.cc_list || '', replyTo: r.reply_to || '',
    text: text.slice(0, STORE_TEXT_MAX),
    frame: frameHtml(html || textToHtml(text), images),
    remoteImages: html ? hasRemoteImages(html) : false, imagesShown: images,
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
    unread: !r.seen, answered: !!r.answered, authPass: !!r.auth_pass, cut: !!r.cut,
  };
}

// One line of the conversation (the shape of mail-inbox.ts ThreadItem, plus a short preview when the body is copied).
// sendState (owner 2026-10-11, the outbox): a reply sent from here is 'sending' until the worker has handed it to Gmail,
// then 'sent'; 'failed' with sendError after the last try (the conversation offers "Try again" by outboxId).
export type SendState = 'sending' | 'sent' | 'failed';
export interface StoreThreadItem {
  folder: StoreFolder; uid: number; from: string; to: string; subject: string; date: string; preview?: string; local?: boolean;
  sendState?: SendState; sendError?: string | null; outboxId?: string;
}
export interface SendRecord { id: string; status: 'pending' | 'sending' | 'sent' | 'failed'; error: string | null }
export function sendStateOf(s: SendRecord | null | undefined): { sendState: SendState; sendError: string | null; outboxId: string } | null {
  if (!s) return null;
  return { sendState: s.status === 'failed' ? 'failed' : s.status === 'sent' ? 'sent' : 'sending', sendError: s.status === 'failed' ? s.error : null, outboxId: s.id };
}
export function rowToThreadItem(r: StoreRow, sends?: Map<string, SendRecord>): StoreThreadItem {
  const text = (r.body_text || '').replace(/\s+/g, ' ').trim();
  const send = r.local && r.message_id && sends ? sendStateOf(sends.get(r.message_id)) : null;
  return {
    folder: r.folder, uid: Number(r.uid),
    from: (r.from_name || r.from_addr || '').trim() || '(unknown)',
    to: (r.to_list || '').split(',')[0]?.replace(/<[^>]*>/g, '').trim() || '',
    subject: (r.subject || '').trim() || '(no subject)',
    date: iso(r.sent_at),
    ...(text ? { preview: text.slice(0, 160) } : {}),
    ...(r.local ? { local: true } : {}),
    ...(send || {}),
  };
}

// The conversation: the mails of one Gmail thread and, for mails Gmail gave no thread id, the ones with that address;
// a reply sent from ShipTrack (local) is dropped once Gmail's own copy (same Message-ID) is in. Oldest first, the last 40.
// sends: the outbox rows by Message-ID (the state of a reply sent from here).
export function threadFromRows(rows: StoreRow[], sends?: Map<string, SendRecord>): StoreThreadItem[] {
  const real = new Set(rows.filter(r => !r.local && r.message_id).map(r => r.message_id));
  const seen = new Set<string>();
  const out: StoreRow[] = [];
  for (const r of rows) {
    if (r.local && r.message_id && real.has(r.message_id)) continue;
    const k = `${r.folder}:${r.uidvalidity}:${r.uid}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  return out.sort((a, b) => Date.parse(iso(a.sent_at)) - Date.parse(iso(b.sent_at))).slice(-40).map(r => rowToThreadItem(r, sends));
}

// Lists of addresses as mailparser gives them ("Name <a@b>, c@d") and the bare addresses (lower case).
interface AddrObj { value?: { name?: string; address?: string }[] }
export function addrText(v: unknown): string {
  const arr = (Array.isArray(v) ? v : v ? [v] : []) as AddrObj[];
  return arr.flatMap(x => x?.value || []).map(addressLabel).filter(Boolean).join(', ');
}
export function addrList(v: unknown): string[] {
  const arr = (Array.isArray(v) ? v : v ? [v] : []) as AddrObj[];
  return arr.flatMap(x => x?.value || []).map(a => (a.address || '').toLowerCase()).filter(Boolean);
}

// A parsed mail (mailparser) -> what the row keeps: the text, the HTML with the mail's own small pictures inlined (never
// fetched from the internet), and the attachment list (names and sizes only; the bytes stay in Gmail).
interface ParsedAttachment { filename?: string; contentType?: string; size?: number; content?: Buffer; cid?: string; contentDisposition?: string }
export interface ParsedLike { html?: string | false; text?: string; attachments?: ParsedAttachment[] }
export function bodyFromParsed(p: ParsedLike): { text: string; html: string; attachments: StoreAttachment[] } {
  let html = typeof p.html === 'string' && p.html.trim() ? p.html : '';
  let inlined = 0;
  for (const a of p.attachments || []) {
    if (!html || !a.cid || !a.content) continue;
    if (a.content.length > INLINE_IMAGE_MAX || inlined + a.content.length > INLINE_TOTAL_MAX) continue;
    const cid = a.cid.replace(/^<|>$/g, '');
    if (!html.includes(`cid:${cid}`)) continue;
    html = html.split(`cid:${cid}`).join(`data:${a.contentType};base64,${a.content.toString('base64')}`);
    inlined += a.content.length;
  }
  const text = (p.text || (html ? htmlToText(html) : '')).slice(0, STORE_TEXT_MAX);
  if (html.length > STORE_HTML_MAX) html = '';
  return {
    text, html,
    attachments: (p.attachments || []).map((a, i) => ({
      index: i, filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType || 'application/octet-stream',
      size: a.size ?? a.content?.length ?? 0, inline: !!a.cid && a.contentDisposition !== 'attachment',
    })),
  };
}

// How the sync spends its run (owner 2026-10-11, the live log: one slow Gmail's runs took 50-64 s and copied 0 bodies,
// because the sign-in (up to 13 s), the Sent folder and the 15-minute SEARCH (up to 27 s) ate the budget before the
// bodies' turn): the budget starts once the connection is ready; the order is the screen's flags, INBOX headers, the
// bodies of the INBOX mails that just arrived (never skipped: they are what the team clicks), the INBOX backlog newest
// first with a guaranteed slice, then Sent (headers + bodies), and the "gone" SEARCH only with time left.
export const SYNC_BUDGET_MS = 50_000;          // one mailbox's run stops starting new work after this (from connection ready)
export const INBOX_BODIES_MIN_MS = 20_000;     // the INBOX backlog bodies always get at least this slice
export const FRESH_BODIES_MAX = 30;            // just-arrived INBOX mails whose bodies ignore the deadline (a first copy of a whole month is a backlog)
export const BODIES_PER_RUN = 150;              // the run's budget is the real limit
export const BODY_BATCH = 10;                   // mails per Gmail FETCH
export const FLAGS_EVERY_MS = 2 * 60_000;      // a folder without CONDSTORE: the flags of its kept mails this often
export const GONE_EVERY_MS = 15 * 60_000;      // which kept mails left the folder (archived / deleted): one SEARCH this often
export const GONE_NEEDS_MS = 12_000;           // ... and only when at least this much of the budget is left (else a later run)
export const LEASE_MS = 75_000;                // a sync process holds a mailbox this long (renewed before each step, released at the end:
                                               // after a deploy's restart the other process takes over within seconds, not 3 minutes)
export const BODY_MAX_TRIES = 3;
export const PRUNE_DAYS = 120;                 // bodies older than this are dropped (the headers stay)
