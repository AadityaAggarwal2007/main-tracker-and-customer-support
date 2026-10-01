import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { queryOne, withTransaction } from '@/lib/db';
import { can, canAccessPanel } from '@/lib/permissions';
import { cleanAddress, sameAddress } from '@/lib/chat/order-address';
import { toAddress } from '@/lib/chat/order-address-db';

export const dynamic = 'force-dynamic';

// ── PATCH /api/chat/conversations/:id/address ──────────────────
// The team changes the delivery address of this chat's order (owner, 2026-10-01; see
// src/lib/chat/order-address.ts). Only the order the customer VERIFIED in this chat (order ID +
// phone), only inside the chat's own panel, only for logins that may open Chat Support and change
// orders (chat.view + orders.update). ShipTrack's copy only: not Shopify, not the courier. The
// old and new address go to order_address_changes; orders.address_edited_at makes later Shopify /
// CSV / resync updates keep this address (order-address-edit.sql). The customer is told nothing.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.view') || !can(user, 'orders.update')) {
    return NextResponse.json({ error: 'You cannot change addresses' }, { status: 403 });
  }

  const conv = await queryOne<{ verified_order_id: string | null; tracker_business_id: string | null }>(
    `SELECT c.verified_order_id, s.tracker_business_id
       FROM conversations c
       JOIN sites s ON s.id = c.site_id
      WHERE c.id = $1`,
    [params.id]
  );
  if (!conv || !canAccessPanel(user, conv.tracker_business_id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!conv.verified_order_id || !conv.tracker_business_id) {
    return NextResponse.json({ error: 'Only a verified customer\'s order can be changed here (order ID + phone first)' }, { status: 409 });
  }

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const who = (user.displayName || user.username || '').trim() || user.username;

  try {
    const out = await withTransaction(async (db) => {
      const cur = await db.query<{
        id: string; order_id: string; business_id: string; address_line1: string | null; address_line2: string | null;
        city: string | null; state: string | null; pincode: string | null;
      }>(
        `SELECT id, order_id, business_id, address_line1, address_line2, city, state, pincode
           FROM orders
          WHERE order_id = $1 AND business_id::text = $2::text
          FOR UPDATE`,
        [conv.verified_order_id, conv.tracker_business_id]
      );
      if (cur.rows.length !== 1) return { status: 404, body: { error: 'The order is not in this panel' } };
      const o = cur.rows[0];
      const before = toAddress(o);
      const cleaned = cleanAddress(raw, o.state);
      if ('error' in cleaned) return { status: 400, body: { error: cleaned.error } };
      const after = cleaned.address;
      if (sameAddress(before, after)) return { status: 200, body: { unchanged: true } };

      const upd = await db.query<{ address_edited_at: string }>(
        `UPDATE orders
            SET address_line1 = $1, address_line2 = $2, city = $3, state = $4, pincode = $5,
                address_edited_at = clock_timestamp(), address_edited_by = $6, updated_at = now()
          WHERE id = $7
        RETURNING address_edited_at`,
        [after.line1, after.line2, after.city, after.state, after.pincode, who, o.id]
      );
      await db.query(
        `INSERT INTO order_address_changes (order_uuid, order_id, business_id, conversation_id, old_address, new_address, changed_by, changed_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [o.id, o.order_id, o.business_id, params.id, JSON.stringify(before), JSON.stringify(after), user.username, who]
      );
      return {
        status: 200,
        body: { address: { order_id: o.order_id, ...after, edited_at: new Date(upd.rows[0].address_edited_at).toISOString(), edited_by: who } },
      };
    });
    return NextResponse.json(out.body, { status: out.status });
  } catch (err) {
    console.error('[chat/address] PATCH error:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not save the address' }, { status: 500 });
  }
}
