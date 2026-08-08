'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  MessageCircle, Mail, Search, Check, X, AlertCircle, Loader2,
  ChevronRight, Settings, Zap, Send, RefreshCw, Package, LogOut,
  ShoppingBag, Upload, Users, Building2, Inbox, Clock, CheckCircle,
  Bot, User, ExternalLink, Filter,
} from 'lucide-react';

interface AuthUser { username: string; displayName: string; role: string; businessIds: string[] | null; }
interface Business { id: string; name: string; primary_color: string | null; }
interface Ticket {
  id: string; source: string; status: string; subject: string;
  customer_email: string; customer_name: string; order_id: string;
  last_message_at: string; created_at: string; business_name: string;
  unread_count: number; last_message_preview: string;
}
interface TicketMessage {
  id: string; direction: string; body: string;
  is_ai_generated: boolean; sent_by: string; created_at: string;
}
interface OrderInfo {
  order_id: string; customer_name: string; tracking_status: string;
  tracking_id: string; estimated_delivery: string; order_total: number;
}
interface SupportSettings {
  ai_mode: string; ai_provider: string; ai_model: string; ai_base_url: string;
  imap_host: string; imap_port: number; imap_user: string; imap_folder: string;
  auto_reply_enabled: boolean; has_ai_key: boolean; has_imap_password: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  open: '#f59e0b',
  pending: '#3b82f6',
  resolved: '#10b981',
  spam: '#ef4444',
};

const STATUS_ICONS: Record<string, string> = {
  open: '🔴',
  pending: '🔵',
  resolved: '✅',
  spam: '🚫',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function SupportPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState('');
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [activePanelId, setActivePanelId] = useState('');

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [totalTickets, setTotalTickets] = useState(0);
  const [statusFilter, setStatusFilter] = useState('open');
  const [search, setSearch] = useState('');
  const [loadingTickets, setLoadingTickets] = useState(false);

  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [orderInfo, setOrderInfo] = useState<OrderInfo | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [generatingDraft, setGeneratingDraft] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<SupportSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState({
    aiMode: 'human_first', aiProvider: 'gemini', aiApiKey: '', aiModel: 'gemini-1.5-flash',
    aiBaseUrl: '', imapHost: 'imap.gmail.com', imapPort: 993, imapUser: '',
    imapPassword: '', imapFolder: 'INBOX', autoReplyEnabled: false,
  });
  const [savingSettings, setSavingSettings] = useState(false);

  const [alert, setAlert] = useState<{ type: string; message: string } | null>(null);

  const showAlert = (type: string, message: string) => {
    setAlert({ type, message });
    setTimeout(() => setAlert(null), 4000);
  };

  useEffect(() => {
    const savedToken = localStorage.getItem('auth_token');
    const savedUser = localStorage.getItem('auth_user');
    if (!savedToken || !savedUser) { router.push('/login'); return; }
    setToken(savedToken);
    setUser(JSON.parse(savedUser));
    const savedPanel = localStorage.getItem('active_panel_id') || '';
    setActivePanelId(savedPanel);
  }, [router]);

  // Fetch businesses
  useEffect(() => {
    if (!token) return;
    fetch('/api/businesses', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setBusinesses(d.businesses || []));
  }, [token]);

  const fetchTickets = useCallback(async () => {
    if (!token) return;
    setLoadingTickets(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (statusFilter) params.set('status', statusFilter);
      if (activePanelId) params.set('businessId', activePanelId);
      const res = await fetch(`/api/support/tickets?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) { setTickets(data.tickets); setTotalTickets(data.total); }
    } catch { showAlert('error', 'Failed to load tickets'); }
    finally { setLoadingTickets(false); }
  }, [token, statusFilter, activePanelId]);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  const fetchTicketDetail = async (ticket: Ticket) => {
    setSelectedTicket(ticket);
    setLoadingDetail(true);
    setMessages([]);
    setOrderInfo(null);
    setReplyText('');
    try {
      const res = await fetch(`/api/support/tickets/${ticket.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) { setMessages(data.messages); setOrderInfo(data.order); }
    } catch { showAlert('error', 'Failed to load conversation'); }
    finally { setLoadingDetail(false); }
  };

  const fetchSettings = async () => {
    if (!activePanelId) return;
    const res = await fetch(`/api/support/settings?businessId=${activePanelId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (res.ok && data.settings) {
      setSettings(data.settings);
      setSettingsForm(prev => ({
        ...prev,
        aiMode: data.settings.ai_mode,
        aiProvider: data.settings.ai_provider,
        aiModel: data.settings.ai_model || 'gemini-1.5-flash',
        aiBaseUrl: data.settings.ai_base_url || '',
        imapHost: data.settings.imap_host,
        imapPort: data.settings.imap_port,
        imapUser: data.settings.imap_user || '',
        imapFolder: data.settings.imap_folder,
        autoReplyEnabled: data.settings.auto_reply_enabled,
      }));
    }
  };

  useEffect(() => { if (showSettings && activePanelId) fetchSettings(); }, [showSettings, activePanelId]);

  const handleSendReply = async () => {
    if (!replyText.trim() || !selectedTicket) return;
    setSendingReply(true);
    try {
      const res = await fetch(`/api/support/tickets/${selectedTicket.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ body: replyText }),
      });
      const data = await res.json();
      if (res.ok) {
        showAlert('success', data.emailSent ? '✅ Reply sent to customer!' : '✅ Reply saved (email send failed)');
        setReplyText('');
        fetchTicketDetail(selectedTicket);
        fetchTickets();
      } else { showAlert('error', data.error || 'Send failed'); }
    } catch { showAlert('error', 'Send failed'); }
    finally { setSendingReply(false); }
  };

  const handleAIDraft = async () => {
    if (!selectedTicket) return;
    setGeneratingDraft(true);
    try {
      const res = await fetch(`/api/support/tickets/${selectedTicket.id}/ai-draft`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok && data.draft) {
        setReplyText(data.draft);
        showAlert('success', '🤖 AI draft ready — review and edit before sending');
      } else { showAlert('error', data.error || 'AI draft failed'); }
    } catch { showAlert('error', 'AI draft failed'); }
    finally { setGeneratingDraft(false); }
  };

  const handleStatusChange = async (ticketId: string, status: string) => {
    await fetch(`/api/support/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status }),
    });
    if (selectedTicket?.id === ticketId) {
      setSelectedTicket(prev => prev ? { ...prev, status } : null);
    }
    fetchTickets();
  };

  const handleSaveSettings = async () => {
    if (!activePanelId) { showAlert('error', 'Select a panel first'); return; }
    setSavingSettings(true);
    try {
      const res = await fetch('/api/support/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ businessId: activePanelId, ...settingsForm }),
      });
      if (res.ok) { showAlert('success', 'Settings saved ✅'); fetchSettings(); }
      else { showAlert('error', 'Save failed'); }
    } catch { showAlert('error', 'Save failed'); }
    finally { setSavingSettings(false); }
  };

  const filteredTickets = tickets.filter(t =>
    !search || t.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
    t.customer_email?.toLowerCase().includes(search.toLowerCase()) ||
    t.subject?.toLowerCase().includes(search.toLowerCase())
  );

  const logout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    router.push('/login');
  };

  if (!user) return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}><Loader2 size={32} className="animate-spin" /></div>;

  return (
    <div className="admin-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--primary)' }}>
            🎧 Support Inbox
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
            Customer queries
          </div>
        </div>

        {/* Panel selector */}
        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <label style={{ fontSize: '0.7rem', color: 'var(--fg-muted)', fontWeight: 600 }}>PANEL</label>
          <select
            value={activePanelId}
            onChange={e => { setActivePanelId(e.target.value); localStorage.setItem('active_panel_id', e.target.value); }}
            style={{ width: '100%', marginTop: '0.25rem', padding: '0.375rem', borderRadius: 6, border: '1px solid var(--border)', fontSize: '0.8125rem', background: 'var(--card-bg)', color: 'var(--fg)' }}
          >
            <option value="">All panels</option>
            {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        {/* Status filters */}
        <nav style={{ padding: '0.5rem' }}>
          {(['open', 'pending', 'resolved', 'spam', ''] as const).map(s => (
            <button
              key={s || 'all'}
              onClick={() => setStatusFilter(s)}
              className={`nav-btn ${statusFilter === s ? 'active' : ''}`}
              style={{ justifyContent: 'space-between', width: '100%' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>{s ? STATUS_ICONS[s] : '📋'}</span>
                <span style={{ textTransform: 'capitalize' }}>{s || 'All'}</span>
              </span>
              {s === statusFilter && <span style={{ fontSize: '0.7rem', background: 'var(--primary)', color: '#fff', borderRadius: 9999, padding: '1px 6px' }}>{totalTickets}</span>}
            </button>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', padding: '0.75rem' }}>
          <button className="nav-btn" onClick={() => router.push('/admin')} style={{ width: '100%' }}>
            <ShoppingBag size={16} /> Back to Orders
          </button>
          {user.role === 'admin' && (
            <button className="nav-btn" onClick={() => setShowSettings(!showSettings)} style={{ width: '100%' }}>
              <Settings size={16} /> Support Settings
            </button>
          )}
          <button className="nav-btn" onClick={logout} style={{ width: '100%', marginTop: '0.25rem' }}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <div className="main-inner" style={{ padding: 0 }}>

          {/* Alert toast */}
          {alert && (
            <div className={`toast toast-${alert.type}`} style={{ position: 'fixed', top: '1rem', right: '1rem', zIndex: 9999 }}>
              {alert.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
              {alert.message}
            </div>
          )}

          {showSettings ? (
            /* ── SETTINGS PANEL ── */
            <div style={{ padding: '1.5rem', maxWidth: 640 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
                <button onClick={() => setShowSettings(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)' }}><ChevronRight size={20} style={{ transform: 'rotate(180deg)' }} /></button>
                <div>
                  <h2 className="page-title" style={{ marginBottom: 0 }}>Support Settings</h2>
                  <p className="page-subtitle">Configure AI & email inbox for {businesses.find(b => b.id === activePanelId)?.name || 'this panel'}</p>
                </div>
              </div>

              {!activePanelId && (
                <div style={{ padding: '1rem', background: 'var(--warning-light, #fef3c7)', borderRadius: 8, color: '#92400e', marginBottom: '1rem', fontSize: '0.875rem' }}>
                  ⚠️ Select a panel from the sidebar to configure settings.
                </div>
              )}

              <div className="tf-card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
                <h3 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Bot size={16} style={{ color: 'var(--primary)' }} /> AI Configuration
                </h3>

                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <div>
                    <label className="form-label">AI Mode</label>
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                      {[['human_first', '👤 Human-first (AI suggests, you approve)'], ['ai_first', '🤖 AI-first (auto-sends simple queries)']].map(([val, label]) => (
                        <button key={val} onClick={() => setSettingsForm(f => ({ ...f, aiMode: val }))}
                          style={{ flex: 1, padding: '0.5rem', borderRadius: 8, border: `2px solid ${settingsForm.aiMode === val ? 'var(--primary)' : 'var(--border)'}`, background: settingsForm.aiMode === val ? 'var(--primary-light)' : 'var(--card-bg)', cursor: 'pointer', fontSize: '0.75rem', fontWeight: settingsForm.aiMode === val ? 700 : 400, color: settingsForm.aiMode === val ? 'var(--primary)' : 'var(--fg)' }}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="form-label">AI Provider</label>
                    <select value={settingsForm.aiProvider} onChange={e => setSettingsForm(f => ({ ...f, aiProvider: e.target.value }))}
                      style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--fg)', fontSize: '0.875rem' }}>
                      <option value="gemini">Gemini (Google — free)</option>
                      <option value="openai">OpenAI (GPT-4o)</option>
                      <option value="openrouter">OpenRouter (multi-model)</option>
                    </select>
                  </div>

                  <div>
                    <label className="form-label">
                      API Key {settings?.has_ai_key ? <span style={{ color: 'var(--success)', fontSize: '0.7rem' }}>● Saved</span> : <span style={{ color: 'var(--error, #ef4444)', fontSize: '0.7rem' }}>● Not set</span>}
                    </label>
                    <input type="password" placeholder={settings?.has_ai_key ? '••••••••••••• (leave blank to keep)' : 'Paste API key here'}
                      value={settingsForm.aiApiKey} onChange={e => setSettingsForm(f => ({ ...f, aiApiKey: e.target.value }))}
                      style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--fg)', fontSize: '0.875rem', boxSizing: 'border-box' }} />
                    {settingsForm.aiProvider === 'gemini' && (
                      <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: '0.7rem', color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.25rem' }}>
                        Get free Gemini API key <ExternalLink size={10} />
                      </a>
                    )}
                    {settingsForm.aiProvider === 'openrouter' && (
                      <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: '0.7rem', color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.25rem' }}>
                        Get OpenRouter API key (access GPT-4o, Claude, etc.) <ExternalLink size={10} />
                      </a>
                    )}
                  </div>

                  <div>
                    <label className="form-label">AI Model</label>
                    <input value={settingsForm.aiModel} onChange={e => setSettingsForm(f => ({ ...f, aiModel: e.target.value }))}
                      placeholder={settingsForm.aiProvider === 'gemini' ? 'gemini-1.5-flash' : settingsForm.aiProvider === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'}
                      style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--fg)', fontSize: '0.875rem', boxSizing: 'border-box' }} />
                  </div>
                </div>
              </div>

              <div className="tf-card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
                <h3 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Mail size={16} style={{ color: 'var(--primary)' }} /> Gmail IMAP — Receive Emails
                </h3>
                <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginBottom: '0.75rem' }}>
                  We&apos;ll check this inbox every 2 min for new customer emails.
                  Gmail requires an <strong>App Password</strong> (not your regular password).
                  <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', marginLeft: '0.25rem' }}>Generate one here ↗</a>
                </p>

                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <div>
                    <label className="form-label">Gmail Address</label>
                    <input type="email" placeholder="support@yourbrand.com" value={settingsForm.imapUser}
                      onChange={e => setSettingsForm(f => ({ ...f, imapUser: e.target.value }))}
                      style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--fg)', fontSize: '0.875rem', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label className="form-label">
                      Gmail App Password {settings?.has_imap_password ? <span style={{ color: 'var(--success)', fontSize: '0.7rem' }}>● Saved</span> : ''}
                    </label>
                    <input type="password" placeholder={settings?.has_imap_password ? '•••• •••• •••• ••••' : '16-char app password'}
                      value={settingsForm.imapPassword}
                      onChange={e => setSettingsForm(f => ({ ...f, imapPassword: e.target.value }))}
                      style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--fg)', fontSize: '0.875rem', boxSizing: 'border-box' }} />
                  </div>
                </div>
              </div>

              <button onClick={handleSaveSettings} disabled={savingSettings || !activePanelId}
                style={{ width: '100%', padding: '0.75rem', borderRadius: 8, background: 'var(--primary)', color: '#fff', border: 'none', fontWeight: 700, cursor: savingSettings ? 'not-allowed' : 'pointer', opacity: !activePanelId ? 0.5 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                {savingSettings ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : <><Check size={16} /> Save Settings</>}
              </button>
            </div>
          ) : (
            /* ── INBOX ── */
            <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
              {/* Ticket List */}
              <div style={{ width: 340, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--bg-subtle)', borderRadius: 8, padding: '0.375rem 0.625rem' }}>
                    <Search size={14} style={{ color: 'var(--fg-muted)' }} />
                    <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
                      style={{ border: 'none', background: 'transparent', outline: 'none', fontSize: '0.8125rem', color: 'var(--fg)', width: '100%' }} />
                  </div>
                  <button onClick={fetchTickets} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: '0.25rem' }}>
                    <RefreshCw size={16} className={loadingTickets ? 'animate-spin' : ''} />
                  </button>
                </div>

                <div style={{ flex: 1, overflowY: 'auto' }}>
                  {loadingTickets && <div style={{ padding: '2rem', textAlign: 'center' }}><Loader2 size={24} className="animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>}
                  {!loadingTickets && filteredTickets.length === 0 && (
                    <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                      <Inbox size={32} style={{ marginBottom: '0.5rem', opacity: 0.3 }} />
                      <div style={{ fontSize: '0.875rem' }}>No tickets</div>
                    </div>
                  )}
                  {filteredTickets.map(ticket => (
                    <button key={ticket.id} onClick={() => fetchTicketDetail(ticket)}
                      style={{
                        width: '100%', textAlign: 'left', padding: '0.875rem 1rem',
                        borderBottom: '1px solid var(--border)', cursor: 'pointer',
                        background: selectedTicket?.id === ticket.id ? 'var(--primary-light)' : 'transparent',
                        border: 'none', borderLeft: selectedTicket?.id === ticket.id ? '3px solid var(--primary)' : '3px solid transparent',
                      }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: '0.625rem' }}>{ticket.source === 'shopify' ? '🛍️' : '📧'}</span>
                          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {ticket.customer_name || ticket.customer_email}
                          </span>
                        </div>
                        <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', flexShrink: 0, marginLeft: '0.5rem' }}>{timeAgo(ticket.last_message_at)}</span>
                      </div>
                      <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--fg)', marginBottom: '0.25rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {ticket.subject || '(no subject)'}
                      </div>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {ticket.last_message_preview || ''}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginTop: '0.375rem' }}>
                        <span style={{ fontSize: '0.625rem', padding: '1px 6px', borderRadius: 9999, background: STATUS_COLORS[ticket.status] + '20', color: STATUS_COLORS[ticket.status], fontWeight: 700 }}>
                          {ticket.status}
                        </span>
                        {ticket.order_id && <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)' }}>#{ticket.order_id}</span>}
                        {ticket.business_name && <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginLeft: 'auto' }}>{ticket.business_name}</span>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Ticket Detail */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {!selectedTicket ? (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                    <MessageCircle size={48} style={{ opacity: 0.2, marginBottom: '1rem' }} />
                    <div style={{ fontSize: '0.875rem' }}>Select a ticket to view conversation</div>
                  </div>
                ) : (
                  <>
                    {/* Header */}
                    <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--fg)' }}>{selectedTicket.subject || '(no subject)'}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span>{selectedTicket.customer_name}</span>
                          <span>·</span>
                          <span>{selectedTicket.customer_email}</span>
                          {selectedTicket.order_id && <><span>·</span><span style={{ color: 'var(--primary)' }}>#{selectedTicket.order_id}</span></>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.375rem' }}>
                        {(['open', 'pending', 'resolved', 'spam'] as const).map(s => (
                          <button key={s} onClick={() => handleStatusChange(selectedTicket.id, s)}
                            style={{ padding: '0.25rem 0.625rem', borderRadius: 6, border: `1px solid ${STATUS_COLORS[s]}`, background: selectedTicket.status === s ? STATUS_COLORS[s] : 'transparent', color: selectedTicket.status === s ? '#fff' : STATUS_COLORS[s], fontSize: '0.6875rem', fontWeight: 700, cursor: 'pointer' }}>
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Order Info Card */}
                    {orderInfo && (
                      <div style={{ margin: '0.75rem 1.25rem', padding: '0.75rem 1rem', background: 'var(--primary-light)', borderRadius: 8, display: 'flex', gap: '1rem', flexShrink: 0 }}>
                        <Package size={16} style={{ color: 'var(--primary)', flexShrink: 0, marginTop: '0.125rem' }} />
                        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', fontSize: '0.75rem' }}>
                          <div><span style={{ color: 'var(--fg-muted)' }}>Order</span><br /><strong>#{orderInfo.order_id}</strong></div>
                          <div><span style={{ color: 'var(--fg-muted)' }}>Status</span><br /><strong>{orderInfo.tracking_status}</strong></div>
                          <div><span style={{ color: 'var(--fg-muted)' }}>Tracking</span><br /><strong>{orderInfo.tracking_id || '—'}</strong></div>
                          <div><span style={{ color: 'var(--fg-muted)' }}>Est. Delivery</span><br /><strong>{orderInfo.estimated_delivery ? new Date(orderInfo.estimated_delivery).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}</strong></div>
                          <div><span style={{ color: 'var(--fg-muted)' }}>Total</span><br /><strong>₹{orderInfo.order_total}</strong></div>
                        </div>
                      </div>
                    )}

                    {/* Messages Thread */}
                    <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                      {loadingDetail && <div style={{ textAlign: 'center', padding: '2rem' }}><Loader2 size={24} className="animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>}
                      {messages.map(msg => (
                        <div key={msg.id} style={{ display: 'flex', flexDirection: msg.direction === 'outbound' ? 'row-reverse' : 'row', gap: '0.625rem', alignItems: 'flex-start' }}>
                          <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: msg.direction === 'outbound' ? 'var(--primary)' : 'var(--border)', color: msg.direction === 'outbound' ? '#fff' : 'var(--fg-muted)', fontSize: '0.625rem' }}>
                            {msg.direction === 'outbound' ? (msg.is_ai_generated ? <Bot size={12} /> : <User size={12} />) : <User size={12} />}
                          </div>
                          <div style={{ maxWidth: '75%' }}>
                            <div style={{
                              padding: '0.625rem 0.875rem', borderRadius: msg.direction === 'outbound' ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
                              background: msg.direction === 'outbound' ? 'var(--primary)' : 'var(--card-bg)',
                              color: msg.direction === 'outbound' ? '#fff' : 'var(--fg)',
                              border: msg.direction === 'inbound' ? '1px solid var(--border)' : 'none',
                              fontSize: '0.8125rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            }}>
                              {msg.body}
                            </div>
                            <div style={{ fontSize: '0.6rem', color: 'var(--fg-muted)', marginTop: '0.25rem', textAlign: msg.direction === 'outbound' ? 'right' : 'left', display: 'flex', alignItems: 'center', gap: '0.25rem', justifyContent: msg.direction === 'outbound' ? 'flex-end' : 'flex-start' }}>
                              {msg.is_ai_generated && <span style={{ color: 'var(--primary)', fontWeight: 700 }}>🤖 AI</span>}
                              {timeAgo(msg.created_at)} · {msg.sent_by || 'customer'}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Reply Box */}
                    <div style={{ borderTop: '1px solid var(--border)', padding: '0.875rem 1.25rem', flexShrink: 0 }}>
                      <textarea
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        placeholder="Type your reply… or click 🤖 AI Draft to generate one"
                        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSendReply(); }}
                        style={{
                          width: '100%', minHeight: 90, padding: '0.625rem 0.875rem',
                          borderRadius: 8, border: '1px solid var(--border)',
                          background: 'var(--card-bg)', color: 'var(--fg)', fontSize: '0.875rem',
                          resize: 'vertical', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
                          lineHeight: 1.5,
                        }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                        <button onClick={handleAIDraft} disabled={generatingDraft}
                          style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', borderRadius: 8, border: '1.5px solid var(--primary)', background: 'var(--primary-light)', color: 'var(--primary)', cursor: generatingDraft ? 'not-allowed' : 'pointer', fontSize: '0.8125rem', fontWeight: 700 }}>
                          {generatingDraft ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                          {generatingDraft ? 'Generating…' : 'AI Draft'}
                        </button>
                        <span style={{ fontSize: '0.7rem', color: 'var(--fg-muted)' }}>Review before sending</span>
                        <div style={{ flex: 1 }} />
                        <button onClick={handleSendReply} disabled={sendingReply || !replyText.trim()}
                          style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', borderRadius: 8, border: 'none', background: !replyText.trim() ? 'var(--border)' : 'var(--primary)', color: !replyText.trim() ? 'var(--fg-muted)' : '#fff', cursor: !replyText.trim() || sendingReply ? 'not-allowed' : 'pointer', fontSize: '0.8125rem', fontWeight: 700 }}>
                          {sendingReply ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                          {sendingReply ? 'Sending…' : 'Send Reply'}
                        </button>
                      </div>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.375rem' }}>
                        ⌘+Enter to send · Reply goes to {selectedTicket.customer_email}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
