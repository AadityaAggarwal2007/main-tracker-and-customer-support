'use client';

import { Check, Trash2 } from 'lucide-react';
import type { AuthUser, Business } from '../_lib/types';

export default function SettingsPanelList({ activePanelId, businesses, openDeletePanel, switchPanel, user }: {
  activePanelId: string;
  businesses: Business[];
  openDeletePanel: (biz: Business) => Promise<void>;
  switchPanel: (panelId: string) => void;
  user: AuthUser | null;
}) {
  return (
                <div className="tf-card" style={{ padding: '1rem' }}>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--fg-muted)' }}>All Panels</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {businesses.map(biz => (
                      <div key={biz.id} style={{
                        display: 'flex', alignItems: 'center',
                        borderRadius: '9999px', border: activePanelId === biz.id ? '2px solid var(--primary)' : '1px solid var(--border)',
                        background: activePanelId === biz.id ? 'var(--primary-light)' : 'var(--card-bg)',
                        overflow: 'hidden',
                      }}>
                        <button onClick={() => switchPanel(biz.id)} style={{
                          display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.75rem',
                          border: 'none', background: 'transparent',
                          fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer',
                          color: activePanelId === biz.id ? 'var(--primary)' : 'var(--fg)',
                        }}>
                          {biz.is_shopify_connected && <span style={{ color: 'var(--success)', fontSize: '0.5rem' }}>●</span>}
                          {biz.name}
                          {activePanelId === biz.id && <Check size={10} />}
                        </button>
                        {user?.role === 'admin' && (
                          <button
                            onClick={() => openDeletePanel(biz)}
                            title={`Delete panel "${biz.name}"`}
                            style={{
                              display: 'flex', alignItems: 'center', padding: '0.375rem 0.5rem 0.375rem 0.25rem',
                              border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--danger)',
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
  );
}
