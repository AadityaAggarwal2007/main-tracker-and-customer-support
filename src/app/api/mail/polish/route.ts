import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { mailSuggestContext } from '@/lib/chat/mail-suggest';
import { POLISH_MAX_CHARS } from '@/lib/chat/suggest';
import { polishDraft } from '@/lib/chat/suggest-run';
import { staffActor } from '@/lib/chat/team-routing';
import { hasFormLink } from '@/lib/refund/link-mask';

export const dynamic = 'force-dynamic';

// POST /api/mail/polish {box, uid, text}: "Sudharo" in the Mail tab (owner 2026-10-13): the team member's own reply with
// its spelling and grammar fixed and nothing else changed (suggest-run.ts polishDraft, the same as in Chat Support).
// Mail reply access; nothing is sent. A draft with a form link comes back as it is (the send route refuses it anyway).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const a = await mailAccess(request, typeof body.box === 'string' ? body.box : null, 'reply');
  if ('error' in a) return a.error;
  const text = String(body.text ?? '').trim();
  if (!text) return NextResponse.json({ error: 'text required' }, { status: 400 });
  if (text.length > POLISH_MAX_CHARS) return NextResponse.json({ error: `Keep it under ${POLISH_MAX_CHARS} characters` }, { status: 400 });
  if (hasFormLink(text)) return NextResponse.json({ text, changed: false });
  try {
    const uid = Number(body.uid);
    const ctx = Number.isInteger(uid) && uid > 0 ? await mailSuggestContext(a.box, uid).catch(() => null) : null;
    const conv = ctx?.conv || { id: `mail:${a.box.id}:polish`, site_id: '', tracker_business_id: a.box.panelId, source: 'email', status: 'agent_handling', verified_order_id: null, phone_match_order_id: null, case_kind: null };
    const out = await polishDraft(conv, staffActor(a.user)?.key || a.user.username, text, ctx?.src || { rows: [], orderId: null }, { wrap: body.wrap !== false, lang: body.lang === 'en' || body.lang === 'hi' ? body.lang : 'auto' });
    return NextResponse.json({ text: out, changed: out !== text });
  } catch (e) { return mailFail(e); }
}
