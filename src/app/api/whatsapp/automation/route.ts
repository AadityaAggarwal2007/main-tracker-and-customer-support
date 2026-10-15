import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { automationOverview, panelExists, resetTemplateCache, retryFailed, saveAuto, saveLinkMode, sendAutomationTest } from '@/lib/chat/whatsapp-auto';
import { manualPause, resumeNow, saveSendRate } from '@/lib/chat/whatsapp-pause';
import { SEND_RATES } from '@/lib/chat/whatsapp-auto-rules';

export const dynamic = 'force-dynamic';

// ── WhatsApp > Automation (owner 2026-10-10): the order-placed message on every new order and the tracking link
// 48 hours later, per panel ON / OFF (default OFF), with what was sent / delivered / read / failed. Super Admin only.
// GET [?day=]: the switches, the counts per panel (all time and the chosen days), the orders that came in those days,
// the template states and every message of those days (numbers masked to the last 4).
// POST { businessId, enabled }: the switch (turning ON needs the table and an approved order_placed template; it
// starts the clock: only orders placed from then on are ever messaged). POST { action: 'retry', id }: a Failed row again.
// POST { action: 'test', businessId, to, name }: both messages of that brand to one number, filled from its latest order
// (nothing recorded, no customer messaged).
// POST { action: 'pause', minutes: 15 | 30 | 60 | 120 }: no order message for that long (owner 2026-10-15, "pause ka
// option"); POST { action: 'resume' }: the pause (Meta's or one by hand) ends now.
// POST { action: 'link_mode', on: boolean }: the switch "One message per order" (owner 2026-10-15, "switch ya jo bhi
// banana h bana"): ON = order_placed_link once Meta approved it, OFF = the two old templates as before.
// POST { action: 'rate', perMinute: 1 | 2 | 3 | 4 }: how many order messages a minute (owner 2026-10-15, "button se set kar
// sakein ki har minute 2, 3, 4 message"); anything else is a 400. The GET answers it as `sendRate`.

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (request.nextUrl?.searchParams?.get('fresh') === '1') resetTemplateCache();
  // ?day=today | yesterday | 7d | YYYY-MM-DD (India days; owner 2026-10-11: the date filter)
  const day = (request.nextUrl?.searchParams?.get('day') || '').slice(0, 10) || null;
  try { return NextResponse.json(await automationOverview(day)); }
  catch (e) { console.error('[whatsapp] automation overview:', (e as Error).message); return NextResponse.json({ error: 'Could not read the automation' }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !isSuperAdmin(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { businessId?: unknown; enabled?: unknown; action?: unknown; id?: unknown; to?: unknown; name?: unknown; minutes?: unknown; on?: unknown; perMinute?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Not JSON' }, { status: 400 }); }
  try {
    if (body.action === 'rate') {
      const n = typeof body.perMinute === 'number' ? body.perMinute : typeof body.perMinute === 'string' && body.perMinute.trim() ? Number(body.perMinute.trim()) : NaN;   // a number, or one typed in a field
      if (!SEND_RATES.includes(n)) return NextResponse.json({ error: `Pick ${SEND_RATES.join(', ')} order messages a minute` }, { status: 400 });
      const s = await saveSendRate(n, user.displayName || user.username);
      return s ? NextResponse.json({ ok: true, perMinute: s.perMinute, sendRate: s }) : NextResponse.json({ error: 'Pick 1, 2, 3 or 4' }, { status: 400 });
    }
    if (body.action === 'link_mode') {
      if (typeof body.on !== 'boolean') return NextResponse.json({ error: 'Send on: true or false' }, { status: 400 });
      const s = await saveLinkMode(body.on, user.displayName || user.username);
      resetTemplateCache();
      const o = await automationOverview();
      return NextResponse.json({ ok: true, on: s.on, linkMode: o.linkMode });
    }
    if (body.action === 'retry') {
      const id = String(body.id ?? '');
      if (!/^\d{1,18}$/.test(id)) return NextResponse.json({ error: 'Not a message id' }, { status: 400 });
      const ok = await retryFailed(id);
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Only a Failed message can be sent again' }, { status: 409 });
    }
    if (body.action === 'pause') {
      const until = await manualPause(Number(body.minutes), user.displayName || user.username);
      return until ? NextResponse.json({ ok: true, until: new Date(until).toISOString() }) : NextResponse.json({ error: 'Pick 15, 30, 60 or 120 minutes' }, { status: 400 });
    }
    if (body.action === 'resume') {
      const ok = await resumeNow(user.displayName || user.username);
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'The number is not paused' }, { status: 409 });
    }
    if (body.action === 'test') {
      const panel = String(body.businessId ?? '');
      if (!(await panelExists(panel))) return NextResponse.json({ error: 'No such panel' }, { status: 404 });
      const r = await sendAutomationTest(panel, String(body.to ?? ''), String(body.name ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40));
      return 'error' in r ? NextResponse.json({ error: r.error }, { status: 400 }) : NextResponse.json({ ok: true, ...r });
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
