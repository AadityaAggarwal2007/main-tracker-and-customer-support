import { NextRequest, NextResponse } from 'next/server';
import { FIRST_DAY, clearScoreCache, computeDays, errorReply, freezePlan, rangeDays, snapshotDay } from '@/lib/team-score/report';
import { runJudge } from '@/lib/team-score/judge';
import { addDays, todayIst } from '@/lib/team-score/clock';
import { JUDGE_MAX_PER_RUN, JUDGE_WINDOW_DAYS, MAX_RANGE_DAYS } from '@/lib/team-score/rules';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// ── Team score cron (owner, 2026-10-01, part 4) ─────────────────
// Called every 15 minutes by the VPS crontab (crontab is not in Git, see AGENTS.md):
//   */15 * * * * curl -s -m 115 "http://localhost:3000/api/cron/team-score?secret=YOUR_SECRET" >> /var/log/team-score.log 2>&1
// 1. Asks the AI about customer messages of the last 4 India days the keywords could not decide
//    (src/lib/team-score/judge.ts: capped per run and per day; one verdict per message, ever).
// 2. Freezes settled days (D+2 01:00 IST, later while AI checks are pending, at the latest D+4) into
//    team_score_days, so incentive numbers stop moving.
// Sends nothing to anyone. The secret has NO default: unset = refused (it spends model calls).
// ?dry=<anything but 0/false/no> only counts: no model call, no insert. ?days=N (1-31) widens the
// AI window once, for a catch-up. The answer and the log line carry counts only.

const g = globalThis as unknown as { __teamScoreCronBusy?: boolean };

export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const want = process.env.CRON_SECRET;
  if (!want || sp.get('secret') !== want) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (g.__teamScoreCronBusy) return NextResponse.json({ skipped: 'busy' });
  g.__teamScoreCronBusy = true;
  const t0 = Date.now();
  try {
    const dry = sp.get('dry');
    const dryRun = dry !== null && !['0', 'false', 'no'].includes(dry.toLowerCase());
    const n = Number(sp.get('days'));
    const windowDays = Number.isInteger(n) && n >= 1 && n <= MAX_RANGE_DAYS ? n : JUDGE_WINDOW_DAYS;
    const nowMs = Date.now();
    const today = todayIst(nowMs);
    let start = addDays(today, -(windowDays - 1));
    if (start < FIRST_DAY) start = FIRST_DAY;            // nothing before the report's first day is worth a call
    const days = rangeDays(start, today);

    // 1. The AI check (fresh numbers: what the cache holds may be a minute old).
    const engine = await computeDays(days, nowMs, { fresh: true });
    const candidates = engine.candidates;
    if (dryRun) {
      const plan = await freezePlan(nowMs, 3);
      console.log(`[team-score] cron dry: candidates=${candidates.length} ready=${plan.ready.length} waiting=${plan.waiting.length}`);
      return NextResponse.json({
        success: true, dry: true, candidates: candidates.length, would_freeze: plan.ready, waiting: plan.waiting, took_ms: Date.now() - t0,
      });
    }
    const judged = await runJudge({ candidates, max: JUDGE_MAX_PER_RUN, budgetMs: 70_000 });

    // 2. Freeze settled days, oldest first, at most 3 a run.
    const plan = await freezePlan(Date.now(), 3);
    const frozen: string[] = [];
    for (const d of plan.ready) {
      if (await snapshotDay(d, 'auto', 'cron', null)) frozen.push(d);
    }

    // 3. Clear and answer.
    clearScoreCache();
    const took = Date.now() - t0;
    console.log(`[team-score] cron asked=${judged.asked} yes=${judged.thanks_yes} unclear=${judged.unclear} failed=${judged.failed} capped=${judged.capped} model_ok=${judged.model_ok} frozen=${frozen.length} waiting=${plan.waiting.length} ${took} ms`);
    return NextResponse.json({ success: true, judged, frozen, waiting: plan.waiting, took_ms: took });
  } catch (err) {
    const e = errorReply(err, 'cron');
    return NextResponse.json(e.body, { status: e.status });
  } finally {
    g.__teamScoreCronBusy = false;
  }
}
