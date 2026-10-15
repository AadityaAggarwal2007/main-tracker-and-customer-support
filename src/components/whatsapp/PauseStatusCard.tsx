'use client';

// ── WhatsApp > Automation: the number's status (owner 2026-10-15: "pause ka koi option banade automation ma jissa pata
// chal jaee ki meta na pause kia ha kab tak resume ho jaega yeh sab") ──
// Paused (by Meta's 130429 or by hand) until when, with a live countdown; or sending slowly until when; or normal.
// Meta's words, its last refusal, which refusal of the last 2 hours it was, how long the next pause would be; the order
// messages due now and the alerts waiting. Pause now (15 / 30 / 60 / 120 min) and Resume now. Super Admin only (the tab).
import { useEffect, useState } from 'react';
import { Loader2, Pause, Play } from 'lucide-react';
import type { PauseView } from '@/lib/chat/whatsapp-auto-rules';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
function inText(ms: number): string {
  if (ms <= 0) return 'any moment now';
  const m = Math.ceil(ms / 60000);
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
}
const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

export default function PauseStatusCard({ info, ordersDue, alertsWaiting, busy, onPause, onResume }: {
  info: PauseView; ordersDue: number; alertsWaiting: number; busy: boolean;
  onPause: (minutes: number) => void; onResume: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const [mins, setMins] = useState(30);
  const paused = info.state === 'paused' && !!info.until && Date.parse(info.until) > now;
  const tone = paused ? 'var(--danger, #b91c1c)' : info.state === 'slow' ? '#b45309' : 'var(--success, #15803d)';
  const perMin = Math.max(1, Math.round(60000 / (info.sendEveryMs || 30000)));
  const resume = () => {
    const text = info.manual
      ? 'Resume sending order messages now?'
      : 'Meta paused this number for sending too many messages. Resuming early may make Meta refuse again and the next pause longer. Resume now anyway?';
    if (window.confirm(text)) onResume();
  };

  return (
    <div className="tf-card" style={{ padding: '0.75rem 1rem', borderLeft: `4px solid ${tone}`, display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.9rem', color: tone }}>
          {paused
            ? `${info.manual ? `Paused by ${info.by || 'you'}` : 'Paused by Meta (130429)'} · resumes at ${time(info.until!)} (${inText(Date.parse(info.until!) - now)})`
            : info.state === 'slow'
              ? `Sending slowly: 1 order message a minute${info.slowUntil ? ` until ${time(info.slowUntil)}` : ''}`
              : `Sending normally: ${perMin} order messages a minute`}
        </strong>
        <span style={{ flex: 1 }} />
        {paused ? (
          <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={resume}>
            {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Resume now
          </button>
        ) : (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select className="form-input" style={{ height: '2rem', width: 'auto' }} value={mins} onChange={(e) => setMins(Number(e.target.value))} aria-label="Pause for">
              {[15, 30, 60, 120].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}
            </select>
            <button type="button" className="btn btn-outline btn-sm" disabled={busy}
              onClick={() => { if (window.confirm(`Stop sending order messages for ${mins} minutes? Chargeback alerts and test messages still go.`)) onPause(mins); }}>
              {busy ? <Loader2 size={14} className="spin" /> : <Pause size={14} />} Pause now
            </button>
          </span>
        )}
      </div>
      {paused && !info.manual && info.reason && <div className="meta" style={{ fontSize: '0.78rem' }}>Meta said: {info.reason}</div>}
      {info.lastRefusalAt && (
        <div className="meta" style={{ fontSize: '0.78rem' }}>
          Meta&apos;s last refusal: {time(info.lastRefusalAt)} · the {ordinal(info.strikes)} in the last 2 hours. If Meta refuses again{paused ? ' after it resumes' : ''}, the number stops for {info.nextPauseMin} min.
          {info.state !== 'normal' && info.slowUntil && !paused ? ` Back to 2 a minute at ${time(info.slowUntil)} if Meta refuses nothing more.` : ''}
        </div>
      )}
      {!info.lastRefusalAt && !paused && <div className="meta" style={{ fontSize: '0.78rem' }}>No refusal from Meta in the last 2 hours.</div>}
      {info.resumedBy && !paused && <div className="meta" style={{ fontSize: '0.78rem' }}>The last pause was ended early by {info.resumedBy}.</div>}
      <div className="meta" style={{ fontSize: '0.78rem' }}>
        Order messages due now: <strong>{ordersDue}</strong>
        {ordersDue > 0 ? ` (about ${Math.ceil(ordersDue / (paused ? 1 : perMin))} min to send them once ${paused ? 'it resumes' : 'their turn comes'})` : ''}
        {' · '}ShipTrack alerts waiting: <strong>{alertsWaiting}</strong>{alertsWaiting > 0 ? ' (they go first; order messages wait for them)' : ''}.
        {' '}Chargeback alerts and test messages go even while paused; nothing is lost while paused, the messages wait in line.
      </div>
    </div>
  );
}
