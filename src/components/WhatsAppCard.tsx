'use client';

// ── Settings > WhatsApp (owner 2026-10-10), Super Admin only ──────────────────────────────────
// What is set up on the server (names only, never the token), the WhatsApp Business Account id (needed for
// templates), the account's message templates (Meta reviews each one: Pending / Approved / Rejected), a form
// to make a new one, and "Message a number": the first message to a customer who has not written to us must
// be an approved template, so this sends one and opens the chat in Chat Support. Server: src/lib/chat/whatsapp*.
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, MessageSquareText, Pencil, Plus, RefreshCw, Send, Trash2, Upload, XCircle } from 'lucide-react';
import { renderTemplate, varCount, type TemplateInfo } from '@/lib/chat/whatsapp-templates';
import type { PhoneInfo, Profile } from '@/lib/chat/whatsapp-profile';

interface Settings {
  configured: boolean; verifyTokenSet: boolean; appSecretSet: boolean; phoneNumberId: string;
  waba: string; wabaFromEnv: boolean; appId: string; panel: { id: string; name: string } | null; webhookUrl: string;
  phone: PhoneInfo | null; phoneError: string | null;
}
interface ProfileData { profile: Profile | null; error?: string; verticals: { code: string; label: string }[] }
const NAME_STATUS: Record<string, string> = { APPROVED: 'approved', AVAILABLE_WITHOUT_REVIEW: 'approved', PENDING_REVIEW: 'under review by Meta', DECLINED: 'declined by Meta', EXPIRED: 'expired', NON_EXISTS: 'not set' };
const QUALITY: Record<string, string> = { GREEN: 'Good', YELLOW: 'Medium', RED: 'Low', UNKNOWN: 'Not rated yet' };
const LIMIT: Record<string, string> = { TIER_50: '50 customers / day', TIER_250: '250 customers / day', TIER_1K: '1,000 customers / day', TIER_10K: '10,000 customers / day', TIER_100K: '100,000 customers / day', TIER_UNLIMITED: 'unlimited' };
interface Lists { templates: TemplateInfo[]; waba: string; error?: string; categories?: string[]; languages?: { code: string; label: string }[] }

const STATUS_COLOR: Record<string, string> = { APPROVED: 'var(--success, #15803d)', PENDING: '#b45309', REJECTED: 'var(--danger)', PAUSED: '#b45309', DISABLED: 'var(--danger)' };

export default function WhatsAppCard({ token, onAlert, onOpenChat }: { token: string; onAlert: (type: string, message: string) => void; onOpenChat?: (conversationId: string) => void }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [s, setS] = useState<Settings | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [loading, setLoading] = useState(true);
  const [waba, setWaba] = useState('');
  const [appIdV, setAppIdV] = useState('');
  const [prof, setProf] = useState<ProfileData | null>(null);
  const [pf, setPf] = useState({ about: '', description: '', address: '', email: '', website1: '', website2: '', vertical: 'UNDEFINED' });
  const [newName, setNewName] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: '', language: 'en_US', category: 'UTILITY', header: '', body: '', footer: '', examples: [] as string[] });
  const [send, setSend] = useState({ to: '', template: '', params: [] as string[] });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, b, c] = await Promise.all([
        fetch('/api/whatsapp/settings', { headers: auth, cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch('/api/whatsapp/templates', { headers: auth, cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch('/api/whatsapp/profile', { headers: auth, cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      ]);
      if (a && !a.error) { setS(a); setWaba(a.waba || ''); setAppIdV(a.appId || ''); }
      if (b) setLists(b);
      if (c) {
        setProf(c);
        const p = c.profile as Profile | null;
        if (p) setPf({ about: p.about, description: p.description, address: p.address, email: p.email, website1: p.websites[0] || '', website2: p.websites[1] || '', vertical: p.vertical || 'UNDEFINED' });
      }
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const saveIds = async () => {
    setBusy('waba');
    try {
      const r = await fetch('/api/whatsapp/settings', { method: 'POST', headers: auth, body: JSON.stringify({ waba, appId: appIdV }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not save it'); return; }
      onAlert('success', 'Saved'); await load();
    } finally { setBusy(''); }
  };
  const saveProfile = async () => {
    setBusy('profile');
    try {
      const r = await fetch('/api/whatsapp/profile', { method: 'POST', headers: auth, body: JSON.stringify({ about: pf.about, description: pf.description, address: pf.address, email: pf.email, websites: [pf.website1, pf.website2].filter(Boolean), vertical: pf.vertical }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Meta refused the profile change'); return; }
      onAlert('success', 'Profile updated on WhatsApp'); await load();
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
      onAlert('success', 'Profile picture updated'); await load();
    } finally { setBusy(''); }
  };
  const askDisplayName = async () => {
    setBusy('name');
    try {
      const r = await fetch('/api/whatsapp/display-name', { method: 'POST', headers: auth, body: JSON.stringify({ name: newName }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Meta refused the name change'); return; }
      onAlert('success', 'Sent to Meta for review; the name changes once approved'); setNewName(''); await load();
    } finally { setBusy(''); }
  };
  const startEdit = (t: TemplateInfo) => {
    setEditId(t.id); setShowNew(true);
    setForm({ name: t.name, language: t.language, category: t.category || 'UTILITY', header: t.header || '', body: t.body, footer: t.footer || '', examples: [] });
  };

  const vars = varCount(form.body);
  const createTpl = async () => {
    setBusy('create');
    try {
      const r = await fetch('/api/whatsapp/templates', { method: 'POST', headers: auth, body: JSON.stringify({ ...form, examples: form.examples.slice(0, vars), ...(editId ? { id: editId } : {}) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Meta refused the template'); return; }
      onAlert('success', editId ? `Template "${j.name}" changed; Meta reviews it again` : `Template "${j.name}" sent to Meta for review (${j.status})`);
      setShowNew(false); setEditId(null); setForm({ name: '', language: 'en_US', category: 'UTILITY', header: '', body: '', footer: '', examples: [] });
      await load();
    } finally { setBusy(''); }
  };
  const removeTpl = async (name: string) => {
    if (!window.confirm(`Delete the template "${name}" from the WhatsApp account? It cannot be sent after that.`)) return;
    setBusy('del:' + name);
    try {
      const r = await fetch(`/api/whatsapp/templates?name=${encodeURIComponent(name)}`, { method: 'DELETE', headers: auth });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not delete it'); return; }
      onAlert('success', 'Deleted'); await load();
    } finally { setBusy(''); }
  };

  const approved = (lists?.templates || []).filter((t) => t.status === 'APPROVED');
  const chosen = approved.find((t) => t.name === send.template) || null;
  const sendFirst = async () => {
    if (!chosen) return;
    setBusy('send');
    try {
      const r = await fetch('/api/whatsapp/start', { method: 'POST', headers: auth, body: JSON.stringify({ to: send.to, template: chosen.name, language: chosen.language, params: send.params.slice(0, chosen.vars) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'WhatsApp did not take it'); return; }
      onAlert('success', 'Sent. The chat is in Chat Support > With team.');
      setSend({ to: '', template: send.template, params: [] });
      if (onOpenChat && j.conversationId) onOpenChat(j.conversationId);
    } finally { setBusy(''); }
  };

  const Tick = ({ ok, label }: { ok: boolean; label: string }) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8125rem', color: ok ? 'var(--success, #15803d)' : 'var(--danger)' }}>
      {ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{label}
    </span>
  );
  const input = { className: 'form-input', style: { fontSize: '0.875rem' } as React.CSSProperties };

  return (
    <div className="tf-card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
        <MessageSquareText size={16} style={{ color: '#25D366' }} />
        <span style={{ fontWeight: 700 }}>WhatsApp</span>
        <button type="button" className="btn-icon" title="Refresh" onClick={() => void load()} disabled={loading} style={{ marginLeft: 'auto' }}>
          {loading ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <RefreshCw size={14} />}
        </button>
      </div>
      <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', margin: '0 0 1rem' }}>
        One business number for every panel. A customer who writes to it lands in Chat Support (With team) and the team replies from there.
        To write FIRST, or after 24 hours of silence, WhatsApp allows only an approved template.
      </p>

      {s && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', marginBottom: '1rem' }}>
          <Tick ok={s.configured} label={s.configured ? `Token and number set (id ${s.phoneNumberId})` : 'Token or phone number id missing in /etc/tracker/.env'} />
          <Tick ok={s.verifyTokenSet} label={s.verifyTokenSet ? 'Webhook verify token set' : 'WHATSAPP_VERIFY_TOKEN missing'} />
          <Tick ok={s.appSecretSet} label={s.appSecretSet ? 'Webhook signature checked' : 'WHATSAPP_APP_SECRET not set: webhook calls are not signature-checked'} />
          <Tick ok={!!s.panel} label={s.panel ? `Chats go to panel "${s.panel.name}"` : 'No panel for WhatsApp chats'} />
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'end', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        <label style={{ flex: '1 1 14rem' }}>
          <span style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--fg-muted)', marginBottom: 4 }}>WhatsApp Business Account id (templates)</span>
          <input {...input} value={waba} onChange={(e) => setWaba(e.target.value)} placeholder="e.g. 28873951022288651" inputMode="numeric" />
        </label>
        <label style={{ flex: '1 1 14rem' }}>
          <span style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--fg-muted)', marginBottom: 4 }}>Meta App id (profile picture)</span>
          <input {...input} value={appIdV} onChange={(e) => setAppIdV(e.target.value)} placeholder="e.g. 1427249435405269" inputMode="numeric" />
        </label>
        <button type="button" className="btn btn-primary" onClick={() => void saveIds()} disabled={busy === 'waba' || (waba === (s?.waba || '') && appIdV === (s?.appId || ''))}>
          {busy === 'waba' ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : 'Save'}
        </button>
      </div>

      {/* The number as Meta sees it + a display-name change request */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>The number</span>
      </div>
      {s?.phoneError && <p style={{ fontSize: '0.8125rem', color: 'var(--danger)', margin: '0 0 0.75rem' }}>{s.phoneError}</p>}
      {s?.phone && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: '0.5rem 1rem', fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
          <div><span style={{ color: 'var(--fg-muted)' }}>Number</span><br /><strong>{s.phone.displayPhoneNumber || '—'}</strong></div>
          <div><span style={{ color: 'var(--fg-muted)' }}>Name customers see</span><br /><strong>{s.phone.verifiedName || '—'}</strong> <span style={{ color: 'var(--fg-muted)' }}>({NAME_STATUS[s.phone.nameStatus] || s.phone.nameStatus.toLowerCase()})</span></div>
          <div><span style={{ color: 'var(--fg-muted)' }}>Quality</span><br /><strong>{QUALITY[s.phone.qualityRating] || s.phone.qualityRating}</strong></div>
          <div><span style={{ color: 'var(--fg-muted)' }}>New conversations limit</span><br /><strong>{LIMIT[s.phone.messagingLimit] || s.phone.messagingLimit.toLowerCase()}</strong></div>
          <div><span style={{ color: 'var(--fg-muted)' }}>Status</span><br /><strong>{s.phone.status.toLowerCase()}</strong></div>
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'end', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        <label style={{ flex: '1 1 16rem' }}>
          <span style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--fg-muted)', marginBottom: 4 }}>Change the name customers see (Meta reviews it; it must be your real business name)</span>
          <input {...input} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Vastora" maxLength={75} />
        </label>
        <button type="button" className="btn btn-outline" onClick={() => void askDisplayName()} disabled={busy === 'name' || newName.trim().length < 3}>
          {busy === 'name' ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : 'Ask Meta to change it'}
        </button>
      </div>

      {/* The business profile customers open from the chat */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Business profile</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>What a customer sees when they open the number&apos;s profile. Business hours are not in Meta&apos;s API (only the WhatsApp Business phone app sets them).</span>
      </div>
      {prof?.error && <p style={{ fontSize: '0.8125rem', color: 'var(--danger)', margin: '0 0 0.75rem' }}>{prof.error}</p>}
      {prof && !prof.error && (
        <form onSubmit={(e) => { e.preventDefault(); void saveProfile(); }} style={{ display: 'grid', gap: '0.5rem', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', overflow: 'hidden', background: 'var(--bg-subtle, #f6f5fa)', border: '1px solid var(--border)', flexShrink: 0, display: 'grid', placeItems: 'center' }}>
              {prof.profile?.pictureUrl ? <img src={prof.profile.pictureUrl} alt="Profile picture" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <MessageSquareText size={24} style={{ color: 'var(--fg-muted)' }} />}
            </div>
            <label className="btn btn-outline" style={{ gap: 6, cursor: busy === 'picture' ? 'wait' : 'pointer' }}>
              {busy === 'picture' ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Upload size={14} />} Change picture
              <input type="file" accept="image/jpeg,image/png" style={{ display: 'none' }} disabled={busy === 'picture'} onChange={(e) => { void uploadPicture(e.target.files?.[0] || null); e.target.value = ''; }} />
            </label>
            <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>JPG or PNG, square (640 x 640), up to 5 MB. Needs the Meta App id above.</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem' }}>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>About (short line, {pf.about.length}/139)</span><input {...input} value={pf.about} onChange={(e) => setPf({ ...pf, about: e.target.value })} maxLength={139} placeholder="Order help and tracking, Mon to Sat 10 AM to 7:30 PM" /></label>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Category</span>
              <select className="form-input" value={pf.vertical} onChange={(e) => setPf({ ...pf, vertical: e.target.value })}>
                {prof.verticals.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
              </select></label>
          </div>
          <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Description ({pf.description.length}/512)</span><textarea className="form-input" rows={3} value={pf.description} onChange={(e) => setPf({ ...pf, description: e.target.value })} maxLength={512} style={{ height: 'auto' }} /></label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem' }}>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Address</span><input {...input} value={pf.address} onChange={(e) => setPf({ ...pf, address: e.target.value })} maxLength={256} /></label>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Email</span><input {...input} value={pf.email} onChange={(e) => setPf({ ...pf, email: e.target.value })} maxLength={128} inputMode="email" /></label>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Website</span><input {...input} value={pf.website1} onChange={(e) => setPf({ ...pf, website1: e.target.value })} placeholder="https://" maxLength={256} /></label>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Second website (optional)</span><input {...input} value={pf.website2} onChange={(e) => setPf({ ...pf, website2: e.target.value })} placeholder="https://" maxLength={256} /></label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={busy === 'profile'}>{busy === 'profile' ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : 'Save profile'}</button>
          </div>
        </form>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Templates</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Meta reviews a new one (minutes to a day); only Approved ones can be sent</span>
        <button type="button" className="btn btn-sm btn-outline" style={{ marginLeft: 'auto', gap: 4 }} onClick={() => { setEditId(null); setForm({ name: '', language: 'en_US', category: 'UTILITY', header: '', body: '', footer: '', examples: [] }); setShowNew((v) => !v); }}><Plus size={14} /> New template</button>
      </div>
      {lists?.error && <p style={{ fontSize: '0.8125rem', color: 'var(--danger)', margin: '0 0 0.5rem' }}>{lists.error}</p>}
      {lists && !lists.error && lists.templates.length === 0 && <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)' }}>No templates on this account yet.</p>}
      {lists && lists.templates.length > 0 && (
        <div style={{ display: 'grid', gap: 6, marginBottom: '1rem' }}>
          {lists.templates.map((t) => (
            <div key={t.id || t.name + t.language} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '0.5rem 0.75rem', display: 'grid', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <code style={{ fontSize: '0.8125rem', fontWeight: 700 }}>{t.name}</code>
                <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{t.language} · {t.category}</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: STATUS_COLOR[t.status] || 'var(--fg-muted)' }}>{t.status}</span>
                {t.vars > 0 && <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{t.vars} value{t.vars > 1 ? 's' : ''}</span>}
                {t.id && t.status !== 'PENDING' && (
                  <button type="button" className="btn-icon" title="Edit this template (Meta reviews the change)" style={{ marginLeft: 'auto' }} onClick={() => startEdit(t)}><Pencil size={14} /></button>
                )}
                <button type="button" className="btn-icon" title="Delete this template" style={{ marginLeft: t.id && t.status !== 'PENDING' ? 0 : 'auto', color: 'var(--danger)' }} disabled={busy === 'del:' + t.name} onClick={() => void removeTpl(t.name)}>
                  {busy === 'del:' + t.name ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Trash2 size={14} />}
                </button>
              </div>
              {t.header && <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{t.header}</div>}
              <div style={{ fontSize: '0.8125rem', whiteSpace: 'pre-wrap' }}>{t.body}</div>
              {t.footer && <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{t.footer}</div>}
              {t.rejectedReason && <div style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>Rejected: {t.rejectedReason}</div>}
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <form onSubmit={(e) => { e.preventDefault(); void createTpl(); }} style={{ border: '1px dashed var(--border-strong, var(--border))', borderRadius: 10, padding: '0.75rem', display: 'grid', gap: '0.5rem', marginBottom: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem' }}>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Name{editId ? ' (cannot change)' : ''}</span><input {...input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="order_shipped" disabled={!!editId} /></label>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Language{editId ? ' (cannot change)' : ''}</span>
              <select className="form-input" value={form.language} disabled={!!editId} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                {(lists?.languages || [{ code: 'en_US', label: 'English (US)' }, { code: 'hi', label: 'Hindi' }]).map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select></label>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Category</span>
              <select className="form-input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="UTILITY">Utility (order updates, support)</option><option value="MARKETING">Marketing (offers)</option>
              </select></label>
          </div>
          <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Header (optional, one plain line)</span><input {...input} value={form.header} onChange={(e) => setForm({ ...form, header: e.target.value })} maxLength={60} /></label>
          <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Body: use {'{{1}}'}, {'{{2}}'} for the values filled in when sending</span>
            <textarea className="form-input" rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder={'Hi {{1}}, this is the support team. About your order {{2}}: we are looking into it and will update you here.'} style={{ height: 'auto' }} /></label>
          {vars > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem' }}>
              {Array.from({ length: vars }, (_, i) => (
                <label key={i}><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Example for {`{{${i + 1}}}`} (Meta needs one)</span>
                  <input {...input} value={form.examples[i] || ''} onChange={(e) => { const ex = [...form.examples]; ex[i] = e.target.value; setForm({ ...form, examples: ex }); }} /></label>
              ))}
            </div>
          )}
          <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Footer (optional)</span><input {...input} value={form.footer} onChange={(e) => setForm({ ...form, footer: e.target.value })} maxLength={60} /></label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-outline" onClick={() => { setShowNew(false); setEditId(null); }}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy === 'create' || !form.name || !form.body}>{busy === 'create' ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : editId ? 'Save change (Meta reviews it)' : 'Send to Meta for review'}</button>
          </div>
        </form>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0.25rem 0 0.5rem' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Message a number</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>The first message to a customer: an approved template, then the chat opens in Chat Support</span>
      </div>
      {approved.length === 0 ? (
        <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)' }}>No approved template yet. Make one above and wait for Meta&apos;s approval.</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void sendFirst(); }} style={{ display: 'grid', gap: '0.5rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '0.5rem' }}>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>WhatsApp number</span><input {...input} value={send.to} onChange={(e) => setSend({ ...send, to: e.target.value })} placeholder="98765 43210" inputMode="tel" /></label>
            <label><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Template</span>
              <select className="form-input" value={send.template} onChange={(e) => setSend({ ...send, template: e.target.value, params: [] })}>
                <option value="">Pick one</option>
                {approved.map((t) => <option key={t.id || t.name} value={t.name}>{t.name} ({t.language})</option>)}
              </select></label>
          </div>
          {chosen && chosen.vars > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem' }}>
              {Array.from({ length: chosen.vars }, (_, i) => (
                <label key={i}><span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Value {i + 1}</span>
                  <input {...input} value={send.params[i] || ''} onChange={(e) => { const p = [...send.params]; p[i] = e.target.value; setSend({ ...send, params: p }); }} /></label>
              ))}
            </div>
          )}
          {chosen && <div style={{ fontSize: '0.8125rem', whiteSpace: 'pre-wrap', background: 'var(--bg-subtle, #f6f5fa)', borderRadius: 8, padding: '0.5rem 0.75rem' }}>{renderTemplate(chosen, send.params)}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" style={{ gap: 6 }} disabled={busy === 'send' || !chosen || !send.to.trim() || (chosen ? send.params.slice(0, chosen.vars).filter(Boolean).length < chosen.vars : true)}>
              {busy === 'send' ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Send size={14} />} Send on WhatsApp
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
