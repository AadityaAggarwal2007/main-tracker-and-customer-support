// The chat's order items for staff (see order-items.ts). Server only.
import { query } from '@/lib/db';
import { priceOf, type OrderItem } from './order-items';

export interface StaffOrderItem extends OrderItem {
  id: string;
}

export interface StaffOrderItems {
  order_id: string;
  // The order's rows, oldest first (the team's order after an edit).
  items: StaffOrderItem[];
  // When and by whom the team last changed them here (null = as they came from Shopify / the CSV).
  edited_at: string | null;
  edited_by: string | null;
}

interface ItemsRow {
  order_id: string;
  items: { id: string; product_name: string | null; quantity: number | null; price: unknown }[] | null;
  items_edited_at?: string | Date | null;
  items_edited_by?: string | null;
}

export const toItem = (r: { product_name: string | null; quantity: number | null; price: unknown }): OrderItem => ({
  product_name: r.product_name || '', quantity: Number(r.quantity) || 1, price: priceOf(r.price),
});

// The order inside the chat's own panel; null when there is no panel, no such order, or more than one.
// Never throws: the header just goes without the items.
export async function loadOrderItems(
  orderId: string | null | undefined,
  trackerBusinessId: string | null | undefined,
): Promise<StaffOrderItems | null> {
  if (!orderId || !trackerBusinessId) return null;
  const sql = (edited: boolean) => `SELECT o.order_id${edited ? ', o.items_edited_at, o.items_edited_by' : ''},
            COALESCE(
              json_agg(json_build_object('id', oi.id, 'product_name', oi.product_name, 'quantity', oi.quantity, 'price', oi.price)
                       ORDER BY oi.created_at, oi.id)
              FILTER (WHERE oi.id IS NOT NULL), '[]'::json
            ) AS items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.order_id = $1 AND o.business_id::text = $2::text
      GROUP BY o.id
      LIMIT 2`;
  try {
    // Before order-items-edit.sql the two items_edited_* columns are missing: read without them.
    const { rows } = await query<ItemsRow>(sql(true), [orderId, trackerBusinessId])
      .catch((err) => { if (err?.code === '42703') return query<ItemsRow>(sql(false), [orderId, trackerBusinessId]); throw err; });
    if (rows.length !== 1) return null;
    const r = rows[0];
    const at = r.items_edited_at ? new Date(r.items_edited_at) : null;
    return {
      order_id: r.order_id,
      items: (Array.isArray(r.items) ? r.items : []).map((i) => ({ id: String(i.id), ...toItem(i) })),
      edited_at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
      edited_by: r.items_edited_by ?? null,
    };
  } catch (err) {
    console.error('[chat/order-items] load error:', (err as Error)?.message);
    return null;
  }
}
