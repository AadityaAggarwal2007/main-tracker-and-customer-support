import { query, queryOne } from '@/lib/db';
import { AUTO_DELIVER_DAY } from '@/lib/journey';

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

// Only these two. Name / email / full phone are deliberately not accepted —
// see the comment on lookupOrder.
export interface OrderLookupArgs {
  order_id?: string;
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
         o.is_cancelled,
         o.payment_method,
         b.name AS business_name,
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
         o.order_total, o.city, o.state, o.created_at, o.is_cancelled,
         o.payment_method, b.name, b.tracking_domain
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

  return {
    order_id: row.order_id,
    customer_name: row.customer_name,
    status: row.tracking_status,
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
// tracking ID) AND the last 4 digits of the phone on the order — both, together.
//
// Name, email and full phone were removed deliberately. Each caused a real
// problem: a name is a substring match, so "Raj" pulled back Suraj and Rajan
// and "a" matched 7,312 of 7,946 orders; last-4 on its own collides massively
// (4,783 of 7,946 orders sit in colliding last-4 groups) and once showed one
// customer another's order; and order IDs are sequential, so an order number
// alone lets anyone walk #1200, #1201, #1202 and read strangers' details.
//
// Order ID + last-4 together is the same rule the public /track page uses, and
// it also keeps names, emails and full numbers out of the model and the logs.
//
// trackerBusinessId scopes the lookup to one panel's orders.
export async function lookupOrder(
  { order_id, phone_last4 }: OrderLookupArgs,
  trackerBusinessId?: string | null
): Promise<OrderLookupResult> {
  const normalizedOrderId = normalizeOrderId(order_id);
  const rawLast4 = phone_last4 ? phone_last4.replace(/\D/g, '').slice(-4) : null;
  const last4 = rawLast4 && rawLast4.length === 4 ? rawLast4 : null;

  if (!normalizedOrderId && !last4) {
    return {
      found: false,
      needs_verification: true,
      message: 'Ask the customer for their order ID and the last 4 digits of the phone number on the order. Both are needed.',
    };
  }
  if (!normalizedOrderId) {
    return {
      found: false,
      needs_verification: true,
      message: 'Last 4 digits alone match many different customers. Ask for the order ID as well, then look up again with both.',
    };
  }
  if (!last4) {
    return {
      found: false,
      needs_verification: true,
      message: 'An order number alone is not proof of ownership. Ask for the last 4 digits of the phone number on the order, then look up again with both.',
    };
  }

  try {
    const result = await query<OrderRow>(
      `${ORDER_SELECT_SQL}
       -- Both identifiers are mandatory (guarded above), so both are plain
       -- equality checks. The first may be the order ID or the tracking ID:
       -- customers copy the ST… tracking ID off the track page and send that.
       -- It is random rather than sequential, so it is no weaker than the
       -- order ID, and the last-4 check below still applies either way.
       WHERE (o.order_id ILIKE $1 OR o.tracking_id ILIKE $1)
       AND RIGHT(o.customer_mobile, 4) = $2
       AND ${BUSINESS_SCOPE_SQL('$3')}
       ${ORDER_GROUP_SQL}
       LIMIT 3`,
      [escapeLike(normalizedOrderId), last4, trackerBusinessId || null]
    );

    if (result.rows.length === 0) {
      return {
        found: false,
        // Seen live: with the old "ask them to check both" the model just
        // asked for the details again without saying nothing had matched.
        message: 'No order matched that order ID together with those last 4 digits. Tell the customer plainly that you could not find an order with both, and ask them to double-check the order ID and the last 4 digits of the phone number on the order.',
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
