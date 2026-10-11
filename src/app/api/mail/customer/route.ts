import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { loadMailCustomer } from '@/lib/chat/mail-customer';
import { looksLikeAddress, lowerEmail } from '@/lib/chat/mail-verify';
import { can } from '@/lib/permissions';

// GET /api/mail/customer?box=&email=: the "Customer" card next to the open mail (owner 2026-10-11): the sender's verified
// order(s) with their facts, items, place, payment and chat, or, not verified, the orders of this panel placed with that
// email address as hints. The mailbox's own panel; order data only for a login with orders.view, the chat id only with
// chat.view. Read only.
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const email = lowerEmail(sp.get('email'));
  if (!looksLikeAddress(email)) return NextResponse.json({ error: 'email required' }, { status: 400 });
  const a = await mailAccess(request, sp.get('box'), 'view');
  if ('error' in a) return a.error;
  try {
    const customer = await loadMailCustomer(a.box.panelId, email, { orders: can(a.user, 'orders.view'), chat: can(a.user, 'chat.view') });
    return NextResponse.json({ customer }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return mailFail(e); }
}
