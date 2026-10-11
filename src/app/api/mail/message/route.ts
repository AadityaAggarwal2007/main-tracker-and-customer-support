import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { readMail, setSeen } from '@/lib/chat/mail-inbox';
import { noteSeen, readMailCached } from '@/lib/chat/mail-cache';
import { parseUid } from '@/lib/chat/mail-view';
import { autoVerifySenders } from '@/lib/chat/mail-auto-verify';
import { verifiedSenders } from '@/lib/chat/mail-verify';
import { can } from '@/lib/permissions';
import { storeBody, storeFlag, storeMail, storeReady, storeRow, storeSeenThread } from '@/lib/chat/mail-store';
import { MailError } from '@/lib/chat/mail-inbox';

// GET /api/mail/message?box=&uid=[&images=1][&peek=1]: opens one mail. It is marked read in Gmail, like opening
// it in Gmail, unless peek=1. The HTML comes back already wrapped for a sandboxed frame (mail-view.ts).
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const uid = parseUid(sp.get('uid'));
  if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 });
  const a = await mailAccess(request, sp.get('box'), 'view');
  if ('error' in a) return a.error;
  try {
    const folder = sp.get('folder') === 'sent' ? 'sent' as const : 'inbox' as const;
    // peek=1 is the read-ahead and the conversation: they use their own connection, so a slow background mail can never hold
    // up the one the person clicked (imap-pool.ts).
    const peek = sp.get('peek') === '1';
    // via=thread: an older message opened inside the conversation (its own connection, owner 2026-10-10).
    // via=read (owner 2026-10-11): an earlier mail of THEIRS opened inside the conversation: the click's own connection,
    // never the read-ahead's ('bg'); it is usually in the server's copy anyway.
    const via = sp.get('via');
    const slot = via === 'thread' ? 'thread' as const : via === 'read' ? 'read' as const : peek ? 'bg' as const : 'read' as const;
    const images = sp.get('images') === '1';
    // The mail store (owner 2026-10-11): the copy answers at once; a mail whose body the sync has not copied yet is read
    // from Gmail this once (without marking it: the copy and the sync do that).
    if ((await storeReady(a.box.id)).ok) {
      const { row, mail: kept } = await storeMail(a.box.id, folder, uid, images);
      if (row) {
        let mail: (NonNullable<typeof kept> | Omit<NonNullable<Awaited<ReturnType<typeof readMail>>>, 'raw'>) | null = kept;
        if (!mail) {
          // Not copied yet (it just arrived, or the sync is behind): read from Gmail once on the click's own connection,
          // 30 s at most, and KEEP it (owner 2026-10-11: before, every click on such a mail waited on a cold Gmail again).
          let got: Awaited<ReturnType<typeof readMail>>;
          try { got = await readMail(a.box, uid, { markRead: false, images, folder, slot: 'read', withRaw: true, timeoutMs: 30_000 }); }
          catch (e) {
            if (e instanceof MailError && e.status === 504) throw new MailError('This mail\'s text is not copied into ShipTrack yet and Gmail did not answer in 30 s. Click it again in a moment; the copy runs in the background.', 504);
            throw e;
          }
          if (got?.raw) { await storeBody(row, got.raw); }
          if (got) { const { raw: _raw, ...rest } = got; mail = rest; }
        }
        if (!mail) return NextResponse.json({ error: 'That mail is no longer in the inbox.' }, { status: 404 });
        if (folder === 'sent') return NextResponse.json({ mail, verified: [] }, { headers: { 'Cache-Control': 'no-store' } });
        if (!peek) { if (!row.seen) await storeFlag(row, 'seen'); await storeSeenThread(row); }
        const shown = { ...mail, unread: peek ? !row.seen : false };
        await autoVerifySenders(a.box.panelId, [{ email: shown.fromAddress, authPass: shown.authPass, subject: shown.subject, text: shown.text }]);
        const verified = await verifiedSenders(a.box.panelId, [shown.fromAddress]);
        if (!can(a.user, 'chat.view')) for (const list of Object.values(verified)) for (const v of list) v.chatId = null;
        return NextResponse.json({ mail: shown, verified: verified[shown.fromAddress] || [], store: true }, { headers: { 'Cache-Control': 'no-store' } });
      }
    }
    // An INBOX mail comes from the server's copy when it was opened or read ahead before (mail-cache.ts); a sent one is
    // read live (the conversation view only).
    const mail = folder === 'sent'
      ? await readMail(a.box, uid, { markRead: false, images: sp.get('images') === '1', folder, slot })
      : await readMailCached(a.box, uid, { markRead: !peek, images: sp.get('images') === '1', slot });
    // A mail we SENT (the conversation view) is only shown: nothing to verify and nobody to mark read.
    if (mail && folder === 'sent') return NextResponse.json({ mail, verified: [] }, { headers: { 'Cache-Control': 'no-store' } });
    if (!mail) return NextResponse.json({ error: 'That mail is no longer in the inbox.' }, { status: 404 });
    // Step 2: the opened mail has its text, so an order number in it can verify that order (mail-auto-verify.ts).
    await autoVerifySenders(a.box.panelId, [{ email: mail.fromAddress, authPass: mail.authPass, subject: mail.subject, text: mail.text }]);
    const verified = await verifiedSenders(a.box.panelId, [mail.fromAddress]);
    if (!can(a.user, 'chat.view')) for (const list of Object.values(verified)) for (const v of list) v.chatId = null;
    return NextResponse.json({ mail, verified: verified[mail.fromAddress] || [] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return mailFail(e); }
}

// PATCH /api/mail/message { box, uid, seen: boolean }: "Mark unread" / "Mark read" in Gmail.
export async function PATCH(request: NextRequest) {
  let body: { box?: string; uid?: unknown; seen?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const uid = parseUid(body.uid);
  if (!uid || typeof body.seen !== 'boolean') return NextResponse.json({ error: 'uid and seen (true or false) are required' }, { status: 400 });
  const a = await mailAccess(request, body.box ?? null, 'view');
  if ('error' in a) return a.error;
  try {
    if ((await storeReady(a.box.id)).ok) {
      const row = await storeRow(a.box.id, 'inbox', uid);
      if (row) { await storeFlag(row, body.seen ? 'seen' : 'unseen'); return NextResponse.json({ ok: true, seen: body.seen }); }
    }
    await setSeen(a.box, uid, body.seen);
    noteSeen(a.box.id, uid, body.seen);
    return NextResponse.json({ ok: true, seen: body.seen });
  } catch (e) { return mailFail(e); }
}
