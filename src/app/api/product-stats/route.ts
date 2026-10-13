import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { canAccessPanel, isSuperAdmin, isTeamLead } from '@/lib/permissions';
import { cleanGroups, cleanWatch } from '@/lib/product-stats';
import { loadProductStats, loadSetup, saveSetup } from '@/lib/product-stats-server';

export const dynamic = 'force-dynamic';

// ── Shopify tab (owner 2026-10-13): orders by product and by the team's own collections ─────────────────────────
// GET  ?businessId=<panel>&range=today|yesterday|7d|30d|custom[&from=YYYY-MM-DD&to=YYYY-MM-DD]
// POST {businessId, groups?, watch?}   saves the panel's collections and / or watch list.
// The Super Admin and the Manager (owner's answer), inside the panels they may see. Nothing is sent anywhere.
function who(request: NextRequest, businessId: string | null) {
  const user = getAuthFromRequest(request);
  if (!user) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!isSuperAdmin(user) && !isTeamLead(user)) return { res: NextResponse.json({ error: 'Only the Super Admin and the Manager see this' }, { status: 403 }) };
  if (!businessId || !/^[0-9a-f-]{36}$/i.test(businessId)) return { res: NextResponse.json({ error: 'Pick a panel first' }, { status: 400 }) };
  if (!canAccessPanel(user, businessId)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  return { user };
}

export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const businessId = sp.get('businessId');
  const got = who(request, businessId);
  if ('res' in got) return got.res;
  try {
    return NextResponse.json(await loadProductStats(businessId as string, { range: sp.get('range'), from: sp.get('from'), to: sp.get('to') }));
  } catch (e) {
    console.error('[product-stats] GET:', (e as Error).message);
    return NextResponse.json({ error: 'Could not read the orders right now' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let body: { businessId?: unknown; groups?: unknown; watch?: unknown } | null = null;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const businessId = typeof body?.businessId === 'string' ? body.businessId : null;
  const got = who(request, businessId);
  if ('res' in got) return got.res;
  const setup = await loadSetup(businessId as string);
  if (body?.groups !== undefined) {
    const g = cleanGroups(body.groups);
    if ('error' in g) return NextResponse.json({ error: g.error }, { status: 400 });
    setup.groups = g.groups;
  }
  if (body?.watch !== undefined) {
    const w = cleanWatch(body.watch);
    if ('error' in w) return NextResponse.json({ error: w.error }, { status: 400 });
    setup.watch = w.watch;
  }
  try {
    await saveSetup(businessId as string, setup, got.user);
    return NextResponse.json({ ok: true, setup });
  } catch (e) {
    console.error('[product-stats] POST:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save right now' }, { status: 500 });
  }
}
