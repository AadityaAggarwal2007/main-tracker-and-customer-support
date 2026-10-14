import { NextRequest } from 'next/server';
import { authReady, getAuthFromRequest } from '@/lib/auth';
import { canRefunds, panelScope } from '@/lib/permissions';
import { ajson } from '@/lib/refund/public';
import { adminFailure, refundCounts, refundCountsByPanel } from '@/lib/refund/server';
import { loadStuck } from '@/lib/refund/stuck';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── GET /api/refunds/counts (owner, 2026-10-02) ─────────────────
// The red badge on the Super Admin's "Refund requests" tab: {unseen, new, approved}. Polled by the
// admin page every 60 s and on focus. Its own route, so the refund tables stay out of the shared chat
// routes (/api/chat/pending). Super Admin only. Spec 3.5. ?byPanel=1 (owner 2026-10-09) answers
// { by_panel: { <business_id>: new requests } } for the panel board instead. ?stuck=1 (owner 2026-10-14) adds
// { stuck: { <business_id>: {refundNoForm, refundWaiting, reshipNotSent} } }: promises waiting 2+ days (stuck.ts),
// for the panel board and the Chat Support bar.
export async function GET(request: NextRequest) {
  await authReady();
  const user = getAuthFromRequest(request);
  if (!user) return ajson({ error: 'Please log in again' }, 401);
  if (!canRefunds(user)) return ajson({ error: 'Only the Super Admin and the Manager can see refund requests' }, 403);
  try {
    const sp = new URL(request.url).searchParams;
    const r = sp.get('byPanel') === '1' ? await refundCountsByPanel(panelScope(user)) : await refundCounts(panelScope(user));
    if (sp.get('stuck') === '1' && r.status === 200) return ajson({ ...(r.body as object), stuck: await loadStuck(panelScope(user)) }, 200);
    return ajson(r.body, r.status);
  } catch (e) {
    const r = adminFailure('counts', e);
    return ajson(r.body, r.status);
  }
}
