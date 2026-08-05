import { NextRequest } from 'next/server';
import { queryOne, query } from './db';

export interface AuthUser {
  username: string;
  displayName: string;
  role: 'admin' | 'manager' | 'viewer';
}

// Simple token-based auth using base64 encoded credentials
export function generateToken(username: string, role: string): string {
  const payload = JSON.stringify({ username, role, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
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
    const user: AuthUser = { username, displayName: 'Super Admin', role: 'admin' };
    const token = generateToken(username, 'admin');
    return { user, token };
  }

  // Check team users in database (direct SQL — no Supabase)
  try {
    const data = await queryOne<{
      id: string; username: string; display_name: string;
      role: string; password_hash: string;
    }>(
      `SELECT id, username, display_name, role, password_hash
       FROM team_users
       WHERE username = $1 AND is_active = true
       LIMIT 1`,
      [username]
    );

    if (data && data.password_hash === simpleHash(password)) {
      const user: AuthUser = {
        username: data.username,
        displayName: data.display_name,
        role: data.role as AuthUser['role'],
      };
      const token = generateToken(data.username, data.role);

      // Update last login (fire-and-forget)
      query(
        `UPDATE team_users SET last_login = NOW() WHERE id = $1`,
        [data.id]
      ).catch(() => {});

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
