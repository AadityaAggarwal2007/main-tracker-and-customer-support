import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { query, queryOne } from '@/lib/db';
import { waDigits } from '@/lib/chat/whatsapp';

export const dynamic = 'force-dynamic';

// ── The WhatsApp tab's Test screen: one number's conversation, live (Super Admin only) ──
// GET ?to=<number>  ->  { conversationId, name, messages: oldest first (the last 40): who wrote, the text, when,
//                         the template used, and for ours Meta's report: sent / delivered / read / failed + the error }
// Read only: it never clears the inbox's unread count.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const url = new URL(request.url);
  // ?conversation=<id> (the Chats tab: one chat of one brand; &read=1 clears its unread count, as opening it in the
  // inbox does) or ?to=<number> (the Test tab: the number's latest chat, read only)
  const byId = (url.searchParams.get('conversation') || '').trim();
  const digits = waDigits(url.searchParams.get('to'));
  if (!byId && !digits) return NextResponse.json({ error: 'Type the WhatsApp number (10 digits = India)' }, { status: 400 });
  if (byId && !/^[\w-]{1,64}$/.test(byId)) return NextResponse.json({ error: 'Not a chat id' }, { status: 400 });
  try {
    const conv = byId
      ? await queryOne<{ id: string; name: string | null }>(
        `SELECT c.id, c.visitor_name AS name FROM conversations c WHERE c.id = $1 AND c.source = 'whatsapp' AND c.merged_into IS NULL`, [byId])
      : await queryOne<{ id: string; name: string | null }>(
        `SELECT c.id, c.visitor_name AS name FROM conversations c
          WHERE c.source = 'whatsapp' AND c.visitor_id = $1 AND c.merged_into IS NULL
          ORDER BY c.created_at DESC LIMIT 1`,
        [`wa:${digits}`]
      );
    if (!conv) return NextResponse.json({ conversationId: null, name: null, messages: [] });
    if (byId && url.searchParams.get('read') === '1') await query(`UPDATE conversations SET unread_count = 0 WHERE id = $1 AND unread_count > 0`, [conv.id]).catch(() => null);
    const rows = await query<{ id: string; sender: string; content: string; created_at: string; metadata: Record<string, unknown> | null }>(
      `SELECT m.id, m.sender, m.content, m.created_at, m.metadata FROM messages m
        WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND m.sender IN ('visitor', 'agent', 'system')
        ORDER BY m.created_at DESC LIMIT 40`,
      [conv.id]
    );
    const messages = rows.rows.reverse().map((r) => ({
      id: r.id, from: r.sender === 'visitor' ? 'customer' : 'us', auto: r.sender === 'system' && r.metadata?.automation === true, text: r.content.slice(0, 1000), at: r.created_at,
      template: typeof r.metadata?.wa_template === 'string' ? r.metadata.wa_template : null,
      sent: r.metadata?.wa_sent === true || (r.sender === 'system' && !!r.metadata?.wa_id) ? true : r.metadata?.wa_sent === false ? false : null,
      status: typeof r.metadata?.wa_status === 'string' ? r.metadata.wa_status : null,
      error: typeof r.metadata?.wa_error === 'string' ? r.metadata.wa_error : null,
    }));
    return NextResponse.json({ conversationId: conv.id, name: conv.name, messages });
  } catch (e) {
    console.error('[whatsapp] thread:', (e as Error).message);
    return NextResponse.json({ error: 'Could not read the conversation' }, { status: 500 });
  }
}
