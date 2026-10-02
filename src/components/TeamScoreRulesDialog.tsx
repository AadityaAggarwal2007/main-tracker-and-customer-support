'use client';

import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { Loader2, X } from 'lucide-react';
import type { PointKind, Weights } from '@/lib/team-score/types';
import { POINT_LABELS, WEIGHT_KEYS } from '@/lib/team-score/rules';
import { addDays, dayLabel } from '@/lib/team-score/clock';
import type { WeightsRow } from '@/lib/team-score/report';
import { FIRST_DAY, isDay, muted, small } from './TeamScoreShared';

export default function TeamScoreRulesDialog({
  saving, recomputing, setRulesOpen, rulesPlan, weightChanges, wDraft, setWDraft, weightError, field, today, effFrom, setEffFrom,
  ptsFrom, setPtsFrom, replaced, saveRules, canRecompute, lastFinal, reDay, setReDay, reReason, setReReason, recompute,
}: {
  saving: boolean; recomputing: boolean; setRulesOpen: Dispatch<SetStateAction<boolean>>;
  rulesPlan: { base: WeightsRow; today: WeightsRow | null; scheduled: WeightsRow[] } | null;
  weightChanges: (prev: Partial<Weights> | undefined, next: Partial<Weights>, was: string) => string;
  wDraft: Record<PointKind, string>; setWDraft: Dispatch<SetStateAction<Record<PointKind, string> | null>>;
  weightError: (v: string) => string; field: CSSProperties; today: string;
  effFrom: string; setEffFrom: Dispatch<SetStateAction<string>>; ptsFrom: string; setPtsFrom: Dispatch<SetStateAction<string>>;
  replaced: WeightsRow[]; saveRules: () => Promise<void>; canRecompute: boolean; lastFinal: string;
  reDay: string; setReDay: Dispatch<SetStateAction<string>>; reReason: string; setReReason: Dispatch<SetStateAction<string>>;
  recompute: () => Promise<void>;
}) {
  return (
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
        </div>
  );
}
