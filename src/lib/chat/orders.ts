import { query, queryOne } from '@/lib/db';
import { AUTO_DELIVER_DAY, JOURNEY, buildJourney, type JourneyOrder } from '@/lib/journey';

// ── Order lookup for the support AI ────────────────────────────
// Ported from the chat-support app's tracker-db.js. It already spoke raw SQL
// against this database; only the connection changed. The identity rules below
// are the outcome of a real privacy incident and are deliberately strict —
// read the comments before relaxing any of them.

export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/\D/g, '').replace(/^0+/, '');
  if (cleaned.startsWith('91') && cleaned.length > 10) {
    const stripped = cleaned.slice(2);
    if (stripped.length === 10) return stripped;
  }
  return cleaned.slice(-10);
}

// ILIKE treats % and _ as wildcards, so an order id of "%" matched every order.
function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => '\\' + c);
}

// Names are matched with a regex, so anything the customer types must be inert.

function normalizeOrderId(orderId?: string | null): string | null {
  if (!orderId) return null;
  const trimmed = orderId.trim();
  // Accept with or without # prefix
  if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
  // Customers put a # in front of the ST… tracking ID too; tracking_id has none.
  const tracking = trimmed.match(/^#\s*(ST[A-Z0-9]{10})$/i);
  if (tracking) return tracking[1];
  if (trimmed.startsWith('#')) return trimmed;
  return trimmed;
}

// Only the order ID and the phone number on the order. Name and email are
// deliberately not accepted, and since 2026-09-30 neither is a last-4 (owner's
// rule, SHIPTRACK_MASTER_RULES.md 8.1): the proof is the order ID together with
// the FULL phone number, the same proof as the widget's verify form.
// phone_last4 is still declared because older stored tool calls carry it; a
// lookup that has only that is refused and asks for the full number.
export interface OrderLookupArgs {
  order_id?: string;
  phone_number?: string;
  phone_last4?: string;
}

export interface FoundOrder {
  order_id: string;
  customer_name: string;
  status: string;
  tracking_id: string | null;
  tracking_link: string | null;
  courier: string | null;
  estimated_delivery: string | null;
  total: number;
  products: string[];
  placed_on: string;
  store: string | null;
  cancelled: boolean;
  payment: string;
}

export type OrderLookupResult =
  | { found: true; count: number; orders: FoundOrder[] }
  | { found: false; needs_verification?: boolean; message: string };

interface OrderRow {
  order_id: string; customer_name: string; customer_email: string | null;
  customer_mobile: string | null; tracking_status: string; tracking_id: string | null;
  tracking_token: string | null; courier_partner: string | null; estimated_delivery: string | null;
  order_total: number; city: string | null; state: string | null; created_at: string;
  status_updated_at: string | null; delivered_at: string | null; origin_city: string | null;
  is_cancelled: boolean; payment_method: string | null;
  business_name: string | null; business_tracking_domain: string | null;
  products: string[] | null;
}

// The columns and joins every order read for the AI shares. The WHERE clause
// sits between ORDER_SELECT_SQL and ORDER_GROUP_SQL and is each caller's own.
const ORDER_SELECT_SQL = `SELECT
         o.order_id,
         o.customer_name,
         o.customer_email,
         o.customer_mobile,
         o.tracking_status,
         o.tracking_id,
         o.tracking_token,
         o.courier_partner,
         o.estimated_delivery,
         o.order_total,
         o.city,
         o.state,
         o.created_at,
         o.status_updated_at,
         o.delivered_at,
         o.is_cancelled,
         o.payment_method,
         b.name AS business_name,
         b.origin_city,
         b.tracking_domain AS business_tracking_domain,
         COALESCE(
           array_agg(oi.product_name ORDER BY oi.created_at)
           FILTER (WHERE oi.product_name IS NOT NULL), '{}'
         ) AS products
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.order_id
       LEFT JOIN businesses b ON b.id = o.business_id`;

const ORDER_GROUP_SQL = `GROUP BY
         o.order_id, o.customer_name, o.customer_email, o.customer_mobile,
         o.tracking_status, o.tracking_id, o.tracking_token, o.courier_partner, o.estimated_delivery,
         o.order_total, o.city, o.state, o.created_at, o.status_updated_at, o.delivered_at, o.is_cancelled,
         o.payment_method, b.name, b.tracking_domain, b.origin_city
       ORDER BY o.created_at DESC`;

// The panel id arrives from sites.tracker_business_id, which is text on the
// chat side while orders.business_id is uuid, so both are compared as text
// rather than casting the parameter and risking a type error.
const BUSINESS_SCOPE_SQL = (param: string) => `(${param}::text IS NULL OR o.business_id::text = ${param}::text)`;

// What the AI is shown about an order.
function toFoundOrder(row: OrderRow): FoundOrder {
  const TRACKER_BASE = process.env.TRACKING_BASE_URL || 'https://shiptrack.store';
  const trackingBase = (row.business_tracking_domain || TRACKER_BASE).replace(/\/+$/, '');
  const trackingLink = row.tracking_token
    ? `${trackingBase}/track/${row.tracking_token}`
    : null;

  // Orders created by the Shopify webhook never get estimated_delivery
  // written, so the agent used to say "I can't give you a delivery date".
  // The track page already falls back to the day-13 end of the window;
  // do the same here so there is always a date to quote.
  let eta: string | Date | null = row.estimated_delivery || null;
  if (!eta && row.created_at) {
    const placed = new Date(row.created_at).getTime();
    if (!Number.isNaN(placed)) {
      eta = new Date(placed + AUTO_DELIVER_DAY * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  const rawPay = (row.payment_method || '').toLowerCase();
  const isCOD = rawPay === 'cod' || rawPay.includes('cash on delivery');
  const paymentDisplay = isCOD ? 'Cash on Delivery (COD)' : 'Prepaid';

  // The stage the customer's own tracking page shows (journey.ts: the stored status,
  // moved forward by the order's age, and never Delivered unless the team marked it),
  // in its plain name ("Reached City", not "Reached Surat"). Before 2026-09-30 the AI
  // read the raw stored status: it said "packed, not picked up" about an order whose
  // tracking page said it had reached the destination state. Special states (cancelled,
  // return to origin, failed) keep their stored wording.
  const journey = buildJourney(row as unknown as JourneyOrder);
  const stage = journey.mode === 'normal' && journey.currentIndex >= 0 ? JOURNEY[journey.currentIndex].status : row.tracking_status;

  return {
    order_id: row.order_id,
    customer_name: row.customer_name,
    status: stage,
    tracking_id: row.tracking_id || null,
    tracking_link: trackingLink,
    courier: row.courier_partner || null,
    estimated_delivery: eta,
    total: row.order_total,
    products: row.products || [],
    placed_on: row.created_at,
    store: row.business_name,
    cancelled: row.is_cancelled,
    payment: paymentDisplay,
  };
}

// Look up an order. The ONLY accepted identifiers are the order ID (or its
// tracking ID) AND the full phone number on the order: both, together, and the
// number must be a complete 10-digit one (+91 and a leading 0 are ignored).
//
// Name, email and a bare last-4 were removed deliberately. Each caused a real
// problem: a name is a substring match, so "Raj" pulled back Suraj and Rajan
// and "a" matched 7,312 of 7,946 orders; last-4 on its own collides massively
// (4,783 of 7,946 orders sit in colliding last-4 groups) and once showed one
// customer another's order; and order IDs are sequential, so an order number
// alone lets anyone walk #1200, #1201, #1202 and read strangers' details.
//
// Order ID + full phone is the proof the widget's verify form uses
// (verifyOrderByPhone below). The number is compared here and never returned or
// logged by this function, so it stays out of the model's results.
//
// trackerBusinessId scopes the lookup to one panel's orders.
export async function lookupOrder(
  { order_id, phone_number }: OrderLookupArgs,
  trackerBusinessId?: string | null
): Promise<OrderLookupResult> {
  const normalizedOrderId = normalizeOrderId(order_id);
  const phoneRaw = normalizePhone(phone_number);
  const phone = phoneRaw && /^\d{10}$/.test(phoneRaw) ? phoneRaw : null;

  if (!normalizedOrderId && !phone) {
    return {
      found: false,
      needs_verification: true,
      message: 'Ask the customer for their order ID and the phone number on the order. Both are needed.',
    };
  }
  if (!normalizedOrderId) {
    return {
      found: false,
      needs_verification: true,
      message: 'A phone number alone verifies nothing. Ask for the order ID as well, then look up again with both.',
    };
  }
  if (!phone) {
    return {
      found: false,
      needs_verification: true,
      message: 'An order number alone is not proof of ownership, and neither are the last few digits of a phone. Ask for the complete phone number on the order (all 10 digits), then look up again with both.',
    };
  }

  try {
    const result = await query<OrderRow>(
      `${ORDER_SELECT_SQL}
       -- Both identifiers are mandatory (guarded above), so both are plain
       -- equality checks. The first may be the order ID or the tracking ID:
       -- customers copy the ST… tracking ID off the track page and send that.
       -- It is random rather than sequential, so it is no weaker than the
       -- order ID, and the phone check below still applies either way.
       -- customer_mobile is stored in many shapes (+91 98765 43210,
       -- 09876543210…), so it is reduced to its last 10 digits first.
       WHERE (o.order_id ILIKE $1 OR o.tracking_id ILIKE $1)
       AND RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\\D', '', 'g'), 10) = $2
       AND ${BUSINESS_SCOPE_SQL('$3')}
       ${ORDER_GROUP_SQL}
       LIMIT 3`,
      [escapeLike(normalizedOrderId), phone, trackerBusinessId || null]
    );

    if (result.rows.length === 0) {
      return {
        found: false,
        // Seen live: with the old "ask them to check both" the model just
        // asked for the details again without saying nothing had matched.
        message: 'No order matched that order ID together with that phone number. Tell the customer plainly that you could not find an order with both, and ask them to double-check the order ID and the phone number on the order.',
      };
    }

    const orders = result.rows.map(toFoundOrder);
    return { found: true, count: orders.length, orders };
  } catch (err) {
    console.error('[chat/orders] lookupOrder error:', err);
    return { found: false, message: 'Could not look up order right now. Please try again in a moment.' };
  }
}

// ── Orders a conversation has already proved it owns ───────────

// The widget's "Verify yourself" form: the order ID (or ST… tracking ID) and
// the customer's FULL phone number, which is a stronger proof than the chat's
// last 4. Returns only what the verify route needs; the number itself never
// reaches the model. Same order ID matching as lookupOrder, within one panel.
export async function verifyOrderByPhone(
  orderIdOrTracking: string | null | undefined,
  fullPhone: string | null | undefined,
  trackerBusinessId?: string | null
): Promise<{ order_id: string; customer_name: string | null } | null> {
  const normalizedOrderId = normalizeOrderId(orderIdOrTracking);
  const phone = normalizePhone(fullPhone);
  // A partial number is not a full number: exactly 10 digits or nothing.
  if (!normalizedOrderId || !phone || !/^\d{10}$/.test(phone)) return null;
  // Unlike lookupOrder, no panel means no match: a site not linked to a panel
  // must not verify (and name) some other store's order.
  if (!trackerBusinessId) return null;

  // customer_mobile is stored in many shapes (+91 98765 43210, 09876543210…),
  // so it is reduced to its last 10 digits in SQL before comparing.
  const row = await queryOne<{ order_id: string; customer_name: string | null }>(
    `SELECT o.order_id, o.customer_name
       FROM orders o
      WHERE (o.order_id ILIKE $1 OR o.tracking_id ILIKE $1)
        AND RIGHT(regexp_replace(COALESCE(o.customer_mobile, ''), '\\D', '', 'g'), 10) = $2
        AND o.business_id::text = $3::text
      ORDER BY o.created_at DESC
      LIMIT 1`,
    [escapeLike(normalizedOrderId), phone, trackerBusinessId]
  );
  return row || null;
}

// The order this conversation already verified (conversations.verified_order_id,
// set only by verifyOrderByPhone or a found lookupOrder). There is no last-4
// here because ownership was proved earlier in the same chat — never call this
// with an order ID that came from anything the customer typed.
export async function lookupVerifiedOrder(
  orderId: string,
  trackerBusinessId?: string | null
): Promise<OrderLookupResult> {
  try {
    const result = await query<OrderRow>(
      `${ORDER_SELECT_SQL}
       WHERE o.order_id = $1
       AND ${BUSINESS_SCOPE_SQL('$2')}
       ${ORDER_GROUP_SQL}
       LIMIT 2`,
      [orderId, trackerBusinessId || null]
    );
    // Order numbers repeat across panels. On a site with no panel scope, two
    // matches mean we cannot tell which one was verified, so show neither.
    if (result.rows.length !== 1) {
      return { found: false, message: 'The verified order could not be loaded.' };
    }
    return { found: true, count: 1, orders: [toFoundOrder(result.rows[0])] };
  } catch (err) {
    console.error('[chat/orders] lookupVerifiedOrder error:', err);
    return { found: false, message: 'Could not look up order right now. Please try again in a moment.' };
  }
}

// ── One chat per verified customer (conversations.customer_key) ─
// The key is the last 10 digits of the phone on the order a chat verified
// (chat-customer-key.sql). It is the same number verifyOrderByPhone compares
// with, so the form's typed phone (normalizePhone) and the order's stored
// phone reduce to the same key. It only groups a customer's chats for staff
// and lets the form carry on their chat; it never reaches the widget or the AI.

// A phone column reduced to its key: digits only, at least 10, last 10 kept.
export const phoneKeySql = (col: string) =>
  `CASE WHEN length(regexp_replace(COALESCE(${col}, ''), '\\D', '', 'g')) >= 10
        THEN RIGHT(regexp_replace(COALESCE(${col}, ''), '\\D', '', 'g'), 10) END`;

// Scalar subquery: the key of order `orderIdSql` within the panel of site
// `siteIdSql`, or NULL when the site has no panel, the order is not in it, or
// its rows do not agree on one 10-digit phone. Same rule as the backfill in
// chat-customer-key.sql.
export const customerKeyForOrderSql = (orderIdSql: string, siteIdSql: string) =>
  `(SELECT CASE WHEN count(DISTINCT k.key) = 1 THEN min(k.key) END
      FROM (SELECT ${phoneKeySql('o.customer_mobile')} AS key
              FROM orders o
              JOIN sites s ON o.business_id::text = s.tracker_business_id::text
             WHERE s.id = ${siteIdSql}
               AND o.order_id = ${orderIdSql}) k)`;
