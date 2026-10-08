'use client';

// ── Chargebacks: the Super Admin's list of chargeback mails from every panel (owner 2026-10-08) ──
// Fed by the panels' chargeback Gmails (src/lib/chargeback/poll.ts). Opening an alert marks it seen; Done closes it
// (and takes the red Chargeback tag off that customer's chat). Super Admin only; every /api/chargebacks route
// checks again. The gateway mail's details stay in the Gmail itself; this shows who, what and which order.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ExternalLink, Loader2, MessageCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { agoText } from '@/app/admin/_lib/format';

interface Alert {
  id: string; business_id: string; panel_name: string | null; received_at: string; from_address: string; from_name: string;
  subject: string; snippet: string; gateway: string; order_id: string | null; status: 'new' | 'seen' | 'done';
  seen_by_name: string | null; done_by_name: string | null; done_at: string | null; note: string | null; notify_status: string; chat_id: string | null;
  routed_by?: string | null; alt_panels?: { id: string; name: string }[];
}

const notifyText = (s: string) => s === 'sent' ? 'WhatsApp sent' : s === 'no_number' ? 'No WhatsApp number' : s === 'not_configured' ? 'WhatsApp not set up' : s === 'pending' ? 'WhatsApp pending' : s.replace(/^failed: ?/, 'WhatsApp failed: ');

export default function ChargebacksCard({ token, onAlert, onChanged }: { token: string; onAlert: (type: string, message: string) => void; onChanged?: () => void }) {
  const [view, setView] = useState<'open' | 'done' | 'all'>('open');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [installed, setInstalled] = useState(true);
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
      setAlerts(j.alerts || []); setInstalled(j.installed !== false);
    } catch { onAlert('error', 'Could not read the chargebacks.'); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);
  useEffect(() => { void load(); }, [load]);

  const patch = async (id: string, status: 'seen' | 'done', n?: string) => {
    try {
      const r = await fetch('/api/chargebacks', { method: 'PATCH', headers: auth, body: JSON.stringify({ id, status, note: n }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); onAlert('error', j.error || 'Could not save that.'); return; }
      onChanged?.();
      await load();
    } catch { onAlert('error', 'Could not save that.'); }
  };
  // Two panels share one chargeback Gmail and the mail could not be told apart: the Super Admin moves it by hand.
  const move = async (a: Alert, businessId: string) => {
    try {
      const r = await fetch('/api/chargebacks', { method: 'PATCH', headers: auth, body: JSON.stringify({ id: a.id, businessId }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); onAlert('error', j.error || 'Could not move it.'); return; }
      onAlert('success', 'Moved.'); onChanged?.(); await load();
    } catch { onAlert('error', 'Could not move it.'); }
  };
  const toggle = (a: Alert) => {
    const next = openId === a.id ? null : a.id;
    setOpenId(next); setNote('');
    if (next && a.status === 'new') void patch(a.id, 'seen');
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <ShieldAlert size={20} style={{ color: 'var(--danger)' }} />
        <h2 style={{ fontSize: '1.125rem', fontWeight: 700, margin: 0, flex: 1 }}>Chargebacks</h2>
        {(['open', 'done', 'all'] as const).map(v => <button key={v} type="button" className="seg-btn" aria-pressed={view === v} onClick={() => setView(v)}>{v === 'open' ? 'Open' : v === 'done' ? 'Done' : 'All'}</button>)}
        <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading}>{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh</button>
      </div>
      {!installed && <div className="mail-warn" style={{ margin: 0 }}>Not installed yet: run chargeback.sql on the server first.</div>}
      {installed && !loading && alerts.length === 0 && (
        <div className="mail-empty">{view === 'open' ? 'No open chargeback. Connect each panel’s chargeback Gmail in Settings → Chargeback protection.' : 'Nothing here.'}</div>
      )}
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {alerts.map(a => (
          <div key={a.id} className="tf-card" style={{ padding: 0, borderColor: a.status === 'new' ? 'var(--danger)' : undefined }}>
            <button type="button" onClick={() => toggle(a)} style={{ all: 'unset', cursor: 'pointer', display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.25rem 0.75rem', padding: '0.75rem 1rem', width: '100%', boxSizing: 'border-box' }}>
              <span style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {a.status === 'new' && <span className="chip chip-danger">New</span>}
                {a.status === 'done' && <span className="chip chip-muted">Done</span>}
                <b style={{ fontSize: '0.875rem' }}>{a.panel_name || 'Panel'}</b>
                <span className="chip chip-muted">{a.gateway}</span>
                {a.routed_by === 'unsure' && <span className="chip chip-warn" title="Two panels share this Gmail and the mail names no order and no ticked gateway of either. Move it to the right panel.">Panel unsure</span>}
                {a.order_id ? <span className="chip chip-primary">Order {a.order_id}</span> : <span className="chip chip-warn" title="No order number of this panel was found in the mail">Order not found</span>}
              </span>
              <span className="meta">{agoText(Date.parse(a.received_at))} <ChevronDown size={12} style={{ verticalAlign: '-2px' }} /></span>
              <span style={{ fontSize: '0.8125rem', fontWeight: a.status === 'new' ? 700 : 500, gridColumn: '1 / -1', wordBreak: 'break-word' }}>{a.subject}</span>
            </button>
            {openId === a.id && (
              <div style={{ padding: '0 1rem 0.875rem', display: 'grid', gap: '0.5rem' }}>
                <div className="meta">From {a.from_name ? `${a.from_name} <${a.from_address}>` : a.from_address} · {notifyText(a.notify_status)}</div>
                <div style={{ fontSize: '0.8125rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--muted)', borderRadius: '0.5rem', padding: '0.625rem' }}>{a.snippet || '(no text)'}</div>
                <div className="meta">The full mail, with the gateway&apos;s deadline and evidence steps, is in that panel&apos;s chargeback Gmail.</div>
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
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => patch(a.id, 'done', note)}>Mark done</button>
                    </>
                  )}
                  {a.status === 'done' && <span className="meta">Done by {a.done_by_name}{a.note ? ` · ${a.note}` : ''}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
