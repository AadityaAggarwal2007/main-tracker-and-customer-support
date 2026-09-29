import { NextRequest } from 'next/server';
import { getOrCreateVisitorConversation, siteByKey, widgetJson, widgetPreflight } from '@/lib/chat/widget-api';

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

    const conversation = await getOrCreateVisitorConversation(site.id, visitorId, visitorName);

    return widgetJson({
      conversationId: conversation.id,
      status: conversation.status,
      siteName: site.name,
    });
  } catch (err) {
    console.error('[widget] conversation error:', err);
    return widgetJson({ error: 'Could not start a conversation' }, 500);
  }
}
