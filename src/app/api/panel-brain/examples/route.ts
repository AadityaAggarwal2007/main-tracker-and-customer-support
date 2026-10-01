import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAuthFromRequest, type AuthUser } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { ensureSiteForPanel } from '@/lib/chat/site';
import { SITUATIONS, SITUATION_KEYS, exampleProblem } from '@/lib/chat/brain-examples';
import { hasPersonalDetail } from '@/lib/chat/brain-learn';
import { can } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

// ── How our team handles difficult customers (brain_examples, brain-examples.ts) ──────
// GET: the panel's examples (pending first) and a count per situation, for anyone on the panel.
// POST (admin only): action = approve | reject | toggle | delete | add. An approved, enabled
// example is what the agent is shown; nothing else is.

async function siteIdFor(businessId: string, user: AuthUser) {
  if (user.businessIds && user.businessIds.length > 0 && !user.businessIds.includes(businessId)) return null;
  const biz = await queryOne<{ id: string }>(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
  if (!biz) return null;
  return (await ensureSiteForPanel(businessId)).id;
}

const COLS = 'id, situation, customer_said, team_replied, why, source, status, is_enabled, shown_count, last_shown_at, created_at';

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const businessId = new URL(request.url).searchParams.get('businessId') || '';
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  const siteId = await siteIdFor(businessId, user);
  if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });
  try {
    const rows = await query(
      `SELECT ${COLS} FROM brain_examples WHERE site_id = $1 AND status <> 'rejected'
        ORDER BY (status = 'pending') DESC, (why LIKE '%replied calmly%') DESC, created_at DESC LIMIT 200`,
      [siteId]
    );
    const learned = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM brain_reviewed WHERE site_id = $1`, [siteId]).catch(() => null);
    const res = NextResponse.json({ examples: rows.rows, situations: SITUATIONS, reviewed: learned?.n ?? 0 });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (err) {
    console.error('panel-brain examples GET error:', err);
    return NextResponse.json({ examples: [], situations: SITUATIONS, reviewed: 0 });
  }
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || !can(user, 'chikki.edit')) return NextResponse.json({ error: 'You cannot change Chikki' }, { status: 403 });
  try {
    const raw = await request.json();
    const { businessId, id, action } = raw;
    if (!businessId || !['approve', 'reject', 'toggle', 'delete', 'add'].includes(action)) {
      return NextResponse.json({ error: 'businessId and action required' }, { status: 400 });
    }
    const siteId = await siteIdFor(businessId, user);
    if (!siteId) return NextResponse.json({ error: 'Panel not found' }, { status: 404 });

    const check = (situation: string, customer: string, team: string) => {
      if (!SITUATION_KEYS.includes(situation)) return 'Pick a situation';
      if (customer.length < 3) return 'Write what the customer said';
      if (hasPersonalDetail(customer)) return 'Take out phone numbers, order IDs, links and e-mail addresses from what the customer said';
      return exampleProblem(team);
    };

    if (action === 'add') {
      const situation = String(raw.situation || ''), customer = String(raw.customer_said || '').trim().slice(0, 300), team = String(raw.team_replied || '').trim();
      const problem = check(situation, customer, team);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      const row = await queryOne(
        `INSERT INTO brain_examples (id, site_id, situation, customer_said, team_replied, why, source, status, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, 'Written by the owner.', 'owner', 'approved', $6, now()) RETURNING ${COLS}`,
        [crypto.randomUUID(), siteId, situation, customer, team, user.username]
      );
      return NextResponse.json({ example: row });
    }

    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    const ex = await queryOne<{ situation: string; customer_said: string; team_replied: string; is_enabled: boolean }>(
      `SELECT situation, customer_said, team_replied, is_enabled FROM brain_examples WHERE id = $1 AND site_id = $2`, [id, siteId]
    );
    if (!ex) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (action === 'reject') {
      await query(`UPDATE brain_examples SET status = 'rejected', decided_by = $1, decided_at = now() WHERE id = $2`, [user.username, id]);
    } else if (action === 'delete') {
      await query(`DELETE FROM brain_examples WHERE id = $1`, [id]);
    } else if (action === 'toggle') {
      await query(`UPDATE brain_examples SET is_enabled = NOT is_enabled WHERE id = $1`, [id]);
    } else {
      // approve, with the owner's edits if any
      const situation = String(raw.situation ?? ex.situation);
      const customer = String(raw.customer_said ?? ex.customer_said).trim().slice(0, 300);
      const team = String(raw.team_replied ?? ex.team_replied).trim();
      const problem = check(situation, customer, team);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      await query(
        `UPDATE brain_examples SET situation = $1, customer_said = $2, team_replied = $3, status = 'approved',
                is_enabled = true, decided_by = $4, decided_at = now() WHERE id = $5`,
        [situation, customer, team, user.username, id]
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('panel-brain examples POST error:', err);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}
