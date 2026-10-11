'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, Loader2, Mail, MapPin, MessageCircle, Package, RefreshCw, RotateCcw, Wrench, X } from 'lucide-react';
import { can, isTeamLead } from '@/lib/permissions';
import { activeHeaders } from '@/lib/presence-client';
import { DONE_NOTE_MAX, ageText, kindLabel, type CorrectionAction, type CorrectionCounts } from '@/lib/chat/corrections-rules';
import type { CorrectionListRow } from '@/lib/chat/corrections';
import type { OrderAddress } from '@/lib/chat/order-address';
import type { AuthUser, Business, StaffAddress, StaffOrderItems } from '../_lib/types';
import { timeAgo } from '../_lib/inbox';
import { Chip } from './chips';
import { AddressDialog, ItemsDialog } from './OrderLine';

// Chat Support > Corrections (owner 2026-10-11): every correction of the login's panels, for everyone with Open Chat
// Support, pending (oldest first, red once over a day) and done. Open chat / Open mail on each row; the Super Admin
// and the Manager get Mark done (with an optional note), Cancel, Reopen, and, when the row points at a chat still
// verified for that order, Edit address / Edit items = the SAME dialogs and PATCH routes the chat header uses
// (PATCH /api/chat/conversations/[id]/address and /items; ShipTrack only, never Shopify or the courier). A Mail-tab
// row with no chat has Open mail only: the order editors work through a chat (the Orders tab has none). Nothing
// here is sent to a customer. Reads GET /api/corrections every minute while visible.
type Tab = 'pending' | 'done';
interface Data { rows: CorrectionListRow[]; counts: CorrectionCounts }

export default function CorrectionsPanel({ token, user, businesses, onOpenChat, onAlert }: {
  token: string; user: AuthUser | null; businesses: Business[];
  onOpenChat: (conversationId: string) => void;
  onAlert: (type: 'success' | 'error', message: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('pending');
  const [panel, setPanel] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Mark done asks for a note first (one row at a time); every other action goes at once.
  const [doneFor, setDoneFor] = useState<{ id: string; note: string } | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ row: CorrectionListRow; kind: 'address' | 'items'; address: StaffAddress | null; items: StaffOrderItems | null; busy: boolean; error: string } | null>(null);
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const lead = isTeamLead(user);
  const canEditOrder = can(user, 'orders.update') && can(user, 'chat.view');
  const panels = businesses.filter((b) => !user?.businessIds || user.businessIds.includes(b.id));

  const load = useCallback(async (quiet = false) => {
    if (!token) return;
    if (!quiet) setBusy(true);
    try {
      const qs = new URLSearchParams({ status: tab });
      if (panel) qs.set('panel', panel);
      const res = await fetch(`/api/corrections?${qs}`, { headers: { Authorization: `Bearer ${token}`, ...activeHeaders() } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error || 'Could not read the corrections'); setData(null); return; }
      setData({ rows: j.rows || [], counts: j.counts || { pending: 0, overdue: 0, done_today: 0 } }); setErr('');
    } catch { setErr('Could not read the corrections'); }
    finally { setBusy(false); }
  }, [token, tab, panel]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (row: CorrectionListRow, action: CorrectionAction, note?: string) => {
    if (action === 'cancel' && !window.confirm(`Cancel this correction on order ${row.order_id}? It stays in Done as cancelled; nothing goes to the customer.`)) return;
    setActing(row.id);
    try {
      const res = await fetch(`/api/corrections/${row.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ action, note: note || undefined }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { onAlert('error', j.error || 'Could not change the correction'); return; }
      onAlert('success', action === 'done' ? `Marked done · order ${row.order_id}` : action === 'cancel' ? 'Correction cancelled' : 'Correction reopened');
      setDoneFor(null);
      void load(true);
    } catch { onAlert('error', 'Could not change the correction'); }
    finally { setActing(null); }
  };

  // Edit address / Edit items: the chat's own thread answer carries the order's address and lines and whether this
  // login may change them (the same GET the open chat uses), then the same dialogs and PATCH routes.
  const openEdit = async (row: CorrectionListRow, kind: 'address' | 'items') => {
    if (!row.conversation_id) return;
    setEdit({ row, kind, address: null, items: null, busy: true, error: '' });
    try {
      const res = await fetch(`/api/chat/conversations/${row.conversation_id}`, { headers: { Authorization: `Bearer ${token}`, ...activeHeaders() } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setEdit(null); onAlert('error', j.error || 'Could not open that chat'); return; }
      const address = kind === 'address' && j.address_editable ? (j.order_address as StaffAddress) : null;
      const items = kind === 'items' && j.items_editable ? (j.order_items as StaffOrderItems) : null;
      if (!address && !items) { setEdit(null); onAlert('error', kind === 'address' ? 'This order\'s address cannot be changed from here (open the chat).' : 'This order\'s items cannot be changed from here (open the chat).'); return; }
      setEdit({ row, kind, address, items, busy: false, error: '' });
    } catch { setEdit(null); onAlert('error', 'Could not open that chat'); }
  };
  const saveAddress = async (a: OrderAddress) => {
    if (!edit?.row.conversation_id) return;
    setEdit({ ...edit, busy: true, error: '' });
    try {
      const res = await fetch(`/api/chat/conversations/${edit.row.conversation_id}/address`, { method: 'PATCH', headers: auth, body: JSON.stringify(a) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setEdit({ ...edit, busy: false, error: j.error || 'Could not save the address' }); return; }
      setEdit(null); onAlert('success', j.unchanged ? 'Nothing changed' : `Address updated in ShipTrack · order ${edit.row.order_id}. Now mark the correction done.`);
    } catch { setEdit({ ...edit, busy: false, error: 'Could not save the address' }); }
  };
  const saveItems = async (items: { product_name: string; quantity: number; price: number | null }[]) => {
    if (!edit?.row.conversation_id) return;
    setEdit({ ...edit, busy: true, error: '' });
    try {
      const res = await fetch(`/api/chat/conversations/${edit.row.conversation_id}/items`, { method: 'PATCH', headers: auth, body: JSON.stringify({ items }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setEdit({ ...edit, busy: false, error: j.error || 'Could not save the items' }); return; }
      setEdit(null); onAlert('success', j.unchanged ? 'Nothing changed' : `Items updated in ShipTrack · order ${edit.row.order_id}. Now mark the correction done.`);
    } catch { setEdit({ ...edit, busy: false, error: 'Could not save the items' }); }
  };

  const who = (r: CorrectionListRow) => r.customer_name || r.customer_email || 'Customer';
  const c = data?.counts;
  return (
    <div className="tl-wrap corr-wrap">
      <div className="tl-head">
        <div>
          <div className="tl-title"><Wrench size={18} style={{ verticalAlign: '-3px' }} /> Corrections</div>
          <div className="meta">What customers asked to change on their orders. {lead ? 'You fix the order and mark it done.' : 'The Super Admin and the Manager fix the order and mark it done.'}{c ? ` · ${c.pending} pending${c.overdue ? `, ${c.overdue} over 24 h` : ''} · ${c.done_today} done today` : ''}</div>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => load()} disabled={busy}><RefreshCw size={14} /> Refresh</button>
      </div>
      <div className="corr-bar">
        <div className="seg">
          <button type="button" className="seg-btn" aria-pressed={tab === 'pending'} onClick={() => setTab('pending')}>Pending{c && c.pending > 0 ? ` (${c.pending})` : ''}</button>
          <button type="button" className="seg-btn" aria-pressed={tab === 'done'} onClick={() => setTab('done')}>Done</button>
        </div>
        {panels.length > 1 && (
          <select className="form-input corr-panel" value={panel} onChange={(e) => setPanel(e.target.value)} aria-label="Panel">
            <option value="">All panels</option>
            {panels.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
      </div>
      {err && <div className="chat-note" style={{ color: 'var(--danger)' }}>{err}</div>}
      {!data && !err && <div className="tl-empty"><Loader2 size={18} style={{ animation: 'spin 0.6s linear infinite' }} /></div>}
      {data && data.rows.length === 0 && <div className="tl-empty">{tab === 'pending' ? 'No correction is waiting.' : 'Nothing done yet.'}</div>}
      {data && data.rows.length > 0 && (
        <div className="corr-list">
          {data.rows.map((r) => (
            <div key={r.id} className={`corr-row${r.overdue ? ' corr-late' : ''}${r.status !== 'pending' ? ' corr-closed' : ''}`}>
              <div className="corr-top">
                {r.source === 'mail' || r.source === 'email' ? <Mail className="row-icon" aria-label="Email" /> : <MessageCircle className="row-icon" aria-label="Chat" />}
                <b className="truncate">{who(r)}</b>
                <span className="meta">· order {r.order_id}{panels.length > 1 && r.panel_name ? ` · ${r.panel_name}` : ''}</span>
                <span style={{ flex: 1 }} />
                {r.status === 'pending'
                  ? <Chip tone={r.overdue ? 'danger' : 'warn'} title={r.overdue ? 'Waiting over a day' : 'Waiting'}>{r.overdue ? `Waiting ${ageText(r.age_ms)}` : `Pending · ${ageText(r.age_ms)}`}</Chip>
                  : <Chip tone={r.status === 'done' ? 'ok' : 'muted'}>{r.status === 'done' ? 'Done' : 'Cancelled'}</Chip>}
              </div>
              <div className="corr-kinds-line">
                {r.kinds.map((k) => <Chip key={k} tone="info">{kindLabel(k)}</Chip>)}
                <span className="meta">by {r.created_by_name || 'team'} · {timeAgo(r.created_at)}</span>
              </div>
              <div className="corr-note">{r.note}</div>
              {r.status !== 'pending' && (
                <div className="meta">{r.status === 'done' ? 'Done' : 'Cancelled'}{r.done_by_name ? ` by ${r.done_by_name}` : ''}{r.done_at ? ` · ${timeAgo(r.done_at)}` : ''}{r.done_note ? ` · “${r.done_note}”` : ''}</div>
              )}
              <div className="corr-actions">
                {r.conversation_id && <button type="button" className="btn btn-outline btn-sm" onClick={() => onOpenChat(r.conversation_id as string)}><MessageCircle size={13} /> Open chat</button>}
                {r.mail_box_id && r.mail_uid && (
                  <a className="btn btn-outline btn-sm" href={`/admin?tab=mail&box=${encodeURIComponent(r.mail_box_id)}&uid=${r.mail_uid}`}><ExternalLink size={13} /> Open mail</a>
                )}
                {canEditOrder && r.status === 'pending' && r.conversation_id && r.chat_verified && (
                  <>
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => openEdit(r, 'address')} title="Change the delivery address in ShipTrack (not Shopify, not the courier)"><MapPin size={13} /> Edit address</button>
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => openEdit(r, 'items')} title="Change the order's items in ShipTrack (not Shopify, not the courier)"><Package size={13} /> Edit items</button>
                  </>
                )}
                {canEditOrder && r.status === 'pending' && !(r.conversation_id && r.chat_verified) && (
                  <span className="meta" title="The address and items are changed from the customer's verified chat; this correction has none (or that chat is verified for another order)">No chat to edit the order from</span>
                )}
                {lead && r.status === 'pending' && (
                  <>
                    <button type="button" className="btn btn-primary btn-sm" disabled={acting === r.id} onClick={() => setDoneFor(doneFor?.id === r.id ? null : { id: r.id, note: '' })}><Check size={13} /> Mark done</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={acting === r.id} onClick={() => act(r, 'cancel')}><X size={13} /> Cancel</button>
                  </>
                )}
                {lead && r.status !== 'pending' && (
                  <button type="button" className="btn btn-outline btn-sm" disabled={acting === r.id} onClick={() => act(r, 'reopen')}><RotateCcw size={13} /> Reopen</button>
                )}
              </div>
              {lead && doneFor?.id === r.id && (
                <form className="corr-done-form" onSubmit={(e) => { e.preventDefault(); void act(r, 'done', doneFor.note); }}>
                  <input className="form-input" value={doneFor.note} maxLength={DONE_NOTE_MAX} placeholder="Note (optional): what was changed" onChange={(e) => setDoneFor({ id: r.id, note: e.target.value })} autoFocus />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={acting === r.id}>{acting === r.id ? <Loader2 size={13} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Check size={13} />} Done</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDoneFor(null)}>Back</button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
      {edit && edit.busy && !edit.address && !edit.items && <div className="tl-empty"><Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} /> Opening the order…</div>}
      {edit && edit.kind === 'address' && edit.address && (
        <AddressDialog initial={edit.address} orderId={edit.address.order_id} busy={edit.busy} error={edit.error} onCancel={() => setEdit(null)} onSave={saveAddress} />
      )}
      {edit && edit.kind === 'items' && edit.items && (
        <ItemsDialog initial={edit.items.items} orderId={edit.items.order_id} busy={edit.busy} error={edit.error} onCancel={() => setEdit(null)} onSave={saveItems} />
      )}
    </div>
  );
}
