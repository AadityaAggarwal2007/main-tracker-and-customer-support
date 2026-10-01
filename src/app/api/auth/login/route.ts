import { NextRequest, NextResponse } from 'next/server';
import { authenticateUser } from '@/lib/auth';
import { clientIp } from '@/lib/chat/widget-api';

// Wrong passwords are limited (owner's team logins, 2026-10-01): 10 per 15 minutes per username
// and 30 per internet address (a whole office can share one), so nobody can guess a team
// member's password by trying many. A right password clears that username's count. Kept in
// memory (one server process).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_USER = 10;
const MAX_FAILS_IP = 30;
type Entry = { n: number; until: number };
const g = globalThis as unknown as { __shiptrackLoginFails?: Map<string, Entry> };
const fails: Map<string, Entry> = g.__shiptrackLoginFails || (g.__shiptrackLoginFails = new Map());

function blocked(key: string, max: number): boolean {
  const e = fails.get(key);
  if (!e) return false;
  if (e.until < Date.now()) { fails.delete(key); return false; }
  return e.n >= max;
}
function failed(key: string) {
  const e = fails.get(key);
  if (!e || e.until < Date.now()) fails.set(key, { n: 1, until: Date.now() + WINDOW_MS });
  else e.n++;
  if (fails.size > 10000) fails.clear();
}

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    const ipKey = `ip:${clientIp(request)}`;
    const userKey = `user:${String(username).trim().toLowerCase()}`;
    if (blocked(ipKey, MAX_FAILS_IP) || blocked(userKey, MAX_FAILS_USER)) {
      return NextResponse.json({ error: 'Too many wrong tries. Please wait 15 minutes and try again.' }, { status: 429 });
    }

    const result = await authenticateUser(String(username).trim(), String(password));

    if (!result) {
      failed(ipKey); failed(userKey);
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    fails.delete(userKey);
    return NextResponse.json({
      token: result.token,
      user: result.user,
    });
  } catch (err) {
    // Most likely AUTH_TOKEN_SECRET missing from /etc/tracker/.env.
    console.error('[auth] login failed:', (err as Error).message);
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}
