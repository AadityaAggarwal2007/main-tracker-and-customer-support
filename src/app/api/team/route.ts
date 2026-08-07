import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { simpleHash } from '@/lib/auth';

// ── GET - list team users ───────────────────────────────────────
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await query(
    `SELECT id, username, display_name, role, is_active, last_login, created_at, business_ids
     FROM team_users
     ORDER BY created_at DESC`
  );

  return NextResponse.json({ users: result.rows });
}

// ── POST - create team user ─────────────────────────────────────
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { username, password, displayName, role, businessIds } = await request.json();

    if (!username || !password || !displayName || !role) {
      return NextResponse.json({ error: 'All fields required' }, { status: 400 });
    }

    if (!['admin', 'manager', 'viewer'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }

    // business_ids: null = all panels (admin), array = specific panels
    const bids = Array.isArray(businessIds) && businessIds.length > 0 ? businessIds : null;

    const data = await queryOne(
      `INSERT INTO team_users (username, password_hash, display_name, role, business_ids)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, display_name, role, is_active, created_at, business_ids`,
      [username, simpleHash(password), displayName, role, bids]
    );

    return NextResponse.json({ user: data });
  } catch (err: unknown) {
    // Unique constraint violation (username already exists)
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
      return NextResponse.json({ error: 'Username already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
  }
}

// ── PATCH - update team user ────────────────────────────────────
export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id, displayName, role, isActive, password, businessIds } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'User ID required' }, { status: 400 });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    if (displayName !== undefined) { sets.push(`display_name = $${pi++}`);   params.push(displayName); }
    if (role !== undefined)        { sets.push(`role = $${pi++}`);            params.push(role); }
    if (isActive !== undefined)    { sets.push(`is_active = $${pi++}`);       params.push(isActive); }
    if (password)                  { sets.push(`password_hash = $${pi++}`);   params.push(simpleHash(password)); }
    if (businessIds !== undefined) {
      const bids = Array.isArray(businessIds) && businessIds.length > 0 ? businessIds : null;
      sets.push(`business_ids = $${pi++}`);
      params.push(bids);
    }

    if (sets.length === 0) {
      return NextResponse.json({ success: true });
    }

    params.push(id);
    await query(`UPDATE team_users SET ${sets.join(', ')} WHERE id = $${pi}`, params);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}

// ── DELETE - delete team user ───────────────────────────────────
export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'User ID required' }, { status: 400 });
  }

  await query(`DELETE FROM team_users WHERE id = $1`, [id]);

  return NextResponse.json({ success: true });
}
