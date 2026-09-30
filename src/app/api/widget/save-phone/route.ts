import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { conversationForSite, siteByKey, widgetJson, widgetPreflight } from '@/lib/chat/widget-api';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

// POST /api/widget/save-phone — lets a visitor pick the chat back up elsewhere
export async function POST(request: NextRequest) {
  try {
    const { conversationId, siteKey, phone } = await request.json();
    if (!conversationId || !siteKey || !phone) {
      return widgetJson({ error: 'conversationId, siteKey, phone required' }, 400);
    }

    const site = await siteByKey(siteKey);
    if (!site) return widgetJson({ error: 'Invalid site key' }, 404);

    const conversation = await conversationForSite(conversationId, site.id);
    if (!conversation) return widgetJson({ error: 'Forbidden' }, 403);

    await query(
      `UPDATE conversations SET visitor_phone = $1, updated_at = now() WHERE id = $2`,
      [phone, conversationId]
    );

    return widgetJson({ ok: true });
  } catch (err) {
    console.error('[widget] save-phone error:', err);
    return widgetJson({ error: 'Could not save that number' }, 500);
  }
}
