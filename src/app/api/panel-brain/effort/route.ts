import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest, type AuthUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { ensureSiteForPanel } from '@/lib/chat/site';
import { CUSTOMER_GROUPS, EFFORTS, cleanEffortSettings } from '@/lib/chat/effort';

export const dynamic = 'force-dynamic';

// ── Chikki's effort per group (chikki-effort.sql, src/lib/chat/effort.ts) ───────────────
// Read with the rest of Chikki (GET /api/panel-brain). Here an admin saves which level each
// kind of customer gets (Calm / Uneasy / Frustrated / Critical: Normal / High / Max). Visitors
// are not set here: they stay Normal until a visitor AI is built (owner, 2026-10-01).

async function siteIdFor(businessId: string, user: AuthUser) {
  if (user.businessIds && user.businessIds.length > 0 && !user.businessIds.includes(businessId)) return null;
  const biz = await queryOne<{ id: string }>(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
  if (!biz) return null;
  return (await ensureSiteForPanel(businessId)).id;
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Only an admin can change how Chikki thinks' }, { status: 403 });
  try {
    const raw = await request.json();
    const businessId = String(raw.businessId || '');
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    const given = (raw.effort && typeof raw.effort === 'object' ? raw.effort : {}) as Record<string, unknown>;
    for (const g of CUSTOMER_GROUPS) {
      if (!(EFFORTS as string[]).includes(String(given[g]))) return NextResponse.json({ error: `Pick Normal, High or Max for ${g}` }, { status: 400 });
    }
    const siteId = await siteIdFor(businessId, user);
    if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
    const settings = cleanEffortSettings(given);
    await queryOne(`UPDATE sites SET chikki_effort = $2::jsonb WHERE id = $1 RETURNING id`, [siteId, JSON.stringify(settings)]);
    return NextResponse.json({ settings });
  } catch (err) {
    console.error('panel-brain effort POST error:', err);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}
