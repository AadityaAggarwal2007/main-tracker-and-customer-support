import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// ── GET all businesses ─────────────────────────────────────────
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await query(
    `SELECT * FROM businesses ORDER BY created_at ASC`
  );

  return NextResponse.json({ businesses: result.rows });
}

// ── POST create business ───────────────────────────────────────
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { name, logoUrl, supportEmail, supportPhone, isDefault } = await request.json();

    if (!name) {
      return NextResponse.json({ error: 'Business name is required' }, { status: 400 });
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await query(`UPDATE businesses SET is_default = false WHERE is_default = true`);
    }

    const data = await queryOne(
      `INSERT INTO businesses (name, logo_url, support_email, support_phone, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, logoUrl || null, supportEmail || null, supportPhone || null, isDefault || false]
    );

    return NextResponse.json({ business: data });
  } catch {
    return NextResponse.json({ error: 'Failed to create business' }, { status: 500 });
  }
}

// ── PATCH update business ──────────────────────────────────────
export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id, name, logoUrl, supportEmail, supportPhone, isDefault } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'Business ID required' }, { status: 400 });
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await query(`UPDATE businesses SET is_default = false WHERE is_default = true AND id != $1`, [id]);
    }

    // Build SET clause dynamically (only update provided fields)
    const sets: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    if (name !== undefined)         { sets.push(`name = $${pi++}`);          params.push(name); }
    if (logoUrl !== undefined && logoUrl !== null && logoUrl !== '')
                                    { sets.push(`logo_url = $${pi++}`);      params.push(logoUrl); }
    if (supportEmail !== undefined) { sets.push(`support_email = $${pi++}`); params.push(supportEmail); }
    if (supportPhone !== undefined) { sets.push(`support_phone = $${pi++}`); params.push(supportPhone); }
    if (isDefault !== undefined)    { sets.push(`is_default = $${pi++}`);    params.push(isDefault); }

    if (sets.length === 0) {
      return NextResponse.json({ success: true });
    }

    params.push(id);
    await query(`UPDATE businesses SET ${sets.join(', ')} WHERE id = $${pi}`, params);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}

// ── DELETE business ────────────────────────────────────────────
export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Business ID required' }, { status: 400 });
  }

  // Nullify any orders pointing to this business
  await query(`UPDATE orders SET business_id = NULL WHERE business_id = $1`, [id]);
  await query(`DELETE FROM businesses WHERE id = $1`, [id]);

  return NextResponse.json({ success: true });
}
