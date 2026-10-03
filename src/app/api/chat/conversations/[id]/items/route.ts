import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { queryOne, withTransaction } from '@/lib/db';
import { can, canAccessPanel } from '@/lib/permissions';
import { cleanItems, sameItems, type OrderItem } from '@/lib/chat/order-items';
import { toItem } from '@/lib/chat/order-items-db';

export const dynamic = 'force-dynamic';

// ── PATCH /api/chat/conversations/:id/items ────────────────────
// The team changes the items (product / colour lines) of this chat's order (owner, 2026-10-03; see
// src/lib/chat/order-items.ts). Only the order the customer VERIFIED in this chat (order ID +
// phone), only inside the chat's own panel, only for logins that may open Chat Support and change
// orders (chat.view + orders.update). ShipTrack's copy only: not Shopify, not the courier. The
// order's order_items rows are replaced by the new lines inside one transaction; the old and new
// lines go to order_item_changes; orders.items_edited_at makes a later Shopify webhook / CSV upload
// keep these rows (trigger in order-items-edit.sql; SET LOCAL app.team_items_edit lets this edit
// through it). The customer is told nothing.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.view') || !can(user, 'orders.update')) {
    return NextResponse.json({ error: 'You cannot change order items' }, { status: 403 });
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
      const cur = await db.query<{ id: string; order_id: string; business_id: string }>(
        `SELECT id, order_id, business_id
           FROM orders
          WHERE order_id = $1 AND business_id::text = $2::text
          FOR UPDATE`,
        [conv.verified_order_id, conv.tracker_business_id]
      );
      if (cur.rows.length !== 1) return { status: 404, body: { error: 'The order is not in this panel' } };
      const o = cur.rows[0];
      const old = await db.query<{ id: string; brand: string | null; product_name: string | null; quantity: number | null; price: unknown }>(
        `SELECT id, brand, product_name, quantity, price
           FROM order_items
          WHERE order_id = $1
          ORDER BY created_at, id`,
        [o.order_id]
      );
      const before: OrderItem[] = old.rows.map(toItem);
      const cleaned = cleanItems(raw);
      if ('error' in cleaned) return { status: 400, body: { error: cleaned.error } };
      // A line sent without a price keeps the old price of the same name, else 0 (the column's default).
      const key = (s: string) => s.toLowerCase();
      const after: OrderItem[] = cleaned.items.map((i) => ({
        ...i,
        price: i.price ?? before.find((b) => key(b.product_name) === key(i.product_name))?.price ?? 0,
      }));
      if (sameItems(before, after)) return { status: 200, body: { unchanged: true } };

      // The brand stays when every old row had the same one (the Brands view groups by it).
      const brands = Array.from(new Set(old.rows.map((r) => r.brand ?? null)));
      const brand = brands.length === 1 ? brands[0] : null;

      // Our own rows pass the keep-team-items trigger for this transaction only.
      await db.query(`SET LOCAL app.team_items_edit = '1'`);
      await db.query(`DELETE FROM order_items WHERE order_id = $1`, [o.order_id]);
      // created_at steps by a millisecond per line so the rows read back in the team's order.
      const colCount = 6;
      const placeholders = after.map(
        (_, j) => `($${j * colCount + 1}, $${j * colCount + 2}, $${j * colCount + 3}, $${j * colCount + 4}, $${j * colCount + 5}, now() + ($${j * colCount + 6}::int * interval '1 millisecond'))`
      ).join(', ');
      const values: unknown[] = [];
      after.forEach((i, j) => { values.push(o.order_id, brand, i.product_name, i.quantity, i.price, j); });
      const ins = await db.query<{ id: string; product_name: string | null; quantity: number | null; price: unknown }>(
        `INSERT INTO order_items (order_id, brand, product_name, quantity, price, created_at)
         VALUES ${placeholders}
         RETURNING id, product_name, quantity, price`,
        values
      );
      const upd = await db.query<{ items_edited_at: string }>(
        `UPDATE orders
            SET items_edited_at = clock_timestamp(), items_edited_by = $1, updated_at = now()
          WHERE id = $2
        RETURNING items_edited_at`,
        [who, o.id]
      );
      await db.query(
        `INSERT INTO order_item_changes (order_uuid, order_id, business_id, conversation_id, old_items, new_items, changed_by, changed_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [o.id, o.order_id, o.business_id, params.id, JSON.stringify(before), JSON.stringify(after), user.username, who]
      );
      return {
        status: 200,
        body: {
          items: {
            order_id: o.order_id,
            items: ins.rows.map((r) => ({ id: String(r.id), ...toItem(r) })),
            edited_at: new Date(upd.rows[0].items_edited_at).toISOString(),
            edited_by: who,
          },
        },
      };
    });
    return NextResponse.json(out.body, { status: out.status });
  } catch (err) {
    console.error('[chat/items] PATCH error:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not save the items' }, { status: 500 });
  }
}
