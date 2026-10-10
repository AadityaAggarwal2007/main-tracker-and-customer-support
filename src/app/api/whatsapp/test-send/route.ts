import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { query } from '@/lib/db';
import { sendWhatsAppText, waDigits } from '@/lib/chat/whatsapp';
import { waConversationFor } from '@/lib/chat/whatsapp-inbound';
import { staffActor } from '@/lib/chat/team-routing';

export const dynamic = 'force-dynamic';

// ── The WhatsApp tab's Test screen: a plain text to a number (Super Admin only) ──
// POST { to, text }: goes through the same Cloud API call as a team reply, so it works only when that number wrote
// to us in the last 24 hours (otherwise Meta answers 131047 and the Send tab's template is the way). The message
// is saved on the number's chat (made if it has none; With team) as the team's message with Meta's answer, so the
// Test screen, the inbox and the delivery reports (webhook) all show the same thing.
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { to?: unknown; text?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  const digits = waDigits(body.to);
  if (!digits) return NextResponse.json({ error: 'Type the WhatsApp number (10 digits = India)' }, { status: 400 });
  const text = String(body.text ?? '').trim().slice(0, 4000);
  if (!text) return NextResponse.json({ error: 'Write a message' }, { status: 400 });

  const conv = await waConversationFor(digits, null).catch((e) => { console.error('[whatsapp] test chat:', (e as Error).message); return null; });
  if (!conv) return NextResponse.json({ error: 'No panel for WhatsApp chats (set WHATSAPP_PANEL_ID or a default panel)' }, { status: 500 });

  const r = await sendWhatsAppText(digits, text);
  const actor = staffActor(user);
  const metadata = {
    agent: actor?.name || user.username, wa_sent: r.ok, test: true,
    ...(r.ok && r.id ? { wa_id: r.id } : {}), ...('error' in r ? { wa_error: r.error } : {}),
  };
  try {
    await query(
      `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
       VALUES (gen_random_uuid()::text, $1, 'agent', $2, $3::jsonb, now())`,
      [conv.id, text, JSON.stringify(metadata)]
    );
    await query(`UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [conv.id]);
  } catch (e) {
    console.error('[whatsapp] test record:', (e as Error).message);
  }
  if ('error' in r) return NextResponse.json({ error: r.error, code: r.code, conversationId: conv.id }, { status: 502 });
  return NextResponse.json({ ok: true, conversationId: conv.id, id: r.id });
}
