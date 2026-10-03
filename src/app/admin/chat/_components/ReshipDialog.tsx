'use client';

import { useState } from 'react';
import { Loader2, Check, AlertCircle, X, Info, PackageCheck } from 'lucide-react';

// "Mark reshipped" (owner 2026-10-03): the new parcel for a Ship again chat was sent; the team
// gives the new fship tracking link or the AWB. PATCH /api/chat/conversations/[id]/reship.
export function ReshipDialog({ orderId, busy, error, onCancel, onSave }: {
  orderId: string | null; busy: boolean; error: string; onCancel: () => void; onSave: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const ok = value.trim().length >= 8;
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="reship-title" onClick={e => e.stopPropagation()} style={{ maxWidth: '28rem' }}>
        <div className="modal-header">
          <div>
            <div className="modal-title" id="reship-title">Mark reshipped</div>
            <p className="modal-subtitle">{orderId ? `Order ${orderId} · ` : ''}the new parcel was sent</p>
          </div>
          <button type="button" className="btn-icon" onClick={onCancel} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); if (ok && !busy) onSave(value.trim()); }}>
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.625rem' }}>New tracking link or AWB number
            <input className="form-input" style={{ marginTop: 4 }} value={value} maxLength={400} autoFocus placeholder="https://app.fship.in/shipment/tracking?awbno=… or 143449611008922"
              onChange={e => setValue(e.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.75rem', color: 'var(--fg-muted)', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.625rem', marginBottom: '0.75rem' }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>The chat moves down the Ship again list as "Reshipped" with this AWB. Internal only: the customer is not told by this. Pasting the new tracking link in a reply marks it the same way.</span>
          </div>
          {error && (
            <p role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger)', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!ok || busy}>
              {busy ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Saving…</> : <><Check size={14} /> Mark reshipped</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
