import { NextRequest, NextResponse } from 'next/server';
import { authReady, getAuthFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// ── GET /api/auth/session ──────────────────────────────────────
// The admin pages ask this on load. A 401 means the saved token is expired,
// forged, from before tokens were signed, or (super admin) made before the
// owner last changed his username / password, and the page sends the person
// back to the login screen instead of showing empty lists. Right after a
// restart it first waits for the logins to be read (auth.ts), so a good
// token is never turned away for that.
export async function GET(request: NextRequest) {
  await authReady();
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ user });
}
