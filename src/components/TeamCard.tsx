'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, MessageCircle, Pencil, Power, Trash2, UserPlus, X } from 'lucide-react';
import OwnerLoginDialog, { PasswordInput, since } from './OwnerLogin';
import { PERMISSION_GROUPS, ROLE_INFO, TEAM_ROLES, type Permission, type Role } from '@/lib/permissions';

// Team (owner, 2026-10-01): the owner (super admin) gives each person their own login: a role,
// the panels they may use and the exact things they can do (src/lib/permissions.ts). ShipTrack
// makes the password (or takes one the owner types) and shows it once, with the login link, ready
// to send (copy or WhatsApp). The owner changes his own username / password here too (owner,
// 2026-10-01: the old one was known to the whole staff): /api/auth/account. Every change is checked
// on the server too (/api/team, the routes' own checks).

type TeamRole = Exclude<Role, 'admin'>;
interface Member {
  id: string; username: string; display_name: string; role: TeamRole; is_active: boolean;
  last_login: string | null; created_at: string; business_ids: string[] | null; permissions: string[] | null; effective: Permission[];
}
interface Panel { id: string; name: string; logo_url?: string | null; primary_color?: string | null }
interface Draft { id?: string; origUsername?: string; displayName: string; username: string; role: TeamRole; allPanels: boolean; panels: string[]; perms: Permission[] }
interface Share { name: string; username: string; password: string; reset: boolean }
interface Owner { username: string; changedAt: string | null; savedInPanel: boolean }
interface PwDraft { member: Member; mode: 'auto' | 'own'; value: string; show: boolean }

const ROLE_STYLE: Record<TeamRole, { color: string; bg: string }> = {
  panel_admin: { color: '#4338ca', bg: '#eef0ff' },
  manager: { color: '#0e7490', bg: '#e6f7fb' },
  agent: { color: '#047857', bg: '#e7f8f0' },
  viewer: { color: '#6b7280', bg: '#f1f2f4' },
};
const muted = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' };
const ALL_PERMS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

const emptyDraft = (): Draft => ({ displayName: '', username: '', role: 'agent', allPanels: true, panels: [], perms: [...ROLE_INFO.agent.perms] });
const suggestUsername = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 24);
function ago(iso: string | null): string {
  if (!iso) return 'Never logged in';
  const s = since(iso);
  return s === 'just now' ? 'Active just now' : `Last login ${s}`;
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const USERNAME_OK = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export default function TeamCard({ token, panels, onAlert, onLoginChanged }: {
  token: string | null; panels: Panel[]; onAlert: (type: string, message: string) => void;
  // The owner's new login after he changes it here (his old one stops working).
  onLoginChanged?: (token: string, user: unknown) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [share, setShare] = useState<Share | null>(null);
  const [copied, setCopied] = useState(false);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [pwFor, setPwFor] = useState<PwDraft | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch('/api/team', { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setMembers(d.users || []);
      else onAlert('error', d.error || 'Could not load the team');
    } catch { onAlert('error', 'Could not load the team'); }
    finally { setLoaded(true); }
  }, [token, onAlert]);
  useEffect(() => { load(); }, [load]);

  const loadOwner = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch('/api/auth/account', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setOwner(await r.json());
    } catch { /* the row shows without it */ }
  }, [token]);
  useEffect(() => { loadOwner(); }, [loadOwner]);

  const call = async (method: 'POST' | 'PATCH' | 'DELETE', body?: unknown, qs = '') => {
    setBusy(true);
    try {
      const r = await fetch(`/api/team${qs}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'Could not save'); return null; }
      await load();
      return d as { user?: Member; password?: string };
    } catch { onAlert('error', 'Could not save'); return null; }
    finally { setBusy(false); }
  };

  const panelName = (id: string) => panels.find((p) => p.id === id)?.name || 'Removed panel';
  const loginLink = typeof window !== 'undefined' ? `${window.location.origin}/login` : 'https://shiptrack.store/login';
  const shareText = share ? `Your ShipTrack login\nLink: ${loginLink}\nUsername: ${share.username}\nPassword: ${share.password}\n\nPlease keep it private.` : '';

  const openNew = () => { setShare(null); setDraft(emptyDraft()); };
  const openEdit = (m: Member) => {
    setShare(null);
    setDraft({ id: m.id, origUsername: m.username, displayName: m.display_name, username: m.username, role: m.role, allPanels: !m.business_ids || !m.business_ids.length,
      panels: m.business_ids || [], perms: [...m.effective] });
  };
  const setRole = (role: TeamRole) => draft && setDraft({ ...draft, role, perms: [...ROLE_INFO[role].perms] });
  const togglePerm = (p: Permission) => draft && setDraft({ ...draft, perms: draft.perms.includes(p) ? draft.perms.filter((x) => x !== p) : [...draft.perms, p] });
  const custom = useMemo(() => {
    if (!draft) return false;
    const base = ROLE_INFO[draft.role].perms;
    return base.length !== draft.perms.length || base.some((p) => !draft.perms.includes(p));
  }, [draft]);

  const save = async () => {
    if (!draft) return;
    if (draft.displayName.trim().length < 2) { onAlert('error', 'Write the member\'s name'); return; }
    if (!draft.allPanels && !draft.panels.length) { onAlert('error', 'Pick at least one panel, or All panels'); return; }
    const body = {
      displayName: draft.displayName, role: draft.role, permissions: draft.perms,
      businessIds: draft.allPanels ? null : draft.panels,
    };
    if (draft.id) {
      const renamed = draft.username !== draft.origUsername;
      if (renamed && !USERNAME_OK.test(draft.username)) { onAlert('error', 'Username: 3-32 small letters, numbers, dot, dash or underscore'); return; }
      const d = await call('PATCH', { id: draft.id, ...body, ...(renamed ? { username: draft.username } : {}) });
      if (d) {
        setDraft(null);
        onAlert('success', renamed ? `Saved. They sign in again with ${draft.username} (same password).` : 'Saved: it applies within 30 seconds');
      }
    } else {
      const d = await call('POST', { ...body, username: draft.username });
      if (d?.password) { setDraft(null); setShare({ name: draft.displayName, username: draft.username, password: d.password, reset: false }); }
    }
  };

  const resetPassword = (m: Member) => { setShare(null); setPwFor({ member: m, mode: 'auto', value: '', show: false }); };
  const savePassword = async () => {
    if (!pwFor) return;
    const m = pwFor.member;
    if (pwFor.mode === 'own') {
      if (pwFor.value.length < 8) { onAlert('error', 'Password: at least 8 characters'); return; }
      const d = await call('PATCH', { id: m.id, password: pwFor.value });
      if (d) { setPwFor(null); setShare({ name: m.display_name, username: m.username, password: pwFor.value, reset: true }); }
    } else {
      const d = await call('PATCH', { id: m.id, resetPassword: true });
      if (d?.password) { setPwFor(null); setShare({ name: m.display_name, username: m.username, password: d.password, reset: true }); }
    }
  };
  const toggleActive = async (m: Member) => {
    if (m.is_active && !confirm(`Switch off ${m.display_name}'s login? They are signed out within 30 seconds.`)) return;
    const d = await call('PATCH', { id: m.id, isActive: !m.is_active });
    if (d) onAlert('success', m.is_active ? 'Login switched off' : 'Login switched on');
  };
  const remove = async (m: Member) => {
    if (!confirm(`Remove ${m.display_name}'s login for good? Their past replies stay in the chats.`)) return;
    const d = await call('DELETE', undefined, `?id=${encodeURIComponent(m.id)}`);
    if (d) onAlert('success', 'Removed');
  };
  const copyAll = async () => {
    try { await navigator.clipboard.writeText(shareText); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { onAlert('error', 'Could not copy: select the text instead'); }
  };

  const roleBadge = (role: TeamRole) => (
    <span style={{ fontSize: '0.6875rem', fontWeight: 700, padding: '0.125rem 0.5rem', borderRadius: 999, color: ROLE_STYLE[role].color, background: ROLE_STYLE[role].bg, whiteSpace: 'nowrap' }}>{ROLE_INFO[role].label}</span>
  );
  const avatar = (text: string, color: string) => (
    <span style={{ width: 38, height: 38, borderRadius: 999, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.8125rem', color: '#fff', background: color }}>{text}</span>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        <div>
          <h2 className="page-title">Team</h2>
          <p className="page-subtitle">Give each person their own login, the panels they work on and what they can do.</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}><UserPlus size={16} /> Add member</button>
      </div>

      {/* The roles at a glance */}
      <div className="tf-card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        {TEAM_ROLES.map((r) => (
          <div key={r} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            {roleBadge(r)}
            <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>{ROLE_INFO[r].hint}</span>
          </div>
        ))}
      </div>

      {/* Members */}
      <div className="tf-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0.875rem 1.25rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)', flexWrap: 'wrap' }}>
          {avatar('SA', 'linear-gradient(135deg, #4f6bed, #8b5cf6)')}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '0.875rem' }}>Super Admin (you)</span>
              {owner && <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>@{owner.username}</span>}
              <span style={{ fontSize: '0.6875rem', fontWeight: 700, padding: '0.125rem 0.5rem', borderRadius: 999, color: '#fff', background: 'linear-gradient(90deg, #4f6bed, #8b5cf6)' }}>Owner</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginTop: 2 }}>
              All panels · everything, including the team, Shopify, mailboxes and the Danger Zone
              {owner?.savedInPanel && owner.changedAt ? ` · login changed ${since(owner.changedAt)}` : ''}
            </div>
            {owner && !owner.savedInPanel && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: '0.75rem', color: '#92400e', background: '#fff7e6', border: '1px solid #fde68a', borderRadius: 8, padding: '0.3125rem 0.5rem' }}>
                <AlertTriangle size={13} style={{ flexShrink: 0 }} /> Your login is still the first one from the server settings. Change it so only you know it.
              </div>
            )}
          </div>
          <button className="btn btn-sm" style={muted} disabled={busy} onClick={() => setOwnerOpen(true)}>
            <KeyRound size={13} /> Change username / password
          </button>
        </div>
        {loaded && !members.length && (
          <div style={{ padding: '2rem 1.25rem', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '0.8125rem' }}>
            No team members yet. <button type="button" onClick={openNew} style={{ border: 'none', background: 'none', color: 'var(--primary)', fontWeight: 600, cursor: 'pointer', padding: 0 }}>Add the first one</button>: they get their own login and only the panels you give them.
          </div>
        )}
        {members.map((m) => (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0.875rem 1.25rem', borderBottom: '1px solid var(--border)', opacity: m.is_active ? 1 : 0.55, flexWrap: 'wrap' }}>
            {avatar(initials(m.display_name), m.is_active ? ROLE_STYLE[m.role].color : '#9ca3af')}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: '0.875rem' }}>{m.display_name}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>@{m.username}</span>
                {roleBadge(m.role)}
                {m.permissions && <span title="Ticks changed from the role's" style={{ fontSize: '0.625rem', fontWeight: 700, color: '#b45309', background: '#fff6e5', borderRadius: 999, padding: '0.0625rem 0.4rem' }}>custom</span>}
                {!m.is_active && <span style={{ fontSize: '0.625rem', fontWeight: 700, color: '#b91c1c', background: '#fee2e2', borderRadius: 999, padding: '0.0625rem 0.4rem' }}>OFF</span>}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginTop: 2 }}>
                {m.business_ids && m.business_ids.length ? m.business_ids.map(panelName).join(', ') : 'All panels'} · {m.effective.length} of {ALL_PERMS.length} permissions · {ago(m.last_login)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" style={muted} disabled={busy} onClick={() => openEdit(m)}><Pencil size={13} /> Edit</button>
              <button className="btn btn-sm" style={muted} disabled={busy} onClick={() => resetPassword(m)}><KeyRound size={13} /> New password</button>
              <button className="btn btn-sm" style={muted} disabled={busy} onClick={() => toggleActive(m)}><Power size={13} /> {m.is_active ? 'Switch off' : 'Switch on'}</button>
              <button className="btn btn-sm" style={{ ...muted, color: 'var(--danger, #ef4444)' }} disabled={busy} onClick={() => remove(m)} aria-label={`Remove ${m.display_name}`}><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
      </div>

      {/* Add / edit */}
      {draft && (
        <div className="modal-overlay" onClick={() => setDraft(null)}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '44rem' }}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">{draft.id ? `Edit ${draft.displayName || 'member'}` : 'Add a team member'}</h3>
                <p className="modal-subtitle">{draft.id ? 'Changes apply within 30 seconds; they stay logged in.' : 'ShipTrack makes the password and shows it to you once, with the login link.'}</p>
              </div>
              <button className="btn-icon" onClick={() => setDraft(null)} aria-label="Close"><X size={16} /></button>
            </div>

            <div style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 6 }}>1. Who</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Name
                <input className="form-input" style={{ marginTop: 4 }} placeholder="e.g. Rahul Sharma" value={draft.displayName} maxLength={60}
                  onChange={(e) => setDraft({ ...draft, displayName: e.target.value, ...(draft.id ? {} : { username: suggestUsername(e.target.value) }) })} autoFocus />
              </label>
              <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Username {draft.id && draft.username !== draft.origUsername && <span style={{ fontWeight: 400, color: '#b45309' }}>(they sign in again with the new one)</span>}
                <input className="form-input" style={{ marginTop: 4 }} placeholder="e.g. rahul.sharma" value={draft.username} maxLength={32}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '') })} />
              </label>
            </div>

            <div style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 6 }}>2. Role</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: '1rem' }} role="radiogroup" aria-label="Role">
              {TEAM_ROLES.map((r) => {
                const on = draft.role === r;
                return (
                  <button key={r} type="button" role="radio" aria-checked={on} onClick={() => setRole(r)}
                    style={{ textAlign: 'left', padding: '0.625rem 0.75rem', borderRadius: 10, cursor: 'pointer',
                      border: `1.5px solid ${on ? ROLE_STYLE[r].color : 'var(--border)'}`, background: on ? ROLE_STYLE[r].bg : 'var(--card-bg)' }}>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: '0.8125rem', color: on ? ROLE_STYLE[r].color : 'var(--fg)' }}>{ROLE_INFO[r].label}</span>
                    <span style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--fg-muted)', lineHeight: 1.45, marginTop: 2 }}>{ROLE_INFO[r].hint}</span>
                  </button>
                );
              })}
            </div>

            <div style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 6 }}>3. Panels</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '1rem' }}>
              <button type="button" onClick={() => setDraft({ ...draft, allPanels: true })} className="btn btn-sm"
                style={{ ...muted, ...(draft.allPanels ? { borderColor: 'var(--primary)', color: 'var(--primary)', background: 'var(--primary-light)' } : {}) }}>
                {draft.allPanels && <Check size={13} />} All panels
              </button>
              {panels.map((p) => {
                const on = !draft.allPanels && draft.panels.includes(p.id);
                return (
                  <button key={p.id} type="button" className="btn btn-sm"
                    onClick={() => setDraft({ ...draft, allPanels: false, panels: on ? draft.panels.filter((x) => x !== p.id) : [...draft.panels.filter((x) => panels.some((q) => q.id === x)), p.id] })}
                    style={{ ...muted, ...(on ? { borderColor: 'var(--primary)', color: 'var(--primary)', background: 'var(--primary-light)' } : {}) }}>
                    {on && <Check size={13} />} {p.name}
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>4. What they can do</span>
              {custom && <button type="button" onClick={() => setRole(draft.role)} style={{ border: 'none', background: 'none', color: 'var(--primary)', fontSize: '0.75rem', cursor: 'pointer', padding: 0 }}>Back to the {ROLE_INFO[draft.role].label} ticks</button>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: '0.75rem' }}>
              {PERMISSION_GROUPS.map((g) => (
                <div key={g.title} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '0.625rem 0.75rem' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, marginBottom: 6 }}>{g.title}</div>
                  {g.items.map((it) => (
                    <label key={it.key} title={it.hint} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.75rem', padding: '0.1875rem 0', cursor: 'pointer' }}>
                      <input type="checkbox" checked={draft.perms.includes(it.key)} onChange={() => togglePerm(it.key)} style={{ marginTop: 2 }} />
                      <span><span style={{ fontWeight: 600 }}>{it.label}</span><span style={{ display: 'block', color: 'var(--fg-muted)', fontSize: '0.6875rem' }}>{it.hint}</span></span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '1rem' }}>
              Only you can add members, connect Shopify or mailboxes, change the default panel, make a new widget key or use the Danger Zone.
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" style={muted} onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || draft.displayName.trim().length < 2 || draft.username.length < 3} onClick={save}>
                {draft.id ? <><Check size={14} /> Save</> : <><UserPlus size={14} /> Create login</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The owner's own login: Login & security */}
      {ownerOpen && (
        <OwnerLoginDialog token={token} onAlert={onAlert} onClose={() => setOwnerOpen(false)}
          onLoginChanged={onLoginChanged} onSaved={() => { void loadOwner(); void load(); }} />
      )}

      {/* A member's new password: made for them, or typed by the owner */}
      {pwFor && (
        <div className="modal-overlay" onClick={() => !busy && setPwFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '28rem' }}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">New password for {pwFor.member.display_name}</h3>
                <p className="modal-subtitle">Their old password stops working and they are signed out.</p>
              </div>
              <button className="btn-icon" onClick={() => setPwFor(null)} aria-label="Close" disabled={busy}><X size={16} /></button>
            </div>
            <div role="radiogroup" aria-label="Password" style={{ display: 'grid', gap: 8, marginBottom: '1rem' }}>
              {([['auto', 'Make a strong one for me', 'Recommended. Shown to you once, ready to send.'], ['own', 'I will type it', 'At least 8 characters.']] as const).map(([mode, label, hint]) => {
                const on = pwFor.mode === mode;
                return (
                  <button key={mode} type="button" role="radio" aria-checked={on} onClick={() => setPwFor({ ...pwFor, mode })}
                    style={{ textAlign: 'left', padding: '0.625rem 0.75rem', borderRadius: 10, cursor: 'pointer', border: `1.5px solid ${on ? 'var(--primary)' : 'var(--border)'}`, background: on ? 'var(--primary-light)' : 'var(--card-bg)' }}>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: '0.8125rem', color: on ? 'var(--primary)' : 'var(--fg)' }}>{label}</span>
                    <span style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: 2 }}>{hint}</span>
                  </button>
                );
              })}
            </div>
            {pwFor.mode === 'own' && (
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '1rem' }}>Password
                <PasswordInput value={pwFor.value} onChange={(v) => setPwFor({ ...pwFor, value: v })} show={pwFor.show}
                  onToggle={() => setPwFor({ ...pwFor, show: !pwFor.show })} placeholder="At least 8 characters" autoFocus autoComplete="new-password" />
              </label>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" style={muted} onClick={() => setPwFor(null)} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || (pwFor.mode === 'own' && pwFor.value.length < 8)} onClick={savePassword}><KeyRound size={14} /> Save new password</button>
            </div>
          </div>
        </div>
      )}

      {/* The login to send */}
      {share && (
        <div className="modal-overlay" onClick={() => setShare(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '30rem' }}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">{share.reset ? `New password for ${share.name}` : `${share.name}'s login is ready`}</h3>
                <p className="modal-subtitle">Send this to them. The password is shown only now{share.reset ? '; the old one no longer works' : ''}.</p>
              </div>
              <button className="btn-icon" onClick={() => setShare(null)} aria-label="Close"><X size={16} /></button>
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '0.875rem 1rem', background: 'var(--bg-subtle)', fontSize: '0.875rem', lineHeight: 1.9 }}>
              <div><span style={{ color: 'var(--fg-muted)', display: 'inline-block', width: 84 }}>Login link</span><b>{loginLink}</b></div>
              <div><span style={{ color: 'var(--fg-muted)', display: 'inline-block', width: 84 }}>Username</span><b style={{ fontFamily: 'monospace' }}>{share.username}</b></div>
              <div><span style={{ color: 'var(--fg-muted)', display: 'inline-block', width: 84 }}>Password</span><b style={{ fontFamily: 'monospace', letterSpacing: '0.04em' }}>{share.password}</b></div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: '1rem', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={copyAll}>{copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy all</>}</button>
              <a className="btn" style={{ ...muted, textDecoration: 'none' }} href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noopener noreferrer"><MessageCircle size={14} /> Send on WhatsApp</a>
              <button className="btn" style={{ ...muted, marginLeft: 'auto' }} onClick={() => setShare(null)}>Done</button>
            </div>
            <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.75rem' }}>
              Lost it? Use &ldquo;New password&rdquo; on their row. They should not share their login with anyone.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
