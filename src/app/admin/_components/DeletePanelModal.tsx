'use client';

import { X, Loader2, Trash2 } from 'lucide-react';
import type { Business, PanelImpact } from '../_lib/types';
import { plural } from '../_lib/format';

export default function DeletePanelModal({ deleteConfirmText, deleteImpact, deleteImpactLoading, deletePanelTarget, deletingPanel, handleDeletePanel, setDeleteConfirmText, setDeleteImpact, setDeletePanelTarget }: {
  deleteConfirmText: string;
  deleteImpact: PanelImpact | null;
  deleteImpactLoading: boolean;
  deletePanelTarget: Business | null;
  deletingPanel: boolean;
  handleDeletePanel: () => Promise<void>;
  setDeleteConfirmText: React.Dispatch<React.SetStateAction<string>>;
  setDeleteImpact: React.Dispatch<React.SetStateAction<PanelImpact | null>>;
  setDeletePanelTarget: React.Dispatch<React.SetStateAction<Business | null>>;
}) {
  return (
        <div className="modal-overlay" onClick={() => { if (!deletingPanel) { setDeletePanelTarget(null); setDeleteImpact(null); setDeleteConfirmText(''); } }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title" style={{ color: 'var(--danger)' }}>Delete panel &ldquo;{deletePanelTarget.name}&rdquo;</h3>
                <p className="modal-subtitle">This removes the panel everywhere. It cannot be undone.</p>
              </div>
              <button className="btn-icon" disabled={deletingPanel} onClick={() => { setDeletePanelTarget(null); setDeleteImpact(null); setDeleteConfirmText(''); }}><X size={16} /></button>
            </div>

            <div className="space-y-4">
              {deleteImpactLoading && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Checking what this panel holds…
                </p>
              )}

              {deleteImpact && (
                <>
                  <div style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', overflow: 'hidden' }}>
                    <div style={{ padding: '0.5rem 0.75rem', background: 'var(--bg-subtle, rgba(0,0,0,0.03))', fontSize: '0.75rem', fontWeight: 700 }}>
                      Tracker
                    </div>
                    <div style={{ padding: '0.625rem 0.75rem', fontSize: '0.8125rem', display: 'grid', gap: '0.25rem' }}>
                      <div>{plural(deleteImpact.orders, 'order')} — and all order items, status history, email logs and queued drafts</div>
                      <div>{plural(deleteImpact.tickets, 'support ticket')} — and all ticket messages</div>
                      {deleteImpact.isShopifyConnected && (
                        <div>Shopify webhook for {deleteImpact.shopifyDomain || 'this store'} is removed</div>
                      )}
                    </div>
                    <div style={{ padding: '0.5rem 0.75rem', background: 'var(--bg-subtle, rgba(0,0,0,0.03))', fontSize: '0.75rem', fontWeight: 700, borderTop: '1px solid var(--border)' }}>
                      Chat support
                    </div>
                    <div style={{ padding: '0.625rem 0.75rem', fontSize: '0.8125rem' }}>
                      {deleteImpact.chatSites > 0
                        ? `The linked chat site, ${plural(deleteImpact.chatConversations, 'conversation')} and ${plural(deleteImpact.chatMessages, 'message')}`
                        : 'No chat site is linked to this panel'}
                    </div>
                  </div>

                  {deleteImpact.isDefault && (
                    <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>
                      This is the default panel — the oldest remaining panel becomes the default for tracking pages and emails.
                    </p>
                  )}
                  {deleteImpact.teamMembersLosingAccess > 0 && (
                    <p style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>
                      {plural(deleteImpact.teamMembersLosingAccess, 'team member')} will be deactivated — this is their only panel.
                    </p>
                  )}
                </>
              )}

              <div className="form-group">
                <label className="form-label">Type <strong>{deletePanelTarget.name}</strong> to confirm</label>
                <input
                  className="form-input"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder={deletePanelTarget.name}
                  autoFocus
                />
              </div>

              <div className="modal-actions">
                <button className="btn btn-outline" disabled={deletingPanel} onClick={() => { setDeletePanelTarget(null); setDeleteImpact(null); setDeleteConfirmText(''); }}>Cancel</button>
                <button
                  className="btn"
                  style={{ background: 'var(--danger)', color: '#fff' }}
                  disabled={deletingPanel || deleteImpactLoading || deleteConfirmText.trim() !== deletePanelTarget.name.trim()}
                  onClick={handleDeletePanel}
                >
                  {deletingPanel ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Deleting…</> : <><Trash2 size={14} /> Delete panel permanently</>}
                </button>
              </div>
            </div>
          </div>
        </div>
  );
}
