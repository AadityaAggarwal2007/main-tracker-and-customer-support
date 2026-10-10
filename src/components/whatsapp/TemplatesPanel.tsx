'use client';

import { useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import MetaError from './MetaError';
import PhonePreview from './PhonePreview';
import { renderTemplate, varCount, type TemplateInfo } from '@/lib/chat/whatsapp-templates';
import { ORDER_PLACED_PRESET } from '@/lib/chat/whatsapp-brand-rules';
import BrandsCard from './BrandsCard';
import { EMPTY_FORM, SECTION, label, spin, type Alert, type Brand, type TemplateForm, type WaLists, type WaProfileData, type WaSettings } from './types';

const STATUS_CLASS: Record<string, string> = { APPROVED: 'chip-ok', PENDING: 'chip-warn', REJECTED: 'chip-danger', PAUSED: 'chip-warn', DISABLED: 'chip-danger' };

// The account's templates with Meta's review status; make a new one or edit one, with the phone showing the
// message as it is typed (the example values stand in for {{n}}).
export default function TemplatesPanel({ token, s, lists, prof, brands, onAlert, reload }: { token: string; s: WaSettings | null; lists: WaLists | null; prof: WaProfileData | null; brands: Brand[]; onAlert: Alert; reload: () => Promise<void> }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<TemplateInfo | null>(null);
  const vars = varCount(form.body);

  const startNew = () => { setEditId(null); setForm(EMPTY_FORM); setOpen(true); setPreview(null); };
  // The owner's order-placed confirmation, ready to send to Meta (edit any word before sending).
  const startOrderPlaced = () => { setEditId(null); setForm({ ...ORDER_PLACED_PRESET }); setOpen(true); setPreview(null); };
  const startEdit = (t: TemplateInfo) => { setEditId(t.id); setForm({ name: t.name, language: t.language, category: t.category || 'UTILITY', header: t.header || '', body: t.body, footer: t.footer || '', examples: [] }); setOpen(true); setPreview(null); };
  const submit = async () => {
    setBusy('save');
    try {
      const r = await fetch('/api/whatsapp/templates', { method: 'POST', headers: auth, body: JSON.stringify({ ...form, examples: form.examples.slice(0, vars), ...(editId ? { id: editId } : {}) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Meta refused the template'); return; }
      onAlert('success', editId ? `Template "${j.name}" changed; Meta reviews it again` : `Template "${j.name}" sent to Meta for review`);
      setOpen(false); setEditId(null); setForm(EMPTY_FORM); await reload();
    } finally { setBusy(''); }
  };
  const remove = async (name: string) => {
    if (!window.confirm(`Delete the template "${name}" from the WhatsApp account? It cannot be sent after that.`)) return;
    setBusy('del:' + name);
    try {
      const r = await fetch(`/api/whatsapp/templates?name=${encodeURIComponent(name)}`, { method: 'DELETE', headers: auth });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not delete it'); return; }
      onAlert('success', 'Deleted'); await reload();
    } finally { setBusy(''); }
  };
  const shown = open
    ? { header: form.header, body: renderTemplate({ body: form.body }, form.examples), footer: form.footer }
    : preview ? { header: preview.header, body: preview.body, footer: preview.footer } : null;
  const name = s?.phone?.verifiedName || 'Shiptrack';

  return (
    <div className="wa-layout">
      <div style={{ display: 'grid', gap: '1rem' }}>
        <div className="tf-card" style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            <span style={SECTION}>Templates</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Meta reviews a new one (minutes to a day); only Approved ones can be sent. Click one to see it on the phone.</span>
            <button type="button" className="btn btn-sm btn-outline" style={{ marginLeft: 'auto', gap: 4 }} onClick={startOrderPlaced}>Order placed template</button>
            <button type="button" className="btn btn-sm btn-primary" style={{ gap: 4 }} onClick={startNew}><Plus size={14} /> New template</button>
          </div>
          {lists?.error && <MetaError error={lists.error} />}
          {lists && !lists.error && lists.templates.length === 0 && <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)' }}>No templates on this account yet.</p>}
          {!lists && <Loader2 size={18} style={spin} />}
          <div style={{ display: 'grid', gap: 6 }}>
            {(lists?.templates || []).map((t) => (
              <div key={t.id || t.name + t.language} onClick={() => { setPreview(t); setOpen(false); }} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '0.5rem 0.75rem', display: 'grid', gap: 2, cursor: 'pointer', background: preview?.id === t.id && !open ? 'var(--primary-light)' : undefined }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <code style={{ fontSize: '0.8125rem', fontWeight: 700 }}>{t.name}</code>
                  <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{t.language} · {t.category}</span>
                  <span className={`chip ${STATUS_CLASS[t.status] || 'chip-muted'}`}>{t.status}</span>
                  {t.vars > 0 && <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{t.vars} value{t.vars > 1 ? 's' : ''}</span>}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                    {t.id && t.status !== 'PENDING' && <button type="button" className="btn-icon" title="Edit (Meta reviews the change)" onClick={(e) => { e.stopPropagation(); startEdit(t); }}><Pencil size={14} /></button>}
                    <button type="button" className="btn-icon" title="Delete this template" style={{ color: 'var(--danger)' }} disabled={busy === 'del:' + t.name} onClick={(e) => { e.stopPropagation(); void remove(t.name); }}>
                      {busy === 'del:' + t.name ? <Loader2 size={14} style={spin} /> : <Trash2 size={14} />}
                    </button>
                  </span>
                </div>
                {t.header && <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{t.header}</div>}
                <div style={{ fontSize: '0.8125rem', whiteSpace: 'pre-wrap' }}>{t.body}</div>
                {t.footer && <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{t.footer}</div>}
                {t.rejectedReason && <div style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>Rejected: {t.rejectedReason}</div>}
              </div>
            ))}
          </div>
        </div>

        <BrandsCard token={token} brands={brands} onAlert={onAlert} reload={reload} />

        {open && (
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: '0.5rem' }}>
            <div style={SECTION}>{editId ? `Edit "${form.name}"` : 'New template'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem' }}>
              <label><span style={label}>Name{editId ? ' (fixed)' : ''}</span><input className="form-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="order_update" disabled={!!editId} /></label>
              <label><span style={label}>Language{editId ? ' (fixed)' : ''}</span>
                <select className="form-input" value={form.language} disabled={!!editId} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                  {(lists?.languages || [{ code: 'en_US', label: 'English (US)' }, { code: 'hi', label: 'Hindi' }]).map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select></label>
              <label><span style={label}>Category</span>
                <select className="form-input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  <option value="UTILITY">Utility (order updates, support)</option><option value="MARKETING">Marketing (offers)</option>
                </select></label>
            </div>
            <label><span style={label}>Header (optional, one plain line)</span><input className="form-input" value={form.header} onChange={(e) => setForm({ ...form, header: e.target.value })} maxLength={60} /></label>
            <label><span style={label}>Body: {'{{1}}'}, {'{{2}}'} are the values filled in when sending; *bold*, _italic_ work</span>
              <textarea className="form-input" rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder={'Hi {{1}}, this is the support team. About your order {{2}}: we are looking into it and will update you here.'} style={{ height: 'auto' }} /></label>
            {vars > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem' }}>
                {Array.from({ length: vars }, (_, i) => (
                  <label key={i}><span style={label}>Example for {`{{${i + 1}}}`} (Meta needs one; shown on the phone)</span>
                    <input className="form-input" value={form.examples[i] || ''} onChange={(e) => { const ex = [...form.examples]; ex[i] = e.target.value; setForm({ ...form, examples: ex }); }} /></label>
                ))}
              </div>
            )}
            <label><span style={label}>Footer (optional)</span><input className="form-input" value={form.footer} onChange={(e) => setForm({ ...form, footer: e.target.value })} maxLength={60} /></label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-outline" onClick={() => { setOpen(false); setEditId(null); }}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy === 'save' || !form.name || !form.body}>{busy === 'save' ? <Loader2 size={14} style={spin} /> : editId ? 'Save change (Meta reviews it)' : 'Send to Meta for review'}</button>
            </div>
          </form>
        )}
      </div>
      <PhonePreview name={name} picture={prof?.profile?.pictureUrl || null} message={shown} />
    </div>
  );
}
