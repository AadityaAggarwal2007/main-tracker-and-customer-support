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

// extra: the team member's display name, their own permission ticks (null = the role's) and
// their session version (a password reset bumps it, which signs that member out everywhere).
export function generateToken(
  username: string,
  role: string,
  businessIds: string[] | null = null,
  extra: { name?: string; perms?: string[] | null; sv?: number } = {},
): string {
  const secret = tokenSecret();
  if (!secret) throw new Error('AUTH_TOKEN_SECRET is missing or shorter than 32 characters; refusing to issue a login token');

  const payload = Buffer.from(
    JSON.stringify({ username, role, businessIds, exp: Date.now() + TOKEN_LIFETIME_MS, name: extra.name, perms: extra.perms ?? null, sv: extra.sv ?? 1 })
  ).toString('base64url');
  const body = `${TOKEN_VERSION}.${payload}`;
  return `${body}.${signature(body, secret).toString('base64url')}`;
}

type TokenUser = AuthUser & { sv: number };

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

// ── Team members, read fresh ───────────────────────────────────
// A token lives 7 days, but a member who is switched off, removed, given a new password or new
// ticks or panels must feel it at once: every request checks the token against this copy of
// team_users, reloaded every 30 seconds and right after any change in the Team screen (one
// server process: PM2 fork mode). Until the first load finishes, the token's own claims count.
interface TeamEntry { active: boolean; role: Role; name: string; businessIds: string[] | null; permissions: string[] | null; sv: number }
type TeamCache = { map: Map<string, TeamEntry>; loadedAt: number; loading: Promise<void> | null; timer: ReturnType<typeof setInterval> | null };
const g = globalThis as unknown as { __shiptrackTeam?: TeamCache };
const cache: TeamCache = g.__shiptrackTeam || (g.__shiptrackTeam = { map: new Map(), loadedAt: 0, loading: null, timer: null });

export function refreshTeamCache(): Promise<void> {
  if (cache.loading) return cache.loading;
  cache.loading = (async () => {
    try {
      const r = await query<{ username: string; display_name: string; role: string; is_active: boolean; business_ids: string[] | null; permissions: string[] | null; session_version: number | null }>(
        `SELECT username, display_name, role, is_active, business_ids, permissions, session_version FROM team_users`
      );
      const next = new Map<string, TeamEntry>();
      for (const u of r.rows) {
        if (!isRole(u.role) || u.role === 'admin') continue; // a team member is never the super admin
        next.set(u.username, {
          active: !!u.is_active, role: u.role, name: u.display_name || u.username,
          businessIds: u.business_ids && u.business_ids.length ? u.business_ids : null,
          permissions: u.permissions, sv: u.session_version ?? 1,
        });
      }
      cache.map = next;
      cache.loadedAt = Date.now();
    } catch (err) {
      // Before team-permissions.sql is applied, or the database hiccups: keep the last copy.
      console.error('[auth] team refresh failed:', (err as Error)?.message);
    } finally {
      cache.loading = null;
    }
  })();
  if (!cache.timer) {
    cache.timer = setInterval(() => { void refreshTeamCache(); }, 30_000);
    (cache.timer as { unref?: () => void }).unref?.();
  }
  return cache.loading;
}

export async function authenticateUser(
  username: string,
  password: string
): Promise<{ user: AuthUser; token: string } | null> {
  // The super admin: the owner's login from the server settings.
  const envUsername = process.env.ADMIN_USERNAME || '';
  const envPassword = process.env.ADMIN_PASSWORD || '';
  if (envUsername && envPassword && sameText(username, envUsername) && sameText(password, envPassword)) {
    const user: AuthUser = { username, displayName: 'Super Admin', role: 'admin', businessIds: null, permissions: resolvePermissions('admin') };
    const token = generateToken(username, 'admin', null, { name: 'Super Admin' });
    return { user, token };
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
      [username.trim().toLowerCase()]
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
      const token = generateToken(data.username, data.role, businessIds, { name: data.display_name, perms: data.permissions, sv });

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
  const { sv, ...base } = t;
  if (t.role === 'admin') {
    // Only the owner's own login is the super admin.
    const envUsername = process.env.ADMIN_USERNAME || '';
    return envUsername && t.username === envUsername ? base : null;
  }
  if (!cache.loadedAt) { void refreshTeamCache(); return base; }
  const e = cache.map.get(t.username);
  if (!e || !e.active || e.sv !== sv) return null; // removed, switched off, or a new password since
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
