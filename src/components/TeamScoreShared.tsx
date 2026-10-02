'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { ItemKind, Metric, PersonRow } from '@/lib/team-score/types';
import { addDays, dayLabel } from '@/lib/team-score/clock';
import type { ScoreCounts } from '@/lib/team-score/engine';

export const FIRST_DAY = '2026-10-01';            // the routes refuse earlier days
export const REFRESH_MS = 120_000;                // Today: every 2 minutes while the tab is visible
export const PERIOD_KEY = 'teamScore.period';
export const MINUS = '−';

export type Chip = 'today' | 'yesterday' | '7d' | 'month';
export type Period = { chip: Chip } | { day: string };
export const CHIPS: { v: Chip; label: string }[] = [
  { v: 'today', label: 'Today' }, { v: 'yesterday', label: 'Yesterday' },
  { v: '7d', label: 'Last 7 days' }, { v: 'month', label: 'This month' },
];

export const METRIC_LABEL: Record<Metric, string> = {
  chats: 'Chats replied', customers: 'Chats replied', thanks: 'Thank you', convinced: 'Convinced',
  frustrated: 'Still frustrated', unanswered_2h: 'Left 2 h, no reply', sent: 'Sent to / received / taken',
  picked: 'Picked up', taken_no_reply: 'Taken, no reply', angry: 'Angry', fast_reply: '10-min reply',
  solved: 'Solved', points: 'Points',
};
export const KIND_LABEL: Record<ItemKind, string> = {
  chat: 'Chat', thanks: 'Thank you', convinced: 'Convinced', frustrated: 'Still frustrated',
  unanswered_2h: 'Left 2 h, no reply', taken_no_reply: 'Taken, no reply', picked: 'Picked up', sent: 'Sent',
  received: 'Received', taken_from: 'Taken from', released: 'Released', fast_reply: '10-min reply',
  solved: 'Solved', closed_waiting: 'Closed while waiting', angry: 'Angry',
};
export const STATUS_CHIP: Record<string, { label: string; fg: string; bg: string }> = {
  human_needed: { label: 'Needs you', fg: 'var(--danger)', bg: 'var(--danger-light)' },
  agent_handling: { label: 'With team', fg: 'var(--primary)', bg: 'var(--primary-light)' },
  ai_handling: { label: 'AI', fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' },
  resolved: { label: 'Closed', fg: 'var(--fg-muted)', bg: 'var(--bg-subtle)' },
};
// The laptop table: the owner's order. Each label has a small Hinglish hint under it.
export const HEAD: { label: string; hint: string }[] = [
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

export type C = Partial<ScoreCounts>;
export interface Who { key: string; name: string }
export interface Drawer { who: Who; metric: Metric; from: string; to: string; label: string }
export interface Pop { who: Who; row: PersonRow; top: number; left: number }

// India day of now, as the screen asks for it (the server checks the same range).
export const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function rangeOf(p: Period, today: string): { from: string; to: string; label: string } {
  let from = today, to = today, label = 'Today';
  if ('day' in p) { from = to = p.day; label = dayLabel(p.day); }
  else if (p.chip === 'yesterday') { from = to = addDays(today, -1); label = 'Yesterday'; }
  else if (p.chip === '7d') { from = addDays(today, -6); label = 'Last 7 days'; }
  else if (p.chip === 'month') { from = `${today.slice(0, 8)}01`; label = 'This month'; }
  if (from < FIRST_DAY) from = FIRST_DAY;
  return { from, to, label };
}

export const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1)).replace('-', MINUS);
export const signed = (n: number) => (n > 0 ? `+${fmtNum(n)}` : fmtNum(n));
export const num = (c: C, k: keyof ScoreCounts): number | null => {
  const v = c[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
export const plural = (n: number, one: string, many: string) => `${fmtNum(n)} ${n === 1 ? one : many}`;

// '5 Oct, 1:00 AM' India time, from an ISO instant.
export function fmtWhen(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 330 * 60000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${dayLabel(d.toISOString().slice(0, 10))}, ${h % 12 === 0 ? 12 : h % 12}:${m < 10 ? '0' : ''}${m} ${h < 12 ? 'AM' : 'PM'}`;
}
export const istDayOf = (iso: string | null | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms + 330 * 60000).toISOString().slice(0, 10) : '';
};
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export const muted: CSSProperties = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' };
export const chosen: CSSProperties = { border: '1px solid var(--primary)', color: 'var(--primary)', background: 'var(--primary-light)' };
export const small: CSSProperties = { fontSize: '0.6875rem', color: 'var(--fg-muted)', lineHeight: 1.4 };
export const linkBtn: CSSProperties = {
  border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit',
  textAlign: 'inherit', textUnderlineOffset: 2,
};
export const pill = (fg: string, bg: string): CSSProperties => ({
  fontSize: '0.625rem', fontWeight: 700, padding: '0.0625rem 0.4rem', borderRadius: 999, color: fg, background: bg,
  whiteSpace: 'nowrap', display: 'inline-block', lineHeight: 1.5,
});
export const hoverOn = (e: { currentTarget: HTMLElement }) => { e.currentTarget.style.textDecoration = 'underline'; };
export const hoverOff = (e: { currentTarget: HTMLElement }) => { e.currentTarget.style.textDecoration = 'none'; };

// A count: "—" with the reason when it is not counted yet (null), a button that opens the items
// when it is above zero, plain text at zero.
export function Count({ n, tip, open, active, children }: {
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

  // ── Laptop: one table row per person ──
export   const td: CSSProperties = { padding: '0.625rem 0.75rem', borderBottom: '1px solid var(--border)', verticalAlign: 'top', whiteSpace: 'nowrap', textAlign: 'right' };
  // The # column has a fixed width so the sticky Person column sits right after it.
export   const RANK_W = 52;
export   const RANK_COL: CSSProperties = { width: RANK_W, minWidth: RANK_W, maxWidth: RANK_W, padding: '0.625rem 0.5rem' };
export   const stick = (left: number, bg: string, edge = false): CSSProperties => ({
    position: 'sticky', left, zIndex: 1, background: bg, textAlign: 'left',
    ...(edge ? { boxShadow: 'inset -1px 0 0 var(--border)' } : {}),
  });
