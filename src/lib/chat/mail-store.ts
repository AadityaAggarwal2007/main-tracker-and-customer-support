// ── Mail store: what the screen reads (owner 2026-10-11, "history ko load karke rakh, baar baar read karega toh kaise
// baat banegi") ──
// The Mail tab's routes read the mailbox from the database (mail-store.sql), which mail-sync.ts fills from Gmail in the
// background, so the list, an opened mail and its conversation answer at once. What the screen changes (read / unread,
// answered) is written here at once and queued in mail_actions for the sync to write to Gmail. Until mail-store.sql
// is run, or before a mailbox's first copy is done, storeReady() is false and the routes keep the old live path.
import { query, queryOne } from '@/lib/db';
import { STORE_LIST_DAYS, STORE_MAX_CONVS, sinceDate, sortMails, type MailListItem } from './mail-view';
import { STORE_HTML_MAX, applyBounces, rowToListItem, rowToMailFull, threadFromRows, type StoreFolder, type StoreRow, type StoreThreadItem } from './mail-store-rules';
import { outboxStates } from './mail-outbox';

interface ErrCode { code?: string }
const missing = (e: unknown) => ['42P01', '42703'].includes((e as ErrCode)?.code || '');

const COLS = `id::text AS id, box_id, folder, uidvalidity::text AS uidvalidity, uid::text AS uid, thread_id, message_id, in_reply_to, refs,
  from_name, from_addr, to_list, to_addrs, cc_list, reply_to, subject, sent_at, seen, answered, has_attach, auth_pass,
  body_state, body_text, body_html, attachments, cut, local`;
const LIST_COLS = `id::text AS id, box_id, folder, uidvalidity::text AS uidvalidity, uid::text AS uid, from_name, from_addr, subject, sent_at, seen, answered, has_attach, auth_pass`;

// Is this mailbox's copy usable? Its INBOX was copied at least once (mail_sync.full_at). Cached 20 s per process.
const ready = new Map<string, { at: number; ok: boolean; syncedAt: string | null }>();
export async function storeReady(boxId: string, now = Date.now()): Promise<{ ok: boolean; syncedAt: string | null }> {
  const have = ready.get(boxId);
  if (have && now - have.at < 20_000) return have;
  let out = { ok: false, syncedAt: null as string | null };
  try {
    const r = await queryOne<{ full_at: string | null; ok_at: string | null }>(
      `SELECT full_at, ok_at FROM mail_sync WHERE box_id = $1 AND folder = 'inbox'`, [boxId]);
    if (r?.full_at) out = { ok: true, syncedAt: r.ok_at ? new Date(r.ok_at).toISOString() : null };
  } catch (e) { if (!missing(e)) console.error('[mail-store] ready:', (e as Error).message); }
  ready.set(boxId, { at: now, ...out });
  return out;
}
export function forgetStoreReady(): void { ready.clear(); }

// The list: the last 30 days of INBOX, ONE row per Gmail conversation (its newest mail; bold while any mail of it is
// unread), with the first words, whether we wrote to that customer after it (Sent, or a reply from here), and how
// many mails the conversation holds (owner 2026-10-11: "Gmail jaisa UI"). Unread first, as before.
// replied_at (owner 2026-10-11 12:45, the cases close by themselves): WHEN we last wrote to this CUSTOMER after this
// mail, NULL when never; the Cases rule in mail-filters.ts compares it with the mail's own time and a close / reopen by
// hand. Per customer, not per thread (owner 2026-10-11 13:02, kurtiya: Bhanu sent two mails 3 minutes apart in two Gmail
// threads, the team answered inside the first, the second stayed "To reply" and he stayed in Active cases: "inka reply
// hamne kar rakha hai to fir active mein kyon"): the newest non-gone Sent row after the mail that is in the same thread
// OR addressed to the mail's sender (to_addrs, lower-case: the sync fills it from Gmail, a reply from here as ARRAY[to],
// so it counts at once; a mail with no thread id still matches by the address).
// Gmail's own "could not deliver" reports (mail-filters.ts isBounce, the address part): never a conversation's row.
const BOUNCE_FROM_SQL = '^(mailer-daemon|postmaster)@';
// A bounce's words: its text part, else its HTML without tags (14 Oct: the live count of "suspicious" bounces by body_text
// came back 0; a report with its words only in HTML must still give its reason), else the subject.
const bounceTextSql = (a: string) => `left(btrim(regexp_replace(COALESCE(NULLIF(btrim(${a}.body_text), ''),
  regexp_replace(regexp_replace(regexp_replace(COALESCE(${a}.body_html, ''), '<(style|head|script)[^>]*?>.*?</(style|head|script)>', ' ', 'gi'), '<[^>]+>', ' ', 'g'), '&[a-z#0-9]+;', ' ', 'gi'),
  ${a}.subject), '\\s+', ' ', 'g')), 1200)`;
const REPLY_AFTER = `s.box_id = $1 AND s.folder = 'sent' AND NOT s.gone AND s.sent_at > i.sent_at
                     AND (s.thread_id = i.thread_id OR lower(i.from_addr) = ANY(s.to_addrs))`;
export async function storeList(boxId: string, now = Date.now()): Promise<{ mails: MailListItem[]; unread: number; truncated: boolean; days: number }> {
  // Up to STORE_MAX_CONVS conversations of STORE_LIST_DAYS (owner 2026-10-14: the old 200 / 30 days left waiting customers
  // off a busy Gmail's list); the unanswered ones first, so the cut, if any, only ever drops answered mail. replied_at is
  // read once per row (LATERAL) instead of twice.
  const r = await query<StoreRow & { snippet: string | null; replied: boolean; replied_at: string | Date | null; thread_count: number; any_unread: boolean; contact: boolean; bounce_at: string | Date | null; bounce_text: string | null }>(
    `WITH inbox AS (
       SELECT ${LIST_COLS}, thread_id, body_text, (from_addr ~* '${BOUNCE_FROM_SQL}') AS is_bounce,
              CASE WHEN from_addr ~* '${BOUNCE_FROM_SQL}' THEN ${bounceTextSql('mail_store')} END AS self_bounce_text,
              row_number() OVER (PARTITION BY COALESCE(thread_id, 'u' || id) ORDER BY (from_addr ~* '${BOUNCE_FROM_SQL}') ASC, sent_at DESC) AS rn,
              bool_or(NOT seen) OVER (PARTITION BY COALESCE(thread_id, 'u' || id)) AS any_unread
         FROM mail_store
        WHERE box_id = $1 AND folder = 'inbox' AND NOT gone AND NOT local AND sent_at >= $2),
     sent_to AS (
       SELECT DISTINCT unnest(to_addrs) AS addr FROM mail_store WHERE box_id = $1 AND folder = 'sent' AND NOT gone)
     SELECT i.id, i.box_id, i.folder, i.uidvalidity, i.uid, i.from_name, i.from_addr, i.subject, i.sent_at, i.seen, i.answered, i.has_attach, i.auth_pass,
            i.any_unread,
            btrim(left(regexp_replace(COALESCE(i.body_text, ''), '\\s+', ' ', 'g'), 180)) AS snippet,
            (i.answered OR ra.replied_at IS NOT NULL) AS replied,
            ra.replied_at,
            bo.bounce_at, CASE WHEN i.is_bounce THEN i.self_bounce_text ELSE bo.bounce_text END AS bounce_text,
            EXISTS (SELECT 1 FROM sent_to st WHERE st.addr = lower(i.from_addr)) AS contact,
            CASE WHEN i.thread_id IS NULL THEN 1
                 ELSE (SELECT count(*)::int FROM mail_store t WHERE t.box_id = $1 AND t.thread_id = i.thread_id AND NOT t.gone AND NOT t.local) END AS thread_count
       FROM inbox i
       LEFT JOIN LATERAL (SELECT max(s.sent_at) AS replied_at FROM mail_store s WHERE ${REPLY_AFTER}) ra ON true
       LEFT JOIN LATERAL (SELECT b.sent_at AS bounce_at, ${bounceTextSql('b')} AS bounce_text
                            FROM mail_store b
                           WHERE i.thread_id IS NOT NULL AND NOT i.is_bounce AND b.box_id = $1 AND b.folder = 'inbox' AND NOT b.gone
                             AND b.thread_id = i.thread_id AND b.from_addr ~* '${BOUNCE_FROM_SQL}' AND b.sent_at > i.sent_at
                           ORDER BY b.sent_at DESC LIMIT 1) bo ON true
      WHERE i.rn = 1
      ORDER BY (i.answered OR ra.replied_at IS NOT NULL) ASC, i.sent_at DESC LIMIT ${STORE_MAX_CONVS + 1}`, [boxId, sinceDate(now, STORE_LIST_DAYS)]);
  const truncated = r.rows.length > STORE_MAX_CONVS;
  // a bounce of our reply puts the customer back to To reply (applyBounces, owner 2026-10-14)
  const mails = sortMails(applyBounces(r.rows.slice(0, STORE_MAX_CONVS).map(x => ({ item: rowToListItem(x), bounceAt: x.bounce_at, bounceText: x.bounce_text }))));
  return { mails, unread: mails.filter(m => m.unread).length, truncated, days: STORE_LIST_DAYS };
}

// Opening a conversation reads all of it: every unread INBOX mail of the same Gmail thread is marked read too.
export async function storeSeenThread(row: StoreRow): Promise<void> {
  if (!row.thread_id) return;
  const r = await query<StoreRow>(
    `SELECT ${COLS} FROM mail_store WHERE box_id = $1 AND folder = 'inbox' AND thread_id = $2 AND NOT seen AND NOT gone AND NOT local AND id <> $3`,
    [row.box_id, row.thread_id, row.id]);
  for (const x of r.rows) await storeFlag(x, 'seen');
}

// The row of a UID in a folder: the copy still in the folder first (owner 2026-10-11, live: Gmail renumbered one
// mailbox's folder and the old, empty copy of a UID was picked, so the mail and the reply went to Gmail live and timed
// out), then one whose body is copied, then the newest uidvalidity.
export async function storeRow(boxId: string, folder: StoreFolder, uid: number): Promise<StoreRow | null> {
  return queryOne<StoreRow>(
    `SELECT ${COLS} FROM mail_store WHERE box_id = $1 AND folder = $2 AND uid = $3 AND NOT local
      ORDER BY gone ASC, (body_state = 'done') DESC, uidvalidity DESC LIMIT 1`, [boxId, folder, uid]);
}

// One mail for the screen: from the copy when its body is in; null = not copied yet (the route reads Gmail then).
export async function storeMail(boxId: string, folder: StoreFolder, uid: number, images: boolean) {
  const row = await storeRow(boxId, folder, uid);
  if (!row) return { row: null, mail: null };
  return { row, mail: rowToMailFull(row, images) };
}

// A body read live (the click came before the sync got to it) is kept, so the next open is instant (owner 2026-10-11:
// a mail that arrived at 9:19 was still read from a cold Gmail on every click at 9:24). Same limits as the sync's copy.
export async function storeBody(row: StoreRow, body: { text: string; html: string; attachments: unknown[]; cut?: boolean }): Promise<void> {
  try {
    const html = body.html.length > STORE_HTML_MAX ? '' : body.html;
    await query(
      `UPDATE mail_store SET body_state = 'done', body_text = $2, body_html = NULLIF($3, ''), attachments = $4::jsonb, cut = $5,
              has_attach = has_attach OR EXISTS (SELECT 1 FROM jsonb_array_elements($4::jsonb) a WHERE NOT COALESCE((a->>'inline')::boolean, false)), updated_at = now()
        WHERE id = $1 AND body_state <> 'done'`,
      [row.id, body.text.slice(0, 40_000), html, JSON.stringify(body.attachments), !!body.cut]);
  } catch (e) { console.error('[mail-store] keep body:', (e as Error).message); }
}

// Read / unread / answered from the screen: the copy changes now, Gmail within a minute (mail-sync.ts applyActions).
export async function storeFlag(row: StoreRow, action: 'seen' | 'unseen' | 'answered'): Promise<void> {
  const set = action === 'answered' ? 'answered = true' : `seen = ${action === 'seen'}`;
  await query(`UPDATE mail_store SET ${set}, updated_at = now() WHERE id = $1`, [row.id]);
  await query(
    `INSERT INTO mail_actions (box_id, folder, uidvalidity, uid, action) VALUES ($1, $2, $3, $4, $5)`,
    [row.box_id, row.folder, row.uidvalidity, row.uid, action]);
}

// The conversation of one mail: its Gmail thread (X-GM-THRID: their mails AND our replies, in INBOX and Sent), plus
// what that address sent us / we sent it when Gmail gave no thread id. Last 30 days, oldest first.
export async function storeThread(boxId: string, address: string, uid: number | null, now = Date.now()): Promise<StoreThreadItem[]> {
  const since = sinceDate(now, STORE_LIST_DAYS);
  let threadId: string | null = null;
  if (uid) {
    const t = await queryOne<{ thread_id: string | null }>(
      `SELECT thread_id FROM mail_store WHERE box_id = $1 AND folder = 'inbox' AND uid = $2 ORDER BY gone ASC, uidvalidity DESC LIMIT 1`, [boxId, uid]);
    threadId = t?.thread_id || null;
  }
  const r = await query<StoreRow>(
    `SELECT ${LIST_COLS}, thread_id, message_id, to_list, local, body_text
       FROM mail_store
      WHERE box_id = $1 AND NOT gone AND sent_at >= $2
        AND ( ($3::text IS NOT NULL AND thread_id = $3)
           OR (folder = 'inbox' AND from_addr = $4)
           OR (folder = 'sent' AND $4 = ANY(to_addrs)) )
      ORDER BY sent_at DESC LIMIT 80`, [boxId, since, threadId, address.toLowerCase()]);
  // The state of a reply sent from here (the outbox, owner 2026-10-11): Sending… / Sent / Not sent, by its Message-ID.
  const localIds = r.rows.filter(x => x.local && x.message_id).map(x => x.message_id as string);
  const sends = localIds.length ? await outboxStates(boxId, localIds) : undefined;
  return threadFromRows(r.rows.map(x => ({ ...x, body_text: x.body_text ? String(x.body_text).slice(0, 400) : null })), sends);
}

// What a reply needs from the mail it answers (no Gmail call when the body is copied).
// A mail whose body is not copied yet still has every header a reply needs (owner 2026-10-11: such a reply fell back to
// reading Gmail inside the request and never went); `hasBody` false = the reply goes without the quoted original.
export async function storeOriginal(boxId: string, uid: number) {
  const row = await storeRow(boxId, 'inbox', uid);
  if (!row) return null;
  const replyAddr = (row.reply_to.match(/<([^>]+)>/)?.[1] || (/@/.test(row.reply_to) ? row.reply_to.split(',')[0].trim() : '') || row.from_addr).toLowerCase();
  return {
    row,
    to: replyAddr, subject: row.subject, messageId: row.message_id || '', references: row.refs || '',
    date: new Date(row.sent_at).toISOString(),
    fromLabel: row.from_name && row.from_addr ? `${row.from_name} <${row.from_addr}>` : (row.from_addr || row.from_name),
    text: row.body_state === 'done' ? row.body_text || '' : '',
    hasBody: row.body_state === 'done',
  };
}

// A reply sent from ShipTrack shows in the conversation at once (local row, uid below zero), until the sync brings
// Gmail's own copy of it from Sent (same Message-ID) and the local one stops showing.
// `files` (owner 2026-10-14): the reply carried attachments, so the conversation shows the clip on it at once.
export async function storeLocalSent(boxId: string, x: { messageId: string; threadId: string | null; fromName: string; fromAddr: string; to: string; subject: string; text: string; files?: number }): Promise<void> {
  try {
    await query(
      `INSERT INTO mail_store (box_id, folder, uidvalidity, uid, thread_id, message_id, from_name, from_addr, to_list, to_addrs, subject, sent_at,
                               seen, body_state, body_text, local, has_attach)
       VALUES ($1, 'sent', 0, -(extract(epoch FROM clock_timestamp()) * 1000)::bigint, $2, $3, $4, $5, $6, ARRAY[$6]::text[], $7, now(), true, 'done', $8, true, $9)
       ON CONFLICT DO NOTHING`,
      [boxId, x.threadId, x.messageId, x.fromName, x.fromAddr.toLowerCase(), x.to.toLowerCase(), x.subject, x.text.slice(0, 40_000), (x.files || 0) > 0]);
  } catch (e) { console.error('[mail-store] local sent:', (e as Error).message); }
}

// The chat thread's "Emails" line: the mails of these addresses, newest first.
export async function storeFromAddresses(boxId: string, emails: string[], now = Date.now()): Promise<MailListItem[]> {
  if (!emails.length) return [];
  const r = await query<StoreRow>(
    `SELECT ${LIST_COLS} FROM mail_store
      WHERE box_id = $1 AND folder = 'inbox' AND NOT gone AND NOT local AND sent_at >= $2 AND from_addr = ANY($3)
      ORDER BY sent_at DESC LIMIT 15`, [boxId, sinceDate(now, STORE_LIST_DAYS), emails.map(e => e.toLowerCase())]);
  return r.rows.map(rowToListItem);
}

// For the screen's footer: how far the copy got.
export async function storeStatus(boxId: string): Promise<{ mails: number; bodies: number; syncedAt: string | null; error: string | null } | null> {
  try {
    const r = await queryOne<{ mails: number; bodies: number; ok_at: string | null; error: string | null }>(
      `SELECT (SELECT count(*)::int FROM mail_store WHERE box_id = $1 AND NOT gone AND NOT local) AS mails,
              (SELECT count(*)::int FROM mail_store WHERE box_id = $1 AND NOT gone AND NOT local AND body_state = 'done') AS bodies,
              (SELECT max(ok_at) FROM mail_sync WHERE box_id = $1) AS ok_at,
              (SELECT error FROM mail_sync WHERE box_id = $1 AND error IS NOT NULL AND (ok_at IS NULL OR error_at > ok_at) LIMIT 1) AS error`, [boxId]);
    return r ? { mails: r.mails, bodies: r.bodies, syncedAt: r.ok_at ? new Date(r.ok_at).toISOString() : null, error: r.error } : null;
  } catch (e) { if (!missing(e)) console.error('[mail-store] status:', (e as Error).message); return null; }
}
