import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { getProfile, profileSpec, updateProfile, VERTICALS } from '@/lib/chat/whatsapp-profile';

export const dynamic = 'force-dynamic';

// ── The WhatsApp business profile (src/lib/chat/whatsapp-profile.ts), Super Admin only ──
// GET   { profile, verticals }      POST { about, description, address, email, websites[], vertical }
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await getProfile();
  if ('error' in r) return NextResponse.json({ profile: null, error: r.error, verticals: VERTICALS });
  return NextResponse.json({ profile: r.value, verticals: VERTICALS });
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  const spec = profileSpec({
    about: String(body.about ?? ''), description: String(body.description ?? ''), address: String(body.address ?? ''), email: String(body.email ?? ''),
    websites: Array.isArray(body.websites) ? body.websites.map((w) => String(w ?? '')) : [], vertical: String(body.vertical ?? ''),
  });
  if ('error' in spec) return NextResponse.json({ error: spec.error }, { status: 400 });
  const r = await updateProfile(spec.body);
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: 502 });
  return NextResponse.json({ ok: true });
}
