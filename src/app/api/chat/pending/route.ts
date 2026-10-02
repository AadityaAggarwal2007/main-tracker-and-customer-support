import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';
import { can } from '@/lib/permissions';

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
  if (!can(user, 'chat.view')) return NextResponse.json({ error: 'You cannot open Chat Support' }, { status: 403 });

  const businessId = new URL(request.url).searchParams.get('businessId') || '';

  // A Refund / Ship again chat (chat-cases.sql) is counted under its own section, not here, except a
  // red Ship again chat (status human_needed, owner 2026-10-02, answer 8): it is in Needs you too.
  const conditions: string[] = [`c.status = 'human_needed'`, "(c.case_kind IS NULL OR c.case_kind = 'reship')"];
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
    // A verified customer's widget chats on one site are one inbox row
    // (customer_key, chat-customer-key.sql), so they count once here too.
    `SELECT count(DISTINCT CASE WHEN c.customer_key IS NOT NULL AND c.source = 'chat'
                                THEN 'k:' || c.site_id || ':' || c.customer_key
                                ELSE 'c:' || c.id END) AS human_needed,
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
