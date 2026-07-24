import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ═══════════════════════════════════════════════
// CRON: Auto-Progress Orders
// ═══════════════════════════════════════════════
// Called every minute (by Apps Script trigger or Vercel Cron).
// Finds orders whose current stage timer has expired
// and advances them to the next stage.
// ═══════════════════════════════════════════════

const CRON_SECRET = process.env.DRAFT_QUEUE_SECRET || '';

export async function GET(request: NextRequest) {
  // Verify secret (reuse DRAFT_QUEUE_SECRET)
  const key = request.nextUrl.searchParams.get('key') || '';
  if (!CRON_SECRET || key !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 1. Fetch all enabled progression steps
    const { data: steps } = await getSupabaseAdmin()
      .from('progression_settings')
      .select('*')
      .eq('is_enabled', true)
      .order('step_order', { ascending: true });

    if (!steps || steps.length === 0) {
      return NextResponse.json({ message: 'No progression steps enabled', progressed: 0 });
    }

    let totalProgressed = 0;

    // 2. For each step, find orders ready to progress
    for (const step of steps) {
      const cutoffTime = new Date(Date.now() - step.delay_minutes * 60 * 1000).toISOString();

      // Find orders at this status where enough time has passed
      const { data: readyOrders } = await getSupabaseAdmin()
        .from('orders')
        .select('order_id, tracking_status, status_updated_at')
        .eq('tracking_status', step.step_from)
        .eq('is_cancelled', false)
        .lte('status_updated_at', cutoffTime)
        .limit(50); // Process max 50 per step per run

      if (!readyOrders || readyOrders.length === 0) continue;

      // 3. Progress each order to the next status
      for (const order of readyOrders) {
        const { error } = await getSupabaseAdmin()
          .from('orders')
          .update({
            tracking_status: step.step_to,
            status_updated_at: new Date().toISOString(),
          })
          .eq('order_id', order.order_id);

        if (error) {
          console.error(`Failed to progress order ${order.order_id}:`, error);
          continue;
        }

        // 4. Log in tracking history
        await getSupabaseAdmin()
          .from('tracking_history')
          .insert({
            order_id: order.order_id,
            status: step.step_to,
            changed_by: 'auto-progression',
            notes: `Auto-progressed from "${step.step_from}" after ${step.delay_minutes} minutes`,
          });

        totalProgressed++;
      }
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
