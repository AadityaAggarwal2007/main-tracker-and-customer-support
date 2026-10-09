import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { loadPanelBoard } from '@/lib/panel-board-server';

export const dynamic = 'force-dynamic';

// ── GET /api/panel-board (owner 2026-10-09) ───────────────────────────────────────────────────
// Every panel this login may see with its numbers; the screen (PanelBoard.tsx) turns them into the lines with the
// pure rules in src/lib/panel-board.ts, after adding the Super Admin's refund-request numbers from
// /api/refunds/counts?byPanel=1. The chargeback number is the Super Admin's only (null for a team member).
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const panels = await loadPanelBoard(user.businessIds, isSuperAdmin(user));
    return NextResponse.json({ panels, superAdmin: isSuperAdmin(user), at: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[panel-board]', (e as Error).message);
    return NextResponse.json({ error: 'Could not read the panel board.' }, { status: 500 });
  }
}
