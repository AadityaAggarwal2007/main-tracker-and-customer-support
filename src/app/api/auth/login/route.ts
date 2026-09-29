import { NextRequest, NextResponse } from 'next/server';
import { authenticateUser } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    const result = await authenticateUser(username, password);

    if (!result) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

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
