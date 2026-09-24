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
    // Sweep EVERY order still on its journey, in deterministic pages.
    //
    // This used to be a bare `LIMIT 2000` with no ORDER BY. Once the store
    // passed 2000 live orders, each run saw an arbitrary subset and Postgres
    // was free to return the same ones every time — so a tail of orders was
    // never advanced at all and their stored stage silently fell behind their
    // real age (718 of 3274 were stuck by up to 3 stages when this was found).
    // Keyset pagination on (created_at, order_id) is stable here because
    // neither column is modified by the update below.
    const PAGE = 1000;
    const MAX_PAGES = 500; // safety valve: 500k orders per run
    const rows: Candidate[] = [];
    let cursorAt: string | null = null;
    let cursorId: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = cursorAt === null
        ? await query<Candidate>(
            `SELECT order_id, tracking_status, created_at
               FROM orders
              WHERE is_cancelled = false
                AND COALESCE(tracking_status, '') <> 'Delivered'
              ORDER BY created_at, order_id
              LIMIT $1`,
            [PAGE]
          )
        : await query<Candidate>(
            `SELECT order_id, tracking_status, created_at
               FROM orders
              WHERE is_cancelled = false
                AND COALESCE(tracking_status, '') <> 'Delivered'
                AND (created_at, order_id) > ($1::timestamptz, $2::text)
              ORDER BY created_at, order_id
              LIMIT $3`,
            [cursorAt, cursorId, PAGE]
          );
      if (res.rows.length === 0) break;
      rows.push(...res.rows);
      const last = res.rows[res.rows.length - 1];
      cursorAt = last.created_at;
      cursorId = last.order_id;
      if (res.rows.length < PAGE) break;
    }

    const now = Date.now();
    // Bucket order_ids by the canonical status they should advance TO.
    const buckets = new Map<string, string[]>();

    for (const o of rows) {
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

    // Written in chunks: a single history INSERT binds 4 params per order, and
    // a full catch-up sweep can move thousands at once, which would otherwise
    // run into Postgres's 65535 bind-parameter ceiling.
    const WRITE_CHUNK = 500;

    for (const [targetStatus, allIds] of buckets) {
      if (allIds.length === 0) continue;
      const targetIndex = JOURNEY.findIndex((s) => s.status === targetStatus);
      const isDelivered = targetIndex === DELIVERED_INDEX;

      // Honest history note — never phrased as a confirmed courier scan.
      const note = isDelivered
        ? `Auto-completed on day ${AUTO_DELIVER_DAY} of the expected journey (not a verified courier confirmation).`
        : `Expected journey advanced to "${targetStatus}". No verified courier scan — framework stage.`;
      const changedBy = 'journey-engine';

      for (let off = 0; off < allIds.length; off += WRITE_CHUNK) {
        const orderIds = allIds.slice(off, off + WRITE_CHUNK);

        // Advance the orders. Auto-delivery deliberately leaves delivered_at
        // NULL — that column is reserved for a verified team confirmation.
        await query(
          `UPDATE orders
              SET tracking_status = $1, status_updated_at = NOW(), updated_at = NOW()
            WHERE order_id = ANY($2::text[])`,
          [targetStatus, orderIds]
        );

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
    }

    return NextResponse.json({
      success: true,
      scanned: rows.length,
      progressed: totalProgressed,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Progress orders cron error:', err);
    return NextResponse.json({ error: 'Cron failed', detail: String(err) }, { status: 500 });
  }
}
