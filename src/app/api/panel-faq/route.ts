import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { ensureSiteForPanel } from '@/lib/chat/site';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

// ── Saved answers (Q&A) for a panel's chat agent ────────────────────────
// The merchant writes the exact answer; the agent reuses it verbatim. These
// are read fresh on every message in getAIResponse, so an edit here is live
// on the next reply with no redeploy.

async function siteIdFor(businessId: string, user: { businessIds?: string[] | null }) {
  if (user.businessIds && user.businessIds.length > 0 && !user.businessIds.includes(businessId)) return null;
  const biz = await queryOne<{ id: string }>(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
  if (!biz) return null;
  const site = await ensureSiteForPanel(businessId);
  return site.id;
}

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const businessId = new URL(request.url).searchParams.get('businessId') || '';
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  const siteId = await siteIdFor(businessId, user);
  if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });

  const rows = await query(
    `SELECT id, question, answer, sort_order, is_enabled
       FROM site_faqs WHERE site_id = $1 ORDER BY sort_order, created_at`,
    [siteId]
  );
  const res = NextResponse.json({ faqs: rows.rows });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role === 'viewer') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { businessId, question, answer } = await request.json();
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    if (!question?.trim() || !answer?.trim()) {
      return NextResponse.json({ error: 'Both a question and an answer are required' }, { status: 400 });
    }

    const siteId = await siteIdFor(businessId, user);
    if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });

    const next = await queryOne<{ n: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM site_faqs WHERE site_id = $1`,
      [siteId]
    );

    const row = await queryOne(
      `INSERT INTO site_faqs (id, site_id, question, answer, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, question, answer, sort_order, is_enabled`,
      [crypto.randomUUID(), siteId, question.trim(), answer.trim(), next?.n ?? 0]
    );
    return NextResponse.json({ faq: row });
  } catch (err) {
    console.error('panel-faq POST error:', err);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role === 'viewer') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { businessId, id, question, answer, isEnabled } = await request.json();
    if (!businessId || !id) return NextResponse.json({ error: 'businessId and id required' }, { status: 400 });

    const siteId = await siteIdFor(businessId, user);
    if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });

    const sets: string[] = []; const params: unknown[] = []; let pi = 1;
    if (question !== undefined)  { sets.push(`question = $${pi++}`);   params.push(String(question).trim()); }
    if (answer !== undefined)    { sets.push(`answer = $${pi++}`);     params.push(String(answer).trim()); }
    if (isEnabled !== undefined) { sets.push(`is_enabled = $${pi++}`); params.push(Boolean(isEnabled)); }
    if (!sets.length) return NextResponse.json({ success: true });
    sets.push(`updated_at = now()`);

    params.push(id, siteId);
    const row = await queryOne(
      `UPDATE site_faqs SET ${sets.join(', ')}
        WHERE id = $${pi++} AND site_id = $${pi}
        RETURNING id, question, answer, sort_order, is_enabled`,
      params
    );
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ faq: row });
  } catch (err) {
    console.error('panel-faq PATCH error:', err);
    return NextResponse.json({ error: 'Could not update' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role === 'viewer') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('businessId') || '';
  const id = searchParams.get('id') || '';
  if (!businessId || !id) return NextResponse.json({ error: 'businessId and id required' }, { status: 400 });

  const siteId = await siteIdFor(businessId, user);
  if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });

  await query(`DELETE FROM site_faqs WHERE id = $1 AND site_id = $2`, [id, siteId]);
  return NextResponse.json({ success: true });
}
