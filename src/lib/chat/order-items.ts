// ── The order's items (product / colour lines), changed by the team from Chat Support ─
// Owner, 2026-10-03: "customer na jo order kia ha woh bhi edit ho saka jaisa color and product
// edit ho saka ... upper header ma hi": like the address (order-address.ts), the thread header
// shows the order's lines and the team changes them there. STAFF ONLY: read by
// GET /api/chat/conversations/[id] and changed by PATCH .../[id]/items, both behind login and
// panel scope; never by the widget. It changes ShipTrack's copy only (order_items: Chikki's
// lookup_order and the customer's tracking page read it live), not Shopify and not the courier.
// order-items-edit.sql keeps the team's rows when Shopify or a CSV later sends the old lines,
// and logs every change in order_item_changes.
// Pure helpers (no imports), so the tests can load them.

export interface OrderItem {
  // Shopify's line name as the orders have it: "Jhumka box - Silver".
  product_name: string;
  quantity: number;
  // Per unit, 2 decimals; null = not given (the route keeps the old price of the same name, else 0).
  price: number | null;
}

export const MAX_ITEMS = 10;
export const MAX_QUANTITY = 20;
export const MAX_PRICE = 100000;
const MIN_NAME = 2;
const MAX_NAME = 120;
// The header line: about this long, then "…".
const MAX_LINE = 80;

const oneLine = (x: unknown) => String(x ?? '').replace(/\s+/g, ' ').trim();

// A price as the database or the team gives it ("1299.00", 1299, '', null) -> 1299 / null.
export function priceOf(x: unknown): number | null {
  if (x == null || x === '') return null;
  const n = typeof x === 'number' ? x : Number(String(x).trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

// What the team sent ({ items: [...] } or the list itself), tidied, or the first thing wrong with it.
export function cleanItems(raw: unknown): { items: OrderItem[] } | { error: string } {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : null;
  if (!list || list.length === 0) return { error: 'Add at least one item' };
  if (list.length > MAX_ITEMS) return { error: `At most ${MAX_ITEMS} items` };
  const items: OrderItem[] = [];
  for (let i = 0; i < list.length; i++) {
    const n = i + 1;
    const r = (list[i] && typeof list[i] === 'object' ? list[i] : {}) as Record<string, unknown>;
    const product_name = oneLine(r.product_name);
    if (product_name.length < MIN_NAME || product_name.length > MAX_NAME) {
      return { error: `Item ${n}: write the product name (${MIN_NAME}-${MAX_NAME} characters)` };
    }
    if (product_name.includes('<')) return { error: `Item ${n}: no "<" in a product name` };
    if (/https?:\/\/|www\./i.test(product_name)) return { error: `Item ${n}: no links in a product name` };
    if (/(?:\d[\s-]?){10,}/.test(product_name)) return { error: `Item ${n}: no phone numbers in a product name` };
    const qRaw = r.quantity;
    const quantity = qRaw == null || qRaw === '' ? 1 : typeof qRaw === 'number' ? qRaw : Number(String(qRaw).trim());
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return { error: `Item ${n}: quantity 1-${MAX_QUANTITY}` };
    }
    const pRaw = r.price;
    const price = priceOf(pRaw);
    if (pRaw != null && pRaw !== '' && (price === null || price < 0 || price > MAX_PRICE)) {
      return { error: `Item ${n}: price 0-${MAX_PRICE}` };
    }
    items.push({ product_name, quantity, price });
  }
  return { items };
}

const itemKey = (i: OrderItem) => `${i.product_name}\u0000${i.quantity}\u0000${i.price == null ? '' : i.price.toFixed(2)}`;

// The same lines in any order: name, quantity and price of each (null and 0 are different prices).
export function sameItems(a: OrderItem[], b: OrderItem[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(itemKey).sort();
  const kb = b.map(itemKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

// One line for the header: "Jhumka box - Silver ×2 · Earrings Set" (about 80 characters, then "…").
export function itemsLine(items: OrderItem[]): string {
  const line = items
    .map((i) => (i.quantity > 1 ? `${i.product_name} ×${i.quantity}` : i.product_name))
    .join(' · ');
  if (line.length <= MAX_LINE) return line;
  return line.slice(0, MAX_LINE - 1).replace(/[\s·]+$/, '') + '…';
}
