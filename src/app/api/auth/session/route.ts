import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// ── GET /api/auth/session ──────────────────────────────────────
// The admin pages ask this on load. A 401 means the saved token is expired,
// forged, or from before tokens were signed, and the page sends the person
// back to the login screen instead of showing empty lists.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ user });
}
