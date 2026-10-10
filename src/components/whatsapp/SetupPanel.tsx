'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, XCircle, Stethoscope } from 'lucide-react';
import type { TokenCheck } from '@/lib/chat/whatsapp-diagnose';
import MetaError from './MetaError';
import { SECTION, label, spin, type Alert, type WaSettings, type WaLists } from './types';

// Setup: what the server has, the two ids, the webhook, and the checklist the owner walks through once.
export default function SetupPanel({ token, s, lists, onAlert, reload }: { token: string; s: WaSettings | null; lists: WaLists | null; onAlert: Alert; reload: () => Promise<void> }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [waba, setWaba] = useState(s?.waba || '');
  const [appId, setAppId] = useState(s?.appId || '');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<TokenCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const runCheck = async () => {
    setChecking(true);
    try {
      const r = await fetch('/api/whatsapp/token-check', { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) { onAlert('error', (j && j.error) || 'Could not check the token'); return; }
      setCheck(j);
    } finally { setChecking(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/whatsapp/settings', { method: 'POST', headers: auth, body: JSON.stringify({ waba, appId }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not save it'); return; }
      onAlert('success', 'Saved'); await reload();
    } finally { setBusy(false); }
  };
  const Row = ({ ok, text, note }: { ok: boolean | null; text: string; note?: string }) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.875rem', padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
      {ok === null ? <Loader2 size={16} style={{ ...spin, color: 'var(--fg-muted)', marginTop: 2 }} /> : ok ? <CheckCircle2 size={16} style={{ color: 'var(--success, #15803d)', marginTop: 2 }} /> : <XCircle size={16} style={{ color: 'var(--danger)', marginTop: 2 }} />}
      <div><div style={{ fontWeight: 600 }}>{text}</div>{note && <div style={{ fontSize: '0.78rem', color: 'var(--fg-muted)' }}>{note}</div>}</div>
    </div>
  );
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://shiptrack.store';
  const hasTemplates = !!lists && !lists.error;
  const approved = (lists?.templates || []).some((t) => t.status === 'APPROVED');
  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div className="tf-card" style={{ padding: '1.25rem' }}>
        <div style={{ ...SECTION, marginBottom: '0.5rem' }}>Checklist</div>
        <Row ok={s ? s.configured : null} text="Token and phone number id on the server" note={s?.configured ? `Phone number id ${s.phoneNumberId}` : 'WHATSAPP_CLOUD_TOKEN and WHATSAPP_PHONE_NUMBER_ID in /etc/tracker/.env, then deploy'} />
        <Row ok={s ? s.verifyTokenSet : null} text="Webhook verify token on the server" note={`Meta App Dashboard > WhatsApp > Configuration: Callback URL ${origin}${s?.webhookUrl || '/api/whatsapp/webhook'}, field "messages" subscribed`} />
        <Row ok={s ? s.appSecretSet : null} text="Webhook calls signature-checked" note={s?.appSecretSet ? 'WHATSAPP_APP_SECRET is set' : 'Not yet: put the Meta app secret (App settings > Basic) in /etc/tracker/.env as WHATSAPP_APP_SECRET before real customers'} />
        <Row ok={s ? !!s.panel : null} text={s?.panel ? `WhatsApp chats go to the panel "${s.panel.name}"` : 'No panel for WhatsApp chats'} note="One number for the whole install; WHATSAPP_PANEL_ID in .env picks another panel" />
        <Row ok={s ? !!s.waba : null} text="WhatsApp Business Account id saved" note="Needed for templates (below)" />
        <Row ok={s ? !!s.appId : null} text="Meta App id saved" note="Needed for the profile picture (below)" />
        <Row ok={s ? !!s.phone : null} text={s?.phone ? `Number ${s.phone.displayPhoneNumber} is ${s.phone.status.toLowerCase()}` : 'Meta could not be asked about the number'} note={s?.phone ? `Name "${s.phone.verifiedName}" (${s.phone.nameStatus.toLowerCase().replace(/_/g, ' ')}), quality ${s.phone.qualityRating.toLowerCase()}` : s?.phoneError || undefined} />
        <Row ok={lists ? hasTemplates : null} text="Templates readable from Meta" note={lists?.error || `${lists?.templates.length ?? 0} on the account`} />
        <Row ok={lists ? approved : null} text="At least one approved template" note={approved ? 'The first message to a customer can go' : 'Make one on the Templates tab and wait for Meta'} />
        {s?.phoneError && <MetaError error={s.phoneError} />}
      </div>

      <div className="tf-card" style={{ padding: '1.25rem' }}>
        <div style={{ ...SECTION, marginBottom: '0.5rem' }}>Ids from Meta Business Settings</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
          <label><span style={label}>WhatsApp Business Account id (WhatsApp accounts &gt; Shiptrack)</span><input className="form-input" value={waba} onChange={(e) => setWaba(e.target.value)} placeholder="e.g. 28873951022288651" inputMode="numeric" /></label>
          <label><span style={label}>Meta App id (Apps &gt; ship track msg)</span><input className="form-input" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="e.g. 1427249435405269" inputMode="numeric" /></label>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || (waba === (s?.waba || '') && appId === (s?.appId || ''))} style={{ justifySelf: 'start' }}>
            {busy ? <Loader2 size={14} style={spin} /> : 'Save'}
          </button>
        </div>
      </div>

      <div className="tf-card" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: '0.5rem' }}>
          <span style={SECTION}>Check the token</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Asks Meta what the token on the server can do and which accounts it sees</span>
          <button type="button" className="btn btn-sm btn-outline" style={{ marginLeft: 'auto', gap: 4 }} onClick={() => void runCheck()} disabled={checking}>
            {checking ? <Loader2 size={14} style={spin} /> : <Stethoscope size={14} />} Check token
          </button>
        </div>
        {check && (
          <div style={{ display: 'grid', gap: 6, fontSize: '0.8125rem' }}>
            {check.verdicts.map((v, i) => (
              <div key={i} className={/is fine/.test(v) ? '' : 'wa-hint'} style={/is fine/.test(v) ? { color: 'var(--success, #15803d)', fontWeight: 600 } : undefined}>{v}</div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '0.25rem 1rem', color: 'var(--fg-secondary)' }}>
              <div>Token: <strong>{check.valid === null ? 'could not be read' : check.valid ? 'valid' : 'NOT valid'}</strong>{check.type ? ` · ${check.type.toLowerCase().replace('_', ' ')}` : ''}{check.expires ? ` · expires ${check.expires === 'never' ? 'never' : new Date(check.expires).toLocaleDateString()}` : ''}</div>
              <div>App: <strong>{check.appName || check.appId || '—'}</strong>{check.appName && check.appId ? ` (${check.appId})` : ''}</div>
              <div>Permissions: <strong>{check.scopes.length ? check.scopes.join(', ') : '—'}</strong></div>
              {check.granular.map((g) => <div key={g.scope}>{g.scope} on: <strong>{g.targets.length ? g.targets.join(', ') : 'every asset'}</strong></div>)}
              <div>Saved account {check.waba.id || '—'}: <strong>{check.waba.name ? `readable ("${check.waba.name}")` : check.waba.error ? `NOT readable: ${check.waba.error}` : 'not saved'}</strong></div>
              <div>Phone number {check.phone.id || '—'}: <strong>{check.phone.ok ? 'readable' : check.phone.error ? `NOT readable: ${check.phone.error}` : 'not set'}</strong></div>
            </div>
          </div>
        )}
      </div>

      <div className="tf-card" style={{ padding: '1.25rem', fontSize: '0.8125rem', color: 'var(--fg-muted)', display: 'grid', gap: 4 }}>
        <div style={{ ...SECTION, marginBottom: '0.25rem' }}>How it works</div>
        <div>A customer who writes to the number lands in Chat Support &gt; With team &gt; Open case; the team replies from the inbox and it goes out on WhatsApp.</div>
        <div>To write FIRST, or after 24 hours of silence from the customer, WhatsApp allows only an approved template: Templates tab to make one, Send tab to send it.</div>
        <div>Business-initiated conversations use the funds in Meta Billing &amp; payments (a utility template is about ₹0.12); replies inside 24 hours are free.</div>
        <div>Chikki does not answer on WhatsApp yet.</div>
      </div>
    </div>
  );
}
