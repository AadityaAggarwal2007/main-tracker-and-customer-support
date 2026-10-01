import { query } from './db';
import type { AuthUser } from './auth';

// Which of these ORDER NUMBERS a login may act on: all of them for someone with every panel,
// else only those that have an order in one of their panels (src/lib/permissions.ts). Order
// numbers can repeat across panels, so the caller still limits its UPDATE / DELETE to the
// login's panels with panelFilterSql.
export async function orderNumbersInScope(user: AuthUser, orderIds: string[]): Promise<string[]> {
  if (!user.businessIds || user.businessIds.length === 0) return orderIds;
  if (!orderIds.length) return [];
  const r = await query<{ order_id: string }>(
    `SELECT DISTINCT order_id FROM orders WHERE order_id = ANY($1::text[]) AND business_id::text = ANY($2::text[])`,
    [orderIds, user.businessIds]
  );
  const ok = new Set(r.rows.map((x) => x.order_id));
  return orderIds.filter((id) => ok.has(id));
}
