'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';

// ── Office hours & holidays (owner 2026-10-05) ──────────────────────────────────
// Shown in Team (Super Admin only). The week is fixed in code (src/lib/office-hours.ts:
// Monday to Friday 10:00-19:30, Saturday 10:00-14:00, Sunday off); the holidays are the days
// the Super Admin lists here (/api/team/holidays, one date per line). On those days the office
// counts as closed all day: customers handed to the team hear when it opens next ("on Tuesday
// morning, after 10 AM"), an upset customer gets Chikki's closed-hours note, and nobody is "away".
export default function OfficeHoursCard({ token, onAlert }: { token: string | null; onAlert: (type: string, message: string) => void }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState<string[]>([]);
  const [week, setWeek] = useState<{ weekdays: string; saturday: string; sunday: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch('/api/team/holidays', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const d = await r.json();
      setSaved(d.holidays || []); setText((d.holidays || []).join('\n')); setWeek(d.week || null); setLoaded(true);
    } catch { /* the card stays empty */ }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const r = await fetch('/api/team/holidays', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });
      const d = await r.json();
      if (!r.ok) { onAlert('error', d.error || 'Could not save'); return; }
      setSaved(d.holidays || []); setText((d.holidays || []).join('\n'));
      onAlert('success', d.holidays?.length ? `Saved: ${d.holidays.length} holiday${d.holidays.length === 1 ? '' : 's'}` : 'Saved: no holidays');
    } catch { onAlert('error', 'Could not save'); }
    finally { setBusy(false); }
  };

  const dirty = text.trim() !== saved.join('\n');
  return (
    <div className="tf-card" style={{ padding: '0.875rem 1.25rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <CalendarClock size={16} />
        <span style={{ fontWeight: 700, fontSize: '0.875rem' }}>Office hours &amp; holidays</span>
      </div>
      <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
        Monday to Friday {week?.weekdays || '10:00-19:30'}, Saturday {week?.saturday || '10:00-14:00'}, Sunday {week?.sunday || 'off'} (India time).
        While the office is closed, a customer handed to the team is told when it opens next, and a very upset customer is told honestly that the office is closed and that the team sits down with their case first thing when it opens.
        Add the days the office is closed below, one date per line (for example 2026-11-08). Nothing is sent to anyone when you save.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={'2026-11-08\n2026-11-09'} disabled={!loaded}
          style={{ fontFamily: 'inherit', fontSize: '0.8125rem', minWidth: 180, flex: '0 1 220px', padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', color: 'inherit' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button className="btn btn-primary" onClick={save} disabled={busy || !loaded || !dirty}>{busy ? 'Saving…' : 'Save holidays'}</button>
          <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>{saved.length ? `${saved.length} listed` : 'None listed'}</span>
        </div>
      </div>
    </div>
  );
}
