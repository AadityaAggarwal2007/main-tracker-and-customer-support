import { NextRequest, NextResponse } from 'next/server';
import { mailUser, mailFail } from '@/lib/chat/mail-access';
import { listMails, mailboxesForSite } from '@/lib/chat/mail-inbox';
import { verifiedEmailsForChat } from '@/lib/chat/mail-verify';
import { can, canAccessPanel } from '@/lib/permissions';

// GET /api/mail/by-chat?conversationId=<id>: the emails (last 30 days, live from Gmail) of the addresses verified
// for this chat's verified order. Only for a login with Open Mail AND Chat Support, for a panel it may use. It is
// asked for when someone presses "Emails" in the thread, never by the thread's own polling.
export async function GET(request: NextRequest) {
  const a = mailUser(request, 'view');
  if ('error' in a) return a.error;
  if (!can(a.user, 'chat.view')) return NextResponse.json({ error: 'You do not have access to Mail.' }, { status: 403 });
  const id = new URL(request.url).searchParams.get('conversationId') || '';
  if (!/^[\w-]{6,80}$/.test(id)) return NextResponse.json({ error: 'conversationId required' }, { status: 400 });
  try {
    const info = await verifiedEmailsForChat(id);
    if (!info || !canAccessPanel(a.user, info.businessId)) return NextResponse.json({ error: 'Chat not found.' }, { status: 404 });
    if (!info.orderId) return NextResponse.json({ orderId: null, emails: [], mails: [] });
    const boxes = (await mailboxesForSite(a.user, info.siteId)).slice(0, 3);
    const mails: Array<Record<string, unknown>> = [];
    let failed = 0;
    for (const box of boxes) {
      for (const email of info.emails.slice(0, 3)) {
        try {
          const r = await listMails(box, Date.now(), { from: email });
          for (const m of r.mails) mails.push({ ...m, boxId: box.id });
        } catch { failed += 1; }
      }
    }
    mails.sort((x, y) => (Date.parse(String(y.date)) || 0) - (Date.parse(String(x.date)) || 0));
    return NextResponse.json({ orderId: info.orderId, emails: info.emails, mails: mails.slice(0, 15), hasMailbox: boxes.length > 0, failed }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return mailFail(e); }
}
