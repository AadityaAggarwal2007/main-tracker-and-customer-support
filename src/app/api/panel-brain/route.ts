import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAuthFromRequest, type AuthUser } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { ensureSiteForPanel } from '@/lib/chat/site';
import { BRAIN_TOPICS, BRAIN_TOPIC_KEYS, noteProblem } from '@/lib/chat/brain';
import { getLockedRules } from '@/lib/chat/ai';
import { fillRulebook } from '@/lib/chat/rulebook';

export const dynamic = 'force-dynamic';

// ── The Brain's notes (chat-brain.sql, src/lib/chat/brain.ts) ───────────────────────
// Everyone who can open a panel can read its notes and the common ones; only an admin can
// add, change or delete (owner's rule, 2026-10-01). A COMMON note (every panel) can only
// be written by an admin who is not limited to certain panels.

const KINDS = ['rule', 'fact', 'lesson'];
const COLS = 'id, site_id, kind, title, body, topics, always, audience, shown_count, last_shown_at, is_enabled, source, sort_order, created_by, updated_at';
const AUDIENCES = ['all', 'verified', 'visitor'];

async function siteIdFor(businessId: string, user: AuthUser) {
  if (user.businessIds && user.businessIds.length > 0 && !user.businessIds.includes(businessId)) return null;
  const biz = await queryOne<{ id: string }>(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
  if (!biz) return null;
  return (await ensureSiteForPanel(businessId)).id;
}

const isGlobalAdmin = (u: AuthUser) => u.role === 'admin' && (!u.businessIds || u.businessIds.length === 0);

function clean(body: Record<string, unknown>) {
  const out: { kind?: string; title?: string; body?: string; topics?: string[]; always?: boolean; audience?: string; isEnabled?: boolean } = {};
  if (body.kind !== undefined) out.kind = KINDS.includes(String(body.kind)) ? String(body.kind) : 'lesson';
  if (body.title !== undefined) out.title = String(body.title).trim().slice(0, 120);
  if (body.body !== undefined) out.body = String(body.body).trim().slice(0, 900);
  if (body.topics !== undefined) out.topics = (Array.isArray(body.topics) ? body.topics : []).map(String).filter((t) => BRAIN_TOPIC_KEYS.includes(t));
  if (body.always !== undefined) out.always = Boolean(body.always);
  if (body.audience !== undefined) out.audience = AUDIENCES.includes(String(body.audience)) ? String(body.audience) : 'all';
  if (body.isEnabled !== undefined) out.isEnabled = Boolean(body.isEnabled);
  return out;
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
      `SELECT ${COLS} FROM brain_notes WHERE site_id = $1 OR site_id IS NULL ORDER BY (site_id IS NULL), sort_order, created_at`,
      [siteId]
    );
    // Chikki's rulebook, with this panel's COD and courier filled in, and the changes the
    // owner asked for (chikki-rule-changes.sql; an empty list until that file is applied).
    const site = await queryOne<{ cod_available: boolean | null; cod_states: string | null }>(
      `SELECT cod_available, cod_states FROM sites WHERE id = $1`, [siteId]
    );
    const biz = await queryOne<{ default_courier: string | null }>(`SELECT default_courier FROM businesses WHERE id = $1`, [businessId]);
    let ruleChanges: unknown[] = [];
    try {
      ruleChanges = (await query(
        `SELECT id, rule_id, body, status, created_by, created_at, closed_at, closed_note
           FROM chikki_rule_changes ORDER BY created_at DESC LIMIT 200`
      )).rows;
    } catch { /* table not there yet */ }
    const res = NextResponse.json({
      notes: rows.rows,
      topics: BRAIN_TOPICS.map((t) => ({ key: t.key, label: t.label })),
      locked: getLockedRules(),
      rulebook: fillRulebook(
        { codStates: site?.cod_states ?? null, codAvailable: site?.cod_available ?? null },
        biz?.default_courier ?? null,
      ),
      ruleChanges,
      canEdit: user.role === 'admin',
      canEditCommon: isGlobalAdmin(user),
    });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (err) {
    console.error('panel-brain GET error:', err);
    return NextResponse.json({ error: 'The Brain is not set up yet' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Only an admin can change the Brain' }, { status: 403 });
  try {
    const raw = await request.json();
    const { businessId, scope } = raw;
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    const siteId = await siteIdFor(businessId, user);
    if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
    const common = scope === 'common';
    if (common && !isGlobalAdmin(user)) return NextResponse.json({ error: 'A note for every panel needs an admin of all panels' }, { status: 403 });

    const n = clean(raw);
    if (!n.title || !n.body) return NextResponse.json({ error: 'Write a title and the note' }, { status: 400 });
    const topics = n.topics || [];
    if (!n.always && !topics.length) return NextResponse.json({ error: 'Pick at least one topic, or turn on "always"' }, { status: 400 });
    const problem = noteProblem(n.title, n.body);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const next = await queryOne<{ n: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM brain_notes WHERE site_id ${common ? 'IS NULL' : '= $1'}`,
      common ? [] : [siteId]
    );
    const row = await queryOne(
      `INSERT INTO brain_notes (id, site_id, kind, title, body, topics, always, audience, source, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'owner', $9, $10)
       RETURNING ${COLS}`,
      [crypto.randomUUID(), common ? null : siteId, n.kind || 'lesson', n.title, n.body, topics, !!n.always, n.audience || 'all', next?.n ?? 0, user.username]
    );
    return NextResponse.json({ note: row });
  } catch (err) {
    console.error('panel-brain POST error:', err);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Only an admin can change the Brain' }, { status: 403 });
  try {
    const raw = await request.json();
    const { businessId, id } = raw;
    if (!businessId || !id) return NextResponse.json({ error: 'businessId and id required' }, { status: 400 });
    const siteId = await siteIdFor(businessId, user);
    if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });

    const existing = await queryOne<{ site_id: string | null; title: string; body: string }>(`SELECT site_id, title, body FROM brain_notes WHERE id = $1`, [id]);
    if (!existing || (existing.site_id !== null && existing.site_id !== siteId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (existing.site_id === null && !isGlobalAdmin(user)) return NextResponse.json({ error: 'A note for every panel needs an admin of all panels' }, { status: 403 });

    const n = clean(raw);
    if (n.title !== undefined || n.body !== undefined) {
      const problem = noteProblem(n.title ?? existing.title, n.body ?? existing.body);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }
    const sets: string[] = []; const params: unknown[] = []; let pi = 1;
    if (n.kind !== undefined)      { sets.push(`kind = $${pi++}`); params.push(n.kind); }
    if (n.title !== undefined)     { if (!n.title) return NextResponse.json({ error: 'The title cannot be empty' }, { status: 400 }); sets.push(`title = $${pi++}`); params.push(n.title); }
    if (n.body !== undefined)      { if (!n.body) return NextResponse.json({ error: 'The note cannot be empty' }, { status: 400 }); sets.push(`body = $${pi++}`); params.push(n.body); }
    if (n.topics !== undefined)    { sets.push(`topics = $${pi++}`); params.push(n.topics); }
    if (n.always !== undefined)    { sets.push(`always = $${pi++}`); params.push(n.always); }
    if (n.audience !== undefined)  { sets.push(`audience = $${pi++}`); params.push(n.audience); }
    if (n.isEnabled !== undefined) { sets.push(`is_enabled = $${pi++}`); params.push(n.isEnabled); }
    if (!sets.length) return NextResponse.json({ success: true });
    sets.push('updated_at = now()');
    params.push(id);
    const row = await queryOne(`UPDATE brain_notes SET ${sets.join(', ')} WHERE id = $${pi} RETURNING ${COLS}`, params);
    return NextResponse.json({ note: row });
  } catch (err) {
    console.error('panel-brain PATCH error:', err);
    return NextResponse.json({ error: 'Could not update' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Only an admin can change the Brain' }, { status: 403 });
  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('businessId') || '';
  const id = searchParams.get('id') || '';
  if (!businessId || !id) return NextResponse.json({ error: 'businessId and id required' }, { status: 400 });
  const siteId = await siteIdFor(businessId, user);
  if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
  const existing = await queryOne<{ site_id: string | null }>(`SELECT site_id FROM brain_notes WHERE id = $1`, [id]);
  if (!existing || (existing.site_id !== null && existing.site_id !== siteId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (existing.site_id === null && !isGlobalAdmin(user)) return NextResponse.json({ error: 'A note for every panel needs an admin of all panels' }, { status: 403 });
  await query(`DELETE FROM brain_notes WHERE id = $1`, [id]);
  return NextResponse.json({ success: true });
}
