'use client';

import { useState } from 'react';
import { BadgeCheck, ChevronDown, ChevronUp, Copy, Loader2, MapPin, MessageCircle, Package, ShieldQuestion, Wallet } from 'lucide-react';
import type { Customer, CustomerOrder } from './types';

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—');
const rupees = (n: number | null) => (n == null ? '' : `₹${Math.round(n).toLocaleString('en-IN')}`);

// The customer next to the mail (owner 2026-10-11): name, email, the verified order(s) with the tracking page's stage,
// placed / estimated dates, the items, payment + total, the city, Copy tracking link and Open chat; not verified = the
// orders placed with this email as hints and the Verify button. Read only. On a desktop it is the right column; on a
// narrow screen it sits above the conversation folded into one line (the Customer / Verify line) that opens on a tap.
export default function CustomerCard({ customer, loading, onVerify, onAlert }: {
  customer: Customer | null; loading: boolean; onVerify?: () => void; onAlert: (type: string, message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const copy = async (link: string) => {
    try { await navigator.clipboard.writeText(link); onAlert('success', 'Tracking link copied.'); }
    catch { onAlert('error', 'Could not copy. Select the link and copy it.'); }
  };
  const first = customer?.verified[0];
  const name = first?.customerName || null;
  const line = loading && !customer ? 'Looking up the customer…'
    : !customer ? 'Customer'
    : first ? `${name || 'Customer'} · ${first.facts?.status || `order ${first.orderId}`}`
    : customer.hints.length ? `Not verified · ${customer.hints.length} order${customer.hints.length === 1 ? '' : 's'} with this email`
    : 'Not verified · no order with this email';

  const order = (o: CustomerOrder) => (
    <div key={o.orderId} className="mail-cust-order">
      <div className="mail-cust-row">
        <b>Order {o.orderId}</b>
        {o.facts && <span className={`chip ${o.facts.mode !== 'normal' ? 'chip-muted' : o.facts.delivered ? 'chip-ok' : o.facts.late ? 'chip-warn' : 'chip-muted'}`}>{o.facts.status}</span>}
      </div>
      {o.facts && (
        <dl className="mail-cust-dl">
          <div><dt>Placed</dt><dd>{day(o.facts.placed_on)}</dd></div>
          {o.facts.delivered ? null : o.facts.mode !== 'normal' ? null : <div><dt>{o.facts.late ? 'Was due' : 'Estimated'}</dt><dd>{day(o.facts.eta)}{o.facts.late ? ` · ${o.facts.late.daysPast} day${o.facts.late.daysPast === 1 ? '' : 's'} late` : ''}</dd></div>}
          {(o.payment || o.total != null) && <div><dt><Wallet size={12} /> Paid</dt><dd>{o.payment === 'cod' ? 'Cash on delivery' : o.payment === 'prepaid' ? 'Prepaid' : ''}{o.total != null ? ` ${rupees(o.total)}` : ''}</dd></div>}
          {o.place && (o.place.city || o.place.state) && <div><dt><MapPin size={12} /> Place</dt><dd>{[o.place.city, o.place.state].filter(Boolean).join(', ')}{o.place.pincode ? ` ${o.place.pincode}` : ''}</dd></div>}
        </dl>
      )}
      {o.items.length > 0 && (
        <ul className="mail-cust-items">
          {o.items.map((i, n) => <li key={n}><Package size={12} /> <span className="truncate">{i.product_name || '(item)'}</span><span className="meta">× {i.quantity}{i.price != null ? ` · ${rupees(i.price)}` : ''}</span></li>)}
        </ul>
      )}
      <div className="mail-cust-actions">
        {o.facts?.tracking_link && <button type="button" className="btn btn-outline btn-sm" onClick={() => copy(o.facts!.tracking_link!)}><Copy size={13} /> Copy tracking link</button>}
        {o.chatId && <a className="btn btn-outline btn-sm" href={`/admin/chat?open=${encodeURIComponent(o.chatId)}`}><MessageCircle size={13} /> Open chat</a>}
      </div>
    </div>
  );

  return (
    <aside className={`mail-cust${open ? ' open' : ''}`} aria-label="Customer">
      <button type="button" className="mail-cust-line" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {loading && !customer ? <Loader2 size={14} className="spin" /> : first ? <BadgeCheck size={14} className="ok" /> : <ShieldQuestion size={14} className="warn" />}
        <span className="truncate">{line}</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      <div className="mail-cust-body">
        <div className="mail-cust-head">
          <span className={`mail-avatar sm${first ? '' : ' warn'}`} aria-hidden="true">{(name || customer?.email || '?').slice(0, 1).toUpperCase()}</span>
          <span className="mail-msg-who">
            <b className="truncate">{name || (first ? 'Customer' : 'Not verified')}</b>
            <span className="meta truncate" title={customer?.email}>{customer?.email}</span>
          </span>
        </div>
        {loading && !customer && <div className="meta"><Loader2 size={12} className="spin" /> Looking up the customer…</div>}
        {customer && first && !customer.ordersAllowed && (
          <div className="meta">Verified for order {customer.verified.map(v => v.orderId).join(', ')}. Your login cannot see order details.</div>
        )}
        {customer && customer.verified.map(order)}
        {customer && !first && (
          <>
            {customer.hints.length > 0 ? (
              <>
                <div className="meta">Orders with this email — verify to see details</div>
                <ul className="mail-cust-hints">
                  {customer.hints.map(h => <li key={h.orderId}><b>{h.orderId}</b><span className="meta">{day(h.placedOn)}{h.status ? ` · ${h.status}` : ''}</span></li>)}
                </ul>
              </>
            ) : <div className="meta">{customer.ordersAllowed ? 'No order of this panel was placed with this email. Ask for the Order ID and the full phone number, then verify.' : 'Not verified yet.'}</div>}
            {onVerify && <button type="button" className="btn btn-primary btn-sm" onClick={onVerify}><BadgeCheck size={14} /> Verify</button>}
          </>
        )}
      </div>
    </aside>
  );
}
