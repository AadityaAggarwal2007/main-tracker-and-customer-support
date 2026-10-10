'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Columns3, ExternalLink, List, Loader2, RefreshCw, Send, X } from 'lucide-react';
import PhoneThread, { type ThreadMessage } from './PhoneThread';
import { SECTION, spin, type Alert } from './types';

// WhatsApp > Chats (owner 2026-10-10: "chat ka system ho, brand wise", then "ek whatsapp chat ka column bana brand
// wise, taaki pata chale kya ho raha hai"). Default view = a BOARD: one column per brand side by side, each with its
// chats (who wrote last, waiting / new, "Replied to automation"); the old one-list view stays as a switch. A click
// opens the chat in a drawer on the right: the thread as WhatsApp draws it and a reply box (the normal reply route,
// so the same holder / WhatsApp rules as the inbox). Every panel gets a column; none is hard-coded.
interface PanelSum { id: string; name: string; chats: number; unread: number; today: number; waiting: number }
interface Chat { id: string; name: string | null; phone: string | null; status: string; unread: number; at: string | null; last: string; lastSender: string | null; panelId: string | null; panel: string | null; automation: boolean; customerMsgs: number; subject: string | null }
interface Sent { id: string; panelId: string; orderId: string; kind: string; status: string; phone: string | null; text: string; template: string | null; error: string | null; at: string; name: string | null; replied: boolean }
const TICK: Record<string, string> = { sent: '✓ sent', delivered: '✓✓ delivered', read: '✓✓ read', failed: '! failed' };
const STATUS: Record<string, string> = { agent_handling: 'With team', human_needed: 'Needs you', resolved: 'Closed', ai_handling: 'With AI' };
const WHO: Record<string, string> = { visitor: 'Customer', agent: 'Team', ai: 'Chikki' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—');
const waiting = (c: Chat) => c.status !== 'resolved' && c.lastSender === 'visitor';

export default function ChatsPanel({ token, onAlert, onOpenChat, goSend }: { token: string; onAlert: Alert; onOpenChat: (conversationId: string) => void; goSend: () => void }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [view, setView] = useState<'board' | 'list'>(() => { try { return localStorage.getItem('wa_chats_view') === 'list' ? 'list' : 'board'; } catch { return 'board'; } });
  const [panel, setPanel] = useState<string>(() => { try { return localStorage.getItem('wa_chats_panel') || 'all'; } catch { return 'all'; } });
  const [panels, setPanels] = useState<PanelSum[]>([]);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [sent, setSent] = useState<Sent[]>([]);
  const [openSent, setOpenSent] = useState<Sent | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<ThreadMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const openRef = useRef<string | null>(null);
  const lastErr = useRef('');
  const warn = (msg: string) => { if (msg !== lastErr.current) { lastErr.current = msg; onAlert('error', msg); } };
  useEffect(() => { openRef.current = open; }, [open]);
  const scope = view === 'board' ? 'all' : panel;

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/whatsapp/chats?panel=${encodeURIComponent(scope)}`, { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) { warn(j?.error || 'Could not read the chats'); return; }
      setPanels(j.panels || []); setChats(j.chats || []); setSent(Array.isArray(j.sent) ? j.sent : []);
      if (j.error) warn(j.error); else lastErr.current = '';
    } catch { /* offline: the next refresh tries again */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, scope]);
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
  useEffect(() => {
    if ((!open && !openSent) || view !== 'board') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(null); setOpenSent(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, openSent, view]);

  const switchView = (v: 'board' | 'list') => { setView(v); setChats(null); try { localStorage.setItem('wa_chats_view', v); } catch { /* private window */ } };
  const pick = (id: string) => { setPanel(id); setChats(null); setOpen(null); try { localStorage.setItem('wa_chats_panel', id); } catch { /* private window */ } };
  const choose = (id: string) => { setOpenSent(null); setOpen(id); setMsgs([]); setText(''); };
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

  const card = (c: Chat, showBrand: boolean) => (
    <button key={c.id} type="button" onClick={() => choose(c.id)} style={{ textAlign: 'left', border: `1px solid ${open === c.id ? 'var(--primary)' : waiting(c) ? 'var(--border-strong, var(--border))' : 'var(--border)'}`, background: open === c.id ? 'var(--bg-subtle, rgba(124,58,237,0.06))' : 'var(--bg, #fff)', borderRadius: 10, padding: '0.55rem 0.7rem', display: 'grid', gap: 4, cursor: 'pointer', font: 'inherit', color: 'inherit', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.85rem' }}>{c.name || 'Customer'}</strong>
        {showBrand && c.panel && <span className="chip">{c.panel}</span>}
        {waiting(c) && <span className="chip chip-warn">Waiting</span>}
        {c.unread > 0 && <span className="chip chip-danger">{c.unread} new</span>}
        {c.automation && <span className="chip" title="The thread starts with a message our automation sent">Automation reply</span>}
      </div>
      <div className="meta" style={{ fontSize: '0.72rem' }}>{c.phone} · {when(c.at)} · {STATUS[c.status] || c.status}</div>
      <div style={{ fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
        <span style={{ color: c.lastSender === 'visitor' ? 'var(--primary)' : 'var(--fg-muted)', fontWeight: 600 }}>{WHO[c.lastSender || ''] || '—'}:</span> {c.last || '—'}
      </div>
    </button>
  );

  const thread = open && (
    <div style={{ display: 'grid', gap: 8, justifyItems: 'center', alignContent: 'start' }}>
      {cur && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', width: '100%' }}>
          <span className="chip">{STATUS[cur.status] || cur.status}</span>
          {cur.panel && <span className="chip">{cur.panel}</span>}
          <button type="button" className="btn btn-sm btn-outline" style={{ gap: 4, marginLeft: 'auto' }} onClick={() => onOpenChat(cur.id)}><ExternalLink size={13} /> Open in Chat Support</button>
        </div>
      )}
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
    </div>
  );

  return (
    <div className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={SECTION}>WhatsApp chats</span>
        <span className="meta" style={{ fontSize: '0.75rem' }}>All brands · {total.chats} chats · {total.waiting} waiting · {total.unread} with new messages</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" className={`seg-btn${view === 'board' ? ' active' : ''}`} onClick={() => switchView('board')} style={{ gap: 4 }}><Columns3 size={13} /> Brands side by side</button>
          <button type="button" className={`seg-btn${view === 'list' ? ' active' : ''}`} onClick={() => switchView('list')} style={{ gap: 4 }}><List size={13} /> One list</button>
          <button type="button" className="btn btn-sm btn-outline" style={{ gap: 4 }} onClick={() => void load()}><RefreshCw size={13} /> Refresh</button>
        </div>
      </div>
      <div className="meta" style={{ fontSize: '0.75rem' }}>A customer who writes back lands in the column of the brand they dealt with. Click a chat to read it and answer right here: the reply goes out on WhatsApp (within 24 hours of their message).</div>

      {chats === null && <div className="meta"><Loader2 size={14} style={spin} /> Loading…</div>}

      {view === 'board' && chats && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, panels.length)}, minmax(260px, 1fr))`, gap: 12, overflowX: 'auto', alignItems: 'start' }}>
          {panels.map((p) => {
            const list = chats.filter((c) => c.panelId === p.id);
            return (
              <div key={p.id} style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-subtle, rgba(124,58,237,0.03))', display: 'grid', alignContent: 'start', minWidth: 0 }}>
                <div style={{ padding: '0.7rem 0.8rem', borderBottom: '1px solid var(--border)', display: 'grid', gap: 6 }}>
                  <strong style={{ fontSize: '1rem' }}>{p.name}</strong>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span className="chip">{p.chats} chats</span>
                    <span className={`chip ${p.waiting ? 'chip-warn' : ''}`}>{p.waiting} waiting</span>
                    <span className={`chip ${p.unread ? 'chip-danger' : ''}`}>{p.unread} new</span>
                    <span className="chip">{p.today} today</span>
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 8, padding: '0.6rem', maxHeight: '64vh', overflowY: 'auto' }}>
                  {list.length === 0 && <div className="meta" style={{ fontSize: '0.78rem', padding: '0.5rem' }}>No WhatsApp chats yet. When a customer of {p.name} writes back, the chat appears here.</div>}
                  {list.map((c) => card(c, false))}
                </div>
                {(() => {
                  const mine = sent.filter((x) => x.panelId === p.id);
                  return (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '0.6rem', display: 'grid', gap: 6 }}>
                      <div style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Sent by automation · {mine.length}</div>
                      {mine.length === 0 && <div className="meta" style={{ fontSize: '0.75rem' }}>Nothing sent yet{p.name ? ` for ${p.name}` : ''}.</div>}
                      <div style={{ display: 'grid', gap: 6, maxHeight: '40vh', overflowY: 'auto' }}>
                        {mine.map((x) => (
                          <button key={x.id} type="button" onClick={() => { setOpen(null); setOpenSent(x); }} style={{ textAlign: 'left', border: `1px solid ${openSent?.id === x.id ? 'var(--primary)' : 'var(--border)'}`, background: 'var(--bg, #fff)', borderRadius: 8, padding: '0.4rem 0.6rem', display: 'grid', gap: 2, cursor: 'pointer', font: 'inherit', color: 'inherit' }}>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.8rem' }}>
                              <strong>{x.name || 'Customer'}</strong>
                              <span>{x.orderId}</span>
                              <span className={`chip ${x.status === 'failed' ? 'chip-danger' : x.status === 'read' ? 'chip-ok' : ''}`}>{TICK[x.status] || x.status}</span>
                              {x.replied && <span className="chip chip-warn">Replied</span>}
                            </div>
                            <div className="meta" style={{ fontSize: '0.7rem' }}>{x.kind === 'placed' ? 'Order placed' : 'Tracking link'} · {x.phone || '—'} · {when(x.at)}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {view === 'list' && chats && (
        <>
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
              {chats.length === 0 && <div className="meta" style={{ fontSize: '0.8125rem' }}>No WhatsApp chats for this brand yet.</div>}
              {chats.map((c) => card(c, panel === 'all'))}
            </div>
            <div style={{ display: 'grid', justifyItems: 'center' }}>
              {open ? thread : <div className="meta" style={{ fontSize: '0.8125rem', padding: '2rem 0' }}>Click a chat on the left to read it and answer.</div>}
            </div>
          </div>
        </>
      )}

      {view === 'board' && openSent && !open && (
        <>
          <div onClick={() => setOpenSent(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,10,30,0.25)', zIndex: 60 }} />
          <div role="dialog" aria-label="Message sent by the automation" style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(440px, 100vw)', background: 'var(--bg, #fff)', boxShadow: '-8px 0 24px rgba(0,0,0,0.15)', zIndex: 61, overflowY: 'auto', padding: '1rem', display: 'grid', alignContent: 'start', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <strong>{openSent.name || 'Customer'}</strong><span className="meta">{openSent.orderId}</span>
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Close" style={{ marginLeft: 'auto' }} onClick={() => setOpenSent(null)}><X size={16} /></button>
            </div>
            <PhoneThread
              name={openSent.name || openSent.phone || 'Customer'} phone={openSent.phone || ''} picture={null}
              messages={[{ id: openSent.id, from: 'us', auto: true, text: openSent.text || '(the message text was not kept)', at: openSent.at, template: openSent.template, sent: openSent.status !== 'failed', status: openSent.status, error: openSent.error }]}
              composer={<div className="wa-compose" style={{ fontSize: '0.75rem', color: '#54656f' }}>{openSent.replied ? 'They wrote back: their chat is in this brand\'s column above.' : 'No reply yet. Until they write, only a template can go (Send tab).'}</div>}
            />
          </div>
        </>
      )}

      {view === 'board' && open && (
        <>
          <div onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,10,30,0.25)', zIndex: 60 }} />
          <div role="dialog" aria-label="WhatsApp chat" style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(440px, 100vw)', background: 'var(--bg, #fff)', boxShadow: '-8px 0 24px rgba(0,0,0,0.15)', zIndex: 61, overflowY: 'auto', padding: '1rem', display: 'grid', alignContent: 'start', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <strong>{cur?.name || 'Customer'}</strong>
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Close" style={{ marginLeft: 'auto' }} onClick={() => setOpen(null)}><X size={16} /></button>
            </div>
            {thread}
          </div>
        </>
      )}
    </div>
  );
}
