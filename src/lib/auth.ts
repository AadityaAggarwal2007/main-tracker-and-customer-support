import { NextRequest } from 'next/server';
import { queryOne, query } from './db';

export interface AuthUser {
  username: string;
  displayName: string;
  role: 'admin' | 'manager' | 'viewer';
  businessIds: string[] | null; // null = all panels (admin), string[] = specific panels only
}

// Simple token-based auth using base64 encoded credentials
export function generateToken(username: string, role: string, businessIds: string[] | null = null): string {
  const payload = JSON.stringify({ username, role, businessIds, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  return Buffer.from(payload).toString('base64');
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return {
      username: payload.username,
      displayName: payload.username,
      role: payload.role,
      businessIds: payload.businessIds ?? null,
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
