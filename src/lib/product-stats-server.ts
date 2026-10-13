import { query, queryOne } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import {
  groupLines, parseSetup, productLines, rangeDays, rangeOf, setupKey, totalsOf, watchLines,
  type GroupLine, type ItemRow, type ProductGroup, type ProductLine, type ProductSetup, type RangeKey, type Totals,
} from './product-stats';

// ── Shopify tab, the database side (owner 2026-10-13; rules in product-stats.ts) ─────────────────────────────────
// Read only, except the panel's own collections / watch list (chat_settings key product_setup:<panel id>, JSON; no
// SQL file: the table exists, tracker_user may SELECT / INSERT / UPDATE it). The order lines are the panel's own
// (order_items.business_id, order-items-panel.sql), of its not-cancelled orders placed in the range.
const COD_SQL = `(lower(COALESCE(o.payment_method, '')) = 'cod' OR lower(COALESCE(o.payment_method, '')) LIKE '%cash on delivery%')`;
export const LINES_MAX = 60_000;

export async function loadSetup(businessId: string): Promise<ProductSetup> {
  try {
    const row = await queryOne<{ value: string }>(`SELECT value FROM chat_settings WHERE key = $1`, [setupKey(businessId)]);
    return parseSetup(row?.value);
  } catch (e) { console.error('[product-stats] setup read:', (e as Error).message); return { groups: [], watch: [] }; }
}

export async function saveSetup(businessId: string, setup: ProductSetup, user: AuthUser): Promise<void> {
  await query(
    `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [setupKey(businessId), JSON.stringify(setup)]);
  console.log(`[product-stats] panel=${businessId} collections=${setup.groups.length} watch=${setup.watch.length} by ${user.username}`);
}

export interface ProductStats {
  range: { range: RangeKey; from: string; to: string; label: string; days: string };
  at: string;              // when this answer was read
  totals: Totals;          // every not-cancelled order of the range that has lines
  cancelled: number;       // cancelled orders placed in the range (not counted anywhere above)
  products: ProductLine[];
  groups: GroupLine[];
  watch: ProductLine[];
  setup: { groups: ProductGroup[]; watch: string[] };
  capped: boolean;
}

export async function loadProductStats(businessId: string, opts: { range?: string | null; from?: string | null; to?: string | null; now?: number }): Promise<ProductStats> {
  const r = rangeOf(opts.range, opts.now ?? Date.now(), opts.from, opts.to);
  const from = new Date(r.from).toISOString(), to = new Date(r.to).toISOString();
  const [lines, cancelled, setup] = await Promise.all([
    query<{ order: string; product_name: string | null; quantity: number | null; price: unknown; cod: boolean; at: unknown }>(
      `SELECT o.id::text AS "order", oi.product_name, oi.quantity, oi.price, ${COD_SQL} AS cod,
              (extract(epoch FROM o.created_at) * 1000)::float8 AS at
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.order_id AND oi.business_id IS NOT DISTINCT FROM o.business_id
        WHERE o.business_id::text = $1::text AND o.created_at >= $2 AND o.created_at < $3
          AND COALESCE(o.is_cancelled, false) = false
        LIMIT ${LINES_MAX + 1}`,
      [businessId, from, to]).then((x) => x.rows),
    queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders o
        WHERE o.business_id::text = $1::text AND o.created_at >= $2 AND o.created_at < $3 AND COALESCE(o.is_cancelled, false) = true`,
      [businessId, from, to]).then((x) => Number(x?.n) || 0).catch(() => 0),
    loadSetup(businessId),
  ]);
  const capped = lines.length > LINES_MAX;
  const rows: ItemRow[] = lines.slice(0, LINES_MAX).filter((l) => l.product_name)
    .map((l) => ({ order: l.order, product_name: String(l.product_name), quantity: Number(l.quantity) || 1, price: Number(l.price) || 0, cod: l.cod === true, at: l.at == null ? undefined : Number(l.at) }));
  const products = productLines(rows);
  return {
    range: { range: r.range, from, to, label: r.label, days: rangeDays(r.from, r.to) }, at: new Date().toISOString(),
    totals: totalsOf(rows), cancelled,
    products, groups: groupLines(setup.groups, rows, products), watch: watchLines(setup.watch, products),
    setup, capped,
  };
}
