import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  VISIBLE_MESSAGE_SQL, conversationForSite, siteByKey, widgetJson, widgetPreflight,
} from '@/lib/chat/widget-api';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

// GET /api/widget/messages/:conversationId?siteKey=&since=
// The widget polls this every 3 seconds while its panel is open.
export async function GET(
  request: NextRequest,
  { params }: { params: { conversationId: string } }
) {
  try {
    const { searchParams } = new URL(request.url);
    const siteKey = searchParams.get('siteKey');
    const since = searchParams.get('since');

    if (!siteKey) return widgetJson({ error: 'siteKey required' }, 400);

    const site = await siteByKey(siteKey);
    if (!site) return widgetJson({ error: 'Invalid site key' }, 404);

    const conversation = await conversationForSite(params.conversationId, site.id);
    if (!conversation) return widgetJson({ error: 'Forbidden' }, 403);

    const messages = await query(
      `SELECT id, conversation_id, sender, content, metadata, created_at
         FROM messages
        WHERE conversation_id = $1
          AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
          AND ${VISIBLE_MESSAGE_SQL}
        ORDER BY created_at ASC`,
      [params.conversationId, since || null]
    );

    return widgetJson({ messages: messages.rows, status: conversation.status });
  } catch (err) {
    console.error('[widget] messages error:', err);
    return widgetJson({ error: 'Could not load messages' }, 500);
  }
}
