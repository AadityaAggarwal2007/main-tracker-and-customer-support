import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { STARTING_MESSAGE, actionsReady } from '@/lib/chat/team-routing';
import { loadForUser } from '@/lib/chat/thread-read';
import { removeTeamVerify, teamVerify, type TeamVerifyResult } from '@/lib/chat/team-verify';

export const dynamic = 'force-dynamic';

// ── POST /api/chat/conversations/:id/verify ──────────────────
// "Team ka Verify button" (owner 2026-10-11 13:10): a team member types the Order ID + the customer's
// FULL phone number for a website-widget or email chat; both must match one order of the chat's own
// panel (src/lib/chat/team-verify.ts, rules in team-verify-rules.ts). { orderId, phone } verifies,
// { remove: true } undoes a team verification (a wrong click). Logins with chat.view + chat.reply, inside
// their own panels, on a chat they may reply in (the holder, a free chat, or the Super Admin). Never a
// WhatsApp chat (400). Wrong tries: 10 per login in 15 minutes (429). The phone is never stored or
// logged. Answers { ok, orderId, customerName }.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await actionsReady())) return NextResponse.json({ error: STARTING_MESSAGE }, { status: 503 });
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.view') || !can(user, 'chat.reply')) {
    return NextResponse.json({ error: 'You cannot verify chats' }, { status: 403 });
  }
  const conv = await loadForUser(params.id, user);
  if (!conv) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const body = (raw && typeof raw === 'object' ? raw : {}) as { remove?: unknown };

  try {
    const out: TeamVerifyResult = body.remove === true ? await removeTeamVerify(conv, user) : await teamVerify(conv, user, raw);
    if (out.ok === false) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json({ ok: true, orderId: out.orderId, customerName: out.customerName });
  } catch (err) {
    console.error('[chat-verify] POST error:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not verify right now' }, { status: 500 });
  }
}
