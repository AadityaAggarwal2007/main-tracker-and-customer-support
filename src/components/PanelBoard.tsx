'use client';

// ── "Today": the panel board (owner 2026-10-09: "home screen par har panel ki line: is par kya karna hai", then
// "isko Orders se alag, ek apna segment: everyday morning check") ──
// Its own tab, first in the sidebar. Top: the day (India's date, office open / closed, who is in ShipTrack now) and
// the totals across every panel; the morning routine (the same steps every day, ticked by themselves when their
// number is 0); then one numbered card per panel the login may see, the panel with the most to do first, with the
// lines from src/lib/panel-board.ts and the numbers behind them. Refreshes every minute and on focus. A line is a
// button that makes that panel the active one and opens the screen for it.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, CheckSquare, Loader2, RefreshCw, ShieldAlert, Sun, Users } from 'lucide-react';
import { morningRoutine, panelNeeds, sortPanels, summarize, type PanelStats, type Need } from '@/lib/panel-board';
import { agoText } from '@/app/admin/_lib/format';

type Panel = PanelStats & { needs: Need[] };
interface Day { date: string; officeOpen: boolean; online: string[]; ai?: { ok: boolean; reason: string | null; text: string | null; detail: string; lastFailAt: number | null; failsLastHour: number } }

const dateText = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
};
const gmailWord = (s: PanelStats['supportGmailStatus'], connected: boolean) => !connected ? '✗ not connected' : s === 'ok' ? '✓ reading' : s === 'error' ? '✗ cannot read' : '✓';

export default function PanelBoard({ token, activePanelId, goTo }: {
  token: string;
  activePanelId: string;
  // Where a line takes the person: the panel is made active first, then the screen opens.
  goTo: (panelId: string, where: NonNullable<Need['go']>) => void;
}) {
  const [panels, setPanels] = useState<Panel[] | null>(null);
  const [day, setDay] = useState<Day | null>(null);
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
      setPanels(sortPanels(stats).map(p => ({ ...p, needs: panelNeeds(p) }))); setDay(j.day || null); setAt(Date.now()); setError(null);
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

  const totals = panels ? summarize(panels) : null;
  const routine = totals ? morningRoutine(totals, !!(day?.ai && !day.ai.ok)) : [];
  const left = routine.filter(s => !s.done).length;
  // A step's screen opens on the panel with the most of that thing.
  const panelFor = (go: NonNullable<Need['go']>) => {
    const pick = (f: (p: Panel) => number) => (panels || []).slice().sort((a, b) => f(b) - f(a))[0]?.id || activePanelId;
    if (go === 'chargebacks') return pick(p => p.chargebacksOpen ?? 0);
    if (go === 'refunds') return pick(p => p.refundRequestsNew ?? 0);
    if (go === 'orders') return pick(p => p.lateOrders);
    if (go === 'settings') return pick(p => p.needs.filter(x => x.go === 'settings').length);
    return pick(p => p.overdue * 10 + p.needsYou);
  };

  return (
    <section className="pb" aria-label="Today, panel by panel">
      <div className="pb-head">
        <Sun size={20} style={{ color: 'var(--warning)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="pb-title">Today{day ? `, ${dateText(day.date)}` : ''}</h2>
          <div className="meta">
            {day && <span className={`chip ${day.officeOpen ? 'chip-success' : 'chip-muted'}`} style={{ marginRight: '0.375rem' }}>{day.officeOpen ? 'Office open' : 'Office closed'}</span>}
            {day && <span title={day.online.length ? day.online.join(', ') : 'Nobody has touched ShipTrack in the last 5 minutes'}><Users size={12} style={{ verticalAlign: '-2px' }} /> {day.online.length ? `In ShipTrack now: ${day.online.join(', ')}` : 'Nobody in ShipTrack right now'}</span>}
            {at ? ` · checked ${agoText(at)}` : ''}
          </div>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading} aria-label="Refresh">{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh</button>
      </div>
      {error && <div className="mail-warn" style={{ margin: '0 0 0.5rem' }}>{error}</div>}
      {day?.ai && !day.ai.ok && (
        <div className="pb-ai-down" role="alert">
          <ShieldAlert size={18} />
          <div>
            <b>Chikki cannot answer customers right now</b> — {day.ai.text || 'every model failed'}.
            <div className="meta" style={{ color: 'inherit', opacity: 0.85 }}>
              {day.ai.failsLastHour} failed {day.ai.failsLastHour === 1 ? 'reply' : 'replies'} in the last hour{day.ai.lastFailAt ? `, last ${agoText(day.ai.lastFailAt)}` : ''}{day.ai.detail ? ` · "${day.ai.detail}"` : ''}. Customers get "Sorry, that took longer than expected" until it works again; verified customers go to Needs you.
            </div>
          </div>
        </div>
      )}
      {!panels && !error && <div className="meta" style={{ padding: '0.5rem 0' }}>Reading every panel…</div>}

      {totals && (
        <div className="pb-top">
          <dl className="pb-strip" aria-label="Across every panel">
            <div className={totals.needsYou ? 'pb-hot' : ''}><dt>Needs you</dt><dd>{totals.needsYou}</dd></div>
            <div className={totals.overdue ? 'pb-hot' : ''}><dt>Waiting 2 h+</dt><dd>{totals.overdue}</dd></div>
            {totals.chargebacks !== null && <div className={totals.chargebacks ? 'pb-hot' : ''}><dt>Chargebacks</dt><dd>{totals.chargebacks}</dd></div>}
            {totals.refundRequests !== null && <div className={totals.refundRequests ? 'pb-warm' : ''}><dt>Refund requests</dt><dd>{totals.refundRequests}</dd></div>}
            <div className={totals.reshipToShip ? 'pb-warm' : ''}><dt>To ship again</dt><dd>{totals.reshipToShip}</dd></div>
            <div className={totals.lateOrders ? 'pb-warm' : ''}><dt>Late orders</dt><dd>{totals.lateOrders}</dd></div>
            <div><dt>Customers today</dt><dd>{totals.chatsToday}</dd></div>
            <div><dt>Team replies</dt><dd>{totals.teamRepliesToday}</dd></div>
            <div><dt>Chikki replies</dt><dd>{totals.chikkiToday}</dd></div>
            <div><dt>Orders today</dt><dd>{totals.ordersToday}</dd></div>
          </dl>
          <div className="pb-routine">
            <div className="pb-routine-head"><CheckSquare size={16} style={{ color: 'var(--primary)' }} /> <b>Morning routine</b> <span className="meta">{left === 0 ? 'all done' : `${left} of ${routine.length} left`}</span></div>
            <ol>
              {routine.map((s, i) => (
                <li key={i} className={s.done ? 'done' : ''}>
                  {s.done ? <CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> : <Circle size={15} style={{ color: 'var(--fg-muted)' }} />}
                  {s.done ? <span>{s.text}</span> : <button type="button" className="pb-need-btn" onClick={() => goTo(panelFor(s.go), s.go)}>{s.text}</button>}
                  {!s.done && <span className="chip chip-warn" style={{ marginLeft: 'auto' }}>{s.count}</span>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {panels && panels.length === 0 && <div className="meta">No panel yet.</div>}
      <div className="pb-grid">
        {(panels || []).map((p, i) => {
          const urgent = p.needs.some(x => x.tone === 'danger'), clear = p.needs.every(x => x.tone === 'ok');
          return (
            <article key={p.id} className={`pb-card${urgent ? ' pb-urgent' : clear ? ' pb-clear' : ''}${p.id === activePanelId ? ' pb-active' : ''}`}>
              <header className="pb-card-head">
                <span className="pb-num" aria-hidden="true">{i + 1}</span>
                <b className="pb-name" title={p.name}>{p.name}</b>
                {p.id === activePanelId && <span className="chip chip-primary" title="The panel the other tabs show">Open now</span>}
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
              <div className="meta pb-today-line" title="Today, India time">Today: {p.chatsToday} {p.chatsToday === 1 ? 'customer' : 'customers'} wrote · team {p.teamRepliesToday} · Chikki {p.chikkiToday}</div>
              <div className="pb-foot">
                <span className="meta" title="Chikki on or off · support Gmail · chargeback Gmail">
                  {p.aiOn === null ? 'No chat yet' : p.aiOn ? 'Chikki on' : 'Chikki OFF'} · Gmail {gmailWord(p.supportGmailStatus, p.supportGmail)} · Chargeback {gmailWord(p.chargebackGmailStatus, p.chargebackGmail)}
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
