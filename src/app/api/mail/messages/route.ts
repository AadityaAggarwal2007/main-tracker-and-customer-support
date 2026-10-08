import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { listMails } from '@/lib/chat/mail-inbox';

// GET /api/mail/messages?box=<mailbox id>: the last 30 days of that Gmail inbox, unread first, read live from
// Gmail and stored nowhere.
export async function GET(request: NextRequest) {
  const a = await mailAccess(request, new URL(request.url).searchParams.get('box'), 'view');
  if ('error' in a) return a.error;
  try {
    const r = await listMails(a.box);
    return NextResponse.json({ ...r, mailbox: a.box.email }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return mailFail(e); }
}
