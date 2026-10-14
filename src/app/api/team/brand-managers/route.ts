import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest, teamEntries } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { can, canAccessPanel, isSuperAdmin, isTeamLead } from '@/lib/permissions';
import { loadBrandManagers, setBrandManager } from '@/lib/chat/brand-managers';
import { panelsOf } from '@/lib/chat/brand-managers-rules';

export const dynamic = 'force-dynamic';

// Brand managers (owner 2026-10-14; brand-managers-rules.ts):
//   GET   -> {managers: {<panel id>: {id, name}}, mine: [<panel id>]}: any login (names only; `mine` = the panels this login
//            manages, so its screens open on its own brand)
//   POST  {panelId, memberId | null}   Super Admin: one member per panel, who replies to chats and may see that panel.
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const map = await loadBrandManagers();
  const names = new Map(teamEntries().map((e) => [e.id, e.name]));
  const managers: Record<string, { id: string; name: string }> = {};
  for (const [panel, id] of Object.entries(map)) {
    if (!canAccessPanel(user, panel)) continue;
    managers[panel] = { id, name: names.get(id) || 'Removed member' };
  }
  return NextResponse.json({ managers, mine: user.id ? panelsOf(user.id, map) : [] });
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Super Admin only' }, { status: 403 });
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const panelId = typeof body.panelId === 'string' ? body.panelId : '';
  const memberId = typeof body.memberId === 'string' && body.memberId ? body.memberId : null;
  if (!/^[\w-]{6,80}$/.test(panelId)) return NextResponse.json({ error: 'panelId required' }, { status: 400 });
  const panel = await queryOne<{ id: string }>(`SELECT id FROM businesses WHERE id::text = $1::text`, [panelId]).catch(() => null);
  if (!panel) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
  if (memberId) {
    const m = teamEntries().find((e) => e.id === memberId);
    if (!m || !m.active) return NextResponse.json({ error: 'That member is not active.' }, { status: 400 });
    if (!can(m, 'chat.reply')) return NextResponse.json({ error: `${m.name} cannot reply to chats: tick "Reply" for them in Team first.` }, { status: 400 });
    // The Manager is never given chats by auto-assign (onDuty leaves team leads out) and keeps All panels, so picking them
    // would change nothing (review 2026-10-14): refused with the reason.
    if (isTeamLead(m)) return NextResponse.json({ error: `${m.name} is a Manager: chats are never handed to a Manager automatically. Pick a team member.` }, { status: 400 });
    if (!canAccessPanel(m, panelId)) return NextResponse.json({ error: `${m.name} may not see this panel: add it to their panels in Team first.` }, { status: 400 });
  }
  try {
    await setBrandManager(panelId, memberId, user.displayName || user.username);
    console.log(`[brand-managers] panel=${panelId} -> ${memberId || 'nobody'}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[brand-managers] save:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save it.' }, { status: 500 });
  }
}
