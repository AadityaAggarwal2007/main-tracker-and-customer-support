// ── The order line in the inbox thread header ──────────────────
// Asked for by the owner on 2026-09-30: next to the customer's name, staff see
// when the order was placed, how far it has got in ShipTrack, and its estimated
// delivery date, so nobody has to open the panel or ask the customer.
//
// STAFF ONLY: read by GET /api/chat/conversations/[id] (behind login and panel
// scope). The AI reads it only to work out how late an order is (the delay ladder in
// ai.ts / delay-ladder.ts); none of these facts is put in its prompt or shown to a
// customer by it. Never by the widget or /api/widget/*. The status is the one
// the customer's own tracking page shows (buildJourney in journey.ts: the stored
// status, moved forward by the order's age), so staff and customer read the same
// thing. It works from the order the chat verified, else the one its number
// matched (an old phone match: no new chat gets one), inside the chat's own panel.
import { query } from '@/lib/db';
import { buildJourney, type JourneyOrder } from '@/lib/journey';

export interface OrderFacts {
  order_id: string;
  // 'verified' = the customer proved the order; 'phone_match' = a staff hint only.
  source: 'verified' | 'phone_match';
  placed_on: string | null;
  // The stage as the customer's tracking page words it ("Shipment Picked Up",
  // "Delivered", "Order Cancelled").
  status: string;
  mode: 'normal' | 'cancelled' | 'rto' | 'failed';
  delivered: boolean;
  // The date on the order, else the day-13 end of the delivery window (eta_estimated).
  eta: string | null;
  eta_estimated: boolean;
}

interface FactsRow {
  order_id: string; tracking_status: string; is_cancelled: boolean;
  created_at: string | Date; status_updated_at: string | Date | null;
  estimated_delivery: string | Date | null; state: string | null; city: string | null;
  delivered_at: string | Date | null; origin_city: string | null;
}

const iso = (v: string | Date | null | undefined): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// null when the chat's site has no panel, there is no such order in it, or the
// number matches more than one order. Never throws: the header just goes without
// the line.
export async function loadOrderFacts(
  orderId: string | null | undefined,
  trackerBusinessId: string | null | undefined,
  source: OrderFacts['source'],
): Promise<OrderFacts | null> {
  // No panel, no line: an order number alone could be another store's.
  if (!orderId || !trackerBusinessId) return null;
  try {
    const { rows } = await query<FactsRow>(
      `SELECT o.order_id, o.tracking_status, o.is_cancelled, o.created_at, o.status_updated_at,
              o.estimated_delivery, o.state, o.city, o.delivered_at, b.origin_city
         FROM orders o
         LEFT JOIN businesses b ON b.id = o.business_id
        WHERE o.order_id = $1
          AND o.business_id::text = $2::text
        LIMIT 2`,
      [orderId, trackerBusinessId]
    );
    if (rows.length !== 1) return null;
    const row = rows[0];
    const journey = buildJourney(row as unknown as JourneyOrder);
    return {
      order_id: row.order_id,
      source,
      placed_on: iso(row.created_at),
      status: journey.currentLabel,
      mode: journey.mode,
      delivered: journey.delivered,
      eta: journey.eta,
      eta_estimated: journey.etaEstimated,
    };
  } catch (err) {
    console.error('[chat/order-facts] loadOrderFacts error:', err);
    return null;
  }
}
