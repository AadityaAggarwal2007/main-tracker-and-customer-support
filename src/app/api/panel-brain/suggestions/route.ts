import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAuthFromRequest, type AuthUser } from '@/lib/auth';
import { query, queryOne, withTransaction } from '@/lib/db';
import { ensureSiteForPanel } from '@/lib/chat/site';
import { BRAIN_TOPIC_KEYS } from '@/lib/chat/brain';
import { hasPersonalDetail } from '@/lib/chat/brain-learn';

export const dynamic = 'force-dynamic';

// ── Lessons the system drafted from real chats (brain-learn.ts) ─────────────────────
// GET lists the panel's pending suggestions (anyone on the panel). POST decides one: an admin
// approves (optionally after editing it) and it becomes a Brain note, or rejects it. The AI never
// reads a suggestion and never approves one.

async function siteIdFor(businessId: string, user: AuthUser) {
  if (user.businessIds && user.businessIds.length > 0 && !user.businessIds.includes(businessId)) return null;
  const biz = await queryOne<{ id: string }>(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
  if (!biz) return null;
  return (await ensureSiteForPanel(businessId)).id;
}

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const businessId = new URL(request.url).searchParams.get('businessId') || '';
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  const siteId = await siteIdFor(businessId, user);
  if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
  try {
    const rows = await query(
      `SELECT id, kind, title, body, topics, why, conversation_id, created_at
         FROM brain_suggestions WHERE site_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 50`,
      [siteId]
    );
    const res = NextResponse.json({ suggestions: rows.rows });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (err) {
    console.error('panel-brain suggestions GET error:', err);
    return NextResponse.json({ suggestions: [] });
  }
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Only an admin can decide a suggestion' }, { status: 403 });
  try {
    const raw = await request.json();
    const { businessId, id, action } = raw;
    if (!businessId || !id || !['approve', 'reject'].includes(action)) return NextResponse.json({ error: 'businessId, id and action required' }, { status: 400 });
    const siteId = await siteIdFor(businessId, user);
    if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });

    const sug = await queryOne<{ id: string; kind: string; title: string; body: string; topics: string[] }>(
      `SELECT id, kind, title, body, topics FROM brain_suggestions WHERE id = $1 AND site_id = $2 AND status = 'pending'`,
      [id, siteId]
    );
    if (!sug) return NextResponse.json({ error: 'Already decided or not found' }, { status: 404 });

    if (action === 'reject') {
      await query(`UPDATE brain_suggestions SET status = 'rejected', decided_by = $1, decided_at = now() WHERE id = $2`, [user.username, id]);
      return NextResponse.json({ success: true });
    }

    // The owner may edit the wording before approving.
    const title = String(raw.title ?? sug.title).trim().slice(0, 120);
    const body = String(raw.body ?? sug.body).trim().slice(0, 900);
    const topics = (Array.isArray(raw.topics) ? raw.topics : sug.topics).map(String).filter((t: string) => BRAIN_TOPIC_KEYS.includes(t));
    const always = Boolean(raw.always);
    if (!title || !body) return NextResponse.json({ error: 'Write a title and the note' }, { status: 400 });
    if (!always && !topics.length) return NextResponse.json({ error: 'Pick at least one topic, or tick "Always show"' }, { status: 400 });
    if (hasPersonalDetail(title) || hasPersonalDetail(body)) return NextResponse.json({ error: 'Take out phone numbers, order IDs, links and e-mail addresses: a note is general' }, { status: 400 });
    const kind = ['rule', 'fact', 'lesson'].includes(String(raw.kind)) ? String(raw.kind) : sug.kind;

    const note = await withTransaction(async (client) => {
      const next = await client.query(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM brain_notes WHERE site_id = $1`, [siteId]);
      const ins = await client.query(
        `INSERT INTO brain_notes (id, site_id, kind, title, body, topics, always, source, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'learned', $8, $9)
         RETURNING id, site_id, kind, title, body, topics, always, is_enabled, source, sort_order`,
        [crypto.randomUUID(), siteId, kind, title, body, topics, always, next.rows[0].n, user.username]
      );
      await client.query(`UPDATE brain_suggestions SET status = 'approved', decided_by = $1, decided_at = now() WHERE id = $2`, [user.username, id]);
      return ins.rows[0];
    });
    return NextResponse.json({ note });
  } catch (err) {
    console.error('panel-brain suggestions POST error:', err);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}
