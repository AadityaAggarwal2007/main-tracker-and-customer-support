import type {
  Counts, DayResult, InPerson, Part, PersonKey, PersonRow, PointKind, TeamDay, TeamScoreResponse,
} from './types';
import { WEIGHT_KEYS, OWNER_RANKED } from './rules';
import { cmp } from './ctx';

const addN = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : a + b);

// The counts the engine and mergeDays build: Counts plus the "Convinced" items that do not count
// (visitor not verified, AI could not decide, an "ok" to a holding line), like thanks_not_counted,
// so that number can be opened too (review 2026-10-02). A frozen day saved before it reads as 0.
export type ScoreCounts = Counts & { convinced_not_counted: number };

export function emptyCounts(evOn: boolean, hOn: boolean): ScoreCounts {
  const e = evOn ? 0 : null, h = hOn ? 0 : null;
  return {
    replies: 0, after_hours: 0, chats: 0, customers: 0,
    thanks: 0, thanks_pending: 0, thanks_not_counted: 0, asked_thanks: 0,
    convinced: 0, convinced_pending: 0, convinced_not_counted: 0,
    frustrated: h,
    unanswered_2h: e, taken_no_reply: e,
    picked: e, picked_pool: e, picked_take: e,
    sent: e, sent_to: [],
    received: e, taken_from: e, released: e,
    fast_reply: e, solved: e, solved_pending: e, closed_waiting: e,
    angry: h,
    holding_now: null, waiting_now: null,
    online: null, days_in: 0,
  };
}

// ── A range of days into one leaderboard ──
const NUM_KEYS: (keyof ScoreCounts)[] = [
  'replies', 'after_hours', 'chats', 'thanks', 'thanks_pending', 'thanks_not_counted', 'asked_thanks', 'convinced',
  'convinced_pending', 'convinced_not_counted', 'frustrated', 'unanswered_2h', 'taken_no_reply', 'picked', 'picked_pool', 'picked_take', 'sent',
  'received', 'taken_from', 'released', 'fast_reply', 'solved', 'solved_pending', 'closed_waiting', 'angry',
  'holding_now', 'waiting_now', 'days_in',
];

export function mergeDays(days: DayResult[], people: InPerson[], nowMs: number): {
  people: PersonRow[]; owner: PersonRow | null; team: TeamDay; leader: TeamScoreResponse['leader'] } {
  void nowMs;
  const pmap = new Map((people || []).map((p) => [p.key, p] as [string, InPerson]));
  interface Agg { counts: ScoreCounts; points: number | null; parts: Partial<Record<PointKind, Part>>; cus: Set<string>; sentTo: Map<string, { key: string | null; name: string; n: number }> }
  const agg = new Map<PersonKey, Agg>();
  const single = (days || []).length === 1;
  for (const d of days || []) {
    for (const pd of d.people || []) {
      let a = agg.get(pd.key);
      if (!a) {
        const c = emptyCounts(false, false);
        a = { counts: c, points: null, parts: {}, cus: new Set(), sentTo: new Map() };
        agg.set(pd.key, a);
      }
      const src = pd.counts;
      const dst = a.counts as unknown as Record<string, number | null>;
      for (const k of NUM_KEYS) dst[k as string] = addN(dst[k as string], (src as unknown as Record<string, number | null>)[k as string] ?? null);
      // replies & co are never null in a day; keep them numbers.
      for (const s of src.sent_to || []) {
        const sk = s.key ?? '';
        const g = a.sentTo.get(sk) || { key: s.key ?? null, name: s.name, n: 0 };
        g.n += s.n; g.name = s.name; a.sentTo.set(sk, g);
      }
      for (const cu of pd.cus || []) a.cus.add(cu);
      a.counts.online = single ? src.online : null;
      a.points = addN(a.points, pd.points);
      for (const k of WEIGHT_KEYS) {
        const p = pd.parts?.[k];
        if (!p) continue;
        const q = a.parts[k];
        // Days with different weights: no single "each" (the card then shows only n and the points).
        if (!q) a.parts[k] = { n: p.n, each: p.each, points: p.points };
        else { q.n += p.n; q.points += p.points; if (q.each !== p.each) q.each = null; }
      }
    }
  }
  const rows: PersonRow[] = [];
  for (const [key, a] of agg) {
    a.counts.customers = a.cus.size;
    a.counts.sent_to = Array.from(a.sentTo.values()).sort((x, y) => y.n - x.n || cmp(x.name, y.name) || cmp(x.key ?? '', y.key ?? ''));
    for (const k of ['replies', 'after_hours', 'chats', 'thanks', 'thanks_pending', 'thanks_not_counted', 'asked_thanks', 'convinced', 'convinced_pending', 'convinced_not_counted', 'days_in'] as const) {
      if (a.counts[k] === null) (a.counts as unknown as Record<string, number>)[k] = 0;
    }
    const p = pmap.get(key);
    const ranked = !!(p && (key !== 'owner' || OWNER_RANKED) && p.active && p.canReply);
    rows.push({
      key, name: p ? p.name : key === 'owner' ? 'Super Admin' : 'Removed member', tier: p ? p.tier : key === 'owner' ? 'owner' : 'junior',
      active: p ? p.active : false, ranked, rank: null, points: a.points, counts: a.counts, parts: a.parts,
    });
  }
  const rankedRows = rows.filter((r) => r.ranked).sort((x, y) => {
    const px = x.points === null ? -Infinity : x.points, py = y.points === null ? -Infinity : y.points;
    return (py - px) || (y.counts.thanks - x.counts.thanks) || (y.counts.customers - x.counts.customers) || cmp(x.name, y.name) || cmp(x.key, y.key);
  });
  rankedRows.forEach((r, i) => { r.rank = i + 1; });
  const others = rows.filter((r) => !r.ranked && r.key !== 'owner').sort((x, y) => cmp(x.name, y.name) || cmp(x.key, y.key));
  const owner = rows.find((r) => r.key === 'owner' && !r.ranked) || null;   // his own grey row, never ranked (Q3)
  const team: TeamDay = { pool_waited_2h: null, absent_waits: null, thanks_after_ai: 0, unattributed: [] };
  const unat = new Map<string, number>();
  for (const d of days || []) {
    team.pool_waited_2h = addN(team.pool_waited_2h, d.team.pool_waited_2h);
    team.absent_waits = addN(team.absent_waits, d.team.absent_waits);
    team.thanks_after_ai += d.team.thanks_after_ai || 0;
    for (const u of d.team.unattributed || []) unat.set(u.login, (unat.get(u.login) || 0) + u.replies);
  }
  team.unattributed = Array.from(unat.entries()).sort((a, b) => cmp(a[0], b[0])).map(([login, replies]) => ({ login, replies }));
  let leader: TeamScoreResponse['leader'] = null;
  for (const r of rankedRows) if (r.counts.thanks > 0 && (!leader || r.counts.thanks > leader.thanks)) leader = { key: r.key, name: r.name, thanks: r.counts.thanks };
  return { people: [...rankedRows, ...others], owner, team, leader };
}
