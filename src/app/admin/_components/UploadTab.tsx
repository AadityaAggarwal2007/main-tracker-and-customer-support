'use client';

import { Loader2, FileUp, Mail, Activity, Info } from 'lucide-react';
import type { Business, RecentUpload } from '../_lib/types';

export default function UploadTab({ recentUploads, businesses, dragOver, fetchQueueStats, handleFileUpload, loadingQueue, queueStats, setDragOver, setUploadPanelId, uploadPanelId, uploadProgress, uploadResult, uploading }: {
  recentUploads: RecentUpload[];
  businesses: Business[];
  dragOver: boolean;
  fetchQueueStats: () => Promise<void>;
  handleFileUpload: (file: File) => Promise<void>;
  loadingQueue: boolean;
  queueStats: { pending: number; sent?: number; processing: number; done: number; failed: number; total: number } | null;
  setDragOver: React.Dispatch<React.SetStateAction<boolean>>;
  setUploadPanelId: React.Dispatch<React.SetStateAction<string>>;
  uploadPanelId: string;
  uploadProgress: { current: number; total: number; percent: number };
  uploadResult: Record<string, unknown> | null;
  uploading: boolean;
}) {
  return (
            <div className="space-y-6 animate-fade-in-up max-w-2xl">
              <div>
                <h2 className="page-title">Upload CSV</h2>
                <p className="page-subtitle">Import orders from Shopify CSV export</p>
              </div>

              {/* ── PANEL SELECTOR — required before upload ── */}
              <div className="tf-card" style={{ padding: '1rem' }}>
                <label style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '0.5rem' }}>
                  📂 Step 1 — Select which panel this CSV belongs to
                </label>
                <select
                  value={uploadPanelId}
                  onChange={e => setUploadPanelId(e.target.value)}
                  style={{
                    width: '100%', padding: '0.625rem 0.875rem', borderRadius: 'var(--radius-lg)',
                    border: uploadPanelId ? '1.5px solid var(--success)' : '1.5px solid var(--warning)',
                    background: 'var(--bg-subtle)', color: 'var(--fg)', fontSize: '0.9rem', cursor: 'pointer',
                  }}
                >
                  <option value="">— Choose panel (required) —</option>
                  {businesses.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                {!uploadPanelId && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--warning)', marginTop: '0.375rem' }}>
                    ⚠️ You must select a panel. All orders in the CSV will be locked to this panel.
                  </p>
                )}
                {uploadPanelId && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--success)', marginTop: '0.375rem' }}>
                    ✅ All orders in this CSV will go to: <strong>{businesses.find(b => b.id === uploadPanelId)?.name}</strong>
                  </p>
                )}
              </div>

              {/* Drop zone */}
              <div
                className={`upload-zone ${dragOver ? 'dragging' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); const file = e.dataTransfer.files[0]; if (file) handleFileUpload(file); }}
              >
                {uploading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', width: '100%', padding: '0 2rem' }}>
                    <Loader2 size={40} style={{ animation: 'spin 0.6s linear infinite', color: 'var(--primary)' }} />
                    <p style={{ fontSize: '0.875rem', fontWeight: 500 }}>
                      {uploadProgress.total > 0
                        ? `Chunk ${uploadProgress.current}/${uploadProgress.total} — ${uploadProgress.percent}%`
                        : 'Parsing CSV...'}
                    </p>
                    {uploadProgress.total > 0 && (
                      <div style={{ width: '100%', height: '6px', background: 'var(--muted)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${uploadProgress.percent}%`, height: '100%', background: 'var(--primary)', borderRadius: '3px', transition: 'width 0.3s ease' }} />
                      </div>
                    )}
                    <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Each chunk ~500 rows • fits within 10s timeout</p>
                  </div>
                ) : (
                  <>
                    <div className="upload-icon"><FileUp /></div>
                    <p className="upload-title">Drop your CSV file here</p>
                    <p className="upload-hint">or click to browse • .csv only</p>
                    <input type="file" accept=".csv" onChange={(e) => { const file = e.target.files?.[0]; if (file) handleFileUpload(file); }} />
                  </>
                )}
              </div>

              {/* Results */}
              {uploadResult && (
                <div className="upload-results">
                  {[
                    { label: 'CSV Rows', value: (uploadResult as Record<string, number>).total },
                    { label: 'Unique Orders', value: (uploadResult as Record<string, number>).unique },
                    { label: 'New', value: (uploadResult as Record<string, number>).newOrders },
                    { label: 'Updated', value: (uploadResult as Record<string, number>).updatedOrders },
                  ].map((r) => (
                    <div key={r.label} className="upload-result-card">
                      <p className="upload-result-value">{r.value}</p>
                      <p className="upload-result-label">{r.label}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Recent uploads: which file went into which panel (owner 2026-10-08) */}
              <div className="tf-card" style={{ padding: '1rem' }}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.5rem' }}>Recent uploads</div>
                {recentUploads.length === 0 ? (
                  <p className="meta">No uploads recorded yet.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                    {recentUploads.map((u) => (
                      <div key={u.id} style={{ padding: '0.5rem 0.625rem', background: 'var(--bg-subtle)', borderRadius: 'var(--radius)', fontSize: '0.75rem', lineHeight: 1.45 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <b style={{ fontSize: '0.8125rem' }}>{u.panel_name || 'Panel not recorded'}</b>
                          <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{u.filename}</span>
                          <span className="meta">{new Date(u.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</span>
                        </div>
                        <div className="meta">
                          {u.uploaded_by || 'unknown'} · {u.new_orders} new · {u.updated_orders} updated
                          {u.first_order ? ` · orders #${String(u.first_order).replace(/^#/, '')} to #${String(u.last_order ?? u.first_order).replace(/^#/, '')}` : ''}
                        </div>
                        {u.warning_text && <div style={{ color: 'hsl(32, 90%, 32%)', fontWeight: 600 }} title={u.warning_text}>⚠ Uploaded after a warning: {u.warning_text}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Email Queue Status */}
              <div className="tf-card" style={{ padding: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  <Mail size={15} style={{ color: 'var(--primary)' }} />
                  <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>Email Queue</span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.625rem', padding: '0.125rem 0.5rem', borderRadius: '9999px', background: 'var(--primary-light)', color: 'var(--primary)', fontWeight: 600 }}>
                    1 email / min
                  </span>
                  <button
                    className="btn-icon"
                    onClick={fetchQueueStats}
                    title="Refresh queue stats"
                    style={{ marginLeft: '0.25rem' }}
                    disabled={loadingQueue}
                  >
                    {loadingQueue
                      ? <Loader2 size={13} style={{ animation: 'spin 0.6s linear infinite' }} />
                      : <Activity size={13} />}
                  </button>
                </div>

                {queueStats ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
                    {[
                      { label: 'Pending', value: queueStats.pending ?? 0, color: 'var(--warning)' },
                      { label: 'Sent', value: queueStats.sent ?? 0, color: 'var(--success)' },
                      { label: 'Failed', value: queueStats.failed ?? 0, color: 'var(--danger)' },
                    ].map((s) => (
                      <div key={s.label} style={{ padding: '0.625rem', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
                        <div style={{ fontSize: '1.25rem', fontWeight: 700, color: s.value > 0 ? s.color : 'var(--fg-muted)' }}>{s.value.toLocaleString()}</div>
                        <div style={{ fontSize: '0.625rem', color: 'var(--fg-muted)', marginTop: '2px', fontWeight: 500 }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', textAlign: 'center', padding: '0.5rem 0' }}>
                    Upload a CSV to see queue status
                  </p>
                )}

                {queueStats && (queueStats.pending ?? 0) > 0 && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginTop: '0.75rem', textAlign: 'center' }}>
                    ⏱️ ~{Math.ceil((queueStats.pending ?? 0) / 60)} hours left &nbsp;·&nbsp; Sending automatically in background
                  </p>
                )}
              </div>

              <div className="info-box">
                <Info size={16} />
                <div>
                  <p className="info-box-title">How it works</p>
                  <p className="info-box-text">
                    Export your orders from Shopify as CSV, then upload here. Brands are <strong>auto-detected</strong> from the Vendor column and panels are created automatically. Re-uploading updates existing orders without duplicates. Emails are <strong>queued automatically</strong> on upload and sent 1 per minute in the background — no clicking needed.
                  </p>
                </div>
              </div>

            </div>
  );
}
