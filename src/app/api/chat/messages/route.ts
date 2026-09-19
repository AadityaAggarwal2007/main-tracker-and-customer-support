import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { sendAgentEmailReply } from '@/lib/chat/email';

export const dynamic = 'force-dynamic';

// ── POST /api/chat/messages ────────────────────────────────────
// An agent replies. Chat replies are picked up by the widget's next poll;
// an email conversation additionally goes out over SMTP.
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role === 'viewer') {
    return NextResponse.json({ error: 'Viewers cannot reply' }, { status: 403 });
  }

  try {
    const { conversationId, content } = await request.json();
    if (!conversationId || !content || !String(content).trim()) {
      return NextResponse.json({ error: 'conversationId and content required' }, { status: 400 });
    }

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

    const message = await queryOne<{ id: string; sender: string; content: string; created_at: string }>(
      `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
       VALUES (gen_random_uuid()::text, $1, 'agent', $2, $3::jsonb, now())
       RETURNING id, sender, content, created_at`,
      [conversationId, content, JSON.stringify({ agent: user.username })]
    );

    // A person answering means the AI stands down for this thread.
    await query(
      `UPDATE conversations
          SET status = 'agent_handling', last_message_at = now(), updated_at = now()
        WHERE id = $1`,
      [conversationId]
    );

    // The message is already saved, so a failing mail server must not lose the
    // agent's reply — it is reported instead.
    let emailed: boolean | null = null;
    if (conversation.source === 'email') {
      try {
        await sendAgentEmailReply(conversationId, content);
        emailed = true;
      } catch (err) {
        emailed = false;
        console.error('[chat] agent email reply failed:', (err as Error).message);
      }
    }

    return NextResponse.json({ message, emailed });
  } catch (err) {
    console.error('[chat] agent reply error:', err);
    return NextResponse.json({ error: 'Could not send that reply' }, { status: 500 });
  }
}
