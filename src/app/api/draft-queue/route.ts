import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// POST /api/draft-queue — enqueue order IDs for draft creation
// GET  /api/draft-queue — return queue stats { pending, processing, done, failed, total }

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { orderIds, status = 'Order Placed' } = body as { orderIds: string[]; status?: string };

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return NextResponse.json({ error: 'No order IDs provided' }, { status: 400 });
    }

    // Deduplicate: find order_ids already in queue (pending/processing/done)
    const alreadyQueued = new Set<string>();
    for (let i = 0; i < orderIds.length; i += 500) {
      const batch = orderIds.slice(i, i + 500);
      const result = await query<{ order_id: string }>(
        `SELECT order_id FROM draft_queue
         WHERE order_id = ANY($1::text[])
           AND status IN ('pending', 'processing', 'done')`,
        [batch]
      );
      result.rows.forEach(r => alreadyQueued.add(r.order_id));
    }

    const toEnqueue = orderIds.filter(id => !alreadyQueued.has(id));

    if (toEnqueue.length === 0) {
      return NextResponse.json({
        queued: 0,
        skipped: orderIds.length,
        message: 'All orders already queued or completed',
      });
    }

    // Batch-insert in chunks of 500
    let queued = 0;
    for (let i = 0; i < toEnqueue.length; i += 500) {
      const batch = toEnqueue.slice(i, i + 500);
      const valuePlaceholders = batch.map(
        (_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`
      ).join(', ');
      const params: unknown[] = [];
      batch.forEach(orderId => {
        params.push(orderId, status, 'pending');
      });

      const result = await query(
        `INSERT INTO draft_queue (order_id, email_status, status) VALUES ${valuePlaceholders}`,
        params
      );
      queued += result.rowCount ?? 0;
    }

    return NextResponse.json({
      queued,
      skipped: alreadyQueued.size,
      message: `${queued} orders queued for Gmail draft creation`,
    });
  } catch (err) {
    console.error('Draft queue enqueue error:', err);
    return NextResponse.json({ error: 'Failed to enqueue drafts' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // Single query to get all status counts at once (vs 4 separate Supabase calls)
    const result = await query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count
       FROM draft_queue
       GROUP BY status`
    );

    const counts: Record<string, number> = { pending: 0, processing: 0, done: 0, failed: 0 };
    result.rows.forEach(r => { counts[r.status] = parseInt(r.count, 10); });

    return NextResponse.json({
      pending: counts.pending,
      processing: counts.processing,
      done: counts.done,
      failed: counts.failed,
      total: Object.values(counts).reduce((s, v) => s + v, 0),
    });
  } catch (err) {
    console.error('Draft queue stats error:', err);
    return NextResponse.json({ error: 'Failed to fetch queue stats' }, { status: 500 });
  }
}
