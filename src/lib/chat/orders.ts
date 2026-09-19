import { query } from '@/lib/db';

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
function escapeRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeOrderId(orderId?: string | null): string | null {
  if (!orderId) return null;
  const trimmed = orderId.trim();
  // Accept with or without # prefix
  if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
  if (trimmed.startsWith('#')) return trimmed;
  return trimmed;
}

export interface OrderLookupArgs {
  order_id?: string;
  email?: string;
  phone?: string;
  phone_last4?: string;
  name?: string;
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

// Look up an order by order_id, email, phone, or last 4 digits of phone.
// trackerBusinessId scopes the lookup to one panel's orders.
export async function lookupOrder(
  { order_id, email, phone, phone_last4, name }: OrderLookupArgs,
  trackerBusinessId?: string | null
): Promise<OrderLookupResult> {
  const normalizedOrderId = normalizeOrderId(order_id);
  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = email ? email.toLowerCase().trim() : null;
  const normalizedName = name ? name.trim() : null;

  // Last-4 is only ever taken from an explicit phone_last4. Deriving it from a
  // full phone number used to OR it into the query, so a customer who gave their
  // real number also matched every stranger whose number ended the same way —
  // 4,783 of 7,946 orders sit in colliding last-4 groups, and one customer was
  // shown another's order because of it. On its own it identifies nobody, so it
  // is honoured only alongside a name.
  const rawLast4 = phone_last4 ? phone_last4.replace(/\D/g, '').slice(-4) : null;
  const last4 = rawLast4 && rawLast4.length === 4 && normalizedName ? rawLast4 : null;

  // Email and phone identify one person. A name does not: it is matched as a
  // substring, so "Raj" pulled back Suraj PATIL and Rajan, and "a" pulled back
  // 7,312 of 7,946 orders. Because the clauses used to be OR'd, a customer who
  // mistyped their phone still matched on name alone and was shown a stranger's
  // order. A strong identifier, once given, now has to match.
  const hasStrongIdentifier = Boolean(normalizedEmail || normalizedPhone);
  const hasPersonalIdentifier = Boolean(hasStrongIdentifier || last4 || normalizedName);

  if (normalizedName && !hasStrongIdentifier && !last4 && !normalizedOrderId) {
    return {
      found: false,
      needs_verification: true,
      message: 'A name on its own matches many different customers. Ask for the email or phone number on the order, then look up again.',
    };
  }

  if (rawLast4 && !normalizedName && !normalizedEmail && !normalizedPhone) {
    return {
      found: false,
      needs_verification: true,
      message: 'Last 4 digits alone match many different customers. Ask for the name on the order and look up again with both.',
    };
  }

  if (!normalizedOrderId && !hasPersonalIdentifier) {
    return { found: false, message: 'Please provide a name, last 4 digits of phone, email, or order ID.' };
  }

  // Order IDs are sequential and guessable, so one on its own is not proof of ownership.
  if (!hasPersonalIdentifier) {
    return {
      found: false,
      needs_verification: true,
      message: 'An order number alone is not enough to confirm identity. Ask the customer for the name, email, or last 4 digits of the phone number on the order, then look up again with both.',
    };
  }

  try {
    const result = await query<OrderRow>(
      `SELECT
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
       LEFT JOIN businesses b ON b.id = o.business_id
       WHERE ($1::text IS NULL OR o.order_id ILIKE $1)
       -- If an email or phone was supplied it must match. Previously these were
       -- OR'd with the name, so a wrong number was silently ignored.
       AND (
         ($2::text IS NULL AND $3::text IS NULL)
         OR ($2::text IS NOT NULL AND LOWER(o.customer_email) = $2)
         OR ($3::text IS NOT NULL AND o.customer_mobile = $3)
       )
       AND ($5::text IS NULL OR RIGHT(o.customer_mobile, 4) = $5)
       -- Name only ever narrows, and matches at a word start so "Raj" no longer
       -- matches "Suraj".
       AND ($6::text IS NULL OR o.customer_name ~* ('(^|[[:space:]])' || $6))
       -- The panel id arrives from sites.tracker_business_id, which is text on
       -- the chat side while orders.business_id is uuid, so both are compared
       -- as text rather than casting the parameter and risking a type error.
       AND ($4::text IS NULL OR o.business_id::text = $4::text)
       GROUP BY
         o.order_id, o.customer_name, o.customer_email, o.customer_mobile,
         o.tracking_status, o.tracking_id, o.tracking_token, o.courier_partner, o.estimated_delivery,
         o.order_total, o.city, o.state, o.created_at, o.is_cancelled,
         o.payment_method, b.name, b.tracking_domain
       ORDER BY o.created_at DESC
       LIMIT 3`,
      [
        normalizedOrderId ? escapeLike(normalizedOrderId) : null,
        normalizedEmail,
        normalizedPhone,
        trackerBusinessId || null,
        last4,
        normalizedName ? escapeRegex(normalizedName) : null,
      ]
    );

    if (result.rows.length === 0) {
      return {
        found: false,
        message: 'No order found with those details. Please double-check the order ID or try your registered email/phone.',
      };
    }

    const TRACKER_BASE = process.env.TRACKING_BASE_URL || 'https://shiptrack.store';

    const orders: FoundOrder[] = result.rows.map((row) => {
      const trackingBase = (row.business_tracking_domain || TRACKER_BASE).replace(/\/+$/, '');
      const trackingLink = row.tracking_token
        ? `${trackingBase}/track/${row.tracking_token}`
        : null;

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
        estimated_delivery: row.estimated_delivery || null,
        total: row.order_total,
        products: row.products || [],
        placed_on: row.created_at,
        store: row.business_name,
        cancelled: row.is_cancelled,
        payment: paymentDisplay,
      };
    });

    return { found: true, count: orders.length, orders };
  } catch (err) {
    console.error('[chat/orders] lookupOrder error:', err);
    return { found: false, message: 'Could not look up order right now. Please try again in a moment.' };
  }
}
