'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookOpenCheck, Brain, CheckCheck, Gauge, Send, ShieldAlert, Thermometer, UserRound } from 'lucide-react';

// Chikki > Logic (owner, 2026-10-01): how Chikki thinks, step by step, and how hard it thinks
// for whom (src/lib/chat/effort.ts), like Claude's effort setting. An admin picks Normal / High /
// Max per kind of customer (POST /api/panel-brain/effort); visitors stay Normal until a visitor
// AI is built. The numbers come from chikki_runs (last 7 days).

type Effort = 'normal' | 'high' | 'max';
type CustomerGroup = 'calm' | 'uneasy' | 'frustrated' | 'critical';
export type EffortSettings = Record<CustomerGroup, Effort>;
interface UsageRow {
  grp: string; level: string; replies: number; tokens: number | string; avg_tokens: number; avg_ms: number;
  thinking: number; checked: number; changed: number; since: string | null;
}
export interface EffortData { settings: EffortSettings; defaults: EffortSettings; usage: UsageRow[] }

// Time and tokens measured on the live test suite, 2026-10-01 (24 verified-customer cases each):
// Normal 2.8 s / ~8k tokens, High 6.9 s / ~9.9k, Max 10.9 s (slowest 25 s) / ~17.6k.
const LEVELS: { key: Effort; label: string; what: string; cost: string; speed: string; color: string; bg: string }[] = [
  { key: 'normal', label: 'Normal', what: 'Answers straight away and reads 2 of your team\'s examples. What every reply did until today.', cost: '1× tokens', speed: 'About 3 seconds', color: '#3b4fd8', bg: '#eef1ff' },
  { key: 'high', label: 'High', what: 'Thinks before it writes and reads 3 of your team\'s examples.', cost: '~1.2× tokens', speed: 'About 7 seconds', color: '#6d28d9', bg: '#f3efff' },
  { key: 'max', label: 'Max', what: 'Thinks, writes, then checks its own reply against your rules and the order facts and fixes it before it is sent (also a reply that came out cut).', cost: '~2.2× tokens', speed: 'About 11 seconds, at most ~25', color: '#c2410c', bg: '#fff1e6' },
];
const LEVEL = Object.fromEntries(LEVELS.map((l) => [l.key, l])) as Record<Effort, typeof LEVELS[number]>;
const GROUPS: { key: 'visitor' | CustomerGroup; label: string; score: string }[] = [
  { key: 'visitor', label: 'Visitors', score: 'not verified' },
  { key: 'calm', label: 'Calm', score: 'score 0–24' },
  { key: 'uneasy', label: 'Uneasy', score: 'score 25–49' },
  { key: 'frustrated', label: 'Frustrated', score: 'score 50–74' },
  { key: 'critical', label: 'Critical', score: 'score 75+' },
];
const STEPS: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <UserRound size={15} />, title: 'Who is writing?', text: 'A visitor, or a customer who proved the order (order ID + phone).' },
  { icon: <Thermometer size={15} />, title: 'How upset?', text: 'The frustration score of the chat, or a quick count in this message (swearing, threats, refund demands, repeats), whichever is higher.' },
  { icon: <Gauge size={15} />, title: 'How hard to think', text: 'Normal, High or Max, from the table below.' },
  { icon: <ShieldAlert size={15} />, title: 'Code checks first', text: 'Threat, fraud claim, refund or cancel, payment problem, card details, two addresses: a fixed reply and your team (verified customers only).' },
  { icon: <BookOpenCheck size={15} />, title: 'Reads', text: 'The order (fresh), the whole chat, your saved answers, the notes that fit, and your team\'s examples.' },
  { icon: <Brain size={15} />, title: 'Thinks and writes', text: 'At High and Max it thinks before writing.' },
  { icon: <CheckCheck size={15} />, title: 'Checks', text: 'Every reply: no "today" promise, only real order numbers, no address repeated, courier only when asked. At Max it also reads its reply again against your rules and the order, and fixes it.' },
  { icon: <Send size={15} />, title: 'Acts', text: 'Sends, hands the chat to your team, or later closes it when quiet (visitors after 2 hours, customers after 4 days).' },
];

const num = (x: number | string | null | undefined) => Number(x || 0);
const fmtK = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export default function ChikkiLogic({ data, canEdit, busy, onSave }: {
  data: EffortData | null; canEdit: boolean; busy: boolean; onSave: (s: EffortSettings) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<EffortSettings | null>(data?.settings || null);
  useEffect(() => { setDraft(data?.settings || null); }, [data]);

  const usage = useMemo(() => {
    const rows = data?.usage || [];
    const by = (g: string) => {
      const r = rows.filter((u) => u.grp === g);
      const replies = r.reduce((n, u) => n + num(u.replies), 0);
      const tokens = r.reduce((n, u) => n + num(u.tokens), 0);
      const ms = r.reduce((n, u) => n + num(u.avg_ms) * num(u.replies), 0);
      return { replies, tokens, avgTokens: replies ? Math.round(tokens / replies) : 0, avgSec: replies ? ms / replies / 1000 : 0,
        checked: r.reduce((n, u) => n + num(u.checked), 0), changed: r.reduce((n, u) => n + num(u.changed), 0) };
    };
    const total = rows.reduce((n, u) => n + num(u.tokens), 0);
    const since = rows.map((u) => u.since).filter(Boolean).sort()[0] || null;
    return { by, total, since };
  }, [data]);

  if (!data || !draft) return <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Loading…</div>;
  const dirty = (Object.keys(draft) as CustomerGroup[]).some((g) => draft[g] !== data.settings[g]);
  const isDefault = (Object.keys(draft) as CustomerGroup[]).every((g) => draft[g] === data.defaults[g]);
  const help = { fontSize: '0.6875rem', color: 'var(--fg-muted)', lineHeight: 1.6 };
  const sectionTitle = (t: string) => (
    <div style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase' as const, color: 'var(--fg-muted)', margin: '0 0 0.5rem' }}>{t}</div>
  );

  return (
    <div>
      <div style={{ ...help, marginBottom: '0.75rem' }}>
        How Chikki decides every reply, and how hard it thinks for whom: like Claude&rsquo;s effort setting, more effort means more thinking and more tokens.
        Visitors stay as they are; your customers get more care the more upset they are.
      </div>

      {/* ── The steps ── */}
      {sectionTitle('How Chikki thinks, for every message')}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8, marginBottom: '1rem' }}>
        {STEPS.map((s, i) => (
          <div key={s.title} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', border: '1px solid var(--border)', borderRadius: 10, padding: '0.5rem 0.625rem', background: 'var(--card-bg)' }}>
            <span style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', background: 'linear-gradient(135deg, #4f6bed, #8b5cf6)' }}>{s.icon}</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700 }}>{i + 1}. {s.title}</span>
              <span style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>{s.text}</span>
            </span>
          </div>
        ))}
      </div>

      {/* ── The levels ── */}
      {sectionTitle('Effort levels')}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginBottom: '1rem' }}>
        {LEVELS.map((l) => (
          <div key={l.key} style={{ borderRadius: 10, padding: '0.625rem 0.75rem', background: l.bg, border: `1px solid ${l.color}22` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: '0.875rem', fontWeight: 800, color: l.color }}>{l.label}</span>
              <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: l.color }}>{l.cost}</span>
            </div>
            <div style={{ fontSize: '0.75rem', lineHeight: 1.5, margin: '0.25rem 0' }}>{l.what}</div>
            <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>{l.speed}</div>
          </div>
        ))}
      </div>

      {/* ── Who gets which ── */}
      {sectionTitle('Who gets which level')}
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', marginBottom: '0.5rem' }}>
        {GROUPS.map((g, i) => {
          const u = usage.by(g.key);
          const share = usage.total ? Math.round((u.tokens / usage.total) * 100) : 0;
          return (
            <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '0.625rem 0.75rem', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div style={{ width: 150, minWidth: 130 }}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 700 }}>{g.label}</div>
                <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>{g.score}</div>
              </div>
              <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 9, background: 'var(--muted)' }} role="radiogroup" aria-label={`Effort for ${g.label}`}>
                {LEVELS.map((l) => {
                  const on = g.key === 'visitor' ? l.key === 'normal' : draft[g.key as CustomerGroup] === l.key;
                  const locked = g.key === 'visitor' || !canEdit;
                  return (
                    <button key={l.key} type="button" role="radio" aria-checked={on} disabled={locked && !on}
                      onClick={() => { if (!locked) setDraft({ ...draft, [g.key]: l.key } as EffortSettings); }}
                      style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.25rem 0.625rem', borderRadius: 7, border: 'none', cursor: locked ? 'default' : 'pointer',
                        background: on ? l.bg : 'transparent', color: on ? l.color : 'var(--fg-muted)', boxShadow: on ? 'var(--shadow-xs)' : 'none', opacity: locked && !on ? 0.45 : 1 }}>
                      {l.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                {g.key === 'visitor' && <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: 2 }}>Stays Normal: a visitor AI for sales is built later.</div>}
                <div style={{ fontSize: '0.6875rem', color: 'var(--fg-secondary)' }}>
                  {u.replies
                    ? <>{u.replies.toLocaleString()} replies · {fmtK(u.avgTokens)} tokens each · {u.avgSec.toFixed(1)} s{u.checked ? ` · checked ${u.checked}, fixed ${u.changed}` : ''}</>
                    : 'No replies counted yet'}
                </div>
                <div style={{ height: 5, borderRadius: 999, background: 'var(--border)', marginTop: 4, overflow: 'hidden' }} title={`${share}% of the tokens of the last 7 days`}>
                  <div style={{ width: `${share}%`, height: '100%', background: LEVEL[g.key === 'visitor' ? 'normal' : draft[g.key as CustomerGroup]].color }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ ...help, marginBottom: '0.625rem' }}>
        Bars = share of the tokens of the last 7 days ({fmtK(usage.total)} in all
        {usage.since ? `, counted since ${new Date(usage.since).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ', counting starts with the next reply'}).
        Two small extra calls per customer message (subject line and frustration score) are not counted here.
      </div>
      {canEdit && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-primary" disabled={busy || !dirty} onClick={() => onSave(draft)}>Save levels</button>
          {!isDefault && <button className="btn btn-sm" disabled={busy} onClick={() => setDraft({ ...data.defaults })}
            style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' }}>Back to recommended</button>}
          {dirty && <span style={help}>Not saved yet. The next reply uses the new levels once saved.</span>}
        </div>
      )}
    </div>
  );
}
