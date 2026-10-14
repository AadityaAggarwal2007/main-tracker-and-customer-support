'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

// The red bar at the bottom of every team member's inbox (owner 2026-10-10: "team ko bottom message chala jaye"): a chat
// a member left without a reply for 30 minutes was given to the Manager (escalate-late.ts), or a chat with a Critical
// chargeback risk was (Chargeback Shield, src/lib/chargeback/risk-escalate.ts). Each alert can be closed;
// closed ones are remembered in this browser only (localStorage), and alerts older than 2 hours are gone anyway.
export interface TeamAlert { id: string; conversation_id: string; at: string; from_name: string; to_name: string; waited_min: number; customer: string | null; kind?: 'late' | 'risk'; order?: string | null; why?: string | null }
const KEY = 'team_alerts_dismissed';
const readDismissed = (): string[] => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

// Promises waiting 2+ days (owner 2026-10-14: "Refund aur Ship again ka vaada atak jaata hai"): one bar for the Super
// Admin and the Manager, from GET /api/refunds/counts?stuck=1 (refund/stuck.ts); a click opens the Today board. Closed
// for the day with the same list (its id carries the India day and the numbers, so a new stuck promise shows it again).
export interface StuckSummary { id: string; reshipNotSent: number; refundNoForm: number; refundWaiting: number }
const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
function stuckWords(s: StuckSummary): string {
  const parts: string[] = [];
  if (s.reshipNotSent) parts.push(`${plural(s.reshipNotSent, 'Ship again parcel', 'Ship again parcels')} not sent`);
  if (s.refundNoForm) parts.push(`${plural(s.refundNoForm, 'refund form', 'refund forms')} not sent`);
  if (s.refundWaiting) parts.push(`${plural(s.refundWaiting, 'refund request', 'refund requests')} not decided / paid`);
  return parts.join(' · ');
}

export function TeamAlerts({ alerts, onOpen, stuck, onStuck }: { alerts: TeamAlert[]; onOpen: (conversationId: string) => void; stuck?: StuckSummary | null; onStuck?: () => void }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => { setDismissed(readDismissed()); }, []);
  const shown = alerts.filter((a) => !dismissed.includes(a.id));
  const stuckShown = stuck && stuckWords(stuck) && !dismissed.includes(stuck.id) ? stuck : null;
  if (!shown.length && !stuckShown) return null;
  const close = (id: string) => {
    const next = [...dismissed, id].slice(-100);
    setDismissed(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private window */ }
  };
  return (
    <div className="team-alerts" role="alert" aria-live="polite">
      {stuckShown && (
        <div className="team-alert">
          <AlertTriangle size={15} style={{ flexShrink: 0 }} />
          <button type="button" className="team-alert-text" onClick={() => onStuck?.()} title="Open the Today board">
            <b>Promises waiting 2+ days:</b> {stuckWords(stuckShown)}. Keep them today, or the customer may raise a chargeback.
          </button>
          <button type="button" className="btn-icon" aria-label="Close for today" onClick={() => close(stuckShown.id)}><X size={14} /></button>
        </div>
      )}
      {shown.slice(0, 3).map((a) => (
        <div key={a.id} className="team-alert">
          <AlertTriangle size={15} style={{ flexShrink: 0 }} />
          <button type="button" className="team-alert-text" onClick={() => onOpen(a.conversation_id)} title="Open this chat">
            {a.kind === 'risk'
              ? <><b>Chargeback risk</b>{a.order ? ` on order ${a.order}` : ''}{a.customer ? ` (${a.customer})` : ''}{a.why ? `: ${a.why}` : ''}. Given to <b>{a.to_name}</b>.</>
              : <><b>{a.from_name}</b>&apos;s chat{a.customer ? ` (${a.customer})` : ''} waited {a.waited_min} min with no reply, given to <b>{a.to_name}</b>.</>}
          </button>
          <button type="button" className="btn-icon" aria-label="Close this alert" onClick={() => close(a.id)}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
