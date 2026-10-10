import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isTeamLead, panelScope } from '@/lib/permissions';
import { loadTeamLive } from '@/lib/chat/team-live';

export const dynamic = 'force-dynamic';

// ── GET /api/chat/team/live ────────────────────────────────────
// The Manager's live board (owner 2026-10-10, step 5): each team member's day in half hours and Chikki's, in the
// login's panels (src/lib/chat/team-live.ts). The Super Admin and the Manager (team.lead) only; read only.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isTeamLead(user)) return NextResponse.json({ error: 'Only the Manager and the Super Admin see the team board' }, { status: 403 });
  try {
    return NextResponse.json(await loadTeamLive(panelScope(user)));
  } catch (e) {
    console.error('[team-live] route:', (e as Error).message);
    return NextResponse.json({ error: 'Could not read the team board' }, { status: 500 });
  }
}
