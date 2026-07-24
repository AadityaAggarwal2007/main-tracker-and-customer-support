import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

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

    // Deduplicate: skip order_ids that are already pending/processing/done in the queue
    const alreadyQueued = new Set<string>();
    for (let i = 0; i < orderIds.length; i += 500) {
      const batch = orderIds.slice(i, i + 500);
      const { data } = await getSupabaseAdmin()
        .from('draft_queue')
        .select('order_id')
        .in('order_id', batch)
        .in('status', ['pending', 'processing', 'done']);
      if (data) data.forEach((r) => alreadyQueued.add(r.order_id));
    }

    const toEnqueue = orderIds.filter((id) => !alreadyQueued.has(id));

    if (toEnqueue.length === 0) {
      return NextResponse.json({
        queued: 0,
        skipped: orderIds.length,
        message: 'All orders already queued or completed',
      });
    }

    // Insert in batches of 500
    let queued = 0;
    for (let i = 0; i < toEnqueue.length; i += 500) {
      const batch = toEnqueue.slice(i, i + 500);
      const rows = batch.map((order_id) => ({ order_id, email_status: status, status: 'pending' }));
      const { error } = await getSupabaseAdmin().from('draft_queue').insert(rows);
      if (!error) queued += batch.length;
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
    // Count by status
    const statuses = ['pending', 'processing', 'done', 'failed'];
    const counts: Record<string, number> = {};

    await Promise.all(
      statuses.map(async (s) => {
        const { count } = await getSupabaseAdmin()
          .from('draft_queue')
          .select('*', { count: 'exact', head: true })
          .eq('status', s);
        counts[s] = count ?? 0;
      })
    );

    return NextResponse.json({
      pending: counts.pending,
      processing: counts.processing,
      done: counts.done,
      failed: counts.failed,
      total: statuses.reduce((sum, s) => sum + (counts[s] ?? 0), 0),
    });
  } catch (err) {
    console.error('Draft queue stats error:', err);
    return NextResponse.json({ error: 'Failed to fetch queue stats' }, { status: 500 });
  }
}
