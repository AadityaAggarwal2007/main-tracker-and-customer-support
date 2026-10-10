import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { canChargebacks, panelScope } from '@/lib/permissions';
import { loadRiskList, loadStudy } from '@/lib/chargeback/risk';

export const dynamic = 'force-dynamic';

// ── Chargeback Shield (owner 2026-10-10) ──
// GET /api/chargebacks/risk[?fresh=1]   the prepaid orders whose customers sound like a chargeback is coming (Watch+)
// GET /api/chargebacks/risk?view=study  every real chargeback so far: its order, and whether the signs were there before
// The Super Admin and the Manager (chargebacks.view), the Manager only for their panels. Read only.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !canChargebacks(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sp = new URL(request.url).searchParams;
  try {
    const scope = panelScope(user);
    const body = sp.get('view') === 'study' ? await loadStudy(scope) : await loadRiskList(scope, Date.now(), sp.get('fresh') === '1');
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[risk] route:', (e as Error).message);
    return NextResponse.json({ error: 'Could not work out the chargeback risk.' }, { status: 500 });
  }
}
