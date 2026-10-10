'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Power, RefreshCw, Search } from 'lucide-react';
import { SECTION, spin, type Alert, type AutoOverview } from './types';
import { SHOW_LABELS, countByPanel, countByShow, filterOrders, groupOrders, type AutoShow } from '@/lib/chat/whatsapp-auto-view';
import type { RecentRow } from '@/lib/chat/whatsapp-auto';

// WhatsApp > Automation (owner 2026-10-10: "har naye order par apne aap message chala jaye, on/off ka button, kitne
// bheje kitne fail"). The order-placed message at once and the tracking link 48 hours later, per panel, default OFF.
const COLS: { key: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'; label: string; tone: string }[] = [
  { key: 'pending', label: 'Waiting', tone: 'chip-warn' }, { key: 'sent', label: 'Sent', tone: 'chip-ok' }, { key: 'delivered', label: 'Delivered', tone: 'chip-ok' },
  { key: 'read', label: 'Read', tone: 'chip-ok' }, { key: 'failed', label: 'Failed', tone: 'chip-danger' }, { key: 'skipped', label: 'Skipped', tone: 'chip-warn' },
];
const STATUS_TONE: Record<string, string> = { pending: 'chip-warn', sent: 'chip-ok', delivered: 'chip-ok', read: 'chip-ok', failed: 'chip-danger', skipped: 'chip-warn' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—');
const STATUS_WORD: Record<string, string> = { pending: 'Waiting', sent: 'Sent ✓', delivered: 'Delivered ✓✓', read: 'Read ✓✓', failed: 'Failed', skipped: 'Skipped' };
const PAGE = 25;
const store = { get: (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } } };
const tplTone = (s: string) => (s === 'APPROVED' ? 'chip-ok' : s === 'PENDING' ? 'chip-warn' : 'chip-danger');

export default function AutomationPanel({ token, onAlert }: { token: string; onAlert: Alert }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [o, setO] = useState<AutoOverview | null>(null);
  const [busy, setBusy] = useState('');
  const lastErr = useRef('');
  const [testTo, setTestTo] = useState(() => { try { return localStorage.getItem('wa_test_to') || ''; } catch { return ''; } });
  const [testName, setTestName] = useState('');
  const [brand, setBrandState] = useState(() => store.get('wa_auto_brand') || 'all');
  const setBrand = (b: string) => { setBrandState(b); setShown(PAGE); store.set('wa_auto_brand', b); };
  const [show, setShow] = useState<AutoShow>('all');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [testOut, setTestOut] = useState<Record<string, { kind: string; ok: boolean; text: string; error: string | null }[]>>({});
  const load = useCallback(async (fresh = false) => {
    try {
      const r = await fetch(`/api/whatsapp/automation${fresh ? '?fresh=1' : ''}`, { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (r.ok && j) { setO(j); lastErr.current = ''; } else if (j?.error && j.error !== lastErr.current) { lastErr.current = j.error; onAlert('error', j.error); }
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

  const test = async (id: string, name: string) => {
    if (!testTo.trim()) { onAlert('error', 'Type your WhatsApp number first'); return; }
    setBusy('t' + id);
    try {
      try { localStorage.setItem('wa_test_to', testTo.trim()); } catch { /* private window */ }
      const r = await fetch('/api/whatsapp/automation', { method: 'POST', headers: auth, body: JSON.stringify({ action: 'test', businessId: id, to: testTo, name: testName }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not send the test'); return; }
      setTestOut((x) => ({ ...x, [id]: j.results || [] }));
      const sent = (j.results || []).filter((x: { ok: boolean }) => x.ok).length;
      onAlert(sent ? 'success' : 'error', `${name}: ${sent} of 2 test messages sent to ${testTo}${j.order ? ` (filled from order ${j.order})` : ''}`);
    } finally { setBusy(''); }
  };
  const lines = useMemo(() => groupOrders(o?.recent || []), [o]);
  const brandOk = brand === 'all' || !o || o.panels.some((p) => p.id === brand);
  const panelSel = brandOk ? brand : 'all';
  const list = useMemo(() => filterOrders(lines, { panel: panelSel, show, q }), [lines, panelSel, show, q]);
  const perPanel = useMemo(() => countByPanel(lines, { show, q }), [lines, show, q]);
  const perShow = useMemo(() => countByShow(lines, { panel: panelSel, q }), [lines, panelSel, q]);
  if (!o) return <div className="tf-card" style={{ padding: '1.25rem' }}><Loader2 size={16} style={spin} /> Loading…</div>;
  const cell = (r: RecentRow | null, label: string) => {
    if (!r) return <span className="meta">—</span>;
    return (
      <div style={{ display: 'grid', gap: 2 }}>
        <span><span className={`chip ${STATUS_TONE[r.status] || 'chip-warn'}`} title={label}>{STATUS_WORD[r.status] || r.status}</span></span>
        <span className="meta" style={{ fontSize: '0.72rem' }}>{r.status === 'pending' ? `goes ${when(r.due_at)}` : when(r.sent_at || r.due_at)}</span>
        {r.error && <span style={{ fontSize: '0.72rem', color: r.status === 'failed' ? 'var(--danger, #b91c1c)' : 'var(--fg-muted)', maxWidth: 260 }}>{r.error}{r.code ? ` [${r.code}]` : ''}</span>}
        {r.status === 'failed' && <span><button type="button" className="btn btn-sm btn-outline" style={{ marginTop: 2 }} disabled={busy === 'r' + r.id} onClick={() => void retry(r.id)}>Send again</button></span>}
      </div>
    );
  };
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

      <div className="tf-card" style={{ padding: '0.75rem 1rem', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="meta" style={{ fontSize: '0.78rem', marginRight: 4 }}>Brand:</span>
        {[{ id: 'all', name: 'All brands', enabled: null as boolean | null }, ...o.panels.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled as boolean | null }))].map((b) => (
          <button key={b.id} type="button" aria-pressed={panelSel === b.id} onClick={() => setBrand(b.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 999, border: '1px solid var(--border-strong, var(--border))', background: panelSel === b.id ? 'var(--primary)' : 'transparent', color: panelSel === b.id ? '#fff' : 'inherit', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
            {b.enabled !== null && <span title={b.enabled ? 'Automation ON' : 'Automation OFF'} style={{ width: 8, height: 8, borderRadius: 999, background: b.enabled ? '#16a34a' : '#9ca3af' }} />}
            {b.name}
            <span style={{ fontWeight: 500, opacity: 0.8 }}>{perPanel[b.id] || 0}</span>
          </button>
        ))}
      </div>

      {o.panels.filter((p) => panelSel === 'all' || p.id === panelSel).map((p) => (
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
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: '0.78rem' }}>
            <span className="meta">Check it on your own phone:</span>
            <input className="form-input" style={{ width: 150, height: 32 }} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Your number" inputMode="tel" />
            <input className="form-input" style={{ width: 130, height: 32 }} value={testName} onChange={(e) => setTestName(e.target.value)} placeholder="Name (optional)" />
            <button type="button" className="btn btn-sm btn-outline" disabled={busy === 't' + p.id} onClick={() => void test(p.id, p.name)}>{busy === 't' + p.id ? <Loader2 size={13} style={spin} /> : 'Send both as a test'}</button>
            <span className="meta">(the brand's latest order fills them; no customer is messaged, nothing is counted)</span>
          </div>
          {(testOut[p.id] || []).map((t) => (
            <div key={t.kind} style={{ fontSize: '0.78rem', padding: '6px 8px', borderRadius: 8, background: t.ok ? 'var(--ok-bg, #ecfdf3)' : 'var(--danger-bg, #fef3f2)' }}>
              <strong>{t.kind === 'placed' ? 'Order placed' : 'Tracking link'}:</strong> {t.ok ? 'sent' : `not sent (${t.error})`}
              {t.text && <div style={{ whiteSpace: 'pre-wrap', marginTop: 4, color: 'var(--fg-muted)' }}>{t.text}</div>}
            </div>
          ))}
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

      <div className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={SECTION}>Orders and their messages{panelSel !== 'all' ? ` · ${o.panels.find((p) => p.id === panelSel)?.name || ''}` : ''}</span>
          <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 8, padding: '0 8px', height: 32 }}>
            <Search size={13} />
            <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Order, name or last 4 digits" style={{ border: 0, outline: 'none', background: 'transparent', width: 190, fontSize: '0.8125rem', color: 'inherit' }} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {SHOW_LABELS.map((f) => (
            <button key={f.key} type="button" className={`btn btn-sm ${show === f.key ? 'btn-primary' : 'btn-outline'}`} onClick={() => { setShow(f.key); setShown(PAGE); }}
              style={f.key === 'failed' && perShow.failed > 0 && show !== 'failed' ? { color: 'var(--danger, #b91c1c)', borderColor: 'var(--danger, #b91c1c)' } : undefined}>
              {f.label} <span style={{ opacity: 0.8, marginLeft: 4 }}>{perShow[f.key]}</span>
            </button>
          ))}
        </div>
        {lines.length === 0 && <div className="meta" style={{ fontSize: '0.8125rem' }}>Nothing yet. Once a panel is ON, every new order and its two messages are listed here.</div>}
        {lines.length > 0 && list.length === 0 && <div className="meta" style={{ fontSize: '0.8125rem' }}>No order matches these filters.</div>}
        {list.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
              <thead><tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
                <th style={{ padding: '4px 6px' }}>Order</th><th style={{ padding: '4px 6px' }}>Customer</th>
                <th style={{ padding: '4px 6px' }}>1 · Order placed</th><th style={{ padding: '4px 6px' }}>2 · Tracking link (48 h)</th>
              </tr></thead>
              <tbody>
                {list.slice(0, shown).map((l) => (
                  <tr key={l.key} style={{ borderTop: '1px solid var(--border)', verticalAlign: 'top' }}>
                    <td style={{ padding: '8px 6px' }}>
                      <div style={{ fontWeight: 700 }}>{l.orderId}</div>
                      {panelSel === 'all' && <div className="meta" style={{ fontSize: '0.72rem' }}>{l.panel}</div>}
                    </td>
                    <td style={{ padding: '8px 6px' }}>
                      <div>{l.name || '—'}</div>
                      {l.to && <div className="meta" style={{ fontSize: '0.72rem' }}>{l.to}</div>}
                    </td>
                    <td style={{ padding: '8px 6px' }}>{cell(l.placed, 'Order placed')}</td>
                    <td style={{ padding: '8px 6px' }}>{cell(l.tracking, 'Tracking link')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.length > shown && (
          <button type="button" className="btn btn-sm btn-outline" style={{ justifySelf: 'center' }} onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, list.length - shown)} more (of {list.length - shown})</button>
        )}
      </div>
    </div>
  );
}
