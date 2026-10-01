import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAuthFromRequest } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { RULE_IDS } from '@/lib/chat/rulebook';

export const dynamic = 'force-dynamic';

// ── Changes the owner asks for in Chikki's rulebook (chikki-rule-changes.sql) ──────────
// The list is read with the rest of Chikki (GET /api/panel-brain). Here an admin asks for a
// change to one rule (or a new rule, ruleId 'new'), or withdraws an open request. A request
// changes nothing by itself: the developer applies it after testing and closes the row.

const COLS = 'id, rule_id, body, status, created_by, created_at, closed_at, closed_note';

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Only an admin can ask to change a rule' }, { status: 403 });
  try {
    const raw = await request.json();
    const ruleId = String(raw.ruleId || '').trim();
    const body = String(raw.body || '').trim().slice(0, 1000);
    if (ruleId !== 'new' && !RULE_IDS.has(ruleId)) return NextResponse.json({ error: 'Unknown rule' }, { status: 400 });
    if (body.length < 3) return NextResponse.json({ error: 'Write what should change' }, { status: 400 });
    const by = (user.displayName || user.username || '').trim() || 'admin';
    const row = await queryOne(
      `INSERT INTO chikki_rule_changes (id, rule_id, body, created_by) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
      [crypto.randomUUID(), ruleId, body, by]
    );
    return NextResponse.json({ change: row });
  } catch (err) {
    console.error('rule-changes POST error:', err);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Only an admin can change this' }, { status: 403 });
  try {
    const raw = await request.json();
    const id = String(raw.id || '');
    if (!id || raw.action !== 'withdraw') return NextResponse.json({ error: 'id and action required' }, { status: 400 });
    const by = (user.displayName || user.username || '').trim() || 'admin';
    const row = await queryOne(
      `UPDATE chikki_rule_changes SET status = 'dropped', closed_at = now(), closed_note = $2
        WHERE id = $1 AND status = 'open' RETURNING ${COLS}`,
      [id, `Withdrawn by ${by}`]
    );
    if (!row) return NextResponse.json({ error: 'Not found, or already closed' }, { status: 404 });
    return NextResponse.json({ change: row });
  } catch (err) {
    console.error('rule-changes PATCH error:', err);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}
