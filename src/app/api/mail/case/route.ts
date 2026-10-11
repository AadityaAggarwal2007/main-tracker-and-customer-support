import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { looksLikeAddress, lowerEmail } from '@/lib/chat/mail-verify';
import { setMailCase } from '@/lib/chat/mail-cases';

// POST /api/mail/case { box, address, action: 'close' | 'reopen' } (owner 2026-10-11 afternoon, "active case aur close case"):
// closes or reopens a customer's case in this mailbox. Same access as sending a reply (mail.view + mail.reply, the mailbox's
// panel). Nothing is sent to the customer; the state is the pure rule in mail-filters.ts (a customer who writes again after a
// close is Active by himself), so right after a close the case is closed and after a reopen it is active.
export async function POST(request: NextRequest) {
  let body: { box?: string; address?: unknown; action?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const address = lowerEmail(body.address);
  const action = body.action === 'close' || body.action === 'reopen' ? body.action : null;
  if (!looksLikeAddress(address) || !action) return NextResponse.json({ error: 'address and action (close or reopen) are required' }, { status: 400 });
  const a = await mailAccess(request, body.box ?? null, 'reply');
  if ('error' in a) return a.error;
  try {
    const c = await setMailCase(a.box.id, address, action, a.user);
    return NextResponse.json({ ok: true, address, case: c, state: action === 'close' ? 'closed' : 'active' });
  } catch (e) { return mailFail(e); }
}
