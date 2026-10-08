import { ImapFlow } from 'imapflow';

// ── Kept-open Gmail connections for the Mail tab (owner 2026-10-08: "sloww hai, load hi nahi ho rahi") ──
// Every call used to open a NEW connection to Gmail and sign in (1-3 seconds from the server) before it did its
// work, and a list refresh and "open this mail" could not overlap. Now each mailbox keeps up to two connections
// alive in this process (one PM2 process): slot 'list' for reading the list, slot 'read' for opening a mail, a
// download, a flag, a reply. Both close after 4 minutes without use, drop themselves when Gmail closes them
// (the next call signs in again), and a call that fails on a REUSED connection is repeated once on a fresh one.
// Gmail allows about 15 connections per account; this uses at most 2 per mailbox (the poller uses its own, a short
// one per minute). The App Password never leaves this file's callers. No mail is kept here, only the connection.

interface Entry { client: ImapFlow; pass: string; ready: Promise<ImapFlow>; idle?: ReturnType<typeof setTimeout> }
export interface PoolBox { id: string; email: string; appPassword: string }
export type PoolSlot = 'list' | 'read';

const IDLE_MS = 4 * 60_000;
const G = globalThis as unknown as { __imapPool?: Map<string, Entry> };
const pool = (): Map<string, Entry> => (G.__imapPool ??= new Map());

function drop(key: string, entry: Entry): void {
  if (pool().get(key) === entry) pool().delete(key);
  if (entry.idle) clearTimeout(entry.idle);
  try { entry.client.close(); } catch { /* already closed */ }
}

function touch(key: string, entry: Entry): void {
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = setTimeout(() => {
    pool().delete(key);
    entry.client.logout().catch(() => { try { entry.client.close(); } catch { /* gone */ } });
  }, IDLE_MS);
  (entry.idle as { unref?: () => void }).unref?.();
}

async function acquire(key: string, box: PoolBox): Promise<{ client: ImapFlow; entry: Entry; reused: boolean }> {
  const cur = pool().get(key);
  if (cur && cur.pass === box.appPassword) {
    try {
      const c = await cur.ready;
      if (c.usable) { touch(key, cur); return { client: c, entry: cur, reused: true }; }
    } catch { /* it never connected: sign in again below */ }
    drop(key, cur);
  } else if (cur) {
    drop(key, cur);
  }
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: box.email, pass: box.appPassword }, logger: false });
  const entry = { client, pass: box.appPassword } as Entry;
  // An ImapFlow that errors with no listener would crash the process; a closed one simply leaves the pool.
  client.on('error', () => drop(key, entry));
  client.on('close', () => { if (pool().get(key) === entry) { pool().delete(key); if (entry.idle) clearTimeout(entry.idle); } });
  entry.ready = client.connect().then(() => client);
  pool().set(key, entry);
  try { await entry.ready; } catch (e) { drop(key, entry); throw e; }
  touch(key, entry);
  return { client, entry, reused: false };
}

export class PoolTimeout extends Error { constructor() { super('Gmail did not answer in time'); } }

// Runs fn on the mailbox's connection for that slot. A timeout drops the connection (a hung one must not be reused).
export async function withPooledImap<T>(box: PoolBox, slot: PoolSlot, fn: (c: ImapFlow) => Promise<T>, timeoutMs = 25_000): Promise<T> {
  const key = `${box.id}:${slot}`;
  for (let attempt = 0; ; attempt++) {
    const { client, entry, reused } = await acquire(key, box);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        fn(client),
        new Promise<never>((_, rej) => { timer = setTimeout(() => { drop(key, entry); rej(new PoolTimeout()); }, timeoutMs); }),
      ]);
      touch(key, entry);
      return out;
    } catch (e) {
      const err = e as { authenticationFailed?: boolean; message?: string };
      const auth = err?.authenticationFailed || /credentials|authenticat/i.test(err?.message || '');
      if (e instanceof PoolTimeout || auth) { drop(key, entry); throw e; }
      // A connection Gmail closed while it sat idle fails on first use: try once more on a fresh one.
      if (reused && attempt === 0) { drop(key, entry); continue; }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// For shutdown and for the tests.
export function closeAllImap(): void {
  for (const [key, entry] of Array.from(pool().entries())) drop(key, entry);
}
