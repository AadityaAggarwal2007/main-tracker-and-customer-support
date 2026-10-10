import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { canChargebacks, isSuperAdmin, panelScope } from '@/lib/permissions';
import { alertCounts, listAlerts, setAlertOrder, setAlertPanel, setAlertStatus } from '@/lib/chargeback/store';

// ── Chargeback alerts: the Super Admin's screen and badge (owner 2026-10-08) ──────────────────
// GET  /api/chargebacks?counts=1            only the numbers for the sidebar badge (new = not opened yet)
// GET  /api/chargebacks?view=open|done|all|other  the alerts, newest unopened first ('other' = the Gmail's non-chargeback mail)
// PATCH /api/chargebacks { id, status: 'seen' | 'done', note? }
// PATCH /api/chargebacks { id, orderId }   "Link order" when the mail named none of ours (owner 2026-10-11)
// The Super Admin and the Manager (chargebacks.view, owner 2026-10-10: "chargeback ki saari responsibility Sunny ke sar
// pe"), the Manager only for their panels. Any other member gets the red tag in a chat thread, never the gateway mail.
// Moving an alert to another panel stays the Super Admin's.
function owner(request: NextRequest) {
  const user = getAuthFromRequest(request);
  return user && canChargebacks(user) ? user : null;
}

export async function GET(request: NextRequest) {
  const user = owner(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sp = new URL(request.url).searchParams;
  try {
    const scope = panelScope(user);
    if (sp.get('counts') === '1') return NextResponse.json(await alertCounts(scope), { headers: { 'Cache-Control': 'no-store' } });
    const v = sp.get('view');
    const view = v === 'done' || v === 'all' || v === 'other' ? v : 'open';
    const [list, counts] = await Promise.all([listAlerts(view, 100, scope), alertCounts(scope)]);
    // Moving an alert to another panel is the Super Admin's: the Manager gets no panels to move to.
    if (!isSuperAdmin(user)) for (const a of list.alerts) a.alt_panels = [];
    return NextResponse.json({ ...list, counts }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[chargeback] list:', (e as Error).message);
    return NextResponse.json({ error: 'Could not read the chargeback alerts.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const user = owner(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { id?: unknown; status?: unknown; note?: unknown; businessId?: unknown; orderId?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  // { id, orderId }: tie the alert to an order of its panel by hand (the Super Admin and the Manager for their panels).
  if (typeof body.id === 'string' && (typeof body.orderId === 'string' || typeof body.orderId === 'number') && body.status === undefined) {
    try {
      const r = await setAlertOrder(body.id, String(body.orderId), panelScope(user));
      return r.ok ? NextResponse.json({ ok: true, orderId: r.orderId }) : NextResponse.json({ error: r.error }, { status: r.status || 400 });
    } catch (e) {
      console.error('[chargeback] link order:', (e as Error).message);
      return NextResponse.json({ error: 'Could not link it.' }, { status: 500 });
    }
  }
  // { id, businessId }: move an alert to the other panel that reads the same chargeback Gmail.
  if (typeof body.id === 'string' && typeof body.businessId === 'string' && body.status === undefined) {
    if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the Super Admin moves an alert to another panel' }, { status: 403 });
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
    const ok = await setAlertStatus(body.id, body.status, user.displayName || user.username, typeof body.note === 'string' ? body.note : '', panelScope(user));
    return NextResponse.json({ ok });
  } catch (e) {
    console.error('[chargeback] status:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save that.' }, { status: 500 });
  }
}
