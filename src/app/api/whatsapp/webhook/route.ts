import { NextRequest, NextResponse } from 'next/server';
import { parseWaWebhook, waSignatureOk } from '@/lib/chat/whatsapp';
import { storeWaInbound, storeWaStatus } from '@/lib/chat/whatsapp-inbound';
import { noteWebhookOk, noteWebhookRefused } from '@/lib/chat/whatsapp-webhook-status';
import { sendWaAutoReply } from '@/lib/chat/whatsapp-autoreply';

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
    const why = request.headers.get('x-hub-signature-256') ? 'the signature does not match WHATSAPP_APP_SECRET' : 'the call carried no signature';
    noteWebhookRefused(why);
    console.error(`[whatsapp] webhook refused: ${why} (check that WHATSAPP_APP_SECRET is the App secret of the app "ship track msg")`);
    return NextResponse.json({ error: 'Bad signature' }, { status: 403 });
  }
  noteWebhookOk();
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  const { messages, statuses } = parseWaWebhook(body);
  let stored = 0, duplicates = 0, reports = 0, replied = 0;
  for (const m of messages) {
    try {
      const r = await storeWaInbound(m);
      if (r.outcome === 'stored') {
        stored++;
        // one fixed reply: this number only sends order updates, help is by email (whatsapp-autoreply.ts)
        if (r.conversationId && Date.now() - m.timestamp < 6 * 3_600_000) {
          try { if ((await sendWaAutoReply(r.conversationId, m.from)) === 'sent') replied++; }
          catch (err) { console.error('[whatsapp] auto reply:', (err as Error).message); }
        }
      }
      else if (r.outcome === 'duplicate') duplicates++;
      else console.error('[whatsapp] no panel for the WhatsApp chats: set WHATSAPP_PANEL_ID or a default panel');
    } catch (err) {
      console.error('[whatsapp] could not store a message:', (err as Error).message);
    }
  }
  for (const s of statuses) {
    try { if (await storeWaStatus(s)) reports++; } catch (err) { console.error('[whatsapp] could not store a delivery report:', (err as Error).message); }
  }
  if (messages.length || statuses.length) console.log(`[whatsapp] webhook: ${stored} stored, ${replied} auto replies, ${duplicates} repeated, ${reports} delivery reports`);
  return NextResponse.json({ ok: true, stored, duplicates, reports });
}
