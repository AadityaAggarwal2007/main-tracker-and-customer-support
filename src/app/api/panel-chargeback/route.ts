import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { checkMailbox, looksLikeEmail, normalizeAppPassword } from '@/lib/chat/mailbox-check';
import { panelChargeback, savePanelSettings } from '@/lib/chargeback/store';
import { GATEWAYS } from '@/lib/chargeback/parse';
import { whatsappConfigured } from '@/lib/chargeback/notify';

// ── Chargeback protection for one panel (owner 2026-10-08), Super Admin only ──────────────────
// GET    ?businessId=             the chargeback Gmail, the WhatsApp number, the gateway checklist, whether WhatsApp is set up
// POST   { businessId, email, appPassword }   connect the panel's ONE chargeback Gmail (checked by signing in once)
// PATCH  { businessId, whatsapp? , gateway?: { key, done } }
// DELETE ?businessId=             disconnect it (its past alerts stay)
// The App Password is never sent back. This Gmail is only read: nothing is ever sent from it and the AI never sees it.
function owner(request: NextRequest) {
  const user = getAuthFromRequest(request);
  return user && user.role === 'admin' ? user : null;
}
const ID = /^[\w-]{6,80}$/;

export async function GET(request: NextRequest) {
  if (!owner(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const businessId = new URL(request.url).searchParams.get('businessId') || '';
  if (!ID.test(businessId)) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  try {
    const d = await panelChargeback(businessId);
    return NextResponse.json({ ...d, whatsappReady: whatsappConfigured(), gatewayList: GATEWAYS.map(g => ({ key: g.key, label: g.label })) });
  } catch (e) {
    console.error('[chargeback] panel:', (e as Error).message);
    return NextResponse.json({ error: 'Could not read the chargeback settings.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!owner(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { businessId?: unknown; email?: unknown; appPassword?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const businessId = typeof body.businessId === 'string' ? body.businessId : '';
  const address = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
  const secret = typeof body.appPassword === 'string' ? normalizeAppPassword(body.appPassword) : '';
  if (!ID.test(businessId) || !address || !secret) return NextResponse.json({ error: 'businessId, email and appPassword are required' }, { status: 400 });
  if (!looksLikeEmail(address)) return NextResponse.json({ error: 'That does not look like an email address' }, { status: 400 });
  if (secret.length < 16) return NextResponse.json({ error: 'A Google App Password is 16 characters. Paste the one Google showed you, spaces and all.' }, { status: 400 });
  try {
    const biz = await queryOne<{ id: string }>(`SELECT id FROM businesses WHERE id::text = $1::text`, [businessId]);
    if (!biz) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
    const cur = await panelChargeback(businessId);
    if (!cur.installed) return NextResponse.json({ error: 'Chargeback protection is not installed yet (chargeback.sql).' }, { status: 503 });
    if (cur.mailbox) return NextResponse.json({ error: `This panel already has a chargeback Gmail (${cur.mailbox.email}). Remove it first.` }, { status: 409 });
    // One address does one job: it is not also a support mailbox and not another panel's chargeback mailbox.
    const used = await queryOne<{ n: number }>(
      `SELECT (SELECT count(*) FROM site_emails WHERE email = $1) + (SELECT count(*) FROM chargeback_mailboxes WHERE email = $1) AS n`, [address]);
    if (Number(used?.n ?? 0) > 0) return NextResponse.json({ error: `${address} is already connected somewhere else in ShipTrack.` }, { status: 409 });
    const check = await checkMailbox(address, secret);
    if ('error' in check) return NextResponse.json({ error: check.error }, { status: 400 });
    const row = await queryOne<{ id: string; email: string; created_at: string }>(
      `INSERT INTO chargeback_mailboxes (business_id, email, app_password, last_uid) VALUES ($1, $2, $3, $4) RETURNING id, email, created_at`,
      [businessId, address, secret, check.lastUid]);
    return NextResponse.json({ mailbox: row });
  } catch (e) {
    console.error('[chargeback] connect:', (e as Error).message);
    return NextResponse.json({ error: 'Could not connect that Gmail' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const user = owner(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: { businessId?: unknown; whatsapp?: unknown; gateway?: { key: unknown; done: unknown } } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const businessId = typeof body.businessId === 'string' ? body.businessId : '';
  if (!ID.test(businessId) || (body.whatsapp === undefined && !body.gateway)) return NextResponse.json({ error: 'businessId and a change are required' }, { status: 400 });
  try {
    const r = await savePanelSettings(businessId, user.displayName || user.username, { whatsapp: body.whatsapp, gateway: body.gateway });
    if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[chargeback] settings:', (e as Error).message);
    return NextResponse.json({ error: 'Could not save that.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!owner(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const businessId = new URL(request.url).searchParams.get('businessId') || '';
  if (!ID.test(businessId)) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  try {
    const r = await query(`DELETE FROM chargeback_mailboxes WHERE business_id = $1`, [businessId]);
    if ((r.rowCount ?? 0) === 0) return NextResponse.json({ error: 'No chargeback Gmail on this panel.' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[chargeback] disconnect:', (e as Error).message);
    return NextResponse.json({ error: 'Could not disconnect it.' }, { status: 500 });
  }
}
