'use client';

// ── The panel board (owner 2026-10-09: "home screen par har panel ki line: is par kya karna hai") ──
// Top of the Orders tab: one card per panel the login may see, numbered, the panel with the most to do first,
// each with the lines from src/lib/panel-board.ts (chargebacks, waiting customers, Refund / Ship again, late
// orders, the setup a new panel still lacks) and the numbers behind them. Refreshes every minute and on
// focus. A line is a button that takes you to the screen for it, on that panel.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, LayoutGrid, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { panelNeeds, sortPanels, type PanelStats, type Need } from '@/lib/panel-board';
import { agoText } from '@/app/admin/_lib/format';

type Panel = PanelStats & { needs: Need[] };

export default function PanelBoard({ token, activePanelId, goTo }: {
  token: string;
  activePanelId: string;
  // Where a line takes the person: the panel is made active first, then the screen opens.
  goTo: (panelId: string, where: NonNullable<Need['go']>) => void;
}) {
  const [panels, setPanels] = useState<Panel[] | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch('/api/panel-board', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || 'Could not read the panel board.'); return; }
      let stats: PanelStats[] = j.panels || [];
      // The Super Admin's refund requests to decide, per panel, from the refund area's own route (a member gets 403: skipped).
      if (j.superAdmin) {
        try {
          const rr = await fetch('/api/refunds/counts?byPanel=1', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
          const by: Record<string, number> = rr.ok ? ((await rr.json())?.by_panel || {}) : {};
          stats = stats.map(p => ({ ...p, refundRequestsNew: Number(by[p.id] || 0) }));
        } catch { /* the line is left out */ }
      }
      setPanels(sortPanels(stats).map(p => ({ ...p, needs: panelNeeds(p) }))); setAt(Date.now()); setError(null);
    } catch { setError('Could not read the panel board.'); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => {
    void load();
    const tick = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(tick); window.removeEventListener('focus', onFocus); };
  }, [load]);

  const total = (panels || []).reduce((a, p) => a + p.needs.filter(x => x.tone !== 'ok').length, 0);

  return (
    <section className="pb" aria-label="Panel board">
      <div className="pb-head">
        <LayoutGrid size={18} style={{ color: 'var(--primary)' }} />
        <h2 className="pb-title">Today, panel by panel</h2>
        <span className="meta">{panels ? (total === 0 ? 'Nothing waiting on any panel' : `${total} ${total === 1 ? 'thing' : 'things'} to do`) : ''}{at ? ` · checked ${agoText(at)}` : ''}</span>
        <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading} aria-label="Refresh the board">{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}</button>
      </div>
      {error && <div className="mail-warn" style={{ margin: '0 0 0.5rem' }}>{error}</div>}
      {!panels && !error && <div className="meta" style={{ padding: '0.5rem 0' }}>Reading every panel…</div>}
      {panels && panels.length === 0 && <div className="meta">No panel yet.</div>}
      <div className="pb-grid">
        {(panels || []).map((p, i) => {
          const urgent = p.needs.some(x => x.tone === 'danger'), clear = p.needs.every(x => x.tone === 'ok');
          return (
            <article key={p.id} className={`pb-card${urgent ? ' pb-urgent' : clear ? ' pb-clear' : ''}${p.id === activePanelId ? ' pb-active' : ''}`}>
              <header className="pb-card-head">
                <span className="pb-num" aria-hidden="true">{i + 1}</span>
                <b className="pb-name" title={p.name}>{p.name}</b>
                {p.id === activePanelId && <span className="chip chip-primary" title="The panel the Orders list below shows">Open now</span>}
                {urgent ? <ShieldAlert size={16} style={{ color: 'var(--danger)' }} /> : clear ? <CheckCircle2 size={16} style={{ color: 'var(--success)' }} /> : <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />}
              </header>
              <ul className="pb-needs">
                {p.needs.map((x, k) => (
                  <li key={k} className={`pb-need pb-${x.tone}`}>
                    {x.go
                      ? <button type="button" className="pb-need-btn" onClick={() => goTo(p.id, x.go!)} title="Open this on that panel">{x.text}</button>
                      : <span>{x.text}</span>}
                  </li>
                ))}
              </ul>
              <dl className="pb-nums">
                <div><dt>Needs you</dt><dd>{p.needsYou}</dd></div>
                <div><dt>Waiting</dt><dd>{p.waiting}</dd></div>
                <div><dt>Refund</dt><dd>{p.refundCases}</dd></div>
                <div><dt>Ship again</dt><dd>{p.reshipToShip}</dd></div>
                {p.chargebacksOpen !== null && <div><dt>Chargebacks</dt><dd>{p.chargebacksOpen}</dd></div>}
                <div><dt>Orders today</dt><dd>{p.ordersToday}</dd></div>
                <div><dt>Late</dt><dd>{p.lateOrders}</dd></div>
              </dl>
              <div className="pb-foot">
                <span className="meta" title="Chikki on / support Gmail / chargeback Gmail">
                  {p.aiOn === null ? 'No chat yet' : p.aiOn ? 'Chikki on' : 'Chikki OFF'} · Gmail {p.supportGmail ? '✓' : '✗'} · Chargeback {p.chargebackGmail ? '✓' : '✗'}
                </span>
                <span style={{ display: 'flex', gap: '0.375rem' }}>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => goTo(p.id, 'chats')}>Chats</button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => goTo(p.id, 'orders')}>Orders</button>
                </span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
