import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest, AuthUser } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const VALID_STATUSES = ['ai_handling', 'agent_handling', 'resolved', 'human_needed'];

interface ConversationRow {
  id: string; site_id: string; visitor_name: string | null; visitor_phone: string | null;
  status: string; source: string; category: string; unread_count: number;
  last_message_at: string | null; created_at: string;
  site_name: string; tracker_business_id: string | null; panel_name: string | null;
}

// Reachable only if the conversation's panel is one this user may see.
async function loadForUser(id: string, user: AuthUser): Promise<ConversationRow | null> {
  const conv = await queryOne<ConversationRow>(
    `SELECT c.id, c.site_id, c.visitor_name, c.visitor_phone, c.status, c.source,
            c.category, c.unread_count, c.last_message_at, c.created_at,
            s.name AS site_name, s.tracker_business_id,
            b.name AS panel_name
       FROM conversations c
       JOIN sites s ON s.id = c.site_id
       LEFT JOIN businesses b ON b.id::text = s.tracker_business_id::text
      WHERE c.id = $1`,
    [id]
  );
  if (!conv) return null;

  if (user.businessIds && user.businessIds.length > 0) {
    const panel = conv.tracker_business_id;
    if (!panel || !user.businessIds.includes(panel)) return null;
  }
  return conv;
}

// ── GET /api/chat/conversations/:id ────────────────────────────
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const conversation = await loadForUser(params.id, user);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // tool_result rows and the hidden tool bookkeeping are context for the model,
  // not part of the conversation a person reads.
  const messages = await query(
    `SELECT id, sender, content, metadata, created_at
       FROM messages
      WHERE conversation_id = $1
        AND sender <> 'tool_result'
        AND COALESCE(metadata->>'hidden', 'false') <> 'true'
        AND content IS NOT NULL AND btrim(content) <> ''
      ORDER BY created_at ASC`,
    [params.id]
  );

  // Opening a thread clears its unread badge.
  if (conversation.unread_count > 0) {
    await query(`UPDATE conversations SET unread_count = 0, updated_at = now() WHERE id = $1`, [params.id]);
    conversation.unread_count = 0;
  }

  return NextResponse.json({ conversation, messages: messages.rows });
}

// ── PATCH /api/chat/conversations/:id ──────────────────────────
// Take over, hand back to the AI, or close. These were socket events in the old
// app; with the inbox polling they are an ordinary request.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role === 'viewer') {
    return NextResponse.json({ error: 'Viewers cannot change conversations' }, { status: 403 });
  }

  const conversation = await loadForUser(params.id, user);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const { status } = await request.json();
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Unknown status' }, { status: 400 });
    }

    await query(
      `UPDATE conversations
          SET status = $1,
              unread_count = CASE WHEN $1 = 'resolved' THEN 0 ELSE unread_count END,
              updated_at = now()
        WHERE id = $2`,
      [status, params.id]
    );

    return NextResponse.json({ success: true, status });
  } catch {
    return NextResponse.json({ error: 'Could not update that conversation' }, { status: 500 });
  }
}
