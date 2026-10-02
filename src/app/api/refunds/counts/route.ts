import { NextRequest } from 'next/server';
import { authReady, getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { ajson } from '@/lib/refund/public';
import { adminFailure, refundCounts } from '@/lib/refund/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── GET /api/refunds/counts (owner, 2026-10-02) ─────────────────
// The red badge on the Super Admin's "Refund requests" tab: {unseen, new, approved}. Polled by the
// admin page every 60 s and on focus. Its own route, so the refund tables stay out of the shared chat
// routes (/api/chat/pending). Super Admin only. Spec 3.5.
export async function GET(request: NextRequest) {
  await authReady();
  const user = getAuthFromRequest(request);
  if (!user) return ajson({ error: 'Please log in again' }, 401);
  if (!isSuperAdmin(user)) return ajson({ error: 'Only the Super Admin can see refund requests' }, 403);
  try {
    const r = await refundCounts();
    return ajson(r.body, r.status);
  } catch (e) {
    const r = adminFailure('counts', e);
    return ajson(r.body, r.status);
  }
}
