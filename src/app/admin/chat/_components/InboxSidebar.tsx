'use client';

import type { useRouter } from 'next/navigation';
import { ShoppingBag, LogOut, MessageCircle, Inbox, UserCheck, ChevronDown } from 'lucide-react';
import { ROLE_INFO, type Role } from '@/lib/permissions';
import { INBOX_TOPICS } from '@/lib/chat/inbox-topics';
import type { AuthUser, Business, InboxTab } from '../_lib/types';
import { TOPIC_ICONS, INBOX_TABS } from '../_lib/inbox';
import { Chip } from './chips';

export default function InboxSidebar({ activePanelId, businesses, canReply, caseCounts, logout, myChats, router, setActiveId, setActivePanelId, setMeOpen, setSearchInput, setSearchQ, setSidebarOpen, setTab, setTopicsOpen, sidebarOpen, tab, topicCounts, topicsShown, unreadTotal, user }: {
  activePanelId: string;
  businesses: Business[];
  canReply: boolean;
  caseCounts: Record<string, { total: number; unread: number }>;
  logout: () => void;
  myChats: { open: number; waiting: number; held: number };
  router: ReturnType<typeof useRouter>;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  setActivePanelId: React.Dispatch<React.SetStateAction<string>>;
  setMeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSearchInput: React.Dispatch<React.SetStateAction<string>>;
  setSearchQ: React.Dispatch<React.SetStateAction<string>>;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTab: React.Dispatch<React.SetStateAction<InboxTab>>;
  setTopicsOpen: (v: boolean) => void;
  sidebarOpen: boolean;
  tab: InboxTab;
  topicCounts: Record<string, number>;
  topicsShown: boolean;
  unreadTotal: number;
  user: AuthUser | null;
}) {
  return (
      <aside className={`sidebar chat-side ${sidebarOpen ? 'open' : ''}`}>
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <MessageCircle size={15} /> Chat Support
          </div>
          <div className="meta" style={{ marginTop: '0.25rem' }}>
            {unreadTotal > 0 ? `${unreadTotal} waiting` : 'Chat and email in one place'}
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
              setSidebarOpen(false);
            }}
            style={{ width: '100%', marginTop: '0.25rem', padding: '0.375rem', borderRadius: 6, border: '1px solid var(--border)', fontSize: '0.8125rem', background: 'var(--card-bg)', color: 'var(--fg)' }}
          >
            <option value="">All panels</option>
            {businesses
              .filter(b => !user.businessIds || user.businessIds.includes(b.id))
              .map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        {/* Status filters: they scroll inside the sidebar when the screen is short, so the
            panel picker stays on top and Back to Orders / Sign out stay at the bottom. */}
        <nav style={{ padding: '0.5rem', flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {INBOX_TABS.filter(s => s.v !== 'mine' || canReply).map(s => (
            <button
              key={s.v}
              onClick={() => { setTab(s.v); setSearchInput(''); setSearchQ(''); setActiveId(null); setSidebarOpen(false); }}
              className={`nav-btn ${tab === s.v ? 'active' : ''}`}
              style={{ width: '100%' }}
            >
              <s.icon size={16} />
              <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>{s.label}</span>
              {s.v.startsWith('case:') && (caseCounts[s.v.slice(5)]?.total ?? 0) > 0 && (() => {
                const c = caseCounts[s.v.slice(5)];
                return (
                  <Chip tone={c.unread ? 'danger' : 'muted'} title={`${c.total} chat${c.total === 1 ? '' : 's'}${c.unread ? `, ${c.unread} waiting for an answer` : ''}`}>
                    {c.unread ? `${c.unread} waiting` : c.total}
                  </Chip>
                );
              })()}
              {s.v === 'mine' && myChats.open > 0 && (
                // My chats: how many open chats this login holds; red while any customer waits.
                <Chip tone={myChats.waiting ? 'danger' : 'muted'} title={`${myChats.open} open chat${myChats.open === 1 ? '' : 's'} you hold${myChats.waiting ? `, ${myChats.waiting} waiting for an answer` : ''}`}>
                  {myChats.open}
                </Chip>
              )}
            </button>
          ))}

          {/* What the customers are upset about: open chats only, so each queue stays short. The
              list folds away (remembered) so the menu stays short; At risk shows even folded. */}
          <button type="button" onClick={() => setTopicsOpen(!topicsShown)} aria-expanded={topicsShown}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '0.75rem 0.75rem 0.25rem', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
            <span style={{ flex: 1, textAlign: 'left' }}>Problem type</span>
            {!topicsShown && (topicCounts.risk ?? 0) > 0 && (
              <Chip tone="danger">{topicCounts.risk} at risk</Chip>
            )}
            <ChevronDown size={13} style={{ transition: 'transform .15s', transform: topicsShown ? 'rotate(180deg)' : 'none' }} />
          </button>
          {topicsShown && INBOX_TOPICS.map(t => {
            const Icon = TOPIC_ICONS[t.key] || Inbox;
            const n = topicCounts[t.key] ?? 0;
            const id = `topic:${t.key}` as InboxTab;
            return (
              <button
                key={id}
                title={t.hint}
                onClick={() => { setTab(id); setSearchInput(''); setSearchQ(''); setActiveId(null); setSidebarOpen(false); }}
                className={`nav-btn ${tab === id ? 'active' : ''}`}
                style={{ width: '100%' }}
              >
                <Icon size={16} style={t.key === 'risk' && n > 0 ? { color: 'var(--danger)' } : undefined} />
                <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>{t.label}</span>
                {n > 0 && (
                  <Chip tone={t.key === 'risk' ? 'danger' : 'muted'}>{n}</Chip>
                )}
              </button>
            );
          })}
        </nav>

        <div style={{ marginTop: 'auto', padding: '0.75rem', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          {/* Who is signed in: their name and role; opens My profile (Login & security for the owner). */}
          {user && (
            <button type="button" className="nav-btn" onClick={() => setMeOpen(true)} style={{ width: '100%', marginBottom: '0.25rem' }}
              title={user.role === 'admin' ? 'Login & security' : 'My profile'}>
              <UserCheck size={16} />
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.displayName}</span>
              <span style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--fg-muted)' }}>
                {user.role === 'admin' ? 'Owner' : (ROLE_INFO[user.role as Exclude<Role, 'admin'>]?.label ?? user.role)}
              </span>
            </button>
          )}
          <button className="nav-btn" onClick={() => router.push('/admin')} style={{ width: '100%' }}>
            <ShoppingBag size={16} /> Back to Orders
          </button>
          <button className="nav-btn" onClick={logout} style={{ width: '100%', marginTop: '0.25rem' }}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>
  );
}
