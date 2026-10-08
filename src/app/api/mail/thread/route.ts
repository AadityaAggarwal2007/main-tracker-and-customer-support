import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { listThread } from '@/lib/chat/mail-inbox';
import { looksLikeAddress, lowerEmail } from '@/lib/chat/mail-verify';

// GET /api/mail/thread?box=&address=: the conversation with one address (last 30 days): what it sent to this Gmail and
// what this Gmail sent to it, oldest first, headers only. A body is read through /api/mail/message (folder=sent for ours).
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const address = lowerEmail(sp.get('address'));
  if (!looksLikeAddress(address)) return NextResponse.json({ error: 'address required' }, { status: 400 });
  const a = await mailAccess(request, sp.get('box'), 'view');
  if ('error' in a) return a.error;
  try {
    const items = await listThread(a.box, address);
    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return mailFail(e); }
}
