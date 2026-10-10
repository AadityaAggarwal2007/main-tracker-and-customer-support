import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { automationOverview, panelExists, resetTemplateCache, retryFailed, saveAuto } from '@/lib/chat/whatsapp-auto';

export const dynamic = 'force-dynamic';

// ── WhatsApp > Automation (owner 2026-10-10): the order-placed message on every new order and the tracking link
// 48 hours later, per panel ON / OFF (default OFF), with what was sent / delivered / read / failed. Super Admin only.
// GET: the switches, the counts per panel, the template states and the last 30 messages (numbers masked to the last 4).
// POST { businessId, enabled }: the switch (turning ON needs the table and an approved order_placed template; it
// starts the clock: only orders placed from then on are ever messaged). POST { action: 'retry', id }: a Failed row again.

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (request.nextUrl?.searchParams?.get('fresh') === '1') resetTemplateCache();
  try { return NextResponse.json(await automationOverview()); }
  catch (e) { console.error('[whatsapp] automation overview:', (e as Error).message); return NextResponse.json({ error: 'Could not read the automation' }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { businessId?: unknown; enabled?: unknown; action?: unknown; id?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  try {
    if (body.action === 'retry') {
      const id = String(body.id ?? '');
      if (!/^\d{1,18}$/.test(id)) return NextResponse.json({ error: 'Not a message id' }, { status: 400 });
      const ok = await retryFailed(id);
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Only a Failed message can be sent again' }, { status: 409 });
    }
    const businessId = String(body.businessId ?? '');
    if (!businessId || typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'Send businessId and enabled' }, { status: 400 });
    if (!(await panelExists(businessId))) return NextResponse.json({ error: 'No such panel' }, { status: 404 });
    if (body.enabled) {
      resetTemplateCache();
      const o = await automationOverview();
      if (!o.installed) return NextResponse.json({ error: 'Not installed yet: whatsapp-automation.sql has to be run on the server first' }, { status: 409 });
      if (!o.configured) return NextResponse.json({ error: 'WhatsApp is not set up on the server (token / phone number id)' }, { status: 409 });
      if (o.templates.placed !== 'APPROVED') return NextResponse.json({ error: `The "order_placed" template is ${o.templates.placed === 'MISSING' ? 'not made yet' : o.templates.placed.toLowerCase()}: switch on after Meta approves it` }, { status: 409 });
    }
    const s = await saveAuto(businessId, body.enabled);
    return NextResponse.json({ ok: true, enabled: s.enabled, since: s.since ? new Date(s.since).toISOString() : null });
  } catch (e) {
    console.error('[whatsapp] automation save:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save it' }, { status: 500 });
  }
}
