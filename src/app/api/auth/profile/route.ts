import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest, refreshTeamCache } from '@/lib/auth';
import { query, queryOne, withTransaction } from '@/lib/db';
import { ROLE_INFO, isSuperAdmin, resolvePermissions, type Role } from '@/lib/permissions';
import { NAME_CHANGE_DAYS, cleanDisplayName, nameProblem, nextNameChange } from '@/lib/team-names';

export const dynamic = 'force-dynamic';

// ── My profile (owner, 2026-10-01) ─────────────────────────────
// GET: who this login is (name, role, the panels they work on, what they can do, when they may next
// change their name). PATCH { displayName }: a team member changes their OWN display name, once every
// NAME_CHANGE_DAYS days (team-profile.sql: name_changed_at); the owner changes anyone's any time in
// Team. Passwords are not here: only the owner changes them (owner's choice). Customers never see
// these names.

interface Row {
  id: string; username: string; display_name: string; role: string; business_ids: string[] | null;
  permissions: string[] | null; name_changed_at: string | null; is_active: boolean;
}

async function panelsFor(ids: string[] | null) {
  const r = ids && ids.length
    ? await query<{ id: string; name: string }>(`SELECT id::text AS id, name FROM businesses WHERE id::text = ANY($1::text[]) ORDER BY name`, [ids])
    : await query<{ id: string; name: string }>(`SELECT id::text AS id, name FROM businesses ORDER BY name`);
  return r.rows;
}

function shape(row: Row, panels: { id: string; name: string }[]) {
  const next = nextNameChange(row.name_changed_at);
  return {
    superAdmin: false,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    roleLabel: ROLE_INFO[row.role as Exclude<Role, 'admin'>]?.label ?? row.role,
    allPanels: !row.business_ids || !row.business_ids.length,
    panels,
    permissions: resolvePermissions(row.role, row.permissions),
    nameChangedAt: row.name_changed_at,
    nextNameChangeAt: next ? next.toISOString() : null,
    nameChangeDays: NAME_CHANGE_DAYS,
  };
}

const COLS = `id, username, display_name, role, business_ids, permissions, name_changed_at, is_active`;

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (isSuperAdmin(user)) {
    return NextResponse.json({
      superAdmin: true, username: user.username, displayName: user.displayName, role: 'admin', roleLabel: 'Owner',
      allPanels: true, panels: await panelsFor(null), permissions: user.permissions,
      nameChangedAt: null, nextNameChangeAt: null, nameChangeDays: NAME_CHANGE_DAYS,
    });
  }
  const row = await queryOne<Row>(`SELECT ${COLS} FROM team_users WHERE username = $1`, [user.username]);
  if (!row || !row.is_active) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(shape(row, await panelsFor(row.business_ids)));
}

export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (isSuperAdmin(user)) return NextResponse.json({ error: 'Your name is Super Admin. Change your login in Login & security.' }, { status: 400 });

  let raw: { displayName?: unknown };
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const name = cleanDisplayName(raw.displayName);

  const me = await queryOne<Row>(`SELECT ${COLS} FROM team_users WHERE username = $1`, [user.username]);
  if (!me || !me.is_active) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (name === me.display_name) return NextResponse.json(shape(me, await panelsFor(me.business_ids)));
  const others = await query<{ display_name: string }>(`SELECT display_name FROM team_users WHERE id <> $1`, [me.id]);
  const problem = nameProblem(name, others.rows.map((o) => o.display_name));
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  try {
    const saved = await withTransaction(async (db) => {
      // The 15-day rule is checked in the same UPDATE, so two quick tries cannot both pass.
      const r = await db.query<Row>(
        `UPDATE team_users SET display_name = $1, name_changed_at = now(), updated_at = now()
          WHERE id = $2 AND is_active
            AND (name_changed_at IS NULL OR name_changed_at <= now() - make_interval(days => $3))
        RETURNING ${COLS}`,
        [name, me.id, NAME_CHANGE_DAYS]
      );
      if (!r.rows[0]) return null;
      await db.query(
        `INSERT INTO team_name_changes (user_id, old_name, new_name, changed_by) VALUES ($1, $2, $3, 'self')`,
        [me.id, me.display_name, name]
      );
      return r.rows[0];
    });
    if (!saved) {
      const next = nextNameChange(me.name_changed_at);
      return NextResponse.json({
        error: `You can change your name once every ${NAME_CHANGE_DAYS} days${next ? `; next on ${next.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}` : ''}. Ask the owner if it is urgent.`,
      }, { status: 429 });
    }
    await refreshTeamCache(true);
    return NextResponse.json(shape(saved, await panelsFor(saved.business_ids)));
  } catch (err) {
    console.error('[profile] name change failed:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not save your name' }, { status: 500 });
  }
}
