'use client';

import { useMemo, useState } from 'react';
import { CheckCircle2, Minus, Plus, Timer } from 'lucide-react';
import { DELIVERED_INDEX, JOURNEY, MAX_WINDOW_DAYS, MIN_WINDOW_DAYS, stageStartDay } from '@/lib/journey';

// Panel Settings > Auto-Progression (owner, 2026-10-01: "jo system me saved hai usi hisaab se").
// Shows the schedule the system really runs (src/lib/journey.ts, used by the tracking page, the
// cron /api/cron/progress-orders and the AI), read from the same code, so it can never drift.
// Nothing to set here: the old per-stage minutes (progression_settings) were not used by anything.
// The example picks how far the estimated date is from the order, 13-20 days, to show the dates.

const DAY_MS = 86_400_000;
const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

export default function AutoProgressionCard() {
  const [windowDays, setWindowDays] = useState(MIN_WINDOW_DAYS);
  const today = useMemo(() => new Date(), []);
  const stages = JOURNEY.map((s, i) => {
    const day = i === DELIVERED_INDEX ? windowDays : stageStartDay(i, windowDays);
    const beforeEta = windowDays - day;
    return {
      key: s.key,
      label: s.status === 'Shipment Picked Up' ? 'Picked Up' : s.status,
      day,
      date: new Date(today.getTime() + day * DAY_MS),
      note: i === DELIVERED_INDEX ? 'Only your team marks it'
        : i >= 6 ? `${beforeEta} day${beforeEta === 1 ? '' : 's'} before the estimated date`
        : i === 0 ? 'When the order comes in' : `Day ${day} after the order`,
      team: i === DELIVERED_INDEX,
      eta: i >= 6,
    };
  });
  const step = (n: number) => setWindowDays((w) => Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, w + n)));
  const muted = { fontSize: '0.75rem', color: 'var(--fg-muted)' };

  return (
    <div className="tf-card" style={{ padding: '1.5rem', marginTop: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.375rem' }}>
        <Timer size={18} style={{ color: 'var(--primary)' }} />
        <span style={{ fontWeight: 700, fontSize: '1rem' }}>Auto-Progression</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.6875rem', fontWeight: 600, padding: '0.125rem 0.5rem', borderRadius: 999, color: 'var(--success)', background: 'var(--success-light)' }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--success)', animation: 'pulseDot 1.6s ease-in-out infinite' }} /> Live, every minute
        </span>
      </div>
      <p style={{ ...muted, fontSize: '0.8125rem', lineHeight: 1.6, margin: '0 0 1rem' }}>
        How every order moves on its tracking page. Nothing to set: each order follows its own estimated delivery date,
        and the last stages count back from it. Delivered is never automatic.
      </p>

      {/* Example: how far the estimated date is */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap', padding: '0.625rem 0.75rem', borderRadius: 10, background: 'var(--bg-subtle)', border: '1px solid var(--border)', marginBottom: '1rem' }}>
        <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>Example: an order placed today, estimated delivery after</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button type="button" className="btn-icon" aria-label="Fewer days" disabled={windowDays <= MIN_WINDOW_DAYS} onClick={() => step(-1)}><Minus size={14} /></button>
          <span style={{ minWidth: 64, textAlign: 'center', fontWeight: 700 }}>{windowDays} days</span>
          <button type="button" className="btn-icon" aria-label="More days" disabled={windowDays >= MAX_WINDOW_DAYS} onClick={() => step(1)}><Plus size={14} /></button>
        </span>
        <span style={muted}>(most orders: {MIN_WINDOW_DAYS})</span>
      </div>

      {/* The stages */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
        {stages.map((s, i) => (
          <div key={s.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '0.625rem 0.75rem', borderRadius: 10,
            border: `1px solid ${s.team ? 'var(--success)' : 'var(--border)'}`, background: s.team ? 'var(--success-light)' : s.eta ? 'var(--primary-light)' : 'var(--card-bg)' }}>
            <span style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.75rem', fontWeight: 700, color: '#fff', background: s.team ? 'var(--success)' : 'var(--primary)' }}>
              {s.team ? <CheckCircle2 size={15} /> : i + 1}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 700 }}>{s.label}</span>
              <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--fg-secondary)' }}>
                {s.team ? `Estimated ${fmt(s.date)}` : `${fmt(s.date)} · day ${s.day}`}
              </span>
              <span style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>{s.note}</span>
            </span>
          </div>
        ))}
      </div>

      <ul style={{ ...muted, lineHeight: 1.7, margin: '1rem 0 0', paddingLeft: '1.1rem' }}>
        <li>Estimated date: the order&apos;s own date when it is {MIN_WINDOW_DAYS}–{MAX_WINDOW_DAYS} days after ordering, otherwise day {MIN_WINDOW_DAYS}.</li>
        <li>A day after the estimated date the tracking page says &ldquo;taking longer than usual&rdquo;, never &ldquo;arriving soon&rdquo;.</li>
        <li>Delivered is marked only by your team; who and when are saved.</li>
      </ul>
    </div>
  );
}
