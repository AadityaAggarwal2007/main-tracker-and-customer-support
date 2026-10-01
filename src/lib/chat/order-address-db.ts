// The chat's order address for staff (see order-address.ts). Server only.
import { query } from '@/lib/db';
import type { OrderAddress } from './order-address';

export interface StaffOrderAddress extends OrderAddress {
  order_id: string;
  // When and by whom the team last changed it here (null = as it came from Shopify / the CSV).
  edited_at: string | null;
  edited_by: string | null;
}

interface AddressRow {
  order_id: string; address_line1: string | null; address_line2: string | null; city: string | null;
  state: string | null; pincode: string | null; address_edited_at?: string | Date | null; address_edited_by?: string | null;
}

export const toAddress = (r: Pick<AddressRow, 'address_line1' | 'address_line2' | 'city' | 'state' | 'pincode'>): OrderAddress => ({
  line1: r.address_line1 || '', line2: r.address_line2 || '', city: r.city || '', state: r.state || '', pincode: r.pincode || '',
});

// The order inside the chat's own panel; null when there is no panel, no such order, or more than one.
// Never throws: the header just goes without the address.
export async function loadOrderAddress(
  orderId: string | null | undefined,
  trackerBusinessId: string | null | undefined,
): Promise<StaffOrderAddress | null> {
  if (!orderId || !trackerBusinessId) return null;
  const sql = (edited: boolean) => `SELECT order_id, address_line1, address_line2, city, state, pincode${edited ? ', address_edited_at, address_edited_by' : ''}
       FROM orders
      WHERE order_id = $1 AND business_id::text = $2::text
      LIMIT 2`;
  try {
    // Before order-address-edit.sql the two address_edited_* columns are missing: read without them.
    const { rows } = await query<AddressRow>(sql(true), [orderId, trackerBusinessId])
      .catch((err) => { if (err?.code === '42703') return query<AddressRow>(sql(false), [orderId, trackerBusinessId]); throw err; });
    if (rows.length !== 1) return null;
    const r = rows[0];
    const at = r.address_edited_at ? new Date(r.address_edited_at) : null;
    return {
      order_id: r.order_id,
      ...toAddress(r),
      edited_at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
      edited_by: r.address_edited_by ?? null,
    };
  } catch (err) {
    console.error('[chat/order-address] load error:', (err as Error)?.message);
    return null;
  }
}
