import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { sendMailReply, type ReplyFile } from '@/lib/chat/mail-inbox';
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
export async function POST(request: NextRequest) {
  const ct = request.headers.get('content-type') || '';
  let box: string | null = null, uidRaw: unknown, textRaw: unknown, includeQuote = true;
  const files: File[] = [];
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
    const sent = await sendMailReply(a.box, uid, stripLinkJunk(clean.text).text, { includeQuote, files: replyFiles });
    noteAnswered(a.box.id, uid);
    return NextResponse.json({ ok: true, to: sent.to, files: replyFiles.length });
  } catch (e) { return mailFail(e); }
}
