import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import {
  JOURNEY,
  DELIVERED_INDEX,
  AUTO_DELIVER_DAY,
  expectedIndexForAge,
  statusToIndex,
} from '@/lib/journey';

export const dynamic = 'force-dynamic';

// ═══════════════════════════════════════════════════════════════════════
// CRON: Advance orders along the 12-day journey (deterministic — NO AI)
// ═══════════════════════════════════════════════════════════════════════
// Called every minute by Linux cron (on VPS).
//
// The 12-day expected journey (src/lib/journey.ts) is the single source of
// truth: each order's stage is derived purely from how many days have passed
// since it was placed. We never invent a courier scan — the intermediate
// stages are the honest EXPECTED framework, surfaced as such on the track
// page. Delivered is auto-marked on day 13 (business rule) with delivered_at
// left NULL, so the UI can still distinguish it from a team-confirmed
// delivery.
//
// Only ever advances FORWARD, never regresses, and never touches cancelled /
// RTO / failed / manually-set special states.
// ═══════════════════════════════════════════════════════════════════════

const CRON_SECRET = process.env.DRAFT_QUEUE_SECRET || '';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Candidate {
  order_id: string;
  tracking_status: string;
  created_at: string;
}

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') || '';
  if (!CRON_SECRET || key !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Pull every order still on its journey. Delivered / cancelled are terminal.
    const result = await query<Candidate>(
      `SELECT order_id, tracking_status, created_at
         FROM orders
        WHERE is_cancelled = false
          AND COALESCE(tracking_status, '') <> 'Delivered'
        LIMIT 2000`
    );

    const now = Date.now();
    // Bucket order_ids by the canonical status they should advance TO.
    const buckets = new Map<string, string[]>();

    for (const o of result.rows) {
      const currentIndex = statusToIndex(o.tracking_status);
      // Skip special / unknown states (Stuck, RTO, Delivery Failed, etc.) —
      // those are handled by the team, not the schedule.
      if (currentIndex === null) continue;

      const created = new Date(o.created_at).getTime();
      if (Number.isNaN(created)) continue;
      const ageDays = Math.max(0, Math.floor((now - created) / DAY_MS));

      const targetIndex = expectedIndexForAge(ageDays); // includes Delivered at day 13
      if (targetIndex <= currentIndex) continue; // only move forward

      const targetStatus = JOURNEY[targetIndex].status;
      if (!buckets.has(targetStatus)) buckets.set(targetStatus, []);
      buckets.get(targetStatus)!.push(o.order_id);
    }

    let totalProgressed = 0;

    for (const [targetStatus, orderIds] of buckets) {
      if (orderIds.length === 0) continue;
      const targetIndex = JOURNEY.findIndex((s) => s.status === targetStatus);
      const isDelivered = targetIndex === DELIVERED_INDEX;

      // Advance the orders. Auto-delivery deliberately leaves delivered_at
      // NULL — that column is reserved for a verified team confirmation.
      await query(
        `UPDATE orders
            SET tracking_status = $1, status_updated_at = NOW(), updated_at = NOW()
          WHERE order_id = ANY($2::text[])`,
        [targetStatus, orderIds]
      );

      // Honest history note — never phrased as a confirmed courier scan.
      const note = isDelivered
        ? `Auto-completed on day ${AUTO_DELIVER_DAY} of the expected journey (not a verified courier confirmation).`
        : `Expected journey advanced to "${targetStatus}". No verified courier scan — framework stage.`;
      const changedBy = 'journey-engine';

      const valuePlaceholders = orderIds
        .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
        .join(', ');
      const historyParams: unknown[] = [];
      orderIds.forEach((orderId) => {
        historyParams.push(orderId, targetStatus, changedBy, note);
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
    return NextResponse.json({ error: 'Cron failed', detail: String(err) }, { status: 500 });
  }
}
