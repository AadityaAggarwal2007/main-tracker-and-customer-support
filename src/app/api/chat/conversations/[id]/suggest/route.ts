import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { can, canAccessPanel } from '@/lib/permissions';
import { SUGGEST_LANGS, type SuggestLang } from '@/lib/chat/suggest';
import { recordPick, suggestReplies, type SuggestConv } from '@/lib/chat/suggest-run';
import { staffActor } from '@/lib/chat/team-routing';

export const dynamic = 'force-dynamic';

// ── Suggested replies for the team (owner 2026-10-04) ───────────────────────────────
// GET  /api/chat/conversations/:id/suggest?lang=auto|en|hi&refresh=1
//      3 drafts for the team member's next reply (suggest-run.ts), cached per customer message.
// PATCH /api/chat/conversations/:id/suggest { suggestion_id, picked }   which one was clicked.
// Logins that may read and reply in Chat Support, inside their panels; a verified customer's chat
// box or email thread only (never a visitor, never a Closed chat). Nothing is sent to the customer.
async function loadConv(request: NextRequest, id: string) {
  const user = getAuthFromRequest(request);
  if (!user) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!can(user, 'chat.view') || !can(user, 'chat.reply')) return { res: NextResponse.json({ error: 'You cannot reply' }, { status: 403 }) };
  const conv = await queryOne<SuggestConv>(
    `SELECT c.id, c.site_id, s.tracker_business_id, c.source, c.status, c.verified_order_id, c.phone_match_order_id, c.case_kind
       FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = $1`,
    [id]
  );
  if (!conv || !canAccessPanel(user, conv.tracker_business_id)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  if (conv.source !== 'chat') return { res: NextResponse.json({ error: 'Suggestions are for chat conversations only' }, { status: 409 }) };
  if (conv.status === 'resolved') return { res: NextResponse.json({ error: 'This chat is closed' }, { status: 409 }) };
  if (!conv.verified_order_id && !conv.phone_match_order_id) return { res: NextResponse.json({ error: 'Suggestions are for verified customers only' }, { status: 409 }) };
  const actor = staffActor(user);
  return { user, conv, actorKey: actor?.key || user.username };
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const got = await loadConv(request, params.id);
  if ('res' in got) return got.res;
  const sp = new URL(request.url).searchParams;
  const lang = (SUGGEST_LANGS as string[]).includes(sp.get('lang') || '') ? (sp.get('lang') as SuggestLang) : 'auto';
  const refresh = /^(1|true|yes)$/i.test(sp.get('refresh') || '');
  try {
    const out = await suggestReplies(got.conv, got.actorKey, lang, refresh);
    if ('error' in out) return NextResponse.json({ error: out.error }, { status: 503 });
    return NextResponse.json({ suggestion: out });
  } catch (err) {
    console.error('[chat/suggest] GET error:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not draft replies right now' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const got = await loadConv(request, params.id);
  if ('res' in got) return got.res;
  let raw: { suggestion_id?: unknown; picked?: unknown } | null = null;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const id = String(raw?.suggestion_id || '');
  const picked = Number(raw?.picked);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(picked) || picked < 0 || picked > 9) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  await recordPick(got.conv.id, id, picked);
  return NextResponse.json({ ok: true });
}
