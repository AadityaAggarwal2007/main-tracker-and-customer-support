import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { buildReply, sendBuiltReply, sendMailReply, type ReplyFile } from '@/lib/chat/mail-inbox';
import { storeFlag, storeLocalSent, storeOriginal, storeReady } from '@/lib/chat/mail-store';
import { enqueueReply, outboxInstalled, retryOutbox, runOutbox } from '@/lib/chat/mail-outbox';
import { actorKey } from '@/lib/chat/mail-verify';
import { noteAnswered } from '@/lib/chat/mail-cache';
import { cleanReply, parseUid, MAIL_MAX_FILES, MAIL_MAX_TOTAL_BYTES } from '@/lib/chat/mail-view';
import { hasFormLink } from '@/lib/refund/link-mask';
import { stripLinkJunk } from '@/lib/chat/reply-guards';
import {
  MAX_ATTACHMENT_BYTES, TOO_LARGE_MESSAGE, TOO_MANY_MESSAGE, TOTAL_TOO_LARGE_MESSAGE, UNSUPPORTED_TYPE_MESSAGE, EMPTY_FILE_MESSAGE,
  cleanFileName, sniffAttachmentType,
} from '@/lib/chat/attachment-rules';

// POST /api/mail/send: a reply to one mail, from that Gmail address, like a normal Gmail reply: the typed text, the
// original quoted after it (includeQuote, on by default) and up to 5 files. JSON { box, uid, text, includeQuote? } or
// multipart (box, uid, text, includeQuote, files). Same rules as a chat reply by the team: no Google Form / refund-form
// link (the refund form is the Super Admin's own button in Chat Support), copy-paste junk (utm_*, fbclid ...) cut from
// links. Files: JPG / PNG / WEBP / GIF / PDF only, judged by their bytes, at most 5 and 10 MB in all.
// With the mail store + outbox (owner 2026-10-11, "Send and open next" sat spinning): the reply is QUEUED (mail_outbox)
// and the answer comes at once ({ queued: true }); the worker sends it in the background and the conversation shows
// Sending… / Sent / Not sent. JSON { action: 'retry', box, id } puts a failed reply back in the queue.
export async function POST(request: NextRequest) {
  const ct = request.headers.get('content-type') || '';
  let box: string | null = null, uidRaw: unknown, textRaw: unknown, includeQuote = true;
  const files: File[] = [];
  if (!ct.includes('multipart/form-data')) {
    const peek = await request.clone().json().catch(() => null) as { action?: unknown; box?: string; id?: unknown } | null;
    if (peek && peek.action === 'retry') {
      const id = String(peek.id ?? '').trim();
      if (!/^\d{1,18}$/.test(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });
      const a = await mailAccess(request, peek.box ?? null, 'reply');
      if ('error' in a) return a.error;
      try {
        if (!(await retryOutbox(id, a.box.id))) return NextResponse.json({ error: 'That reply is not waiting to be sent again.' }, { status: 404 });
        void runOutbox();
        return NextResponse.json({ ok: true, queued: true });
      } catch (e) { return mailFail(e); }
    }
  }
  if (ct.includes('multipart/form-data')) {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAIL_MAX_TOTAL_BYTES + 256 * 1024) return NextResponse.json({ error: TOTAL_TOO_LARGE_MESSAGE.replace(/\d+ MB/, '10 MB') }, { status: 413 });
    let form: FormData;
    try { form = await request.formData(); } catch { return NextResponse.json({ error: 'Could not read that upload' }, { status: 400 }); }
    box = String(form.get('box') || ''); uidRaw = form.get('uid'); textRaw = form.get('text'); includeQuote = form.get('includeQuote') !== '0';
    for (const f of form.getAll('files')) if (typeof f !== 'string') files.push(f);
  } else {
    let body: { box?: string; uid?: unknown; text?: unknown; includeQuote?: unknown } = {};
    try { body = await request.json(); } catch { /* handled below */ }
    box = body.box ?? null; uidRaw = body.uid; textRaw = body.text; includeQuote = body.includeQuote !== false;
  }
  const uid = parseUid(uidRaw);
  if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 });
  const clean = cleanReply(textRaw);
  if ('error' in clean) return NextResponse.json({ error: clean.error }, { status: 400 });
  const a = await mailAccess(request, box, 'reply');
  if ('error' in a) return a.error;
  if (hasFormLink(clean.text)) {
    return NextResponse.json({ error: "Refund forms go only through 'Send refund form' (Super Admin, Refund section). Remove the form link." }, { status: 403 });
  }

  // Every file is judged by its own bytes (the name and the reported type are only hints), before anything is sent.
  if (files.length > MAIL_MAX_FILES) return NextResponse.json({ error: TOO_MANY_MESSAGE }, { status: 400 });
  const replyFiles: ReplyFile[] = [];
  let total = 0;
  for (const f of files) {
    if (f.size === 0) return NextResponse.json({ error: EMPTY_FILE_MESSAGE }, { status: 400 });
    if (f.size > MAX_ATTACHMENT_BYTES) return NextResponse.json({ error: TOO_LARGE_MESSAGE }, { status: 413 });
    const bytes = new Uint8Array(await f.arrayBuffer());
    const type = sniffAttachmentType(bytes);
    if (!type) return NextResponse.json({ error: UNSUPPORTED_TYPE_MESSAGE }, { status: 415 });
    total += bytes.length;
    if (total > MAIL_MAX_TOTAL_BYTES) return NextResponse.json({ error: 'Files on one reply can add up to 10 MB.' }, { status: 413 });
    replyFiles.push({ filename: cleanFileName(f.name || '', type), content: Buffer.from(bytes), contentType: type.mime });
  }

  try {
    // The mail store (owner 2026-10-11): the original comes from the database (no Gmail read before sending), the reply
    // shows in the conversation at once, and the Answered flag reaches Gmail through the sync.
    if ((await storeReady(a.box.id)).ok) {
      const orig = await storeOriginal(a.box.id, uid);
      if (orig) {
        const text = stripLinkJunk(clean.text).text;
        const built = buildReply(a.box, orig, text, { includeQuote: includeQuote && orig.hasBody });
        // The outbox: the row first (so nothing is lost if the process dies), then the answer; the worker sends.
        const queued = await outboxInstalled();
        if (queued) {
          await enqueueReply({
            boxId: a.box.id, replyUid: uid, uidvalidity: orig.row.uidvalidity, to: built.to, subject: built.subject, textBody: built.textBody, htmlBody: built.htmlBody,
            messageId: built.messageId, inReplyTo: built.inReplyTo, references: built.references, createdBy: actorKey(a.user),
            files: replyFiles.map(f => ({ filename: f.filename, contentType: f.contentType, content: f.content.toString('base64') })),
          });
        } else {
          await sendBuiltReply(a.box, built, replyFiles);
        }
        await storeFlag(orig.row, 'answered').catch((e) => console.error('[mail] answered flag:', (e as Error).message));
        await storeLocalSent(a.box.id, { messageId: built.messageId, threadId: orig.row.thread_id, fromName: built.fromName, fromAddr: a.box.email, to: built.to, subject: built.subject, text });
        if (queued) void runOutbox();
        return NextResponse.json({ ok: true, to: built.to, files: replyFiles.length, queued });
      }
      console.warn(`[mail-send] box=${a.box.id} uid=${uid}: not in the mail store, sending the old way (reads Gmail first)`);
    }
    const sent = await sendMailReply(a.box, uid, stripLinkJunk(clean.text).text, { includeQuote, files: replyFiles });
    noteAnswered(a.box.id, uid);
    return NextResponse.json({ ok: true, to: sent.to, files: replyFiles.length });
  } catch (e) { return mailFail(e); }
}
