import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { waConfigured } from '@/lib/chat/whatsapp';
import { setWabaId, wabaId } from '@/lib/chat/whatsapp-settings';
import { waPanelId } from '@/lib/chat/whatsapp-inbound';
import { queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

// ── Settings > WhatsApp (Super Admin): what is set up, and the WhatsApp Business Account id ──
// GET   { configured, verifyTokenSet, appSecretSet, phoneNumberId, waba, panel }  (never the token)
// POST  { waba }   save the account id (digits), '' clears it
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const panelId = await waPanelId().catch(() => null);
  const panel = panelId ? await queryOne<{ name: string }>(`SELECT name FROM businesses WHERE id::text = $1`, [panelId]).catch(() => null) : null;
  return NextResponse.json({
    configured: waConfigured(),
    verifyTokenSet: !!process.env.WHATSAPP_VERIFY_TOKEN,
    appSecretSet: !!process.env.WHATSAPP_APP_SECRET,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    waba: await wabaId(),
    wabaFromEnv: !!process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    panel: panel ? { id: panelId, name: panel.name } : null,
    webhookUrl: '/api/whatsapp/webhook',
  });
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { waba?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  const waba = String(body.waba ?? '').replace(/\D/g, '');
  if (waba && !/^\d{6,30}$/.test(waba)) return NextResponse.json({ error: 'The account id is a number of 6 to 30 digits' }, { status: 400 });
  try {
    await setWabaId(waba);
  } catch (e) {
    console.error('[whatsapp] waba save:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save it (chat_settings: run chat-settings.sql for the GRANT)' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, waba });
}
