import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// ── GET /api/chat/conversations ────────────────────────────────
// The inbox list. Scoped to the panels this user may see, because the chat
// tables know nothing about ShipTrack's roles on their own.
//
// sites.tracker_business_id is text and businesses.id is uuid, so every join
// between the two apps' tables compares as text.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('businessId') || '';
  const status = searchParams.get('status') || '';
  const category = searchParams.get('category') || '';
  const limit = Math.min(parseInt(searchParams.get('limit') || '200', 10), 500);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  if (businessId) {
    // A user restricted to certain panels cannot read another one by asking.
    if (user.businessIds && user.businessIds.length > 0 && !user.businessIds.includes(businessId)) {
      return NextResponse.json({ conversations: [] });
    }
    conditions.push(`s.tracker_business_id::text = $${pi++}::text`);
    params.push(businessId);
  } else if (user.businessIds && user.businessIds.length > 0) {
    conditions.push(`s.tracker_business_id::text = ANY($${pi++}::text[])`);
    params.push(user.businessIds);
  }

  if (status) { conditions.push(`c.status = $${pi++}`); params.push(status); }
  if (category) { conditions.push(`c.category = $${pi++}`); params.push(category); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const result = await query(
    `SELECT c.id, c.visitor_name, c.visitor_phone, c.status, c.source, c.category,
            c.unread_count, c.last_message_at, c.created_at,
            s.id AS site_id, s.name AS site_name, s.tracker_business_id,
            b.name AS panel_name,
            (SELECT m.content
               FROM messages m
              WHERE m.conversation_id = c.id
                AND m.sender <> 'tool_result'
                AND COALESCE(m.metadata->>'hidden', 'false') <> 'true'
                AND m.content IS NOT NULL AND btrim(m.content) <> ''
              ORDER BY m.created_at DESC
              LIMIT 1) AS last_message
       FROM conversations c
       JOIN sites s ON s.id = c.site_id
       LEFT JOIN businesses b ON b.id::text = s.tracker_business_id::text
       ${where}
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $${pi}`,
    params
  );

  return NextResponse.json({ conversations: result.rows });
}
