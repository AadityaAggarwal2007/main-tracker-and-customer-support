'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, Loader2, RefreshCw } from 'lucide-react';
import { activeHeaders } from '@/lib/presence-client';
import type { TeamLive as Live } from '@/lib/chat/team-live';
import { minutesText } from '../_lib/inbox';
import { Chip } from './chips';

// The Manager's "Team live" (owner 2026-10-10, step 5: "har 30 minute me har team member ki kitni chats hui hain";
// Chikki's work recorded too). Reads GET /api/chat/team/live every minute while the tab is visible. Read only.
export default function TeamLive({ token }: { token: string }) {
  const [data, setData] = useState<Live | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      const res = await fetch('/api/chat/team/live', { headers: { Authorization: `Bearer ${token}`, ...activeHeaders() } });
      const j = await res.json();
      if (res.ok) { setData(j); setErr(''); } else setErr(j.error || 'Could not read the team board');
    } catch { setErr('Could not read the team board'); }
    finally { setBusy(false); }
  }, [token]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) {
    return <div className="tl-wrap"><div className="tl-empty">{err || <Loader2 size={18} style={{ animation: 'spin 0.6s linear infinite' }} />}</div></div>;
  }
  const max = Math.max(1, ...data.members.flatMap((m) => m.slots), ...data.chikki.slots);
  const cell = (n: number, i: number) => (
    <td key={i} className="tl-cell" title={`${n} repl${n === 1 ? 'y' : 'ies'}`}>
      {n > 0 && <span className="tl-dot" style={{ opacity: 0.35 + 0.65 * (n / max) }}>{n}</span>}
    </td>
  );
  const c = data.chikki;
  return (
    <div className="tl-wrap">
      <div className="tl-head">
        <div>
          <div className="tl-title">Team live</div>
          <div className="meta">Today from 10:00 · {data.officeOpen ? 'Office open' : 'Office closed'} · replies in each half hour</div>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={busy}><RefreshCw size={14} /> Refresh</button>
      </div>
      {err && <div className="chat-note" style={{ color: 'var(--danger)' }}>{err}</div>}

      <div className={`tl-chikki${c.ok ? '' : ' tl-chikki-down'}`}>
        <Bot size={18} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>Chikki</b> {c.ok ? 'is answering customers.' : `is NOT answering: ${c.text ?? 'every model failed'}.`}
          <div className="meta">{c.repliesToday} replies today · {c.aloneToday} chats handled alone · {c.handedToday} handed to the team · {c.autoMarksToday} Refund / Ship again marks</div>
        </div>
      </div>

      <div className="tl-scroll">
        <table className="tl-table">
          <thead>
            <tr>
              <th className="tl-name">Who</th>
              <th>Now</th>
              <th title="Open chats they hold">Chats</th>
              <th title="Of those, customers waiting for an answer">Waiting</th>
              <th title="Replies today">Replies</th>
              <th title="Chats moved to the Manager after 30 minutes without a reply">Missed 30 min</th>
              {data.slotLabels.map((l) => <th key={l} className="tl-slot">{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.key}>
                <td className="tl-name">{m.name}{m.lead && <span className="meta"> · Manager</span>}</td>
                <td>{m.onDuty ? <Chip tone="ok">On duty</Chip>
                  : m.seenMin === null ? <Chip tone="muted">Not in today</Chip>
                  : <Chip tone="warn">{`Away ${minutesText(m.seenMin)}`}</Chip>}</td>
                <td>{m.held}</td>
                <td>{m.waiting > 0 ? <Chip tone="danger">{m.waiting}</Chip> : 0}</td>
                <td><b>{m.repliesToday}</b></td>
                <td>{m.movedToManager > 0 ? <Chip tone="danger">{m.movedToManager}</Chip> : 0}</td>
                {m.slots.map(cell)}
              </tr>
            ))}
            <tr className="tl-ai-row">
              <td className="tl-name"><Bot size={13} style={{ verticalAlign: -2 }} /> Chikki</td>
              <td>{c.ok ? <Chip tone="ok">Answering</Chip> : <Chip tone="danger">Down</Chip>}</td>
              <td>-</td><td>-</td>
              <td><b>{c.repliesToday}</b></td>
              <td>-</td>
              {c.slots.map(cell)}
            </tr>
          </tbody>
        </table>
      </div>
      {data.members.length === 0 && <div className="tl-empty">No team member who replies to chats in these panels.</div>}
    </div>
  );
}
