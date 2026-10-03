'use client';

import { Fragment, useState } from 'react';
import { Loader2, Check, AlertCircle, X, Pencil, Info, MapPin, Package, Plus, Trash2 } from 'lucide-react';
import { INDIAN_STATES, addressText, type OrderAddress } from '@/lib/chat/order-address';
import { itemsLine } from '@/lib/chat/order-items';
import type { OrderFacts, StaffAddress, StaffOrderItem, StaffOrderItems } from '../_lib/types';
import { orderDay, stampIST } from '../_lib/inbox';
import { Chip } from './chips';

// One line of order facts, short labels: "#8554 · Placed 2 Oct · Out for Delivery · ETA 15 Oct ·
// Hoshiarpur 146001". Inline, so the header's facts row can truncate it on a phone.
export function OrderLine({ facts, place }: { facts: OrderFacts; place?: string | null }) {
  const placed = orderDay(facts.placed_on);
  // A delivered, cancelled or returning order has no delivery still to come.
  const eta = facts.delivered || facts.mode === 'cancelled' || facts.mode === 'rto' ? null : orderDay(facts.eta);
  const tone = facts.mode === 'cancelled' || facts.mode === 'rto' ? 't-danger'
    : facts.mode === 'failed' ? 't-warn'
    : facts.delivered ? 't-ok'
    : 't-primary';
  return (
    <span title={`Order ${facts.order_id}${facts.source === 'phone_match' ? ' (matched by phone number, not verified)' : ''}`}>
      <b>{facts.order_id}</b>
      {placed && <> · Placed <b>{placed}</b></>}
      {' · '}<span className={tone}>{facts.status}</span>
      {eta && <> · ETA <b>{eta}</b></>}
      {place && <> · {place}</>}
    </span>
  );
}

export function AddressLine({ address, editable, onEdit }: { address: StaffAddress; editable: boolean; onEdit: () => void }) {
  const text = addressText(address);
  // Inline, so a long address wraps like text and the chip and Edit follow it.
  return (
    <div style={{ color: 'var(--fg)', lineHeight: 1.6 }}>
      <MapPin size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '0.375rem', color: 'var(--fg-muted)' }} />
      {text || <span style={{ color: 'var(--fg-muted)' }}>No address on this order</span>}
      {address.edited_at && (
        <>
          {' '}
          <Chip tone="ok" title={`Changed in ShipTrack by ${address.edited_by || 'the team'} on ${stampIST(address.edited_at)}. Shopify and CSV updates keep this address.`}>
            Changed{address.edited_by ? ` · ${address.edited_by}` : ''}
          </Chip>
        </>
      )}
      {editable && (
        <button type="button" onClick={onEdit} title="Change the delivery address" className="btn btn-outline btn-sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginLeft: '0.375rem' }}>
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

// ── The order's items (owner 2026-10-03: "color and product edit ho sake ... upper header ma hi") ──
// Shown under Details like the address; Edit opens ItemsDialog. ShipTrack's copy only (order
// details, Chikki's lookup and the customer's tracking page), not Shopify, not the courier.
export function ItemsLine({ items, editable, onEdit }: { items: StaffOrderItems; editable: boolean; onEdit: () => void }) {
  const text = itemsLine(items.items);
  return (
    <div style={{ color: 'var(--fg)', lineHeight: 1.6 }}>
      <Package size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '0.375rem', color: 'var(--fg-muted)' }} />
      {text || <span style={{ color: 'var(--fg-muted)' }}>No items on this order</span>}
      {items.edited_at && (
        <>
          {' '}
          <Chip tone="ok" title={`Changed in ShipTrack by ${items.edited_by || 'the team'} on ${stampIST(items.edited_at)}. Shopify and CSV updates keep these items.`}>
            Changed{items.edited_by ? ` · ${items.edited_by}` : ''}
          </Chip>
        </>
      )}
      {editable && (
        <button type="button" onClick={onEdit} title="Change the order items" className="btn btn-outline btn-sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginLeft: '0.375rem' }}>
          <Pencil size={11} /> Edit
        </button>
      )}
    </div>
  );
}

type ItemDraft = { product_name: string; quantity: string; price: number | null };
const MAX_ITEMS = 10;
export function ItemsDialog({ initial, orderId, busy, error, onCancel, onSave }: {
  initial: StaffOrderItem[]; orderId: string; busy: boolean; error: string;
  onCancel: () => void; onSave: (items: { product_name: string; quantity: number; price: number | null }[]) => void;
}) {
  const [rows, setRows] = useState<ItemDraft[]>(() => initial.length
    ? initial.map(i => ({ product_name: i.product_name, quantity: String(i.quantity), price: i.price }))
    : [{ product_name: '', quantity: '1', price: null }]);
  const clean = rows.map(r => ({ product_name: r.product_name.trim().replace(/\s+/g, ' '), quantity: Number(r.quantity), price: r.price }));
  const ok = clean.length >= 1 && clean.length <= MAX_ITEMS
    && clean.every(r => r.product_name.length >= 2 && r.product_name.length <= 120 && Number.isInteger(r.quantity) && r.quantity >= 1 && r.quantity <= 20);
  const set = (i: number, patch: Partial<ItemDraft>) => setRows(rs => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const label = { display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.625rem' } as const;
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="items-title" onClick={e => e.stopPropagation()} style={{ maxWidth: '32rem' }}>
        <div className="modal-header">
          <div>
            <div className="modal-title" id="items-title">Change order items</div>
            <p className="modal-subtitle">Order {orderId} · product name with its colour / size, and the quantity</p>
          </div>
          <button type="button" className="btn-icon" onClick={onCancel} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); if (ok && !busy) onSave(clean); }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 4.5rem 2rem', gap: '0.5rem 0.5rem', alignItems: 'center', marginBottom: '0.75rem' }}>
            <span style={label}>Item</span><span style={label}>Qty</span><span />
            {rows.map((r, i) => (
              <Fragment key={i}>
                <input className="form-input" value={r.product_name} maxLength={120} placeholder="Jhumka box - Silver" autoFocus={i === 0}
                  onChange={e => set(i, { product_name: e.target.value })} />
                <input className="form-input" value={r.quantity} inputMode="numeric" maxLength={2}
                  onChange={e => set(i, { quantity: e.target.value.replace(/\D/g, '').slice(0, 2) })} />
                <button type="button" className="btn-icon" aria-label={`Remove item ${i + 1}`} title="Remove this item" disabled={busy || rows.length <= 1}
                  onClick={() => setRows(rs => rs.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
              </Fragment>
            ))}
          </div>
          {rows.length < MAX_ITEMS && (
            <button type="button" className="btn btn-outline btn-sm" disabled={busy} style={{ marginBottom: '0.75rem' }}
              onClick={() => setRows(rs => [...rs, { product_name: '', quantity: '1', price: null }])}><Plus size={13} /> Add item</button>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.75rem', color: 'var(--fg-muted)', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.625rem', marginBottom: '0.75rem' }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>Changes the items in ShipTrack only (order details, Chikki&apos;s answers and the customer&apos;s tracking page), not in Shopify or with the courier. Prices stay as they are. Later Shopify or CSV updates will not change them back.</span>
          </div>
          {error && (
            <p role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger)', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!ok || busy}>
              {busy ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Saving…</> : <><Check size={14} /> Save items</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
