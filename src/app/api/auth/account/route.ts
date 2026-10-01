import { NextRequest, NextResponse } from 'next/server';
import {
  checkEnvPassword, envSuperAdmin, getAuthFromRequest, hashPassword, readSuperAdminRow,
  refreshTeamCache, setSuperAdminCache, superAdminSession, verifyPassword,
} from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { isSuperAdmin } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

// ── The owner's own login (super admin), 2026-10-01 ────────────
// Owner: "admin panel ka id password update karne ka option ... sab staff ke paas hai".
// GET: the username and when it was last changed here. POST: a new username and / or password,
// after the current password. Saved in admin_login (admin-login.sql); from then on the .env login
// no longer works, every super-admin login made before (staff phones too) is refused from its
// next request (session_version + 1, src/lib/auth.ts), and this answer carries a fresh login for
// the owner's own screen. signOutTeam: every team member is signed out too (owner: "sabke system
// logout"). POST { action: 'signOutEveryone' }: the same sign-out without a new password, once the
// login was changed here (before that the staff know the password and would sign right back in).
// Never logged or answered: the passwords.

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

// Wrong current passwords: 5 per 15 minutes, so a stolen login cannot guess the password here
// and lock the owner out. In memory (one server process).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const g = globalThis as unknown as { __shiptrackAccountFails?: { n: number; until: number } };

// Every team member's logins stop working at once (their own passwords still work to sign in again).
async function signOutTeam(): Promise<number> {
  const r = await query(`UPDATE team_users SET session_version = session_version + 1, updated_at = now()`);
  await refreshTeamCache(true);
  return r.rowCount ?? 0;
}

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the super admin can see this' }, { status: 403 });
  let row = null;
  try { row = await readSuperAdminRow(); } catch { /* answer with what the login says */ }
  const team = await queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM team_users`).catch(() => null);
  return NextResponse.json({
    username: row?.username ?? user!.username, changedAt: row?.updated_at ?? null, savedInPanel: !!row,
    teamCount: Number(team?.n ?? 0),
  });
}

// Signs out every device (the team and every other owner login) and gives this screen a fresh login.
async function signOutEveryone() {
  let row;
  try { row = await readSuperAdminRow(); } catch {
    return NextResponse.json({ error: 'Could not check your login. Try again in a minute.' }, { status: 503 });
  }
  if (!row) {
    return NextResponse.json({ error: 'Change your login first: the old one is known to the staff, so they could sign right back in.' }, { status: 409 });
  }
  try {
    const saved = await queryOne<{ username: string; session_version: number }>(
      `UPDATE admin_login SET session_version = session_version + 1 WHERE id = 1 RETURNING username, session_version`
    );
    if (!saved) throw new Error('no row');
    setSuperAdminCache({ username: saved.username, sv: saved.session_version });
    const team = await signOutTeam();
    console.log(`[auth] everyone signed out by the owner (${team} team members)`);
    const session = superAdminSession(saved.username, saved.session_version);
    return NextResponse.json({ token: session.token, user: session.user, teamSignedOut: team });
  } catch (err) {
    console.error('[auth] sign out everyone failed:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not sign everyone out. Try again.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the super admin can change this login' }, { status: 403 });

  let raw: { action?: unknown; currentPassword?: unknown; username?: unknown; newPassword?: unknown; signOutTeam?: unknown };
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (raw.action === 'signOutEveryone') return signOutEveryone();

  const fails = g.__shiptrackAccountFails;
  if (fails && fails.until > Date.now() && fails.n >= MAX_FAILS) {
    return NextResponse.json({ error: 'Too many wrong tries. Please wait 15 minutes and try again.' }, { status: 429 });
  }
  const current = typeof raw.currentPassword === 'string' ? raw.currentPassword : '';
  const wantUsername = typeof raw.username === 'string' ? raw.username.trim() : null;
  const wantPassword = typeof raw.newPassword === 'string' && raw.newPassword !== '' ? raw.newPassword : null;
  if (!current) return NextResponse.json({ error: 'Type your current password' }, { status: 400 });

  let row;
  try { row = await readSuperAdminRow(); } catch {
    return NextResponse.json({ error: 'Could not check your login. Try again in a minute.' }, { status: 503 });
  }
  const env = envSuperAdmin();
  const nowUsername = row ? row.username : (env?.username ?? user!.username);
  const currentOk = row ? verifyPassword(row.password_hash, current) : checkEnvPassword(current);
  if (!currentOk) {
    const f = g.__shiptrackAccountFails;
    g.__shiptrackAccountFails = !f || f.until < Date.now() ? { n: 1, until: Date.now() + WINDOW_MS } : { n: f.n + 1, until: f.until };
    return NextResponse.json({ error: 'Your current password is not right' }, { status: 400 });
  }
  g.__shiptrackAccountFails = undefined;

  let username = nowUsername;
  if (wantUsername !== null && wantUsername.toLowerCase() !== nowUsername.toLowerCase()) {
    const u = wantUsername.toLowerCase();
    if (!USERNAME_RE.test(u)) {
      return NextResponse.json({ error: 'Username: 3-32 small letters, numbers, dot, dash or underscore' }, { status: 400 });
    }
    const clash = await queryOne(`SELECT 1 FROM team_users WHERE lower(username) = $1`, [u]);
    if (clash) return NextResponse.json({ error: 'A team member already has that username' }, { status: 409 });
    username = u;
  }
  if (wantPassword !== null) {
    if (wantPassword.length < MIN_PASSWORD) return NextResponse.json({ error: `New password: at least ${MIN_PASSWORD} characters` }, { status: 400 });
    if (wantPassword.length > MAX_PASSWORD) return NextResponse.json({ error: 'New password is too long' }, { status: 400 });
    if (wantPassword === current) return NextResponse.json({ error: 'That is your current password. Type a new one.' }, { status: 400 });
    if (wantPassword.toLowerCase().includes(username.toLowerCase())) {
      return NextResponse.json({ error: 'The password must not contain the username' }, { status: 400 });
    }
  }
  if (username === nowUsername && wantPassword === null) {
    return NextResponse.json({ error: 'Nothing changed: type a new username or a new password' }, { status: 400 });
  }

  // Only the username changes: keep the saved password (the first time, the .env one, hashed).
  const hash = wantPassword !== null ? hashPassword(wantPassword) : row ? row.password_hash : hashPassword(current);
  try {
    const saved = await queryOne<{ username: string; session_version: number; updated_at: string }>(
      `INSERT INTO admin_login (id, username, password_hash, session_version, updated_at, updated_by)
       VALUES (1, $1, $2, 2, now(), $3)
       ON CONFLICT (id) DO UPDATE
          SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash,
              session_version = admin_login.session_version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING username, session_version, updated_at`,
      [username, hash, user!.username]
    );
    if (!saved) throw new Error('no row');
    setSuperAdminCache({ username: saved.username, sv: saved.session_version });
    // The login is saved; a failed team sign-out only means the team stays signed in (said in the answer).
    let teamSignedOut: number | null = null;
    if (raw.signOutTeam === true) {
      try { teamSignedOut = await signOutTeam(); } catch (err) { console.error('[auth] team sign-out failed:', (err as Error)?.message); }
    }
    console.log(`[auth] super admin login changed (username ${saved.username !== nowUsername ? 'changed' : 'same'}, password ${wantPassword !== null ? 'changed' : 'same'}, team signed out: ${teamSignedOut ?? 'no'})`);
    const session = superAdminSession(saved.username, saved.session_version);
    return NextResponse.json({ token: session.token, user: session.user, username: saved.username, changedAt: saved.updated_at, teamSignedOut });
  } catch (err) {
    console.error('[auth] super admin login change failed:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not save. Your old login still works.' }, { status: 500 });
  }
}
