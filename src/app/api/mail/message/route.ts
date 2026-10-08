import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { readMail, setSeen } from '@/lib/chat/mail-inbox';
import { parseUid } from '@/lib/chat/mail-view';

// GET /api/mail/message?box=&uid=[&images=1][&peek=1]: opens one mail. It is marked read in Gmail, like opening
// it in Gmail, unless peek=1. The HTML comes back already wrapped for a sandboxed frame (mail-view.ts).
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const uid = parseUid(sp.get('uid'));
  if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 });
  const a = await mailAccess(request, sp.get('box'), 'view');
  if ('error' in a) return a.error;
  try {
    const mail = await readMail(a.box, uid, { markRead: sp.get('peek') !== '1', images: sp.get('images') === '1' });
    if (!mail) return NextResponse.json({ error: 'That mail is no longer in the inbox.' }, { status: 404 });
    return NextResponse.json({ mail }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return mailFail(e); }
}

// PATCH /api/mail/message { box, uid, seen: boolean }: "Mark unread" / "Mark read" in Gmail.
export async function PATCH(request: NextRequest) {
  let body: { box?: string; uid?: unknown; seen?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const uid = parseUid(body.uid);
  if (!uid || typeof body.seen !== 'boolean') return NextResponse.json({ error: 'uid and seen (true or false) are required' }, { status: 400 });
  const a = await mailAccess(request, body.box ?? null, 'view');
  if ('error' in a) return a.error;
  try {
    await setSeen(a.box, uid, body.seen);
    return NextResponse.json({ ok: true, seen: body.seen });
  } catch (e) { return mailFail(e); }
}
