import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { isSuperAdmin } from '@/lib/permissions';
import { siteForPanel } from '@/lib/chat/site';
import { loadCommon, makeCommon, overview, setMode } from '@/lib/chat/common-setup';
import { commonReady } from '@/lib/chat/common-setup-rules';

export const dynamic = 'force-dynamic';

// ── /api/panel-setup: the "All panels" setup (owner 2026-10-10, step 7; src/lib/chat/common-setup.ts) ──
// Super Admin only. GET = the common setup and every panel with its mode. POST:
//   { action: 'make', businessId, dryRun? }  the common setup from that panel's Chikki (Preview with dryRun, then Make)
//   { action: 'mode', businessId, mode: 'common' | 'own' }  which setup a panel's Chikki uses
// Nothing of a panel is deleted: its own prompt and answers stay stored and come back with 'own'.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the Super Admin can change the All panels setup' }, { status: 403 });
  try {
    const res = NextResponse.json(await overview(null));
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (e) {
    console.error('[panel-setup] GET:', (e as Error).message);
    return NextResponse.json({ error: 'Could not read the setup' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the Super Admin can change the All panels setup' }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const businessId = String(body.businessId || '');
  if (!businessId) return NextResponse.json({ error: 'Pick a panel' }, { status: 400 });
  const biz = await queryOne<{ id: string }>(`SELECT id FROM businesses WHERE id::text = $1`, [businessId]);
  const site = biz ? await siteForPanel(businessId) : null;
  if (!site) return NextResponse.json({ error: 'That panel has no chat set up yet' }, { status: 404 });
  try {
    if (body.action === 'make') {
      const plan = await makeCommon(site.id, user.username, body.dryRun === true);
      if ('error' in plan) return NextResponse.json(plan, { status: 400 });
      return NextResponse.json({ plan, done: body.dryRun !== true });
    }
    if (body.action === 'mode') {
      const mode = body.mode === 'common' ? 'common' : body.mode === 'own' ? 'own' : null;
      if (!mode) return NextResponse.json({ error: 'Pick All panels or Own' }, { status: 400 });
      if (mode === 'common' && !commonReady(await loadCommon(true))) {
        return NextResponse.json({ error: 'Make the All panels setup first (from one panel)' }, { status: 409 });
      }
      await setMode(site.id, mode);
      return NextResponse.json({ ok: true, mode });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    console.error('[panel-setup] POST:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}
