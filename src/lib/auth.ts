import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest } from 'next/server';
import { queryOne, query } from './db';

export interface AuthUser {
  username: string;
  displayName: string;
  role: 'admin' | 'manager' | 'viewer';
  businessIds: string[] | null; // null = all panels (admin), string[] = specific panels only
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
const ROLES: AuthUser['role'][] = ['admin', 'manager', 'viewer'];

function tokenSecret(): string | null {
  const secret = process.env.AUTH_TOKEN_SECRET || '';
  return secret.length >= 32 ? secret : null;
}

function signature(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function generateToken(username: string, role: string, businessIds: string[] | null = null): string {
  const secret = tokenSecret();
  if (!secret) throw new Error('AUTH_TOKEN_SECRET is missing or shorter than 32 characters; refusing to issue a login token');

  const payload = Buffer.from(
    JSON.stringify({ username, role, businessIds, exp: Date.now() + TOKEN_LIFETIME_MS })
  ).toString('base64url');
  const body = `${TOKEN_VERSION}.${payload}`;
  return `${body}.${signature(body, secret).toString('base64url')}`;
}

export function verifyToken(token: string): AuthUser | null {
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
    if (typeof payload.username !== 'string' || !ROLES.includes(payload.role)) return null;
    return {
      username: payload.username,
      displayName: payload.username,
      role: payload.role,
      businessIds: Array.isArray(payload.businessIds) ? payload.businessIds : null,
    };
  } catch {
    return null;
  }
}

export async function authenticateUser(
  username: string,
  password: string
): Promise<{ user: AuthUser; token: string } | null> {
  // Check env admin first
  const envUsername = process.env.ADMIN_USERNAME;
  const envPassword = process.env.ADMIN_PASSWORD;

  if (username === envUsername && password === envPassword) {
    const user: AuthUser = { username, displayName: 'Super Admin', role: 'admin', businessIds: null };
    const token = generateToken(username, 'admin', null);
    return { user, token };
  }

  // Check team users in database
  try {
    const data = await queryOne<{
      id: string; username: string; display_name: string;
      role: string; password_hash: string; business_ids: string[] | null;
    }>(
      `SELECT id, username, display_name, role, password_hash, business_ids
       FROM team_users
       WHERE username = $1 AND is_active = true
       LIMIT 1`,
      [username]
    );

    if (data && data.password_hash === simpleHash(password)) {
      const businessIds = data.business_ids && data.business_ids.length > 0 ? data.business_ids : null;
      const user: AuthUser = {
        username: data.username,
        displayName: data.display_name,
        role: data.role as AuthUser['role'],
        businessIds,
      };
      const token = generateToken(data.username, data.role, businessIds);

      // Update last login (fire-and-forget)
      query(`UPDATE team_users SET last_login = NOW() WHERE id = $1`, [data.id]).catch(() => {});

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
  return verifyToken(authHeader.slice(7));
}

// Simple hash for team user passwords (sufficient for internal CRM)
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'h_' + Math.abs(hash).toString(36);
}
