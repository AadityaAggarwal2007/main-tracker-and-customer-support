import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { setCorrection } from '@/lib/chat/corrections';

export const dynamic = 'force-dynamic';

// ── PATCH /api/corrections/:id { action: 'done' | 'cancel' | 'reopen', note? } ───────────────────
// Owner 2026-10-11: only the Super Admin and the Manager (team.lead) fix the order and close a correction; a member
// gets 403. Inside the login's panels (another panel's row is a 404). The optional note (at most 300 characters)
// stays with the row. Nothing is sent to the customer.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  try {
    const r = await setCorrection(user, params.id, body);
    if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, correction: r.value });
  } catch (e) {
    console.error('[correction] PATCH error:', (e as Error)?.message);
    return NextResponse.json({ error: 'Could not change the correction right now' }, { status: 500 });
  }
}
