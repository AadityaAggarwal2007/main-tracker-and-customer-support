'use client';

import { useEffect, useState } from 'react';
import { Loader2, X, Send } from 'lucide-react';
import { renderTemplate, type TemplateInfo } from '@/lib/chat/whatsapp-templates';

// Send an approved WhatsApp template in this chat (owner 2026-10-10): the only message WhatsApp allows after
// 24 hours of silence from the customer. The values are filled here; the chat record keeps the filled text.
export function TemplateDialog({ token, busy, onCancel, onSend }: {
  token: string; busy: boolean; onCancel: () => void;
  onSend: (t: { name: string; language: string; params: string[]; text: string }) => void;
}) {
  const [list, setList] = useState<TemplateInfo[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [params, setParams] = useState<string[]>([]);
  useEffect(() => {
    let on = true;
    fetch('/api/whatsapp/templates?approved=1', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then((r) => r.json()).then((j) => { if (!on) return; setList(j.templates || []); if (j.error) setError(j.error); })
      .catch(() => { if (on) { setList([]); setError('Could not read the templates'); } });
    return () => { on = false; };
  }, [token]);
  const chosen = (list || []).find((t) => t.name === name) || null;
  const ready = !!chosen && params.slice(0, chosen.vars).filter((p) => (p || '').trim()).length === chosen.vars && !busy;
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="tpl-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '30rem' }}>
        <div className="modal-header">
          <div>
            <div className="modal-title" id="tpl-title">Send a WhatsApp template</div>
            <p className="modal-subtitle">After 24 hours of silence from the customer only an approved template goes through</p>
          </div>
          <button type="button" className="btn-icon" onClick={onCancel} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (ready && chosen) onSend({ name: chosen.name, language: chosen.language, params: params.slice(0, chosen.vars), text: renderTemplate(chosen, params) }); }} style={{ display: 'grid', gap: '0.625rem' }}>
          {list === null ? <div style={{ textAlign: 'center', padding: '1rem' }}><Loader2 size={18} style={{ animation: 'spin 0.6s linear infinite' }} /></div> : (
            <>
              {error && <p style={{ fontSize: '0.8125rem', color: 'var(--danger)', margin: 0 }}>{error}</p>}
              {!error && list.length === 0 && <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', margin: 0 }}>No approved template yet. The Super Admin makes one in Settings &gt; WhatsApp.</p>}
              {list.length > 0 && (
                <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Template</span>
                  <select className="form-input" value={name} onChange={(e) => { setName(e.target.value); setParams([]); }} autoFocus>
                    <option value="">Pick one</option>
                    {list.map((t) => <option key={t.id || t.name} value={t.name}>{t.name} ({t.language})</option>)}
                  </select></label>
              )}
              {chosen && chosen.vars > 0 && Array.from({ length: chosen.vars }, (_, i) => (
                <label key={i}><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Value {i + 1}</span>
                  <input className="form-input" value={params[i] || ''} onChange={(e) => { const p = [...params]; p[i] = e.target.value; setParams(p); }} /></label>
              ))}
              {chosen && <div style={{ fontSize: '0.8125rem', whiteSpace: 'pre-wrap', background: 'var(--bg-subtle, #f6f5fa)', borderRadius: 8, padding: '0.5rem 0.75rem' }}>{renderTemplate(chosen, params)}</div>}
            </>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" style={{ gap: 6 }} disabled={!ready}>{busy ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Send size={14} />} Send</button>
          </div>
        </form>
      </div>
    </div>
  );
}
