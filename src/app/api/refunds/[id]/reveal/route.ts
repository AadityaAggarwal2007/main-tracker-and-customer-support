import { NextRequest } from 'next/server';
import { authReady, getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { clientIp } from '@/lib/chat/widget-api';
import { ajson } from '@/lib/refund/public';
import { adminFailure, revealPayout } from '@/lib/refund/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── POST /api/refunds/<id>/reveal (owner, 2026-10-02) ───────────
// The full UPI ID / bank account a customer gave, for the Super Admin to pay. Every call is recorded
// (refund_events 'revealed', written BEFORE the details are sent), at most 30 an hour, never cached;
// the screen hides them again after 60 s. Without the key: 503. Only the Super Admin. Spec 3.5.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  await authReady();
  const user = getAuthFromRequest(request);
  if (!user) return ajson({ error: 'Please log in again' }, 401);
  if (!isSuperAdmin(user)) return ajson({ error: 'Only the Super Admin can see refund details' }, 403);
  try {
    const r = await revealPayout(String(params?.id || ''), clientIp(request), request.headers.get('user-agent'));
    return ajson(r.body, r.status);
  } catch (e) {
    const r = adminFailure('reveal', e);
    return ajson(r.body, r.status);
  }
}
