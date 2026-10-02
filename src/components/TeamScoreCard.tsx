'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ExternalLink, Loader2, RefreshCw, Settings, Trophy, X } from 'lucide-react';
import type {
  ItemKind, ItemRow, ItemsResponse, Metric, PersonRow, PointKind, TeamScoreResponse, Weights,
} from '@/lib/team-score/types';
import { DEFAULT_WEIGHTS, POINT_LABELS, WEIGHT_KEYS, rulesHinglish } from '@/lib/team-score/rules';
import { addDays, dayLabel } from '@/lib/team-score/clock';
import type { ScoreCounts } from '@/lib/team-score/engine';
import type { WeightsPlan, WeightsRow } from '@/lib/team-score/report';

// ── Team score (owner, 2026-10-01, part 4): the per-member daily report and incentive points. ──
// STAFF ONLY. The Super Admin sees the whole board ("Team score"); a member who can reply sees only
// their own card and its items ("My score", owner answer A1 2026-10-02): no leaderboard, leader line,
// team footer, Points rules or Recompute. The routes enforce it (/api/team/score, /api/team/score/items:
// a member's answer carries view 'self' and their own row only). Reads only those two routes; nothing
// here reaches a customer, the widget or the AI. Customers always see "Vastora Support". Points only,
// no money. The numbers are computed on the server (src/lib/team-score/engine.ts); this screen only
// shows them and opens the items behind each one.

const FIRST_DAY = '2026-10-01';            // the routes refuse earlier days
const REFRESH_MS = 120_000;                // Today: every 2 minutes while the tab is visible
const PERIOD_KEY = 'teamScore.period';
const MINUS = '−';

type Chip = 'today' | 'yesterday' | '7d' | 'month';
type Period = { chip: Chip } | { day: string };
const CHIPS: { v: Chip; label: string }[] = [
  { v: 'today', label: 'Today' }, { v: 'yesterday', label: 'Yesterday' },
  { v: '7d', label: 'Last 7 days' }, { v: 'month', label: 'This month' },
];

const METRIC_LABEL: Record<Metric, string> = {
  chats: 'Chats replied', customers: 'Chats replied', thanks: 'Thank you', convinced: 'Convinced',
  frustrated: 'Still frustrated', unanswered_2h: 'Left 2 h, no reply', sent: 'Sent to / received / taken',
  picked: 'Picked up', taken_no_reply: 'Taken, no reply', angry: 'Angry', fast_reply: '10-min reply',
  solved: 'Solved', points: 'Points',
};
const KIND_LABEL: Record<ItemKind, string> = {
  chat: 'Chat', thanks: 'Thank you', convinced: 'Convinced', frustrated: 'Still frustrated',
  unanswered_2h: 'Left 2 h, no reply', taken_no_reply: 'Taken, no reply', picked: 'Picked up', sent: 'Sent',
  received: 'Received', taken_from: 'Taken from', released: 'Released', fast_reply: '10-min reply',
  solved: 'Solved', closed_waiting: 'Closed while waiting', angry: 'Angry',
};
const STATUS_CHIP: Record<string, { label: string; fg: string; bg: string }> = {
  human_needed: { label: 'Needs you', fg: 'var(--danger)', bg: 'var(--danger-light)' },
  agent_handling: { label: 'With team', fg: 'var(--primary)', bg: 'var(--primary-light)' },
  ai_handling: { label: 'AI', fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' },
  resolved: { label: 'Closed', fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' },
};
// The laptop table: the owner's order. Each label has a small Hinglish hint under it.
const HEAD: { label: string; hint: string }[] = [
  { label: 'Points', hint: '' },
  { label: 'Chats replied', hint: 'kitni chats ka reply' },
  { label: 'Customers', hint: 'unique customers' },
  { label: 'Convinced', hint: 'convince hue' },
  { label: 'Thank you', hint: 'thank you bola' },
  { label: 'Still frustrated', hint: 'abhi bhi frustrated' },
  { label: 'Left 2 h, no reply', hint: '2 ghante bina reply' },
  { label: 'Sent to', hint: 'kisko bheji' },
  { label: 'Picked up', hint: 'kitni baar chat uthai' },
  { label: 'Taken, no reply', hint: 'lekar reply nahi kiya' },
  { label: 'Angry', hint: 'gussa raha' },
  { label: '10-min reply', hint: '10 min me reply' },
  { label: 'Solved', hint: 'band + 24 ghante shanti' },
];

type C = Partial<ScoreCounts>;
interface Who { key: string; name: string }
interface Drawer { who: Who; metric: Metric; from: string; to: string; label: string }
interface Pop { who: Who; row: PersonRow; top: number; left: number }

// India day of now, as the screen asks for it (the server checks the same range).
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function rangeOf(p: Period, today: string): { from: string; to: string; label: string } {
  let from = today, to = today, label = 'Today';
  if ('day' in p) { from = to = p.day; label = dayLabel(p.day); }
  else if (p.chip === 'yesterday') { from = to = addDays(today, -1); label = 'Yesterday'; }
  else if (p.chip === '7d') { from = addDays(today, -6); label = 'Last 7 days'; }
  else if (p.chip === 'month') { from = `${today.slice(0, 8)}01`; label = 'This month'; }
  if (from < FIRST_DAY) from = FIRST_DAY;
  return { from, to, label };
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1)).replace('-', MINUS);
const signed = (n: number) => (n > 0 ? `+${fmtNum(n)}` : fmtNum(n));
const num = (c: C, k: keyof ScoreCounts): number | null => {
  const v = c[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const plural = (n: number, one: string, many: string) => `${fmtNum(n)} ${n === 1 ? one : many}`;

// '5 Oct, 1:00 AM' India time, from an ISO instant.
function fmtWhen(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 330 * 60000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${dayLabel(d.toISOString().slice(0, 10))}, ${h % 12 === 0 ? 12 : h % 12}:${m < 10 ? '0' : ''}${m} ${h < 12 ? 'AM' : 'PM'}`;
}
const istDayOf = (iso: string | null | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms + 330 * 60000).toISOString().slice(0, 10) : '';
};
function agoText(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

const muted: CSSProperties = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' };
const chosen: CSSProperties = { border: '1px solid var(--primary)', color: 'var(--primary)', background: 'var(--primary-light)' };
const small: CSSProperties = { fontSize: '0.6875rem', color: 'var(--fg-muted)', lineHeight: 1.4 };
const linkBtn: CSSProperties = {
  border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit',
  textAlign: 'inherit', textUnderlineOffset: 2,
};
const pill = (fg: string, bg: string): CSSProperties => ({
  fontSize: '0.625rem', fontWeight: 700, padding: '0.0625rem 0.4rem', borderRadius: 999, color: fg, background: bg,
  whiteSpace: 'nowrap', display: 'inline-block', lineHeight: 1.5,
});
const hoverOn = (e: { currentTarget: HTMLElement }) => { e.currentTarget.style.textDecoration = 'underline'; };
const hoverOff = (e: { currentTarget: HTMLElement }) => { e.currentTarget.style.textDecoration = 'none'; };

// A count: "—" with the reason when it is not counted yet (null), a button that opens the items
// when it is above zero, plain text at zero.
function Count({ n, tip, open, active, children }: {
  n: number | null; tip: string; open?: () => void; active?: boolean; children?: ReactNode;
}) {
  if (n === null) return <span title={tip} style={{ color: 'var(--fg-muted)', cursor: 'help' }}>—</span>;
  const clickable = !!open && (active ?? n > 0);
  if (!clickable) return <span>{children ?? fmtNum(n)}</span>;
  return (
    <button type="button" style={linkBtn} onClick={open} onMouseEnter={hoverOn} onMouseLeave={hoverOff}>
      {children ?? fmtNum(n)}
    </button>
  );
}

export default function TeamScoreCard({ token, onAlert, mine = false }: {
  token: string; onAlert: (type: string, message: string) => void;
  mine?: boolean;                       // a member's own score: the server answers view 'self' and decides
}) {
  // The parent's showAlert is a new function on every render; a ref keeps the loaders stable.
  const alertRef = useRef(onAlert);
  alertRef.current = onAlert;

  const [period, setPeriod] = useState<Period | null>(null);
  const [isPhone, setIsPhone] = useState(false);
  const [data, setData] = useState<TeamScoreResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);
  const [, setTick] = useState(0);
  const [pop, setPop] = useState<Pop | null>(null);
  const [openBreakdown, setOpenBreakdown] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [items, setItems] = useState<ItemsResponse | null>(null);
  const [itemsErr, setItemsErr] = useState<string | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [wDraft, setWDraft] = useState<Record<PointKind, string> | null>(null);
  const [rulesPlan, setRulesPlan] = useState<{ base: WeightsRow; today: WeightsRow | null; scheduled: WeightsRow[] } | null>(null);
  const [effFrom, setEffFrom] = useState('');
  const [ptsFrom, setPtsFrom] = useState('');
  const [saving, setSaving] = useState(false);
  const [reDay, setReDay] = useState('');
  const [reReason, setReReason] = useState('');
  const [recomputing, setRecomputing] = useState(false);
  const seqRef = useRef(0);
  const itemsSeqRef = useRef(0);

  const today = todayIst();
  const pKey = period ? ('day' in period ? `d:${period.day}` : period.chip) : '';
  const range = useMemo(() => (period ? rangeOf(period, today) : null), [pKey, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const beforeStart = !!range && range.to < FIRST_DAY;

  // The chosen period (remembered in this browser) and phone or laptop layout.
  useEffect(() => {
    let chip: Chip = 'today';
    try {
      const v = localStorage.getItem(PERIOD_KEY);
      if (v && CHIPS.some((c) => c.v === v)) chip = v as Chip;
    } catch { /* private window */ }
    setPeriod({ chip });
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setIsPhone(mq.matches);
    on();
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on); };
  }, []);

  const pickChip = (v: Chip) => {
    setPeriod({ chip: v });
    try { localStorage.setItem(PERIOD_KEY, v); } catch { /* ignore */ }
  };
  const pickDay = (v: string) => {
    if (isDay(v) && v >= FIRST_DAY && v <= today) setPeriod({ day: v });
  };

  const load = useCallback(async (fresh: boolean) => {
    if (!token || !range || range.to < FIRST_DAY) return;
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from: range.from, to: range.to });
      if (fresh) qs.set('fresh', '1');
      const r = await fetch(`/api/team/score?${qs}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (seq !== seqRef.current) return;
      if (r.ok && d && Array.isArray(d.people)) {
        setData(d as TeamScoreResponse); setFetchedAt(Date.now()); setDown(null); setBlocked(null);
      } else if (r.status === 403) setBlocked(d.error || 'You cannot see this score.');
      else if (r.status === 503) setDown(d.error || 'The team score is not available right now.');
      else alertRef.current('error', d.error || 'Could not load the team score');
    } catch {
      if (seq === seqRef.current) alertRef.current('error', 'Could not load the team score');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [token, range]);

  useEffect(() => { void load(false); }, [load]);

  // Today: ask again every 2 minutes while this tab is on screen. Nothing polls otherwise.
  useEffect(() => {
    if (!period || !('chip' in period) || period.chip !== 'today') return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(false); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [period, load]);

  // "Updated 2 min ago" stays true (a re-render only, no request).
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // The points popover follows its button: close it when the page moves.
  useEffect(() => {
    if (!pop) return;
    const close = () => setPop(null);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [pop]);

  const post = async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    try {
      const r = await fetch('/api/team/score', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) return d;
      alertRef.current('error', d.error || (r.status === 403 ? 'Only the Super Admin can change this.' : r.status === 429 ? 'Wait a moment' : 'Could not save'));
      return null;
    } catch { alertRef.current('error', 'Could not reach ShipTrack'); return null; }
  };

  const checkNow = async () => {
    setJudging(true);
    const d = await post({ action: 'judge' });
    setJudging(false);
    if (d) {
      const n = Number(d.judged) || 0;
      alertRef.current('success', n ? `AI checked ${plural(n, 'message', 'messages')}` : 'Nothing new to check right now');
      await load(false);
    }
  };

  // ── Drill-down ── (always for the range on screen, which may still be the last one while loading)
  const labelOf = (from: string, to: string) => (range && range.from === from && range.to === to ? range.label
    : from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`);
  const openDrawer = (who: Who, metric: Metric) => {
    if (!data) return;
    setPop(null);
    setItems(null); setItemsErr(null);
    setDrawer({ who, metric, from: data.from, to: data.to, label: labelOf(data.from, data.to) });
  };
  const loadItems = useCallback(async (dw: Drawer) => {
    const seq = ++itemsSeqRef.current;
    setItemsLoading(true); setItemsErr(null);
    try {
      const qs = new URLSearchParams({ from: dw.from, to: dw.to, person: dw.who.key, metric: dw.metric });
      const r = await fetch(`/api/team/score/items?${qs}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (seq !== itemsSeqRef.current) return;
      if (r.ok && d && Array.isArray(d.items)) setItems(d as ItemsResponse);
      else setItemsErr(d.error || (r.status === 403 ? 'You cannot see these items.' : 'Could not load these items'));
    } catch {
      if (seq === itemsSeqRef.current) setItemsErr('Could not load these items');
    } finally {
      if (seq === itemsSeqRef.current) setItemsLoading(false);
    }
  }, [token]);
  useEffect(() => { if (drawer) void loadItems(drawer); }, [drawer, loadItems]);
  const closeDrawer = () => { itemsSeqRef.current++; setDrawer(null); setItems(null); setItemsErr(null); setItemsLoading(false); };

  // ── Points rules ──
  // The dialog starts from the NEWEST saved weights (review 2026-10-02), never the weights of the day
  // on screen: saving those again as a new row undid a newer change from the save day on, or cancelled
  // one planned for a later day. A planned change is shown, and so is a save that would replace it.
  const openRules = () => {
    const plan = data as (TeamScoreResponse & Partial<WeightsPlan>) | null;
    const base: WeightsRow | null = plan?.weights_latest || (data?.weights ? { ...data.weights } : null);
    const w: Weights = { ...DEFAULT_WEIGHTS, ...(base?.values || {}) };
    const draft = {} as Record<PointKind, string>;
    for (const k of WEIGHT_KEYS) draft[k] = String(w[k]);
    setWDraft(draft);
    const sched = plan?.weights_scheduled;
    setRulesPlan(base ? { base, today: plan?.weights_today || null, scheduled: Array.isArray(sched) ? sched : [] } : null);
    // A change planned for a later day is edited on its own day unless the owner picks another.
    setEffFrom(base && isDay(base.effective_from) && base.effective_from > today ? base.effective_from : today);
    setPtsFrom(data?.points_from && isDay(data.points_from) ? data.points_from : '');
    setReDay(''); setReReason('');
    setRulesOpen(true);
  };
  const weightError = (v: string) => {
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n)) return 'a number';
    if (n < -10 || n > 10) return 'from −10 to 10';
    if (!Number.isInteger(n * 2)) return 'in steps of 0.5';
    return '';
  };
  const saveRules = async () => {
    if (!wDraft) return;
    const bad = WEIGHT_KEYS.find((k) => weightError(wDraft[k]));
    if (bad) { alertRef.current('error', `${POINT_LABELS[bad]}: use a number from -10 to 10, in steps of 0.5`); return; }
    if (!isDay(effFrom) || effFrom < today) { alertRef.current('error', 'Past days keep their points. Pick today or a later day.'); return; }
    if (effFrom > addDays(today, 60)) { alertRef.current('error', 'Pick a day within the next 60 days.'); return; }   // = the server's FAR_AHEAD_ERROR
    const weights = {} as Weights;
    for (const k of WEIGHT_KEYS) weights[k] = Number(wDraft[k]);
    const body: Record<string, unknown> = { action: 'settings', weights, effectiveFrom: effFrom };
    if (ptsFrom && ptsFrom !== data?.points_from) body.pointsFrom = ptsFrom;
    setSaving(true);
    const d = await post(body);
    setSaving(false);
    if (d) {
      alertRef.current('success', `Saved. Applies from ${dayLabel(effFrom)}; past days keep their points.`);
      setRulesOpen(false);
      await load(false);
    }
  };
  const lastFinal = addDays(today, -2);
  const canRecompute = lastFinal >= FIRST_DAY;
  const recompute = async () => {
    const reason = reReason.trim();
    if (!isDay(reDay) || reDay > lastFinal || reDay < FIRST_DAY) { alertRef.current('error', 'Only days that are already final can be recomputed'); return; }
    if (reason.length < 3 || reason.length > 200) { alertRef.current('error', 'Write why, in 3 to 200 characters'); return; }
    setRecomputing(true);
    const d = await post({ action: 'recompute', day: reDay, reason });
    setRecomputing(false);
    if (d) {
      alertRef.current('success', `Recomputed ${dayLabel(reDay)}. The new numbers are saved.`);
      setReDay(''); setReReason('');
      await load(false);
    }
  };

  // ── What the status strip and the "—" tooltips say ──
  const tips = useMemo(() => {
    const ev = data?.events_since
      ? `Picked, sent, 10-min, 2-hour and solved count from ${fmtWhen(data.events_since)} (when team routing went live).`
      : 'Picked, sent, 10-min, 2-hour and solved count from when team routing went live.';
    const health = `'Angry' and 'Still frustrated' count from ${data?.health_from ? dayLabel(data.health_from) : 'the day after setup'}.`;
    const points = `Points start on ${data?.points_from ? dayLabel(data.points_from) : 'the setup day'}. Earlier days show numbers only.`;
    return { ev, health, points };
  }, [data]);

  // A member's own score ("My score"): what the server answered, or the tab's hint before that.
  const self = data ? data.view === 'self' : mine;

  // Only the lines that apply (rebuilt on every render: it holds the Check now button).
  const strip: { key: string; text: ReactNode; fg: string; bg: string }[] = [];
  if (data) {
    const days = Array.isArray(data.days) ? data.days : [];
    const live = days.filter((d) => d.state === 'live');
    const fin = days.filter((d) => d.state === 'final');
    const rec = days.filter((d) => d.state === 'recomputed');
    if (live.length) {
      const until = live.map((d) => d.final_at || '').sort().pop();
      strip.push({ key: 'live', fg: 'var(--warning)', bg: 'var(--warning-light)',
        text: `Live: numbers can still change until ${fmtWhen(until) || 'two days after the day ends'} (24-hour checks and AI checks).` });
    }
    if (fin.length) {
      const saved = fin.map((d) => d.saved_at || '').sort().pop();
      strip.push({ key: 'final', fg: 'var(--success)', bg: 'var(--success-light)',
        text: fin.length === 1 && days.length === 1 ? `Final · saved ${fmtWhen(saved)}.` : `Final (${plural(fin.length, 'day', 'days')}) · saved ${fmtWhen(saved)}.` });
    }
    for (const d of rec) {
      const pre = days.length > 1 ? `${dayLabel(d.day)}: ` : '';
      strip.push({ key: `rec-${d.day}`, fg: 'var(--primary)', bg: 'var(--primary-light)',
        text: self ? `${pre}Recomputed by the Super Admin on ${dayLabel(istDayOf(d.saved_at))}.`
          : `${pre}Recomputed by you on ${dayLabel(istDayOf(d.saved_at))}: ${d.reason || ''}.` });
    }
    if (data.judge && data.judge.pending > 0) strip.push({ key: 'judge', fg: 'var(--fg-muted)', bg: 'var(--card-bg)', text: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        AI check pending: {plural(data.judge.pending, 'message', 'messages')} (not counted yet)
        {!self && (
          <button type="button" className="btn btn-sm" style={{ ...muted, height: '1.625rem', background: 'var(--card-bg)' }} disabled={judging} onClick={checkNow}>
            {judging ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null} Check now
          </button>
        )}
      </span>) });
    if (!self && data.judge && data.judge.model_ok === false) {
      strip.push({ key: 'model', fg: 'var(--warning)', bg: 'var(--warning-light)', text: 'The AI checker is not answering: keyword results only for now.' });
    }
    if (data.points_from && data.from < data.points_from) strip.push({ key: 'points', fg: 'var(--border)', bg: 'var(--card-bg)', text: tips.points });
    const startMs = Date.parse(`${data.from}T00:00:00+05:30`);
    const evMs = data.events_since ? Date.parse(data.events_since) : NaN;
    if (!data.events_since || (Number.isFinite(evMs) && evMs > startMs)) strip.push({ key: 'events', fg: 'var(--border)', bg: 'var(--card-bg)', text: tips.ev });
    if (data.health_from && data.health_from > data.from) strip.push({ key: 'health', fg: 'var(--border)', bg: 'var(--card-bg)', text: tips.health });
  }

  const tipFor = (m: Metric | 'points') => (m === 'frustrated' || m === 'angry' ? tips.health : m === 'points' ? tips.points : tips.ev);
  const isToday = !!data && data.from === today && data.to === today;
  const stale = !!data && !!range && (data.from !== range.from || data.to !== range.to);

  const board = useMemo(() => {
    const people = Array.isArray(data?.people) ? data!.people : [];
    const a = people.filter((p) => p.ranked && p.rank !== null).sort((x, y) => (x.rank as number) - (y.rank as number));
    const b = people.filter((p) => !(p.ranked && p.rank !== null));
    return [...a, ...b];
  }, [data]);

  const whoOf = (p: PersonRow): Who => ({ key: p.key, name: p.key === 'owner' ? 'Super Admin' : p.name });

  // ── Pieces shared by the table and the phone cards ──
  const tierPill = (p: PersonRow) => p.tier === 'senior'
    ? <span style={pill('var(--primary)', 'var(--primary-light)')}>Senior</span>
    : p.tier === 'junior' ? <span style={pill('var(--fg-muted)', 'var(--bg-subtle)')}>Junior</span> : null;

  const rankMark = (p: PersonRow) => (p.ranked && p.rank !== null
    ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontWeight: 700 }}>
        {p.rank === 1 && <Trophy size={14} style={{ color: 'var(--warning)' }} aria-label="First" />}{p.rank}
      </span>
    : null);

  const askedChip = (p: PersonRow) => {
    const n = num(p.counts || {}, 'asked_thanks');
    if (!n) return null;
    return (
      <button type="button" onClick={() => openDrawer(whoOf(p), 'thanks')} title="Replies that asked the customer to say thank you"
        style={{ ...pill('var(--danger)', 'var(--danger-light)'), border: 'none', cursor: 'pointer' }}>
        asked for thanks ×{n}
      </button>
    );
  };

  const presenceLine = (p: PersonRow) => {
    const c: C = p.counts || {};
    const parts: ReactNode[] = [];
    const days = data?.days?.length || 1;
    if (c.online && c.online.first) parts.push(<span key="on">online {c.online.first}–{c.online.last}</span>);
    else if (days > 1 && typeof c.days_in === 'number') parts.push(<span key="in">in {c.days_in} of {days} days</span>);
    else if (days === 1) {
      // In by their own actions (a reply, a pickup) even with no online times, which start only when
      // team-score.sql is installed (review 2026-10-02): "not in" only when they did nothing that day.
      const wasIn = (num(c, 'days_in') || 0) > 0 || (num(c, 'replies') || 0) > 0;
      parts.push(wasIn
        ? <span key="in">in {isToday ? 'today' : 'that day'} (no online times)</span>
        : <span key="no">not in {isToday ? 'yet' : 'that day'}</span>);
    }
    const holding = num(c, 'holding_now'), waiting = num(c, 'waiting_now');
    if (isToday && holding !== null) {
      parts.push(<span key="hold">holding {holding}{waiting ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}> ({waiting} waiting)</span> : null}</span>);
    }
    return parts.map((x, i) => <span key={i}>{i > 0 ? ' · ' : ''}{x}</span>);
  };

  const pointsColor = (n: number | null) => (n === null || n === 0 ? 'var(--fg)' : n > 0 ? 'var(--success)' : 'var(--danger)');

  const breakdown = (p: PersonRow) => {
    const parts = p.parts || {};
    const lines = WEIGHT_KEYS.filter((k) => parts[k] && (parts[k]!.n > 0 || parts[k]!.points !== 0));
    return (
      <div style={{ fontSize: '0.8125rem', lineHeight: 1.7 }}>
        {lines.map((k) => {
          const part = parts[k]!;
          return (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ color: 'var(--fg-muted)' }}>{POINT_LABELS[k]}</span>
              {part.each === null
                ? <span style={{ textAlign: 'right' }}><span style={{ whiteSpace: 'nowrap' }}>{fmtNum(part.n)} → <b style={{ color: pointsColor(part.points) }}>{signed(part.points)}</b></span> <span style={{ color: 'var(--fg-muted)', fontSize: '0.75rem' }}>(weight changed in this range)</span></span>
                : <span style={{ whiteSpace: 'nowrap' }}>{fmtNum(part.n)} × {signed(part.each)} = <b style={{ color: pointsColor(part.points) }}>{signed(part.points)}</b></span>}
            </div>
          );
        })}
        {!lines.length && <div style={{ color: 'var(--fg-muted)' }}>Nothing earned or lost yet.</div>}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4, fontWeight: 700 }}>
          Total = {p.points === null ? '—' : fmtNum(p.points)}
        </div>
        <button type="button" style={{ ...linkBtn, color: 'var(--primary)', fontWeight: 600, marginTop: 6 }}
          onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={() => openDrawer(whoOf(p), 'points')}>See each item</button>
      </div>
    );
  };

  const openPop = (p: PersonRow, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const popW = 300;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - popW - 8));
    const top = r.bottom + 260 > window.innerHeight ? Math.max(8, r.top - 260) : r.bottom + 6;
    setPop({ who: whoOf(p), row: p, top, left });
  };

  // ── Laptop: one table row per person ──
  const td: CSSProperties = { padding: '0.625rem 0.75rem', borderBottom: '1px solid var(--border)', verticalAlign: 'top', whiteSpace: 'nowrap', textAlign: 'right' };
  // The # column has a fixed width so the sticky Person column sits right after it.
  const RANK_W = 52;
  const RANK_COL: CSSProperties = { width: RANK_W, minWidth: RANK_W, maxWidth: RANK_W, padding: '0.625rem 0.5rem' };
  const stick = (left: number, bg: string, edge = false): CSSProperties => ({
    position: 'sticky', left, zIndex: 1, background: bg, textAlign: 'left',
    ...(edge ? { boxShadow: 'inset -1px 0 0 var(--border)' } : {}),
  });

  const row = (p: PersonRow, owner = false) => {
    const c: C = p.counts || {};
    const who = whoOf(p);
    const open = (m: Metric) => () => openDrawer(who, m);
    const bg = owner ? 'var(--bg-subtle)' : 'var(--card-bg)';
    const off = !owner && !p.active;
    const thanks = num(c, 'thanks'), thanksPending = num(c, 'thanks_pending') || 0;
    const conv = num(c, 'convinced'), convPending = num(c, 'convinced_pending') || 0;
    const solved = num(c, 'solved'), solvedPending = num(c, 'solved_pending') || 0, closedWaiting = num(c, 'closed_waiting') || 0;
    const picked = num(c, 'picked');
    const sent = num(c, 'sent'), received = num(c, 'received') || 0, takenFrom = num(c, 'taken_from') || 0, released = num(c, 'released') || 0;
    const sentTo = Array.isArray(c.sent_to) ? c.sent_to : [];
    const pendingChip = (n: number) => (n > 0 ? <span style={{ ...pill('var(--fg-muted)', 'var(--bg-subtle)'), marginLeft: 4 }}>+{n} pending</span> : null);
    return (
      <tr key={p.key} style={{ background: bg, color: owner ? 'var(--fg-muted)' : 'var(--fg)', opacity: off ? 0.55 : 1 }}>
        <td style={{ ...td, ...stick(0, bg), ...RANK_COL }}>{owner ? '' : rankMark(p)}</td>
        <td style={{ ...td, ...stick(RANK_W, bg, true), whiteSpace: 'normal', minWidth: 200, maxWidth: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: owner ? 'var(--fg-muted)' : 'var(--fg)' }}>{owner ? 'Super Admin (you)' : p.name}</span>
            {owner ? <span style={small}>· not ranked</span> : tierPill(p)}
            {off && <span style={small}>(switched off)</span>}
            {askedChip(p)}
          </div>
          <div style={{ ...small, marginTop: 2 }}>{presenceLine(p)}</div>
        </td>
        <td style={td}>
          {p.points === null
            ? <span title={tipFor('points')} style={{ color: 'var(--fg-muted)', cursor: 'help', fontSize: '1.125rem' }}>—</span>
            : <button type="button" style={{ ...linkBtn, fontSize: '1.125rem', fontWeight: 800, color: pointsColor(p.points) }}
                onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={(e) => openPop(p, e.currentTarget)} aria-label={`Points breakdown for ${who.name}`}>
                {fmtNum(p.points)}
              </button>}
        </td>
        <td style={td}>
          <Count n={num(c, 'chats')} tip={tipFor('chats')} open={open('chats')} />
          {num(c, 'replies') !== null && (
            <div style={small}>{plural(num(c, 'replies')!, 'msg', 'msgs')}{num(c, 'after_hours') ? ` · ${fmtNum(num(c, 'after_hours')!)} after 19:30` : ''}</div>
          )}
        </td>
        <td style={td}><Count n={num(c, 'customers')} tip={tipFor('customers')} open={open('customers')} /></td>
        <td style={td}>
          <Count n={conv} tip={tipFor('convinced')} open={open('convinced')}
            active={(conv || 0) + convPending + (num(c, 'convinced_not_counted') || 0) > 0} />{conv !== null && pendingChip(convPending)}
        </td>
        <td style={td}>
          <Count n={thanks} tip={tipFor('thanks')} open={open('thanks')}
            active={(thanks || 0) + thanksPending + (num(c, 'thanks_not_counted') || 0) > 0} />{thanks !== null && pendingChip(thanksPending)}
        </td>
        <td style={td}><Count n={num(c, 'frustrated')} tip={tipFor('frustrated')} open={open('frustrated')} /></td>
        <td style={td}><Count n={num(c, 'unanswered_2h')} tip={tipFor('unanswered_2h')} open={open('unanswered_2h')} /></td>
        <td style={{ ...td, textAlign: 'left' }}>
          <Count n={sent} tip={tipFor('sent')} open={open('sent')} active={(sent || 0) + received + takenFrom + released > 0}>
            {sent ? sentTo.map((s) => `${s.name} ${s.n}`).join(' · ') || fmtNum(sent) : '—'}
          </Count>
          {sent !== null && (received || takenFrom || released) ? (
            <div style={small}>{[received ? `got ${received}` : '', takenFrom ? `taken from ${takenFrom}` : '', released ? `released ${released}` : ''].filter(Boolean).join(' · ')}</div>
          ) : null}
        </td>
        <td style={td}>
          <Count n={picked} tip={tipFor('picked')} open={open('picked')}>
            {picked !== null ? `${fmtNum(picked)}${num(c, 'picked_pool') !== null && picked > 0 ? ` (${fmtNum(num(c, 'picked_pool')!)} pool · ${fmtNum(num(c, 'picked_take') || 0)} took)` : ''}` : null}
          </Count>
        </td>
        <td style={td}><Count n={num(c, 'taken_no_reply')} tip={tipFor('taken_no_reply')} open={open('taken_no_reply')} /></td>
        <td style={td}><Count n={num(c, 'angry')} tip={tipFor('angry')} open={open('angry')} /></td>
        <td style={td}><Count n={num(c, 'fast_reply')} tip={tipFor('fast_reply')} open={open('fast_reply')} /></td>
        <td style={td}>
          <Count n={solved} tip={tipFor('solved')} open={open('solved')} active={(solved || 0) + solvedPending + closedWaiting > 0}>
            {solved !== null ? `${fmtNum(solved)}${solvedPending ? ` (+${fmtNum(solvedPending)} pending)` : ''}` : null}
          </Count>
          {solved !== null && closedWaiting > 0 && <div style={{ ...small, color: 'var(--danger)' }}>{fmtNum(closedWaiting)} closed while waiting</div>}
        </td>
      </tr>
    );
  };

  // ── Phone: one card per person ──
  const card = (p: PersonRow, owner = false) => {
    const c: C = p.counts || {};
    const who = whoOf(p);
    const off = !owner && !p.active;
    const chips: { label: string; m: Metric; n: number | null; extra?: number; active?: number }[] = [
      { label: 'Chats', m: 'chats', n: num(c, 'chats') },
      { label: 'Customers', m: 'customers', n: num(c, 'customers') },
      { label: 'Thank you', m: 'thanks', n: num(c, 'thanks'), extra: num(c, 'thanks_pending') || 0,
        active: (num(c, 'thanks') || 0) + (num(c, 'thanks_pending') || 0) + (num(c, 'thanks_not_counted') || 0) },
      { label: 'Convinced', m: 'convinced', n: num(c, 'convinced'), extra: num(c, 'convinced_pending') || 0,
        active: (num(c, 'convinced') || 0) + (num(c, 'convinced_pending') || 0) + (num(c, 'convinced_not_counted') || 0) },
      { label: 'Frustrated', m: 'frustrated', n: num(c, 'frustrated') },
      { label: '2 h no reply', m: 'unanswered_2h', n: num(c, 'unanswered_2h') },
      { label: 'Sent', m: 'sent', n: num(c, 'sent'),
        active: (num(c, 'sent') || 0) + (num(c, 'received') || 0) + (num(c, 'taken_from') || 0) + (num(c, 'released') || 0) },
      { label: 'Picked', m: 'picked', n: num(c, 'picked') },
      { label: 'Taken no reply', m: 'taken_no_reply', n: num(c, 'taken_no_reply') },
      { label: 'Angry', m: 'angry', n: num(c, 'angry') },
      { label: '10-min', m: 'fast_reply', n: num(c, 'fast_reply') },
      { label: 'Solved', m: 'solved', n: num(c, 'solved'), extra: num(c, 'solved_pending') || 0,
        active: (num(c, 'solved') || 0) + (num(c, 'solved_pending') || 0) + (num(c, 'closed_waiting') || 0) },
    ];
    const chipBox: CSSProperties = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, minWidth: 0,
      padding: '0.4375rem 0.625rem', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--card-bg)',
      fontSize: '0.8125rem', color: 'var(--fg)', textAlign: 'left',
    };
    return (
      <div key={p.key} className="tf-card" style={{ padding: '0.875rem', marginBottom: 10, opacity: off ? 0.55 : 1, background: owner ? 'var(--bg-subtle)' : undefined }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!owner && rankMark(p)}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: owner ? 'var(--fg-muted)' : 'var(--fg)', overflowWrap: 'anywhere' }}>{owner ? 'Super Admin (you)' : p.name}</span>
            {owner ? <span style={small}>· not ranked</span> : tierPill(p)}
            {off && <span style={small}>(switched off)</span>}
            {askedChip(p)}
          </div>
          <span title={p.points === null ? tipFor('points') : undefined}
            style={{ fontSize: '1.375rem', fontWeight: 800, color: p.points === null ? 'var(--fg-muted)' : pointsColor(p.points), whiteSpace: 'nowrap' }}>
            {p.points === null ? '—' : fmtNum(p.points)}
          </span>
        </div>
        <div style={{ ...small, marginTop: 2 }}>{presenceLine(p)}</div>
        <div style={{ display: 'grid', gridTemplateColumns: isPhone ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6, marginTop: 10 }}>
          {chips.map((x) => {
            const inner = (
              <>
                <span style={{ color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.label}</span>
                <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {x.n === null ? '—' : fmtNum(x.n)}
                  {x.n !== null && x.extra ? <span style={{ fontWeight: 500, color: 'var(--fg-muted)', fontSize: '0.6875rem' }}> +{x.extra}</span> : null}
                </span>
              </>
            );
            const can = x.n !== null && (x.active ?? x.n) > 0;
            return can
              ? <button key={x.m} type="button" style={{ ...chipBox, cursor: 'pointer' }} onClick={() => openDrawer(who, x.m)}>{inner}</button>
              : <div key={x.m} style={chipBox} title={x.n === null ? tipFor(x.m) : undefined}>{inner}</div>;
          })}
        </div>
        {(num(c, 'closed_waiting') || 0) > 0 && (
          <button type="button" onClick={() => openDrawer(who, 'solved')}
            style={{ ...linkBtn, display: 'block', marginTop: 8, fontSize: '0.75rem', fontWeight: 600, color: 'var(--danger)' }}>
            {plural(num(c, 'closed_waiting') || 0, 'chat', 'chats')} closed while the customer was waiting
          </button>
        )}
        {p.points !== null && (
          <div style={{ marginTop: 8 }}>
            {/* A member's own card shows the breakdown open; the Super Admin's phone board folds it. */}
            {!self && (
              <button type="button" style={{ ...linkBtn, color: 'var(--primary)', fontSize: '0.8125rem', fontWeight: 600 }}
                onClick={() => setOpenBreakdown(openBreakdown === p.key ? null : p.key)}>
                {openBreakdown === p.key ? 'Hide points breakdown' : 'Points breakdown'}
              </button>
            )}
            {(self || openBreakdown === p.key) && (
              <div style={{ marginTop: 6, padding: '0.5rem 0.625rem', borderRadius: 10, background: 'var(--bg-subtle)', maxWidth: isPhone ? undefined : 460 }}>
                {self && <div style={{ fontSize: '0.75rem', fontWeight: 700, marginBottom: 2 }}>Points breakdown</div>}
                {breakdown(p)}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Drawer rows ──
  // multi: the drawer covers more than one day, so each row says which day (review 2026-10-02).
  const itemRow = (it: ItemRow, i: number, metric: Metric, multi: boolean) => {
    const dim = !it.counted || it.pending;
    const st = it.chat ? STATUS_CHIP[it.chat.status] : undefined;
    const pc = it.pending ? { t: 'pending', fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' }
      : it.points > 0 ? { t: signed(it.points), fg: 'var(--success)', bg: 'var(--success-light)' }
      : it.points < 0 ? { t: signed(it.points), fg: 'var(--danger)', bg: 'var(--danger-light)' }
      : { t: '0', fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' };
    const showKind = metric === 'sent' || metric === 'solved' || metric === 'points';
    const messages = Array.isArray(it.messages) ? it.messages : [];
    return (
      <div key={`${it.kind}-${it.conv}-${it.at}-${i}`} style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--border)', opacity: dim ? 0.62 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: '0.8125rem' }}>
          <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{multi && /^\d{1,2}:\d{2}$/.test(it.at_ist || '') ? `${dayLabel(it.day)} ${it.at_ist}` : it.at_ist}</span>
          <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{it.chat?.name || 'Chat'}</span>
          {it.chat?.source === 'email' && <span style={small}>email</span>}
          {st && <span style={pill(st.fg, st.bg)}>{st.label}</span>}
          {showKind && <span style={pill('var(--fg)', 'var(--bg-subtle)')}>{KIND_LABEL[it.kind] || it.kind}</span>}
          <span style={pill(pc.fg, pc.bg)}>{pc.t}</span>
          {(it.kind === 'thanks' || it.kind === 'convinced') && it.by && (
            <span style={pill('var(--primary)', 'var(--primary-light)')}>{it.by === 'ai' ? 'AI' : 'Keyword'}</span>
          )}
          <a href={`/admin/chat?open=${encodeURIComponent(it.conv)}`} target="_blank" rel="noopener"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
            Open chat <ExternalLink size={12} />
          </a>
        </div>
        <div style={{ fontSize: '0.8125rem', marginTop: 4, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{it.why}</div>
        {it.kind === 'chat' && typeof it.n === 'number' && (
          <div style={{ ...small, marginTop: 2 }}>{plural(it.n, 'message', 'messages')}{it.after ? ` · ${fmtNum(it.after)} after 19:30` : ''}</div>
        )}
        {messages.length > 0 && (
          <div style={{ marginTop: 6, padding: '0.375rem 0.625rem', borderRadius: 8, background: 'var(--bg-subtle)', fontSize: '0.75rem', lineHeight: 1.55 }}>
            {messages.map((m) => (
              <div key={m.id} style={{ overflowWrap: 'anywhere' }}>
                <span style={{ fontWeight: 600, color: m.role === 'customer' ? 'var(--fg)' : 'var(--primary)' }}>
                  {m.role === 'customer' ? 'Customer' : m.role === 'ai' ? 'AI' : (m.by || 'Staff')}
                </span>
                <span style={{ color: 'var(--fg-muted)' }}> {m.at_ist}{m.text ? ': ' : ''}</span>{m.text}
              </div>
            ))}
          </div>
        )}
        {it.kind === 'sent' && it.note && (
          <div style={{ ...small, marginTop: 4, fontSize: '0.75rem', overflowWrap: 'anywhere' }}>Note: {it.note}</div>
        )}
      </div>
    );
  };

  const w = { ...DEFAULT_WEIGHTS, ...(data?.weights?.values || {}) } as Weights;
  // Points rules: a planned change in words ("Thank you +5 (today +3)"), and the planned rows a save
  // from the picked day would replace (a newer row wins from its own day on). Editing the newest row
  // on its own day replaces nothing new: the boxes started from it.
  const weightChanges = (prev: Partial<Weights> | undefined, next: Partial<Weights>, was: string): string => {
    if (!prev) return WEIGHT_KEYS.map((k) => `${POINT_LABELS[k]} ${signed(Number(next[k] ?? DEFAULT_WEIGHTS[k]))}`).join(', ');
    const ch = WEIGHT_KEYS.filter((k) => Number(prev[k] ?? DEFAULT_WEIGHTS[k]) !== Number(next[k] ?? DEFAULT_WEIGHTS[k]))
      .map((k) => `${POINT_LABELS[k]} ${signed(Number(next[k] ?? DEFAULT_WEIGHTS[k]))} (${was} ${signed(Number(prev[k] ?? DEFAULT_WEIGHTS[k]))})`);
    return ch.length ? ch.join(', ') : 'the same numbers';
  };
  const replaced = rulesOpen && rulesPlan && isDay(effFrom)
    ? rulesPlan.scheduled.filter((r) => r.effective_from >= effFrom && !(r.id === rulesPlan.base.id && r.effective_from === effFrom))
    : [];
  const team = data?.team;
  const owner = data?.owner || null;
  const dateInput: CSSProperties = { height: '2rem', width: 'auto', minWidth: 0, padding: '0 0.5rem', fontSize: isPhone ? 16 : undefined };
  const field: CSSProperties = isPhone ? { fontSize: 16 } : {};

  return (
    <div>
      {/* 1. Header */}
      <div style={{ marginBottom: '1rem' }}>
        <h2 className="page-title">{self ? 'My score' : 'Team score'}</h2>
        <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', marginTop: 2 }}>
          {self
            ? "Chat support · office 10:00–19:30 IST · only you and the Super Admin see your score. Customers always see 'Vastora Support'. Points only, no money."
            : "Chat support · office 10:00–19:30 IST · you see everyone; each team member sees only their own score (My score). Customers always see 'Vastora Support'. Points only, no money."}
        </p>
      </div>

      {/* 2. Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {CHIPS.map((c) => (
            <button key={c.v} type="button" className="btn btn-sm" aria-pressed={!!period && 'chip' in period && period.chip === c.v}
              style={{ ...muted, ...(period && 'chip' in period && period.chip === c.v ? chosen : {}) }} onClick={() => pickChip(c.v)}>
              {c.label}
            </button>
          ))}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', color: 'var(--fg-muted)' }}>
            Pick a day
            <input type="date" className="form-input" min={FIRST_DAY} max={today} aria-label="Pick a day"
              value={period && 'day' in period ? period.day : ''} onChange={(e) => pickDay(e.target.value)}
              style={{ ...dateInput, ...(period && 'day' in period ? { borderColor: 'var(--primary)' } : {}) }} />
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {fetchedAt && <span style={small}>Updated {agoText(fetchedAt)}</span>}
          <button type="button" className="btn btn-sm" style={muted} disabled={loading || beforeStart} onClick={() => load(true)}>
            <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} /> Refresh
          </button>
          {!self && (
            <button type="button" className="btn btn-sm" style={muted} disabled={!data} onClick={openRules}>
              <Settings size={13} /> Points rules
            </button>
          )}
        </div>
      </div>

      {/* Errors that replace the board */}
      {blocked && (
        <div className="tf-card" style={{ padding: '1rem', marginBottom: '0.75rem', color: 'var(--danger)', fontSize: '0.875rem' }}>{blocked}</div>
      )}
      {down && !blocked && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0.5rem 0.75rem', marginBottom: '0.5rem', borderRadius: 10, background: 'var(--danger-light)', color: 'var(--danger)', fontSize: '0.8125rem' }}>
          <span style={{ overflowWrap: 'anywhere' }}>{down}</span>
          <button type="button" className="btn btn-sm" style={{ ...muted, height: '1.625rem', background: 'var(--card-bg)' }} disabled={loading} onClick={() => load(false)}>Retry</button>
        </div>
      )}
      {beforeStart && (
        <div style={{ padding: '0.5rem 0.75rem', marginBottom: '0.5rem', borderRadius: 10, background: 'var(--bg-subtle)', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
          The team score starts on {dayLabel(FIRST_DAY)} 2026. Pick Today or a later day.
        </div>
      )}

      {/* 3. Status strip */}
      {!blocked && !beforeStart && strip.length > 0 && (
        <div style={{ display: 'grid', gap: 4, marginBottom: '0.75rem' }}>
          {strip.map((s) => (
            <div key={s.key} style={{ padding: '0.375rem 0.75rem', borderRadius: 8, borderLeft: `3px solid ${s.fg}`, fontSize: '0.75rem', lineHeight: 1.5, color: 'var(--fg)', background: s.bg, overflowWrap: 'anywhere' }}>{s.text}</div>
          ))}
        </div>
      )}

      {/* 4. Open-pool banner (the owner's own words) */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: 12, background: 'var(--warning-light)', color: 'var(--fg)', fontSize: '0.8125rem', lineHeight: 1.55 }}>
        <Trophy size={18} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
        <div style={{ minWidth: 0 }}>
          <div><b>Open pool:</b>{' jo chat lekar sabse zyada customers se "Thank you" likhwayega, uske utne zyada points. More chats = more thank-yous = more incentive.'}</div>
          {!self && data?.leader && !stale && (
            <div style={{ marginTop: 4 }}>
              <b>{labelOf(data.from, data.to)}: {data.leader.name}</b>, {plural(data.leader.thanks, 'customer', 'customers')} said thank you.
            </div>
          )}
        </div>
      </div>

      {/* 5 / 6. Leaderboard */}
      {!blocked && !beforeStart && (
        <div style={{ opacity: stale ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          {!data && (
            <div className="tf-card" style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
              {loading ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }} /> {self ? 'Loading your score…' : 'Loading the team score…'}</> : 'No numbers yet.'}
            </div>
          )}
          {/* My score: the member's own card only, on a phone and a laptop alike. */}
          {data && self && (
            <div>
              {board.map((p) => card(p))}
              {!board.length && (
                <div className="tf-card" style={{ padding: '1rem', marginBottom: 10, color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>No numbers for you in this period yet.</div>
              )}
            </div>
          )}
          {data && !self && !isPhone && (
            <div className="tf-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 1240, fontSize: '0.8125rem' }}>
                  <thead>
                    <tr>
                      {[{ label: '#', hint: '' }, { label: 'Person', hint: '' }, ...HEAD].map((h, i) => (
                        <th key={h.label} scope="col" style={{
                          padding: '0.625rem 0.75rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)',
                          verticalAlign: 'bottom', whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--fg)', textAlign: i < 2 || h.label === 'Sent to' ? 'left' : 'right',
                          ...(i === 0 ? { position: 'sticky', left: 0, zIndex: 2, ...RANK_COL } : {}),
                          ...(i === 1 ? { position: 'sticky', left: RANK_W, zIndex: 2, boxShadow: 'inset -1px 0 0 var(--border)' } : {}),
                        }}>
                          {h.label}
                          {h.hint && <div style={{ ...small, fontWeight: 400, fontStyle: 'italic' }}>{h.hint}</div>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {board.map((p) => row(p))}
                    {!board.length && (
                      <tr><td colSpan={HEAD.length + 2} style={{ ...td, textAlign: 'left', color: 'var(--fg-muted)' }}>No team member has a number in this period yet.</td></tr>
                    )}
                    {owner && (
                      <>
                        <tr aria-hidden="true"><td colSpan={HEAD.length + 2} style={{ padding: 0, height: 6, background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }} /></tr>
                        {row(owner, true)}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {data && !self && isPhone && (
            <div>
              {board.map((p) => card(p))}
              {!board.length && (
                <div className="tf-card" style={{ padding: '1rem', marginBottom: 10, color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>No team member has a number in this period yet.</div>
              )}
              {owner && (
                <>
                  <div style={{ height: 1, background: 'var(--border)', margin: '0.75rem 0' }} />
                  {card(owner, true)}
                </>
              )}
            </div>
          )}

          {/* 8. Team footer (the Super Admin only) */}
          {data && !self && team && (
            <div style={{ ...small, fontSize: '0.75rem', marginTop: '0.75rem', display: 'grid', gap: 2 }}>
              <div>
                Thank-yous after AI answers:{' '}
                {team.thanks_after_ai > 0
                  ? <button type="button" style={{ ...linkBtn, color: 'var(--primary)', fontWeight: 600 }} onMouseEnter={hoverOn} onMouseLeave={hoverOff}
                      onClick={() => openDrawer({ key: 'ai', name: 'AI' }, 'thanks')}>{fmtNum(team.thanks_after_ai)}</button>
                  : fmtNum(team.thanks_after_ai || 0)}
              </div>
              <div>
                Customers who waited 2 office hours with nobody holding the chat:{' '}
                {team.pool_waited_2h === null ? <span title={tips.ev}>—</span> : fmtNum(team.pool_waited_2h)}
              </div>
              <div>
                Waiting on someone not in that day:{' '}
                {team.absent_waits === null ? <span title={tips.ev}>—</span> : fmtNum(team.absent_waits)}
              </div>
              {Array.isArray(team.unattributed) && team.unattributed.length > 0 && (
                <div style={{ overflowWrap: 'anywhere' }}>
                  Replies by old logins that are not a current member: {team.unattributed.map((u) => `${u.login} ${u.replies}`).join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 10. Points kaise bante hain */}
      <details className="tf-card" style={{ padding: '0.75rem 1rem', marginTop: '1rem', fontSize: '0.8125rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Points kaise bante hain</summary>
        <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.125rem', lineHeight: 1.6, color: 'var(--fg)' }}>
          {rulesHinglish(w).map((line, i) => <li key={i} style={{ overflowWrap: 'anywhere' }}>{line}</li>)}
        </ul>
      </details>

      {/* Points popover (laptop). The overlays go to <body>: the admin page wraps this card in
          .animate-fade-in-up, whose kept transform would pin position:fixed to the card. */}
      {pop && createPortal(
        <>
          <div onClick={() => setPop(null)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
          <div role="dialog" aria-label={`${pop.who.name} points`} className="tf-card"
            style={{ position: 'fixed', top: pop.top, left: pop.left, width: 300, maxWidth: 'calc(100vw - 16px)', zIndex: 46, padding: '0.75rem 0.875rem', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontWeight: 700, fontSize: '0.8125rem' }}>{pop.who.name} · points</span>
              <button type="button" className="btn-icon" onClick={() => setPop(null)} aria-label="Close" style={{ width: '1.5rem', height: '1.5rem' }}><X size={14} /></button>
            </div>
            {breakdown(pop.row)}
          </div>
        </>, document.body,
      )}

      {/* 7. Drawer: the items behind one number */}
      {drawer && createPortal(
        <div className="modal-overlay" onClick={closeDrawer} style={{ padding: 0, justifyContent: 'flex-end', alignItems: 'stretch' }}>
          <div role="dialog" aria-modal="true" aria-label={`${drawer.who.name} · ${METRIC_LABEL[drawer.metric]}`} onClick={(e) => e.stopPropagation()}
            style={{ width: isPhone ? '100%' : 480, maxWidth: '100%', height: '100%', background: 'var(--card-bg)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', animation: 'slideInRight 0.2s ease' }}>
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)' }}>
              {isPhone && (
                <button type="button" className="btn btn-sm" style={{ ...muted, marginBottom: 8 }} onClick={closeDrawer}><ChevronLeft size={14} /> Back</button>
              )}
              <div className="modal-header" style={{ marginBottom: 0, alignItems: 'flex-start', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 className="modal-title" style={{ overflowWrap: 'anywhere' }}>{drawer.who.name} · {METRIC_LABEL[drawer.metric]} · {drawer.label}</h3>
                  <p className="modal-subtitle">
                    {items ? `${fmtNum(items.counted)} counted · ${fmtNum(Math.max(0, items.total - items.counted))} not counted` : itemsLoading ? 'Loading…' : ''}
                  </p>
                </div>
                {!isPhone && <button type="button" className="btn-icon" onClick={closeDrawer} aria-label="Close"><X size={16} /></button>}
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 1rem 1rem' }}>
              {itemsLoading && !items && (
                <div style={{ padding: '1.5rem 0', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
                  <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }} /> Loading…
                </div>
              )}
              {itemsErr && (
                <div style={{ padding: '1rem 0', color: 'var(--danger)', fontSize: '0.8125rem', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {itemsErr}
                  <button type="button" className="btn btn-sm" style={muted} onClick={() => loadItems(drawer)}>Retry</button>
                </div>
              )}
              {items && (() => {
                const list = items.items;
                const good = list.filter((x) => x.counted && !x.pending);
                const rest = list.filter((x) => !x.counted || x.pending);
                return (
                  <>
                    {!list.length && <div style={{ padding: '1.5rem 0', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>Nothing here for this period.</div>}
                    {good.map((it, i) => itemRow(it, i, drawer.metric, drawer.from !== drawer.to))}
                    {rest.length > 0 && (
                      <>
                        <div style={{ marginTop: '1rem', fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Not counted</div>
                        {rest.map((it, i) => itemRow(it, i, drawer.metric, drawer.from !== drawer.to))}
                      </>
                    )}
                    {items.total > list.length && (
                      <div style={{ ...small, marginTop: '0.75rem' }}>Showing the newest {fmtNum(list.length)} of {fmtNum(items.total)}.</div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>, document.body,
      )}

      {/* 9. Points rules */}
      {rulesOpen && wDraft && !self && createPortal(
        <div className="modal-overlay" onClick={() => !saving && !recomputing && setRulesOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '34rem' }}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">Points rules</h3>
                <p className="modal-subtitle">A change applies from the day you pick. Past days keep their points.</p>
              </div>
              <button type="button" className="btn-icon" onClick={() => setRulesOpen(false)} aria-label="Close" disabled={saving || recomputing}><X size={16} /></button>
            </div>
            {rulesPlan && rulesPlan.scheduled.length > 0 && (
              <div style={{ padding: '0.5rem 0.75rem', marginBottom: '0.75rem', borderRadius: 8, borderLeft: '3px solid var(--primary)', background: 'var(--primary-light)', fontSize: '0.75rem', lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                {rulesPlan.scheduled.map((r, i) => (
                  <div key={r.id}>
                    <b>Planned from {dayLabel(r.effective_from)}:</b>{' '}
                    {weightChanges(i === 0 ? rulesPlan.today?.values : rulesPlan.scheduled[i - 1].values, r.values, i === 0 ? 'today' : 'before')}
                  </div>
                ))}
                <div style={{ color: 'var(--fg-muted)' }}>The boxes below show the newest saved numbers (from {dayLabel(rulesPlan.base.effective_from)}).</div>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: '1rem' }}>
              {WEIGHT_KEYS.map((k) => {
                const err = weightError(wDraft[k]);
                return (
                  <label key={k} style={{ fontSize: '0.75rem', fontWeight: 600 }}>{POINT_LABELS[k]}
                    <input type="number" className="form-input" step={0.5} min={-10} max={10} value={wDraft[k]}
                      onChange={(e) => setWDraft({ ...wDraft, [k]: e.target.value })}
                      style={{ marginTop: 4, ...field, ...(err ? { borderColor: 'var(--danger)' } : {}) }} />
                    {err && <span style={{ display: 'block', fontWeight: 400, color: 'var(--danger)', marginTop: 2 }}>Use {err}</span>}
                  </label>
                );
              })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Applies from
                <input type="date" className="form-input" min={today} max={addDays(today, 60)} value={effFrom}
                  onChange={(e) => setEffFrom(e.target.value)} style={{ marginTop: 4, ...field }} />
              </label>
              <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Points start on
                <input type="date" className="form-input" min={FIRST_DAY} value={ptsFrom}
                  onChange={(e) => setPtsFrom(e.target.value)} style={{ marginTop: 4, ...field }} />
              </label>
            </div>
            {replaced.length > 0 && (
              <div role="note" style={{ padding: '0.5rem 0.75rem', marginBottom: '0.75rem', borderRadius: 8, borderLeft: '3px solid var(--warning)', background: 'var(--warning-light)', fontSize: '0.75rem', lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                Saving from {dayLabel(effFrom)} replaces the change planned for {replaced.map((r) => dayLabel(r.effective_from)).join(', ')}: these numbers apply from {dayLabel(effFrom)} on.
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: '1.25rem' }}>
              <button type="button" className="btn" style={muted} onClick={() => setRulesOpen(false)} disabled={saving}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={saving || WEIGHT_KEYS.some((k) => weightError(wDraft[k])) || !isDay(effFrom)} onClick={saveRules}>
                {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null} Save
              </button>
            </div>

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
              <div style={{ fontSize: '0.8125rem', fontWeight: 700, marginBottom: 4 }}>Recompute a final day</div>
              <p style={{ ...small, fontSize: '0.75rem', marginBottom: 8 }}>
                {"Final days never change on their own. Recompute saves that day again with today's rules and data; your reason is kept with it."}
              </p>
              {canRecompute ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, alignItems: 'end' }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Day
                    <input type="date" className="form-input" min={FIRST_DAY} max={lastFinal} value={reDay}
                      onChange={(e) => setReDay(e.target.value)} style={{ marginTop: 4, ...field }} />
                  </label>
                  <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Why
                    <input type="text" className="form-input" maxLength={200} placeholder="e.g. points start date moved" value={reReason}
                      onChange={(e) => setReReason(e.target.value)} style={{ marginTop: 4, ...field }} />
                  </label>
                  <button type="button" className="btn btn-primary" disabled={recomputing || !isDay(reDay) || reReason.trim().length < 3} onClick={recompute}>
                    {recomputing ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null} Recompute
                  </button>
                </div>
              ) : (
                <div style={{ ...small, fontSize: '0.75rem' }}>No day is final yet: a day becomes final two days after it ends, at 1 AM.</div>
              )}
            </div>
          </div>
        </div>, document.body,
      )}
    </div>
  );
}
