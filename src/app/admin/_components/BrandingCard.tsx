'use client';

import { Building2, Upload, X, Loader2, Check } from 'lucide-react';
import type { Business } from '../_lib/types';

export default function BrandingCard({ activeBusiness, brandForm, fetchBusinesses, savingBrand, setBrandForm, setSavingBrand, showAlert, token }: {
  activeBusiness: Business | null;
  brandForm: { name: string; logoUrl: string; supportEmail: string; supportPhone: string; trackingDomain: string; primaryColor: string; originCity: string };
  fetchBusinesses: () => Promise<void>;
  savingBrand: boolean;
  setBrandForm: React.Dispatch<React.SetStateAction<{ name: string; logoUrl: string; supportEmail: string; supportPhone: string; trackingDomain: string; primaryColor: string; originCity: string }>>;
  setSavingBrand: React.Dispatch<React.SetStateAction<boolean>>;
  showAlert: (type: string, message: string) => void;
  token: string;
}) {
  return (
                  <div className="tf-card" style={{ padding: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
                      <Building2 size={16} style={{ color: 'var(--primary)' }} />
                      <span style={{ fontWeight: 700 }}>Branding</span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
                      {brandForm.logoUrl ? (
                        <img src={brandForm.logoUrl.includes('drive.google.com') ? brandForm.logoUrl.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1') : brandForm.logoUrl} alt="Logo" style={{ width: '4rem', height: '4rem', borderRadius: '0.75rem', objectFit: 'cover', border: '2px solid var(--border)' }} />
                      ) : (
                        <div style={{ width: '4rem', height: '4rem', borderRadius: '0.75rem', background: brandForm.primaryColor || 'var(--primary-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', fontWeight: 700, color: '#fff' }}>
                          {brandForm.name ? brandForm.name.charAt(0).toUpperCase() : '?'}
                        </div>
                      )}
                      <div>
                        <p style={{ fontWeight: 700, fontSize: '1.125rem' }}>{brandForm.name || 'Panel Name'}</p>
                        <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Customers see this on tracking pages &amp; emails</p>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                      <div className="form-group">
                        <label className="form-label">Panel / Brand Name *</label>
                        <input className="form-input" value={brandForm.name} onChange={(e) => setBrandForm({ ...brandForm, name: e.target.value })} placeholder="e.g. My Store" />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Brand Color</label>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                          <input type="color" value={brandForm.primaryColor} onChange={(e) => setBrandForm({ ...brandForm, primaryColor: e.target.value })} style={{ width: 36, height: 36, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                          <input className="form-input" value={brandForm.primaryColor} onChange={(e) => setBrandForm({ ...brandForm, primaryColor: e.target.value })} style={{ flex: 1 }} />
                        </div>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Logo URL / Upload</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                            <Upload size={14} /> Upload
                            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              if (file.size > 500 * 1024) { showAlert('error', 'Logo must be under 500KB'); return; }
                              const reader = new FileReader();
                              reader.onload = () => setBrandForm({ ...brandForm, logoUrl: reader.result as string });
                              reader.readAsDataURL(file);
                            }} />
                          </label>
                          {brandForm.logoUrl && <button className="btn-icon" onClick={() => setBrandForm({ ...brandForm, logoUrl: '' })} style={{ color: 'var(--danger)' }}><X size={14} /></button>}
                        </div>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Support Email</label>
                        <input className="form-input" type="email" value={brandForm.supportEmail} onChange={(e) => setBrandForm({ ...brandForm, supportEmail: e.target.value })} placeholder="support@yourbrand.com" />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Support Phone</label>
                        <input className="form-input" value={brandForm.supportPhone} onChange={(e) => setBrandForm({ ...brandForm, supportPhone: e.target.value })} placeholder="+91 98765 43210" />
                      </div>
                      <div className="form-group">
                        <label className="form-label">🏭 Ship-from City (warehouse)</label>
                        <input className="form-input" value={brandForm.originCity} onChange={(e) => setBrandForm({ ...brandForm, originCity: e.target.value })} placeholder="Delhi" />
                        <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                          Shown as the origin on the customer&apos;s tracking feed (&quot;Picked Up — Delhi warehouse&quot;).
                          Leave blank and it just says &quot;Seller warehouse&quot; — it will never guess a city.
                        </p>
                      </div>
                      <div className="form-group">
                        <label className="form-label">📧 Tracking Domain (fixes IP bug)</label>
                        <input className="form-input" value={brandForm.trackingDomain} onChange={(e) => setBrandForm({ ...brandForm, trackingDomain: e.target.value })} placeholder="https://track.yourbrand.com" />
                        <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.25rem' }}>
                          Email tracking links use this domain. Leave blank to use server default.
                        </p>
                      </div>
                    </div>

                    <div style={{ marginTop: '1.25rem' }}>
                      <button className="btn btn-primary" disabled={!brandForm.name || savingBrand} onClick={async () => {
                        setSavingBrand(true);
                        try {
                          const body = {
                            id: activeBusiness.id, name: brandForm.name,
                            logoUrl: brandForm.logoUrl || null,
                            supportEmail: brandForm.supportEmail || null,
                            supportPhone: brandForm.supportPhone || null,
                            trackingDomain: brandForm.trackingDomain || null,
                            originCity: brandForm.originCity || null,
                            primaryColor: brandForm.primaryColor || '#4F46E5',
                          };
                          const res = await fetch('/api/businesses', {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                            body: JSON.stringify(body),
                          });
                          if (res.ok) { showAlert('success', 'Panel settings saved!'); fetchBusinesses(); }
                          else showAlert('error', 'Failed to save');
                        } catch { showAlert('error', 'Failed to save'); }
                        finally { setSavingBrand(false); }
                      }}>
                        {savingBrand ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Check size={14} />}
                        {savingBrand ? 'Saving...' : 'Save Branding'}
                      </button>
                    </div>
                  </div>
  );
}
