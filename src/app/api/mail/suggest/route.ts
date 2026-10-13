import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { mailSuggestContext } from '@/lib/chat/mail-suggest';
import { suggestReplies } from '@/lib/chat/suggest-run';
import { staffActor } from '@/lib/chat/team-routing';

export const dynamic = 'force-dynamic';

// POST /api/mail/suggest {box, uid, lang?: 'auto'|'en'|'hi', refresh?}: three draft replies for the open mail (owner
// 2026-10-13: the team kept pasting mails into ChatGPT). The same drafting and guards as Chat Support's Suggestions
// (suggest-run.ts), fed with the mail conversation (mail-suggest.ts). Mail reply access; nothing is sent.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const a = await mailAccess(request, typeof body.box === 'string' ? body.box : null, 'reply');
  if ('error' in a) return a.error;
  const uid = Number(body.uid);
  if (!Number.isInteger(uid) || uid <= 0) return NextResponse.json({ error: 'uid required' }, { status: 400 });
  const lang = body.lang === 'en' || body.lang === 'hi' ? body.lang : 'auto';
  try {
    const ctx = await mailSuggestContext(a.box, uid);
    if (!ctx) return NextResponse.json({ error: 'This mail is still being copied from Gmail. Try again in a minute.' }, { status: 409 });
    const out = await suggestReplies(ctx.conv, staffActor(a.user)?.key || a.user.username, lang, body.refresh === true, ctx.src, { wrap: body.wrap !== false });
    if ('error' in out) return NextResponse.json({ error: out.error }, { status: 502 });
    return NextResponse.json({ options: out.options, lang: out.lang, cached: out.cached, verified: !!ctx.src.orderId });
  } catch (e) { return mailFail(e); }
}
