'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, Loader2, Mail, MapPin, MessageCircle, Package, RefreshCw, RotateCcw, Wrench, X } from 'lucide-react';
import { can, isTeamLead } from '@/lib/permissions';
import { activeHeaders } from '@/lib/presence-client';
import { DONE_NOTE_MAX, ageText, changedLine, kindLabel, type CorrectionAction, type CorrectionCounts } from '@/lib/chat/corrections-rules';
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
// Owner 2026-10-12 ("kuch bhi changes ke baad ... replied aur active jaisa segment"): three segments like the Mail
// tab's cases: Active (nothing changed on the order yet, oldest first, red after a day), Changed (the address or the
// items were edited after the correction was written: it moves there by itself and waits for Mark done), Done
// (done + cancelled). The segment is remembered (localStorage corr_tab).
type Tab = 'active' | 'changed' | 'done';
const TAB_KEY = 'corr_tab';
const savedTab = (): Tab => { try { const v = localStorage.getItem(TAB_KEY); return v === 'changed' || v === 'done' ? v : 'active'; } catch { return 'active'; } };
interface Data { rows: CorrectionListRow[]; counts: CorrectionCounts }

export default function CorrectionsPanel({ token, user, businesses, onOpenChat, onAlert }: {
  token: string; user: AuthUser | null; businesses: Business[];
  onOpenChat: (conversationId: string) => void;
  onAlert: (type: 'success' | 'error', message: string) => void;
}) {
  const [tab, setTabState] = useState<Tab>('active');
  useEffect(() => { setTabState(savedTab()); }, []);
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* private window */ } };
  const [panel, setPanel] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Mark done asks for a note first (one row at a time); every other action goes at once.
  const [doneFor, setDoneFor] = useState<{ id: string; note: string } | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  // chatId: the verified chat the edit goes through (the row's own, or one /api/corrections/:id/chat found or made)
  const [edit, setEdit] = useState<{ row: CorrectionListRow; chatId: string; kind: 'address' | 'items'; address: StaffAddress | null; items: StaffOrderItems | null; busy: boolean; error: string } | null>(null);
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
  // A row with no verified chat for its order (a Mail correction, owner 2026-10-13) first asks the server for one:
  // the customer's email chat, found or made and verified for that order (POST /api/corrections/:id/chat).
  const openEdit = async (row: CorrectionListRow, kind: 'address' | 'items') => {
    setEdit({ row, chatId: '', kind, address: null, items: null, busy: true, error: '' });
    try {
      let chatId = row.conversation_id && row.chat_verified ? row.conversation_id : '';
      if (!chatId) {
        const c = await fetch(`/api/corrections/${row.id}/chat`, { method: 'POST', headers: auth });
        const cj = await c.json().catch(() => ({}));
        if (!c.ok || !cj.chatId) { setEdit(null); onAlert('error', cj.error || 'Could not open the order for editing'); return; }
        chatId = String(cj.chatId);
      }
      const res = await fetch(`/api/chat/conversations/${chatId}`, { headers: { Authorization: `Bearer ${token}`, ...activeHeaders() } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setEdit(null); onAlert('error', j.error || 'Could not open that chat'); return; }
      const address = kind === 'address' && j.address_editable ? (j.order_address as StaffAddress) : null;
      const items = kind === 'items' && j.items_editable ? (j.order_items as StaffOrderItems) : null;
      if (!address && !items) { setEdit(null); onAlert('error', kind === 'address' ? 'This order\'s address cannot be changed from here (open the chat).' : 'This order\'s items cannot be changed from here (open the chat).'); return; }
      setEdit({ row, chatId, kind, address, items, busy: false, error: '' });
    } catch { setEdit(null); onAlert('error', 'Could not open that chat'); }
  };
  const saveAddress = async (a: OrderAddress) => {
    if (!edit?.chatId) return;
    setEdit({ ...edit, busy: true, error: '' });
    try {
      const res = await fetch(`/api/chat/conversations/${edit.chatId}/address`, { method: 'PATCH', headers: auth, body: JSON.stringify(a) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setEdit({ ...edit, busy: false, error: j.error || 'Could not save the address' }); return; }
      setEdit(null); onAlert('success', j.unchanged ? 'Nothing changed' : `Address / phone updated in ShipTrack · order ${edit.row.order_id}. It is in Changed now: check it and mark it done.`);
      void load(true);
    } catch { setEdit({ ...edit, busy: false, error: 'Could not save the address' }); }
  };
  const saveItems = async (items: { product_name: string; quantity: number; price: number | null }[]) => {
    if (!edit?.chatId) return;
    setEdit({ ...edit, busy: true, error: '' });
    try {
      const res = await fetch(`/api/chat/conversations/${edit.chatId}/items`, { method: 'PATCH', headers: auth, body: JSON.stringify({ items }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setEdit({ ...edit, busy: false, error: j.error || 'Could not save the items' }); return; }
      setEdit(null); onAlert('success', j.unchanged ? 'Nothing changed' : `Items updated in ShipTrack · order ${edit.row.order_id}. It is in Changed now: check it and mark it done.`);
      void load(true);
    } catch { setEdit({ ...edit, busy: false, error: 'Could not save the items' }); }
  };

  const who = (r: CorrectionListRow) => r.customer_name || r.customer_email || 'Customer';
  const c = data?.counts;
  return (
    <div className="tl-wrap corr-wrap">
      <div className="tl-head">
        <div>
          <div className="tl-title"><Wrench size={18} style={{ verticalAlign: '-3px' }} /> Corrections</div>
          <div className="meta">What customers asked to change on their orders. {lead ? 'You fix the order and mark it done.' : 'The Super Admin and the Manager fix the order and mark it done.'}{c ? ` · ${c.active ?? c.pending} active${c.overdue ? `, ${c.overdue} over 24 h` : ''}${c.changed ? ` · ${c.changed} changed, to mark done` : ''} · ${c.done_today} done today` : ''}</div>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => load()} disabled={busy}><RefreshCw size={14} /> Refresh</button>
      </div>
      <div className="corr-bar">
        <div className="seg">
          <button type="button" className="seg-btn" aria-pressed={tab === 'active'} onClick={() => setTab('active')} title="Nothing changed on the order yet">Active{c && (c.active ?? c.pending) > 0 ? ` (${c.active ?? c.pending})` : ''}</button>
          <button type="button" className="seg-btn" aria-pressed={tab === 'changed'} onClick={() => setTab('changed')} title="The address or items were changed after the request: check and mark done">Changed{c && (c.changed ?? 0) > 0 ? ` (${c.changed})` : ''}</button>
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
      {data && data.rows.length === 0 && <div className="tl-empty">{tab === 'active' ? 'No correction is waiting.' : tab === 'changed' ? 'Nothing changed and waiting for Mark done.' : 'Nothing done yet.'}</div>}
      {data && data.rows.length > 0 && (
        <div className="corr-list">
          {data.rows.map((r) => (
            <div key={r.id} className={`corr-row${r.overdue ? ' corr-late' : ''}${r.status !== 'pending' ? ' corr-closed' : ''}`}>
              <div className="corr-top">
                {r.source === 'mail' || r.source === 'email' ? <Mail className="row-icon" aria-label="Email" /> : <MessageCircle className="row-icon" aria-label="Chat" />}
                <b className="truncate">{who(r)}</b>
                <span className="meta">· order {r.order_id}{panels.length > 1 && r.panel_name ? ` · ${r.panel_name}` : ''}</span>
                <span style={{ flex: 1 }} />
                {r.status === 'pending' && r.segment === 'changed'
                  ? <Chip tone="ok" title="The order was changed after this request: check it and mark it done">Changed</Chip>
                  : r.status === 'pending'
                  ? <Chip tone={r.overdue ? 'danger' : 'warn'} title={r.overdue ? 'Waiting over a day' : 'Waiting'}>{r.overdue ? `Waiting ${ageText(r.age_ms)}` : `Pending · ${ageText(r.age_ms)}`}</Chip>
                  : <Chip tone={r.status === 'done' ? 'ok' : 'muted'}>{r.status === 'done' ? 'Done' : 'Cancelled'}</Chip>}
              </div>
              <div className="corr-kinds-line">
                {r.kinds.map((k) => <Chip key={k} tone="info">{kindLabel(k)}</Chip>)}
                <span className="meta">by {r.created_by_name || 'team'} · {timeAgo(r.created_at)}</span>
              </div>
              <div className="corr-note">{r.note}</div>
              {r.status === 'pending' && r.segment === 'changed' && <div className="corr-changed">{changedLine(r)}</div>}
              {r.status !== 'pending' && (
                <div className="meta">{r.status === 'done' ? 'Done' : 'Cancelled'}{r.done_by_name ? ` by ${r.done_by_name}` : ''}{r.done_at ? ` · ${timeAgo(r.done_at)}` : ''}{r.done_note ? ` · “${r.done_note}”` : ''}</div>
              )}
              <div className="corr-actions">
                {r.conversation_id && <button type="button" className="btn btn-outline btn-sm" onClick={() => onOpenChat(r.conversation_id as string)}><MessageCircle size={13} /> Open chat</button>}
                {r.mail_box_id && r.mail_uid && (
                  <a className="btn btn-outline btn-sm" href={`/admin?tab=mail&box=${encodeURIComponent(r.mail_box_id)}&uid=${r.mail_uid}`}><ExternalLink size={13} /> Open mail</a>
                )}
                {/* Every pending row (owner 2026-10-13: a Mail correction had no chat to edit from): a row without a
                    verified chat gets one on the click (openEdit). */}
                {canEditOrder && r.status === 'pending' && (
                  <>
                    <button type="button" className="btn btn-outline btn-sm" disabled={!!edit?.busy} onClick={() => openEdit(r, 'address')} title="Change the delivery address or the phone in ShipTrack (not Shopify, not the courier)"><MapPin size={13} /> Edit address / phone</button>
                    <button type="button" className="btn btn-outline btn-sm" disabled={!!edit?.busy} onClick={() => openEdit(r, 'items')} title="Change the order's items in ShipTrack (not Shopify, not the courier)"><Package size={13} /> Edit items</button>
                  </>
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
