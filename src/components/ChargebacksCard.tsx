'use client';

// ── Chargebacks: the Super Admin's list of chargeback mails from every panel (owner 2026-10-08) ──
// Fed by the panels' chargeback Gmails (src/lib/chargeback/poll.ts). Opening an alert marks it seen; Done closes it
// (and takes the red Chargeback tag off that customer's chat). Super Admin only; every /api/chargebacks route
// checks again. The gateway mail's details stay in the Gmail itself; this shows who, what and which order.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ClipboardCopy, ExternalLink, Loader2, MessageCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { agoText } from '@/app/admin/_lib/format';
import RiskPanel from '@/components/chargeback/RiskPanel';
import StudyPanel from '@/components/chargeback/StudyPanel';
import ChargebackHistory from '@/components/chargeback/ChargebackHistory';

interface Alert {
  id: string; business_id: string; panel_name: string | null; received_at: string; from_address: string; from_name: string;
  subject: string; snippet: string; gateway: string; order_id: string | null; status: 'new' | 'seen' | 'done';
  seen_by_name: string | null; done_by_name: string | null; done_at: string | null; note: string | null; notify_status: string; chat_id: string | null;
  routed_by?: string | null; alt_panels?: { id: string; name: string }[]; kind?: 'chargeback' | 'other';
  // One card per case (owner 2026-10-15): the gateway's reminders of the same dispute are joined (src/lib/chargeback/cases.ts).
  mails?: number; mail_ids?: string[]; first_at?: string; done_mails?: number;
  gateway_elsewhere?: { id: string; name: string }[];
  gmail_panel?: string | null; gmail_panel_name?: string | null; digest?: boolean;
}
interface Counts { open: number; new: number; mails: number; panels?: { id: string; name: string; open: number }[] }
type View = 'open' | 'done' | 'other' | 'all';
const VIEWS: { key: View; label: string }[] = [{ key: 'open', label: 'Open' }, { key: 'done', label: 'Done' }, { key: 'other', label: 'Other mail' }, { key: 'all', label: 'All' }];

const notifyText = (s: string) => s === 'not_chargeback' ? 'Not a chargeback: nothing sent' : s === 'sent' ? 'WhatsApp sent' : s === 'delivered' ? 'WhatsApp delivered' : s === 'read' ? 'WhatsApp read' : s.startsWith('waiting') ? 'WhatsApp waiting: Meta paused the number for a few minutes (too many messages); it goes by itself' : s === 'no_number' ? 'No WhatsApp number' : s === 'not_configured' ? 'WhatsApp not set up' : s === 'pending' ? 'WhatsApp pending' : s.replace(/^failed: ?/, 'WhatsApp failed: ');

// Chargeback Shield (owner 2026-10-10): the tab opens on "Stop them" (the orders at risk now), then the chargebacks that
// came, then the study of all of them. Remembered in localStorage `cb_mode`.
type Mode = 'risk' | 'alerts' | 'study';
const MODES: { key: Mode; label: string }[] = [{ key: 'risk', label: 'Stop them (at risk)' }, { key: 'alerts', label: 'Chargebacks' }, { key: 'study', label: 'Study' }];
const readMode = (): Mode => { try { const m = localStorage.getItem('cb_mode'); return m === 'alerts' || m === 'study' ? m : 'risk'; } catch { return 'risk'; } };

export default function ChargebacksCard(props: { token: string; onAlert: (type: string, message: string) => void; onChanged?: () => void }) {
  const [mode, setModeState] = useState<Mode>('risk');
  useEffect(() => { setModeState(readMode()); }, []);
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem('cb_mode', m); } catch { /* private window */ } };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <ShieldAlert size={20} style={{ color: 'var(--danger)' }} />
        <h2 style={{ fontSize: '1.125rem', fontWeight: 700, margin: 0, flex: 1 }}>Chargeback Shield</h2>
        {MODES.map(m => <button key={m.key} type="button" className="seg-btn" aria-pressed={mode === m.key} onClick={() => setMode(m.key)}>{m.label}</button>)}
      </div>
      {mode === 'risk' && <RiskPanel token={props.token} onAlert={props.onAlert} />}
      {mode === 'study' && <StudyPanel token={props.token} onAlert={props.onAlert} />}
      {mode === 'alerts' && <AlertsPanel {...props} />}
    </div>
  );
}

function AlertsPanel({ token, onAlert, onChanged }: { token: string; onAlert: (type: string, message: string) => void; onChanged?: () => void }) {
  const [view, setView] = useState<View>('open');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [installed, setInstalled] = useState(true);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/chargebacks?view=${view}`, { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not read the chargebacks.'); return; }
      setAlerts(j.alerts || []); setInstalled(j.installed !== false); setCounts(j.counts || null);
    } catch { onAlert('error', 'Could not read the chargebacks.'); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);
  useEffect(() => { void load(); }, [load]);

  // Every mail of the case at once (the first notice and its reminders).
  const patch = async (a: Alert, status: 'seen' | 'done', n?: string) => {
    try {
      const r = await fetch('/api/chargebacks', { method: 'PATCH', headers: auth, body: JSON.stringify({ id: a.id, ids: a.mail_ids, status, note: n }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); onAlert('error', j.error || 'Could not save that.'); return; }
      onChanged?.();
      await load();
    } catch { onAlert('error', 'Could not save that.'); }
  };
  // Two panels share one chargeback Gmail and the mail could not be told apart: the Super Admin moves it by hand.
  const move = async (a: Alert, businessId: string) => {
    try {
      const r = await fetch('/api/chargebacks', { method: 'PATCH', headers: auth, body: JSON.stringify({ id: a.id, ids: a.mail_ids, businessId }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); onAlert('error', j.error || 'Could not move it.'); return; }
      onAlert('success', 'Moved.'); onChanged?.(); await load();
    } catch { onAlert('error', 'Could not move it.'); }
  };
  // The mail named no order of ours (owner 2026-10-11): type it, and it is checked against the alert's panel.
  const [linkNo, setLinkNo] = useState('');
  const link = async (a: Alert) => {
    try {
      const r = await fetch('/api/chargebacks', { method: 'PATCH', headers: auth, body: JSON.stringify({ id: a.id, orderId: linkNo }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not link it.'); return; }
      onAlert('success', `Linked to order ${j.orderId}.`); setLinkNo(''); onChanged?.(); await load();
    } catch { onAlert('error', 'Could not link it.'); }
  };
  // "Copy all for Claude" (owner 2026-10-13): every real chargeback of the last 120 days with its order's chats, Gmail
  // and WhatsApp, masked, to paste into Claude.
  const [copyingAll, setCopyingAll] = useState(false);
  const copyAll = async () => {
    setCopyingAll(true);
    try {
      const r = await fetch('/api/chargebacks/history?all=1', { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not read the chargebacks.'); return; }
      await navigator.clipboard.writeText(j.text || '');
      onAlert('success', `Copied ${j.count} chargeback(s) with their chats, Gmail and WhatsApp (names, phones, emails and links hidden). Paste it to Claude.`);
    } catch { onAlert('error', 'Could not copy: the browser did not allow it.'); }
    finally { setCopyingAll(false); }
  };
  const toggle = (a: Alert) => {
    const next = openId === a.id ? null : a.id;
    setOpenId(next); setNote(''); setLinkNo('');
    if (next && a.status === 'new') void patch(a, 'seen');
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-outline btn-sm" onClick={copyAll} disabled={copyingAll} title="Every chargeback of the last 120 days with the order's chats, Gmail and WhatsApp, as text with names, phones, emails and links hidden">{copyingAll ? <Loader2 size={14} className="spin" /> : <ClipboardCopy size={14} />} Copy all for Claude</button>
        {VIEWS.map(v => <button key={v.key} type="button" className="seg-btn" aria-pressed={view === v.key} onClick={() => setView(v.key)}>{v.label}</button>)}
        <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading}>{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh</button>
      </div>
      {!installed && <div className="mail-warn" style={{ margin: 0 }}>Not installed yet: run chargeback.sql on the server first.</div>}
      {installed && counts && (
        <div className="tf-card" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem 1rem', flexWrap: 'wrap', padding: '0.625rem 1rem', marginBottom: '0.75rem', borderColor: counts.open > 0 ? 'var(--danger)' : undefined }}>
          <b style={{ fontSize: '1rem', color: counts.open > 0 ? 'var(--danger)' : undefined }}>{counts.open > 0 ? `${counts.open} chargeback${counts.open === 1 ? '' : 's'} pending` : 'No chargeback pending'}</b>
          {counts.open > 0 && <span className="meta">{counts.new > 0 ? `${counts.new} not opened yet · ` : ''}{counts.mails} mail{counts.mails === 1 ? '' : 's'} from the gateways (reminders of one case are counted once)</span>}
          {(counts.panels?.length ?? 0) > 1 && <span style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>{counts.panels!.map(p => <span key={p.id} className="chip chip-muted">{p.name} {p.open}</span>)}</span>}
        </div>
      )}
      {installed && view === 'other' && (
        <div className="meta" style={{ marginBottom: '0.5rem' }}>The gateway’s other mail in the same Gmail (payment received, settlement, OTP): by its words it is not a chargeback, so it is not counted, nobody is messaged and no chat is tagged. Look here only if a real chargeback seems to be missing.</div>
      )}
      {installed && !loading && alerts.length === 0 && (
        <div className="mail-empty">{view === 'open' ? 'No open chargeback. Connect each panel’s chargeback Gmail in Settings → Chargeback protection.' : 'Nothing here.'}</div>
      )}
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {alerts.map(a => (
          <div key={a.id} className="tf-card" style={{ padding: 0, borderColor: a.status === 'new' && a.kind !== 'other' ? 'var(--danger)' : undefined, opacity: a.kind === 'other' ? 0.8 : 1 }}>
            <button type="button" onClick={() => toggle(a)} style={{ all: 'unset', cursor: 'pointer', display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.25rem 0.75rem', padding: '0.75rem 1rem', width: '100%', boxSizing: 'border-box' }}>
              <span style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {a.kind === 'other' && <span className="chip chip-muted" title="By its words this is not a chargeback mail">Other mail</span>}
                {a.status === 'new' && a.kind !== 'other' && <span className="chip chip-danger">New</span>}
                {a.status === 'done' && <span className="chip chip-muted">Done</span>}
                <b style={{ fontSize: '0.875rem' }}>{a.panel_name || 'Panel'}</b>
                <span className="chip chip-muted">{a.gateway}</span>
                {a.digest && <span className="chip chip-muted" title={`${a.gateway}'s daily list of open chargeback cases: every day's list is in this one card (the newest on top).`}>Daily list</span>}
                {a.gmail_panel_name && <span className="chip chip-muted" title={`This mail came into ${a.gmail_panel_name}'s chargeback Gmail, but ${a.gateway} is ticked for ${a.panel_name || 'this panel'} only, so it is shown here.`}>Came into {a.gmail_panel_name}&apos;s Gmail</span>}
                {(a.mails ?? 1) > 1 && <span className="chip chip-danger" title={`The gateway sent this case ${a.mails} times (the first notice and its reminders). One card, one Mark done.`}>{a.mails} mails</span>}
                {(a.gateway_elsewhere?.length ?? 0) > 0 && <span className="chip chip-warn" title={`${a.gateway} is not ticked for ${a.panel_name || 'this panel'} in Settings > Chargeback protection, but it is for ${a.gateway_elsewhere!.map(p => p.name).join(', ')}.`}>{a.gateway} not on this panel</span>}
                {a.routed_by === 'unsure' && <span className="chip chip-warn" title="Two panels share this Gmail and the mail names no order and no ticked gateway of either. Move it to the right panel.">Panel unsure</span>}
                {a.order_id ? <span className="chip chip-primary">Order {a.order_id}</span> : <span className="chip chip-warn" title="No order number of this panel was found in the mail">Order not found</span>}
              </span>
              <span className="meta">{agoText(Date.parse(a.received_at))} <ChevronDown size={12} style={{ verticalAlign: '-2px' }} /></span>
              <span style={{ fontSize: '0.8125rem', fontWeight: a.status === 'new' && a.kind !== 'other' ? 700 : 500, gridColumn: '1 / -1', wordBreak: 'break-word' }}>{a.subject}</span>
            </button>
            {openId === a.id && (
              <div style={{ padding: '0 1rem 0.875rem', display: 'grid', gap: '0.5rem' }}>
                <div className="meta">From {a.from_name ? `${a.from_name} <${a.from_address}>` : a.from_address} · {notifyText(a.notify_status)}</div>
                <div style={{ fontSize: '0.8125rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--muted)', borderRadius: '0.5rem', padding: '0.625rem' }}>{a.snippet || '(no text)'}</div>
                <div className="meta">The full mail, with the gateway&apos;s deadline and evidence steps, is in that panel&apos;s chargeback Gmail.</div>
                {(a.mails ?? 1) > 1 && (
                  <div className="meta">Same case, {a.mails} mails: the first came {agoText(Date.parse(a.first_at || a.received_at))}, the newest {agoText(Date.parse(a.received_at))}.{(a.done_mails ?? 0) > 0 && a.status !== 'done' ? ` ${a.done_mails} of them were marked done earlier; a new reminder came after that, so it is open again.` : ''}</div>
                )}
                {(a.gateway_elsewhere?.length ?? 0) > 0 && (
                  <div className="mail-warn" style={{ margin: 0 }}>
                    This mail is from {a.gateway}, but {a.panel_name || 'this panel'} ticks other gateways and {a.gateway_elsewhere!.map(p => p.name).join(', ')} uses {a.gateway}. It came into {a.panel_name || 'this panel'}&apos;s chargeback Gmail, so that Gmail is set as the dispute email in a {a.gateway} account. Check which brand that {a.gateway} account (merchant name / MID in the mail) belongs to; if it is {a.gateway_elsewhere!.map(p => p.name).join(' / ')}, move it with &quot;Move to panel…&quot;{a.alt_panels?.length ? '' : ' (the Super Admin can)'}.
                  </div>
                )}
                {!a.order_id && a.kind !== 'other' && (
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="meta">The mail names no order of this panel. Find it in the gateway (by the amount / date / customer) and link it:</span>
                    <input className="form-input" style={{ width: 140, height: '2rem' }} placeholder="Order no., e.g. 1553" value={linkNo} onChange={e => setLinkNo(e.target.value)} inputMode="numeric" />
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => void link(a)} disabled={!linkNo.trim()}>Link order</button>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  {(a.alt_panels?.length ?? 0) > 0 && a.status !== 'done' && (
                    <select className="form-input" style={{ height: '2rem', width: 'auto' }} value="" onChange={e => { if (e.target.value) void move(a, e.target.value); }} aria-label="Move to another panel">
                      <option value="">Move to panel…</option>
                      {a.alt_panels!.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                  {a.chat_id && <a className="btn btn-outline btn-sm" href={`/admin/chat?open=${encodeURIComponent(a.chat_id)}`}><MessageCircle size={13} /> Open chat</a>}
                  <a className="btn btn-outline btn-sm" href="https://mail.google.com/" target="_blank" rel="noopener noreferrer"><ExternalLink size={13} /> Open Gmail</a>
                  {a.status !== 'done' && (
                    <>
                      <input className="form-input" style={{ flex: 1, minWidth: 160, height: '2rem' }} placeholder="Note (optional): what was done" value={note} onChange={e => setNote(e.target.value)} maxLength={500} />
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => patch(a, 'done', note)}>{(a.mails ?? 1) > 1 ? `Mark done (all ${a.mails} mails)` : 'Mark done'}</button>
                    </>
                  )}
                  {a.status === 'done' && <span className="meta">Done by {a.done_by_name}{a.note ? ` · ${a.note}` : ''}</span>}
                </div>
                {a.kind !== 'other' && <ChargebackHistory key={`${a.id}|${a.order_id || ''}`} token={token} alertId={a.id} onAlert={onAlert} onLinked={() => { onChanged?.(); void load(); }} />}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
