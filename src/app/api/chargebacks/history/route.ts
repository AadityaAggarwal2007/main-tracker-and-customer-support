import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { canChargebacks, panelScope } from '@/lib/permissions';
import { loadHistory, recentAlertIds } from '@/lib/chargeback/history';
import { historyText } from '@/lib/chargeback/history-rules';

export const dynamic = 'force-dynamic';

// ── Chargeback history (owner 2026-10-13: "chargeback ... order ki chat, gmail, whatsapp sa connect") ──────────────
// GET ?id=<alert>                         one chargeback: its order, everything tied to it as one timeline
// GET ?businessId=<panel>&orderId=<order> the same for an order of the Stop them list
// GET ?all=1                              every real chargeback of the last 120 days as masked text (at most 30)
// Read only. The Super Admin and the Manager (chargebacks.view), the Manager only for their panels.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canChargebacks(user)) return NextResponse.json({ error: 'Only the Super Admin and the Manager see chargebacks' }, { status: 403 });
  const sp = new URL(request.url).searchParams;
  const scope = panelScope(user);
  try {
    if (sp.get('all') === '1') {
      const ids = await recentAlertIds(scope);
      const parts: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        const r = await loadHistory({ alertId: ids[i] }, scope);
        if ('history' in r) parts.push(historyText(r.history, i + 1));
      }
      return NextResponse.json({ count: parts.length, text: parts.join('\n\n') }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const r = await loadHistory({ alertId: sp.get('id'), businessId: sp.get('businessId'), orderId: sp.get('orderId') }, scope);
    if (!('history' in r)) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ history: r.history, text: historyText(r.history) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[cb-history] GET:', (e as Error).message);
    return NextResponse.json({ error: 'Could not read the history right now' }, { status: 500 });
  }
}
