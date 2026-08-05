import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';

// POST: Check which order IDs have been emailed
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { orderIds } = await request.json();

    if (!orderIds || !Array.isArray(orderIds)) {
      return NextResponse.json({ emailedIds: [] });
    }

    // Single query — direct Postgres has no batch limit
    const result = await query<{ order_id: string }>(
      `SELECT DISTINCT order_id FROM email_logs
       WHERE order_id = ANY($1::text[]) AND success = true`,
      [orderIds]
    );

    const emailedIds = result.rows.map(r => r.order_id);

    return NextResponse.json({ emailedIds });
  } catch {
    return NextResponse.json({ emailedIds: [] });
  }
}
