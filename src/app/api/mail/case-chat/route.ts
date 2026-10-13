import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { ensureMailCaseChat } from '@/lib/chat/mail-case-chat';
import { looksLikeAddress, lowerEmail } from '@/lib/chat/mail-verify';
import { can } from '@/lib/permissions';

// POST /api/mail/case-chat {box, email, orderId}: the verified sender's email chat for that order, found or made
// (mail-case-chat.ts), so Refund / Ship again from the Mail tab always has a chat to mark (owner 2026-10-13). The same
// rights as the buttons (chat.view + chat.cases, the mailbox's panel); the PATCH that follows checks them again.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const email = lowerEmail(body.email);
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!looksLikeAddress(email) || !orderId) return NextResponse.json({ error: 'email and orderId required' }, { status: 400 });
  const a = await mailAccess(request, typeof body.box === 'string' ? body.box : null, 'view');
  if ('error' in a) return a.error;
  if (!can(a.user, 'chat.view') || !can(a.user, 'chat.cases')) {
    return NextResponse.json({ error: 'Ask the Super Admin to tick "Refund / Ship again" for you in Team.' }, { status: 403 });
  }
  try {
    const r = await ensureMailCaseChat(a.box, email, orderId);
    if (!('chatId' in r)) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ chatId: r.chatId, created: r.created });
  } catch (e) { return mailFail(e); }
}
