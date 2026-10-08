import { NextRequest, NextResponse } from 'next/server';
import { mailUser, mailFail } from '@/lib/chat/mail-access';
import { mailboxesFor } from '@/lib/chat/mail-inbox';
import { getMailboxStatus } from '@/lib/chat/mailbox-status';
import { can } from '@/lib/permissions';

// GET /api/mail/boxes: the Gmail mailboxes this login may open in the Mail tab (never the App Password).
export async function GET(request: NextRequest) {
  const a = mailUser(request, 'view');
  if ('error' in a) return a.error;
  try {
    const boxes = await mailboxesFor(a.user);
    return NextResponse.json({
      canReply: can(a.user, 'mail.reply'),
      boxes: boxes.map(b => ({ ...b, status: getMailboxStatus(b.id) })),
    });
  } catch (e) { return mailFail(e); }
}
