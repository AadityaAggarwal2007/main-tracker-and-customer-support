// ── Team score (owner, 2026-10-01, part 4): the report. Server only. ──
// STAFF ONLY (/api/team/score*, /api/cron/team-score). Puts the leaderboard together from frozen days
// (team_score_days, written once a day is settled) and live days (load.ts + the pure engine, cached
// for a minute), serves the drill-down rows with masked message lines, freezes settled days and saves
// the point weights. The Super Admin sees the whole board; a member who can reply gets only their own
// row (selfView, owner answer A1 2026-10-02): the cache always holds the full result and is filtered
// per request. Never read by the widget, the AI, the learner or search. Logs carry counts only, never
// customer text. Spec: phase 4, sections 4.2 and 4.3.
import { query } from '@/lib/db';
import { orderNameJoinSql } from '@/lib/chat/display-name';
import {
  ENGINE_VERSION,
  type DayResult, type DayState, type EngineResult, type ItemKind, type ItemRow, type ItemsResponse, type Metric,
  type PersonRow, type ScoreItem, type SettingsRow, type TeamScoreResponse, type Weights,
} from './types';
import { DAY_MS, addDays, dayLabel, dayStartMs, hhmm, istDay, todayIst } from './clock';
import { AI_GRACE_MS, MAX_RANGE_DAYS, SETTLE_AFTER_MS, pointsFrom, settingsForDay, validateWeights } from './rules';
import { buildTeamScore, mergeDays, type ScoreCounts } from './engine';
import { EVENTS_SINCE_SQL, SETTINGS_SQL, loadMeta, loadScoreInput, mapDbError, settingsRows, type ScoreMeta } from './load';
import { maskForJudge, stripEmailQuote } from './words';
import { modelStatus } from './judge';

// The first day the report can show (part 3, team routing, went live that evening).
export const FIRST_DAY = '2026-10-01';

// A request the Super Admin can fix (bad date, bad weight, short reason): answered 400 with the text.
export class TeamScoreInputError extends Error {
  status = 400;
  constructor(message: string) { super(message); this.name = 'TeamScoreInputError'; }
}

// What a route answers for an error. Never the error's own text for a 500 (it could quote data).
export function errorReply(err: unknown, where: string): { status: number; body: { error: string } } {
  const e = mapDbError(err) as { name?: string; status?: number; message?: string } | null;
  if (e && (e.name === 'TeamScoreNotInstalled' || e.name === 'TeamScoreBusy' || e.name === 'TeamScoreInputError') && e.message) {
    return { status: e.status || (e.name === 'TeamScoreInputError' ? 400 : 503), body: { error: e.message } };
  }
  console.error(`[team-score] ${where} failed: ${String(e?.message || e || 'error').slice(0, 200)}`);
  return { status: 500, body: { error: 'The team score could not be loaded. Try again in a minute.' } };
}

// ── Dates ──
const RANGE_ERROR = 'Pick dates as YYYY-MM-DD, up to 31 days, not in the future';

// The shared validator: real dates, 2026-10-01 <= from <= to <= today (IST), at most 31 days.
export function parseRange(fromRaw: string | null | undefined, toRaw: string | null | undefined, nowMs: number):
  { ok: true; from: string; to: string } | { ok: false; error: string } {
  const today = todayIst(nowMs);
  const from = String(fromRaw ?? '').trim() || today;
  const to = String(toRaw ?? '').trim() || today;
  const a = dayStartMs(from), b = dayStartMs(to);
  if (a === null || b === null || from < FIRST_DAY || from > to || to > today) return { ok: false, error: RANGE_ERROR };
  if (Math.round((b - a) / DAY_MS) + 1 > MAX_RANGE_DAYS) return { ok: false, error: RANGE_ERROR };
  return { ok: true, from, to };
}

// Every India day from..to (both valid, from <= to).
export function rangeDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

// A reason for "Recompute": control characters out, trimmed, 3-200 characters. null = not good.
export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  const n = Array.from(s).length;
  return n >= 3 && n <= 200 ? s : null;
}

// ── Which item kinds stand behind each clickable number ──
export const METRIC_KINDS: Record<Metric, ItemKind[]> = {
  chats: ['chat'],
  customers: ['chat'],
  convinced: ['convinced'],
  thanks: ['thanks'],
  frustrated: ['frustrated'],
  unanswered_2h: ['unanswered_2h'],
  sent: ['sent', 'received', 'taken_from', 'released'],
  picked: ['picked'],
  taken_no_reply: ['taken_no_reply'],
  angry: ['angry'],
  fast_reply: ['fast_reply'],
  solved: ['solved', 'closed_waiting'],
  points: ['thanks', 'solved', 'fast_reply', 'unanswered_2h', 'angry', 'closed_waiting', 'convinced', 'chat'],
};
export function isMetric(x: unknown): x is Metric {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(METRIC_KINDS, x);
}

// ── Cache (one PM2 process) ──
interface Computed { result: EngineResult; meta: ScoreMeta; msgs: number; names: Map<string, string> }
interface Entry<T> { at: number; promise: Promise<T> }
interface Snap { day: string; kind: 'auto' | 'recompute'; reason: string | null; savedAt: string | null; summary: DayResult }
const g = globalThis as unknown as {
  __teamScoreCache?: Map<string, Entry<Computed>>;
  __teamScoreSnapCache?: Map<string, Entry<Map<string, Snap>>>;
  __teamScoreMetaCache?: Map<string, Entry<ScoreMeta>>;
  __teamScoreNames?: Map<string, string>;
  __teamScoreFreshAt?: number;
};
const MAX_ENTRIES = 8;
const computeCache = () => (g.__teamScoreCache ??= new Map());
const snapCache = () => (g.__teamScoreSnapCache ??= new Map());
const metaCache = () => (g.__teamScoreMetaCache ??= new Map());
const nameCache = () => (g.__teamScoreNames ??= new Map());

export function clearScoreCache(): void {
  g.__teamScoreCache?.clear();
  g.__teamScoreSnapCache?.clear();
  g.__teamScoreMetaCache?.clear();
  g.__teamScoreNames?.clear();
}

// 60 s while the days include today or yesterday (they still move), else 10 minutes.
function ttlFor(days: string[], nowMs: number): number {
  const today = todayIst(nowMs), yday = addDays(today, -1);
  return days.includes(today) || days.includes(yday) ? 60_000 : 600_000;
}

// One shared promise per key: two clicks run once; a failure is not kept.
function cached<T>(map: Map<string, Entry<T>>, key: string, ttl: number, fresh: boolean, make: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = map.get(key);
  if (!fresh && hit && now - hit.at < ttl) return hit.promise;
  const promise = make();
  map.delete(key);
  map.set(key, { at: now, promise });
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  promise.catch(() => { if (map.get(key)?.promise === promise) map.delete(key); });
  return promise;
}

// "Refresh" skips the cache at most once per 10 s per process; otherwise the cache answers.
function takeFresh(): boolean {
  const now = Date.now();
  if (now - (g.__teamScoreFreshAt ?? 0) < 10_000) return false;
  g.__teamScoreFreshAt = now;
  return true;
}

async function computeNow(days: string[], nowMs: number): Promise<Computed> {
  const input = await loadScoreInput(days, nowMs);
  const result = buildTeamScore(input);
  const names = new Map<string, string>();
  for (const a of [...input.actions].sort((x, y) => x.id - y.id)) if (a.actorName) names.set(a.actor, a.actorName);
  return {
    result,
    meta: { people: input.people, settings: input.settings, eventsSinceMs: input.eventsSinceMs, installedMs: input.installedMs },
    msgs: input.msgs.length,
    names,
  };
}

function computeCached(days: string[], nowMs: number, fresh: boolean): Promise<Computed> {
  return cached(computeCache(), days.join(','), ttlFor(days, nowMs), fresh, () => computeNow(days, nowMs));
}

// Load + engine for these contiguous India days, cached. fresh: computed now (and cached for others).
export async function computeDays(days: string[], nowMs: number, opts: { fresh?: boolean } = {}): Promise<EngineResult> {
  return (await computeCached(days, nowMs, !!opts.fresh)).result;
}

// ── Frozen days ──
const jsonOf = (x: unknown): unknown => {
  if (typeof x !== 'string') return x;
  try { return JSON.parse(x); } catch { return null; }
};
const isoOf = (x: unknown): string | null => {
  if (x === null || x === undefined) return null;
  const d = x instanceof Date ? x : new Date(String(x));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

function summaryOf(day: string, raw: unknown): DayResult {
  const s = (jsonOf(raw) || {}) as Partial<DayResult>;
  return {
    day,
    settingsId: Number(s.settingsId) || 0,
    pointsOn: s.pointsOn === true, eventsOn: s.eventsOn === true, healthOn: s.healthOn === true,
    people: Array.isArray(s.people) ? s.people : [],
    team: s.team && typeof s.team === 'object'
      ? { pool_waited_2h: s.team.pool_waited_2h ?? null, absent_waits: s.team.absent_waits ?? null, thanks_after_ai: Number(s.team.thanks_after_ai) || 0, unattributed: Array.isArray(s.team.unattributed) ? s.team.unattributed : [] }
      : { pool_waited_2h: null, absent_waits: null, thanks_after_ai: 0, unattributed: [] },
    items: [],
    aiPending: Number(s.aiPending) || 0,
  };
}

async function readSnapshots(from: string, to: string, nowMs: number, fresh: boolean): Promise<Map<string, Snap>> {
  return cached(snapCache(), `${from},${to}`, ttlFor(rangeDays(from, to), nowMs), fresh, async () => {
    const r = await query<Record<string, unknown>>(
      `SELECT DISTINCT ON (day) id, day::text, kind, reason, by_actor, created_at, summary
     FROM team_score_days WHERE day BETWEEN $1::date AND $2::date ORDER BY day, id DESC`,
      [from, to],
    ).catch((err) => { throw mapDbError(err); });
    const out = new Map<string, Snap>();
    for (const row of r.rows) {
      const day = String(row.day).slice(0, 10);
      if (out.has(day)) continue;
      out.set(day, {
        day, kind: row.kind === 'recompute' ? 'recompute' : 'auto',
        reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
        savedAt: isoOf(row.created_at),
        summary: summaryOf(day, row.summary),
      });
    }
    return out;
  });
}

function metaCached(nowMs: number, fresh: boolean): Promise<ScoreMeta> {
  return cached(metaCache(), 'meta', 60_000, fresh, () => loadMeta(nowMs));
}

// Names of people who are no longer team members: the name their latest event carried.
async function fillRemovedNames(rows: PersonRow[], meta: ScoreMeta, names: Map<string, string> | null): Promise<void> {
  const known = new Set(meta.people.map((p) => p.key));
  const missing = rows.filter((r) => r.key !== 'owner' && !known.has(r.key));
  if (!missing.length) return;
  const cache = nameCache();
  const ask = missing.map((r) => r.key).filter((k) => !(names && names.has(k)) && !cache.has(k));
  if (ask.length) {
    try {
      const r = await query<{ actor: string; actor_name: string }>(
        `SELECT DISTINCT ON (actor) actor, actor_name FROM chat_events
          WHERE actor = ANY($1::text[]) AND actor_name IS NOT NULL ORDER BY actor, id DESC`,
        [ask],
      );
      for (const row of r.rows) if (row.actor_name) cache.set(String(row.actor), String(row.actor_name));
    } catch { /* the plain label below */ }
    for (const k of ask) if (!cache.has(k)) cache.set(k, '');
  }
  for (const r of missing) r.name = (names && names.get(r.key)) || cache.get(r.key) || 'Removed member';
}

// ── GET /api/team/score ──
// The Points rules dialog (Super Admin only, review 2026-10-02): the newest saved weights row, which
// every day from its effective_from on uses, the row in force today and the rows still to come after
// today. `weights` is the row of the range's last day and can be older: a dialog filled from it saved
// the older numbers again as a new row and undid (or cancelled) a newer change. Members never get
// these (selfView).
export interface WeightsRow { id: number; values: Weights; effective_from: string }
export interface WeightsPlan { weights_latest: WeightsRow; weights_today: WeightsRow; weights_scheduled: WeightsRow[] }
export type TeamScoreReport = TeamScoreResponse & WeightsPlan;

export function weightsPlan(rows: SettingsRow[], today: string): WeightsPlan {
  const out = (r: SettingsRow): WeightsRow => ({ id: r.id, values: r.weights, effective_from: r.effectiveFrom });
  const latest = rows.length ? rows.reduce((a, b) => (b.id > a.id ? b : a)) : settingsForDay(rows, today);
  // A later-dated row applies only if no newer row starts on or before its day.
  const scheduled = rows.filter((r) => r.effectiveFrom > today && settingsForDay(rows, r.effectiveFrom).id === r.id)
    .sort((a, b) => cmp(a.effectiveFrom, b.effectiveFrom) || a.id - b.id);
  return { weights_latest: out(latest), weights_today: out(settingsForDay(rows, today)), weights_scheduled: scheduled.map(out) };
}

export async function getReport(from: string, to: string, opts: { fresh?: boolean; nowMs?: number } = {}): Promise<TeamScoreReport> {
  const t0 = Date.now();
  const nowMs = opts.nowMs ?? Date.now();
  const days = rangeDays(from, to);
  const fresh = !!opts.fresh && takeFresh();
  const snaps = await readSnapshots(from, to, nowMs, fresh);
  const live = days.filter((d) => !snaps.has(d));
  const comp = live.length ? await computeCached(rangeDays(live[0], live[live.length - 1]), nowMs, fresh) : null;
  const meta = comp ? comp.meta : await metaCached(nowMs, fresh);

  const results: DayResult[] = [];
  let pending = 0;
  for (const d of days) {
    const s = snaps.get(d);
    if (s) { results.push(s.summary); continue; }
    const r = comp?.result.days.find((x) => x.day === d);
    if (r) { results.push(r); pending += r.aiPending || 0; }
  }
  const merged = mergeDays(results, meta.people, nowMs);
  await fillRemovedNames([...merged.people, ...(merged.owner ? [merged.owner] : [])], meta, comp ? comp.names : null);

  const states: DayState[] = days.map((d) => {
    const s = snaps.get(d);
    if (!s) return { day: d, state: 'live', final_at: new Date((dayStartMs(d) as number) + SETTLE_AFTER_MS).toISOString(), saved_at: null, reason: null };
    return { day: d, state: s.kind === 'recompute' ? 'recomputed' : 'final', final_at: null, saved_at: s.savedAt, reason: s.kind === 'recompute' ? s.reason : null };
  });
  const w = settingsForDay(meta.settings, to);
  const plan = weightsPlan(meta.settings, todayIst(nowMs));
  const took = Date.now() - t0;
  console.log(`[team-score] ${from}..${to} ${live.length} live ${took} ms (${comp ? comp.msgs : 0} msgs, ${snaps.size} frozen)`);
  return {
    view: 'team',
    from, to, now: new Date(nowMs).toISOString(), live: live.length > 0,
    days: states,
    events_since: meta.eventsSinceMs === null ? null : new Date(meta.eventsSinceMs).toISOString(),
    health_from: addDays(istDay(meta.installedMs), 1),
    points_from: pointsFrom(meta.settings),
    weights: { id: w.id, values: w.weights, effective_from: w.effectiveFrom },
    ...plan,
    judge: { pending, model_ok: modelStatus() },
    people: merged.people, owner: merged.owner, team: merged.team, leader: merged.leader,
    took_ms: took,
  };
}

// ── A member's own view (owner answer A1, 2026-10-02) ──
// Only their own row: never another member's row, rank, the leader line, the team footer, the AI
// queue of others or the Super Admin's recompute note. Built fresh from the full report on every
// request (the cache never holds a filtered copy, so nothing leaks from one viewer to another).
// Their own counts still name the colleague they sent a chat to (their own action).
export function selfView(full: TeamScoreResponse, key: string): TeamScoreResponse {
  const mine = full.people.find((p) => p.key === key) || null;
  const row = mine ? { ...mine, ranked: false, rank: null } : null;
  return {
    view: 'self',
    from: full.from, to: full.to, now: full.now, live: full.live,
    days: full.days.map((d) => ({ ...d, reason: null })),
    events_since: full.events_since, health_from: full.health_from, points_from: full.points_from,
    weights: full.weights,
    judge: { pending: row ? (row.counts.thanks_pending || 0) + (row.counts.convinced_pending || 0) : 0, model_ok: null },
    people: row ? [row] : [],
    owner: null,
    team: { pool_waited_2h: null, absent_waits: null, thanks_after_ai: 0, unattributed: [] },
    leader: null,
    took_ms: full.took_ms,
  };
}

// ── GET /api/team/score/items ──
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const MAX_ITEMS = 200;

function timeOn(ms: number, day: string): string {
  return istDay(ms) === day ? hhmm(ms) : `${dayLabel(istDay(ms))} ${hhmm(ms)}`;
}

export async function getItems(from: string, to: string, person: string, metric: Metric): Promise<ItemsResponse> {
  const kinds = METRIC_KINDS[metric];
  if (!kinds) throw new TeamScoreInputError('Unknown metric');
  const nowMs = Date.now();
  const days = rangeDays(from, to);
  const kindRe = '^(' + kinds.join('|') + ')$';
  // like_regex takes only a string literal in jsonpath (not a $variable), so the path carries the
  // pattern itself; the kinds come from the fixed list above, never from the request.
  const path = `$[*] ? (@.actor == $a && @.kind like_regex "${kindRe}")`;
  let snapRows: Record<string, unknown>[];
  try {
    snapRows = (await query<Record<string, unknown>>(
      `SELECT DISTINCT ON (day) day::text,
          jsonb_path_query_array(items, $5::jsonpath, jsonb_build_object('a', $3::text, 'k', $4::text)) AS items
     FROM team_score_days WHERE day BETWEEN $1::date AND $2::date ORDER BY day, id DESC`,
      [from, to, person, kindRe, path],
    )).rows;
  } catch (err) {
    throw mapDbError(err);
  }
  const want = (it: ScoreItem | null | undefined): it is ScoreItem =>
    !!it && it.actor === person && kinds.includes(it.kind) && (metric !== 'points' || it.points !== 0 || it.pending === true);
  let all: ScoreItem[] = [];
  const frozen = new Set<string>();
  for (const row of snapRows) {
    const day = String(row.day).slice(0, 10);
    if (frozen.has(day)) continue;
    frozen.add(day);
    const list = jsonOf(row.items);
    if (Array.isArray(list)) for (const it of list as ScoreItem[]) if (want(it)) all.push(it);
  }
  const live = days.filter((d) => !frozen.has(d));
  let comp: Computed | null = null;
  if (live.length) {
    comp = await computeCached(rangeDays(live[0], live[live.length - 1]), nowMs, false);
    const liveSet = new Set(live);
    for (const d of comp.result.days) if (liveSet.has(d.day)) for (const it of d.items) if (want(it)) all.push(it);
  }
  all = all.sort((a, b) => b.at - a.at || cmp(a.conv, b.conv) || cmp(a.kind, b.kind) || cmp(a.msgs?.[0] ?? '', b.msgs?.[0] ?? ''));
  const total = all.length;
  const counted = all.filter((it) => it.counted).length;
  const cut = all.slice(0, MAX_ITEMS);

  const meta = comp ? comp.meta : await metaCached(nowMs, false);
  const nameOf = new Map(meta.people.map((p) => [p.key, p.name] as [string, string]));
  const staffName = (k: string): string => nameOf.get(k) || (k === 'owner' ? 'Super Admin' : comp?.names.get(k) || 'Staff');

  const convIds = Array.from(new Set(cut.map((it) => it.conv).filter(Boolean)));
  const msgIds = Array.from(new Set(cut.flatMap((it) => it.msgs || []).filter(Boolean)));
  const chats = new Map<string, NonNullable<ItemRow['chat']>>();
  const msgs = new Map<string, { sender: string; text: string; at: number }>();
  try {
    if (convIds.length) {
      const r = await query<Record<string, unknown>>(
        `SELECT c.id, c.status, c.source, (c.verified_order_id IS NOT NULL OR c.phone_match_order_id IS NOT NULL) AS known,
          COALESCE(oname.name, NULLIF(btrim(c.visitor_name), ''), 'Visitor') AS name
     FROM conversations c JOIN sites s ON s.id = c.site_id ${orderNameJoinSql('c', 's')}
    WHERE c.id = ANY($1::text[])`,
        [convIds],
      );
      for (const row of r.rows) {
        chats.set(String(row.id), {
          id: String(row.id),
          name: maskForJudge(String(row.name ?? 'Visitor'), 80) || 'Visitor',
          status: String(row.status ?? ''), known: row.known === true, source: String(row.source ?? 'chat'),
        });
      }
    }
    if (msgIds.length) {
      const r = await query<Record<string, unknown>>(
        `SELECT id, sender, left(content, 400) AS text, (extract(epoch FROM created_at::timestamptz)*1000)::float8 AS at
     FROM messages WHERE id = ANY($1::text[])`,
        [msgIds],
      );
      for (const row of r.rows) msgs.set(String(row.id), { sender: String(row.sender), text: String(row.text ?? ''), at: Number(row.at) });
    }
  } catch (err) {
    throw mapDbError(err);
  }

  const items: ItemRow[] = cut.map((it) => {
    const chat = chats.get(it.conv) || null;
    const lines: ItemRow['messages'] = [];
    for (const id of it.msgs || []) {
      const m = msgs.get(id);
      if (!m) continue;
      const role: 'customer' | 'staff' | 'ai' = m.sender === 'agent' ? 'staff' : m.sender === 'ai' ? 'ai' : 'customer';
      let text = m.text;
      if (role === 'customer' && chat?.source === 'email') text = stripEmailQuote(text);
      lines.push({
        id, role,
        // A staff line in an item is the reply of the item's own person (thanks, convinced, solved, 10-min, chat).
        by: role === 'staff' ? staffName(it.actor) : role === 'ai' ? 'AI' : null,
        at_ist: Number.isFinite(m.at) ? timeOn(m.at, it.day) : '',
        text: maskForJudge(text, 160),
      });
    }
    return { ...it, at_ist: timeOn(it.at, it.day), chat, messages: lines };
  });
  return { person, metric, total, counted, items };
}

// ── Freezing a day ──
const AI_NOT_DONE = 'AI check not done';

// A frozen day never changes again, so an AI check still pending at that moment stays not counted.
function settlePending(d: DayResult): DayResult {
  if (!d.items.some((it) => it.pending && (it.kind === 'thanks' || it.kind === 'convinced'))) return d;
  const people = d.people.map((p) => ({ ...p, counts: { ...p.counts } }));
  const byKey = new Map(people.map((p) => [p.key, p] as [string, typeof p]));
  const items = d.items.map((it) => {
    if (!it.pending || (it.kind !== 'thanks' && it.kind !== 'convinced')) return it;
    const p = byKey.get(it.actor);
    if (p) {
      if (it.kind === 'thanks') { p.counts.thanks_pending = Math.max(0, p.counts.thanks_pending - 1); p.counts.thanks_not_counted += 1; }
      else {
        p.counts.convinced_pending = Math.max(0, p.counts.convinced_pending - 1);
        const pc = p.counts as ScoreCounts;
        pc.convinced_not_counted = (pc.convinced_not_counted || 0) + 1;
      }
    }
    return { ...it, pending: false, counted: false, points: 0, why: AI_NOT_DONE };
  });
  return { ...d, people, items };
}

export async function snapshotDay(day: string, kind: 'auto' | 'recompute', by: string, reason: string | null): Promise<boolean> {
  if (dayStartMs(day) === null) throw new TeamScoreInputError('Pick a day as YYYY-MM-DD');
  // Recompute only a day the cron already froze: its 'auto' row is unique per day and never changes,
  // so a recompute always has the higher id and stays the one shown. On a day not frozen yet the
  // cron's later 'auto' row would replace it and the owner's reason would be lost.
  if (kind === 'recompute') {
    const f = await query(`SELECT 1 FROM team_score_days WHERE day = $1::date AND kind = 'auto' LIMIT 1`, [day]).catch((e) => { throw mapDbError(e); });
    if (!(f.rows?.length)) throw new TeamScoreInputError('Only days that are already final can be recomputed');
  }
  const comp = await computeNow([day], Date.now());       // never the cache
  const raw = comp.result.days.find((x) => x.day === day);
  if (!raw) throw new Error('team-score: day not computed');
  const d = settlePending(raw);
  const summary: DayResult = { ...d, items: [] };
  let inserted = false;
  try {
    const r = await query(
      `INSERT INTO team_score_days (day, kind, engine_version, settings_id, summary, items, ai_pending, by_actor, reason)
       VALUES ($1::date, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
       ON CONFLICT DO NOTHING RETURNING id`,
      [day, kind, ENGINE_VERSION, d.settingsId, JSON.stringify(summary), JSON.stringify(d.items), raw.aiPending || 0, by,
        kind === 'recompute' ? reason : null],
    );
    inserted = (r.rows?.length ?? 0) > 0 || (r.rowCount ?? 0) > 0;
  } catch (err) {
    throw mapDbError(err);
  }
  if (inserted) clearScoreCache();
  return inserted;
}

// Days to freeze now (oldest first, at most max) and days held back by pending AI checks.
export async function freezePlan(nowMs: number, max: number): Promise<{ ready: string[]; waiting: { day: string; ai_pending: number }[] }> {
  try {
    const ev = await query<{ t: number | null }>(EVENTS_SINCE_SQL);
    const t = ev.rows[0]?.t;
    if (t === null || t === undefined || !Number.isFinite(Number(t))) return { ready: [], waiting: [] };
    const today = todayIst(nowMs);
    let start = istDay(Number(t));
    const floor = addDays(today, -60);
    if (start < floor) start = floor;
    if (start < FIRST_DAY) start = FIRST_DAY;
    const end = addDays(today, -2);
    if (start > end) return { ready: [], waiting: [] };
    const auto = await query<{ day: string }>(
      `SELECT day::text AS day FROM team_score_days WHERE kind = 'auto' AND day BETWEEN $1::date AND $2::date`,
      [start, end],
    );
    const have = new Set(auto.rows.map((r) => String(r.day).slice(0, 10)));
    const cand = rangeDays(start, end).filter((d) => !have.has(d) && nowMs >= (dayStartMs(d) as number) + SETTLE_AFTER_MS);
    const check = cand.filter((d) => nowMs < (dayStartMs(d) as number) + AI_GRACE_MS);
    const pending = new Map<string, number>();
    if (check.length) {
      const comp = await computeCached(rangeDays(check[0], check[check.length - 1]), nowMs, false);
      for (const d of comp.result.days) pending.set(d.day, d.aiPending || 0);
    }
    const ready: string[] = [], waiting: { day: string; ai_pending: number }[] = [];
    for (const d of cand) {
      const p = pending.get(d) ?? 0;
      if (check.includes(d) && p > 0) { waiting.push({ day: d, ai_pending: p }); continue; }
      if (ready.length < max) ready.push(d);
    }
    return { ready, waiting };
  } catch (err) {
    throw mapDbError(err);
  }
}

export async function settledDaysToSnapshot(nowMs: number, max: number): Promise<string[]> {
  return (await freezePlan(nowMs, max)).ready;
}

// ── Point weights ──
// A change can be planned up to 60 days ahead (the dialog says the same before it sends).
export const FAR_AHEAD_ERROR = 'Pick a day within the next 60 days.';
export async function saveSettings(input: { weights: unknown; effectiveFrom: unknown; pointsFrom?: unknown }, by: string): Promise<{ id: number }> {
  const v = validateWeights(input?.weights);
  if ('error' in v) throw new TeamScoreInputError(v.error);
  const today = todayIst(Date.now());
  const ef = typeof input.effectiveFrom === 'string' ? input.effectiveFrom.trim() : '';
  if (dayStartMs(ef) === null || ef < today) {
    throw new TeamScoreInputError('Past days keep their points. Pick today or a later day.');
  }
  if (ef > addDays(today, 60)) throw new TeamScoreInputError(FAR_AHEAD_ERROR);
  try {
    let pf: string;
    if (input.pointsFrom === undefined || input.pointsFrom === null || input.pointsFrom === '') {
      const rows = settingsRows((await query<Record<string, unknown>>(SETTINGS_SQL)).rows);
      pf = rows.length ? pointsFrom(rows) : ef;
    } else {
      pf = typeof input.pointsFrom === 'string' ? input.pointsFrom.trim() : '';
      if (dayStartMs(pf) === null || pf < FIRST_DAY) throw new TeamScoreInputError('Points start day: pick a date from 2026-10-01 (YYYY-MM-DD).');
    }
    const r = await query<{ id: number | string }>(
      `INSERT INTO team_score_settings (weights, effective_from, points_from, created_by) VALUES ($1::jsonb, $2::date, $3::date, $4) RETURNING id`,
      [JSON.stringify(v.weights), ef, pf, String(by || 'owner').slice(0, 40)],
    );
    clearScoreCache();
    return { id: Number(r.rows[0]?.id) || 0 };
  } catch (err) {
    throw mapDbError(err);
  }
}
