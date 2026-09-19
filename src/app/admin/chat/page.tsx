'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Check, AlertCircle, ShoppingBag, LogOut, Send, Mail,
  MessageCircle, User, Phone, Bot, Inbox,
} from 'lucide-react';

/* ═══════════ TYPES ═══════════ */
interface AuthUser { username: string; displayName: string; role: 'admin' | 'manager' | 'viewer'; businessIds: string[] | null; }
interface Business { id: string; name: string; }

interface Conversation {
  id: string;
  visitor_name: string | null;
  visitor_phone: string | null;
  status: 'ai_handling' | 'agent_handling' | 'resolved' | 'human_needed';
  source: 'chat' | 'email';
  category: 'wrong_tracking' | 'refund' | 'cancellation' | 'others';
  unread_count: number;
  last_message_at: string | null;
  created_at: string;
  site_id: string;
  site_name: string;
  tracker_business_id: string | null;
  panel_name: string | null;
  last_message: string | null;
}

interface ChatMessage {
  id: string;
  sender: 'visitor' | 'ai' | 'agent';
  content: string;
  metadata: { withheld?: string; emailed?: boolean; agent?: string } | null;
  created_at: string;
}

const STATUS_LABELS: Record<string, string> = {
  ai_handling: 'AI',
  agent_handling: 'You',
  resolved: 'Closed',
  human_needed: 'Needs you',
};

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  ai_handling: { bg: 'var(--primary-light)', fg: 'var(--primary)' },
  agent_handling: { bg: 'var(--primary)', fg: '#fff' },
  resolved: { bg: 'var(--bg-subtle, rgba(0,0,0,0.05))', fg: 'var(--fg-muted)' },
  human_needed: { bg: '#fee2e2', fg: '#b91c1c' },
};

const CATEGORY_LABELS: Record<string, string> = {
  wrong_tracking: 'Wrong tracking',
  refund: 'Refund',
  cancellation: 'Cancellation',
  others: '',
};

// An AI reply that was written but never sent — escalated to a person, or the
// send itself failed. The customer has not seen it.
const WITHHELD_LABELS: Record<string, string> = {
  escalated: 'needs a human',
  send_failed: 'sending failed',
  sending: 'still sending',
};

const POLL_MS = 3000;

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function renderWithLinks(text: string) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', wordBreak: 'break-all' }}>{part}</a>
      : <span key={i}>{part}</span>
  );
}

export default function ChatSupportPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState('');

  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [activePanelId, setActivePanelId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const showAlert = (type: 'success' | 'error', message: string) => {
    setAlert({ type, message });
    setTimeout(() => setAlert(null), 4000);
  };

  /* ═══ AUTH ═══ */
  useEffect(() => {
    const t = localStorage.getItem('auth_token');
    const u = localStorage.getItem('auth_user');
    if (!t || !u) { router.push('/login'); return; }
    setToken(t);
    setUser(JSON.parse(u));
    setActivePanelId(localStorage.getItem('active_panel_id') || '');
  }, [router]);

  /* ═══ PANELS ═══ */
  useEffect(() => {
    if (!token) return;
    fetch('/api/businesses', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setBusinesses(d.businesses || []))
      .catch(() => {});
  }, [token]);

  /* ═══ CONVERSATION LIST ═══ */
  const fetchConversations = useCallback(async (quiet = false) => {
    if (!token) return;
    if (!quiet) setLoadingList(true);
    try {
      const params = new URLSearchParams();
      if (activePanelId) params.set('businessId', activePanelId);
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/chat/conversations?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) setConversations(data.conversations || []);
    } catch { /* keep the last good list */ }
    finally { if (!quiet) setLoadingList(false); }
  }, [token, activePanelId, statusFilter]);

  useEffect(() => { fetchConversations(); }, [fetchConversations]);

  /* ═══ OPEN THREAD ═══ */
  const fetchThread = useCallback(async (id: string, quiet = false) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { if (!quiet) showAlert('error', data.error || 'Could not open that conversation'); return; }
      setActiveConv(data.conversation);
      setMessages(data.messages || []);
    } catch { /* keep what is on screen */ }
  }, [token]);

  useEffect(() => {
    if (activeId) fetchThread(activeId);
    else { setActiveConv(null); setMessages([]); }
  }, [activeId, fetchThread]);

  /* ═══ POLLING ═══ */
  // There is no websocket in ShipTrack — the inbox asks again every few
  // seconds instead, and stops entirely while the tab is in the background.
  useEffect(() => {
    if (!token) return;
    const tick = () => {
      if (document.hidden) return;
      fetchConversations(true);
      if (activeIdRef.current) fetchThread(activeIdRef.current, true);
    };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [token, fetchConversations, fetchThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  /* ═══ ACTIONS ═══ */
  const changeStatus = async (status: string) => {
    if (!activeId) return;
    try {
      const res = await fetch(`/api/chat/conversations/${activeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        setActiveConv(c => (c ? { ...c, status: status as Conversation['status'] } : c));
        fetchConversations(true);
      } else {
        const d = await res.json();
        showAlert('error', d.error || 'Could not update that conversation');
      }
    } catch { showAlert('error', 'Could not update that conversation'); }
  };

  const sendReply = async () => {
    if (!activeId || !draft.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ conversationId: activeId, content: draft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { showAlert('error', data.error || 'Could not send that reply'); return; }

      setDraft('');
      if (data.emailed === false) {
        showAlert('error', 'Saved, but the email did not go out — check the mailbox settings');
      }
      await fetchThread(activeId, true);
      fetchConversations(true);
    } catch { showAlert('error', 'Could not send that reply'); }
    finally { setSending(false); }
  };

  const logout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    router.push('/login');
  };

  if (!user) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Loader2 size={32} style={{ animation: 'spin 0.6s linear infinite' }} />
      </div>
    );
  }

  const canReply = user.role !== 'viewer';
  const unreadTotal = conversations.reduce((n, c) => n + (c.unread_count || 0), 0);

  return (
    <div className="admin-layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <MessageCircle size={15} /> Chat Support
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
            {unreadTotal > 0 ? `${unreadTotal} unread` : 'Chat and email in one place'}
          </div>
        </div>

        {/* Panel selector */}
        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <label style={{ fontSize: '0.7rem', color: 'var(--fg-muted)', fontWeight: 600 }}>PANEL</label>
          <select
            value={activePanelId}
            onChange={e => {
              setActivePanelId(e.target.value);
              localStorage.setItem('active_panel_id', e.target.value);
              setActiveId(null);
            }}
            style={{ width: '100%', marginTop: '0.25rem', padding: '0.375rem', borderRadius: 6, border: '1px solid var(--border)', fontSize: '0.8125rem', background: 'var(--card-bg)', color: 'var(--fg)' }}
          >
            <option value="">All panels</option>
            {businesses
              .filter(b => !user.businessIds || user.businessIds.includes(b.id))
              .map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        {/* Status filters */}
        <nav style={{ padding: '0.5rem' }}>
          {([
            { v: '', label: 'All', icon: Inbox },
            { v: 'human_needed', label: 'Needs you', icon: AlertCircle },
            { v: 'agent_handling', label: 'You are on it', icon: User },
            { v: 'ai_handling', label: 'AI handling', icon: Bot },
            { v: 'resolved', label: 'Closed', icon: Check },
          ] as const).map(s => (
            <button
              key={s.v || 'all'}
              onClick={() => { setStatusFilter(s.v); setActiveId(null); }}
              className={`nav-btn ${statusFilter === s.v ? 'active' : ''}`}
              style={{ width: '100%' }}
            >
              <s.icon size={16} /> {s.label}
            </button>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', padding: '0.75rem' }}>
          <button className="nav-btn" onClick={() => router.push('/admin')} style={{ width: '100%' }}>
            <ShoppingBag size={16} /> Back to Orders
          </button>
          <button className="nav-btn" onClick={logout} style={{ width: '100%', marginTop: '0.25rem' }}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content">
        {alert && (
          <div className={`toast toast-${alert.type}`} style={{ position: 'fixed', top: '1rem', right: '1rem', zIndex: 9999 }}>
            {alert.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
            {alert.message}
          </div>
        )}

        <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
          {/* Conversation list */}
          <div style={{ width: 320, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: '0.875rem' }}>
              Conversations
              <span style={{ color: 'var(--fg-muted)', fontWeight: 400, marginLeft: '0.375rem', fontSize: '0.75rem' }}>
                {conversations.length}
              </span>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loadingList && conversations.length === 0 && (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                  <Loader2 size={20} style={{ animation: 'spin 0.6s linear infinite' }} />
                </div>
              )}

              {!loadingList && conversations.length === 0 && (
                <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
                  <Inbox size={28} style={{ opacity: 0.25, marginBottom: '0.5rem' }} />
                  <p>Nothing here yet.</p>
                  <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    Chats from the widget and email to a connected mailbox both land here.
                  </p>
                </div>
              )}

              {conversations.map(c => (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    padding: '0.75rem 1rem', border: 'none',
                    borderBottom: '1px solid var(--border)',
                    borderLeft: activeId === c.id ? '3px solid var(--primary)' : '3px solid transparent',
                    background: activeId === c.id ? 'var(--primary-light)' : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.25rem' }}>
                    {c.source === 'email' ? <Mail size={12} style={{ color: 'var(--fg-muted)' }} /> : <MessageCircle size={12} style={{ color: 'var(--fg-muted)' }} />}
                    <span style={{ fontWeight: 600, fontSize: '0.8125rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.visitor_name || 'Visitor'}
                    </span>
                    {c.unread_count > 0 && (
                      <span style={{ background: 'var(--danger)', color: '#fff', borderRadius: 9999, fontSize: '0.625rem', padding: '1px 6px', fontWeight: 700 }}>
                        {c.unread_count}
                      </span>
                    )}
                    <span style={{
                      fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                      background: STATUS_STYLE[c.status]?.bg, color: STATUS_STYLE[c.status]?.fg,
                    }}>
                      {STATUS_LABELS[c.status]}
                    </span>
                  </div>

                  <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.25rem', display: 'flex', gap: '0.375rem' }}>
                    <span>{c.panel_name || c.site_name}</span>
                    {CATEGORY_LABELS[c.category] && (
                      <><span>·</span><span>{CATEGORY_LABELS[c.category]}</span></>
                    )}
                  </div>

                  <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.last_message || '—'}
                  </div>
                  <div style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                    {timeAgo(c.last_message_at)}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Thread */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {!activeConv && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <MessageCircle size={40} style={{ opacity: 0.2, marginBottom: '0.75rem' }} />
                <p style={{ fontWeight: 600 }}>Pick a conversation</p>
                <p style={{ fontSize: '0.8125rem' }}>Chats and emails both appear on the left.</p>
              </div>
            )}

            {activeConv && (
              <>
                {/* Thread header */}
                <div style={{ padding: '0.875rem 1.25rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontWeight: 700 }}>{activeConv.visitor_name || 'Visitor'}</span>
                      <span style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                        display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                        background: 'var(--primary-light)', color: 'var(--primary)',
                      }}>
                        {activeConv.source === 'email' ? <><Mail size={10} /> Email</> : <><MessageCircle size={10} /> Chat</>}
                      </span>
                      <span style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                        background: STATUS_STYLE[activeConv.status]?.bg, color: STATUS_STYLE[activeConv.status]?.fg,
                      }}>
                        {STATUS_LABELS[activeConv.status]}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.125rem', display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                      <span>{activeConv.panel_name || activeConv.site_name}</span>
                      {activeConv.visitor_phone && (
                        <>
                          <span>·</span>
                          <a href={`tel:${activeConv.visitor_phone}`} style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <Phone size={10} /> {activeConv.visitor_phone}
                          </a>
                        </>
                      )}
                    </div>
                  </div>

                  {canReply && (
                    <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 0 }}>
                      {activeConv.status !== 'agent_handling' && (
                        <button className="btn btn-primary btn-sm" onClick={() => changeStatus('agent_handling')}>Take over</button>
                      )}
                      {activeConv.status === 'agent_handling' && (
                        <button className="btn btn-outline btn-sm" onClick={() => changeStatus('ai_handling')}>Hand to AI</button>
                      )}
                      {activeConv.status !== 'resolved' && (
                        <button className="btn btn-outline btn-sm" onClick={() => changeStatus('resolved')}>Close</button>
                      )}
                    </div>
                  )}
                </div>

                {/* Messages */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {messages.map(msg => {
                    const mine = msg.sender !== 'visitor';
                    const withheld = msg.metadata?.withheld;
                    return (
                      <div key={msg.id} style={{
                        alignSelf: mine ? 'flex-start' : 'flex-end',
                        maxWidth: '72%', display: 'flex', flexDirection: 'column',
                        alignItems: mine ? 'flex-start' : 'flex-end',
                      }}>
                        <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginBottom: '0.25rem' }}>
                          {msg.sender === 'visitor' ? 'Customer' : msg.sender === 'agent' ? 'You' : 'AI'}
                        </span>
                        <div style={{
                          padding: '0.625rem 0.875rem', borderRadius: 12, fontSize: '0.8125rem', lineHeight: 1.5,
                          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          background: msg.sender === 'visitor' ? 'var(--primary)' : 'var(--card-bg)',
                          color: msg.sender === 'visitor' ? '#fff' : 'var(--fg)',
                          border: withheld ? '1px dashed #f59e0b' : '1px solid var(--border)',
                          opacity: withheld ? 0.65 : 1,
                        }}>
                          {renderWithLinks(msg.content)}
                        </div>
                        {withheld && (
                          <span style={{
                            fontSize: '0.625rem', color: '#b45309', background: '#fffbeb',
                            border: '1px solid #fde68a', borderRadius: 4, padding: '1px 6px', marginTop: '0.25rem',
                          }}>
                            Not sent — {WITHHELD_LABELS[withheld] ?? 'held for you'}
                          </span>
                        )}
                        <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                          {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    );
                  })}
                  <div ref={bottomRef} />
                </div>

                {/* Composer */}
                {activeConv.status !== 'resolved' && canReply && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '0.75rem 1rem' }}>
                    {activeConv.status !== 'agent_handling' && (
                      <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
                        {activeConv.status === 'human_needed'
                          ? 'This one is waiting on a person — take over to reply.'
                          : 'The AI is handling this — take over to reply yourself.'}
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                      <textarea
                        className="form-input"
                        rows={2}
                        placeholder={activeConv.status === 'agent_handling'
                          ? (activeConv.source === 'email' ? 'Type your reply — it goes out by email…' : 'Type your reply…')
                          : 'Take over to reply…'}
                        value={draft}
                        disabled={activeConv.status !== 'agent_handling' || sending}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
                        }}
                        style={{ flex: 1, height: 'auto', resize: 'vertical', minHeight: 44 }}
                      />
                      <button
                        className="btn btn-primary"
                        disabled={!draft.trim() || sending || activeConv.status !== 'agent_handling'}
                        onClick={sendReply}
                      >
                        {sending
                          ? <Loader2 size={16} style={{ animation: 'spin 0.6s linear infinite' }} />
                          : <Send size={16} />}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
