// ── Mail store: the background copy from Gmail (owner 2026-10-11, "history ko load karke rakh, baar baar read karega
// toh kaise baat banegi") ──
// ONE kept-open Gmail connection per mailbox (imap-pool.ts slot 'sync'), in ONE server process at a time (the lease in
// mail_sync_lease; the app runs two PM2 processes), every 30 seconds. The order inside a run (owner 2026-10-11, the live
// log: one slow Gmail's runs took 50-64 s and copied "bodies=0" because the sign-in, the Sent folder and the 15-minute
// SEARCH used the budget first, and a mail that arrived at 9:19 still had no body at 9:24):
//   1. the screen's flag changes (mail_actions) are written to Gmail;
//   2. INBOX: the new mails' headers (UID above the last copied one; the first time, the last 30 days) and the changed
//      read / answered flags (CONDSTORE: only what changed);
//   3. AT ONCE the bodies of the INBOX mails whose headers came in this run (never skipped by the deadline: they are what
//      the team clicks), then the INBOX backlog newest first with a guaranteed slice of the budget;
//   4. the Sent folder (headers, flags, bodies) with what is left;
//   5. which kept mails left a folder (archived / deleted -> gone): one SEARCH per folder, at most every 15 minutes, only
//      when time is left (else a later run).
// The budget (SYNC_BUDGET_MS) starts once the connection is ready, not before a 13-second sign-in; the lease (75 s) is
// renewed before each step and released when the run ends, so after a deploy's restart the other process takes a mailbox
// over within seconds. Bodies = text, HTML with the mail's own small pictures, the attachment list; the bytes stay in Gmail.
// New INBOX senders go through the automatic verification (mail-auto-verify.ts) like before. Never throws; a failed run
// writes its reason on mail_sync.error and tries again next time. Until mail-store.sql is run it does nothing and the
// Mail tab keeps the old live path.
import os from 'os';
import type { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { query } from '@/lib/db';
import { withPooledImap, type PoolBox } from './imap-pool';
import { mailErrorText } from './mailbox-status';
import { STORE_LIST_DAYS, firstAuthResults, gmailAuthPassed, sinceDate } from './mail-view';
import { autoVerifySenders } from './mail-auto-verify';
import { cbBoxRows } from './mail-cb-box';
import {
  BODIES_PER_RUN, BODY_BATCH, BODY_MAX_TRIES, FLAGS_EVERY_MS, FRESH_BODIES_MAX, GONE_EVERY_MS, GONE_NEEDS_MS, INBOX_BODIES_MIN_MS, LEASE_MS,
  PRUNE_DAYS, SYNC_BUDGET_MS, addrList, addrText, bodyFromParsed, type StoreFolder,
} from './mail-store-rules';

export interface SyncBox extends PoolBox { panelId: string | null }
interface SyncState { box_id: string; folder: StoreFolder; path: string | null; uidvalidity: string | null; last_uid: string; modseq: string | null; full_at: string | null; flags_at: string | null }
export interface SyncResult { box: string; skipped?: string; fresh: number; flags: number; gone: number; bodies: number; actions: number; error?: string }

interface ErrCode { code?: string }
const missing = (e: unknown) => ['42P01', '42703'].includes((e as ErrCode)?.code || '');
const ME = `${os.hostname()}:${process.pid}`;
const VIEW_BYTES = 3 * 1024 * 1024;

// Is the store installed? (the table exists) Cached a minute; false = the Mail tab stays on its old path.
let installed: { at: number; ok: boolean } | null = null;
export async function storeInstalled(now = Date.now()): Promise<boolean> {
  if (installed && now - installed.at < 60_000) return installed.ok;
  let ok = false;
  try { await query(`SELECT 1 FROM mail_sync LIMIT 1`); ok = true; }
  catch (e) { if (!missing(e)) console.error('[mail-sync] check:', (e as Error).message); }
  installed = { at: now, ok };
  return ok;
}

async function takeLease(boxId: string): Promise<boolean> {
  const r = await query(
    `INSERT INTO mail_sync_lease (box_id, lease_by, lease_until) VALUES ($1, $2, now() + $3 * interval '1 millisecond')
     ON CONFLICT (box_id) DO UPDATE SET lease_by = EXCLUDED.lease_by, lease_until = EXCLUDED.lease_until
      WHERE mail_sync_lease.lease_until < now() OR mail_sync_lease.lease_by = EXCLUDED.lease_by
     RETURNING box_id`, [boxId, ME, LEASE_MS]);
  return (r.rowCount ?? 0) > 0;
}
// Renewed before each step of a run (a run may take ~75 s; the lease alone is 75 s), released when the run ends.
async function renewLease(boxId: string): Promise<void> {
  await query(`UPDATE mail_sync_lease SET lease_until = now() + $2 * interval '1 millisecond' WHERE box_id = $1 AND lease_by = $3`, [boxId, LEASE_MS, ME]).catch(() => {});
}
async function releaseLease(boxId: string): Promise<void> {
  await query(`UPDATE mail_sync_lease SET lease_until = now() WHERE box_id = $1 AND lease_by = $2`, [boxId, ME]).catch(() => {});
}
// On the way out (PM2's SIGTERM at a deploy, Ctrl-C, a normal exit): every lease this process holds is released so the
// other process can take the mailboxes at once. Best effort: never blocks the exit; the signal is re-raised when nobody
// else handles it (Next.js's own server does, and exits by itself).
export async function releaseMyLeases(): Promise<void> {
  await query(`UPDATE mail_sync_lease SET lease_until = now() WHERE lease_by = $1 AND lease_until > now()`, [ME]).catch(() => {});
}
const GX = globalThis as unknown as { __mailSyncExitHook?: boolean };
function installExitHook(): void {
  if (GX.__mailSyncExitHook) return;
  GX.__mailSyncExitHook = true;
  const onSignal = (sig: NodeJS.Signals) => {
    const others = process.listenerCount(sig);
    void Promise.race([releaseMyLeases(), new Promise(r => setTimeout(r, 1500))]).finally(() => { if (others === 0) process.kill(process.pid, sig); });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.once('beforeExit', () => { void releaseMyLeases(); });
}

async function stateOf(boxId: string, folder: StoreFolder): Promise<SyncState | null> {
  const r = await query<SyncState>(
    `SELECT box_id, folder, path, uidvalidity::text AS uidvalidity, last_uid::text AS last_uid, modseq, full_at, flags_at FROM mail_sync WHERE box_id = $1 AND folder = $2`, [boxId, folder]);
  return r.rows[0] || null;
}

// Gmail's Sent folder ("[Gmail]/Sent Mail" in English, another name in other languages): by its special-use flag.
async function sentPath(c: ImapFlow): Promise<string | null> {
  try {
    const all = await c.list();
    const s = all.find(b => b.specialUse === '\\Sent') ?? all.find(b => /sent/i.test(b.path) && !b.flags?.has('\\Noselect'));
    return s?.path || null;
  } catch { return null; }
}

interface StructNode { disposition?: string; childNodes?: StructNode[] }
const hasAttachmentPart = (n: StructNode | undefined): boolean =>
  !!n && ((typeof n.disposition === 'string' && n.disposition.toLowerCase() === 'attachment') || (n.childNodes || []).some(hasAttachmentPart));

interface FetchedHead {
  uid: number; flags?: Set<string>; threadId?: string; size?: number; headers?: Buffer; bodyStructure?: unknown;
  envelope?: { date?: Date; subject?: string; messageId?: string; inReplyTo?: string; from?: { name?: string; address?: string }[]; to?: { name?: string; address?: string }[]; cc?: { name?: string; address?: string }[]; replyTo?: { name?: string; address?: string }[] };
}
const HEAD_QUERY = { uid: true, flags: true, envelope: true, bodyStructure: true, threadId: true, size: true, headers: ['authentication-results', 'references'] };
const envList = (l?: { name?: string; address?: string }[]) => ({ value: l || [] });

function referencesOf(headers?: Buffer): string {
  if (!headers) return '';
  const raw = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const m = raw.match(/^references:\s*(.*)$/im);
  return m ? m[1].trim().slice(0, 4000) : '';
}

async function saveHead(boxId: string, folder: StoreFolder, uidvalidity: string, m: FetchedHead): Promise<{ id: string; verify: { email: string; authPass: boolean; subject: string } | null }> {
  const env = m.envelope || {};
  const from = env.from?.[0];
  const flags = m.flags ?? new Set<string>();
  const sentAt = env.date && !isNaN(new Date(env.date).getTime()) ? new Date(env.date) : new Date();
  const authPass = gmailAuthPassed(firstAuthResults(m.headers));
  const ins = await query<{ id: string }>(
    `INSERT INTO mail_store (box_id, folder, uidvalidity, uid, thread_id, message_id, in_reply_to, refs, from_name, from_addr,
                             to_list, to_addrs, cc_list, reply_to, subject, sent_at, seen, answered, has_attach, auth_pass, size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (box_id, folder, uidvalidity, uid) DO UPDATE
       SET seen = EXCLUDED.seen, answered = EXCLUDED.answered, thread_id = COALESCE(EXCLUDED.thread_id, mail_store.thread_id),
           gone = false, updated_at = now()
     RETURNING id::text AS id`,
    [boxId, folder, uidvalidity, m.uid, m.threadId ? String(m.threadId) : null, env.messageId || null, env.inReplyTo || null, referencesOf(m.headers) || null,
      (from?.name || '').trim().slice(0, 300), (from?.address || '').toLowerCase().slice(0, 300),
      addrText(envList(env.to)).slice(0, 2000), addrList(envList(env.to)).slice(0, 50), addrText(envList(env.cc)).slice(0, 2000), addrText(envList(env.replyTo)).slice(0, 1000),
      (env.subject || '').trim().slice(0, 1000), sentAt, flags.has('\\Seen'), flags.has('\\Answered'),
      hasAttachmentPart(m.bodyStructure as StructNode | undefined), authPass, m.size ?? null]);
  return { id: ins.rows[0]?.id || '', verify: folder === 'inbox' && from?.address ? { email: from.address.toLowerCase(), authPass, subject: env.subject || '' } : null };
}

// One folder: new headers and changed flags. Returns the counts and the rows of the mails that just arrived (their bodies
// come first). The "gone" SEARCH is a separate step (syncGone), run only with time left.
async function syncFolder(c: ImapFlow, box: SyncBox, folder: StoreFolder, path: string, now: number): Promise<{ fresh: number; flags: number; freshIds: string[] }> {
  const out = { fresh: 0, flags: 0, freshIds: [] as string[] };
  const st = await stateOf(box.id, folder);
  const lock = await c.getMailboxLock(path, { readOnly: true });
  try {
    const mb = c.mailbox as unknown as { uidValidity?: bigint | number; uidNext?: number; highestModseq?: bigint | number } | false;
    if (!mb) return out;
    const uidvalidity = String(mb.uidValidity ?? 0);
    const modseqNow = mb.highestModseq != null ? String(mb.highestModseq) : null;
    const since = sinceDate(now, STORE_LIST_DAYS);
    const restart = !st || st.uidvalidity !== uidvalidity;
    if (restart && st) await query(`UPDATE mail_store SET gone = true, updated_at = now() WHERE box_id = $1 AND folder = $2 AND uidvalidity <> $3 AND NOT gone`, [box.id, folder, uidvalidity]);
    let lastUid = restart ? 0 : Number(st!.last_uid || 0);
    const verify: { email: string; authPass: boolean; subject: string }[] = [];

    // 1. new mails (the first time: the last 30 days)
    let uids: number[] = [];
    if (restart || lastUid === 0) {
      uids = ((await c.search({ since }, { uid: true })) || []) as number[];
    } else if (!mb.uidNext || mb.uidNext > lastUid + 1) {
      for await (const m of c.fetch(`${lastUid + 1}:*`, { uid: true }, { uid: true })) if (m.uid > lastUid) uids.push(m.uid);
    }
    uids.sort((a, b) => a - b);
    for (let i = 0; i < uids.length; i += 100) {
      const chunk = uids.slice(i, i + 100);
      for await (const m of c.fetch(chunk.join(','), HEAD_QUERY as never, { uid: true })) {
        const v = await saveHead(box.id, folder, uidvalidity, m as unknown as FetchedHead);
        if (v.verify) verify.push(v.verify);
        if (v.id) out.freshIds.push(v.id);
        out.fresh++;
        lastUid = Math.max(lastUid, m.uid);
      }
    }
    if (mb.uidNext && (restart || lastUid === 0)) lastUid = Math.max(lastUid, mb.uidNext - 1);

    // 2. flags that changed since the last look (CONDSTORE); without it, the kept mails' flags every few minutes
    let flagsAt = st?.flags_at ? Date.parse(st.flags_at) : 0;
    if (!restart && st) {
      const flagRows: { uid: number; seen: boolean; answered: boolean }[] = [];
      if (modseqNow && st.modseq && modseqNow !== st.modseq) {
        for await (const m of c.fetch('1:*', { uid: true, flags: true }, { uid: true, changedSince: BigInt(st.modseq) } as never)) {
          const f = m.flags ?? new Set<string>();
          flagRows.push({ uid: m.uid, seen: f.has('\\Seen'), answered: f.has('\\Answered') });
        }
      } else if (!modseqNow && now - flagsAt >= FLAGS_EVERY_MS) {
        const kept = await query<{ uid: string }>(`SELECT uid::text AS uid FROM mail_store WHERE box_id = $1 AND folder = $2 AND uidvalidity = $3 AND NOT gone AND sent_at >= $4`, [box.id, folder, uidvalidity, since]);
        if (kept.rows.length) {
          for await (const m of c.fetch(kept.rows.map(r => r.uid).join(','), { uid: true, flags: true }, { uid: true })) {
            const f = m.flags ?? new Set<string>();
            flagRows.push({ uid: m.uid, seen: f.has('\\Seen'), answered: f.has('\\Answered') });
          }
        }
        flagsAt = now;
      }
      // A mail the screen just changed (a mail_actions row Gmail has not got yet) keeps the screen's flag: Gmail's older
      // flag must not undo a click made while the flags were being read (owner 2026-10-11 afternoon, "Unread ka feature
      // nahi chal raha"); the next run writes the click to Gmail (applyActions runs first) and reads it back.
      for (const f of flagRows) {
        const r = await query(`UPDATE mail_store SET seen = $5, answered = $6, updated_at = now()
                                WHERE box_id = $1 AND folder = $2 AND uidvalidity = $3 AND uid = $4 AND (seen <> $5 OR answered <> $6)
                                  AND NOT EXISTS (SELECT 1 FROM mail_actions a WHERE a.box_id = $1 AND a.folder = $2 AND a.uidvalidity = $3 AND a.uid = $4 AND a.done_at IS NULL)`,
          [box.id, folder, uidvalidity, f.uid, f.seen, f.answered]);
        out.flags += r.rowCount ?? 0;
      }
    }

    // A re-copied folder (new uidvalidity) counts as fully checked now; otherwise the full check (gone mails) is syncGone's.
    const fullAt = restart || !st?.full_at ? now : Date.parse(st.full_at);

    await query(
      `INSERT INTO mail_sync (box_id, folder, path, uidvalidity, last_uid, modseq, full_at, flags_at, ok_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
       ON CONFLICT (box_id, folder) DO UPDATE SET path = EXCLUDED.path, uidvalidity = EXCLUDED.uidvalidity, last_uid = EXCLUDED.last_uid,
         modseq = EXCLUDED.modseq, full_at = EXCLUDED.full_at, flags_at = EXCLUDED.flags_at, ok_at = now(), updated_at = now()`,
      [box.id, folder, path, uidvalidity, lastUid, modseqNow, new Date(fullAt), flagsAt ? new Date(flagsAt) : null]);

    if (verify.length) {
      try { await autoVerifySenders(box.panelId, verify); } catch (e) { console.error('[mail-sync] auto-verify:', (e as Error).message); }
    }
    return out;
  } finally { lock.release(); }
}

// Which kept mails left the folder (archived / deleted in Gmail): one SEARCH (up to 27 s on a slow Gmail), so at most every
// 15 minutes and only when the run has time left; a run that skips it leaves it to a later one.
async function syncGone(c: ImapFlow, box: SyncBox, folder: StoreFolder, path: string, now: number): Promise<number> {
  const st = await stateOf(box.id, folder);
  if (!st || !st.full_at || now - Date.parse(st.full_at) < GONE_EVERY_MS) return 0;
  const lock = await c.getMailboxLock(path, { readOnly: true });
  try {
    const mb = c.mailbox as unknown as { uidValidity?: bigint | number } | false;
    if (!mb || String(mb.uidValidity ?? 0) !== st.uidvalidity) return 0;   // the folder changed: the next syncFolder re-copies it
    // the same window the list shows (STORE_LIST_DAYS, owner 2026-10-14), so a mail archived in Gmail leaves the list too
    const since = sinceDate(now, STORE_LIST_DAYS);
    const present = ((await c.search({ since }, { uid: true })) || []) as number[];
    const r = await query(`UPDATE mail_store SET gone = true, updated_at = now()
                            WHERE box_id = $1 AND folder = $2 AND uidvalidity = $3 AND NOT gone AND NOT local AND sent_at >= $4 AND NOT (uid = ANY($5::bigint[]))`,
      [box.id, folder, st.uidvalidity, since, present]);
    await query(`UPDATE mail_sync SET full_at = $3, updated_at = now() WHERE box_id = $1 AND folder = $2`, [box.id, folder, new Date(now)]);
    return r.rowCount ?? 0;
  } finally { lock.release(); }
}

// The screen's read / unread / answered, written to Gmail.
async function applyActions(c: ImapFlow, box: SyncBox, paths: Record<StoreFolder, string | null>): Promise<number> {
  const todo = await query<{ id: string; folder: StoreFolder; uidvalidity: string; uid: string; action: string }>(
    `SELECT id::text AS id, folder, uidvalidity::text AS uidvalidity, uid::text AS uid, action FROM mail_actions
      WHERE box_id = $1 AND done_at IS NULL AND tries < 5 ORDER BY id LIMIT 50`, [box.id]);
  let done = 0;
  for (const folder of ['inbox', 'sent'] as StoreFolder[]) {
    const rows = todo.rows.filter(r => r.folder === folder);
    const path = paths[folder];
    if (!rows.length || !path) continue;
    const lock = await c.getMailboxLock(path);
    try {
      const uv = String((c.mailbox as unknown as { uidValidity?: bigint })?.uidValidity ?? '');
      for (const a of rows) {
        try {
          if (a.uidvalidity !== uv) throw new Error('the folder changed in Gmail');
          if (a.action === 'seen') await c.messageFlagsAdd(a.uid, ['\\Seen'], { uid: true });
          else if (a.action === 'unseen') await c.messageFlagsRemove(a.uid, ['\\Seen'], { uid: true });
          else await c.messageFlagsAdd(a.uid, ['\\Answered'], { uid: true });
          await query(`UPDATE mail_actions SET done_at = now(), tries = tries + 1 WHERE id = $1`, [a.id]);
          done++;
        } catch (e) {
          await query(`UPDATE mail_actions SET tries = tries + 1, error = $2, done_at = CASE WHEN tries >= 4 THEN now() ELSE NULL END WHERE id = $1`, [a.id, (e as Error).message.slice(0, 300)]);
        }
      }
    } finally { lock.release(); }
  }
  return done;
}

// The bodies of one folder, newest first, until the deadline; the rows in firstIds (the mails whose headers came in this
// run, at most FRESH_BODIES_MAX) come first and are never skipped by the deadline.
async function syncBodies(c: ImapFlow, box: SyncBox, folder: StoreFolder, path: string, firstIds: string[], deadline: number): Promise<number> {
  const first = firstIds.slice(-FRESH_BODIES_MAX);
  const todo = await query<{ id: string; folder: StoreFolder; uidvalidity: string; uid: string; body_tries: number }>(
    `SELECT id::text AS id, folder, uidvalidity::text AS uidvalidity, uid::text AS uid, body_tries FROM mail_store
      WHERE box_id = $1 AND folder = $2 AND body_state = 'none' AND NOT gone AND NOT local
      ORDER BY (id = ANY($3::bigint[])) DESC, sent_at DESC LIMIT ${BODIES_PER_RUN}`, [box.id, folder, first]);
  const mustDo = new Set(first);
  const rows = todo.rows;
  if (!rows.length) return 0;
  const over = (r: { id: string }) => Date.now() > deadline && !mustDo.has(r.id);
  if (rows.every(over)) return 0;
  let n = 0;
  const lock = await c.getMailboxLock(path, { readOnly: true });
  try {
    const uv = String((c.mailbox as unknown as { uidValidity?: bigint })?.uidValidity ?? '');
    const valid = rows.filter(r => r.uidvalidity === uv);
    // A copy from an older uidvalidity can never be fetched again (Gmail renumbered the folder; the same mail is copied
    // again under the new number): it is marked gone instead of waiting for ever (owner 2026-10-11 log: one mailbox kept
    // 5 bodies 'none' while every run reported bodies=0).
    const stale = rows.filter(r => r.uidvalidity !== uv).map(r => r.id);
    if (stale.length && uv) {
      await query(`UPDATE mail_store SET gone = true, updated_at = now() WHERE id = ANY($1::bigint[]) AND NOT local`, [stale]);
      console.log(`[mail-sync] box=${box.id} ${folder}: ${stale.length} old copies (uidvalidity changed) marked gone`);
    }
    // Ten mails per Gmail call (owner 2026-10-11, the first live run: one mail per call made a slow Gmail copy 4-13
    // bodies a run); a batch Gmail refuses falls back to one by one.
    for (let i = 0; i < valid.length; i += BODY_BATCH) {
      const chunk = valid.slice(i, i + BODY_BATCH).filter(r => !over(r));
      if (!chunk.length) { if (valid.slice(i).every(over)) break; continue; }
      await renewLease(box.id);   // a slow Gmail can take seconds per batch: the lease (75 s) must outlive the step
      let sources: Map<string, Buffer> | null = new Map();
      try {
        for await (const m of c.fetch(chunk.map(r => r.uid).join(','), { uid: true, source: { maxLength: VIEW_BYTES } } as never, { uid: true })) {
          const src = (m as unknown as { source?: Buffer }).source;
          if (src) sources.set(String(m.uid), src);
        }
      } catch (e) { sources = null; console.error(`[mail-sync] batch box=${box.id}: ${(e as Error).message.slice(0, 200)}`); }
      for (const r of chunk) {
        try {
          let source = sources ? sources.get(r.uid) : undefined;
          if (!source && !sources) {
            const one = await c.fetchOne(r.uid, { source: { maxLength: VIEW_BYTES } } as never, { uid: true }) as unknown as { source?: Buffer } | false;
            source = one && one.source ? one.source : undefined;
          }
          if (!source) { await query(`UPDATE mail_store SET gone = true, updated_at = now() WHERE id = $1`, [r.id]); continue; }
          const cut = source.length >= VIEW_BYTES;
          let p = await simpleParser(source);
          if (cut && !p.html && !p.text) {
            const whole = await c.fetchOne(r.uid, { source: true }, { uid: true }) as unknown as { source?: Buffer } | false;
            if (whole && whole.source) p = await simpleParser(whole.source);
          }
          const b = bodyFromParsed(p as never);
          await query(
            `UPDATE mail_store SET body_state = 'done', body_text = $2, body_html = NULLIF($3, ''), attachments = $4::jsonb, cut = $5,
                    has_attach = has_attach OR EXISTS (SELECT 1 FROM jsonb_array_elements($4::jsonb) a WHERE NOT (a->>'inline')::boolean),
                    reply_to = CASE WHEN reply_to = '' THEN $6 ELSE reply_to END, updated_at = now()
              WHERE id = $1`,
            [r.id, b.text, b.html, JSON.stringify(b.attachments), cut, addrText(p.replyTo).slice(0, 1000)]);
          n++;
          if (folder === 'inbox' && p.from?.value?.[0]?.address) {
            const auth = gmailAuthPassed((p.headerLines || []).find(h => h.key === 'authentication-results')?.line.replace(/^authentication-results:\s*/i, '') ?? null);
            try { await autoVerifySenders(box.panelId, [{ email: p.from.value[0].address.toLowerCase(), authPass: auth, subject: p.subject || '', text: b.text }]); }
            catch (e) { console.error('[mail-sync] auto-verify:', (e as Error).message); }
          }
        } catch (e) {
          const tries = r.body_tries + 1;
          await query(`UPDATE mail_store SET body_tries = $2, body_state = CASE WHEN $2 >= ${BODY_MAX_TRIES} THEN 'failed' ELSE body_state END, updated_at = now() WHERE id = $1`, [r.id, tries]);
          console.error(`[mail-sync] body box=${box.id} uid=${r.uid}: ${(e as Error).message.slice(0, 200)}`);
        }
      }
    }
  } finally { lock.release(); }
  return n;
}

// One mailbox, one run. Only the process holding its lease works on it.
export async function syncMailbox(box: SyncBox, now = Date.now()): Promise<SyncResult> {
  const res: SyncResult = { box: box.id, fresh: 0, flags: 0, gone: 0, bodies: 0, actions: 0 };
  try {
    if (!(await takeLease(box.id))) return { ...res, skipped: 'another process' };
  } catch (e) { return { ...res, skipped: 'lease', error: (e as Error).message }; }
  installExitHook();
  const t0 = Date.now();
  let connected = 0;
  try {
    await withPooledImap(box, 'sync', async (c) => {
      // The budget runs from here: the sign-in (up to 13 s on this server) is not the bodies' time.
      connected = Date.now();
      const deadline = connected + SYNC_BUDGET_MS;
      const sentState = await stateOf(box.id, 'sent');
      const sent = sentState?.path || await sentPath(c);
      const paths: Record<StoreFolder, string | null> = { inbox: 'INBOX', sent };
      // 1. the screen's flags
      res.actions = await applyActions(c, box, paths);
      // 2. INBOX headers + flags, 3. the bodies: just-arrived first (never skipped), then the backlog with its own slice
      await renewLease(box.id);
      const inbox = await syncFolder(c, box, 'inbox', 'INBOX', now);
      res.fresh += inbox.fresh; res.flags += inbox.flags;
      await renewLease(box.id);
      res.bodies += await syncBodies(c, box, 'inbox', 'INBOX', inbox.freshIds, Math.max(deadline, Date.now() + INBOX_BODIES_MIN_MS));
      // 4. Sent, with what is left (its headers always: a reply we sent must show in the conversation)
      if (sent) {
        await renewLease(box.id);
        const r = await syncFolder(c, box, 'sent', sent, now);
        res.fresh += r.fresh; res.flags += r.flags;
        res.bodies += await syncBodies(c, box, 'sent', sent, r.freshIds.slice(-5), deadline);
      }
      // 5. gone mails, only with time left
      for (const folder of ['inbox', 'sent'] as StoreFolder[]) {
        const path = paths[folder];
        if (!path || Date.now() > deadline - GONE_NEEDS_MS) continue;
        await renewLease(box.id);
        res.gone += await syncGone(c, box, folder, path, now);
      }
    }, SYNC_BUDGET_MS + INBOX_BODIES_MIN_MS + 40_000);
    await query(`UPDATE mail_store SET body_text = NULL, body_html = NULL, body_state = 'pruned', updated_at = now()
                  WHERE box_id = $1 AND body_state = 'done' AND sent_at < now() - interval '${PRUNE_DAYS} days'`, [box.id]).catch(() => {});
    const ms = Date.now() - t0;
    if (ms > 5000 || res.fresh || res.bodies) console.log(`[mail-sync] box=${box.id} new=${res.fresh} flags=${res.flags} gone=${res.gone} bodies=${res.bodies} actions=${res.actions} ${ms}ms (sign-in ${connected ? connected - t0 : '-'}ms)`);
  } catch (e) {
    res.error = mailErrorText(e).slice(0, 300);
    console.error(`[mail-sync] box=${box.id} ${box.email} after ${Date.now() - t0}ms: ${res.error}`);
    await query(`UPDATE mail_sync SET error = $2, error_at = now() WHERE box_id = $1`, [box.id, res.error]).catch(() => {});
  } finally {
    await releaseLease(box.id);
  }
  return res;
}

// Every support Gmail (site_emails), read again on every tick so a new or reconnected mailbox joins by itself.
export async function loadSyncBoxes(): Promise<SyncBox[]> {
  const r = await query<{ id: string; email: string; app_password: string; panel_id: string | null }>(
    `SELECT se.id::text AS id, se.email, se.app_password, s.tracker_business_id::text AS panel_id
       FROM site_emails se JOIN sites s ON s.id = se.site_id ORDER BY se.created_at ASC`);
  // The chargeback Gmails too (owner 2026-10-13, mail-cb-box.ts): one copy per panel's box.
  const cb = (await cbBoxRows()).map(x => ({ id: x.id, email: x.email, appPassword: x.app_password, panelId: x.panel_id }));
  return [...r.rows.map(x => ({ id: x.id, email: x.email, appPassword: x.app_password, panelId: x.panel_id })), ...cb];
}

// The loop: every 30 seconds in each server process (started by the minute cron, email.ts); the lease decides which
// process works on a mailbox, and it keeps it while it runs, so its Gmail connection stays warm. Mailboxes side by side.
// afterTick (owner 2026-10-11): the outbox worker (mail-outbox.ts runOutbox, handed in by email.ts so this file imports
// nothing that imports it back), so a reply that failed is tried again every 30 s.
const LOOP_MS = 30_000;
const G = globalThis as unknown as { __mailSyncLoop?: { boxes: () => Promise<SyncBox[]>; timer: ReturnType<typeof setInterval>; busy: boolean; after?: () => Promise<unknown> } };
export async function runMailSyncOnce(boxes: SyncBox[]): Promise<SyncResult[]> {
  return Promise.all(boxes.map(b => syncMailbox(b)));
}
export async function startMailSync(boxes: () => Promise<SyncBox[]>, afterTick?: () => Promise<unknown>): Promise<boolean> {
  if (!(await storeInstalled())) return false;
  if (G.__mailSyncLoop) { G.__mailSyncLoop.boxes = boxes; G.__mailSyncLoop.after = afterTick; return true; }
  const tick = async () => {
    const loop = G.__mailSyncLoop!;
    if (loop.busy) return;
    loop.busy = true;
    try { await runMailSyncOnce(await loop.boxes()); }
    catch (e) { console.error('[mail-sync] loop:', (e as Error).message); }
    finally { loop.busy = false; }
    if (loop.after) await loop.after().catch((e) => console.error('[mail-sync] after tick:', (e as Error).message));
  };
  const timer = setInterval(() => { void tick(); }, LOOP_MS);
  (timer as { unref?: () => void }).unref?.();
  G.__mailSyncLoop = { boxes, timer, busy: false, after: afterTick };
  void tick();
  return true;
}
// For the tests.
export function stopMailSync(): void { if (G.__mailSyncLoop) clearInterval(G.__mailSyncLoop.timer); delete G.__mailSyncLoop; installed = null; }
