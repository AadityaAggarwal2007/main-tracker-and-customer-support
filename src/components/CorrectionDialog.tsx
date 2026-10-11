'use client';

import { useState } from 'react';
import { AlertCircle, BadgeCheck, Check, Info, Loader2, MessageSquareText, Wrench, X } from 'lucide-react';
import { CORRECTION_KINDS, NOTE_MAX, type CorrectionKind } from '@/lib/chat/corrections-rules';

// "Correction" (owner 2026-10-11): a team member notes what a VERIFIED customer wants changed on their order
// (address, pincode, phone, size, colour, product, pack / quantity, Buy 1 Get 1, other) and what exactly; the row
// shows in Chat Support > Corrections for everyone, and the Super Admin / Manager fixes the order and marks it done.
// Used by Chat Support (the open chat) and the Mail tab (the open mail). On a chat / sender that is NOT verified the
// same dialog says "Verify first" and offers the two ways (owner answer 2): the team's Verify dialog, or a ready line
// for the reply box that asks the customer to verify (the team member still presses Send). Nothing here is sent to
// the customer by itself.
export function CorrectionDialog({ verified, orders, who, busy, error, onCancel, onSave, onVerifyNow, ask, onAsk, askHint }: {
  verified: boolean;
  // The verified order(s) the correction can be for: one is shown read-only, several give a choice.
  orders: string[];
  who: 'customer' | 'sender';
  busy: boolean; error: string;
  onCancel: () => void;
  onSave: (kinds: CorrectionKind[], note: string, orderId: string) => void;
  // Not verified: "Verify now" opens the team's Verify dialog / form.
  onVerifyNow?: () => void;
  // Not verified: the ready lines for the reply box (English / Hinglish); onAsk puts one there. Missing = cannot
  // reply right now (askHint says why).
  ask?: { en: string; hi: string } | null;
  onAsk?: (text: string) => void;
  askHint?: string;
}) {
  const [kinds, setKinds] = useState<CorrectionKind[]>([]);
  const [note, setNote] = useState('');
  const [orderId, setOrderId] = useState(orders[0] || '');
  const ok = kinds.length > 0 && note.trim().length > 0 && note.trim().length <= NOTE_MAX && !/</.test(note) && !!orderId;
  const toggle = (k: CorrectionKind) => setKinds((list) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]));
  const label = who === 'customer' ? 'this customer' : 'this sender';
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="corr-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '30rem' }}>
        <div className="modal-header">
          <div>
            <div className="modal-title" id="corr-title">{verified ? 'Correction' : `Verify ${label} first`}</div>
            <p className="modal-subtitle">{verified ? 'What the customer wants changed on the order. The team fixes it and marks it done.' : 'A correction is noted only on a verified order.'}</p>
          </div>
          <button type="button" className="btn-icon" onClick={onCancel} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>
        {!verified ? (
          <div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.75rem', color: 'var(--fg-muted)', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.625rem', marginBottom: '0.75rem' }}>
              <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Two ways: type the Order ID and the full phone number the customer already gave (Verify now), or ask the customer to verify (the line goes into your reply box; you still press Send).</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {onVerifyNow && (
                <button type="button" className="btn btn-primary" onClick={onVerifyNow}><BadgeCheck size={14} /> Verify now (Order ID + full phone)</button>
              )}
              {ask && onAsk ? (
                <>
                  <button type="button" className="btn btn-outline" onClick={() => onAsk(ask.en)}><MessageSquareText size={14} /> Ask the customer to verify (English)</button>
                  <button type="button" className="btn btn-outline" onClick={() => onAsk(ask.hi)}><MessageSquareText size={14} /> Ask the customer to verify (Hinglish)</button>
                </>
              ) : askHint ? (
                <p className="meta" style={{ margin: 0 }}>{askHint}</p>
              ) : null}
            </div>
            <div className="modal-actions"><button type="button" className="btn btn-outline" onClick={onCancel}>Close</button></div>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onSave(kinds, note.trim(), orderId); }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.625rem' }}>
              Order{' '}
              {orders.length > 1 ? (
                <select className="form-input" style={{ marginTop: 4 }} value={orderId} onChange={(e) => setOrderId(e.target.value)}>
                  {orders.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <span className="chip chip-ok" style={{ marginLeft: 4 }}><BadgeCheck /> {orderId || '—'} · verified</span>
              )}
            </div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.375rem' }}>What to change</div>
            <div className="corr-kinds" role="group" aria-label="What to change">
              {CORRECTION_KINDS.map((k) => (
                <button type="button" key={k.key} className="seg-btn" aria-pressed={kinds.includes(k.key)} onClick={() => toggle(k.key)}>
                  {kinds.includes(k.key) && <Check size={12} />} {k.label}
                </button>
              ))}
            </div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, margin: '0.625rem 0' }}>What exactly
              <textarea className="form-input" style={{ marginTop: 4 }} rows={4} value={note} maxLength={NOTE_MAX} autoFocus
                placeholder="e.g. Size M instead of L on the kurti; new pincode 110045" onChange={(e) => setNote(e.target.value)} />
              <span className="meta" style={{ fontWeight: 400 }}>{note.length} / {NOTE_MAX}</span>
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.75rem', color: 'var(--fg-muted)', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.625rem', marginBottom: '0.75rem' }}>
              <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Everyone sees it in Chat Support &gt; Corrections. Only the Super Admin and the Manager change the order and mark it done. The customer is told nothing by this: tell them yourself in the chat.</span>
            </div>
            {error && (
              <p role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger)', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!ok || busy}>
                {busy ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Saving…</> : <><Wrench size={14} /> Save correction</>}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
