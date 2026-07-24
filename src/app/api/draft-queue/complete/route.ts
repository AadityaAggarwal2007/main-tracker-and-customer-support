import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

// POST /api/draft-queue/complete?key=SECRET
// Called by Google Apps Script after attempting to create Gmail drafts.
// Body: { results: [{ queueId, orderId, to, success, error? }] }

const QUEUE_SECRET = process.env.DRAFT_QUEUE_SECRET || '';

export async function POST(request: NextRequest) {
  // Validate secret key
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key') || '';

  if (!QUEUE_SECRET || key !== QUEUE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { results } = body as {
      results: Array<{
        queueId: string;
        orderId?: string;
        to?: string;
        success: boolean;
        error?: string;
      }>;
    };

    if (!results || !Array.isArray(results) || results.length === 0) {
      return NextResponse.json({ error: 'No results provided' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Mark successes as 'done'
    if (succeeded.length > 0) {
      const ids = succeeded.map((r) => r.queueId);
      await getSupabaseAdmin()
        .from('draft_queue')
        .update({ status: 'done', processed_at: now, error: null })
        .in('id', ids);
    }

    // Mark failures as 'failed' and increment attempt count
    for (const f of failed) {
      // First read current attempts
      const { data: row } = await getSupabaseAdmin()
        .from('draft_queue')
        .select('attempts')
        .eq('id', f.queueId)
        .single();

      const newAttempts = (row?.attempts ?? 0) + 1;

      await getSupabaseAdmin()
        .from('draft_queue')
        .update({
          status: 'failed',
          processed_at: now,
          error: f.error || 'Unknown error',
          attempts: newAttempts,
        })
        .eq('id', f.queueId);
    }

    // Log successful drafts to email_logs so the "already sent" dedup works
    const emailLogRows = succeeded
      .filter((r) => r.orderId)
      .map((r) => ({
        order_id: r.orderId!,
        status: 'Order Placed',
        recipient_email: r.to || '',
        success: true,
        error_message: '',
      }));

    if (emailLogRows.length > 0) {
      await getSupabaseAdmin().from('email_logs').insert(emailLogRows);
    }

    return NextResponse.json({
      marked_done: succeeded.length,
      marked_failed: failed.length,
      message: `${succeeded.length} done, ${failed.length} failed`,
    });
  } catch (err) {
    console.error('Draft queue complete error:', err);
    return NextResponse.json({ error: 'Failed to update queue' }, { status: 500 });
  }
}
