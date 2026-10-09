import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { can, canAccessPanel } from '@/lib/permissions';
import { POLISH_MAX_CHARS } from '@/lib/chat/suggest';
import { polishDraft, type SuggestConv } from '@/lib/chat/suggest-run';
import { staffActor } from '@/lib/chat/team-routing';
import { hasFormLink } from '@/lib/refund/link-mask';

export const dynamic = 'force-dynamic';

// ── POST /api/chat/polish { conversationId, text } ("Sudharo", owner 2026-10-04) ──────────
// The team member's own draft comes back with its spelling and grammar fixed and nothing else
// changed (suggest.ts POLISH_INSTRUCTION, acceptPolish). Logins that may reply, inside their
// panels, on a chat conversation (not email). Nothing is sent to the customer: the team member
// still presses Send. A draft with a form link is returned as it is (the reply route refuses it).
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.view') || !can(user, 'chat.reply')) return NextResponse.json({ error: 'You cannot reply' }, { status: 403 });
  let raw: { conversationId?: unknown; text?: unknown } | null = null;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const conversationId = String(raw?.conversationId || '');
  const text = String(raw?.text ?? '').trim();
  if (!conversationId || !text) return NextResponse.json({ error: 'conversationId and text required' }, { status: 400 });
  if (text.length > POLISH_MAX_CHARS) return NextResponse.json({ error: `Keep it under ${POLISH_MAX_CHARS} characters` }, { status: 400 });

  const conv = await queryOne<SuggestConv>(
    `SELECT c.id, c.site_id, s.tracker_business_id, c.source, c.status, c.verified_order_id, c.phone_match_order_id, c.case_kind
       FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = $1`,
    [conversationId]
  );
  if (!conv || !canAccessPanel(user, conv.tracker_business_id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (conv.source !== 'chat' && conv.source !== 'email') return NextResponse.json({ error: 'Sudharo works in chat and email conversations only' }, { status: 409 });
  if (hasFormLink(text)) return NextResponse.json({ text });

  try {
    const out = await polishDraft(conv, staffActor(user)?.key || user.username, text);
    return NextResponse.json({ text: out, changed: out !== text });
  } catch (err) {
    console.error('[chat/polish] error:', (err as Error)?.message);
    return NextResponse.json({ text, changed: false });
  }
}
