import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { PICTURE_MAX_BYTES, pictureMime, uploadProfilePicture } from '@/lib/chat/whatsapp-profile';
import { appId } from '@/lib/chat/whatsapp-settings';

export const dynamic = 'force-dynamic';

// POST multipart { picture }: a JPG / PNG up to 5 MB becomes the WhatsApp profile picture (Super Admin only).
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let form: FormData;
  try { form = await request.formData(); } catch { return NextResponse.json({ error: 'Could not read that upload' }, { status: 400 }); }
  const file = form.get('picture');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'Pick a picture' }, { status: 400 });
  if (file.size > PICTURE_MAX_BYTES) return NextResponse.json({ error: 'The picture is over 5 MB' }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = pictureMime(bytes);
  if (!mime) return NextResponse.json({ error: 'JPG or PNG only' }, { status: 400 });
  const app = await appId();
  const r = await uploadProfilePicture(app, bytes, mime);
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.error.startsWith('Set the Meta App id') ? 400 : 502 });
  return NextResponse.json({ ok: true });
}
