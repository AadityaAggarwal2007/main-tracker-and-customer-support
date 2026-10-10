import { NextRequest, NextResponse } from 'next/server';
import { parseWaWebhook, waSignatureOk } from '@/lib/chat/whatsapp';
import { storeWaInbound, storeWaStatus } from '@/lib/chat/whatsapp-inbound';

export const dynamic = 'force-dynamic';

// ── Meta's webhook for the WhatsApp business number (src/lib/chat/whatsapp.ts) ──
// Callback URL in the Meta app: https://shiptrack.store/api/whatsapp/webhook, field `messages`.
// GET is Meta's one-time verify call: it must get the challenge back when the verify token matches.
// POST brings customer messages and delivery reports; Meta wants a 200 within seconds and resends
// otherwise, so the work is small and a stored wamid is never stored twice. No login (Meta calls it);
// with WHATSAPP_APP_SECRET set, a body whose signature does not match is refused.

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const want = (process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
  const mode = p.get('hub.mode'), token = p.get('hub.verify_token'), challenge = p.get('hub.challenge');
  if (want && mode === 'subscribe' && token === want && challenge != null) {
    return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
}

export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (!waSignatureOk(raw, request.headers.get('x-hub-signature-256'), process.env.WHATSAPP_APP_SECRET)) {
    return NextResponse.json({ error: 'Bad signature' }, { status: 403 });
  }
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  const { messages, statuses } = parseWaWebhook(body);
  let stored = 0, duplicates = 0, reports = 0;
  for (const m of messages) {
    try {
      const r = await storeWaInbound(m);
      if (r.outcome === 'stored') stored++;
      else if (r.outcome === 'duplicate') duplicates++;
      else console.error('[whatsapp] no panel for the WhatsApp chats: set WHATSAPP_PANEL_ID or a default panel');
    } catch (err) {
      console.error('[whatsapp] could not store a message:', (err as Error).message);
    }
  }
  for (const s of statuses) {
    try { if (await storeWaStatus(s)) reports++; } catch (err) { console.error('[whatsapp] could not store a delivery report:', (err as Error).message); }
  }
  if (messages.length || statuses.length) console.log(`[whatsapp] webhook: ${stored} stored, ${duplicates} repeated, ${reports} delivery reports`);
  return NextResponse.json({ ok: true, stored, duplicates, reports });
}
