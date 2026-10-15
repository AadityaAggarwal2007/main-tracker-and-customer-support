'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import MetaError from './MetaError';
import PhonePreview from './PhonePreview';
import { renderTemplate, varCount, type TemplateInfo } from '@/lib/chat/whatsapp-templates';
import { ORDER_LINK_PRESET, ORDER_PLACED_PRESET, ORDER_TRACKING_PRESET, SHIPTRACK_ALERT_PRESET } from '@/lib/chat/whatsapp-brand-rules';
import { isLinkTemplateName, templateUsage, type LinkMode } from '@/lib/chat/whatsapp-auto-rules';
import BrandsCard from './BrandsCard';
import { EMPTY_FORM, SECTION, label, spin, type Alert, type Brand, type TemplateForm, type WaLists, type WaProfileData, type WaSettings } from './types';

const STATUS_CLASS: Record<string, string> = { APPROVED: 'chip-ok', PENDING: 'chip-warn', REJECTED: 'chip-danger', PAUSED: 'chip-warn', DISABLED: 'chip-danger' };
// which template ShipTrack uses for what (owner 2026-10-15, "ye wala working hai baaki nahi"): the chip's colour
const USAGE_CLASS = { ok: 'chip-ok', warn: 'chip-warn', muted: 'chip-muted' } as const;

// The account's templates with Meta's review status; make a new one or edit one, with the phone showing the
// message as it is typed (the example values stand in for {{n}}).
export default function TemplatesPanel({ token, s, lists, prof, brands, onAlert, reload }: { token: string; s: WaSettings | null; lists: WaLists | null; prof: WaProfileData | null; brands: Brand[]; onAlert: Alert; reload: () => Promise<void> }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // the form opens right under the list, and the page moves to it so it is never off screen
  useEffect(() => { if (open) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [open, editId]);
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<TemplateInfo | null>(null);
  const vars = varCount(form.body);
  // What the automation runs now (owner 2026-10-15: "template ke bahar on/off ka button ki ye wala working hai baaki
  // nahi"): a light read of the Automation overview for the "In use" chips and the one-message switch on its card.
  const [mode, setMode] = useState<LinkMode | null>(null);
  const loadMode = useCallback(async () => {
    try {
      const r = await fetch('/api/whatsapp/automation', { headers: auth, cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.linkMode) setMode(j.linkMode as LinkMode);
    } catch { /* the chips stay hidden */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { void loadMode(); }, [loadMode, lists]);
  const switchLink = async (on: boolean) => {
    const text = on
      ? 'Turn ON "One message per order"?\n\nOnce Meta has approved order_placed_link, every new order gets ONE message: order placed + its tracking link. The 48-hour tracking message is skipped for those orders. Orders with no tracking link yet still get the two old messages.'
      : 'Turn OFF "One message per order"?\n\nNew orders get the two old messages again: order_placed when the order comes in, order_tracking 48 hours later, even though order_placed_link is approved.';
    if (!window.confirm(text)) return;
    setBusy('link');
    try {
      const r = await fetch('/api/whatsapp/automation', { method: 'POST', headers: auth, body: JSON.stringify({ action: 'link_mode', on }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not change it'); return; }
      onAlert('success', j.linkMode?.reason ? `Saved. Running now: ${j.linkMode.reason}` : (on ? 'One message per order: ON' : 'One message per order: OFF'));
      if (j.linkMode) setMode(j.linkMode as LinkMode); else await loadMode();
    } catch { onAlert('error', 'Could not change it'); }
    finally { setBusy(''); }
  };

  const startNew = () => { setEditId(null); setForm(EMPTY_FORM); setOpen(true); setPreview(null); };
  // The owner's order-placed confirmation, ready to send to Meta (edit any word before sending).
  const startOrderPlaced = () => { setEditId(null); setForm({ ...ORDER_PLACED_PRESET, examples: [...ORDER_PLACED_PRESET.examples] }); setOpen(true); setPreview(null); };
  // one message per order: order placed + the tracking link (owner 2026-10-15)
  const startLink = () => { setEditId(null); setForm({ ...ORDER_LINK_PRESET, examples: [...ORDER_LINK_PRESET.examples] }); setOpen(true); setPreview(null); };
  const startTracking = () => { setEditId(null); setForm({ ...ORDER_TRACKING_PRESET, examples: [...ORDER_TRACKING_PRESET.examples] }); setOpen(true); setPreview(null); };
  const startAlert = () => { setEditId(null); setForm({ ...SHIPTRACK_ALERT_PRESET, examples: [...SHIPTRACK_ALERT_PRESET.examples] }); setOpen(true); setPreview(null); };
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
            <button type="button" className="btn btn-sm btn-outline" style={{ gap: 4 }} onClick={startLink} title="One message per order: order placed + the tracking link. Once Meta approves it, the automation sends only this one">Order placed + tracking link (one message)</button>
            <button type="button" className="btn btn-sm btn-outline" style={{ gap: 4 }} onClick={startTracking}>Tracking link template</button>
            <button type="button" className="btn btn-sm btn-outline" style={{ gap: 4 }} onClick={startAlert} title="For your own WhatsApp: ShipTrack tells you when the AI credits run low">ShipTrack alert template</button>
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
                  {/* what ShipTrack uses it for, from the automation's current mode (owner 2026-10-15) */}
                  {mode && (() => { const u = templateUsage(t, mode); return <span className={`chip ${USAGE_CLASS[u.tone]}`} title="What ShipTrack sends this template for, as the automation runs now">{u.text}</span>; })()}
                  {mode && isLinkTemplateName(t.name) && (
                    <button type="button" className="btn btn-sm btn-outline" style={{ gap: 4 }} disabled={busy === 'link'} title="One message per order: the same switch as in Automation"
                      onClick={(e) => { e.stopPropagation(); void switchLink(!mode.on); }}>
                      {busy === 'link' ? <Loader2 size={13} style={spin} /> : <Power size={13} />} One message per order: {mode.on ? 'ON' : 'OFF'} · turn {mode.on ? 'OFF' : 'ON'}
                    </button>
                  )}
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

        {open && (
          <form ref={formRef} onSubmit={(e) => { e.preventDefault(); void submit(); }} className="tf-card" style={{ padding: '1.25rem', display: 'grid', gap: '0.5rem' }}>
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

        <BrandsCard token={token} brands={brands} onAlert={onAlert} reload={reload} />
      </div>
      <PhonePreview name={name} picture={prof?.profile?.pictureUrl || null} message={shown} />
    </div>
  );
}
