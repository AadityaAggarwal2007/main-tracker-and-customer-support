'use client';

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { SECTION, spin, type Alert } from './types';

// WhatsApp > Chats, brand by brand (owner 2026-10-10: "customer kuch type karke bhej raha hai to kuch to pata ho,
// chat ka system ho, brand wise"). Read only: who wrote, what, to which brand, how many are waiting. The team answers
// in Chat Support (the chat opens there) and the answer goes out on WhatsApp.
interface PanelSum { id: string; name: string; chats: number; unread: number; today: number; waiting: number }
interface Chat { id: string; name: string | null; phone: string | null; status: string; unread: number; at: string | null; last: string; lastSender: string | null; panelId: string | null; panel: string | null; automation: boolean; customerMsgs: number; subject: string | null }
const STATUS: Record<string, string> = { agent_handling: 'With team', human_needed: 'Needs you', resolved: 'Closed', ai_handling: 'With AI' };
const WHO: Record<string, string> = { visitor: 'Customer', agent: 'Team', ai: 'Chikki' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—');

export default function ChatsPanel({ token, onAlert, onOpenChat }: { token: string; onAlert: Alert; onOpenChat: (conversationId: string) => void }) {
  const [panel, setPanel] = useState<string>(() => { try { return localStorage.getItem('wa_chats_panel') || 'all'; } catch { return 'all'; } });
  const [panels, setPanels] = useState<PanelSum[]>([]);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/whatsapp/chats?panel=${encodeURIComponent(panel)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) { onAlert('error', j?.error || 'Could not read the chats'); return; }
      setPanels(j.panels || []); setChats(j.chats || []);
      if (j.error) onAlert('error', j.error);
    } catch { /* offline: the next refresh tries again */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, panel]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);
  const pick = (id: string) => { setPanel(id); setChats(null); try { localStorage.setItem('wa_chats_panel', id); } catch { /* private window */ } };
  const total = panels.reduce((a, p) => ({ chats: a.chats + p.chats, unread: a.unread + p.unread, waiting: a.waiting + p.waiting }), { chats: 0, unread: 0, waiting: 0 });

  return (
    <div className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={SECTION}>WhatsApp chats</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>A customer who writes back lands in the chat of the brand they dealt with. Open one to answer: the reply goes out on WhatsApp (within 24 hours of their message).</span>
        <button type="button" className="btn btn-sm btn-outline" style={{ marginLeft: 'auto', gap: 4 }} onClick={() => void load()}><RefreshCw size={13} /> Refresh</button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className={`seg-btn${panel === 'all' ? ' active' : ''}`} onClick={() => pick('all')}>All brands · {total.chats}{total.waiting ? ` · ${total.waiting} waiting` : ''}</button>
        {panels.map((p) => (
          <button key={p.id} type="button" className={`seg-btn${panel === p.id ? ' active' : ''}`} onClick={() => pick(p.id)}>
            {p.name} · {p.chats}{p.waiting ? ` · ${p.waiting} waiting` : ''}{p.unread ? ` · ${p.unread} unread` : ''}
          </button>
        ))}
      </div>
      {chats === null && <div className="meta"><Loader2 size={14} style={spin} /> Loading…</div>}
      {chats && chats.length === 0 && <div className="meta" style={{ fontSize: '0.8125rem' }}>No WhatsApp chats for this brand yet. A chat appears when a customer writes back after your message (or writes to the number first).</div>}
      <div style={{ display: 'grid', gap: 8 }}>
        {(chats || []).map((c) => (
          <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '0.6rem 0.75rem', display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong>{c.name || 'Customer'}</strong>
              <span className="meta" style={{ fontSize: '0.75rem' }}>{c.phone}</span>
              {panel === 'all' && c.panel && <span className="chip">{c.panel}</span>}
              <span className={`chip ${c.status === 'human_needed' ? 'chip-danger' : c.status === 'resolved' ? '' : 'chip-ok'}`}>{STATUS[c.status] || c.status}</span>
              {c.automation && <span className="chip chip-warn" title="The thread starts with a message our automation sent">Replied to automation</span>}
              {c.unread > 0 && <span className="chip chip-danger">{c.unread} new</span>}
              <span className="meta" style={{ fontSize: '0.75rem', marginLeft: 'auto' }}>{when(c.at)}</span>
              <button type="button" className="btn btn-sm btn-outline" style={{ gap: 4 }} onClick={() => onOpenChat(c.id)}><ExternalLink size={13} /> Open in Chat Support</button>
            </div>
            <div style={{ fontSize: '0.8125rem' }}>
              <span style={{ color: c.lastSender === 'visitor' ? 'var(--primary)' : 'var(--fg-muted)', fontWeight: 600 }}>{WHO[c.lastSender || ''] || '—'}:</span> {c.last || '—'}
            </div>
            {c.subject && <div className="meta" style={{ fontSize: '0.75rem' }}>{c.subject}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
