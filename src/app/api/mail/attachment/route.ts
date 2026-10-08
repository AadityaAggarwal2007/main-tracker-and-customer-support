import { NextRequest, NextResponse } from 'next/server';
import { mailAccess, mailFail } from '@/lib/chat/mail-access';
import { attachmentBytes } from '@/lib/chat/mail-inbox';
import { parseUid } from '@/lib/chat/mail-view';

// GET /api/mail/attachment?box=&uid=&index=: one attachment as a DOWNLOAD (always octet-stream + attachment,
// never shown as a page, so a mail's file can never run inside ShipTrack).
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const uid = parseUid(sp.get('uid'));
  const index = Number(sp.get('index'));
  if (!uid || !Number.isInteger(index) || index < 0) return NextResponse.json({ error: 'uid and index required' }, { status: 400 });
  const a = await mailAccess(request, sp.get('box'), 'view');
  if ('error' in a) return a.error;
  try {
    const f = await attachmentBytes(a.box, uid, index);
    if (!f) return NextResponse.json({ error: 'Attachment not found.' }, { status: 404 });
    const safe = f.filename.replace(/[\r\n"\\/]/g, '_');
    return new NextResponse(new Uint8Array(f.content), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) { return mailFail(e); }
}
