import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { requestDisplayName } from '@/lib/chat/whatsapp-profile';

export const dynamic = 'force-dynamic';

// POST { name }: asks Meta to change the name customers see on the number (Meta reviews it). Super Admin only.
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { name?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  const r = await requestDisplayName(String(body.name ?? ''));
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: /3 to 75/.test(r.error) ? 400 : 502 });
  return NextResponse.json({ ok: true });
}
