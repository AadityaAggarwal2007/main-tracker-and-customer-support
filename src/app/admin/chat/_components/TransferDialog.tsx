'use client';

import { useState } from 'react';
import { Loader2, AlertCircle, X, ArrowRightLeft, Lock } from 'lucide-react';
import { cleanTransferNote } from '@/lib/chat/team-rules';
import type { TeamMember, TransferTarget } from '../_lib/types';
import { presenceText } from '../_lib/inbox';

// Transfer this chat: to whom, with a one-line note only the team sees (src/lib/chat/team-rules.ts:
// the server lists who may get it and checks everything again). The note lives only in the team
// history: never in the chat, the customer's widget or email, the AI, or search.
export function TransferDialog({ targets, team, me, busy, error, onCancel, onSend }: {
  targets: TransferTarget[]; team: TeamMember[]; me: string | null; busy: boolean; error: string;
  onCancel: () => void; onSend: (to: TransferTarget, note: string) => void;
}) {
  // The picked target's key ('' = Nobody); undefined = nothing picked yet.
  const [pick, setPick] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('');
  const keyOf = (t: TransferTarget) => t.key ?? '';
  // The list refreshes with the thread; a target that left it is no longer picked.
  const chosen = targets.find(t => keyOf(t) === pick) ?? null;
  // The same test the server makes: 3+ characters, a letter, one line.
  const clean = cleanTransferNote(note);
  const ok = !!chosen && !!clean && !busy;
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="transfer-title" onClick={e => e.stopPropagation()} style={{ maxWidth: '28rem' }}>
        <div className="modal-header">
          <div>
            <div className="modal-title" id="transfer-title">Transfer this chat</div>
            <p className="modal-subtitle">Who answers this customer from now on</p>
          </div>
          <button type="button" className="btn-icon" onClick={onCancel} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); if (ok && chosen && clean) onSend(chosen, clean); }}>
          {targets.length === 0 ? (
            <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', marginBottom: '0.875rem' }}>
              You cannot transfer this chat any more. Close this and look at who has it now.
            </p>
          ) : (
            <div role="radiogroup" aria-label="Transfer to" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.875rem' }}>
              {targets.map(t => {
                const k = keyOf(t);
                const member = t.key ? team.find(m => m.key === t.key) : undefined;
                const bits = [t.senior ? 'Senior' : '', t.key && t.key !== me ? presenceText(t.away_min, member?.seen_min) : ''].filter(Boolean);
                const picked = pick === k;
                return (
                  <label key={k || 'nobody'} style={{
                    display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.5rem 0.625rem', borderRadius: 8, cursor: 'pointer',
                    border: `1px solid ${picked ? 'var(--primary)' : 'var(--border)'}`, background: picked ? 'var(--primary-light)' : 'transparent',
                  }}>
                    <input type="radio" name="transfer-to" checked={picked} onChange={() => setPick(k)} disabled={busy} style={{ marginTop: 3 }} />
                    <span style={{ minWidth: 0, fontSize: '0.8125rem' }}>
                      <span style={{ fontWeight: 600 }}>{t.name}</span>
                      {bits.length > 0 && (
                        <span style={{ color: t.away_min != null ? '#b45309' : 'var(--fg-muted)' }}> · {bits.join(' · ')}</span>
                      )}
                      {t.key === null && (
                        <span style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>
                          Nobody has it: the next person to reply or press Take over gets it.
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.375rem' }}>Note for the team
            <input className="form-input" style={{ marginTop: 4 }} value={note} maxLength={200} autoComplete="off" disabled={busy}
              placeholder="Why? One line for the team" onChange={e => setNote(e.target.value)} />
          </label>
          <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <Lock size={11} style={{ flexShrink: 0 }} /> Only the team sees this note. The customer and the AI never see it.
          </p>
          {error && (
            <p role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger)', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!ok}>
              {busy ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Transferring…</> : <><ArrowRightLeft size={14} /> Transfer</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
