'use client';

import type { CSSProperties } from 'react';
import { RefreshCw, Settings } from 'lucide-react';
import type { TeamScoreResponse } from '@/lib/team-score/types';
import { CHIPS, FIRST_DAY, agoText, chosen, muted, small, type Chip, type Period } from './TeamScoreShared';

export default function TeamScoreControls({ period, pickChip, today, pickDay, dateInput, fetchedAt, loading, beforeStart, load, self, data, openRules }: {
  period: Period | null; pickChip: (v: Chip) => void; today: string; pickDay: (v: string) => void; dateInput: CSSProperties;
  fetchedAt: number | null; loading: boolean; beforeStart: boolean; load: (fresh: boolean) => Promise<void>;
  self: boolean; data: TeamScoreResponse | null; openRules: () => void;
}) {
  return (
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
  );
}
