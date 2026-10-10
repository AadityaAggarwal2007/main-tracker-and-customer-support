'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import MetaError from './MetaError';
import PhoneThread, { tickOf, type ThreadMessage } from './PhoneThread';
import { SECTION, label, spin, type Alert, type WaActivity, type WaProfileData, type WaSettings } from './types';

// Test screen (owner 2026-10-10: "testing ko whatsapp ke tab mein"): pick a number, send a plain text, and watch the
// whole conversation on the phone as it happens: ours with Meta's delivery ticks, the customer's replies coming in.
// The number must have written to us in the last 24 hours for a plain text (Meta's rule); otherwise the Send tab.
export default function TestPanel({ token, s, prof, act, onAlert, goSend, goActivity }: {
  token: string; s: WaSettings | null; prof: WaProfileData | null; act: WaActivity | null; onAlert: Alert; goSend: () => void; goActivity: () => void;
}) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [to, setTo] = useState(() => { try { return localStorage.getItem('wa_test_to') || ''; } catch { return ''; } });
  const [text, setText] = useState('Test message from ShipTrack');
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<ThreadMessage[]>([]);
  const [name, setName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errCode, setErrCode] = useState<number | null>(null);
  const [sentOk, setSentOk] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const digits = to.replace(/\D/g, '');
  const valid = digits.length >= 10;

  // First visit with no number saved: the latest WhatsApp chat's number.
  useEffect(() => {
    if (to || !act || !act.chats[0]?.phone) return;
    setTo(act.chats[0].phone.replace(/^\+91/, ''));
  }, [act, to]);

  const load = useCallback(async (quiet = false) => {
    if (!valid) { setMsgs([]); return; }
    if (!quiet) setLoading(true);
    try {
      const r = await fetch(`/api/whatsapp/thread?to=${encodeURIComponent(digits)}`, { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (r.ok && j) { setMsgs(j.messages || []); setName(j.name || null); }
    } finally { if (!quiet) setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits, valid, token]);

  // Live: every 4 seconds while the tab is open and the page is visible.
  useEffect(() => {
    void load();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') void load(true); }, 4000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  const send = async () => {
    setBusy(true); setError(''); setErrCode(null); setSentOk('');
    try {
      try { localStorage.setItem('wa_test_to', to); } catch { /* private window */ }
      const r = await fetch('/api/whatsapp/test-send', { method: 'POST', headers: auth, body: JSON.stringify({ to, text }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || 'WhatsApp did not take it'); setErrCode(typeof j.code === 'number' ? j.code : null); await load(true); return; }
      setSentOk('Meta accepted it. Watch the ticks on the phone: ✓ sent, ✓✓ delivered, blue ✓✓ read.');
      onAlert('success', 'Sent on WhatsApp');
      await load(true);
    } finally { setBusy(false); }
  };

  const lastOurs = [...msgs].reverse().find((m) => m.from === 'us');
  const lastTick = lastOurs ? tickOf(lastOurs) : null;
  const windowOpen = (() => {
    const lastCustomer = [...msgs].reverse().find((m) => m.from === 'customer');
    return lastCustomer ? Date.now() - new Date(lastCustomer.at).getTime() < 24 * 3600e3 : false;
  })();
  const recent = (act?.chats || []).filter((c) => c.phone).slice(0, 5);

  return (
    <div className="wa-layout">
      <div style={{ display: 'grid', gap: '1rem' }}>
        <div className="tf-card" style={{ padding: '1.25rem' }}>
          <div style={{ ...SECTION, marginBottom: '0.25rem' }}>Test: send a message and watch it</div>
          <p style={{ fontSize: '0.78rem', color: 'var(--fg-muted)', margin: '0 0 0.75rem' }}>
            The phone on the right is the customer&apos;s side: what we send appears with its ticks, and whatever they reply shows up by itself (it refreshes every few seconds).
            A plain text goes only if that number wrote to us in the last 24 hours; otherwise use a template on the <button type="button" onClick={goSend} style={{ background: 'none', border: 0, padding: 0, color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline' }}>Send tab</button>.
          </p>
          <form onSubmit={(e) => { e.preventDefault(); void send(); }} style={{ display: 'grid', gap: '0.5rem' }}>
            <label><span style={label}>WhatsApp number (10 digits = India)</span><input className="form-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="98765 43210" inputMode="tel" /></label>
            {recent.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Recent:</span>
                {recent.map((c) => <button key={c.id} type="button" className="chip chip-primary" style={{ cursor: 'pointer', border: 0 }} onClick={() => setTo((c.phone || '').replace(/^\+91/, ''))}>{c.name || c.phone} · {c.phone}</button>)}
              </div>
            )}
            <label><span style={label}>Message</span><textarea className="form-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} style={{ height: 'auto' }} /></label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {valid && <span className={`chip ${windowOpen ? 'chip-ok' : 'chip-warn'}`}>{msgs.length === 0 ? 'No chat with this number yet' : windowOpen ? 'They wrote in the last 24 hours: a text will go' : 'Over 24 hours since they wrote: needs a template'}</span>}
              <button type="submit" className="btn btn-primary" style={{ marginLeft: 'auto', gap: 6 }} disabled={busy || !valid || !text.trim()}>{busy ? <Loader2 size={14} style={spin} /> : <Send size={14} />} Send on WhatsApp</button>
            </div>
          </form>
          {error && (
            <div style={{ marginTop: '0.75rem' }}>
              <MetaError error={error} />
              {(errCode === 131047 || /24 hours/.test(error)) && <button type="button" className="btn btn-sm btn-outline" onClick={goSend}>Send a template instead</button>}
            </div>
          )}
          {sentOk && <p style={{ margin: '0.75rem 0 0', fontSize: '0.8125rem', color: 'var(--success, #15803d)' }}>{sentOk}</p>}
          {lastTick && lastOurs && <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: 'var(--fg-secondary)' }}>Last message we sent: <strong>{lastTick.label || 'waiting for Meta'}</strong>{lastOurs.error ? ` · ${lastOurs.error}` : ''}</p>}
        </div>
        <div className="tf-card" style={{ padding: '1.25rem', fontSize: '0.8125rem', color: 'var(--fg-muted)', display: 'grid', gap: 4 }}>
          <div style={{ ...SECTION, marginBottom: '0.25rem' }}>How to test, step by step</div>
          <div>1. Put the number and a message, press Send. The message shows on the phone with ✓.</div>
          <div>2. Meta then reports <strong>✓✓ delivered</strong> and <strong>blue ✓✓ read</strong>: those come in through the webhook, so this also proves the webhook works.</div>
          <div>3. Reply from the real phone: the reply appears here on the left within a few seconds, and in Chat Support &gt; With team.</div>
          <div>4. Nothing shows? Open the <button type="button" onClick={goActivity} style={{ background: 'none', border: 0, padding: 0, color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline' }}>Activity tab</button> or Setup &gt; Check token.</div>
        </div>
      </div>
      <PhoneThread name={name || (valid ? `+91 ${digits.slice(-10)}` : 'Customer')} phone={to} picture={null} messages={msgs} loading={loading} />
    </div>
  );
}
