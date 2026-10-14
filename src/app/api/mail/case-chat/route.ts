import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { ensureMailCaseChat } from '@/lib/chat/mail-case-chat';
import { looksLikeAddress, lowerEmail } from '@/lib/chat/mail-verify';
import { can } from '@/lib/permissions';

// POST /api/mail/case-chat {box, email, orderId, purpose?}: the verified sender's email chat for that order, found or made
// (mail-case-chat.ts), so Refund / Ship again from the Mail tab always has a chat to mark (owner 2026-10-13). The same
// rights as the buttons (chat.view + chat.cases, the mailbox's panel); the PATCH that follows checks them again.
// purpose 'edit' (owner 2026-10-14, Edit address / Edit items from the Mail tab): chat.view + orders.update instead, and
// the chat's status is left alone (a new one is made Closed): only the order is edited, nobody answers in that chat.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const email = lowerEmail(body.email);
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!looksLikeAddress(email) || !orderId) return NextResponse.json({ error: 'email and orderId required' }, { status: 400 });
  const a = await mailAccess(request, typeof body.box === 'string' ? body.box : null, 'view');
  if ('error' in a) return a.error;
  const forEdit = body.purpose === 'edit';
  if (forEdit ? !can(a.user, 'chat.view') || !can(a.user, 'orders.update') : !can(a.user, 'chat.view') || !can(a.user, 'chat.cases')) {
    return NextResponse.json({ error: forEdit ? 'Ask the Super Admin to tick "Update orders" for you in Team.' : 'Ask the Super Admin to tick "Refund / Ship again" for you in Team.' }, { status: 403 });
  }
  try {
    const r = await ensureMailCaseChat(a.box, email, orderId, { reopen: !forEdit });
    if (!('chatId' in r)) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ chatId: r.chatId, created: r.created });
  } catch (e) { return mailFail(e); }
}
