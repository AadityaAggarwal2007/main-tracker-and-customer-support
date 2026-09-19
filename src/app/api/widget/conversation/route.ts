import { NextRequest } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { siteByKey, widgetJson, widgetPreflight } from '@/lib/chat/widget-api';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

// POST /api/widget/conversation — get or create this visitor's conversation
export async function POST(request: NextRequest) {
  try {
    const { siteKey, visitorId, visitorName } = await request.json();
    if (!siteKey || !visitorId) {
      return widgetJson({ error: 'siteKey and visitorId required' }, 400);
    }

    const site = await siteByKey(siteKey);
    if (!site) return widgetJson({ error: 'Invalid site key' }, 404);

    let conversation = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM conversations
        WHERE site_id = $1 AND visitor_id = $2 AND status <> 'resolved'
        ORDER BY created_at DESC
        LIMIT 1`,
      [site.id, visitorId]
    );

    if (!conversation) {
      conversation = await queryOne<{ id: string; status: string }>(
        `INSERT INTO conversations
           (id, site_id, visitor_id, visitor_name, status, source, category,
            unread_count, last_message_at, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'ai_handling', 'chat', 'others',
                 0, now(), now(), now())
         RETURNING id, status`,
        [site.id, visitorId, visitorName || 'Visitor']
      );
    }

    return widgetJson({
      conversationId: conversation!.id,
      status: conversation!.status,
      siteName: site.name,
    });
  } catch (err) {
    console.error('[widget] conversation error:', err);
    return widgetJson({ error: 'Could not start a conversation' }, 500);
  }
}
