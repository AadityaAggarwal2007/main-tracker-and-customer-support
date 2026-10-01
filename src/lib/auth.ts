import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { NextRequest } from 'next/server';
import { queryOne, query } from './db';
import { isRole, resolvePermissions, type Permission, type Role } from './permissions';

export interface AuthUser {
  username: string;
  displayName: string;
  // 'admin' is the SUPER ADMIN only (the owner's login from the server settings); team members
  // are panel_admin / manager / agent / viewer (src/lib/permissions.ts).
  role: Role;
  businessIds: string[] | null; // null = all panels, string[] = specific panels only
  permissions: Permission[];    // what this login may do, resolved from the role and its ticks
}

// ── Login tokens ───────────────────────────────────────────────
// A token is signed, so nobody can write their own. Until 2026-09-29 tokens
// were plain base64 JSON, and anyone could make an admin token by hand.
//   v1.<base64url payload>.<base64url HMAC-SHA256 of "v1.<payload>">
// The key is AUTH_TOKEN_SECRET, which lives only in /etc/tracker/.env. Without
// it (or with a short one) no token is issued or accepted: login fails closed
// instead of falling back to unsigned tokens. Changing the secret signs
// everyone out.
const TOKEN_VERSION = 'v1';
const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function tokenSecret(): string | null {
  const secret = process.env.AUTH_TOKEN_SECRET || '';
  return secret.length >= 32 ? secret : null;
}

function signature(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

// extra: the team member's display name, their own permission ticks (null = the role's), their
// session version (a password reset bumps it, which signs that member out everywhere) and their
// row id (uid), so a new member who later gets a removed or renamed member's username never
// inherits that person's old logins. The super admin's sv is admin_login.session_version.
export function generateToken(
  username: string,
  role: string,
  businessIds: string[] | null = null,
  extra: { name?: string; perms?: string[] | null; sv?: number; uid?: string } = {},
): string {
  const secret = tokenSecret();
  if (!secret) throw new Error('AUTH_TOKEN_SECRET is missing or shorter than 32 characters; refusing to issue a login token');

  const payload = Buffer.from(
    JSON.stringify({ username, role, businessIds, exp: Date.now() + TOKEN_LIFETIME_MS, name: extra.name, perms: extra.perms ?? null, sv: extra.sv ?? 1, uid: extra.uid })
  ).toString('base64url');
  const body = `${TOKEN_VERSION}.${payload}`;
  return `${body}.${signature(body, secret).toString('base64url')}`;
}

type TokenUser = AuthUser & { sv: number; uid: string | null };

export function verifyToken(token: string): TokenUser | null {
  const secret = tokenSecret();
  if (!secret || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;

  const given = Buffer.from(parts[2], 'base64url');
  const expected = signature(`${parts[0]}.${parts[1]}`, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.username !== 'string' || !isRole(payload.role)) return null;
    return {
      username: payload.username,
      displayName: typeof payload.name === 'string' && payload.name ? payload.name : (payload.role === 'admin' ? 'Super Admin' : payload.username),
      role: payload.role,
      businessIds: Array.isArray(payload.businessIds) ? payload.businessIds : null,
      permissions: resolvePermissions(payload.role, Array.isArray(payload.perms) ? payload.perms : null),
      sv: typeof payload.sv === 'number' ? payload.sv : 1,
      uid: typeof payload.uid === 'string' && payload.uid ? payload.uid : null,
    };
  } catch {
    return null;
  }
}

// ── Passwords ──────────────────────────────────────────────────
// scrypt with a random salt per password: "s1$<salt>$<hash>". Until 2026-10-01 team passwords
// were a 32-bit string hash (simpleHash), which anyone could reverse; no team login existed then,
// and an old hash still verifies once and is replaced by scrypt at that login.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `s1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(stored: string | null | undefined, password: string): boolean {
  if (!stored) return false;
  if (stored.startsWith('s1$')) {
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash) return false;
    const want = Buffer.from(hash, 'base64');
    const got = scryptSync(password, Buffer.from(salt, 'base64'), want.length);
    return got.length === want.length && timingSafeEqual(got, want);
  }
  return stored === simpleHash(password);
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── The super admin's own login ────────────────────────────────
// Until 2026-10-01 the super admin was only ADMIN_USERNAME / ADMIN_PASSWORD in /etc/tracker/.env,
// and the whole staff knew them. The owner can now change them in the panel (Team > "Change
// username / password", /api/auth/account). That writes the one row of admin_login
// (admin-login.sql), and from then on ONLY that row is the super admin: the .env pair no longer
// logs in. Every change raises session_version, so each super-admin login made before it (on a
// staff phone too) is refused from its next request. Forgot it: scripts/admin-login-reset.js.
export interface SuperAdminRow { username: string; password_hash: string; session_version: number; updated_at: string | Date | null }

// The saved row, read fresh. null = no row yet (or admin-login.sql not applied): the .env login
// counts. Any other database error is thrown, and the callers refuse the super-admin login then.
export async function readSuperAdminRow(): Promise<SuperAdminRow | null> {
  try {
    return await queryOne<SuperAdminRow>(`SELECT username, password_hash, session_version, updated_at FROM admin_login WHERE id = 1`);
  } catch (err) {
    if ((err as { code?: string })?.code === '42P01') return null;
    throw err;
  }
}

// The .env login, used only while admin_login has no row. Its logins carry sv 1.
const ENV_SESSION_VERSION = 1;
export function envSuperAdmin(): { username: string; password: string } | null {
  const username = process.env.ADMIN_USERNAME || '';
  const password = process.env.ADMIN_PASSWORD || '';
  return username && password ? { username, password } : null;
}

// Usernames no team member may take: the super admin's, saved and .env.
export async function ownerUsernames(): Promise<string[]> {
  const out = new Set<string>();
  const env = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  if (env) out.add(env);
  try {
    const row = await readSuperAdminRow();
    if (row) out.add(row.username.toLowerCase());
  } catch { /* the .env one at least */ }
  return Array.from(out);
}

export function superAdminSession(username: string, sv: number): { user: AuthUser; token: string } {
  const user: AuthUser = { username, displayName: 'Super Admin', role: 'admin', businessIds: null, permissions: resolvePermissions('admin') };
  return { user, token: generateToken(username, 'admin', null, { name: 'Super Admin', sv }) };
}

export function checkEnvPassword(password: string): boolean {
  const env = envSuperAdmin();
  return !!env && sameText(password, env.password);
}

// ── Logins, read fresh ─────────────────────────────────────────
// A token lives 7 days, but a member who is switched off, removed, given a new password, username,
// ticks or panels must feel it at once, and so must every super-admin login after the owner
// changes his: every request checks the token against this copy of team_users and admin_login,
// reloaded every 30 seconds and right after any change (one server process: PM2 fork mode).
// Until the first load finishes, a team token's own claims count, but a super-admin token is
// refused (it may be an old one the staff still hold); /api/auth/session waits for the load, so
// the owner's screens never send him to the login page for it.
interface TeamEntry { id: string; active: boolean; role: Role; name: string; businessIds: string[] | null; permissions: string[] | null; sv: number }
interface AdminEntry { username: string; sv: number }
type TeamCache = {
  map: Map<string, TeamEntry>; loadedAt: number; loading: Promise<void> | null; timer: ReturnType<typeof setInterval> | null;
  // The saved super admin (null = no row: the .env login); adminLoadedAt 0 = not read yet. adminGen
  // goes up when the account route sets it directly, so a load that started before that change
  // cannot put the old one back.
  admin?: AdminEntry | null; adminLoadedAt?: number; adminGen?: number;
};
const g = globalThis as unknown as { __shiptrackTeam?: TeamCache };
const cache: TeamCache = g.__shiptrackTeam || (g.__shiptrackTeam = { map: new Map(), loadedAt: 0, loading: null, timer: null });

// After the owner's own change (the account route): exact, and no read that began earlier can undo it.
export function setSuperAdminCache(entry: AdminEntry | null) {
  cache.admin = entry;
  cache.adminLoadedAt = Date.now();
  cache.adminGen = (cache.adminGen ?? 0) + 1;
}

// A fresh read of admin_login (a reload or a login): used unless a change was set since it began.
function noteSuperAdminRead(gen: number, row: SuperAdminRow | null) {
  if ((cache.adminGen ?? 0) !== gen) return;
  cache.admin = row ? { username: row.username, sv: row.session_version } : null;
  cache.adminLoadedAt = Date.now();
}

// force: a load already running may have read the rows before the caller's change; wait for it
// and read again.
export async function refreshTeamCache(force = false): Promise<void> {
  if (cache.loading) {
    if (!force) return cache.loading;
    await cache.loading;
    return refreshTeamCache(false);
  }
  cache.loading = (async () => {
    const gen = cache.adminGen ?? 0;
    try {
      const r = await query<{ id: string; username: string; display_name: string; role: string; is_active: boolean; business_ids: string[] | null; permissions: string[] | null; session_version: number | null }>(
        `SELECT id, username, display_name, role, is_active, business_ids, permissions, session_version FROM team_users`
      );
      const next = new Map<string, TeamEntry>();
      for (const u of r.rows) {
        if (!isRole(u.role) || u.role === 'admin') continue; // a team member is never the super admin
        next.set(u.username, {
          id: String(u.id), active: !!u.is_active, role: u.role, name: u.display_name || u.username,
          businessIds: u.business_ids && u.business_ids.length ? u.business_ids : null,
          permissions: u.permissions, sv: u.session_version ?? 1,
        });
      }
      cache.map = next;
      cache.loadedAt = Date.now();
    } catch (err) {
      // Before team-permissions.sql is applied, or the database hiccups: keep the last copy.
      console.error('[auth] team refresh failed:', (err as Error)?.message);
    }
    try {
      noteSuperAdminRead(gen, await readSuperAdminRow());
    } catch (err) {
      console.error('[auth] super admin refresh failed:', (err as Error)?.message);
    }
  })().finally(() => { cache.loading = null; });
  if (!cache.timer) {
    cache.timer = setInterval(() => { void refreshTeamCache(); }, 30_000);
    (cache.timer as { unref?: () => void }).unref?.();
  }
  return cache.loading;
}

// For /api/auth/session: the first answer after a restart waits (up to 3 s) for the first load.
export async function authReady(timeoutMs = 3000): Promise<void> {
  if (cache.adminLoadedAt) return;
  await Promise.race([refreshTeamCache(), new Promise((r) => setTimeout(r, timeoutMs))]);
}

export async function authenticateUser(
  username: string,
  password: string
): Promise<{ user: AuthUser; token: string } | null> {
  const typed = username.trim();

  // The super admin: the login the owner saved in the panel, else (never changed yet) the .env one.
  let row: SuperAdminRow | null = null;
  let rowRead = true;
  const gen = cache.adminGen ?? 0;
  try { row = await readSuperAdminRow(); } catch { rowRead = false; } // database trouble: no super-admin login now
  if (rowRead) {
    noteSuperAdminRead(gen, row); // e.g. a reset made on the server is known from this login on
    if (row) {
      if (typed.toLowerCase() === row.username.toLowerCase() && verifyPassword(row.password_hash, password)) {
        return superAdminSession(row.username, row.session_version);
      }
    } else {
      const env = envSuperAdmin();
      if (env && sameText(typed, env.username) && sameText(password, env.password)) {
        return superAdminSession(env.username, ENV_SESSION_VERSION);
      }
    }
  }

  // Team members
  try {
    const data = await queryOne<{
      id: string; username: string; display_name: string; role: string; password_hash: string;
      business_ids: string[] | null; permissions: string[] | null; session_version: number | null;
    }>(
      `SELECT id, username, display_name, role, password_hash, business_ids, permissions, session_version
       FROM team_users
       WHERE username = $1 AND is_active = true
       LIMIT 1`,
      [typed.toLowerCase()]
    );

    if (data && isRole(data.role) && data.role !== 'admin' && verifyPassword(data.password_hash, password)) {
      const businessIds = data.business_ids && data.business_ids.length > 0 ? data.business_ids : null;
      const sv = data.session_version ?? 1;
      const user: AuthUser = {
        username: data.username,
        displayName: data.display_name,
        role: data.role,
        businessIds,
        permissions: resolvePermissions(data.role, data.permissions),
      };
      const token = generateToken(data.username, data.role, businessIds, { name: data.display_name, perms: data.permissions, sv, uid: String(data.id) });

      // Last login, and an old weak hash replaced by scrypt (fire-and-forget).
      const upgrade = data.password_hash.startsWith('s1$') ? null : hashPassword(password);
      query(
        upgrade ? `UPDATE team_users SET last_login = NOW(), password_hash = $2 WHERE id = $1` : `UPDATE team_users SET last_login = NOW() WHERE id = $1`,
        upgrade ? [data.id, upgrade] : [data.id]
      ).catch(() => {});
      void refreshTeamCache();

      return { user, token };
    }
  } catch {
    // DB not set up yet or user not found
  }

  return null;
}

export function getAuthFromRequest(request: NextRequest): AuthUser | null {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const t = verifyToken(authHeader.slice(7));
  if (!t) return null;
  const { sv, uid, ...base } = t;
  if (t.role === 'admin') {
    // Only the owner's own login is the super admin, and only one made since his last change.
    if (!cache.adminLoadedAt) { void refreshTeamCache(); return null; }
    const now = cache.admin ?? (process.env.ADMIN_USERNAME ? { username: process.env.ADMIN_USERNAME, sv: ENV_SESSION_VERSION } : null);
    return now && t.username === now.username && sv === now.sv ? base : null;
  }
  if (!cache.loadedAt) { void refreshTeamCache(); return base; }
  const e = cache.map.get(t.username);
  // Removed, switched off, a new password or username since, or another person's old username.
  if (!e || !e.active || e.sv !== sv || (uid && uid !== e.id)) return null;
  return {
    username: t.username,
    displayName: e.name,
    role: e.role,
    businessIds: e.businessIds,
    permissions: resolvePermissions(e.role, e.permissions),
  };
}

// The old 32-bit team password hash: only to recognise a password saved before 2026-10-01.
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'h_' + Math.abs(hash).toString(36);
}
