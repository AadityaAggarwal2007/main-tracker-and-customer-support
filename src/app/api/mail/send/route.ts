import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { sendMailReply } from '@/lib/chat/mail-inbox';
import { cleanReply, parseUid } from '@/lib/chat/mail-view';
import { hasFormLink } from '@/lib/refund/link-mask';
import { stripLinkJunk } from '@/lib/chat/reply-guards';

// POST /api/mail/send { box, uid, text }: a reply to one mail, from that Gmail address. Same two rules as a
// chat reply by the team: no Google Form / refund-form link (the refund form is the Super Admin's own button
// in Chat Support), and copy-paste tracking junk (utm_*, fbclid ...) is cut from links.
export async function POST(request: NextRequest) {
  let body: { box?: string; uid?: unknown; text?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const uid = parseUid(body.uid);
  if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 });
  const clean = cleanReply(body.text);
  if ('error' in clean) return NextResponse.json({ error: clean.error }, { status: 400 });
  const a = await mailAccess(request, body.box ?? null, 'reply');
  if ('error' in a) return a.error;
  if (hasFormLink(clean.text)) {
    return NextResponse.json({ error: "Refund forms go only through 'Send refund form' (Super Admin, Refund section). Remove the form link." }, { status: 403 });
  }
  try {
    const sent = await sendMailReply(a.box, uid, stripLinkJunk(clean.text).text);
    return NextResponse.json({ ok: true, to: sent.to });
  } catch (e) { return mailFail(e); }
}
