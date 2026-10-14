// ── "NC": the team changed this order's phone (owner 2026-10-14: "number change ho gaya toh ussi number sa usko
// verified kardio, aga NC likh dio ki number change kara ha fir verify kia ha") ──
// After the Edit address / phone dialog changes an order's number, the customer verifies with the NEW number (the
// order's own number, as always). Every screen that shows a verified customer then puts a small "NC" next to the
// tick, so the team knows the number on the order is not the one the customer ordered with. Read from
// order_address_changes (the dialog's history): a row whose old and new phone differ. One light read after the list /
// thread, never part of it: a missing table or a failed read means no tag. Staff only, never the AI or the widget.
import { query } from '@/lib/db';

export interface NumberChange { at: string; by: string | null }
export const ncKey = (panel: string | null | undefined, order: string | null | undefined) => `${panel ?? ''}|${order ?? ''}`;

export async function numberChanges(items: { panel: string | null | undefined; order: string | null | undefined }[]): Promise<Map<string, NumberChange>> {
  const out = new Map<string, NumberChange>();
  const want = items.filter((i) => i.panel && i.order);
  if (!want.length) return out;
  try {
    const r = await query<{ panel: string; order_id: string; created_at: Date | string; changed_by_name: string | null }>(
      `SELECT DISTINCT ON (h.business_id, h.order_id) h.business_id::text AS panel, h.order_id, h.created_at, h.changed_by_name
         FROM order_address_changes h
        WHERE h.business_id::text = ANY($1::text[]) AND h.order_id = ANY($2::text[])
          AND COALESCE(h.old_address->>'phone', '') <> ''
          AND RIGHT(regexp_replace(h.old_address->>'phone', '\\D', '', 'g'), 10)
              <> RIGHT(regexp_replace(COALESCE(h.new_address->>'phone', ''), '\\D', '', 'g'), 10)
        ORDER BY h.business_id, h.order_id, h.created_at DESC`,
      [Array.from(new Set(want.map((i) => String(i.panel)))), Array.from(new Set(want.map((i) => String(i.order))))]);
    for (const row of r.rows) {
      const at = new Date(row.created_at);
      out.set(ncKey(row.panel, row.order_id), { at: Number.isNaN(at.getTime()) ? '' : at.toISOString(), by: row.changed_by_name ?? null });
    }
  } catch (e) {
    if ((e as { code?: string })?.code !== '42P01') console.error('[number-changed] read:', (e as Error).message);
  }
  return out;
}
