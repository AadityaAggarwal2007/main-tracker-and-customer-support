import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne, withTransaction } from '@/lib/db';
import { sendAgentEmailReply } from '@/lib/chat/email';
import { stripMarkdownEmphasis } from '@/lib/chat/plain-text';
import { can, canAccessPanel } from '@/lib/permissions';
import {
  ATTACHMENT_ID_PATTERN, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES,
  TOO_MANY_MESSAGE, TOTAL_TOO_LARGE_MESSAGE, StoredAttachment, AttachmentKind, attachmentUrl,
} from '@/lib/chat/attachment-rules';

export const dynamic = 'force-dynamic';

// A reply the agent can fix and send again; anything else is a 500.
class ReplyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ── POST /api/chat/messages ────────────────────────────────────
// An agent replies. Chat replies are picked up by the widget's next poll;
// an email conversation additionally goes out over SMTP.
// Body: { conversationId, content, attachmentIds? } — attachmentIds are files
// already uploaded to /api/chat/attachments for this conversation. A reply
// needs text, files, or both.
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.reply')) {
    return NextResponse.json({ error: 'You cannot reply' }, { status: 403 });
  }

  try {
    const { conversationId, content, attachmentIds } = await request.json();
    // Pasted **bold** would reach the customer as literal asterisks.
    const text = stripMarkdownEmphasis(content == null ? '' : String(content));
    const hasText = text.trim() !== '';
    const fileIds: unknown[] = Array.isArray(attachmentIds) ? attachmentIds : [];

    if (!conversationId || (!hasText && fileIds.length === 0)) {
      return NextResponse.json({ error: 'conversationId and content required' }, { status: 400 });
    }
    if (fileIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return NextResponse.json({ error: TOO_MANY_MESSAGE }, { status: 400 });
    }
    if (fileIds.some(id => typeof id !== 'string' || !ATTACHMENT_ID_PATTERN.test(id))
        || new Set(fileIds).size !== fileIds.length) {
      return NextResponse.json({ error: 'Invalid attachment' }, { status: 400 });
    }
    const ids = fileIds as string[];

    const conversation = await queryOne<{ id: string; source: string; tracker_business_id: string | null }>(
      `SELECT c.id, c.source, s.tracker_business_id
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

    // The message and the files it carries are saved together, or not at all.
    const message = await withTransaction(async client => {
      let files: StoredAttachment[] = [];
      if (ids.length > 0) {
        const found = await client.query<{
          id: string; file_name: string; mime_type: string; size_bytes: number; kind: AttachmentKind;
        }>(
          `SELECT id, file_name, mime_type, size_bytes, kind
             FROM chat_attachments
            WHERE id = ANY($1::text[]) AND conversation_id = $2 AND message_id IS NULL
            FOR UPDATE`,
          [ids, conversationId]
        );
        if (found.rows.length !== ids.length) {
          throw new ReplyError(400, 'One of the files is no longer available. Remove it and attach it again.');
        }
        const total = found.rows.reduce((n, r) => n + r.size_bytes, 0);
        if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new ReplyError(413, TOTAL_TOO_LARGE_MESSAGE);

        // In the order the agent attached them.
        files = ids.map(id => {
          const r = found.rows.find(row => row.id === id)!;
          return {
            id: r.id, url: attachmentUrl(r.id), name: r.file_name,
            mimeType: r.mime_type, size: r.size_bytes, kind: r.kind, status: 'sent' as const,
          };
        });
      }

      // A files-only reply still gets readable text: the conversation list, the
      // AI's history, email bodies and older widgets all show messages by their
      // text. `captionless` tells the inbox and the widget not to repeat it
      // under the files.
      const stored = hasText ? text : `📎 ${files.map(f => f.name).join(', ')}`;
      const metadata: Record<string, unknown> = { agent: user.username };
      if (files.length > 0) {
        metadata.attachments = files;
        if (!hasText) metadata.captionless = true;
      }

      const inserted = await client.query<{
        id: string; sender: string; content: string; metadata: unknown; created_at: string;
      }>(
        `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
         VALUES (gen_random_uuid()::text, $1, 'agent', $2, $3::jsonb, now())
         RETURNING id, sender, content, metadata, created_at`,
        [conversationId, stored, JSON.stringify(metadata)]
      );
      const row = inserted.rows[0];

      if (ids.length > 0) {
        await client.query(
          `UPDATE chat_attachments SET message_id = $1 WHERE id = ANY($2::text[])`,
          [row.id, ids]
        );
      }
      return row;
    });

    // A person answering means the AI stands down for this thread, and the
    // "came back after the auto-close" mark (chat-auto-close.sql) is done with.
    await query(
      `UPDATE conversations
          SET status = 'agent_handling', last_message_at = now(), auto_closed_at = NULL, updated_at = now()
        WHERE id = $1`,
      [conversationId]
    );

    // The message is already saved, so a failing mail server must not lose the
    // agent's reply — it is reported instead.
    let emailed: boolean | null = null;
    if (conversation.source === 'email') {
      try {
        await sendAgentEmailReply(conversationId, message.content, ids);
        emailed = true;
      } catch (err) {
        emailed = false;
        console.error('[chat] agent email reply failed:', (err as Error).message);
      }
      // Kept on the message for "View details" in the inbox.
      await query(
        `UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('emailed', $2::boolean)
          WHERE id = $1`,
        [message.id, emailed]
      ).catch(err => console.error('[chat] could not record email status:', (err as Error).message));
    }

    return NextResponse.json({ message, emailed });
  } catch (err) {
    if (err instanceof ReplyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[chat] agent reply error:', err);
    return NextResponse.json({ error: 'Could not send that reply' }, { status: 500 });
  }
}
