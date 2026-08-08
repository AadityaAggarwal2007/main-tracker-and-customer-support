import { CSV_COLUMN_MAP } from './constants';

export interface CleanedOrder {
  order_id: string;
  shopify_id: string;
  payment_method: string;
  financial_status: string;
  customer_name: string;
  customer_email: string;
  customer_mobile: string;
  address_line1: string;
  address_line2: string;
  address_line3: string;
  city: string;
  state: string;
  pincode: string;
  is_cancelled: boolean;
  order_total: number;
  created_at: string; // original Shopify order date e.g. "2026-08-04 11:44:25 +0530"
  items: CleanedItem[];
}

export interface CleanedItem {
  brand: string;
  product_name: string;
  quantity: number;
  price: number;
}

function normalizePhone(phone: string): string {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.length > 10 && cleaned.startsWith('91')) {
    cleaned = cleaned.slice(2);
  }
  return cleaned.slice(-10);
}

function cleanString(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

// Strip decorative/corrupted unicode symbols from product names
// Removes geometric shapes (◆◇▲▼), enclosed alphanumerics, dingbats, etc.
function cleanProductName(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/[\u2500-\u27FF]/g, '')  // Box Drawing, Geometric Shapes, Misc Symbols
    .replace(/[\u2E80-\u2EFF]/g, '')  // CJK Radicals
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Emojis / pictographs
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanCSVData(rawRows: Record<string, string>[]): {
  orders: CleanedOrder[];
  stats: { total: number; unique: number; multiItem: number; cancelled: number };
} {
  const orderMap = new Map<string, CleanedOrder>();

  for (const row of rawRows) {
    const orderId = cleanString(row[CSV_COLUMN_MAP.order_id]);
    if (!orderId) continue;

    const item: CleanedItem = {
      brand: cleanString(row[CSV_COLUMN_MAP.brand]),
      product_name: cleanProductName(row[CSV_COLUMN_MAP.product_name]),
      quantity: parseInt(cleanString(row[CSV_COLUMN_MAP.quantity])) || 1,
      price: parseFloat(cleanString(row[CSV_COLUMN_MAP.price])) || 0,
    };

    if (orderMap.has(orderId)) {
      // Multi-line-item order — just add the item
      // Don't re-sum total — we already grabbed the correct Shopify total
      const existing = orderMap.get(orderId)!;
      existing.items.push(item);
    } else {
      // New order
      const customerName =
        cleanString(row[CSV_COLUMN_MAP.customer_name]) ||
        cleanString(row[CSV_COLUMN_MAP.customer_name_fallback]) ||
        'Unknown';

      const phone =
        normalizePhone(cleanString(row[CSV_COLUMN_MAP.phone])) ||
        normalizePhone(cleanString(row[CSV_COLUMN_MAP.billing_phone]));

      const paymentMethod = cleanString(row[CSV_COLUMN_MAP.payment_method]);
      const cancelledAt = cleanString(row[CSV_COLUMN_MAP.cancelled_at]);

      // ═══ FIX: Use Shopify's "Total" column (actual order total with discounts) ═══
      // Fall back to line item price only if Total column is missing
      const shopifyTotal = parseFloat(cleanString(row[CSV_COLUMN_MAP.order_total])) || 0;
      const orderTotal = shopifyTotal > 0 ? shopifyTotal : item.price * item.quantity;

      const order: CleanedOrder = {
        order_id: orderId,
        shopify_id: cleanString(row[CSV_COLUMN_MAP.shopify_id]),
        payment_method: paymentMethod || 'COD',
        financial_status: cleanString(row[CSV_COLUMN_MAP.financial_status]) || 'paid',
        customer_name: customerName,
        customer_email: cleanString(row[CSV_COLUMN_MAP.email]),
        customer_mobile: phone,
        address_line1: cleanString(row[CSV_COLUMN_MAP.address_line1]),
        address_line2: cleanString(row[CSV_COLUMN_MAP.address_line2]),
        address_line3: cleanString(row[CSV_COLUMN_MAP.address_line3]),
        city: cleanString(row[CSV_COLUMN_MAP.city]),
        state: cleanString(row[CSV_COLUMN_MAP.state]),
        pincode: cleanString(row[CSV_COLUMN_MAP.pincode]),
        is_cancelled: !!cancelledAt,
        order_total: orderTotal,
        created_at: cleanString(row[CSV_COLUMN_MAP.created_at]),
        items: [item],
      };

      orderMap.set(orderId, order);
    }
  }

  const allOrders = Array.from(orderMap.values());

  // ── Filter out zero-price orders (free/test orders, continuation rows) ──
  const orders = allOrders.filter((o) => o.order_total > 0);
  const skipped = allOrders.length - orders.length;
  const cancelled = orders.filter((o) => o.is_cancelled).length;

  return {
    orders,
    stats: {
      total: rawRows.length,
      unique: orders.length,
      multiItem: orders.filter((o) => o.items.length > 1).length,
      cancelled,
      skipped,  // zero-price orders skipped
    },
  };
}
