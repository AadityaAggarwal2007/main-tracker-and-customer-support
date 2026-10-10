import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { checkToken } from '@/lib/chat/whatsapp-diagnose';
import { appId, wabaId } from '@/lib/chat/whatsapp-settings';

export const dynamic = 'force-dynamic';

// GET: what the WhatsApp token on the server can do, in plain words (Super Admin; never the token itself).
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const c = await checkToken(await wabaId(), await appId());
  return NextResponse.json(c);
}
