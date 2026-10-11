'use client';

import { useState } from 'react';
import { Loader2, AlertCircle, X, Info, BadgeCheck } from 'lucide-react';

// "Team ka Verify button" (owner 2026-10-11): a team member types the Order ID + the customer's FULL
// phone number; both must match one order of this chat's own panel. POST /api/chat/conversations/[id]/verify.
// The server decides (team-verify.ts); this dialog only asks and shows its answer. Website / email chats only.
export function VerifyDialog({ busy, error, email, onCancel, onSave }: {
  busy: boolean; error: string; email: boolean; onCancel: () => void; onSave: (orderId: string, phone: string) => void;
}) {
  const [orderId, setOrderId] = useState('');
  const [phone, setPhone] = useState('');
  const ok = orderId.trim().length > 0 && phone.replace(/\D/g, '').length >= 10;
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="verify-title" onClick={e => e.stopPropagation()} style={{ maxWidth: '26rem' }}>
        <div className="modal-header">
          <div>
            <div className="modal-title" id="verify-title">Verify this customer</div>
            <p className="modal-subtitle">Order ID + the full phone number on the order, as the customer {email ? 'wrote in the mail' : 'typed in the chat'}</p>
          </div>
          <button type="button" className="btn-icon" onClick={onCancel} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); if (ok && !busy) onSave(orderId.trim(), phone.trim()); }}>
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.625rem' }}>Order ID
            <input className="form-input" style={{ marginTop: 4 }} value={orderId} maxLength={40} autoFocus placeholder="#1553" autoComplete="off"
              onChange={e => setOrderId(e.target.value)} />
          </label>
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.625rem' }}>Full phone number
            <input className="form-input" style={{ marginTop: 4 }} value={phone} maxLength={16} inputMode="numeric" placeholder="98765 43210" autoComplete="off"
              onChange={e => setPhone(e.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.75rem', color: 'var(--fg-muted)', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.625rem', marginBottom: '0.75rem' }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>Both must match ONE order of this panel. A phone number alone verifies nobody. The customer is told nothing; wrong tries are limited.</span>
          </div>
          {error && (
            <p role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger)', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!ok || busy}>
              {busy ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Checking…</> : <><BadgeCheck size={14} /> Verify</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
