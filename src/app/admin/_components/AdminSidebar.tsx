'use client';

import type { useRouter } from 'next/navigation';
import { ROLE_INFO, can, type Role } from '@/lib/permissions';
import { MessageCircle, ShieldCheck, UserRound, LogOut, type LucideIcon } from 'lucide-react';
import PanelSwitcher from '@/components/PanelSwitcher';
import type { AuthUser, Business, TabType } from '../_lib/types';

export default function AdminSidebar({ activeBusiness, activePanelId, activeTab, businesses, chargebackNew, emailWaiting, humanNeeded, logout, navItems, openMe, refundUnseen, router, setActiveTab, setProfileOpen, setSecurityOpen, setSidebarOpen, sidebarOpen, switchPanel, user }: {
  activeBusiness: Business | null;
  activePanelId: string;
  activeTab: TabType;
  businesses: Business[];
  chargebackNew: number;
  emailWaiting: number;
  humanNeeded: number;
  logout: () => void;
  navItems: { id: TabType; label: string; icon: LucideIcon; show: boolean }[];
  openMe: () => void;
  refundUnseen: number;
  router: ReturnType<typeof useRouter>;
  setActiveTab: React.Dispatch<React.SetStateAction<TabType>>;
  setProfileOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSecurityOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sidebarOpen: boolean;
  switchPanel: (panelId: string) => void;
  user: AuthUser | null;
}) {
  return (
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="psw-wrap">
          <PanelSwitcher
            panels={businesses.filter(b => !user?.businessIds || user.businessIds.includes(b.id))}
            activeId={activePanelId}
            onSelect={switchPanel}
          />
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-btn ${activeTab === item.id ? 'active' : ''}`}
              onClick={() => { setActiveTab(item.id); setSidebarOpen(false); }}
            >
              <item.icon size={18} />
              {item.label}
              {item.id === 'chargebacks' && chargebackNew > 0 && (
                <span title={`${chargebackNew} new chargeback ${chargebackNew === 1 ? 'mail' : 'mails'} you have not opened`}
                  style={{
                    marginLeft: 'auto', minWidth: 20, height: 20, padding: '0 6px', borderRadius: 9999,
                    background: 'var(--danger, #ef4444)', color: '#fff', fontSize: '0.6875rem', fontWeight: 700,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                  {chargebackNew}
                </span>
              )}
              {item.id === 'refunds' && refundUnseen > 0 && (
                <span title={`${refundUnseen} new refund ${refundUnseen === 1 ? 'request' : 'requests'} you have not opened`}
                  style={{
                    marginLeft: 'auto', minWidth: 20, height: 20, padding: '0 6px', borderRadius: 9999,
                    background: 'var(--danger, #ef4444)', color: '#fff', fontSize: '0.6875rem', fontWeight: 700,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                  {refundUnseen}
                </span>
              )}
            </button>
          ))}
          {/* Chat Support — chat widget conversations and email in one inbox (for logins that may open it) */}
          {user && can(user, 'chat.view') && (
            <button
              className="nav-btn"
              onClick={() => router.push('/admin/chat')}
              style={{ borderTop: '1px solid var(--border)', marginTop: '0.25rem', paddingTop: '0.75rem' }}
            >
              <MessageCircle size={18} />
              <span style={{ flex: 1, textAlign: 'left' }}>Chat Support</span>
              {humanNeeded > 0 && (
                <span
                  title={
                    emailWaiting > 0
                      ? `${humanNeeded} waiting for a person — ${emailWaiting} by email, and those customers get no reply until you answer`
                      : `${humanNeeded} waiting for a person`
                  }
                  style={{
                    minWidth: 20, height: 20, padding: '0 6px', borderRadius: 9999,
                    background: 'var(--danger, #ef4444)', color: '#fff',
                    fontSize: '0.6875rem', fontWeight: 700,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {humanNeeded}
                </span>
              )}
            </button>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user" role="button" tabIndex={0} title={user.role === 'admin' ? 'Login & security' : 'My profile'} onClick={openMe}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMe(); } }} style={{ cursor: 'pointer' }}>
            <div className="sidebar-avatar">{user.displayName.charAt(0).toUpperCase()}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{user.displayName}</div>
              <span className="role-pill">{user.role === 'admin' ? 'Owner' : (ROLE_INFO[user.role as Exclude<Role, 'admin'>]?.label ?? user.role)}</span>
            </div>
          </div>
          {user.role === 'admin' ? (
            <button className="nav-btn" onClick={() => setSecurityOpen(true)}>
              <ShieldCheck size={18} /> Login &amp; security
            </button>
          ) : (
            <button className="nav-btn" onClick={() => setProfileOpen(true)}>
              <UserRound size={18} /> My profile
            </button>
          )}
          <button className="nav-btn" onClick={logout} style={{ marginTop: '0.25rem' }}>
            <LogOut size={18} /> Sign out
          </button>
        </div>
      </aside>
  );
}
