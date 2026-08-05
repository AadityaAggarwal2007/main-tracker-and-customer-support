import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';

// GET - get unique brands from order_items
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await query<{ brand: string }>(
    `SELECT DISTINCT brand FROM order_items
     WHERE brand IS NOT NULL AND brand != ''
     ORDER BY brand ASC`
  );

  return NextResponse.json({ brands: result.rows.map(r => r.brand) });
}
