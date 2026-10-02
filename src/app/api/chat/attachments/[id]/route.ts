import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { ATTACHMENT_ID_PATTERN } from '@/lib/chat/attachment-rules';
import { can } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

// ── DELETE /api/chat/attachments/:id ───────────────────────────
// The agent removed a file from the reply before sending it. Only an unsent
// file can go; once it is part of a message it stays with that message.
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.reply')) {
    return NextResponse.json({ error: 'You cannot change files' }, { status: 403 });
  }
  if (!ATTACHMENT_ID_PATTERN.test(params.id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const attachment = await queryOne<{ id: string; tracker_business_id: string | null }>(
      `SELECT a.id, s.tracker_business_id
         FROM chat_attachments a
         JOIN conversations c ON c.id = a.conversation_id
         JOIN sites s ON s.id = c.site_id
        WHERE a.id = $1 AND a.message_id IS NULL`,
      [params.id]
    );
    if (!attachment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (user.businessIds && user.businessIds.length > 0) {
      const panel = attachment.tracker_business_id;
      if (!panel || !user.businessIds.includes(panel)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    }

    await query(`DELETE FROM chat_attachments WHERE id = $1 AND message_id IS NULL`, [params.id]);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[chat] attachment delete error:', err);
    return NextResponse.json({ error: 'Could not remove that file' }, { status: 500 });
  }
}
