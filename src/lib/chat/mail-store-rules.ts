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

export function rowToListItem(r: StoreRow): MailListItem {
  return {
    uid: Number(r.uid),
    from: (r.from_name || r.from_addr || '').trim() || '(unknown sender)',
    fromAddress: (r.from_addr || '').toLowerCase(),
    subject: (r.subject || '').trim() || '(no subject)',
    date: iso(r.sent_at),
    unread: !r.seen,
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
export interface StoreThreadItem { folder: StoreFolder; uid: number; from: string; to: string; subject: string; date: string; preview?: string; local?: boolean }
export function rowToThreadItem(r: StoreRow): StoreThreadItem {
  const text = (r.body_text || '').replace(/\s+/g, ' ').trim();
  return {
    folder: r.folder, uid: Number(r.uid),
    from: (r.from_name || r.from_addr || '').trim() || '(unknown)',
    to: (r.to_list || '').split(',')[0]?.replace(/<[^>]*>/g, '').trim() || '',
    subject: (r.subject || '').trim() || '(no subject)',
    date: iso(r.sent_at),
    ...(text ? { preview: text.slice(0, 160) } : {}),
    ...(r.local ? { local: true } : {}),
  };
}

// The conversation: the mails of one Gmail thread and, for mails Gmail gave no thread id, the ones with that address;
// a reply sent from ShipTrack (local) is dropped once Gmail's own copy (same Message-ID) is in. Oldest first, the last 40.
export function threadFromRows(rows: StoreRow[]): StoreThreadItem[] {
  const real = new Set(rows.filter(r => !r.local && r.message_id).map(r => r.message_id));
  const seen = new Set<string>();
  const out: StoreRow[] = [];
  for (const r of rows) {
    if (r.local && r.message_id && real.has(r.message_id)) continue;
    const k = `${r.folder}:${r.uidvalidity}:${r.uid}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  return out.sort((a, b) => Date.parse(iso(a.sent_at)) - Date.parse(iso(b.sent_at))).slice(-40).map(rowToThreadItem);
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

// How the sync spends its minute: headers of new mails first, then the flags, then bodies newest first.
export const SYNC_BUDGET_MS = 50_000;          // one mailbox's run stops starting new work after this
export const BODIES_PER_RUN = 40;
export const FLAGS_EVERY_MS = 2 * 60_000;      // a folder without CONDSTORE: the flags of its kept mails this often
export const GONE_EVERY_MS = 15 * 60_000;      // which kept mails left the folder (archived / deleted): one SEARCH this often
export const LEASE_MS = 3 * 60_000;            // a sync process holds a mailbox this long per run (renewed while it works)
export const BODY_MAX_TRIES = 3;
export const PRUNE_DAYS = 120;                 // bodies older than this are dropped (the headers stay)
