import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  CUSTOMER_MESSAGE_SQL, VISIBLE_MESSAGE_SQL, conversationForSite, siteByKey, widgetJson, widgetPreflight,
} from '@/lib/chat/widget-api';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

// GET /api/widget/messages/:conversationId?siteKey=&since=[&changes=1]
// The widget polls this every 3 seconds.
//
// Without `since`: the whole visible history.
// With `since`: messages newer than that.
// With `since` and changes=1 (sent by widget.js since message editing): also
// messages the team edited or deleted after `since`, so an open chat updates in
// place. A deleted one comes back only as its id with deleted: true and no
// text. changed_at is the value to send as the next `since`. Older copies of
// widget.js do not send changes=1 and keep getting exactly what they always did.
//
// Times go out in JSON with millisecond precision while the database keeps
// microseconds, so comparisons are cut to milliseconds; otherwise the newest
// row would come back on every poll.
export async function GET(
  request: NextRequest,
  { params }: { params: { conversationId: string } }
) {
  try {
    const { searchParams } = new URL(request.url);
    const siteKey = searchParams.get('siteKey');
    const since = searchParams.get('since');
    const changes = searchParams.get('changes') === '1';

    if (!siteKey) return widgetJson({ error: 'siteKey required' }, 400);

    const site = await siteByKey(siteKey);
    if (!site) return widgetJson({ error: 'Invalid site key' }, 404);

    const conversation = await conversationForSite(params.conversationId, site.id);
    if (!conversation) return widgetJson({ error: 'Forbidden' }, 403);

    const ms = (col: string) => `date_trunc('milliseconds', ${col}) > $2::timestamptz`;
    const filter = !since ? VISIBLE_MESSAGE_SQL
      : changes ? `${CUSTOMER_MESSAGE_SQL} AND (${ms('created_at')} OR ${ms('edited_at')} OR ${ms('deleted_at')})`
      : `${VISIBLE_MESSAGE_SQL} AND ${ms('created_at')}`;

    const messages = await query(
      `SELECT id, conversation_id, sender,
              CASE WHEN deleted_at IS NULL THEN content ELSE '' END AS content,
              CASE WHEN deleted_at IS NULL THEN metadata END AS metadata,
              created_at, edited_at,
              (deleted_at IS NOT NULL) AS deleted,
              GREATEST(created_at, edited_at, deleted_at) AS changed_at
         FROM messages
        WHERE conversation_id = $1
          AND ${filter}
        ORDER BY created_at ASC`,
      since ? [params.conversationId, since] : [params.conversationId]
    );

    return widgetJson({ messages: messages.rows, status: conversation.status });
  } catch (err) {
    console.error('[widget] messages error:', err);
    return widgetJson({ error: 'Could not load messages' }, 500);
  }
}
