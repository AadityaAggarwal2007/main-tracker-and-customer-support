'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Brand } from '@/lib/chat/whatsapp-brand-rules';
import { SECTION, label, spin, type Alert } from './types';

// Each brand's own name and support email for the words inside a template (one WhatsApp number, many brands).
export default function BrandsCard({ token, brands, onAlert, reload }: { token: string; brands: Brand[]; onAlert: Alert; reload: () => Promise<void> }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [edit, setEdit] = useState<Record<string, { name: string; email: string }>>({});
  const [busy, setBusy] = useState('');
  const val = (b: Brand) => edit[b.id] || { name: b.name, email: b.email };
  const save = async (b: Brand) => {
    setBusy(b.id);
    try {
      const v = val(b);
      const r = await fetch('/api/whatsapp/brands', { method: 'POST', headers: auth, body: JSON.stringify({ businessId: b.id, name: v.name, email: v.email }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not save'); return; }
      onAlert('success', `${v.name}: saved`);
      setEdit((e) => { const n = { ...e }; delete n[b.id]; return n; });
      await reload();
    } finally { setBusy(''); }
  };
  return (
    <div className="tf-card" style={{ padding: '1.25rem' }}>
      <div style={{ ...SECTION, marginBottom: '0.25rem' }}>Each brand&apos;s own words</div>
      <p style={{ fontSize: '0.78rem', color: 'var(--fg-muted)', margin: '0 0 0.75rem' }}>
        One WhatsApp number serves every brand, but the brand name and the support email inside a message are each brand&apos;s own. They fill the {'{{3}}'} and {'{{4}}'} of the Order placed template when you send it for that brand.
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {brands.map((b) => {
          const v = val(b);
          const dirty = !!edit[b.id];
          const unsaved = !b.savedName || !b.savedEmail; // nothing saved yet: Save keeps what is shown
          const canSave = (dirty || unsaved) && !!v.name.trim();
          return (
            <div key={b.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(7rem, 9rem) 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
              <div style={{ fontSize: '0.8125rem', fontWeight: 700, paddingBottom: 10 }}>{b.panel}</div>
              <label><span style={label}>Brand name in the message</span><input className="form-input" value={v.name} maxLength={40} onChange={(e) => setEdit({ ...edit, [b.id]: { ...v, name: e.target.value } })} /></label>
              <label><span style={label}>Support email in the message{!b.savedEmail && b.supportGmail ? ' (its support Gmail)' : ''}</span><input className="form-input" value={v.email} maxLength={128} placeholder="help@brand.com" inputMode="email" onChange={(e) => setEdit({ ...edit, [b.id]: { ...v, email: e.target.value } })} /></label>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy === b.id || !canSave} onClick={() => void save(b)}>{busy === b.id ? <Loader2 size={14} style={spin} /> : (unsaved && !dirty ? 'Save these' : 'Save')}</button>
            </div>
          );
        })}
        {brands.length === 0 && <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)' }}>No panels found.</p>}
      </div>
    </div>
  );
}
