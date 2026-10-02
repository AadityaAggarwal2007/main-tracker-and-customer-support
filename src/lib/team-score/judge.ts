// ── Team score (owner, 2026-10-01, part 4): the AI check. Server only. ──
// STAFF ONLY. When the keywords (words.ts) cannot tell whether a customer's message is a real
// thank-you or accepts the answer ("thanks but kab aayega?"), one small model call decides, once per
// message, forever (team_score_verdicts: INSERT only, so a verdict is never re-rolled or paid for
// twice). Run by the cron (/api/cron/team-score) and the Super Admin's "Check now", never while a
// report is read and never in the customer's reply path. The model sees only the masked team reply
// and the masked customer message (buildJudgeInput: no staff name, score or points). Capped per run
// and per India day; a circuit breaker stops a run when the model is down. Logs carry counts only.
// The only file under src/lib/team-score/ that imports the AI module (getClient / isRetryable /
// attemptOrder, the same chain as health.ts askModel). Spec: phase 4, section 4.4.
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { query } from '@/lib/db';
import { attemptOrder, getClient, isRetryable } from '@/lib/chat/ai';
import type { JudgeCandidate } from './types';
import { addDays, istDayStart, todayIst } from './clock';
import { JUDGE_FAIL_LIMIT, JUDGE_MAX_PER_DAY, JUDGE_WINDOW_DAYS } from './rules';
import { JUDGE_INSTRUCTION, buildJudgeInput, parseJudgeReply } from './words';
import { mapDbError } from './load';
import { FIRST_DAY, clearScoreCache, computeDays, rangeDays } from './report';

const JUDGE_TIMEOUT_MS = 20_000;
const JUDGE_MAX_TOKENS = 800;
const CONCURRENCY = 3;
const BREAKER_FAILS = 3;   // call failures in a row that stop a run

// modelOk: null until the first call since this process started. streak: failed calls in a row,
// across runs (3 = "not answering", also when each run had only one message to ask about).
interface JudgeState { modelOk: boolean | null; streak: number; failures: Map<string, number>; failDay: string; failToday: number }
const g = globalThis as unknown as { __teamScoreJudge?: JudgeState; __teamScoreJudgeBusy?: boolean };
function state(): JudgeState {
  return (g.__teamScoreJudge ??= { modelOk: null, streak: 0, failures: new Map(), failDay: '', failToday: 0 });
}

// Did the AI check answer last time? null = not tried since this process started.
export function modelStatus(): boolean | null {
  return state().modelOk;
}

// Is a run going right now (the cron's or "Check now")? One run at a time in this process: two at
// once would ask about the same messages (paid twice) and could pass the daily cap together.
export function judgeBusy(): boolean {
  return !!g.__teamScoreJudgeBusy;
}

// A model that answered with nothing we can read: the next model is tried (like health.ts).
class UnreadableVerdict extends Error {
  status = 502;
  constructor(model: string) { super(`${model} gave no verdict`); }
}

type Asked = { kind: 'verdict'; thanks: boolean; convinced: boolean; model: string } | { kind: 'unclear'; model: string | null };

async function askModel(c: JudgeCandidate): Promise<Asked> {
  const models = attemptOrder();
  let lastErr: unknown = null, answered = 0, lastModel: string | null = null;
  for (const model of models) {
    try {
      const res = await getClient().chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: JUDGE_INSTRUCTION },
            { role: 'user', content: buildJudgeInput(c.teamText, c.customerText) },
          ],
          max_tokens: JUDGE_MAX_TOKENS,
          // The same message must get the same answer every time.
          temperature: 0,
          // A one-line verdict needs no thinking (an OpenRouter field the SDK does not type).
          reasoning: { enabled: false },
        } as ChatCompletionCreateParamsNonStreaming,
        { timeout: JUDGE_TIMEOUT_MS, maxRetries: 0 },
      );
      answered += 1; lastModel = model;
      const parsed = parseJudgeReply(res?.choices?.[0]?.message?.content);
      if (parsed) return { kind: 'verdict', thanks: parsed.thanks, convinced: parsed.convinced, model };
      lastErr = new UnreadableVerdict(model);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) break;
    }
  }
  // Every model answered, none in the asked form: recorded as unclear (counts as "no").
  if (models.length > 0 && answered === models.length) return { kind: 'unclear', model: lastModel };
  throw lastErr instanceof Error ? lastErr : new Error('no model answered');
}

const VERDICT_SQL = `INSERT INTO team_score_verdicts (message_id, conversation_id, thanks, convinced, source, model)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (message_id) DO NOTHING`;

async function saveVerdict(c: JudgeCandidate, thanks: boolean | null, convinced: boolean | null,
  source: 'ai' | 'ai_unclear' | 'ai_failed', model: string | null): Promise<boolean> {
  const r = await query(VERDICT_SQL, [c.messageId, c.conv, thanks, convinced, source, model]);
  return (r.rowCount ?? 0) > 0 || (r.rows?.length ?? 0) > 0;
}

export async function runJudge(opts: { candidates?: JudgeCandidate[]; max: number; budgetMs: number }): Promise<{
  asked: number; thanks_yes: number; unclear: number; failed: number; capped: boolean; model_ok: boolean; busy?: boolean }> {
  const t0 = Date.now();
  const st = state();
  // Another run is going: ask nothing (its messages are asked once, by that run). Checked and taken
  // before any await, so two callers can never both get in.
  if (g.__teamScoreJudgeBusy) return { asked: 0, thanks_yes: 0, unclear: 0, failed: 0, capped: false, model_ok: st.modelOk !== false, busy: true };
  const out = { asked: 0, thanks_yes: 0, unclear: 0, failed: 0, capped: false, model_ok: st.modelOk !== false };
  const today = todayIst(t0);
  if (st.failDay !== today) { st.failDay = today; st.failToday = 0; }
  let inserted = 0, dbErrors = 0;
  g.__teamScoreJudgeBusy = true;   // freed in the finally below
  try {
    // 1. Candidates (the engine lists them oldest first): newest first, one per message.
    let cands = opts.candidates;
    if (!cands) {
      let start = addDays(today, -(JUDGE_WINDOW_DAYS - 1));
      if (start < FIRST_DAY) start = FIRST_DAY;
      cands = (await computeDays(rangeDays(start, today), t0)).candidates;
    }
    const seen = new Set<string>();
    const list: JudgeCandidate[] = [];
    for (let i = (cands || []).length - 1; i >= 0; i--) {
      const c = cands[i];
      if (!c || !c.messageId || seen.has(c.messageId)) continue;
      seen.add(c.messageId);
      list.push(c);
    }
    if (list.length && opts.max > 0) {
      // 2. Never ask twice about a message that already has a verdict.
      const done = await query<{ message_id: string }>(`SELECT message_id FROM team_score_verdicts WHERE message_id = ANY($1)`, [list.map((c) => c.messageId)]);
      const have = new Set(done.rows.map((r) => String(r.message_id)));
      const todo = list.filter((c) => !have.has(c.messageId));
      // 3. Daily cap: verdict rows written since India midnight plus calls that failed today.
      const usedQ = await query<{ count?: string | number; n?: string | number }>(
        `SELECT count(*) FROM team_score_verdicts WHERE created_at >= $1::timestamptz`,
        [new Date(istDayStart(t0)).toISOString()],
      );
      const used = Number(usedQ.rows[0]?.count ?? usedQ.rows[0]?.n ?? 0) + st.failToday;
      const dayLeft = Math.max(0, JUDGE_MAX_PER_DAY - used);
      const want = Math.min(Math.max(0, Math.floor(opts.max)), todo.length);
      const n = Math.min(want, dayLeft);
      if (n < want) out.capped = true;
      const queue = todo.slice(0, n);

      // 4. Calls: 3 at a time, none started after the time budget, stop after 3 failures in a row.
      // After a failure no new call starts until the calls already running have answered, so a model
      // that is down costs exactly 3 calls, never 3 plus the ones started meanwhile.
      let next = 0, streak = 0, stop = false, running = 0;
      let wake: (() => void) | null = null, settled: Promise<void> | null = null;
      const nextSettled = () => (settled ??= new Promise<void>((resolve) => { wake = () => { settled = null; wake = null; resolve(); }; }));
      const worker = async () => {
        while (!stop && next < queue.length && Date.now() - t0 < opts.budgetMs) {
          if (streak > 0 && running > 0) { await nextSettled(); continue; }
          const c = queue[next++];
          out.asked += 1;
          running += 1;
          let asked: Asked | null = null;
          try {
            asked = await askModel(c);
          } catch {
            asked = null;
          } finally {
            running -= 1;
          }
          if (!asked) {
            out.failed += 1; st.failToday += 1; streak += 1; st.streak += 1;
            const f = (st.failures.get(c.messageId) || 0) + 1;
            st.failures.set(c.messageId, f);
            if (streak >= BREAKER_FAILS) stop = true;
            if (streak >= BREAKER_FAILS || st.streak >= BREAKER_FAILS) st.modelOk = false;
            wake?.();
            if (f >= JUDGE_FAIL_LIMIT) {
              st.failures.delete(c.messageId);
              try { if (await saveVerdict(c, null, null, 'ai_failed', null)) inserted += 1; } catch { dbErrors += 1; }
            }
            continue;
          }
          streak = 0; st.streak = 0; st.modelOk = true; st.failures.delete(c.messageId);
          wake?.();
          try {
            if (asked.kind === 'verdict') {
              if (asked.thanks) out.thanks_yes += 1;
              if (await saveVerdict(c, asked.thanks, asked.convinced, 'ai', asked.model)) inserted += 1;
            } else {
              out.unclear += 1;
              if (await saveVerdict(c, false, false, 'ai_unclear', asked.model)) inserted += 1;
            }
          } catch {
            dbErrors += 1;
          }
        }
        wake?.();
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      if (st.failures.size > 5000) st.failures.clear();
    }
  } catch (err) {
    throw mapDbError(err);
  } finally {
    g.__teamScoreJudgeBusy = false;
    out.model_ok = st.modelOk !== false;
    // 7. Counts only, never text.
    console.log(`[team-score] judge asked=${out.asked} yes=${out.thanks_yes} unclear=${out.unclear} failed=${out.failed} capped=${out.capped}${dbErrors ? ` save_errors=${dbErrors}` : ''}`);
    // 8. New verdicts change the report.
    if (inserted > 0) clearScoreCache();
  }
  return out;
}
