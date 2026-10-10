'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, Send } from 'lucide-react';
import PhoneThread, { type ThreadMessage } from './PhoneThread';
import { SECTION, spin, type Alert } from './types';

// WhatsApp > Chats, brand by brand (owner 2026-10-10: "customer kuch type karke bhej raha hai to kuch to pata ho,
// chat ka system ho, brand wise"). Read only: who wrote, what, to which brand, how many are waiting. The team answers
// in Chat Support (the chat opens there) and the answer goes out on WhatsApp.
interface PanelSum { id: string; name: string; chats: number; unread: number; today: number; waiting: number }
interface Chat { id: string; name: string | null; phone: string | null; status: string; unread: number; at: string | null; last: string; lastSender: string | null; panelId: string | null; panel: string | null; automation: boolean; customerMsgs: number; subject: string | null }
const STATUS: Record<string, string> = { agent_handling: 'With team', human_needed: 'Needs you', resolved: 'Closed', ai_handling: 'With AI' };
const WHO: Record<string, string> = { visitor: 'Customer', agent: 'Team', ai: 'Chikki' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—');

export default function ChatsPanel({ token, onAlert, onOpenChat, goSend }: { token: string; onAlert: Alert; onOpenChat: (conversationId: string) => void; goSend: () => void }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [panel, setPanel] = useState<string>(() => { try { return localStorage.getItem('wa_chats_panel') || 'all'; } catch { return 'all'; } });
  const [panels, setPanels] = useState<PanelSum[]>([]);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<ThreadMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const openRef = useRef<string | null>(null);
  const lastErr = useRef('');
  const warn = (msg: string) => { if (msg !== lastErr.current) { lastErr.current = msg; onAlert('error', msg); } };
  useEffect(() => { openRef.current = open; }, [open]);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/whatsapp/chats?panel=${encodeURIComponent(panel)}`, { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) { warn(j?.error || 'Could not read the chats'); return; }
      setPanels(j.panels || []); setChats(j.chats || []);
      if (j.error) warn(j.error); else lastErr.current = '';
    } catch { /* offline: the next refresh tries again */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, panel]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  // The open chat: read live every few seconds (opening it clears its unread count, as the inbox does).
  const readThread = useCallback(async (id: string, first = false) => {
    if (first) setLoadingThread(true);
    try {
      const r = await fetch(`/api/whatsapp/thread?conversation=${encodeURIComponent(id)}&read=1`, { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (openRef.current !== id) return;            // another chat was opened meanwhile
      if (r.ok && j && Array.isArray(j.messages)) setMsgs(j.messages);
    } catch { /* the next try */ } finally { if (first) setLoadingThread(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => {
    if (!open) return;
    void readThread(open, true);
    const t = setInterval(() => { if (document.visibilityState === 'visible') void readThread(open); }, 5_000);
    return () => clearInterval(t);
  }, [open, readThread]);

  const pick = (id: string) => { setPanel(id); setChats(null); setOpen(null); try { localStorage.setItem('wa_chats_panel', id); } catch { /* private window */ } };
  const choose = (id: string) => { setOpen(id); setMsgs([]); setText(''); };
  const send = async () => {
    const body = text.trim();
    if (!open || !body || sending) return;
    setSending(true);
    try {
      const r = await fetch('/api/chat/messages', { method: 'POST', headers: auth, body: JSON.stringify({ conversationId: open, content: body }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not send it'); return; }
      if (j.whatsapp && j.whatsapp.ok === false) onAlert('error', `Saved, but WhatsApp did not take it: ${j.whatsapp.error || 'unknown reason'}. After 24 hours of silence only a template can go (Send tab).`);
      setText(''); await readThread(open); await load();
    } finally { setSending(false); }
  };
  const total = panels.reduce((a, p) => ({ chats: a.chats + p.chats, unread: a.unread + p.unread, waiting: a.waiting + p.waiting }), { chats: 0, unread: 0, waiting: 0 });
  const cur = (chats || []).find((c) => c.id === open) || null;

  return (
    <div className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={SECTION}>WhatsApp chats</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>A customer who writes back lands in the chat of the brand they dealt with. Click a chat to read it and answer right here: the reply goes out on WhatsApp (within 24 hours of their message).</span>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
          {chats === null && <div className="meta"><Loader2 size={14} style={spin} /> Loading…</div>}
          {chats && chats.length === 0 && <div className="meta" style={{ fontSize: '0.8125rem' }}>No WhatsApp chats for this brand yet. A chat appears when a customer writes back after your message (or writes to the number first).</div>}
          {(chats || []).map((c) => (
            <button key={c.id} type="button" onClick={() => choose(c.id)} style={{ textAlign: 'left', border: `1px solid ${open === c.id ? 'var(--primary)' : 'var(--border)'}`, background: open === c.id ? 'var(--bg-subtle, rgba(124,58,237,0.06))' : 'transparent', borderRadius: 10, padding: '0.6rem 0.75rem', display: 'grid', gap: 4, cursor: 'pointer', font: 'inherit', color: 'inherit' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <strong>{c.name || 'Customer'}</strong>
                <span className="meta" style={{ fontSize: '0.75rem' }}>{c.phone}</span>
                {panel === 'all' && c.panel && <span className="chip">{c.panel}</span>}
                {c.automation && <span className="chip chip-warn" title="The thread starts with a message our automation sent">Replied to automation</span>}
                {c.unread > 0 && <span className="chip chip-danger">{c.unread} new</span>}
                <span className="meta" style={{ fontSize: '0.72rem', marginLeft: 'auto' }}>{when(c.at)}</span>
              </div>
              <div style={{ fontSize: '0.8125rem' }}>
                <span style={{ color: c.lastSender === 'visitor' ? 'var(--primary)' : 'var(--fg-muted)', fontWeight: 600 }}>{WHO[c.lastSender || ''] || '—'}:</span> {c.last || '—'}
              </div>
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
          {!open && <div className="meta" style={{ fontSize: '0.8125rem', padding: '2rem 0' }}>Click a chat on the left to read it and answer.</div>}
          {open && cur && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', width: '100%' }}>
              <span className="chip">{STATUS[cur.status] || cur.status}</span>
              {cur.panel && <span className="chip">{cur.panel}</span>}
              <button type="button" className="btn btn-sm btn-outline" style={{ gap: 4, marginLeft: 'auto' }} onClick={() => onOpenChat(cur.id)}><ExternalLink size={13} /> Open in Chat Support</button>
            </div>
          )}
          {open && (
            <>
              <PhoneThread
                name={cur?.name || cur?.phone || 'Customer'} phone={cur?.phone || ''} picture={null} messages={msgs} loading={loadingThread}
                composer={(
                  <div className="wa-compose" style={{ alignItems: 'flex-end' }}>
                    <textarea
                      value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Type a reply…"
                      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
                      style={{ flex: 1, background: '#fff', border: 0, borderRadius: 14, padding: '7px 12px', font: 'inherit', fontSize: '0.8rem', resize: 'none', outline: 'none' }}
                    />
                    <button type="button" onClick={() => void send()} disabled={sending || !text.trim()} aria-label="Send" style={{ width: 34, height: 34, borderRadius: '50%', border: 0, background: '#00a884', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer', opacity: sending || !text.trim() ? 0.5 : 1 }}>
                      {sending ? <Loader2 size={14} style={spin} /> : <Send size={14} />}
                    </button>
                  </div>
                )}
              />
              <div className="meta" style={{ fontSize: '0.72rem', textAlign: 'center' }}>Cmd/Ctrl + Enter sends. More than 24 hours since they wrote? Use a template from the <button type="button" onClick={goSend} style={{ background: 'none', border: 0, padding: 0, color: 'var(--primary)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}>Send tab</button>.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
