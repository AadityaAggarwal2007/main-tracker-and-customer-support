import { NextRequest } from 'next/server';
import { authReady, getAuthFromRequest } from '@/lib/auth';
import { canRefunds, isSuperAdmin, panelScope } from '@/lib/permissions';
import { ajson } from '@/lib/refund/public';
import { adminFailure, getRefund, patchRefund } from '@/lib/refund/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── /api/refunds/<id> (owner, 2026-10-02) ───────────────────────
// GET: one refund request for the Super Admin's drawer (marks it seen; payout masked; flags, files,
// the messages the customer got, the history). PATCH {action, expect, ...}: approve / reject /
// refunded / cancel (a compare-and-set on the status the screen showed; the customer's fixed message
// goes into the chat in the same transaction, never the note), note, return, tell_return, post_ack,
// retry_email. Only the Super Admin. Spec 3.5.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  await authReady();
  const user = getAuthFromRequest(request);
  if (!user) return ajson({ error: 'Please log in again' }, 401);
  if (!canRefunds(user)) return ajson({ error: 'Only the Super Admin and the Manager can see refund requests' }, 403);
  try {
    const r = await getRefund(String(params?.id || ''), panelScope(user), user);
    // The full bank / UPI details (reveal) stay the Super Admin's: the drawer hides the button for the Manager.
    const body = r.status === 200 && r.body && typeof r.body === 'object' ? { ...(r.body as Record<string, unknown>), can_reveal: isSuperAdmin(user) } : r.body;
    return ajson(body, r.status);
  } catch (e) {
    const r = adminFailure('detail', e);
    return ajson(r.body, r.status);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  await authReady();
  const user = getAuthFromRequest(request);
  if (!user) return ajson({ error: 'Please log in again' }, 401);
  if (!canRefunds(user)) return ajson({ error: 'Only the Super Admin and the Manager can change refund requests' }, 403);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return ajson({ error: 'Send a JSON body with an action' }, 400);
  }
  try {
    const r = await patchRefund(user, String(params?.id || ''), body, panelScope(user));
    return ajson(r.body, r.status);
  } catch (e) {
    const r = adminFailure('change', e);
    return ajson(r.body, r.status);
  }
}
