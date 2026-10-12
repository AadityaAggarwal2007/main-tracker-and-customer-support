import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { mailAccess } from '@/lib/chat/mail-access';
import { createForChat, createForMail, listCorrections } from '@/lib/chat/corrections';
import { listForMail } from '@/lib/chat/corrections-read';

export const dynamic = 'force-dynamic';

// ── /api/corrections (owner 2026-10-11, "Correction") ──────────────────────────────────────────
// GET ?status=active|changed|pending|done[&panel=<business id>]: every correction of the login's panels (chat.view), pending oldest
// first, with the counts {pending, overdue, done_today}. GET ?box=<mailbox id>&uid=<n>: the open mail's own rows
// (the Mail tab's "Correction pending" line; Mail access). 503 in plain words until order-corrections.sql is run.
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const box = sp.get('box');
  if (box) {
    const a = await mailAccess(request, box, 'view');
    if ('error' in a) return a.error;
    const uid = Number(sp.get('uid'));
    if (!Number.isInteger(uid) || uid <= 0) return NextResponse.json({ error: 'uid required' }, { status: 400 });
    return NextResponse.json({ rows: await listForMail(a.box.id, uid) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.view')) return NextResponse.json({ error: 'You cannot open Chat Support' }, { status: 403 });
  try {
    const r = await listCorrections(user, { status: sp.get('status'), panel: sp.get('panel') });
    if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json(r.value, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[correction] GET error:', (e as Error)?.message);
    return NextResponse.json({ error: 'Could not read the corrections right now' }, { status: 500 });
  }
}

// POST { conversationId, kinds, note }: a correction on a VERIFIED website / email chat (chat.view + chat.reply, the
// chat's panel in scope; never WhatsApp: 400; not verified: 409 "Verify this customer first").
// POST { mail: { box, uid, email, orderId? }, kinds, note }: from the Mail tab (Mail reply access); the sender must be
// verified for an order of that panel (409 otherwise), and with several verified orders the body names one.
// The customer is told nothing; the row shows in Chat Support > Corrections for everyone.
export async function POST(request: NextRequest) {
  let body: { conversationId?: unknown; mail?: { box?: unknown; uid?: unknown; email?: unknown; orderId?: unknown } | null; kinds?: unknown; note?: unknown } = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  try {
    if (body.mail && typeof body.mail === 'object') {
      const m = body.mail;
      const a = await mailAccess(request, typeof m.box === 'string' ? m.box : null, 'reply');
      if ('error' in a) return a.error;
      const r = await createForMail(a.user, a.box, Number(m.uid), { email: m.email, orderId: m.orderId, kinds: body.kinds, note: body.note });
      if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, correction: r.value });
    }
    const user = getAuthFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = typeof body.conversationId === 'string' ? body.conversationId : '';
    if (!id) return NextResponse.json({ error: 'conversationId required' }, { status: 400 });
    const r = await createForChat(user, id, { kinds: body.kinds, note: body.note });
    if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, correction: r.value });
  } catch (e) {
    console.error('[correction] POST error:', (e as Error)?.message);
    return NextResponse.json({ error: 'Could not save the correction right now' }, { status: 500 });
  }
}
