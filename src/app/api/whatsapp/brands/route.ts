import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { cleanBrand, loadBrands, saveBrand } from '@/lib/chat/whatsapp-brands';

export const dynamic = 'force-dynamic';

// ── Each brand's name and support email inside WhatsApp templates (whatsapp-brands.ts), Super Admin only ──
// GET   { brands: [{ id, panel, name, email, savedName, savedEmail, supportGmail }] }  every panel, the same for all
// POST  { businessId, name, email }   save one brand's words
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ brands: await loadBrands() });
  } catch (e) {
    console.error('[whatsapp] brands:', (e as Error).message);
    return NextResponse.json({ brands: [], error: 'Could not read the brands' });
  }
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { businessId?: unknown; name?: unknown; email?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  const id = String(body.businessId ?? '');
  const brands = await loadBrands().catch(() => []);
  if (!brands.some((b) => b.id === id)) return NextResponse.json({ error: 'Unknown panel' }, { status: 404 });
  const c = cleanBrand(body);
  if ('error' in c) return NextResponse.json({ error: c.error }, { status: 400 });
  try {
    await saveBrand(id, c.name, c.email);
  } catch (e) {
    console.error('[whatsapp] brand save:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save it (chat_settings: run chat-settings.sql for the GRANT)' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, name: c.name, email: c.email });
}
