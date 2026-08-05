import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

// POST /api/draft-queue/complete?key=SECRET
// Called by Google Apps Script after attempting to create Gmail drafts.
// Body: { results: [{ queueId, orderId, to, success, error? }] }

const QUEUE_SECRET = process.env.DRAFT_QUEUE_SECRET || '';

export async function POST(request: NextRequest) {
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
      await query(
        `UPDATE draft_queue SET status = 'done', updated_at = $1 WHERE id = ANY($2::uuid[])`,
        [now, ids]
      );
    }

    // Mark failures as 'failed' and increment attempt count
    for (const f of failed) {
      await query(
        `UPDATE draft_queue
         SET status = 'failed', updated_at = $1, updated_at = NOW()
         WHERE id = $2`,
        [now, f.queueId]
      );
    }

    // Log successful drafts to email_logs for dedup
    if (succeeded.length > 0) {
      const emailLogRows = succeeded.filter(r => r.orderId);
      if (emailLogRows.length > 0) {
        const colCount = 5;
        const placeholders = emailLogRows.map(
          (_, j) => `(${Array.from({ length: colCount }, (_, k) => `$${j * colCount + k + 1}`).join(', ')})`
        ).join(', ');
        const params: unknown[] = [];
        emailLogRows.forEach(r => {
          params.push(r.orderId!, 'Order Placed', r.to || '', true, '');
        });
        await query(
          `INSERT INTO email_logs (order_id, status, recipient_email, success, error_message) VALUES ${placeholders}`,
          params
        );
      }
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
