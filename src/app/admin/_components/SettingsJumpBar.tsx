'use client';

import { can, isSuperAdmin } from '@/lib/permissions';
import type { AuthUser, Business, PanelChatSite } from '../_lib/types';

export default function SettingsJumpBar({ activeBusiness, chatSite, user }: {
  activeBusiness: Business;
  chatSite: PanelChatSite | null;
  user: AuthUser | null;
}) {
  return (
                <div style={{ position: 'sticky', top: 0, zIndex: 5, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: '0.5rem 0.625rem',
                  borderRadius: 12, background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(8px)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--fg-muted)', marginRight: 4 }}>{activeBusiness.name}</span>
                  {[
                    { id: 'set-chikki', label: 'Chikki AI', show: !!chatSite && !!user && (can(user, 'settings.panel') || can(user, 'chikki.edit')) },
                    { id: 'set-copy', label: 'Copy setup', show: isSuperAdmin(user) }, { id: 'set-common', label: 'All panels setup', show: isSuperAdmin(user) },
                    { id: 'set-branding', label: 'Branding', show: !!user && can(user, 'settings.panel') },
                    { id: 'set-widget', label: 'Chat widget', show: !!user && can(user, 'settings.panel') },
                    { id: 'set-schedule', label: 'Tracking schedule', show: true },
                    { id: 'set-gmail', label: 'Gmail accounts', show: isSuperAdmin(user) },
                    { id: 'set-shopify', label: 'Shopify', show: isSuperAdmin(user) },
                    { id: 'set-danger', label: 'Danger zone', show: isSuperAdmin(user) },
                  ].filter((x) => x.show).map((x) => (
                    <button key={x.id} type="button" className="btn btn-sm"
                      onClick={() => document.getElementById(x.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      style={{ border: '1px solid var(--border)', background: 'var(--card-bg)', color: x.id === 'set-danger' ? 'var(--danger)' : 'var(--fg-secondary)', borderRadius: 999 }}>
                      {x.label}
                    </button>
                  ))}
                </div>
  );
}
