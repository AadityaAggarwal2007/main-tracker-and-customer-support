import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { threadFor } from '@/lib/chat/mail-cache';
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
    // The server's copy (mail-cache.ts threadFor): at once when it has one, read again behind the screen when older than a
    // minute; fresh=1 (after a reply) reads Gmail now. Its own Gmail connection (slot 'thread').
    const { items, cached } = await threadFor(a.box, address, { fresh: sp.get('fresh') === '1' });
    return NextResponse.json({ items, cached }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return mailFail(e); }
}
