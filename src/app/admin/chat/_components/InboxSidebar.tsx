'use client';

import type { useRouter } from 'next/navigation';
import { ShoppingBag, LogOut, MessageCircle, UserCheck, MailOpen, CheckCheck } from 'lucide-react';
import PanelSwitcher from '@/components/PanelSwitcher';
import { ROLE_INFO, type Role } from '@/lib/permissions';
import type { AuthUser, Business, InboxTab } from '../_lib/types';
import { TOPIC_ICONS, INBOX_TABS } from '../_lib/inbox';
import type { ChipTone } from './chips';
import { Chip } from './chips';

export default function InboxSidebar({ simple, activeCounts, activePanelId, businesses, canReply, caseCounts, logout, myChats, router, setActiveId, setActivePanelId, setMeOpen, setSearchInput, setSearchQ, setSidebarOpen, setTab, sidebarOpen, tab, topicCounts, unreadTotal, user }: {
  simple: boolean;
  activeCounts: { open: number; closed: number };
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
  sidebarOpen: boolean;
  tab: InboxTab;
  topicCounts: Record<string, number>;
  unreadTotal: number;
  user: AuthUser | null;
}) {
  const base = (v: InboxTab) => INBOX_TABS.find(t => t.v === v)!;
  const caseN = (k: 'refund' | 'reship') => caseCounts[k] ?? { total: 0, unread: 0 };
  type Item = { v: InboxTab; label: string; icon: typeof UserCheck; n: number; tone: ChipTone; text?: string; hint?: string; sub?: boolean; line?: string };
  const caseItem = (k: 'refund' | 'reship'): Item => {
    const c = caseN(k);
    return { v: `case:${k}` as InboxTab, label: base(`case:${k}` as InboxTab).label, icon: base(`case:${k}` as InboxTab).icon, n: c.total, tone: c.unread ? 'danger' : 'muted', text: c.unread ? `${c.unread} waiting` : undefined,
      hint: `${c.total} chat${c.total === 1 ? '' : 's'}${c.unread ? `, ${c.unread} waiting for an answer` : ''}` };
  };
  const groups: { title: string; items: Item[] }[] = [
    { title: 'Do now', items: [
      { v: 'mine', label: 'My chats', icon: base('mine').icon, n: myChats.open, tone: myChats.waiting ? 'danger' : 'muted', hint: `${myChats.open} open chat${myChats.open === 1 ? '' : 's'} you hold${myChats.waiting ? `, ${myChats.waiting} waiting for an answer` : ''}` },
      { v: 'human_needed', label: 'Needs you', icon: base('human_needed').icon, n: 0, tone: 'danger', hint: 'Chats where the AI stopped and a person must answer' },
      { v: 'topic:risk', label: 'At risk', icon: TOPIC_ICONS.risk, n: topicCounts.risk ?? 0, tone: 'danger', hint: 'Frustrated customers who may charge back' },
    ] },
    { title: 'Cases', items: [caseItem('refund'), caseItem('reship')] },
    { title: 'Team and AI', items: [
      { v: 'agent_handling', label: 'With team', icon: base('agent_handling').icon, n: 0, tone: 'muted' },
      { v: 'active:open', label: 'Open case', icon: MailOpen, n: activeCounts.open, tone: 'danger', sub: true, hint: 'The customer wrote and nobody has answered yet' },
      { v: 'active:closed', label: 'Closed case', icon: CheckCheck, n: activeCounts.closed, tone: 'muted', sub: true, hint: 'A team member answered; it comes back to Open case when the customer writes again' },
      { v: 'ai_handling', label: 'With AI', icon: base('ai_handling').icon, n: 0, tone: 'muted' },
    ] },
    { title: 'Everyone', items: [
      { v: 'all', label: 'All customers', icon: base('all').icon, n: 0, tone: 'muted' },
      { v: 'visitors', label: 'Visitors', icon: base('visitors').icon, n: 0, tone: 'muted' },
      { v: 'resolved', label: 'Closed', icon: base('resolved').icon, n: 0, tone: 'muted' },
    ] },
  ];
  // A team member's menu (owner 2026-10-08): their Active cases, Needs you, the Refund / Ship again
  // cases and the customers who open chats. The rest is the Super Admin's.
  const simpleGroups: { title: string; items: Item[] }[] = [
    { title: 'Your chats', items: [
      { v: 'active:open', label: 'Open case', icon: MailOpen, n: activeCounts.open, tone: 'danger', line: 'Customer wrote. Reply to them.' },
      { v: 'active:closed', label: 'Closed case', icon: CheckCheck, n: activeCounts.closed, tone: 'muted', line: 'You answered. It comes back to Open case if they write again.' },
      { v: 'human_needed', label: 'Needs you', icon: base('human_needed').icon, n: 0, tone: 'danger', line: 'The AI stopped. A person must answer.' },
    ] },
    { title: 'Cases', items: [caseItem('refund'), caseItem('reship')] },
    { title: 'Customers', items: [{ v: 'all', label: 'All customers', icon: base('all').icon, n: 0, tone: 'muted', line: 'Everyone who opened a chat.' }] },
  ];
  const view = simple ? simpleGroups : groups;
  return (
      <aside className={`sidebar chat-side ${sidebarOpen ? 'open' : ''}`}>
        {simple && user ? (
          // The team member's own board (owner 2026-10-08): their name, how many chats are pending, and where to
          // finish them. A slow ring turns while chats are pending; it stops for people who ask for less motion.
          <div className="my-work">
            <div className="mw-title">{user.displayName.trim().split(/\s+/)[0]} Chat Support</div>
            {unreadTotal > 0 ? (
              <>
                <div className="mw-body">
                  <div className="mw-ring" aria-hidden="true">
                    <svg viewBox="0 0 44 44"><circle className="mw-track" cx="22" cy="22" r="19" /><circle className="mw-arc" cx="22" cy="22" r="19" /></svg>
                    <span className="mw-num">{unreadTotal}</span>
                  </div>
                  <div className="mw-text"><b>{unreadTotal} chat{unreadTotal === 1 ? '' : 's'} pending</b><br />Please finish them.</div>
                </div>
                <div className="mw-go">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => { setTab('active:open'); setSearchInput(''); setSearchQ(''); setActiveId(null); setSidebarOpen(false); }}>Open case</button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => { setTab('human_needed'); setSearchInput(''); setSearchQ(''); setActiveId(null); setSidebarOpen(false); }}>Needs you</button>
                </div>
              </>
            ) : (
              <div className="mw-body"><div className="mw-ring mw-done" aria-hidden="true"><span className="mw-num">✓</span></div><div className="mw-text"><b>All done</b><br />No chat is waiting.</div></div>
            )}
          </div>
        ) : (
          <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
              <MessageCircle size={15} /> Chat Support
            </div>
            <div className="meta" style={{ marginTop: '0.25rem' }}>
              {unreadTotal > 0 ? `${unreadTotal} waiting` : 'Chat and email in one place'}
            </div>
          </div>
        )}

        {/* Panel selector: the same switcher as the admin page */}
        <div className="psw-wrap">
          <PanelSwitcher
            panels={businesses.filter(b => !user?.businessIds || user.businessIds.includes(b.id))}
            activeId={activePanelId}
            onSelect={(id) => {
              setActivePanelId(id);
              localStorage.setItem('active_panel_id', id);
              setActiveId(null);
              setSidebarOpen(false);
            }}
          />
        </div>

        {/* The menu is a work flow, top to bottom (owner 2026-10-08: "koi flow nahi hai"): what to do
            now, the Refund / Ship again cases, who has the rest, then everything else. The problem
            types (refund, delay, address...) are filter chips above the list (ListHeader), not menu
            items. Same tabs and same server filters as before; only the grouping changed. */}
        <nav style={{ padding: '0.5rem', flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {view.map((g, gi) => (
            <div key={g.title}>
              <div className="nav-group">{g.title}</div>
              {g.items.filter(it => it.v !== 'mine' || canReply).map(it => (
                <button
                  key={it.v}
                  title={it.hint}
                  onClick={() => { setTab(it.v); setSearchInput(''); setSearchQ(''); setActiveId(null); setSidebarOpen(false); }}
                  className={`nav-btn${tab === it.v ? ' active' : ''}${it.sub ? ' nav-sub' : ''}${it.line ? ' nav-simple' : ''}`}
                  style={{ width: '100%' }}
                >
                  <it.icon size={it.line ? 18 : 16} style={it.v === 'topic:risk' && it.n > 0 && tab !== it.v ? { color: 'var(--danger)' } : undefined} />
                  <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                    <span style={{ display: 'block' }}>{it.label}</span>
                    {it.line && <span className="nav-line">{it.line}</span>}
                  </span>
                  {it.n > 0 && <Chip tone={it.tone}>{it.text ?? it.n}</Chip>}
                </button>
              ))}
              {gi < view.length - 1 && <div style={{ height: 1, background: 'var(--border)', margin: '0.5rem 0.25rem' }} />}
            </div>
          ))}
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
