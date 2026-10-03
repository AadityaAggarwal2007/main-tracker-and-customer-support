import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { queryOne, withTransaction } from '@/lib/db';
import { can, canAccessPanel } from '@/lib/permissions';
import { parseReship } from '@/lib/chat/reship';
import { logChatEvent, staffActor } from '@/lib/chat/team-routing';

export const dynamic = 'force-dynamic';

// ── PATCH /api/chat/conversations/:id/reship ──────────────────
// "Mark reshipped" (owner 2026-10-03): the team sent the new parcel for a Ship again chat and gives
// the new tracking link or AWB. { awb_or_link: string }. Logins that may reply in Chat Support, inside
// their own panels, on a chat that is in Ship again. Stores reshipped_at / reshipped_by / reship_awb /
// reship_link on the conversation (chat-reship-done.sql) and a 'reshipped' team event. The customer
// is told nothing; the status does not change. Marking again replaces the AWB.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.view') || !can(user, 'chat.reply')) {
    return NextResponse.json({ error: 'You cannot mark chats as reshipped' }, { status: 403 });
  }

  const conv = await queryOne<{ id: string; site_id: string; status: string; case_kind: string | null; tracker_business_id: string | null }>(
    `SELECT c.id, c.site_id, c.status, c.case_kind, s.tracker_business_id
       FROM conversations c
       JOIN sites s ON s.id = c.site_id
      WHERE c.id = $1`,
    [params.id]
  );
  if (!conv || !canAccessPanel(user, conv.tracker_business_id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (conv.case_kind !== 'reship') {
    return NextResponse.json({ error: 'Only a chat in Ship again can be marked reshipped' }, { status: 409 });
  }

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const parsed = parseReship((raw as { awb_or_link?: unknown } | null)?.awb_or_link);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const actor = staffActor(user);
    if (!actor) return NextResponse.json({ error: 'You cannot mark chats as reshipped' }, { status: 403 });
    const out = await withTransaction(async (db) => {
      const r = await db.query<{ reshipped_at: string; reshipped_by: string | null; reship_awb: string | null; reship_link: string | null }>(
        `UPDATE conversations
            SET reshipped_at = now(), reshipped_by = $2, reship_awb = $3, reship_link = $4, updated_at = now()
          WHERE id = $1 AND case_kind = 'reship'
        RETURNING reshipped_at, reshipped_by, reship_awb, reship_link`,
        [conv.id, actor.name, parsed.awb, parsed.link]
      );
      if (r.rows.length !== 1) return { status: 409, body: { error: 'This chat is no longer in Ship again' } };
      await logChatEvent(db, actor, {
        conversationId: conv.id, siteId: conv.site_id, kind: 'reshipped', reason: 'button',
        fromStatus: conv.status, toStatus: conv.status, meta: { awb: parsed.awb, link: parsed.link, auto: false },
      });
      const row = r.rows[0];
      return { status: 200, body: { reshipped: { ...row, reshipped_at: new Date(row.reshipped_at).toISOString() } } };
    });
    return NextResponse.json(out.body, { status: out.status });
  } catch (err) {
    console.error('[chat/reship] PATCH error:', (err as Error)?.message);
    return NextResponse.json({ error: 'Could not save the reship' }, { status: 500 });
  }
}
