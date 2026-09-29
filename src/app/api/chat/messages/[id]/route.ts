import { NextRequest, NextResponse } from 'next/server';
import { PoolClient } from 'pg';
import { getAuthFromRequest, AuthUser } from '@/lib/auth';
import { query, queryOne, withTransaction } from '@/lib/db';
import { MAX_MESSAGE_LENGTH, canChangeMessage, isOurMessage } from '@/lib/chat/message-rules';
import type { StoredAttachment } from '@/lib/chat/attachment-rules';

export const dynamic = 'force-dynamic';

// ── /api/chat/messages/:id ─────────────────────────────────────
// Manage one message we sent (AI or team): GET details and history, PATCH to
// edit the text in place, DELETE to hide it (soft delete). Every change first
// writes the old text to message_revisions. Who may do what is in
// src/lib/chat/message-rules.ts; it is checked here on every request.

interface MessageRow {
  id: string; conversation_id: string; sender: string; content: string;
  metadata: { agent?: string; hidden?: boolean; attachments?: StoredAttachment[]; captionless?: boolean; [k: string]: unknown } | null;
  created_at: string; edited_at: string | null; edited_by: string | null;
  deleted_at: string | null; deleted_by: string | null;
}

const RETURNING = `id, conversation_id, sender, content, metadata, created_at, edited_at, edited_by, deleted_at, deleted_by`;

// A change the agent can act on; anything else is a 500.
class MessageError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// The message, if it is one of ours and in a panel this user may see.
async function loadForUser(id: string, user: AuthUser) {
  const row = await queryOne<MessageRow & { source: string; tracker_business_id: string | null }>(
    `SELECT m.id, m.conversation_id, m.sender, m.content, m.metadata, m.created_at,
            m.edited_at, m.edited_by, m.deleted_at, m.deleted_by,
            c.source, s.tracker_business_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN sites s ON s.id = c.site_id
      WHERE m.id = $1`,
    [id]
  );
  if (!row || !isOurMessage(row)) return null;

  if (user.businessIds && user.businessIds.length > 0) {
    const panel = row.tracker_business_id;
    if (!panel || !user.businessIds.includes(panel)) return null;
  }
  return row;
}

// Re-read inside the transaction and lock the row, so two people changing the
// same message are applied one after the other and both land in the history.
async function lockForChange(client: PoolClient, id: string, user: AuthUser): Promise<MessageRow> {
  const locked = await client.query<MessageRow>(`SELECT ${RETURNING} FROM messages WHERE id = $1 FOR UPDATE`, [id]);
  const row = locked.rows[0];
  if (!row) throw new MessageError(404, 'Not found');
  if (row.deleted_at) throw new MessageError(409, 'This message has already been deleted.');
  if (!canChangeMessage(user, row)) throw new MessageError(403, 'You can only change AI messages and your own replies.');
  return row;
}

function fail(err: unknown, fallback: string) {
  if (err instanceof MessageError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(`[chat] ${fallback}:`, err);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

// ── GET: details and edit history ─────────────────────────────
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const message = await loadForUser(params.id, user);
    if (!message) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const revisions = await query(
      `SELECT action, previous_content, new_content, actor, actor_role, created_at
         FROM message_revisions
        WHERE message_id = $1
        ORDER BY created_at ASC`,
      [params.id]
    );

    return NextResponse.json({
      message,
      revisions: revisions.rows,
      canChange: canChangeMessage(user, message),
    });
  } catch (err) {
    return fail(err, 'Could not load that message');
  }
}

// ── PATCH: edit the text in place ─────────────────────────────
// Body: { content }. Same row, same id, same position; marked edited.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role === 'viewer') {
    return NextResponse.json({ error: 'Viewers cannot change messages' }, { status: 403 });
  }

  try {
    const { content } = await request.json();
    const text = typeof content === 'string' ? content.trim() : '';
    if (text.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ error: `A message can be at most ${MAX_MESSAGE_LENGTH} characters.` }, { status: 400 });
    }

    if (!(await loadForUser(params.id, user))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const message = await withTransaction(async client => {
      const current = await lockForChange(client, params.id, user);

      // Files stay with the message. With the text cleared, a files-only
      // message gets back its short stand-in text (see POST /api/chat/messages).
      const files = Array.isArray(current.metadata?.attachments) ? current.metadata!.attachments! : [];
      if (!text && files.length === 0) throw new MessageError(400, "A message can't be empty.");

      const metadata = { ...(current.metadata || {}) };
      if (files.length > 0) {
        if (text) delete metadata.captionless;
        else metadata.captionless = true;
      }
      const next = text || `📎 ${files.map(f => f.name).join(', ')}`;

      if (next === current.content && !!metadata.captionless === !!current.metadata?.captionless) {
        return current; // nothing changed
      }

      await client.query(
        `INSERT INTO message_revisions
           (message_id, conversation_id, action, previous_content, new_content, actor, actor_role)
         VALUES ($1, $2, 'edit', $3, $4, $5, $6)`,
        [current.id, current.conversation_id, current.content, next, user.username, user.role]
      );
      const updated = await client.query<MessageRow>(
        `UPDATE messages
            SET content = $2, metadata = $3::jsonb, edited_at = now(), edited_by = $4
          WHERE id = $1
        RETURNING ${RETURNING}`,
        [current.id, next, JSON.stringify(metadata), user.username]
      );
      return updated.rows[0];
    });

    return NextResponse.json({ message });
  } catch (err) {
    return fail(err, 'Unable to update message');
  }
}

// ── DELETE: hide it (soft delete) ─────────────────────────────
// The row and its text stay for the record; the customer's chat, the AI's
// history, the conversation list and the message's files stop showing it.
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role === 'viewer') {
    return NextResponse.json({ error: 'Viewers cannot change messages' }, { status: 403 });
  }

  try {
    if (!(await loadForUser(params.id, user))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const message = await withTransaction(async client => {
      const current = await lockForChange(client, params.id, user);
      await client.query(
        `INSERT INTO message_revisions
           (message_id, conversation_id, action, previous_content, new_content, actor, actor_role)
         VALUES ($1, $2, 'delete', $3, NULL, $4, $5)`,
        [current.id, current.conversation_id, current.content, user.username, user.role]
      );
      const updated = await client.query<MessageRow>(
        `UPDATE messages SET deleted_at = now(), deleted_by = $2 WHERE id = $1 RETURNING ${RETURNING}`,
        [current.id, user.username]
      );
      return updated.rows[0];
    });

    return NextResponse.json({ message });
  } catch (err) {
    return fail(err, 'Unable to delete message');
  }
}
