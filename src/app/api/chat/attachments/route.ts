import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { can } from '@/lib/permissions';
import {
  MAX_ATTACHMENT_BYTES, TOO_LARGE_MESSAGE, UNSUPPORTED_TYPE_MESSAGE, EMPTY_FILE_MESSAGE,
  cleanFileName, sniffAttachmentType,
} from '@/lib/chat/attachment-rules';

export const dynamic = 'force-dynamic';

// ── POST /api/chat/attachments ─────────────────────────────────
// An agent attaches a file to the reply they are writing. The file is stored
// straight away, unlinked, so the inbox can show progress per file; sending the
// reply (POST /api/chat/messages with attachmentIds) links it to the message.
// Multipart form: conversationId, file.
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.reply')) {
    return NextResponse.json({ error: 'You cannot send files' }, { status: 403 });
  }

  // Refuse an oversized body before reading it into memory. The multipart
  // wrapper adds a little on top of the file itself.
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_ATTACHMENT_BYTES + 64 * 1024) {
    return NextResponse.json({ error: TOO_LARGE_MESSAGE }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Could not read that upload' }, { status: 400 });
  }

  const conversationId = String(form.get('conversationId') || '');
  const file = form.get('file');
  if (!conversationId || !file || typeof file === 'string') {
    return NextResponse.json({ error: 'conversationId and file required' }, { status: 400 });
  }

  try {
    const conversation = await queryOne<{ id: string; tracker_business_id: string | null }>(
      `SELECT c.id, s.tracker_business_id
         FROM conversations c
         JOIN sites s ON s.id = c.site_id
        WHERE c.id = $1`,
      [conversationId]
    );
    if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (user.businessIds && user.businessIds.length > 0) {
      const panel = conversation.tracker_business_id;
      if (!panel || !user.businessIds.includes(panel)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    }

    if (file.size === 0) return NextResponse.json({ error: EMPTY_FILE_MESSAGE }, { status: 400 });
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ error: TOO_LARGE_MESSAGE }, { status: 413 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const type = sniffAttachmentType(bytes);
    if (!type) return NextResponse.json({ error: UNSUPPORTED_TYPE_MESSAGE }, { status: 415 });

    const id = randomBytes(32).toString('hex');
    const name = cleanFileName((file as File).name || '', type);

    await query(
      `INSERT INTO chat_attachments
         (id, conversation_id, file_name, mime_type, size_bytes, kind, data, uploaded_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [id, conversationId, name, type.mime, bytes.length, type.kind, bytes, user.username]
    );

    // Files picked but never sent are cleared out after a day.
    query(
      `DELETE FROM chat_attachments
        WHERE message_id IS NULL AND created_at < now() - interval '1 day'`
    ).catch(err => console.error('[chat] attachment cleanup failed:', (err as Error).message));

    return NextResponse.json({
      attachment: { id, name, mimeType: type.mime, size: bytes.length, kind: type.kind },
    });
  } catch (err) {
    console.error('[chat] attachment upload error:', err);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
