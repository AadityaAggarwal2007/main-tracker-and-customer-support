import { NextRequest, NextResponse } from 'next/server';
import { randomInt } from 'crypto';
import { getAuthFromRequest, hashPassword, ownerUsernames, refreshTeamCache } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { ROLE_INFO, TEAM_ROLES, cleanPermissions, isSuperAdmin, resolvePermissions, type Role } from '@/lib/permissions';
import { cleanDisplayName, nameProblem } from '@/lib/team-names';

export const dynamic = 'force-dynamic';

// ── Team logins (owner, 2026-10-01) ────────────────────────────
// Only the super admin (the owner's own login) sees or changes the team. Each member gets a role,
// the panels they may use and, if wanted, their own ticks (src/lib/permissions.ts). A password is
// made here, shown ONCE in the answer for the owner to share with the login link, and only its
// scrypt hash is kept. A reset makes a new one (or takes the one the owner typed), and a new
// password or username signs the member out everywhere (session_version). A new member starts at
// a random session_version, so an old login of a removed or renamed member with the same username
// never fits them. Every change refreshes the copy auth.ts checks requests against.

const COLS = `id, username, display_name, role, is_active, last_login, created_at, business_ids, permissions, created_by, name_changed_at`;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newPassword(len = 12): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
// A password the owner typed for a member; null = fine.
function passwordProblem(p: string, username: string): string | null {
  if (p.length < MIN_PASSWORD) return `Password: at least ${MIN_PASSWORD} characters`;
  if (p.length > MAX_PASSWORD) return 'Password is too long';
  if (p.toLowerCase().includes(username.toLowerCase())) return 'The password must not contain the username';
  return null;
}

const cleanName = cleanDisplayName;
// The other members' names, so two people never share one (the owner and My profile use the same rule).
async function otherNames(exceptId: string | null): Promise<string[]> {
  const r = await query<{ display_name: string }>(`SELECT display_name FROM team_users WHERE $1::text IS NULL OR id::text <> $1::text`, [exceptId]);
  return r.rows.map((x) => x.display_name);
}
const cleanUsername = (x: unknown) => String(x ?? '').trim().toLowerCase();
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

// Saved ticks: NULL when they are exactly the role's own list, so a later change to the role's
// list reaches the member too.
function ticksFor(role: Exclude<Role, 'admin'>, raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const ticks = cleanPermissions(raw);
  const base = ROLE_INFO[role].perms;
  const same = ticks.length === base.length && base.every((p) => ticks.includes(p));
  return same ? null : ticks;
}

async function cleanPanels(raw: unknown): Promise<string[] | null | 'bad'> {
  if (raw === null || raw === undefined) return null; // every panel
  if (!Array.isArray(raw)) return 'bad';
  const ids = Array.from(new Set(raw.map(String))).filter(Boolean);
  if (!ids.length) return 'bad';
  const found = await query<{ id: string }>(`SELECT id FROM businesses WHERE id::text = ANY($1::text[])`, [ids]);
  return found.rows.length === ids.length ? ids : 'bad';
}

function shape(u: Record<string, unknown>) {
  return { ...u, effective: resolvePermissions(String(u.role), (u.permissions as string[] | null) ?? null) };
}

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the super admin can manage the team' }, { status: 403 });
  // The latest name change of each member (team-profile.sql): the owner sees what they renamed themselves to.
  const result = await query(
    `SELECT ${COLS.split(', ').map((c) => 't.' + c).join(', ')},
            n.old_name AS last_rename_from, n.changed_by AS last_rename_by, n.changed_at AS last_rename_at
       FROM team_users t
       LEFT JOIN LATERAL (SELECT old_name, changed_by, changed_at FROM team_name_changes x
                           WHERE x.user_id = t.id ORDER BY changed_at DESC LIMIT 1) n ON true
      ORDER BY t.created_at DESC`
  ).catch(() => query(`SELECT ${COLS} FROM team_users ORDER BY created_at DESC`)); // before team-profile.sql
  return NextResponse.json({ users: result.rows.map(shape), superAdmin: { username: user!.username, displayName: user!.displayName } });
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the super admin can add team members' }, { status: 403 });
  try {
    const raw = await request.json();
    const displayName = cleanName(raw.displayName);
    const username = cleanUsername(raw.username);
    const role = String(raw.role || '') as Exclude<Role, 'admin'>;
    const badName = nameProblem(displayName, await otherNames(null));
    if (badName) return NextResponse.json({ error: badName }, { status: 400 });
    if (!USERNAME_RE.test(username)) return NextResponse.json({ error: 'Username: 3-32 small letters, numbers, dot, dash or underscore' }, { status: 400 });
    if ((await ownerUsernames()).includes(username)) return NextResponse.json({ error: 'That username is taken' }, { status: 409 });
    if (!TEAM_ROLES.includes(role)) return NextResponse.json({ error: 'Pick a role' }, { status: 400 });
    const panels = await cleanPanels(raw.businessIds);
    if (panels === 'bad') return NextResponse.json({ error: 'Pick the panels again' }, { status: 400 });
    const password = newPassword();
    const row = await queryOne(
      `INSERT INTO team_users (username, password_hash, display_name, role, business_ids, permissions, created_by, session_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLS}`,
      [username, hashPassword(password), displayName, role, panels, ticksFor(role, raw.permissions), user!.username, randomInt(2, 2_000_000_000)]
    );
    await refreshTeamCache(true);
    return NextResponse.json({ user: shape(row as Record<string, unknown>), password });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
      return NextResponse.json({ error: 'That username is taken' }, { status: 409 });
    }
    console.error('team POST error:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not add the member' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the super admin can change the team' }, { status: 403 });
  try {
    const raw = await request.json();
    const id = String(raw.id || '');
    if (!id) return NextResponse.json({ error: 'Member id required' }, { status: 400 });
    const current = await queryOne<{ role: string; username: string; display_name: string }>(`SELECT role, username, display_name FROM team_users WHERE id::text = $1`, [id]);
    if (!current) return NextResponse.json({ error: 'Member not found' }, { status: 404 });

    const sets: string[] = []; const params: unknown[] = []; let pi = 1;
    let signOut = false;
    let username = current.username;
    if (raw.username !== undefined && cleanUsername(raw.username) !== current.username) {
      username = cleanUsername(raw.username);
      if (!USERNAME_RE.test(username)) return NextResponse.json({ error: 'Username: 3-32 small letters, numbers, dot, dash or underscore' }, { status: 400 });
      if ((await ownerUsernames()).includes(username)) return NextResponse.json({ error: 'That username is taken' }, { status: 409 });
      sets.push(`username = $${pi++}`); params.push(username);
      signOut = true;
    }
    const role = (raw.role !== undefined ? String(raw.role) : current.role) as Exclude<Role, 'admin'>;
    if (!TEAM_ROLES.includes(role)) return NextResponse.json({ error: 'Pick a role' }, { status: 400 });
    let renamedTo: string | null = null;
    if (raw.displayName !== undefined) {
      const name = cleanName(raw.displayName);
      if (name !== current.display_name) {
        const badName = nameProblem(name, await otherNames(id));
        if (badName) return NextResponse.json({ error: badName }, { status: 400 });
        // The owner renames any time; it does not use up the member's own once-in-15-days change.
        sets.push(`display_name = $${pi++}`); params.push(name);
        renamedTo = name;
      }
    }
    if (raw.role !== undefined) { sets.push(`role = $${pi++}`); params.push(role); }
    if (raw.permissions !== undefined || raw.role !== undefined) {
      sets.push(`permissions = $${pi++}`); params.push(ticksFor(role, raw.permissions ?? null));
    }
    if (raw.businessIds !== undefined) {
      const panels = await cleanPanels(raw.businessIds);
      if (panels === 'bad') return NextResponse.json({ error: 'Pick the panels again' }, { status: 400 });
      sets.push(`business_ids = $${pi++}`); params.push(panels);
    }
    if (raw.isActive !== undefined) { sets.push(`is_active = $${pi++}`); params.push(!!raw.isActive); }
    // A new password: ShipTrack makes one (resetPassword, answered once) or takes the one the owner
    // typed (password, not answered back: the owner has it).
    let password: string | undefined;
    if (typeof raw.password === 'string' && raw.password !== '') {
      const problem = passwordProblem(raw.password, username);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      sets.push(`password_hash = $${pi++}`); params.push(hashPassword(raw.password));
      signOut = true;
    } else if (raw.resetPassword === true) {
      password = newPassword();
      sets.push(`password_hash = $${pi++}`); params.push(hashPassword(password));
      signOut = true;
    }
    if (signOut) sets.push(`session_version = session_version + 1`);
    if (!sets.length) return NextResponse.json({ success: true });
    sets.push('updated_at = now()');
    params.push(id);
    const row = await queryOne(`UPDATE team_users SET ${sets.join(', ')} WHERE id::text = $${pi} RETURNING ${COLS}`, params);
    if (renamedTo !== null) {
      await query(`INSERT INTO team_name_changes (user_id, old_name, new_name, changed_by) VALUES ($1, $2, $3, 'owner')`, [id, current.display_name, renamedTo])
        .catch((err) => console.error('team rename log failed:', (err as Error)?.message));
    }
    await refreshTeamCache(true);
    return NextResponse.json({ user: shape(row as Record<string, unknown>), ...(password ? { password } : {}) });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
      return NextResponse.json({ error: 'That username is taken' }, { status: 409 });
    }
    console.error('team PATCH error:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the super admin can remove team members' }, { status: 403 });
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Member id required' }, { status: 400 });
  const r = await query(`DELETE FROM team_users WHERE id::text = $1`, [id]);
  await refreshTeamCache(true);
  if (!r.rowCount) return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  return NextResponse.json({ success: true });
}
