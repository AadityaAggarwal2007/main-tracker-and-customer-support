'use client';

import { isSuperAdmin } from '@/lib/permissions';
import { MessageCircle, Loader2, Plus, Check } from 'lucide-react';
import type { AuthUser, PanelChatSite } from '../_lib/types';

export default function ChatWidgetCard({ chatSite, copiedSnippet, embedSnippet, saveChatSettings, savingChat, setCopiedSnippet, showAlert, user }: {
  chatSite: PanelChatSite | null;
  copiedSnippet: boolean;
  embedSnippet: string;
  saveChatSettings: (patch: Record<string, unknown>) => Promise<void>;
  savingChat: boolean;
  setCopiedSnippet: React.Dispatch<React.SetStateAction<boolean>>;
  showAlert: (type: string, message: string) => void;
  user: AuthUser | null;
}) {
  return (
                  <div className="tf-card" style={{ padding: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <MessageCircle size={16} style={{ color: 'var(--primary)' }} />
                      <span style={{ fontWeight: 700 }}>Chat Widget</span>
                      {chatSite && chatSite.conversations > 0 && (
                        <span style={{ fontSize: '0.625rem', color: 'var(--fg-muted)' }}>
                          {chatSite.conversations.toLocaleString()} conversations so far
                        </span>
                      )}
                    </div>
                    <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginBottom: '1rem', lineHeight: 1.5 }}>
                      Paste this into the store&rsquo;s theme and customers get a chat bubble answered by
                      the same AI that answers email. Conversations land in <strong>Chat Support</strong>.
                    </p>

                    {!chatSite && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', fontStyle: 'italic', margin: 0 }}>
                          Chat is not set up for this panel yet.
                        </p>
                        <button className="btn btn-primary btn-sm" disabled={savingChat}
                          onClick={() => saveChatSettings({ aiEnabled: true })}>
                          {savingChat
                            ? <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Setting up…</>
                            : <><Plus size={14} /> Set up chat</>}
                        </button>
                      </div>
                    )}

                    {chatSite && (
                      <>
                        <div className="form-group">
                          <label className="form-label">Embed code — paste before &lt;/body&gt; in the Shopify theme</label>
                          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                            <textarea
                              className="form-input"
                              readOnly
                              rows={2}
                              value={embedSnippet}
                              onFocus={(e) => e.target.select()}
                              style={{ flex: 1, height: 'auto', fontFamily: 'monospace', fontSize: '0.6875rem', resize: 'vertical' }}
                            />
                            <button
                              className="btn btn-outline btn-sm"
                              onClick={() => {
                                navigator.clipboard.writeText(embedSnippet).then(
                                  () => { setCopiedSnippet(true); setTimeout(() => setCopiedSnippet(false), 2000); },
                                  () => showAlert('error', 'Could not copy — select the text instead')
                                );
                              }}
                            >
                              {copiedSnippet ? <><Check size={14} /> Copied</> : 'Copy'}
                            </button>
                          </div>
                        </div>

                        {isSuperAdmin(user) && (
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <button
                            className="btn btn-outline"
                            disabled={savingChat}
                            onClick={() => {
                              if (!confirm('Generate a new key? The widget stops working on every store using the old embed code until they paste the new one.')) return;
                              saveChatSettings({ regenerateKey: true });
                            }}
                          >
                            Regenerate key
                          </button>
                        </div>
                        )}
                      </>
                    )}
                  </div>
  );
}
