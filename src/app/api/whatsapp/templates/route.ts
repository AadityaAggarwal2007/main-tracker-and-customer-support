import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { can, isSuperAdmin } from '@/lib/permissions';
import { createTemplate, deleteTemplate, listTemplates, templateSpec, updateTemplate, TEMPLATE_CATEGORIES, TEMPLATE_LANGUAGES } from '@/lib/chat/whatsapp-templates';
import { templatesAccount } from '@/lib/chat/whatsapp-settings';

export const dynamic = 'force-dynamic';

// ── WhatsApp message templates (src/lib/chat/whatsapp-templates.ts) ──
// GET     ?approved=1     the account's templates (anyone who may reply in chats: the inbox picks from them; Super Admin: all)
// POST    { name, language, category, header?, body, footer?, examples[] }   make one and send it to Meta for review (Super Admin)
//         + { id }   edit that template instead (its name and language stay; Meta reviews the change)
// DELETE  ?name=          remove one from the account (Super Admin)
// Nothing here stores anything in ShipTrack: Meta's account is the record.

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSuperAdmin(user) && !can(user, 'chat.reply')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const waba = await templatesAccount();
  if (!waba) return NextResponse.json({ templates: [], waba: '', error: 'Set the WhatsApp Business Account id in Settings > WhatsApp' });
  const r = await listTemplates(waba);
  if ('error' in r) return NextResponse.json({ templates: [], waba, error: r.error });
  const approvedOnly = new URL(request.url).searchParams.get('approved') === '1';
  const templates = approvedOnly ? r.value.filter((t) => t.status === 'APPROVED') : r.value;
  return NextResponse.json({ templates, waba, categories: TEMPLATE_CATEGORIES, languages: TEMPLATE_LANGUAGES });
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Super Admin only' }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  const spec = templateSpec({
    name: String(body.name ?? ''), language: String(body.language ?? ''), category: String(body.category ?? ''),
    header: body.header == null ? null : String(body.header), body: String(body.body ?? ''), footer: body.footer == null ? null : String(body.footer),
    examples: Array.isArray(body.examples) ? body.examples.map((e) => String(e ?? '')) : [],
  });
  if ('error' in spec) return NextResponse.json({ error: spec.error }, { status: 400 });
  const waba = await templatesAccount();
  if (!waba) return NextResponse.json({ error: 'Set the WhatsApp Business Account id first' }, { status: 400 });
  if (typeof body.id === 'string' && body.id) {
    const u = await updateTemplate(body.id, spec.spec);
    if ('error' in u) return NextResponse.json({ error: u.error }, { status: 502 });
    return NextResponse.json({ ok: true, id: body.id, status: 'PENDING', name: spec.spec.name, edited: true });
  }
  const r = await createTemplate(waba, spec.spec);
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: 502 });
  return NextResponse.json({ ok: true, id: r.value.id, status: r.value.status, name: spec.spec.name });
}

export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Super Admin only' }, { status: 403 });
  const name = new URL(request.url).searchParams.get('name') || '';
  const waba = await templatesAccount();
  if (!waba) return NextResponse.json({ error: 'Set the WhatsApp Business Account id first' }, { status: 400 });
  const r = await deleteTemplate(waba, name);
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: 502 });
  return NextResponse.json({ ok: true });
}
