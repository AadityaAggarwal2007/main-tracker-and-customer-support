import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { can, isSuperAdmin } from '@/lib/permissions';
import { query } from '@/lib/db';
import { sendWhatsAppTemplate, waDigits } from '@/lib/chat/whatsapp';
import { waConversationFor } from '@/lib/chat/whatsapp-inbound';
import { listTemplates, renderTemplate } from '@/lib/chat/whatsapp-templates';
import { wabaId } from '@/lib/chat/whatsapp-settings';
import { staffActor } from '@/lib/chat/team-routing';

export const dynamic = 'force-dynamic';

// ── Start a WhatsApp conversation from ShipTrack (owner 2026-10-10: "whatsapp first message template") ──
// POST { to, template, language?, params[] }: the only way to write first is an APPROVED template, so the
// template is checked against the account's list, sent, and the chat appears in Chat Support (With team) with
// the filled-in text as the team's message. Anyone who may reply in chats; the chat lands on the WhatsApp panel.
const NAME_RE = /^[a-z0-9_]{1,512}$/;

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSuperAdmin(user) && !can(user, 'chat.reply')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  const digits = waDigits(body.to);
  if (!digits) return NextResponse.json({ error: 'Type the customer\'s WhatsApp number with the country code (10 digits = India)' }, { status: 400 });
  const name = String(body.template ?? '');
  if (!NAME_RE.test(name)) return NextResponse.json({ error: 'Pick a template' }, { status: 400 });
  const params = Array.isArray(body.params) ? (body.params as unknown[]).slice(0, 20).map((v) => String(v ?? '').trim().slice(0, 1024)) : [];

  const waba = await wabaId();
  if (!waba) return NextResponse.json({ error: 'Set the WhatsApp Business Account id in Settings > WhatsApp' }, { status: 400 });
  const list = await listTemplates(waba);
  if ('error' in list) return NextResponse.json({ error: list.error }, { status: 502 });
  const wantLang = typeof body.language === 'string' ? body.language : '';
  const tpl = list.value.find((t) => t.name === name && t.status === 'APPROVED' && (!wantLang || t.language === wantLang))
    || list.value.find((t) => t.name === name && t.status === 'APPROVED');
  if (!tpl) return NextResponse.json({ error: 'That template is not approved yet (Meta reviews it first)' }, { status: 400 });
  if (params.length < tpl.vars || params.slice(0, tpl.vars).some((p) => !p)) return NextResponse.json({ error: `Fill every value (${tpl.vars})` }, { status: 400 });

  const conv = await waConversationFor(digits, null).catch((e) => { console.error('[whatsapp] start chat:', (e as Error).message); return null; });
  if (!conv) return NextResponse.json({ error: 'No panel for WhatsApp chats (set WHATSAPP_PANEL_ID or a default panel)' }, { status: 500 });

  const r = await sendWhatsAppTemplate(digits, tpl.name, tpl.language, params.slice(0, tpl.vars));
  const text = renderTemplate(tpl, params);
  const actor = staffActor(user);
  const metadata = {
    agent: actor?.name || user.username, wa_template: tpl.name, wa_sent: r.ok,
    ...('id' in r && r.id ? { wa_id: r.id } : {}), ...('error' in r ? { wa_error: r.error } : {}),
  };
  try {
    await query(
      `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
       VALUES (gen_random_uuid()::text, $1, 'agent', $2, $3::jsonb, now())`,
      [conv.id, text, JSON.stringify(metadata)]
    );
    await query(`UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [conv.id]);
  } catch (e) {
    console.error('[whatsapp] start chat record:', (e as Error).message);
  }
  if ('error' in r) return NextResponse.json({ error: `WhatsApp did not take it: ${r.error}`, conversationId: conv.id }, { status: 502 });
  return NextResponse.json({ ok: true, conversationId: conv.id, text });
}
