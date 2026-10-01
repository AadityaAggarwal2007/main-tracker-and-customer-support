'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound, LayoutGrid, Pencil, UserRound, X } from 'lucide-react';
import { PERMISSION_GROUPS } from '@/lib/permissions';

// My profile (owner, 2026-10-01): a team member sees their name, role, the panels they work on and
// what they can do, and changes their own name once every 15 days (/api/auth/profile). The owner
// changes names any time in Team, and is the only one who changes passwords. Customers never see
// these names; they see "Vastora Support".

interface Profile {
  superAdmin: boolean; username: string; displayName: string; role: string; roleLabel: string;
  allPanels: boolean; panels: { id: string; name: string }[]; permissions: string[];
  nameChangedAt: string | null; nextNameChangeAt: string | null; nameChangeDays: number;
}

const dayIST = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const section = { fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', margin: '1rem 0 0.375rem' } as const;

export default function MyProfile({ token, onClose, onAlert, onUserChanged }: {
  token: string | null;
  onClose: () => void;
  onAlert: (type: 'success' | 'error', message: string) => void;
  // The new name, for the screen and the saved login (localStorage auth_user).
  onUserChanged?: (displayName: string) => void;
}) {
  const [p, setP] = useState<Profile | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch('/api/auth/profile', { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setP(d); setName(d.displayName || ''); } else onAlert('error', d.error || 'Could not load your profile');
    } catch { onAlert('error', 'Could not load your profile'); }
  }, [token, onAlert]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!p) return;
    setBusy(true);
    try {
      const r = await fetch('/api/auth/profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ displayName: name }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'Could not save your name'); return; }
      setP(d); setName(d.displayName); setEditing(false);
      try {
        const u = JSON.parse(localStorage.getItem('auth_user') || '{}');
        localStorage.setItem('auth_user', JSON.stringify({ ...u, displayName: d.displayName }));
      } catch { /* private window */ }
      onUserChanged?.(d.displayName);
      onAlert('success', 'Name saved');
    } catch { onAlert('error', 'Could not save your name'); }
    finally { setBusy(false); }
  };

  const locked = !!p?.nextNameChangeAt;
  const labels = PERMISSION_GROUPS.flatMap((g) => g.items).filter((i) => p?.permissions.includes(i.key));
  const initials = (p?.displayName || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="my-profile-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '30rem' }}>
        <div className="modal-header">
          <div>
            <h3 className="modal-title" id="my-profile-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <UserRound size={18} style={{ color: 'var(--primary)' }} /> My profile
            </h3>
            <p className="modal-subtitle">Only the team sees your name. Customers always see &ldquo;Vastora Support&rdquo;.</p>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>

        {!p ? <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)' }}>Loading…</p> : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 44, height: 44, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg, #4f6bed, #8b5cf6)', flexShrink: 0 }}>{initials || '?'}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '1rem' }}>{p.displayName}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>@{p.username} · {p.roleLabel}</div>
              </div>
            </div>

            {!p.superAdmin && (
              <>
                <div style={section}>Your name</div>
                {editing ? (
                  <form onSubmit={(e) => { e.preventDefault(); void save(); }} style={{ display: 'flex', gap: 8 }}>
                    <input className="form-input" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
                    <button type="submit" className="btn btn-primary btn-sm" disabled={busy || name.trim().length < 2}><Check size={14} /> Save</button>
                    <button type="button" className="btn btn-sm" style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' }} onClick={() => { setEditing(false); setName(p.displayName); }}>Cancel</button>
                  </form>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.875rem' }}>{p.displayName}</span>
                    {locked ? (
                      <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>You can change it again on {dayIST(p.nextNameChangeAt!)}.</span>
                    ) : (
                      <button type="button" className="btn btn-sm" style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg)' }} onClick={() => setEditing(true)}>
                        <Pencil size={13} /> Change
                      </button>
                    )}
                  </div>
                )}
                <p style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', margin: '0.375rem 0 0' }}>
                  Once every {p.nameChangeDays} days. The owner sees every change.
                </p>
              </>
            )}

            <div style={section}><LayoutGrid size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />Your panels</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {p.panels.map((x) => (
                <span key={x.id} style={{ fontSize: '0.75rem', fontWeight: 600, padding: '0.1875rem 0.625rem', borderRadius: 999, background: 'var(--primary-light)', color: 'var(--primary)' }}>{x.name}</span>
              ))}
              {p.allPanels && <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', alignSelf: 'center' }}>(all panels)</span>}
            </div>

            <div style={section}>What you can do</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {labels.map((i) => (
                <span key={i.key} title={i.hint} style={{ fontSize: '0.6875rem', padding: '0.125rem 0.5rem', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--fg)' }}>{i.label}</span>
              ))}
            </div>

            {!p.superAdmin && (
              <p style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: '0.75rem', color: 'var(--fg-muted)', marginTop: '1rem' }}>
                <KeyRound size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>Your password is changed only by the owner. Ask him if you need a new one.</span>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
