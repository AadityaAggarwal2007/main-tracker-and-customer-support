import { listMails, readMail, setSeen, type MailBoxSecret, type MailFull } from './mail-inbox';
import type { MailListItem } from './mail-view';
import type { PoolSlot } from './imap-pool';
import { autoVerifySenders } from './mail-auto-verify';

// ── The Gmail history kept on the server (owner 2026-10-09: "Gmail kholna bahut slow hai, teeno panel par; inki
// history bana ke rakh") ──
// Before this every open of the Mail tab asked Gmail for the whole list again (5-25 s on a big mailbox) and every
// click downloaded the mail again. Now the server keeps, in the PM2 process's memory, each mailbox's last list and
// the mails that were opened or read ahead, and the every-minute poller (email.ts pollAllMailboxes -> warmMailboxes)
// keeps the lists fresh and reads the newest mails ahead, so the tab opens from memory at once on every panel.
// Memory only: no customer mail is written to the database or the disk; a restart empties it and the next poller
// minute fills it again. Gmail stays the truth: a list older than LIST_FRESH_MS is read again in the background
// when it is asked for, and read / answered flags set from here are written to Gmail and mirrored in the copy.

export interface CachedList { mails: MailListItem[]; unread: number; truncated: boolean; days: number; at: number }
interface CachedMail { mail: MailFull; at: number; bytes: number }

export const LIST_FRESH_MS = 45_000;          // a list this old is answered at once and refreshed behind the screen
export const LIST_WARM_MS = 4 * 60_000;       // the poller reads a list again when it is this old
export const MAIL_TTL_MS = 30 * 60_000;       // an opened mail is kept this long
export const MAIL_MAX = 400;                  // and at most this many ...
export const MAIL_BUDGET_BYTES = 48 * 1024 * 1024;   // ... within this much memory
export const PREREAD = 20;                    // the poller reads ahead this many of the newest mails per mailbox (only the ones not kept yet)

const lists = new Map<string, CachedList>();
const inflight = new Map<string, Promise<CachedList>>();
const mails = new Map<string, CachedMail>();   // insertion order = age; re-set on every hit (LRU)
let mailBytes = 0;

const mailKey = (boxId: string, uid: number, images: boolean) => `${boxId}:${uid}:${images ? 1 : 0}`;

export function cachedList(boxId: string): CachedList | null { return lists.get(boxId) ?? null; }

// Reads the full list from Gmail (headers only), runs the automatic sender checks (mail-auto-verify.ts) and keeps it.
// One read per mailbox at a time: a second caller waits for the same read.
export function refreshList(box: MailBoxSecret, now = Date.now()): Promise<CachedList> {
  const running = inflight.get(box.id);
  if (running) return running;
  const p = (async () => {
    const r = await listMails(box, now, { phase: 'full' });
    try { await autoVerifySenders(box.panelId, r.mails.map(m => ({ email: m.fromAddress, authPass: m.authPass, subject: m.subject }))); }
    catch (e) { console.error('[mail-cache] auto-verify:', (e as Error).message); }
    const entry: CachedList = { mails: r.mails, unread: r.unread, truncated: r.truncated, days: r.days, at: Date.now() };
    lists.set(box.id, entry);
    // A mail that left the inbox (archived, deleted) is forgotten.
    const keep = new Set(r.mails.map(m => m.uid));
    for (const [k, v] of Array.from(mails.entries())) if (k.startsWith(`${box.id}:`) && !keep.has(v.mail.uid)) drop(k);
    return entry;
  })().finally(() => inflight.delete(box.id));
  inflight.set(box.id, p);
  return p;
}

// The list for the screen: the kept one at once (refreshed behind it when old), else read now.
export async function listCached(box: MailBoxSecret, now = Date.now()): Promise<CachedList & { cached: boolean }> {
  const have = lists.get(box.id);
  if (have) {
    if (now - have.at > LIST_FRESH_MS) refreshList(box, now).catch(e => console.error('[mail-cache] refresh:', (e as Error).message));
    return { ...have, cached: true };
  }
  return { ...await refreshList(box, now), cached: false };
}

function drop(key: string): void {
  const v = mails.get(key);
  if (!v) return;
  mails.delete(key);
  mailBytes -= v.bytes;
}
function store(key: string, mail: MailFull, now: number): void {
  drop(key);
  const bytes = mail.frame.length + mail.text.length + 2048;
  mails.set(key, { mail, at: now, bytes });
  mailBytes += bytes;
  for (const [k, v] of Array.from(mails.entries())) {
    if (mails.size <= MAIL_MAX && mailBytes <= MAIL_BUDGET_BYTES && now - v.at <= MAIL_TTL_MS) break;
    if (k === key) continue;
    drop(k);
  }
}
export function cachedMail(boxId: string, uid: number, images = false, now = Date.now()): MailFull | null {
  const key = mailKey(boxId, uid, images);
  const v = mails.get(key);
  if (!v) return null;
  if (now - v.at > MAIL_TTL_MS) { drop(key); return null; }
  mails.delete(key); mails.set(key, v);   // most recently used
  return v.mail;
}

// Opens one INBOX mail from the copy when it is there (marking it read in Gmail with one flag call when the screen
// asks for that and the list still says unread), else from Gmail, and keeps it.
export async function readMailCached(box: MailBoxSecret, uid: number, opts: { markRead?: boolean; images?: boolean; slot?: PoolSlot } = {}, now = Date.now()): Promise<MailFull | null> {
  const images = !!opts.images;
  const have = cachedMail(box.id, uid, images, now);
  const listed = lists.get(box.id)?.mails.find(m => m.uid === uid);
  if (have) {
    if (opts.markRead !== false && listed?.unread) {
      try { await setSeen(box, uid, true); noteSeen(box.id, uid, true); } catch (e) { console.error('[mail-cache] seen:', (e as Error).message); }
    }
    return { ...have, unread: false, answered: listed?.answered ?? have.answered };
  }
  const mail = await readMail(box, uid, { markRead: opts.markRead, images, folder: 'inbox', slot: opts.slot });
  if (!mail) return null;
  store(mailKey(box.id, uid, images), mail, now);
  if (opts.markRead !== false) noteSeen(box.id, uid, true);
  return mail;
}

// The screen (or the poller) changed a flag in Gmail: the copy follows at once.
export function noteSeen(boxId: string, uid: number, seen: boolean): void {
  const l = lists.get(boxId);
  if (!l) return;
  const m = l.mails.find(x => x.uid === uid);
  if (m && m.unread === seen) { m.unread = !seen; l.unread = l.mails.filter(x => x.unread).length; }
}
export function noteAnswered(boxId: string, uid: number): void {
  const m = lists.get(boxId)?.mails.find(x => x.uid === uid);
  if (m) m.answered = true;
  for (const images of [false, true]) { const v = mails.get(mailKey(boxId, uid, images)); if (v) v.mail.answered = true; }
}

// The poller's minute: a list older than LIST_WARM_MS is read again, then the newest mails not yet kept are read ahead
// (never marking them read). Mailboxes one after another, one warm run at a time, never throwing.
let warmChain: Promise<void> = Promise.resolve();
export function warmMailboxes(boxes: MailBoxSecret[], now = Date.now()): Promise<void> {
  warmChain = warmChain.then(async () => { for (const b of boxes) await warmMailbox(b, now).catch(e => console.error(`[mail-cache] warm ${b.email}:`, (e as Error).message)); });
  return warmChain;
}
export async function warmMailbox(box: MailBoxSecret, now = Date.now()): Promise<{ refreshed: boolean; preread: number }> {
  const have = lists.get(box.id);
  const refreshed = !have || now - have.at > LIST_WARM_MS;
  const list = refreshed ? await refreshList(box, now) : have!;
  let preread = 0;
  for (const m of list.mails) {
    if (preread >= PREREAD) break;
    if (cachedMail(box.id, m.uid, false, now)) continue;
    const mail = await readMail(box, m.uid, { markRead: false, folder: 'inbox', slot: 'bg' });
    if (mail) { store(mailKey(box.id, m.uid, false), mail, now); preread += 1; }
  }
  return { refreshed, preread };
}

// For the tests and a sign-out of every mailbox: forget everything.
export function clearMailServerCache(): void { lists.clear(); inflight.clear(); mails.clear(); mailBytes = 0; }
export function mailCacheStats(): { lists: number; mails: number; bytes: number } { return { lists: lists.size, mails: mails.size, bytes: mailBytes }; }
