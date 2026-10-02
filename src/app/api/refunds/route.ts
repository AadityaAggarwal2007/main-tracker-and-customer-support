import { NextRequest } from 'next/server';
import { authReady, getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { ajson } from '@/lib/refund/public';
import { adminFailure, listRefunds } from '@/lib/refund/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── GET /api/refunds?view=new|approved|rejected|refunded|cancelled|all|sent&before=<iso> ──
// The Super Admin's "Refund requests" tab (owner, 2026-10-02): up to 100 newest requests of one
// status (or the links sent and not filled yet), with the counts for the chips and the list flags.
// UPI / bank details are masked here; the full ones only come from /api/refunds/<id>/reveal.
// Only the Super Admin: the team, the AI, the learner, search and the team score never read these.
// Search is done on the screen over the loaded rows: no order ID or name ever goes in a URL. Spec 3.5.
export async function GET(request: NextRequest) {
  await authReady();
  const user = getAuthFromRequest(request);
  if (!user) return ajson({ error: 'Please log in again' }, 401);
  if (!isSuperAdmin(user)) return ajson({ error: 'Only the Super Admin can see refund requests' }, 403);
  try {
    const sp = new URL(request.url).searchParams;
    const r = await listRefunds(sp.get('view'), sp.get('before'));
    return ajson(r.body, r.status);
  } catch (e) {
    const r = adminFailure('list', e);
    return ajson(r.body, r.status);
  }
}
