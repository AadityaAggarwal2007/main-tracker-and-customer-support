import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// ── What happened on WhatsApp lately (the WhatsApp screen's Activity tab, Super Admin) ──
// GET { chats: the last 20 WhatsApp chats (who, status, last line, unread), sent: the last 20 messages the team
//       sent on WhatsApp with Meta's answer (sent / delivered / read / failed, the template, the error) }
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const chats = await query<{ id: string; name: string | null; phone: string | null; status: string; unread: number; last_message_at: string | null; last_message: string | null; last_sender: string | null; panel: string | null }>(
      `SELECT c.id, c.visitor_name AS name, c.visitor_phone AS phone, c.status, c.unread_count AS unread, c.last_message_at,
              (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_message,
              (SELECT m.sender FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_sender,
              b.name AS panel
         FROM conversations c
         JOIN sites s ON s.id = c.site_id
         LEFT JOIN businesses b ON b.id::text = s.tracker_business_id::text
        WHERE c.source = 'whatsapp' AND c.merged_into IS NULL
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT 20`
    );
    const sent = await query<{ id: string; conversation_id: string; content: string; created_at: string; metadata: Record<string, unknown> | null; name: string | null; phone: string | null }>(
      `SELECT m.id, m.conversation_id, m.content, m.created_at, m.metadata, c.visitor_name AS name, c.visitor_phone AS phone
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.source = 'whatsapp' AND m.sender = 'agent' AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT 20`
    );
    return NextResponse.json({
      chats: chats.rows,
      sent: sent.rows.map((r) => ({
        id: r.id, conversationId: r.conversation_id, text: r.content.slice(0, 300), at: r.created_at, name: r.name, phone: r.phone,
        by: typeof r.metadata?.agent === 'string' ? r.metadata.agent : null,
        template: typeof r.metadata?.wa_template === 'string' ? r.metadata.wa_template : null,
        sent: r.metadata?.wa_sent === true ? true : r.metadata?.wa_sent === false ? false : null,
        status: typeof r.metadata?.wa_status === 'string' ? r.metadata.wa_status : null,
        error: typeof r.metadata?.wa_error === 'string' ? r.metadata.wa_error : null,
      })),
    });
  } catch (e) {
    console.error('[whatsapp] activity:', (e as Error).message);
    return NextResponse.json({ chats: [], sent: [], error: 'Could not read the WhatsApp activity' });
  }
}
