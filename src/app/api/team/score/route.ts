import { NextRequest, NextResponse } from 'next/server';
import { authReady, getAuthFromRequest } from '@/lib/auth';
import { can, isSuperAdmin } from '@/lib/permissions';
import {
  FIRST_DAY, cleanReason, computeDays, errorReply, getReport, parseRange, rangeDays, saveSettings, selfView, snapshotDay,
} from '@/lib/team-score/report';
import { judgeBusy, runJudge } from '@/lib/team-score/judge';
import { addDays, dayStartMs, todayIst } from '@/lib/team-score/clock';
import { JUDGE_WINDOW_DAYS } from '@/lib/team-score/rules';

export const dynamic = 'force-dynamic';

// ── Team score (owner, 2026-10-01, part 4) ──────────────────────
// GET: the leaderboard for one India day or a range (up to 31 days), from frozen days and live
// numbers (src/lib/team-score/report.ts). The Super Admin sees everyone; a team member who can reply
// to chats (chat.reply) sees only their own row ("My score", owner answer A1 2026-10-02); anyone else
// 403. POST (Super Admin only): "Check now" (the AI check of messages the keywords could not decide),
// the point weights (forward only: past days keep their points) and "Recompute" of a final day with a
// reason. Customers never see any of this; the AI never reads it.

const g = globalThis as unknown as { __teamScoreActionAt?: { judge?: number; recompute?: number } };
const JUDGE_EVERY_MS = 30_000;
const RECOMPUTE_EVERY_MS = 10_000;
const JUDGE_BUSY = 'AI check already running, try again in a minute';

// Who is asking: the Super Admin (everything), a member who can reply (their own row), else refused.
// deny: the answer to send instead. self: null = the Super Admin (everyone); a member's own key
// (team_users.id) = only their own row.
interface Viewer { deny: NextResponse | null; self: string | null }
// A refusal's self is '' (nobody), never null, so a missed deny check can never show everything.
const refuse = (error: string, status: number): Viewer => ({ deny: NextResponse.json({ error }, { status }), self: '' });
async function viewer(request: NextRequest, superOnly: boolean): Promise<Viewer> {
  await authReady();
  const user = getAuthFromRequest(request);
  if (!user) return refuse('Please log in again', 401);
  if (isSuperAdmin(user)) return { deny: null, self: null };
  if (superOnly) return refuse('Only the Super Admin can change the team score', 403);
  // The Manager sees the whole team (owner 2026-10-10: "Team score Manager Panel par"); changing it stays the Super Admin's.
  if (can(user, 'team.lead')) return { deny: null, self: null };
  if (!can(user, 'chat.reply')) return refuse('Only team members who reply to chats have a score', 403);
  if (!user.id) return refuse('Please log in again', 401);
  return { deny: null, self: String(user.id) };
}

const yes = (x: string | null) => x !== null && !['', '0', 'false', 'no'].includes(x.toLowerCase());

// Too soon after the last one of this kind (one process): true = refuse.
function tooSoon(kind: 'judge' | 'recompute', everyMs: number): boolean {
  const at = (g.__teamScoreActionAt ??= {});
  const now = Date.now();
  if (now - (at[kind] ?? 0) < everyMs) return true;
  at[kind] = now;
  return false;
}

export async function GET(request: NextRequest) {
  const who = await viewer(request, false);
  if (who.deny) return who.deny;
  const sp = new URL(request.url).searchParams;
  const nowMs = Date.now();
  const range = parseRange(sp.get('from'), sp.get('to'), nowMs);
  if ('error' in range) return NextResponse.json({ error: range.error }, { status: 400 });
  try {
    const full = await getReport(range.from, range.to, { fresh: yes(sp.get('fresh')), nowMs });
    const body = who.self === null ? full : selfView(full, who.self);
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const e = errorReply(err, 'GET');
    return NextResponse.json(e.body, { status: e.status });
  }
}

export async function POST(request: NextRequest) {
  const who = await viewer(request, true);
  if (who.deny) return who.deny;
  let body: Record<string, unknown>;
  try {
    const raw = await request.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Send a JSON body with an action' }, { status: 400 });
  }
  try {
    switch (body.action) {
      case 'judge': {
        // The cron's run (or another click) is asking now: refused before the 30 s slot is used up.
        if (judgeBusy()) return NextResponse.json({ error: JUDGE_BUSY }, { status: 429 });
        if (tooSoon('judge', JUDGE_EVERY_MS)) return NextResponse.json({ error: 'Wait a moment' }, { status: 429 });
        const r = await runJudge({ max: 20, budgetMs: 25_000 });
        if (r.busy) return NextResponse.json({ error: JUDGE_BUSY }, { status: 429 });
        const nowMs = Date.now(), today = todayIst(nowMs);
        let start = addDays(today, -(JUDGE_WINDOW_DAYS - 1));
        if (start < FIRST_DAY) start = FIRST_DAY;
        const left = await computeDays(rangeDays(start, today), nowMs);
        const pending = left.days.reduce((n, d) => n + (d.aiPending || 0), 0);
        return NextResponse.json({ ok: true, judged: Math.max(0, r.asked - r.failed), pending, model_ok: r.model_ok });
      }
      case 'settings': {
        const r = await saveSettings({ weights: body.weights, effectiveFrom: body.effectiveFrom, pointsFrom: body.pointsFrom }, 'owner');
        return NextResponse.json({ ok: true, id: r.id });
      }
      case 'recompute': {
        const day = typeof body.day === 'string' ? body.day.trim() : '';
        if (dayStartMs(day) === null || day < FIRST_DAY) {
          return NextResponse.json({ error: `Pick a day as YYYY-MM-DD, from ${FIRST_DAY}` }, { status: 400 });
        }
        if (day > addDays(todayIst(Date.now()), -2)) {
          return NextResponse.json({ error: 'Only days that are already final can be recomputed' }, { status: 400 });
        }
        const reason = cleanReason(body.reason);
        if (!reason) return NextResponse.json({ error: 'Write a reason of 3 to 200 characters' }, { status: 400 });
        if (tooSoon('recompute', RECOMPUTE_EVERY_MS)) return NextResponse.json({ error: 'Wait a moment' }, { status: 429 });
        await snapshotDay(day, 'recompute', 'owner', reason);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err) {
    const e = errorReply(err, `POST ${String(body.action).slice(0, 20)}`);
    return NextResponse.json(e.body, { status: e.status });
  }
}
