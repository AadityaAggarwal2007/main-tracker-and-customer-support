'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Moon, Power, RefreshCw, Search, Sun } from 'lucide-react';
import { SECTION, spin, type Alert, type AutoOverview } from './types';
import {
  SHOW_LABELS, TIME_LABELS, countByPanel, countByShow, countByTime, filterOrders, groupOrders, hourBuckets, istDate, isNight, reasonCounts, whyLine,
  type AutoShow, type AutoTime,
} from '@/lib/chat/whatsapp-auto-view';
import type { RecentRow } from '@/lib/chat/whatsapp-auto';

// WhatsApp > Automation (owner 2026-10-10: "har naye order par apne aap message chala jaye, on/off ka button, kitne
// bheje kitne fail"). The order-placed message at once and the tracking link 48 hours later, per panel, default OFF.
const COLS: { key: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'; label: string; tone: string }[] = [
  { key: 'pending', label: 'Waiting', tone: 'chip-warn' }, { key: 'sent', label: 'Sent', tone: 'chip-ok' }, { key: 'delivered', label: 'Delivered', tone: 'chip-ok' },
  { key: 'read', label: 'Read', tone: 'chip-ok' }, { key: 'failed', label: 'Failed', tone: 'chip-danger' }, { key: 'skipped', label: 'Skipped', tone: 'chip-warn' },
];
const STATUS_TONE: Record<string, string> = { pending: 'chip-warn', sent: 'chip-ok', delivered: 'chip-ok', read: 'chip-ok', failed: 'chip-danger', skipped: 'chip-warn' };
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '—');
const DAYS: { key: string; label: string }[] = [{ key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' }, { key: '7d', label: 'Last 7 days' }];
const dayWord = (d: string) => (d === 'today' ? 'today' : d === 'yesterday' ? 'yesterday' : d === '7d' ? 'in the last 7 days'
  : `on ${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`);
const WENT = ['sent', 'delivered', 'read'];
const hourText = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
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
  const [day, setDayState] = useState('today');
  const [time, setTime] = useState<AutoTime>('all');
  const [loadingDay, setLoadingDay] = useState(false);
  const setDay = (d: string) => { setDayState(d); setShown(PAGE); };
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [testOut, setTestOut] = useState<Record<string, { kind: string; ok: boolean; text: string; error: string | null }[]>>({});
  const load = useCallback(async (fresh = false) => {
    try {
      const r = await fetch(`/api/whatsapp/automation?day=${encodeURIComponent(day)}${fresh ? '&fresh=1' : ''}`, { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (r.ok && j) { setO(j); lastErr.current = ''; } else if (j?.error && j.error !== lastErr.current) { lastErr.current = j.error; onAlert('error', j.error); }
    } catch { /* offline: the next refresh tries again */ }
    finally { setLoadingDay(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, day]);
  useEffect(() => {
    setLoadingDay(true);
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
  const list = useMemo(() => filterOrders(lines, { panel: panelSel, show, q, time }), [lines, panelSel, show, q, time]);
  const perPanel = useMemo(() => countByPanel(lines, { show, q, time }), [lines, show, q, time]);
  const perShow = useMemo(() => countByShow(lines, { panel: panelSel, q, time }), [lines, panelSel, q, time]);
  const perTime = useMemo(() => countByTime(lines, { panel: panelSel, show, q }), [lines, panelSel, show, q]);
  const range = useMemo(() => (o?.range ? { from: Date.parse(o.range.from), to: Date.parse(o.range.to) } : { from: 0, to: 0 }), [o]);
  const rowsSel = useMemo(() => (o?.recent || []).filter((r) => panelSel === 'all' || r.panel_id === panelSel), [o, panelSel]);
  const hours = useMemo(() => hourBuckets(rowsSel, range), [rowsSel, range]);
  const reasons = useMemo(() => reasonCounts(rowsSel, range), [rowsSel, range]);
  const night = useMemo(() => {
    const inR = rowsSel.filter((r) => r.in_range !== false && r.at && WENT.includes(r.status) && isNight(Date.parse(r.at)));
    return { placed: inR.filter((r) => r.kind === 'placed').length, tracking: inR.filter((r) => r.kind === 'tracking').length };
  }, [rowsSel]);
  if (!o) return <div className="tf-card" style={{ padding: '1.25rem' }}><Loader2 size={16} style={spin} /> Loading…</div>;
  const cell = (r: RecentRow | null, label: string, orderAt: string | null) => {
    if (!r) return <span className="meta">—</span>;
    const t = r.at || r.sent_at || r.due_at;
    return (
      <div style={{ display: 'grid', gap: 2, opacity: r.in_range === false ? 0.6 : 1 }}>
        <span><span className={`chip ${STATUS_TONE[r.status] || 'chip-warn'}`} title={label}>{STATUS_WORD[r.status] || r.status}</span></span>
        <span className="meta" style={{ fontSize: '0.72rem', display: 'inline-flex', alignItems: 'center', gap: 3 }}>{t && isNight(Date.parse(t)) && <Moon size={11} />}{r.status === 'pending' ? `goes ${when(r.due_at)}` : when(t)}</span>
        {WENT.includes(r.status) && <span className="meta" style={{ fontSize: '0.7rem' }}>why then: {whyLine(r, orderAt)}</span>}
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
          When it is ON for a panel, every new order of that panel (Shopify or CSV) gets the <strong>order placed</strong> message on the customer&apos;s WhatsApp number by itself, with the order id, the brand and its support email. 48 hours later the customer gets the <strong>tracking link</strong>, only while the office is open (10 AM to 7:30 PM, Saturday till 2 PM): a 48th hour at night, on a Sunday or a holiday goes out when the office opens next. Old orders (an old CSV, anything placed before you switched it on or more than 24 hours back) are never messaged, and nobody gets the same message twice. Messages go out slowly, one every 30 seconds (2 a minute; 1 a minute for two hours after Meta refuses one), so Meta does not block the number for sending too fast. ShipTrack&apos;s alerts (chargeback first) go before any order message.
        </p>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.8125rem', alignItems: 'center' }}>
          <span>Template <code>order_placed</code>: <span className={`chip ${tplTone(o.templates.placed)}`}>{o.templates.placed}</span></span>
          <span>Template <code>order_tracking</code>: <span className={`chip ${tplTone(o.templates.tracking)}`}>{o.templates.tracking}</span></span>
          {o.templates.link && <span>One message <code>order_placed_link</code>: <span className={`chip ${tplTone(o.templates.link)}`}>{o.templates.link}</span></span>}
          {o.templates.error && <span style={{ color: 'var(--danger, #b91c1c)' }}>Could not read templates: {o.templates.error}</span>}
        </div>
        {/* one message per order (owner 2026-10-15): which mode runs now */}
        <div className="meta" style={{ fontSize: '0.78rem' }}>
          {o.templates.link === 'APPROVED'
            ? <><strong>One message per order:</strong> the first message carries the tracking link (order_placed_link); the 48-hour tracking message is no longer sent for new orders.</>
            : <>Two messages per order now. To send ONE (order placed + tracking link), make the template with the button &quot;Order placed + tracking link (one message)&quot; in Templates; once Meta says APPROVED the automation switches by itself.</>}
        </div>
        {(o.sendEveryMs ?? 30000) > 30000 && !o.paused && (
          <div style={{ padding: '0.6rem 0.75rem', borderRadius: 8, background: 'var(--warn-bg, #fef3c7)', fontSize: '0.8125rem' }}>
            <strong>Going slower for now:</strong> one order message a minute (instead of 2), because Meta refused messages (130429) in the last 2 hours. Back to 2 a minute by itself after 2 quiet hours.
          </div>
        )}
        {(o.alertsWaiting ?? 0) > 0 && (
          <div style={{ padding: '0.6rem 0.75rem', borderRadius: 8, background: 'var(--warn-bg, #fef3c7)', fontSize: '0.8125rem' }}>
            <strong>{o.alertsWaiting} ShipTrack alert{o.alertsWaiting === 1 ? '' : 's'} waiting to go:</strong> order messages wait until they are sent (alerts first).
          </div>
        )}
        {o.paused && (
          <div style={{ padding: '0.6rem 0.75rem', borderRadius: 8, background: 'var(--warn-bg, #fef3c7)', fontSize: '0.8125rem' }}>
            <strong>Paused until {new Date(o.paused.until).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}:</strong> Meta said too many messages went from this number in a short time (130429). Nothing is lost: the messages wait and go again by themselves, spaced out. Each new refusal within 2 hours doubles the pause (15, 30, 60, up to 120 minutes). Chargeback and other ShipTrack alerts and test messages still go at once (alerts first: order messages wait while one waits); the automatic &quot;help is by email&quot; reply waits.
          </div>
        )}
        {(o.templates.placed === 'MISSING' || o.templates.tracking === 'MISSING') && (
          <div className="meta" style={{ fontSize: '0.78rem' }}>Make the missing one in Templates (the buttons &quot;Order placed template&quot; and &quot;Tracking link template&quot; fill it), send it to Meta, and come back when it says APPROVED.</div>
        )}
        {!o.installed && <div style={{ padding: '0.6rem 0.75rem', borderRadius: 8, background: 'var(--warn-bg, #fef3c7)', fontSize: '0.8125rem' }}>Not installed yet: the database file <code>whatsapp-automation.sql</code> has to be run on the server once. Until then nothing can be switched on.</div>}
        {!o.configured && <div style={{ padding: '0.6rem 0.75rem', borderRadius: 8, background: 'var(--warn-bg, #fef3c7)', fontSize: '0.8125rem' }}>WhatsApp is not set up on the server (token / phone number id).</div>}
      </div>

      <div className="tf-card" style={{ padding: '0.75rem 1rem', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="meta" style={{ fontSize: '0.78rem', marginRight: 4 }}>Date:</span>
        {DAYS.map((d) => (
          <button key={d.key} type="button" className={`btn btn-sm ${day === d.key ? 'btn-primary' : 'btn-outline'}`} onClick={() => setDay(d.key)}>{d.label}</button>
        ))}
        <input type="date" className="form-input" aria-label="Pick a date" style={{ height: 32, width: 160, borderColor: /^\d{4}-/.test(day) ? 'var(--primary)' : undefined }}
          max={istDate(Date.now())} value={/^\d{4}-/.test(day) ? day : ''} onChange={(e) => { if (e.target.value) setDay(e.target.value); }} />
        {loadingDay && <Loader2 size={14} style={spin} />}
        <span className="meta" style={{ fontSize: '0.75rem', marginLeft: 'auto' }}>India time · a message counts on the day it went (or failed / was skipped)</span>
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

      {(() => {
        const ps = o.panels.filter((p) => panelSel === 'all' || p.id === panelSel);
        const sum = (k: 'placedIn' | 'trackingIn', st: string[]) => ps.reduce((n, p) => n + st.reduce((m, x) => m + (p[k][x as keyof typeof p.placedIn] || 0), 0), 0);
        const ord = ps.reduce((a, p) => ({ total: a.total + p.orders.total, cancelled: a.cancelled + p.orders.cancelled, queued: a.queued + p.orders.queued, beforeOn: a.beforeOn + p.orders.beforeOn }), { total: 0, cancelled: 0, queued: 0, beforeOn: 0 });
        const offOrders = ps.filter((p) => !p.enabled).reduce((n, p) => n + Math.max(0, p.orders.total - p.orders.cancelled - p.orders.queued), 0);
        const notMsg = Math.max(0, ord.total - ord.cancelled - ord.queued);
        const other = Math.max(0, notMsg - ord.beforeOn - offOrders);
        const max = Math.max(1, ...hours.map((h) => h.went + h.failed + h.skipped));
        const box = (n: number, label: string, hint: string, tone?: string) => (
          <div style={{ padding: '0.6rem 0.75rem', border: '1px solid var(--border)', borderRadius: 10, minWidth: 0 }}>
            <div style={{ fontSize: '1.375rem', fontWeight: 800, color: tone }}>{n}</div>
            <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{label}</div>
            {hint && <div className="meta" style={{ fontSize: '0.72rem' }}>{hint}</div>}
          </div>
        );
        return (
          <div className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: 12 }}>
            <span style={SECTION}>What happened {dayWord(o.range.day)}{panelSel !== 'all' ? ` · ${ps[0]?.name || ''}` : ' · all brands'}</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
              {box(ord.total, 'Orders came in', ord.cancelled ? `${ord.cancelled} of them cancelled` : 'new orders in ShipTrack')}
              {box(sum('placedIn', WENT), 'Order placed messages went', `${sum('placedIn', ['read'])} read · ${sum('placedIn', ['delivered'])} delivered`, '#15803d')}
              {box(sum('trackingIn', WENT), 'Tracking links went', `${sum('trackingIn', ['read'])} read · ${sum('trackingIn', ['pending'])} waiting`, '#15803d')}
              {box(sum('placedIn', ['failed']) + sum('trackingIn', ['failed']), 'Failed', 'WhatsApp refused them: reasons below', 'var(--danger, #b91c1c)')}
              {box(sum('placedIn', ['skipped']) + sum('trackingIn', ['skipped']), 'Skipped', 'not sent on purpose: reasons below', '#b45309')}
              {box(notMsg, 'Orders with no message', notMsg ? 'see why below' : 'every order was picked up')}
            </div>
            {notMsg > 0 && (
              <div style={{ fontSize: '0.8125rem', display: 'grid', gap: 2 }}>
                <strong>Why {notMsg} order{notMsg === 1 ? '' : 's'} got no message:</strong>
                {offOrders > 0 && <span>• {offOrders}: the automation is OFF for that brand</span>}
                {ord.beforeOn > 0 && <span>• {ord.beforeOn}: placed before the automation was switched ON</span>}
                {other > 0 && <span>• {other}: not picked up (an order older than 24 hours when it reached ShipTrack, e.g. an old CSV, or one that came in during the last minute)</span>}
              </div>
            )}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <strong style={{ fontSize: '0.8125rem' }}>Messages per hour</strong>
                <span className="meta" style={{ fontSize: '0.72rem' }}>green = went · red = failed · amber = skipped · shaded = night (7:30 PM – 10 AM)</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 2, alignItems: 'end', height: 90 }}>
                {hours.map((h) => {
                  const n = h.went + h.failed + h.skipped; const nightH = h.hour < 10 || h.hour >= 20;
                  return (
                    <div key={h.hour} title={`${hourText(h.hour)}–${hourText((h.hour + 1) % 24)}: ${h.went} went, ${h.failed} failed, ${h.skipped} skipped`}
                      style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', background: nightH ? 'var(--bg-muted, rgba(100,116,139,0.12))' : 'transparent', borderRadius: 3 }}>
                      {n > 0 && <div style={{ fontSize: '0.6rem', textAlign: 'center', color: 'var(--fg-muted)' }}>{n}</div>}
                      <div style={{ height: `${(h.skipped / max) * 70}px`, background: '#f59e0b' }} />
                      <div style={{ height: `${(h.failed / max) * 70}px`, background: '#dc2626' }} />
                      <div style={{ height: `${(h.went / max) * 70}px`, background: '#16a34a', borderRadius: '2px 2px 0 0' }} />
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 2, fontSize: '0.6rem', color: 'var(--fg-muted)', textAlign: 'center' }}>
                {hours.map((h) => <span key={h.hour}>{h.hour % 3 === 0 ? hourText(h.hour) : ''}</span>)}
              </div>
            </div>
            {(night.placed > 0 || night.tracking > 0) && (
              <div style={{ fontSize: '0.8125rem', padding: '0.5rem 0.75rem', borderRadius: 8, background: 'var(--bg-muted, rgba(100,116,139,0.10))', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Moon size={15} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  <strong>{night.placed + night.tracking} went at night.</strong>{' '}
                  {night.placed > 0 && <>{night.placed} order placed message{night.placed === 1 ? '' : 's'}: the order placed message goes as soon as the order comes in, so an order placed at 11 PM gets it at 11 PM. </>}
                  {night.tracking > 0 && <>{night.tracking} tracking link{night.tracking === 1 ? '' : 's'} at night should not happen (they wait for office hours): tell the developer.</>}
                  {' '}Press <b>Night</b> in the list below to see exactly which orders.
                </span>
              </div>
            )}
            {reasons.length > 0 && (
              <div style={{ fontSize: '0.8125rem', display: 'grid', gap: 3 }}>
                <strong>Why messages did not go</strong>
                {reasons.slice(0, 8).map((r) => (
                  <div key={r.status + r.reason} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span className={`chip ${r.status === 'failed' ? 'chip-danger' : 'chip-warn'}`} style={{ minWidth: 34, justifyContent: 'center' }}>{r.n}</span>
                    <span>{r.status === 'failed' ? 'Failed' : 'Skipped'}: {r.reason}</span>
                  </div>
                ))}
              </div>
            )}
            {o.capped && <div className="meta" style={{ fontSize: '0.75rem' }}>Very many messages on these days: the list below shows the latest 4,000; the numbers above count all of them.</div>}
          </div>
        );
      })()}

      {o.panels.filter((p) => panelSel === 'all' || p.id === panelSel).map((p) => (
        <div key={p.id} className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '1rem' }}>{p.name}</strong>
            <span className={`chip ${p.enabled ? 'chip-ok' : 'chip-warn'}`}>{p.enabled ? 'ON' : 'OFF'}</span>
            {p.replied > 0 && <span className="chip chip-ok" title="Customers who wrote back after one of these messages">{p.replied} replied</span>}
            {p.enabled && p.since && <span className="meta" style={{ fontSize: '0.75rem' }}>messaging orders placed since {when(p.since)}</span>}
            <span className="meta" style={{ fontSize: '0.75rem' }}>{p.orders.total} order{p.orders.total === 1 ? '' : 's'} came in {dayWord(o.range.day)}, {p.orders.queued} got the order placed message</span>
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
              <thead><tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}><th style={{ padding: '4px 6px' }}>Message ({dayWord(o.range.day)})</th>{COLS.map((c) => <th key={c.key} style={{ padding: '4px 6px' }}>{c.label}</th>)}</tr></thead>
              <tbody>
                {([['Order placed', p.placed, p.placedIn], ['Tracking link (48 h)', p.tracking, p.trackingIn]] as const).map(([name, all, dIn]) => (
                  <tr key={name} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px', fontWeight: 600 }}>{name}</td>
                    {COLS.map((c) => <td key={c.key} style={{ padding: '6px' }}><strong>{dIn[c.key]}</strong> <span className="meta" style={{ fontSize: '0.7rem' }}>· {all[c.key]} all time</span></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={SECTION}>Orders and their messages {dayWord(o.range.day)}{panelSel !== 'all' ? ` · ${o.panels.find((p) => p.id === panelSel)?.name || ''}` : ''}</span>
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
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TIME_LABELS.map((f) => (
            <button key={f.key} type="button" className={`btn btn-sm ${time === f.key ? 'btn-primary' : 'btn-outline'}`} style={{ gap: 4 }} onClick={() => { setTime(f.key); setShown(PAGE); }}>
              {f.key === 'night' ? <Moon size={13} /> : f.key === 'day' ? <Sun size={13} /> : null}{f.label} <span style={{ opacity: 0.8, marginLeft: 4 }}>{perTime[f.key]}</span>
            </button>
          ))}
        </div>
        {lines.length === 0 && <div className="meta" style={{ fontSize: '0.8125rem' }}>No automation message {dayWord(o.range.day)}. Pick another date above; once a panel is ON, every new order and its two messages are listed here.</div>}
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
                      {l.orderAt && <div className="meta" style={{ fontSize: '0.72rem', display: 'inline-flex', alignItems: 'center', gap: 3 }}>{isNight(Date.parse(l.orderAt)) && <Moon size={11} />}placed {when(l.orderAt)}</div>}
                    </td>
                    <td style={{ padding: '8px 6px' }}>
                      <div>{l.name || '—'}</div>
                      {l.to && <div className="meta" style={{ fontSize: '0.72rem' }}>{l.to}</div>}
                    </td>
                    <td style={{ padding: '8px 6px' }}>{cell(l.placed, 'Order placed', l.orderAt)}</td>
                    <td style={{ padding: '8px 6px' }}>{cell(l.tracking, 'Tracking link', l.orderAt)}</td>
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
