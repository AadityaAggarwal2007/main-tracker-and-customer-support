'use client';

import { Loader2 } from 'lucide-react';
import { agoText } from '@/app/admin/_lib/format';
import { SECTION, spin, type WaActivity } from './types';

const STATUS: Record<string, string> = { human_needed: 'Needs you', agent_handling: 'With team', ai_handling: 'With AI', resolved: 'Closed' };
const DELIVERY: Record<string, string> = { sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };

// The last WhatsApp chats and the last messages the team sent, with Meta's delivery report on each.
export default function ActivityPanel({ act, onOpenChat }: { act: WaActivity | null; onOpenChat: (id: string) => void }) {
  if (!act) return <Loader2 size={18} style={spin} />;
  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {act.error && <p className="wa-err">{act.error}</p>}
      <div className="tf-card" style={{ padding: '1.25rem' }}>
        <div style={{ ...SECTION, marginBottom: '0.5rem' }}>WhatsApp chats ({act.chats.length})</div>
        {act.chats.length === 0 && <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)' }}>No WhatsApp chat yet. Send a template from the Send tab, or have a customer write to the number.</p>}
        <div style={{ display: 'grid', gap: 4 }}>
          {act.chats.map((c) => (
            <button key={c.id} type="button" onClick={() => onOpenChat(c.id)} style={{ textAlign: 'left', border: '1px solid var(--border)', borderRadius: 10, padding: '0.5rem 0.75rem', background: 'var(--card-bg)', cursor: 'pointer', display: 'grid', gap: 2 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.8125rem' }}>
                <strong>{c.name || 'Customer'}</strong><span style={{ color: 'var(--fg-muted)' }}>{c.phone}</span>
                <span className={`chip ${c.status === 'human_needed' ? 'chip-danger' : c.status === 'resolved' ? 'chip-muted' : 'chip-primary'}`}>{STATUS[c.status] || c.status}</span>
                {c.unread > 0 && <span className="chip chip-warn">{c.unread} unread</span>}
                <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{c.panel ? `${c.panel} · ` : ''}{c.last_message_at ? agoText(new Date(c.last_message_at).getTime()) : ''}</span>
              </div>
              {c.last_message && <div style={{ fontSize: '0.8125rem', color: 'var(--fg-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.last_sender === 'visitor' ? 'Customer: ' : 'Us: '}{c.last_message}</div>}
            </button>
          ))}
        </div>
      </div>
      <div className="tf-card" style={{ padding: '1.25rem' }}>
        <div style={{ ...SECTION, marginBottom: '0.5rem' }}>Sent by the team ({act.sent.length})</div>
        {act.sent.length === 0 && <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)' }}>Nothing sent yet.</p>}
        <div style={{ display: 'grid', gap: 4 }}>
          {act.sent.map((m) => (
            <div key={m.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '0.5rem 0.75rem', display: 'grid', gap: 2, fontSize: '0.8125rem' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{m.name || m.phone || 'Customer'}</strong>
                {m.by && <span style={{ color: 'var(--fg-muted)' }}>by {m.by}</span>}
                {m.template && <span className="chip chip-primary">template {m.template}</span>}
                {m.sent === false ? <span className="chip chip-danger">Not sent</span> : m.status ? <span className={`chip ${m.status === 'failed' ? 'chip-danger' : m.status === 'read' ? 'chip-ok' : 'chip-info'}`}>{DELIVERY[m.status] || m.status}</span> : m.sent ? <span className="chip chip-info">Sent</span> : null}
                <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{agoText(new Date(m.at).getTime())}</span>
              </div>
              <div style={{ color: 'var(--fg-secondary)', whiteSpace: 'pre-wrap' }}>{m.text}</div>
              {m.error && <div style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>{m.error}</div>}
              <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start', padding: 0 }} onClick={() => onOpenChat(m.conversationId)}>Open the chat</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
