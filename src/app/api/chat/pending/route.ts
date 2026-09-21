import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// ── GET /api/chat/pending ──────────────────────────────────────
// Count of conversations waiting on a person. The sidebar badge polls this,
// so it stays a COUNT — pulling the conversation rows just to length them
// would ship a few hundred records every refresh.
//
// This matters most on email: an escalated email reply is deliberately held
// and never auto-sent, so the customer hears nothing at all until someone
// answers it here. Without a visible count that queue is invisible.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const businessId = new URL(request.url).searchParams.get('businessId') || '';

  const conditions: string[] = [`c.status = 'human_needed'`];
  const params: unknown[] = [];
  let pi = 1;

  if (businessId) {
    // A user restricted to certain panels cannot read another one by asking.
    if (user.businessIds && user.businessIds.length > 0 && !user.businessIds.includes(businessId)) {
      return NextResponse.json({ humanNeeded: 0, emailWaiting: 0 });
    }
    conditions.push(`s.tracker_business_id::text = $${pi++}::text`);
    params.push(businessId);
  } else if (user.businessIds && user.businessIds.length > 0) {
    conditions.push(`s.tracker_business_id::text = ANY($${pi++}::text[])`);
    params.push(user.businessIds);
  }

  const row = await query<{ human_needed: string; email_waiting: string }>(
    `SELECT count(*) AS human_needed,
            count(*) FILTER (WHERE c.source = 'email') AS email_waiting
       FROM conversations c
       JOIN sites s ON s.id = c.site_id
      WHERE ${conditions.join(' AND ')}`,
    params
  );

  const r = row.rows[0];
  const res = NextResponse.json({
    humanNeeded: Number(r?.human_needed ?? 0),
    emailWaiting: Number(r?.email_waiting ?? 0),
  });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
