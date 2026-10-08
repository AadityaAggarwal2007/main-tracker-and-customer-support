import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { listMails } from '@/lib/chat/mail-inbox';
import { verifiedSenders } from '@/lib/chat/mail-verify';
import { autoVerifySenders } from '@/lib/chat/mail-auto-verify';
import { can } from '@/lib/permissions';

// GET /api/mail/messages?box=<mailbox id>: the last 30 days of that Gmail inbox, unread first, read live from
// Gmail and stored nowhere. `verified` says which senders a team member has verified for an order (mail-verify.ts),
// with the customer's chat to open (only for a login that may open Chat Support).
export async function GET(request: NextRequest) {
  const a = await mailAccess(request, new URL(request.url).searchParams.get('box'), 'view');
  if ('error' in a) return a.error;
  try {
    const r = await listMails(a.box);
    // Step 1 / 2 of the automatic verification (mail-auto-verify.ts): a sender whose address is on one of this
    // panel's orders and whose mail Gmail itself marked dmarc=pass is verified before the team has to.
    await autoVerifySenders(a.box.panelId, r.mails.map(m => ({ email: m.fromAddress, authPass: m.authPass, subject: m.subject })));
    const verified = await verifiedSenders(a.box.panelId, r.mails.map(m => m.fromAddress));
    if (!can(a.user, 'chat.view')) for (const list of Object.values(verified)) for (const v of list) v.chatId = null;
    return NextResponse.json({ ...r, mailbox: a.box.email, verified }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return mailFail(e); }
}
