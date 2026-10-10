'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

// The red bar at the bottom of every team member's inbox (owner 2026-10-10: "team ko bottom message chala jaye"): a chat
// a member left without a reply for 30 minutes was given to the Manager (escalate-late.ts). Each alert can be closed;
// closed ones are remembered in this browser only (localStorage), and alerts older than 2 hours are gone anyway.
export interface TeamAlert { id: string; conversation_id: string; at: string; from_name: string; to_name: string; waited_min: number; customer: string | null }
const KEY = 'team_alerts_dismissed';
const readDismissed = (): string[] => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

export function TeamAlerts({ alerts, onOpen }: { alerts: TeamAlert[]; onOpen: (conversationId: string) => void }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => { setDismissed(readDismissed()); }, []);
  const shown = alerts.filter((a) => !dismissed.includes(a.id));
  if (!shown.length) return null;
  const close = (id: string) => {
    const next = [...dismissed, id].slice(-100);
    setDismissed(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private window */ }
  };
  return (
    <div className="team-alerts" role="alert" aria-live="polite">
      {shown.slice(0, 3).map((a) => (
        <div key={a.id} className="team-alert">
          <AlertTriangle size={15} style={{ flexShrink: 0 }} />
          <button type="button" className="team-alert-text" onClick={() => onOpen(a.conversation_id)} title="Open this chat">
            <b>{a.from_name}</b>&apos;s chat{a.customer ? ` (${a.customer})` : ''} waited {a.waited_min} min with no reply, given to <b>{a.to_name}</b>.
          </button>
          <button type="button" className="btn-icon" aria-label="Close this alert" onClick={() => close(a.id)}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
