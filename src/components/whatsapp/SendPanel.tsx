'use client';

import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import PhonePreview from './PhonePreview';
import { renderTemplate } from '@/lib/chat/whatsapp-templates';
import { SECTION, label, spin, type Alert, type WaLists, type WaProfileData, type WaSettings } from './types';

// Send a test (or the real first message) to a number: an approved template with its values, previewed on the
// phone; the chat then opens in Chat Support. A plain text goes from the inbox once the customer has written.
export default function SendPanel({ token, s, lists, prof, onAlert, onOpenChat }: { token: string; s: WaSettings | null; lists: WaLists | null; prof: WaProfileData | null; onAlert: Alert; onOpenChat: (id: string) => void }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const approved = (lists?.templates || []).filter((t) => t.status === 'APPROVED');
  const [to, setTo] = useState('');
  const [name, setName] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ ok: boolean; text: string; conversationId?: string } | null>(null);
  const chosen = approved.find((t) => t.name === name) || null;
  const ready = !!chosen && to.replace(/\D/g, '').length >= 10 && params.slice(0, chosen.vars).filter((p) => p.trim()).length === chosen.vars && !busy;
  const send = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const r = await fetch('/api/whatsapp/start', { method: 'POST', headers: auth, body: JSON.stringify({ to, template: chosen.name, language: chosen.language, params: params.slice(0, chosen.vars) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setLast({ ok: false, text: j.error || 'WhatsApp did not take it', conversationId: j.conversationId }); onAlert('error', j.error || 'WhatsApp did not take it'); return; }
      setLast({ ok: true, text: `Sent to ${to}. The chat is in Chat Support > With team > Open case; the customer's reply lands there.`, conversationId: j.conversationId });
      onAlert('success', 'Sent on WhatsApp');
    } finally { setBusy(false); }
  };
  return (
    <div className="wa-layout">
      <div className="tf-card" style={{ padding: '1.25rem' }}>
        <div style={{ ...SECTION, marginBottom: '0.25rem' }}>Send a template to a number</div>
        <p style={{ fontSize: '0.78rem', color: 'var(--fg-muted)', margin: '0 0 0.75rem' }}>The first message to a customer must be an approved template (Meta&apos;s rule). After they reply, the team writes freely from Chat Support for 24 hours. Each template conversation costs about ₹0.12 from the Meta funds.</p>
        {approved.length === 0 ? (
          <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)' }}>No approved template yet. Make one on the Templates tab and wait for Meta&apos;s approval.</p>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void send(); }} style={{ display: 'grid', gap: '0.5rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '0.5rem' }}>
              <label><span style={label}>WhatsApp number (10 digits = India)</span><input className="form-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="98765 43210" inputMode="tel" /></label>
              <label><span style={label}>Template</span>
                <select className="form-input" value={name} onChange={(e) => { setName(e.target.value); setParams([]); }}>
                  <option value="">Pick one</option>
                  {approved.map((t) => <option key={t.id || t.name} value={t.name}>{t.name} ({t.language})</option>)}
                </select></label>
            </div>
            {chosen && chosen.vars > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem' }}>
                {Array.from({ length: chosen.vars }, (_, i) => (
                  <label key={i}><span style={label}>Value {i + 1}</span><input className="form-input" value={params[i] || ''} onChange={(e) => { const p = [...params]; p[i] = e.target.value; setParams(p); }} /></label>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
              <button type="submit" className="btn btn-primary" style={{ gap: 6 }} disabled={!ready}>{busy ? <Loader2 size={14} style={spin} /> : <Send size={14} />} Send on WhatsApp</button>
            </div>
          </form>
        )}
        {last && (
          <div style={{ marginTop: '0.75rem', fontSize: '0.8125rem', color: last.ok ? 'var(--success, #15803d)' : 'var(--danger)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{last.text}</span>
            {last.conversationId && <button type="button" className="btn btn-sm btn-outline" onClick={() => onOpenChat(last.conversationId!)}>Open the chat</button>}
          </div>
        )}
      </div>
      <PhonePreview name={s?.phone?.verifiedName || 'Shiptrack'} picture={prof?.profile?.pictureUrl || null} message={chosen ? { header: chosen.header, body: renderTemplate({ body: chosen.body }, params), footer: chosen.footer } : null} />
    </div>
  );
}
