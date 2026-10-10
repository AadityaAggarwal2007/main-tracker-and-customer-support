'use client';

import { useEffect, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import MetaError from './MetaError';
import PhonePreview from './PhonePreview';
import { SECTION, label, spin, type Alert, type WaProfileData, type WaSettings } from './types';
import type { Profile } from '@/lib/chat/whatsapp-profile';

const NAME_STATUS: Record<string, string> = { APPROVED: 'approved', AVAILABLE_WITHOUT_REVIEW: 'approved', PENDING_REVIEW: 'under review by Meta', DECLINED: 'declined by Meta', EXPIRED: 'expired', NON_EXISTS: 'not set' };
const QUALITY: Record<string, string> = { GREEN: 'Good', YELLOW: 'Medium', RED: 'Low', UNKNOWN: 'Not rated yet' };
const LIMIT: Record<string, string> = { TIER_50: '50 customers / day', TIER_250: '250 customers / day', TIER_1K: '1,000 customers / day', TIER_10K: '10,000 customers / day', TIER_100K: '100,000 customers / day', TIER_UNLIMITED: 'unlimited' };

const formOf = (p: Profile | null) => ({ about: p?.about || '', description: p?.description || '', address: p?.address || '', email: p?.email || '', website1: p?.websites[0] || '', website2: p?.websites[1] || '', vertical: p?.vertical || 'UNDEFINED' });

// The number as Meta sees it, the display name, the business profile with the picture, and the phone showing
// the profile sheet as the customer opens it.
export default function ProfilePanel({ token, s, prof, onAlert, reload }: { token: string; s: WaSettings | null; prof: WaProfileData | null; onAlert: Alert; reload: () => Promise<void> }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [pf, setPf] = useState(formOf(prof?.profile || null));
  useEffect(() => { setPf(formOf(prof?.profile || null)); }, [prof]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState('');

  const saveProfile = async () => {
    setBusy('profile');
    try {
      const r = await fetch('/api/whatsapp/profile', { method: 'POST', headers: auth, body: JSON.stringify({ about: pf.about, description: pf.description, address: pf.address, email: pf.email, websites: [pf.website1, pf.website2].filter(Boolean), vertical: pf.vertical }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Meta refused the profile change'); return; }
      onAlert('success', 'Profile updated on WhatsApp'); await reload();
    } finally { setBusy(''); }
  };
  const uploadPicture = async (file: File | null) => {
    if (!file) return;
    setBusy('picture');
    try {
      const fd = new FormData(); fd.append('picture', file);
      const r = await fetch('/api/whatsapp/profile/picture', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not upload the picture'); return; }
      onAlert('success', 'Profile picture updated'); await reload();
    } finally { setBusy(''); }
  };
  const askDisplayName = async () => {
    setBusy('name');
    try {
      const r = await fetch('/api/whatsapp/display-name', { method: 'POST', headers: auth, body: JSON.stringify({ name: newName }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Meta refused the name change'); return; }
      onAlert('success', 'Sent to Meta for review; the name changes once approved'); setNewName(''); await reload();
    } finally { setBusy(''); }
  };
  const verticalLabel = (prof?.verticals || []).find((v) => v.code === pf.vertical)?.label || pf.vertical;
  const name = newName.trim() || s?.phone?.verifiedName || 'Shiptrack';

  return (
    <div className="wa-layout">
      <div style={{ display: 'grid', gap: '1rem' }}>
        <div className="tf-card" style={{ padding: '1.25rem' }}>
          <div style={{ ...SECTION, marginBottom: '0.5rem' }}>The number</div>
          {s?.phoneError && <MetaError error={s.phoneError} />}
          {s?.phone && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem 1rem', fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
              <div><span style={{ color: 'var(--fg-muted)' }}>Number</span><br /><strong>{s.phone.displayPhoneNumber || '—'}</strong></div>
              <div><span style={{ color: 'var(--fg-muted)' }}>Name customers see</span><br /><strong>{s.phone.verifiedName || '—'}</strong> <span style={{ color: 'var(--fg-muted)' }}>({NAME_STATUS[s.phone.nameStatus] || s.phone.nameStatus.toLowerCase()})</span></div>
              <div><span style={{ color: 'var(--fg-muted)' }}>Quality</span><br /><strong>{QUALITY[s.phone.qualityRating] || s.phone.qualityRating}</strong></div>
              <div><span style={{ color: 'var(--fg-muted)' }}>New conversations limit</span><br /><strong>{LIMIT[s.phone.messagingLimit] || s.phone.messagingLimit.toLowerCase()}</strong></div>
              <div><span style={{ color: 'var(--fg-muted)' }}>Status</span><br /><strong>{s.phone.status.toLowerCase()}</strong></div>
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'end', flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 14rem' }}><span style={label}>Change the name customers see (Meta reviews it; your real business name)</span><input className="form-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Vastora" maxLength={75} /></label>
            <button type="button" className="btn btn-outline" onClick={() => void askDisplayName()} disabled={busy === 'name' || newName.trim().length < 3}>{busy === 'name' ? <Loader2 size={14} style={spin} /> : 'Ask Meta to change it'}</button>
          </div>
        </div>

        <div className="tf-card" style={{ padding: '1.25rem' }}>
          <div style={{ ...SECTION, marginBottom: '0.25rem' }}>Business profile</div>
          <p style={{ fontSize: '0.78rem', color: 'var(--fg-muted)', margin: '0 0 0.75rem' }}>What a customer sees when they open the number&apos;s profile. Business hours are not in Meta&apos;s API (only the WhatsApp Business phone app sets them): put them in &quot;About&quot;.</p>
          {prof?.error && <MetaError error={prof.error} />}
          <form onSubmit={(e) => { e.preventDefault(); void saveProfile(); }} style={{ display: 'grid', gap: '0.5rem' }}>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ width: 72, height: 72, borderRadius: '50%', overflow: 'hidden', background: 'var(--muted)', border: '1px solid var(--border)', flexShrink: 0, display: 'grid', placeItems: 'center' }}>
                {prof?.profile?.pictureUrl ? <img src={prof.profile.pictureUrl} alt="Profile picture" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: 'var(--fg-muted)', fontWeight: 700 }}>{name.slice(0, 1)}</span>}
              </div>
              <label className="btn btn-outline" style={{ gap: 6, cursor: busy === 'picture' ? 'wait' : 'pointer' }}>
                {busy === 'picture' ? <Loader2 size={14} style={spin} /> : <Upload size={14} />} Change picture
                <input type="file" accept="image/jpeg,image/png" style={{ display: 'none' }} disabled={busy === 'picture'} onChange={(e) => { void uploadPicture(e.target.files?.[0] || null); e.target.value = ''; }} />
              </label>
              <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>JPG or PNG, square (640 x 640), up to 5 MB. Needs the Meta App id (Setup).</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem' }}>
              <label><span style={label}>About ({pf.about.length}/139)</span><input className="form-input" value={pf.about} onChange={(e) => setPf({ ...pf, about: e.target.value })} maxLength={139} placeholder="Order help and tracking, Mon to Sat 10 AM to 7:30 PM" /></label>
              <label><span style={label}>Category</span>
                <select className="form-input" value={pf.vertical} onChange={(e) => setPf({ ...pf, vertical: e.target.value })}>
                  {(prof?.verticals || [{ code: 'UNDEFINED', label: 'Not set' }]).map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
                </select></label>
            </div>
            <label><span style={label}>Description ({pf.description.length}/512)</span><textarea className="form-input" rows={3} value={pf.description} onChange={(e) => setPf({ ...pf, description: e.target.value })} maxLength={512} style={{ height: 'auto' }} /></label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem' }}>
              <label><span style={label}>Address</span><input className="form-input" value={pf.address} onChange={(e) => setPf({ ...pf, address: e.target.value })} maxLength={256} /></label>
              <label><span style={label}>Email</span><input className="form-input" value={pf.email} onChange={(e) => setPf({ ...pf, email: e.target.value })} maxLength={128} inputMode="email" /></label>
              <label><span style={label}>Website</span><input className="form-input" value={pf.website1} onChange={(e) => setPf({ ...pf, website1: e.target.value })} placeholder="https://" maxLength={256} /></label>
              <label><span style={label}>Second website (optional)</span><input className="form-input" value={pf.website2} onChange={(e) => setPf({ ...pf, website2: e.target.value })} placeholder="https://" maxLength={256} /></label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" disabled={busy === 'profile' || !!prof?.error}>{busy === 'profile' ? <Loader2 size={14} style={spin} /> : 'Save profile'}</button>
            </div>
          </form>
        </div>
      </div>
      <PhonePreview name={name} picture={prof?.profile?.pictureUrl || null} profile={{ about: pf.about, description: pf.description, address: pf.address, email: pf.email, websites: [pf.website1, pf.website2].filter(Boolean), category: verticalLabel }} />
    </div>
  );
}
