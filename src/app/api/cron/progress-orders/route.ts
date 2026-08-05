import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

// ═══════════════════════════════════════════════
// CRON: Auto-Progress Orders
// ═══════════════════════════════════════════════
// Called every minute by Linux cron (on VPS).
// Finds orders whose current stage timer has expired
// and advances them to the next stage.
// ═══════════════════════════════════════════════

const CRON_SECRET = process.env.DRAFT_QUEUE_SECRET || '';

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') || '';
  if (!CRON_SECRET || key !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 1. Fetch all enabled progression steps
    const stepsResult = await query(
      `SELECT * FROM progression_settings WHERE is_enabled = true ORDER BY step_order ASC`
    );

    const steps = stepsResult.rows;
    if (steps.length === 0) {
      return NextResponse.json({ message: 'No progression steps enabled', progressed: 0 });
    }

    let totalProgressed = 0;

    // 2. For each step, batch-progress ready orders in ONE query (much faster)
    for (const step of steps) {
      const cutoffTime = new Date(Date.now() - step.delay_minutes * 60 * 1000).toISOString();

      // Get IDs of orders ready to progress
      const readyResult = await query<{ order_id: string }>(
        `SELECT order_id FROM orders
         WHERE tracking_status = $1
           AND is_cancelled = false
           AND status_updated_at <= $2
         LIMIT 100`,
        [step.step_from, cutoffTime]
      );

      const readyOrders = readyResult.rows;
      if (readyOrders.length === 0) continue;

      const orderIds = readyOrders.map(o => o.order_id);

      // 3. Batch-update all ready orders at once (single SQL statement)
      await query(
        `UPDATE orders
         SET tracking_status = $1, status_updated_at = NOW()
         WHERE order_id = ANY($2::text[])`,
        [step.step_to, orderIds]
      );

      // 4. Batch-insert tracking history (single INSERT with multiple rows)
      const valuePlaceholders = orderIds.map(
        (_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
      ).join(', ');

      const historyParams: unknown[] = [];
      orderIds.forEach(orderId => {
        historyParams.push(
          orderId,
          step.step_to,
          'auto-progression',
          `Auto-progressed from "${step.step_from}" after ${step.delay_minutes} minutes`
        );
      });

      await query(
        `INSERT INTO tracking_history (order_id, status, changed_by, notes) VALUES ${valuePlaceholders}`,
        historyParams
      );

      totalProgressed += orderIds.length;
    }

    return NextResponse.json({
      success: true,
      progressed: totalProgressed,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Progress orders cron error:', err);
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 });
  }
}
