'use client';

import { useState } from 'react';
import { Loader2, AlertCircle, X, Send, Undo2, Truck } from 'lucide-react';
import { cleanTransferNote } from '@/lib/chat/team-rules';

// Forward to Manager (owner 2026-10-10: "support team refund ya reship wale cases manager ko forward karegi, fir
// manager handle karega"). The chat gets the Refund / Ship again mark AND becomes the Manager's, with a one-line
// note only the team sees (the server checks everything again). The customer is told nothing.
export function ForwardDialog({ busy, error, onCancel, onSend }: {
  busy: boolean; error: string;
  onCancel: () => void; onSend: (kind: 'refund' | 'reship', note: string) => void;
}) {
  const [kind, setKind] = useState<'refund' | 'reship' | null>(null);
  const [note, setNote] = useState('');
  const clean = cleanTransferNote(note);
  const ok = !!kind && !!clean && !busy;
  const option = (k: 'refund' | 'reship', label: string, line: string, Icon: typeof Undo2) => (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.5rem 0.625rem', borderRadius: 8, cursor: 'pointer',
      border: `1px solid ${kind === k ? 'var(--primary)' : 'var(--border)'}`, background: kind === k ? 'var(--primary-light)' : 'transparent',
    }}>
      <input type="radio" name="forward-kind" checked={kind === k} onChange={() => setKind(k)} disabled={busy} style={{ marginTop: 3 }} />
      <span style={{ minWidth: 0, fontSize: '0.8125rem' }}>
        <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon size={13} /> {label}</span>
        <span style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>{line}</span>
      </span>
    </label>
  );
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="forward-title" onClick={e => e.stopPropagation()} style={{ maxWidth: '28rem' }}>
        <div className="modal-header">
          <div>
            <div className="modal-title" id="forward-title">Send to the Manager</div>
            <p className="modal-subtitle">The Manager decides and handles it. The customer is not told anything.</p>
          </div>
          <button type="button" className="btn-icon" onClick={onCancel} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); if (ok && kind && clean) onSend(kind, clean); }}>
          <div role="radiogroup" aria-label="What the customer needs" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.875rem' }}>
            {option('refund', 'Refund', 'The customer wants their money back (or the order must be refunded)', Undo2)}
            {option('reship', 'Ship again', 'The parcel must be sent again (lost, wrong / fake tracking, damaged)', Truck)}
          </div>
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }} htmlFor="forward-note">One line for the Manager</label>
          <input id="forward-note" className="form-input" value={note} onChange={e => setNote(e.target.value)} maxLength={200} disabled={busy}
            placeholder="e.g. Parcel shows delivered, customer says not received" autoFocus />
          <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', margin: '0.25rem 0 0.875rem' }}>Only the team sees this note.</p>
          {error && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', color: 'var(--danger)', fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
              <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} /> {error}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <button type="button" className="btn btn-outline btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!ok}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Send size={14} />} Send to Manager
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
