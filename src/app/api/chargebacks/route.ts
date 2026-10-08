import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { alertCounts, listAlerts, setAlertPanel, setAlertStatus } from '@/lib/chargeback/store';

// ── Chargeback alerts: the Super Admin's screen and badge (owner 2026-10-08) ──────────────────
// GET  /api/chargebacks?counts=1            only the numbers for the sidebar badge (new = not opened yet)
// GET  /api/chargebacks?view=open|done|all  the alerts, newest unopened first
// PATCH /api/chargebacks { id, status: 'seen' | 'done', note? }
// Super Admin only: a member gets the red tag in a chat thread, never the gateway mail itself.
function owner(request: NextRequest) {
  const user = getAuthFromRequest(request);
  return user && user.role === 'admin' ? user : null;
}

export async function GET(request: NextRequest) {
  const user = owner(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sp = new URL(request.url).searchParams;
  try {
    if (sp.get('counts') === '1') return NextResponse.json(await alertCounts(), { headers: { 'Cache-Control': 'no-store' } });
    const view = sp.get('view') === 'done' ? 'done' : sp.get('view') === 'all' ? 'all' : 'open';
    const [list, counts] = await Promise.all([listAlerts(view), alertCounts()]);
    return NextResponse.json({ ...list, counts }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[chargeback] list:', (e as Error).message);
    return NextResponse.json({ error: 'Could not read the chargeback alerts.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const user = owner(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { id?: unknown; status?: unknown; note?: unknown; businessId?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  // { id, businessId }: move an alert to the other panel that reads the same chargeback Gmail.
  if (typeof body.id === 'string' && typeof body.businessId === 'string' && body.status === undefined) {
    try {
      const r = await setAlertPanel(body.id, body.businessId);
      return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status || 400 });
    } catch (e) {
      console.error('[chargeback] move:', (e as Error).message);
      return NextResponse.json({ error: 'Could not move it.' }, { status: 500 });
    }
  }
  if (typeof body.id !== 'string' || (body.status !== 'seen' && body.status !== 'done')) {
    return NextResponse.json({ error: 'id and status (seen or done), or id and businessId, are required' }, { status: 400 });
  }
  try {
    const ok = await setAlertStatus(body.id, body.status, user.displayName || user.username, typeof body.note === 'string' ? body.note : '');
    return NextResponse.json({ ok });
  } catch (e) {
    console.error('[chargeback] status:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save that.' }, { status: 500 });
  }
}
