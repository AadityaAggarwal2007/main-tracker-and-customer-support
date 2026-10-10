'use client';

// ── Chargeback Shield: the study of every chargeback so far (owner 2026-10-10, "serious study karna") ──
// GET /api/chargebacks/risk?view=study: each real chargeback mail -> its order (order number, else the email / phone /
// amount in the mail) -> did the customer write to us first, on which channel, and what the risk engine would have said
// 3 days before and on the day. Read only.
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

interface Row {
  alertId: string; receivedAt: string; gateway: string; panelName: string; matchedBy: string | null; orderId: string | null;
  cod: boolean | null; daysFromOrder: number | null; contacted: boolean; channels: string[];
  before3: { score: number; level: string; signals: string[] } | null;
  onDay: { score: number; level: string; signals: string[]; action: string } | null;
}
interface Study {
  rows: Row[];
  summary: { chargebacks: number; matched: number; cod: number; contacted: number; flaggedBefore: number; flaggedOnDay: number; silent: number; signals: { text: string; count: number }[] };
}
const LEVEL_CHIP: Record<string, string> = { critical: 'chip-danger', high: 'chip-warn', watch: 'chip-muted', low: 'chip-ok' };
const MATCH_TEXT: Record<string, string> = { order: 'by order number', email: 'by the customer email in the mail', phone: 'by the phone in the mail', amount: 'by the amount (only one order had it)' };
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

export default function StudyPanel({ token, onAlert }: { token: string; onAlert: (type: string, message: string) => void }) {
  const [data, setData] = useState<Study | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/chargebacks/risk?view=study', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not read the study.'); return; }
      setData(j);
    } catch { onAlert('error', 'Could not read the study.'); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  const s = data?.summary;

  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <div className="meta" style={{ flex: 1 }}>Every real chargeback of the last 120 days: which order it was, whether the customer wrote to us first, and whether the signs were there 3 days before.</div>
        <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading}>{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh</button>
      </div>
      {s && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.5rem' }}>
          {[
            ['Chargebacks', s.chargebacks, ''],
            ['Order found', s.matched, `${s.chargebacks - s.matched} could not be tied to an order`],
            ['Wrote to us first', s.contacted, 'chat, email or WhatsApp before the chargeback'],
            ['Never wrote (silent)', s.silent, 'went straight to the bank'],
            ['Signs 3 days before', s.flaggedBefore, 'High / Critical on the risk list then'],
            ['Signs on the day', s.flaggedOnDay, 'High / Critical by the day of the mail'],
          ].map(([label, n, hint]) => (
            <div key={String(label)} className="tf-card" style={{ padding: '0.625rem 0.75rem' }}>
              <div style={{ fontSize: '1.375rem', fontWeight: 800 }}>{n}</div>
              <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{label}</div>
              {hint && <div className="meta">{hint}</div>}
            </div>
          ))}
        </div>
      )}
      {s && s.signals.length > 0 && (
        <div className="tf-card" style={{ padding: '0.625rem 0.75rem' }}>
          <div style={{ fontWeight: 700, fontSize: '0.875rem', marginBottom: '0.25rem' }}>What their customers said / went through before the chargeback</div>
          {s.signals.map((x) => <div key={x.text} style={{ fontSize: '0.8125rem' }}>{x.count} × {x.text}</div>)}
        </div>
      )}
      {!loading && data && data.rows.length === 0 && <div className="mail-empty">No real chargeback mail yet (or the chargeback Gmail is not connected).</div>}
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {(data?.rows || []).map((r) => (
          <div key={r.alertId} className="tf-card" style={{ padding: '0.75rem 1rem', display: 'grid', gap: '0.375rem' }}>
            <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <b style={{ fontSize: '0.875rem' }}>{day(r.receivedAt)}</b>
              <span className="chip chip-muted">{r.panelName}</span>
              <span className="chip chip-muted">{r.gateway}</span>
              {r.orderId ? <span className="chip chip-primary" title={MATCH_TEXT[r.matchedBy || ''] || ''}>Order {r.orderId}</span> : <span className="chip chip-warn">Order not found</span>}
              {r.cod && <span className="chip chip-warn">COD?</span>}
              {r.daysFromOrder !== null && <span className="meta">{r.daysFromOrder} days after the order</span>}
              {r.orderId && (r.contacted ? <span className="chip chip-info">Wrote first: {r.channels.join(' + ')}</span> : <span className="chip chip-danger">Never wrote to us</span>)}
            </div>
            {r.orderId && r.matchedBy && r.matchedBy !== 'order' && <div className="meta">Order found {MATCH_TEXT[r.matchedBy]}.</div>}
            {r.before3 && (
              <div style={{ fontSize: '0.8125rem' }}>
                <span className={`chip ${LEVEL_CHIP[r.before3.level] || 'chip-muted'}`}>3 days before: {r.before3.level} {r.before3.score}</span>{' '}
                {r.before3.signals.join(' · ') || 'nothing yet'}
              </div>
            )}
            {r.onDay && (
              <div style={{ fontSize: '0.8125rem' }}>
                <span className={`chip ${LEVEL_CHIP[r.onDay.level] || 'chip-muted'}`}>On the day: {r.onDay.level} {r.onDay.score}</span>{' '}
                {r.onDay.signals.join(' · ') || 'nothing'}
                {r.contacted && <div className="meta">The next step it would have shown: {r.onDay.action}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
