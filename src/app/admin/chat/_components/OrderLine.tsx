'use client';

import { useState } from 'react';
import { Loader2, Check, AlertCircle, X, Pencil, Info, MapPin, CalendarDays, Truck, CalendarCheck } from 'lucide-react';
import { INDIAN_STATES, addressText, type OrderAddress } from '@/lib/chat/order-address';
import type { OrderFacts, StaffAddress } from '../_lib/types';
import { orderDay, stampIST } from '../_lib/inbox';

export function OrderLine({ facts }: { facts: OrderFacts }) {
  const placed = orderDay(facts.placed_on);
  // A delivered, cancelled or returning order has no delivery still to come.
  const eta = facts.delivered || facts.mode === 'cancelled' || facts.mode === 'rto' ? null : orderDay(facts.eta);
  const tone = facts.mode === 'cancelled' || facts.mode === 'rto' ? { bg: 'var(--danger-light)', fg: 'var(--danger)' }
    : facts.mode === 'failed' ? { bg: 'var(--warning-light)', fg: 'var(--warning)' }
    : facts.delivered ? { bg: 'var(--success-light)', fg: 'var(--success)' }
    : { bg: 'var(--primary-light)', fg: 'var(--primary)' };
  const item = { display: 'inline-flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' } as const;
  return (
    <div title={`Order ${facts.order_id}${facts.source === 'phone_match' ? ' (matched by phone number, not verified)' : ''}`} style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem 0.75rem',
      fontSize: '0.75rem', marginTop: '0.375rem', color: 'var(--fg-muted)',
    }}>
      {placed && (
        <span style={item}><CalendarDays size={12} /> Ordered <b style={{ color: 'var(--fg)', fontWeight: 600 }}>{placed}</b></span>
      )}
      <span style={item}>
        <Truck size={12} /> Now
        <b style={{ background: tone.bg, color: tone.fg, padding: '1px 7px', borderRadius: 9999, fontWeight: 700, fontSize: '0.6875rem' }}>{facts.status}</b>
      </span>
      {eta && (
        <span style={item}>
          <CalendarCheck size={12} /> Est. delivery <b style={{ color: 'var(--fg)', fontWeight: 600 }}>{eta}</b>
        </span>
      )}
    </div>
  );
}

export function AddressLine({ address, editable, onEdit }: { address: StaffAddress; editable: boolean; onEdit: () => void }) {
  const text = addressText(address);
  // Inline, so a long address wraps like text and the chip and Edit follow it.
  return (
    <div style={{ fontSize: '0.75rem', marginTop: '0.25rem', color: 'var(--fg)', lineHeight: 1.6, wordBreak: 'break-word' }}>
      <MapPin size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '0.375rem', color: 'var(--fg-muted)' }} />
      {text || <span style={{ color: 'var(--fg-muted)' }}>No address on this order</span>}
      {address.edited_at && (
        <span title={`Changed in ShipTrack by ${address.edited_by || 'the team'} on ${stampIST(address.edited_at)}. Shopify and CSV updates keep this address.`} style={{
          display: 'inline-block', verticalAlign: 'middle', marginLeft: '0.375rem', whiteSpace: 'nowrap', lineHeight: 1.4,
          fontSize: '0.625rem', fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'var(--success-light)', color: 'var(--success)',
        }}>
          Changed{address.edited_by ? ` · ${address.edited_by}` : ''}
        </span>
      )}
      {editable && (
        <button type="button" onClick={onEdit} title="Change the delivery address" className="btn btn-outline btn-sm"
          style={{ display: 'inline-flex', verticalAlign: 'middle', marginLeft: '0.375rem', padding: '1px 8px', fontSize: '0.6875rem', gap: '0.25rem', minHeight: 0, lineHeight: 1.4 }}>
          <Pencil size={11} /> Edit
        </button>
      )}
    </div>
  );
}

export function AddressDialog({ initial, orderId, busy, error, onCancel, onSave }: {
  initial: OrderAddress; orderId: string; busy: boolean; error: string;
  onCancel: () => void; onSave: (a: OrderAddress) => void;
}) {
  const [a, setA] = useState<OrderAddress>(initial);
  // An old order whose state is spelled another way keeps it as a choice.
  const states = !initial.state || INDIAN_STATES.includes(initial.state) ? INDIAN_STATES : [initial.state, ...INDIAN_STATES];
  const ok = a.line1.trim().length >= 3 && a.city.trim().length >= 2 && !!a.state && /^[1-9][0-9]{5}$/.test(a.pincode);
  const label = { display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.625rem' } as const;
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="addr-title" onClick={e => e.stopPropagation()} style={{ maxWidth: '32rem' }}>
        <div className="modal-header">
          <div>
            <div className="modal-title" id="addr-title">Change delivery address</div>
            <p className="modal-subtitle">Order {orderId}</p>
          </div>
          <button type="button" className="btn-icon" onClick={onCancel} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); if (ok && !busy) onSave(a); }}>
          <label style={label}>House / flat, street
            <input className="form-input" style={{ marginTop: 4 }} value={a.line1} maxLength={250} autoFocus
              onChange={e => setA({ ...a, line1: e.target.value })} />
          </label>
          <label style={label}>Area, landmark <span style={{ fontWeight: 400, color: 'var(--fg-muted)' }}>(optional)</span>
            <input className="form-input" style={{ marginTop: 4 }} value={a.line2} maxLength={250}
              onChange={e => setA({ ...a, line2: e.target.value })} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 8.5rem', gap: '0.625rem' }}>
            <label style={label}>City
              <input className="form-input" style={{ marginTop: 4 }} value={a.city} maxLength={60}
                onChange={e => setA({ ...a, city: e.target.value })} />
            </label>
            <label style={label}>Pincode
              <input className="form-input" style={{ marginTop: 4 }} value={a.pincode} inputMode="numeric" maxLength={6}
                onChange={e => setA({ ...a, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
            </label>
          </div>
          <label style={label}>State
            <select className="form-input" style={{ marginTop: 4 }} value={a.state} onChange={e => setA({ ...a, state: e.target.value })}>
              {!a.state && <option value="">Pick the state</option>}
              {states.map(st => <option key={st} value={st}>{st}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.75rem', color: 'var(--fg-muted)', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.625rem', marginBottom: '0.875rem' }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>Changes the address in ShipTrack only (order details and tracking page), not in Shopify or with the courier. Later Shopify or CSV updates will not change it back.</span>
          </div>
          {error && (
            <p role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger)', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!ok || busy}>
              {busy ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Saving…</> : <><Check size={14} /> Save address</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
