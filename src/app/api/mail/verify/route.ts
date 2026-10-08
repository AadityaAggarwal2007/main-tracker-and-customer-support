import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { removeVerification, verifySender } from '@/lib/chat/mail-verify';

// POST /api/mail/verify { box, email, orderId, phone }: a team member with Mail access verifies a Gmail sender
// for an order. The Order ID and the FULL phone the customer wrote must both match one order of the panel
// (the chat's own rule); nothing else verifies. The phone is checked and dropped, never stored or returned.
// POST /api/mail/verify { box, email, orderId, remove: true }: takes a wrong verification back.
export async function POST(request: NextRequest) {
  let body: { box?: string; email?: unknown; orderId?: unknown; phone?: unknown; remove?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const a = await mailAccess(request, body.box ?? null, 'view');
  if ('error' in a) return a.error;
  try {
    if (body.remove === true) {
      const r = await removeVerification(a.user, a.box, body.email, body.orderId);
      return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status || 400 });
    }
    const r = await verifySender(a.user, a.box, body.email, body.orderId, body.phone);
    if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, orderId: r.orderId, customerName: r.customerName, chats: r.chats });
  } catch (e) { return mailFail(e); }
}
