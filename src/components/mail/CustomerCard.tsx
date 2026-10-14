'use client';

import { useState } from 'react';
import { BadgeCheck, ChevronDown, ChevronUp, Copy, Loader2, MapPin, MessageCircle, Package, Send, ShieldQuestion, Truck, Undo2, Wallet } from 'lucide-react';
import type { Customer, CustomerOrder } from './types';
import { AddressDialog, ItemsDialog } from '@/app/admin/chat/_components/OrderLine';
import { ncTitle } from '@/app/admin/chat/_components/chips';
import type { StaffAddress, StaffOrderItems } from '@/app/admin/chat/_lib/types';
import type { OrderAddress } from '@/lib/chat/order-address';

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—');
const rupees = (n: number | null) => (n == null ? '' : `₹${Math.round(n).toLocaleString('en-IN')}`);

// The customer next to the mail (owner 2026-10-11): name, email, the verified order(s) with the tracking page's stage,
// placed / estimated dates, the items, payment + total, the city, Copy tracking link and Open chat; not verified = the
// orders placed with this email as hints and the Verify button. Read only. On a desktop it is the right column; on a
// narrow screen it sits above the conversation folded into one line (the Customer / Verify line) that opens on a tap.
export default function CustomerCard({ customer, loading, onVerify, onAlert, token, onChanged, box }: {
  customer: Customer | null; loading: boolean; onVerify?: () => void; onAlert: (type: string, message: string) => void;
  // Refund / Ship again from the Mail tab (owner 2026-10-13): the same PATCH as a chat, then the card is read again.
  token?: string; onChanged?: () => void;
  // The open mailbox (for /api/mail/case-chat).
  box?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The Super Admin / the Manager mark it (the email chat goes to Chat Support's Refund / Ship again list); a team member
  // sends it to the Manager with one line, as in a chat. Nothing is sent to the customer.
  const markCase = async (o: CustomerOrder, kind: 'refund' | 'reship') => {
    if (!token || busy) return;
    const name = kind === 'refund' ? 'Refund' : 'Ship again';
    let body: Record<string, unknown>;
    if (customer?.cases === 'mark') {
      if (!confirm(`Put this customer in ${name}? It shows in Chat Support > ${name}. The customer is not told anything.`)) return;
      body = { caseKind: kind };
    } else {
      const note = window.prompt(`Send to the Manager as ${name}: one line, what does the customer need?`);
      if (note == null) return;
      body = { forward: kind, note };
    }
    setBusy(true);
    try {
      let chatId = o.emailChat && o.emailChat.verified ? o.emailChat.id : null;
      if (!chatId) {
        const c = await fetch('/api/mail/case-chat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ box, email: customer?.email, orderId: o.orderId }) });
        const cj = await c.json().catch(() => ({}));
        if (!c.ok || !cj.chatId) { onAlert('error', cj.error || 'Could not mark it.'); return; }
        chatId = String(cj.chatId);
      }
      const r = await fetch(`/api/chat/conversations/${encodeURIComponent(chatId)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not mark it.'); return; }
      onAlert('success', 'forward' in body ? `Sent to ${j.holder_name || 'the Manager'} as ${name}.` : `In ${name}: it shows in Chat Support > ${name}.`);
      onChanged?.();
    } catch { onAlert('error', 'Could not mark it.'); }
    finally { setBusy(false); }
  };
  // Edit address / Edit items (owner 2026-10-14: "email ma edit ka option de for address change and product details change,
  // jaisa chat support ma ha"): the customer's email chat for that order (found or made, verified for it, status left
  // alone: /api/mail/case-chat purpose 'edit'), then the SAME dialogs and PATCH routes as the chat header. ShipTrack only:
  // never Shopify, never the courier; the customer is told nothing.
  const [edit, setEdit] = useState<{ order: CustomerOrder; chatId: string; address: StaffAddress | null; items: StaffOrderItems | null; busy: boolean; error: string } | null>(null);
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const openEdit = async (o: CustomerOrder, kind: 'address' | 'items') => {
    if (!token || busy) return;
    setBusy(true);
    try {
      const c = await fetch('/api/mail/case-chat', { method: 'POST', headers: auth, body: JSON.stringify({ box, email: customer?.email, orderId: o.orderId, purpose: 'edit' }) });
      const cj = await c.json().catch(() => ({}));
      if (!c.ok || !cj.chatId) { onAlert('error', cj.error || 'Could not open the order for editing.'); return; }
      const chatId = String(cj.chatId);
      const r = await fetch(`/api/chat/conversations/${encodeURIComponent(chatId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not open the order.'); return; }
      const address = kind === 'address' && j.address_editable ? (j.order_address as StaffAddress) : null;
      const items = kind === 'items' && j.items_editable ? (j.order_items as StaffOrderItems) : null;
      if (!address && !items) { onAlert('error', kind === 'address' ? 'This order\'s address cannot be changed (no address on it, or no right to change orders).' : 'This order\'s items cannot be changed (no right to change orders).'); return; }
      setEdit({ order: o, chatId, address, items, busy: false, error: '' });
    } catch { onAlert('error', 'Could not open the order for editing.'); }
    finally { setBusy(false); }
  };
  const saveEdit = async (what: 'address' | 'items', payload: unknown) => {
    if (!edit) return;
    setEdit({ ...edit, busy: true, error: '' });
    try {
      const r = await fetch(`/api/chat/conversations/${encodeURIComponent(edit.chatId)}/${what}`, { method: 'PATCH', headers: auth, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setEdit({ ...edit, busy: false, error: j.error || 'Could not save it.' }); return; }
      const order = edit.order.orderId;
      setEdit(null);
      onAlert('success', j.unchanged ? 'Nothing changed.' : `${what === 'address' ? 'Address / phone' : 'Items'} updated in ShipTrack · order ${order}. Shopify and the courier are not changed; tell the customer in your reply.`);
      onChanged?.();
    } catch { setEdit({ ...edit, busy: false, error: 'Could not save it.' }); }
  };
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
        {o.numberChanged && <span className="chip chip-warn" title={ncTitle(o.numberChanged)}>NC</span>}
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
        {customer?.canEdit && token && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void openEdit(o, 'address')} title="Change the delivery address or the phone in ShipTrack (not Shopify, not the courier)"><MapPin size={13} /> Edit address / phone</button>}
        {customer?.canEdit && token && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void openEdit(o, 'items')} title="Change the products / colour / size in ShipTrack (not Shopify, not the courier)"><Package size={13} /> Edit items</button>}
      </div>
      {/* Refund / Ship again for a customer who writes by email (owner 2026-10-13): on their email chat, listed in Chat Support */}
      {o.emailChat && o.emailChat.caseKind && (
        <div className="mail-cust-case">
          <span className={`chip ${o.emailChat.caseKind === 'refund' ? 'chip-warn' : 'chip-info'}`}>{o.emailChat.caseKind === 'refund' ? 'In Refund' : 'In Ship again'}</span>
          {o.emailChat.caseBy && <span className="meta">by {o.emailChat.caseBy}</span>}
          <a className="btn btn-ghost btn-sm" href={`/admin/chat?open=${encodeURIComponent(o.emailChat.id)}`}>Open in Chat Support</a>
        </div>
      )}
      {/* Shown for every verified order (owner 2026-10-13, Anurag: the buttons hid when the customer's email chat was missing
          or not verified for this order, e.g. a mail auto-verified later or one to the chargeback Gmail): the click asks
          /api/mail/case-chat for that chat first (found or made, verified for the order), then marks it. */}
      {!(o.emailChat && o.emailChat.caseKind) && customer?.cases && token && (
        <div className="mail-cust-case">
          {customer.cases === 'forward' && <span className="meta"><Send size={12} /> Send to Manager:</span>}
          <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void markCase(o, 'refund')}><Undo2 size={13} /> Refund</button>
          <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void markCase(o, 'reship')}><Truck size={13} /> Ship again</button>
        </div>
      )}
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
      {edit?.address && (
        <AddressDialog initial={edit.address} orderId={edit.address.order_id} busy={edit.busy} error={edit.error}
          onCancel={() => setEdit(null)} onSave={(a: OrderAddress) => void saveEdit('address', a)} />
      )}
      {edit?.items && (
        <ItemsDialog initial={edit.items.items} orderId={edit.items.order_id} busy={edit.busy} error={edit.error}
          onCancel={() => setEdit(null)} onSave={(items) => void saveEdit('items', { items })} />
      )}
    </aside>
  );
}
