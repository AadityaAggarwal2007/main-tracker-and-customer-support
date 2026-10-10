import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { waConfigured } from '@/lib/chat/whatsapp';
import { webhookStatus } from '@/lib/chat/whatsapp-webhook-status';
import { appId, messagingId, setAppId, setMessagingId, setWabaId, wabaId } from '@/lib/chat/whatsapp-settings';
import { getPhone } from '@/lib/chat/whatsapp-profile';
import { waPanelId } from '@/lib/chat/whatsapp-inbound';
import { queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

// ── Settings > WhatsApp (Super Admin): what is set up, and the WhatsApp Business Account id ──
// GET   { configured, verifyTokenSet, appSecretSet, phoneNumberId, waba, appId, panel, phone }  (never the token; phone = the number's live state)
// POST  { waba?, appId? }   save the account id / the Meta app id (digits), '' clears
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const panelId = await waPanelId().catch(() => null);
  const panel = panelId ? await queryOne<{ name: string }>(`SELECT name FROM businesses WHERE id::text = $1`, [panelId]).catch(() => null) : null;
  const phone = waConfigured() ? await getPhone().catch(() => null) : null;
  return NextResponse.json({
    phone: phone && 'value' in phone ? phone.value : null,
    phoneError: phone && 'error' in phone ? phone.error : null,
    appId: await appId(),
    configured: waConfigured(),
    verifyTokenSet: !!process.env.WHATSAPP_VERIFY_TOKEN,
    appSecretSet: !!process.env.WHATSAPP_APP_SECRET,
    webhook: webhookStatus(),
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    waba: await wabaId(),
    messaging: await messagingId(),
    wabaFromEnv: !!process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    panel: panel ? { id: panelId, name: panel.name } : null,
    webhookUrl: '/api/whatsapp/webhook',
  });
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { waba?: unknown; appId?: unknown; messagingId?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  const out: Record<string, string> = {};
  try {
    if (body.waba !== undefined) {
      const waba = String(body.waba ?? '').replace(/\D/g, '');
      if (waba && !/^\d{6,30}$/.test(waba)) return NextResponse.json({ error: 'The account id is a number of 6 to 30 digits' }, { status: 400 });
      await setWabaId(waba); out.waba = waba;
    }
    if (body.messagingId !== undefined) {
      const id = String(body.messagingId ?? '').replace(/\D/g, '');
      if (id && !/^\d{6,30}$/.test(id)) return NextResponse.json({ error: 'The messaging account id is a number of 6 to 30 digits' }, { status: 400 });
      await setMessagingId(id); out.messaging = id;
    }
    if (body.appId !== undefined) {
      const id = String(body.appId ?? '').replace(/\D/g, '');
      if (id && !/^\d{6,30}$/.test(id)) return NextResponse.json({ error: 'The app id is a number of 6 to 30 digits' }, { status: 400 });
      await setAppId(id); out.appId = id;
    }
  } catch (e) {
    console.error('[whatsapp] settings save:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save it (chat_settings: run chat-settings.sql for the GRANT)' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...out });
}
