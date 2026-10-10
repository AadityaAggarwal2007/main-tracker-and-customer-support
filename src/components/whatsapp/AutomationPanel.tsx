'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Power, RefreshCw } from 'lucide-react';
import { SECTION, spin, type Alert, type AutoOverview } from './types';

// WhatsApp > Automation (owner 2026-10-10: "har naye order par apne aap message chala jaye, on/off ka button, kitne
// bheje kitne fail"). The order-placed message at once and the tracking link 48 hours later, per panel, default OFF.
const COLS: { key: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'; label: string; tone: string }[] = [
  { key: 'pending', label: 'Waiting', tone: 'chip-warn' }, { key: 'sent', label: 'Sent', tone: 'chip-ok' }, { key: 'delivered', label: 'Delivered', tone: 'chip-ok' },
  { key: 'read', label: 'Read', tone: 'chip-ok' }, { key: 'failed', label: 'Failed', tone: 'chip-danger' }, { key: 'skipped', label: 'Skipped', tone: 'chip-warn' },
];
const STATUS_TONE: Record<string, string> = { pending: 'chip-warn', sent: 'chip-ok', delivered: 'chip-ok', read: 'chip-ok', failed: 'chip-danger', skipped: 'chip-warn' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—');
const tplTone = (s: string) => (s === 'APPROVED' ? 'chip-ok' : s === 'PENDING' ? 'chip-warn' : 'chip-danger');

export default function AutomationPanel({ token, onAlert }: { token: string; onAlert: Alert }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [o, setO] = useState<AutoOverview | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(async (fresh = false) => {
    try {
      const r = await fetch(`/api/whatsapp/automation${fresh ? '?fresh=1' : ''}`, { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (r.ok && j) setO(j); else if (j?.error) onAlert('error', j.error);
    } catch { /* offline: the next refresh tries again */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => {
    void load(true);
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async (id: string, name: string, enabled: boolean) => {
    if (enabled && !window.confirm(`Turn the automation ON for "${name}"?\n\nFrom now every NEW order of ${name} gets the "order placed" WhatsApp message by itself, and the tracking link 48 hours later. Old orders are never messaged.`)) return;
    if (!enabled && !window.confirm(`Turn the automation OFF for "${name}"? New orders get no message until you turn it on again.`)) return;
    setBusy(id);
    try {
      const r = await fetch('/api/whatsapp/automation', { method: 'POST', headers: auth, body: JSON.stringify({ businessId: id, enabled }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not change it'); return; }
      onAlert('success', enabled ? `${name}: automation is ON` : `${name}: automation is OFF`);
      await load();
    } finally { setBusy(''); }
  };
  const retry = async (id: string) => {
    setBusy('r' + id);
    try {
      const r = await fetch('/api/whatsapp/automation', { method: 'POST', headers: auth, body: JSON.stringify({ action: 'retry', id }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not send it again'); return; }
      onAlert('success', 'Queued: it goes out within a minute'); await load();
    } finally { setBusy(''); }
  };

  if (!o) return <div className="tf-card" style={{ padding: '1.25rem' }}><Loader2 size={16} style={spin} /> Loading…</div>;
  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={SECTION}>Automation</span>
          <button type="button" className="btn btn-sm btn-outline" style={{ marginLeft: 'auto', gap: 4 }} onClick={() => void load(true)}><RefreshCw size={13} /> Refresh</button>
        </div>
        <p style={{ fontSize: '0.8125rem', margin: 0, color: 'var(--fg-muted)' }}>
          When it is ON for a panel, every new order of that panel (Shopify or CSV) gets the <strong>order placed</strong> message on the customer&apos;s WhatsApp number by itself, with the order id, the brand and its support email. 48 hours later the customer gets the <strong>tracking link</strong>, only while the office is open (10 AM to 7:30 PM, Saturday till 2 PM): a 48th hour at night, on a Sunday or a holiday goes out when the office opens next. Old orders (an old CSV, anything placed before you switched it on or more than 24 hours back) are never messaged, and nobody gets the same message twice.
        </p>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.8125rem', alignItems: 'center' }}>
          <span>Template <code>order_placed</code>: <span className={`chip ${tplTone(o.templates.placed)}`}>{o.templates.placed}</span></span>
          <span>Template <code>order_tracking</code>: <span className={`chip ${tplTone(o.templates.tracking)}`}>{o.templates.tracking}</span></span>
          {o.templates.error && <span style={{ color: 'var(--danger, #b91c1c)' }}>Could not read templates: {o.templates.error}</span>}
        </div>
        {(o.templates.placed === 'MISSING' || o.templates.tracking === 'MISSING') && (
          <div className="meta" style={{ fontSize: '0.78rem' }}>Make the missing one in Templates (the buttons &quot;Order placed template&quot; and &quot;Tracking link template&quot; fill it), send it to Meta, and come back when it says APPROVED.</div>
        )}
        {!o.installed && <div style={{ padding: '0.6rem 0.75rem', borderRadius: 8, background: 'var(--warn-bg, #fef3c7)', fontSize: '0.8125rem' }}>Not installed yet: the database file <code>whatsapp-automation.sql</code> has to be run on the server once. Until then nothing can be switched on.</div>}
        {!o.configured && <div style={{ padding: '0.6rem 0.75rem', borderRadius: 8, background: 'var(--warn-bg, #fef3c7)', fontSize: '0.8125rem' }}>WhatsApp is not set up on the server (token / phone number id).</div>}
      </div>

      {o.panels.map((p) => (
        <div key={p.id} className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '1rem' }}>{p.name}</strong>
            <span className={`chip ${p.enabled ? 'chip-ok' : 'chip-warn'}`}>{p.enabled ? 'ON' : 'OFF'}</span>
            {p.replied > 0 && <span className="chip chip-ok" title="Customers who wrote back after one of these messages">{p.replied} replied</span>}
            {p.enabled && p.since && <span className="meta" style={{ fontSize: '0.75rem' }}>messaging orders placed since {when(p.since)}</span>}
            <button type="button" className={`btn btn-sm ${p.enabled ? 'btn-outline' : 'btn-primary'}`} style={{ marginLeft: 'auto', gap: 4 }} disabled={busy === p.id || (!p.enabled && !o.installed)} onClick={() => void toggle(p.id, p.name, !p.enabled)}>
              {busy === p.id ? <Loader2 size={13} style={spin} /> : <Power size={13} />} {p.enabled ? 'Turn OFF' : 'Turn ON'}
            </button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
              <thead><tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}><th style={{ padding: '4px 6px' }}>Message</th>{COLS.map((c) => <th key={c.key} style={{ padding: '4px 6px' }}>{c.label}</th>)}</tr></thead>
              <tbody>
                {([['Order placed', p.placed, p.placed24], ['Tracking link (48 h)', p.tracking, p.tracking24]] as const).map(([name, all, d24]) => (
                  <tr key={name} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px', fontWeight: 600 }}>{name}</td>
                    {COLS.map((c) => <td key={c.key} style={{ padding: '6px' }}><strong>{all[c.key]}</strong> <span className="meta" style={{ fontSize: '0.7rem' }}>({d24[c.key]} today)</span></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: 8 }}>
        <span style={SECTION}>Latest messages</span>
        {o.recent.length === 0 && <div className="meta" style={{ fontSize: '0.8125rem' }}>Nothing yet. Once a panel is ON, every order and its messages are listed here.</div>}
        <div style={{ overflowX: 'auto' }}>
          {o.recent.length > 0 && (
            <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
              <thead><tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}><th style={{ padding: '4px 6px' }}>Panel</th><th style={{ padding: '4px 6px' }}>Order</th><th style={{ padding: '4px 6px' }}>Message</th><th style={{ padding: '4px 6px' }}>Status</th><th style={{ padding: '4px 6px' }}>Number</th><th style={{ padding: '4px 6px' }}>When</th><th style={{ padding: '4px 6px' }}>Note</th><th /></tr></thead>
              <tbody>
                {o.recent.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px' }}>{r.panel}</td>
                    <td style={{ padding: '6px', fontWeight: 600 }}>{r.order_id}</td>
                    <td style={{ padding: '6px' }}>{r.kind === 'placed' ? 'Order placed' : 'Tracking link'}</td>
                    <td style={{ padding: '6px' }}><span className={`chip ${STATUS_TONE[r.status] || 'chip-warn'}`}>{r.status}</span></td>
                    <td style={{ padding: '6px' }}>{r.to || '—'}</td>
                    <td style={{ padding: '6px' }}>{r.status === 'pending' ? `due ${when(r.due_at)}` : when(r.sent_at || r.due_at)}</td>
                    <td style={{ padding: '6px', maxWidth: 320, color: r.status === 'failed' ? 'var(--danger, #b91c1c)' : 'var(--fg-muted)' }}>{r.error || ''}{r.code ? ` [${r.code}]` : ''}</td>
                    <td style={{ padding: '6px' }}>{r.status === 'failed' && <button type="button" className="btn btn-sm btn-outline" disabled={busy === 'r' + r.id} onClick={() => void retry(r.id)}>Send again</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
