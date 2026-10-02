'use client';

import type { useRouter } from 'next/navigation';
import { ROLE_INFO, can, type Role } from '@/lib/permissions';
import { ChevronRight, Check, MessageCircle, ShieldCheck, UserRound, LogOut, type LucideIcon } from 'lucide-react';
import type { AuthUser, Business, TabType } from '../_lib/types';

export default function AdminSidebar({ activeBusiness, activePanelId, activeTab, businesses, emailWaiting, humanNeeded, logout, navItems, openMe, refundUnseen, router, setActiveTab, setProfileOpen, setSecurityOpen, setShowPanelDropdown, setSidebarOpen, showPanelDropdown, sidebarOpen, switchPanel, user }: {
  activeBusiness: Business | null;
  activePanelId: string;
  activeTab: TabType;
  businesses: Business[];
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
  setShowPanelDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  showPanelDropdown: boolean;
  sidebarOpen: boolean;
  switchPanel: (panelId: string) => void;
  user: AuthUser | null;
}) {
  return (
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        {/* Panel Switcher */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowPanelDropdown(!showPanelDropdown)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.625rem', width: '100%',
              padding: '0.875rem 1rem', background: 'var(--primary-light)',
              border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            {activeBusiness?.logo_url ? (
              <img src={activeBusiness.logo_url} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'contain', background: '#fff' }} />
            ) : (
              <div style={{ width: 32, height: 32, borderRadius: 6, background: activeBusiness?.primary_color || 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '0.875rem' }}>
                {(activeBusiness?.name || 'T').charAt(0).toUpperCase()}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {activeBusiness?.name || 'All Panels'}
              </div>
              <div style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                {activeBusiness?.is_shopify_connected
                  ? <><span style={{ color: 'var(--success)' }}>●</span> Shopify connected</>
                  : <><span style={{ color: 'var(--fg-muted)' }}>○</span> Switch panel</>}
              </div>
            </div>
            <ChevronRight size={14} style={{ color: 'var(--fg-muted)', transform: showPanelDropdown ? 'rotate(90deg)' : 'none', transition: '0.15s' }} />
          </button>

          {showPanelDropdown && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
              background: 'var(--card-bg)', border: '1px solid var(--border)',
              borderRadius: '0 0 var(--radius-lg) var(--radius-lg)', boxShadow: 'var(--shadow-lg)',
              maxHeight: 260, overflowY: 'auto',
            }}>
              {/* All Panels option */}
              <button
                onClick={() => switchPanel('')}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                  padding: '0.625rem 1rem', border: 'none', background: !activePanelId ? 'var(--primary-light)' : 'transparent',
                  cursor: 'pointer', fontSize: '0.8125rem', fontWeight: !activePanelId ? 700 : 400,
                  color: !activePanelId ? 'var(--primary)' : 'var(--fg)',
                }}
              >
                <div style={{ width: 24, height: 24, borderRadius: 4, background: 'var(--bg-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem' }}>🏪</div>
                All Panels
                {!activePanelId && <Check size={12} style={{ marginLeft: 'auto', color: 'var(--primary)' }} />}
              </button>
              {/* Each accessible panel */}
              {businesses
                .filter(b => !user?.businessIds || user.businessIds.includes(b.id))
                .map(biz => (
                  <button
                    key={biz.id}
                    onClick={() => switchPanel(biz.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                      padding: '0.625rem 1rem', border: 'none',
                      background: activePanelId === biz.id ? 'var(--primary-light)' : 'transparent',
                      cursor: 'pointer', fontSize: '0.8125rem',
                      fontWeight: activePanelId === biz.id ? 700 : 400,
                      color: activePanelId === biz.id ? 'var(--primary)' : 'var(--fg)',
                    }}
                  >
                    {biz.logo_url ? (
                      <img src={biz.logo_url} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'contain', background: '#fff' }} />
                    ) : (
                      <div style={{ width: 24, height: 24, borderRadius: 4, background: biz.primary_color || 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '0.625rem' }}>
                        {biz.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{biz.name}</span>
                    {biz.is_shopify_connected && <span style={{ fontSize: '0.625rem', color: 'var(--success)' }}>●</span>}
                    {activePanelId === biz.id && <Check size={12} style={{ color: 'var(--primary)' }} />}
                  </button>
                ))}
            </div>
          )}
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
