import fs from 'fs';
import path from 'path';
import { listMails, listThread, readMail, setSeen, type MailBoxSecret, type MailFull, type ThreadItem } from './mail-inbox';
import type { MailListItem } from './mail-view';
import type { PoolSlot } from './imap-pool';
import { autoVerifySenders } from './mail-auto-verify';

// ── The Gmail history kept on the server (owner 2026-10-09: "Gmail kholna bahut slow hai, teeno panel par; inki
// history bana ke rakh") ──
// Before this every open of the Mail tab asked Gmail for the whole list again (5-25 s on a big mailbox) and every
// click downloaded the mail again. Now the server keeps, in the PM2 process's memory, each mailbox's last list and
// the mails that were opened or read ahead, and the every-minute poller (email.ts pollAllMailboxes -> warmMailboxes)
// keeps the lists fresh and reads the newest mails ahead, so the tab opens from memory at once on every panel.
// The copy also lives in ONE file on the server's disk (owner 2026-10-09 night, "slow hai abhi bhi": from this VPS a
// Gmail sign-in takes 2-14 s and one mail 2-3 s, so filling the copy again after every deploy's PM2 restart took
// minutes, and the tab was slow until then): MAIL_CACHE_DIR/mail-cache.json (default <app>/.mail-cache, gitignored,
// mode 0600, written only after something changed, never the App Password), read once at start, so a restart
// answers from the copy at once. Nothing goes to the database. Gmail stays the truth: a list older than LIST_FRESH_MS
// is read again in the background when it is asked for, the poller reads every list again each minute (which also
// keeps the Gmail connections alive) and reads the rest of the month's mails ahead a few at a time until every mail
// is kept, and read / answered flags set from here are written to Gmail and mirrored in the copy.

export interface CachedList { mails: MailListItem[]; unread: number; truncated: boolean; days: number; at: number }
interface CachedMail { mail: MailFull; at: number; bytes: number }

export const LIST_FRESH_MS = 45_000;          // a list this old is answered at once and refreshed behind the screen
export const LIST_WARM_MS = 50_000;           // the poller (every minute) reads a list again when it is this old
export const MAIL_TTL_MS = 24 * 3_600_000;    // a kept mail is forgotten after a day unopened (a mail's text never changes)
export const MAIL_MAX = 600;                  // and at most this many ...
export const MAIL_BUDGET_BYTES = 96 * 1024 * 1024;   // ... within this much memory
export const PREREAD = 10;                    // the poller reads ahead this many not-yet-kept mails per mailbox per minute, newest first, until all are kept

const lists = new Map<string, CachedList>();
const inflight = new Map<string, Promise<CachedList>>();
const mails = new Map<string, CachedMail>();   // insertion order = age; re-set on every hit (LRU)
let mailBytes = 0;

const mailKey = (boxId: string, uid: number, images: boolean) => `${boxId}:${uid}:${images ? 1 : 0}`;

// ── the file on disk ──
// MAIL_CACHE_DIR: where the file lives ('off' = memory only, the tests' default); the app directory's .mail-cache otherwise.
const cacheFile = (): string | null => {
  const dir = process.env.MAIL_CACHE_DIR || path.join(process.cwd(), '.mail-cache');
  return dir === 'off' ? null : path.join(dir, 'mail-cache.json');
};
let loaded = false;
let dirty = false;
let saving: Promise<void> | null = null;
interface Snapshot { v: 1; lists: [string, CachedList][]; mails: [string, CachedMail][] }
// Read once, at the first use after a start. A broken or missing file is simply an empty copy.
export function loadFromDisk(): boolean {
  if (loaded) return false;
  loaded = true;
  const file = cacheFile();
  if (!file) return false;
  try {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
    if (snap?.v !== 1 || !Array.isArray(snap.lists) || !Array.isArray(snap.mails)) return false;
    const now = Date.now();
    for (const [k, v] of snap.lists) if (v && Array.isArray(v.mails)) lists.set(k, v);
    for (const [k, v] of snap.mails) if (v?.mail && now - v.at <= MAIL_TTL_MS) { mails.set(k, v); mailBytes += v.bytes; }
    console.log(`[mail-cache] loaded ${lists.size} lists and ${mails.size} mails from disk`);
    return true;
  } catch (e) {
    if ((e as { code?: string })?.code !== 'ENOENT') console.error('[mail-cache] load:', (e as Error).message);
    return false;
  }
}
// Written whole, to a temporary name first, only when something changed; at most one write at a time.
export function saveToDisk(): Promise<void> {
  const file = cacheFile();
  if (!file || !dirty) return Promise.resolve();
  if (saving) return saving;
  dirty = false;
  saving = (async () => {
    try {
      const snap: Snapshot = { v: 1, lists: Array.from(lists.entries()), mails: Array.from(mails.entries()) };
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(snap), { mode: 0o600 });
      await fs.promises.rename(tmp, file);
    } catch (e) { dirty = true; console.error('[mail-cache] save:', (e as Error).message); }
    finally { saving = null; }
  })();
  return saving;
}
const changed = () => { dirty = true; };

export function cachedList(boxId: string): CachedList | null { loadFromDisk(); return lists.get(boxId) ?? null; }

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
    lists.set(box.id, entry); changed();
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
  loadFromDisk();
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
  mailBytes += bytes; changed();
  for (const [k, v] of Array.from(mails.entries())) {
    if (mails.size <= MAIL_MAX && mailBytes <= MAIL_BUDGET_BYTES && now - v.at <= MAIL_TTL_MS) break;
    if (k === key) continue;
    drop(k);
  }
}
export function cachedMail(boxId: string, uid: number, images = false, now = Date.now()): MailFull | null {
  loadFromDisk();
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
  if (m && m.unread === seen) { m.unread = !seen; l.unread = l.mails.filter(x => x.unread).length; changed(); }
}
export function noteAnswered(boxId: string, uid: number): void {
  const m = lists.get(boxId)?.mails.find(x => x.uid === uid);
  if (m) { m.answered = true; changed(); }
  for (const images of [false, true]) { const v = mails.get(mailKey(boxId, uid, images)); if (v) v.mail.answered = true; }
}

// The poller's minute: every list older than LIST_WARM_MS is read again (which also keeps that Gmail connection
// alive), then up to PREREAD not-yet-kept mails are read ahead, newest first (never marking them read), so within
// a few minutes every mail of the month is kept and every click is instant. The mailboxes run side by side (each has
// its own connections); one warm run at a time; never throwing; the file is written afterwards when something changed.
let warmChain: Promise<void> = Promise.resolve();
export function warmMailboxes(boxes: MailBoxSecret[], now = Date.now()): Promise<void> {
  warmChain = warmChain.then(async () => {
    await Promise.all(boxes.map(b => warmMailbox(b, now).catch(e => console.error(`[mail-cache] warm ${b.email}:`, (e as Error).message))));
    await saveToDisk();
  });
  return warmChain;
}
export async function warmMailbox(box: MailBoxSecret, now = Date.now()): Promise<{ refreshed: boolean; preread: number; left: number }> {
  loadFromDisk();
  const have = lists.get(box.id);
  const refreshed = !have || now - have.at > LIST_WARM_MS;
  const list = refreshed ? await refreshList(box, now) : have!;
  const todo = list.mails.filter(m => !cachedMail(box.id, m.uid, false, now)).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  let preread = 0;
  for (const m of todo.slice(0, PREREAD)) {
    const mail = await readMail(box, m.uid, { markRead: false, folder: 'inbox', slot: 'bg' });
    if (mail) { store(mailKey(box.id, m.uid, false), mail, now); preread += 1; }
  }
  return { refreshed, preread, left: Math.max(0, todo.length - preread) };
}

// ── The open mail's conversation (owner 2026-10-10: "Conversation" kept spinning) ──
// Kept in memory per mailbox + address: a copy younger than THREAD_FRESH_MS is answered at once; an older one is answered
// at once AND read again behind the screen; none = read now (one read per address at a time). fresh = read now (after a
// reply). Memory only, at most THREAD_MAX conversations; never written to disk.
export const THREAD_FRESH_MS = 60_000;
const THREAD_MAX = 300;
const threads = new Map<string, { at: number; items: ThreadItem[] }>();
const threadReads = new Map<string, Promise<ThreadItem[]>>();
export async function threadFor(box: MailBoxSecret, address: string, opts: { fresh?: boolean } = {}, now = Date.now()): Promise<{ items: ThreadItem[]; cached: boolean }> {
  const key = `${box.id}|${address.toLowerCase()}`;
  const read = () => {
    let p = threadReads.get(key);
    if (!p) {
      p = listThread(box, address).then((items) => {
        threads.delete(key); threads.set(key, { at: Date.now(), items });
        while (threads.size > THREAD_MAX) threads.delete(threads.keys().next().value as string);
        return items;
      }).finally(() => threadReads.delete(key));
      threadReads.set(key, p);
    }
    return p;
  };
  const have = threads.get(key);
  if (have && !opts.fresh) {
    if (now - have.at > THREAD_FRESH_MS) read().catch((e) => console.error(`[mail-cache] thread ${box.email}:`, (e as Error).message));
    return { items: have.items, cached: true };
  }
  return { items: await read(), cached: false };
}

// For the tests and a sign-out of every mailbox: forget everything.
export function clearMailServerCache(): void { lists.clear(); inflight.clear(); mails.clear(); threads.clear(); threadReads.clear(); mailBytes = 0; dirty = false; loaded = true; }
// For the tests: forget that the file was read, so the next use reads it again.
export function forgetDiskLoad(): void { loaded = false; }
export function mailCacheStats(): { lists: number; mails: number; bytes: number } { return { lists: lists.size, mails: mails.size, bytes: mailBytes }; }
