import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/permissions';
import { loadHolidays, saveHolidays, MAX_HOLIDAYS } from '@/lib/chat/holidays';
import { OFFICE_OPEN_MIN, OFFICE_CLOSE_MIN, SATURDAY_CLOSE_MIN } from '@/lib/office-hours';

export const dynamic = 'force-dynamic';

// ── Office holidays (owner 2026-10-05) ───────────────────────────────────────────
// GET  /api/team/holidays            the listed days + the fixed week (Team > Office hours & holidays)
// POST /api/team/holidays { text }   save the list (one 'YYYY-MM-DD' per line; anything else is dropped)
// Super Admin only: the office hours are the team's, not a panel's. On a listed day the office is
// closed all day: customers handed to the team hear when it opens next, an upset customer gets the
// closed-hours note (closed-hours.ts), and nobody is "away" (team-rules.ts).

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const week = {
  weekdays: `${hhmm(OFFICE_OPEN_MIN)}-${hhmm(OFFICE_CLOSE_MIN)}`,
  saturday: `${hhmm(OFFICE_OPEN_MIN)}-${hhmm(SATURDAY_CLOSE_MIN)}`,
  sunday: 'off',
};

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the Super Admin sees the office hours' }, { status: 403 });
  return NextResponse.json({ holidays: await loadHolidays(0), week, max: MAX_HOLIDAYS });
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSuperAdmin(user)) return NextResponse.json({ error: 'Only the Super Admin changes the office hours' }, { status: 403 });
  try {
    const raw = await request.json().catch(() => ({}));
    const text = typeof raw?.text === 'string' ? raw.text : '';
    if (text.length > 4000) return NextResponse.json({ error: 'That is too long' }, { status: 400 });
    const holidays = await saveHolidays(text);
    return NextResponse.json({ holidays, week, max: MAX_HOLIDAYS });
  } catch (err) {
    console.error('team holidays POST error:', err);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}
