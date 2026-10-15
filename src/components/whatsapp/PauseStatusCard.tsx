'use client';

// ── WhatsApp > Automation: the number's status (owner 2026-10-15: "pause ka koi option banade automation ma jissa pata
// chal jaee ki meta na pause kia ha kab tak resume ho jaega yeh sab") ──
// Paused (by Meta's 130429 or by hand) until when, with a live countdown; or sending slowly until when; or normal.
// Meta's words, its last refusal, which refusal of the last 2 hours it was, how long the next pause would be; the order
// messages due now and the alerts waiting. Pause now (15 / 30 / 60 / 120 min) and Resume now. Super Admin only (the tab).
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Pause, Play } from 'lucide-react';
import { FIRST_AFTER_QUIET_TEXT, SEND_RATES, type PauseView, type SendRate } from '@/lib/chat/whatsapp-auto-rules';
import type { AutoOverview, NumberHealth } from '@/lib/chat/whatsapp-auto';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
function inText(ms: number): string {
  if (ms <= 0) return 'any moment now';
  const m = Math.ceil(ms / 60000);
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
}
const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
// Meta's words for the number, as chips: GREEN / CONNECTED are fine, anything else stands out (whatsapp-health-rules.ts).
const chipTone = (v: string, good: string[]) => (good.includes(v) ? 'chip-ok' : v === 'UNKNOWN' ? 'chip-warn' : 'chip-danger');
const n = (x: number) => x.toLocaleString('en-IN');

export default function PauseStatusCard({ info, ordersDue, alertsWaiting, busy, health, rate, foreign, onPause, onResume, onRate }: {
  info: PauseView; ordersDue: number; alertsWaiting: number; busy: boolean;
  health?: NumberHealth | null;   // Meta's side of the number (owner 2026-10-15): quality, status, messaging limit
  rate?: SendRate | null;         // the chosen speed (owner 2026-10-15, "har minute 2, 3, 4 message")
  foreign?: AutoOverview['foreign'] | null;   // another app on the number (owner 2026-10-15): reports for messages we never sent
  onPause: (minutes: number) => void; onResume: () => void; onRate?: (perMinute: number) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const [mins, setMins] = useState(30);
  const chosen = rate?.perMinute ?? info.perMinute ?? 2;
  const [pick, setPick] = useState(chosen);
  useEffect(() => { setPick(chosen); }, [chosen]);
  const paused = info.state === 'paused' && !!info.until && Date.parse(info.until) > now;
  const tone = paused ? 'var(--danger, #b91c1c)' : info.state === 'slow' ? '#b45309' : 'var(--success, #15803d)';
  const perMin = Math.max(1, Math.round(60000 / (info.sendEveryMs || 30000)));
  const limitAt = health?.limitFreeAt ? time(health.limitFreeAt) : null;
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
              ? `Sending slowly: ${perMin} order message${perMin === 1 ? '' : 's'} a minute${info.slowUntil ? ` until ${time(info.slowUntil)}` : ''}`
              : `Sending normally: ${perMin} order message${perMin === 1 ? '' : 's'} a minute`}
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
      {/* the speed (owner 2026-10-15, "button se set kar sakein ki har minute 2, 3, 4 message"): 1-4 order messages a minute */}
      {onRate && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.8125rem' }}>
          <label htmlFor="wa-rate" style={{ fontWeight: 600 }}>Order messages per minute:</label>
          <select id="wa-rate" className="form-input" style={{ height: '2rem', width: 'auto' }} value={pick} onChange={(e) => setPick(Number(e.target.value))} disabled={busy}>
            {SEND_RATES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button type="button" className="btn btn-outline btn-sm" disabled={busy || pick === chosen} onClick={() => onRate(pick)}>Save</button>
          <span className="meta" style={{ fontSize: '0.78rem' }}>
            Now {chosen} a minute (one every {Math.round(60 / chosen)} s){rate?.by ? `, set by ${rate.by}` : ', the default'}. After a refusal from Meta it is 1 a minute for two hours (never faster than the number you pick). Alerts and test messages do not wait for this.
          </span>
        </div>
      )}
      {/* the daily limit (owner 2026-10-15): at the limit new customers wait; a refusal near the limit = the real limit is likely 250 */}
      {health?.limitReached && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8125rem', color: 'var(--danger, #b91c1c)', fontWeight: 600 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>Daily limit reached: {n(health.used24h)} / {n(health.limit || 0)} in the last 24 h — new customers wait until the oldest drops out{limitAt ? ` (about ${limitAt})` : ''}. Customers messaged in the last 24 h still get their message; nothing is lost, the rows wait in line.</span>
        </div>
      )}
      {health?.refusedNearLimit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8125rem', color: 'var(--danger, #b91c1c)', fontWeight: 600 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{health.refusedNearLimit}</span>
        </div>
      )}
      {/* the refusal hit the FIRST message after a quiet stretch (owner 2026-10-15): Meta's side, not our speed */}
      {info.firstAfterQuiet && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8125rem', color: 'var(--danger, #b91c1c)', fontWeight: 600 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{FIRST_AFTER_QUIET_TEXT}</span>
        </div>
      )}
      {/* another app on the number (owner 2026-10-15, "we need evidence"): Meta's reports today for messages ShipTrack never
          sent, red when there are any; while Meta refuses us and none were seen, the honest other answer */}
      {foreign?.line && (
        <div className="wa-foreign" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8125rem', color: foreign.line.tone === 'danger' ? 'var(--danger, #b91c1c)' : 'inherit', fontWeight: foreign.line.tone === 'danger' ? 600 : 400 }}>
          {foreign.line.tone === 'danger' && <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} />}
          <span>
            {foreign.line.text}
            {foreign.line.tone === 'danger' && foreign.hours.length > 0 && (
              <span className="meta" style={{ display: 'block', fontWeight: 400, marginTop: 2 }}>
                By India hour: {foreign.hours.map((h) => `${h.hour}:00 → ${h.sent} sent${h.failed ? `, ${h.failed} failed` : ''}`).join(' · ')}
                {foreign.lastError ? ` · last failure: ${foreign.lastError}` : ''}
              </span>
            )}
          </span>
        </div>
      )}
      {/* Meta's side of the number: what WhatsApp Manager shows, read at most every 5 minutes */}
      {health && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.78rem' }}>
          <span className="meta">Meta&apos;s side:</span>
          <span>quality <span className={`chip ${chipTone(health.quality, ['GREEN'])}`}>{health.quality}</span></span>
          <span>status <span className={`chip ${chipTone(health.status, ['CONNECTED'])}`}>{health.status}</span></span>
          <span>
            messaging limit{' '}
            <strong>{health.limit ? `${n(health.limit)} customers a day` : health.tier === 'TIER_UNLIMITED' ? 'unlimited' : 'not known'}</strong>
            {health.limit ? <span className="meta"> ({health.limitFrom === 'meta' ? `Meta's ${health.tier}` : 'typed in WhatsApp > Setup'})</span> : null}
          </span>
          <span className="meta">· {n(health.usedToday)} customers messaged today, {n(health.used24h)} in the last 24 h</span>
          {health.error && <span style={{ color: '#b45309' }}>Could not read the number from Meta: {health.error}</span>}
        </div>
      )}
      {health && health.lines.filter((l) => l.tone !== 'ok' && !/^Daily limit reached/.test(l.text)).map((l) => (
        <div key={l.text} style={{ fontSize: '0.78rem', color: l.tone === 'danger' ? 'var(--danger, #b91c1c)' : '#b45309' }}>{l.text}</div>
      ))}
      {info.lastRefusalAt && (
        <div className="meta" style={{ fontSize: '0.78rem' }}>
          Meta&apos;s last refusal: {time(info.lastRefusalAt)} · the {ordinal(info.strikes)} in the last 2 hours. If Meta refuses again{paused ? ' after it resumes' : ''}, the number stops for {info.nextPauseMin} min.
          {info.state !== 'normal' && info.slowUntil && !paused ? ` Back to ${chosen} a minute at ${time(info.slowUntil)} if Meta refuses nothing more.` : ''}
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
