'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Eye, EyeOff, LogOut, ShieldCheck, Sparkles, X } from 'lucide-react';

// Login & security (owner, 2026-10-01: "super admin sirf ek se khule, reset ho sake, sabke system
// logout"). The owner's own login: change the username / password (only the new one works after,
// every older owner login is signed out, the team too if ticked), sign everyone out at once, and
// how to reset a forgotten password. Opened from the sidebar (Super Admin) and from Team. The
// server checks everything again (/api/auth/account).

export interface OwnerInfo { username: string; changedAt: string | null; savedInPanel: boolean; teamCount: number }

export const RESET_COMMAND = "ssh shiptrack-vps 'cd /var/www/tracker && node scripts/admin-login-reset.js'";
const USERNAME_OK = /^[a-z0-9][a-z0-9._-]{2,31}$/;

// A strong password to suggest: 14 letters and digits, easy to read (no 0/O, 1/l/I).
export function strongPassword(): string {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

export function since(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// A password box with show / hide.
export function PasswordInput({ value, onChange, show, onToggle, placeholder, autoFocus, autoComplete }: {
  value: string; onChange: (v: string) => void; show: boolean; onToggle: () => void; placeholder?: string; autoFocus?: boolean; autoComplete?: string;
}) {
  return (
    <div style={{ position: 'relative', marginTop: 4 }}>
      <input className="form-input" type={show ? 'text' : 'password'} value={value} placeholder={placeholder} autoFocus={autoFocus}
        autoComplete={autoComplete} maxLength={128} onChange={(e) => onChange(e.target.value)} style={{ paddingRight: '2.5rem', fontFamily: show && value ? 'monospace' : undefined }} />
      <button type="button" onClick={onToggle} aria-label={show ? 'Hide password' : 'Show password'}
        style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--fg-muted)', display: 'flex', padding: 4 }}>
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

const sectionTitle = { fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', margin: '1.125rem 0 0.5rem' } as const;
const linkBtn = { border: 'none', background: 'none', color: 'var(--primary)', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4 } as const;
const muted = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' };
const label = { display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.625rem' } as const;

type Done = { kind: 'changed'; username: string; pwChanged: boolean; team: number | null } | { kind: 'signedOut'; team: number };

export default function OwnerLoginDialog({ token, onClose, onAlert, onLoginChanged, onSaved }: {
  token: string | null;
  onClose: () => void;
  onAlert: (type: string, message: string) => void;
  // The owner's new login after a change or "Sign out everyone" (his old one stops working).
  onLoginChanged?: (token: string, user: unknown) => void;
  onSaved?: () => void;
}) {
  const [owner, setOwner] = useState<OwnerInfo | null>(null);
  const [current, setCurrent] = useState('');
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [copied, setCopied] = useState(false);
  const [signOutTeam, setSignOutTeam] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [resetCopied, setResetCopied] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch('/api/auth/account', { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setOwner(d); setUsername((u) => u || d.username || ''); }
      else onAlert('error', d.error || 'Could not load your login');
    } catch { onAlert('error', 'Could not load your login'); }
  }, [token, onAlert]);
  useEffect(() => { load(); }, [load]);

  const problem = (): string | null => {
    if (!current) return 'Type your current password';
    const u = username.trim().toLowerCase();
    const renamed = !!owner && u !== owner.username.toLowerCase();
    if (renamed && !USERNAME_OK.test(u)) return 'Username: 3-32 small letters, numbers, dot, dash or underscore';
    if (pw) {
      if (pw.length < 8) return 'New password: at least 8 characters';
      if (pw !== pw2) return 'The two new passwords are not the same';
    }
    if (!renamed && !pw) return 'Type a new username or a new password';
    return null;
  };

  const take = (d: { token?: string; user?: unknown }) => {
    if (!d.token) return;
    try { localStorage.setItem('auth_token', d.token); localStorage.setItem('auth_user', JSON.stringify(d.user)); } catch { /* private window */ }
    onLoginChanged?.(d.token, d.user);
  };

  const save = async () => {
    const p = problem();
    if (p) { onAlert('error', p); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: current, username: username.trim(), newPassword: pw || undefined, signOutTeam: signOutTeam && !!owner?.teamCount }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.token) { onAlert('error', d.error || 'Could not save'); return; }
      take(d);
      setDone({ kind: 'changed', username: d.username, pwChanged: !!pw, team: d.teamSignedOut ?? null });
      setCurrent(''); setPw(''); setPw2('');
      onSaved?.();
      onAlert('success', 'Login changed. Everyone using the old one is signed out.');
    } catch { onAlert('error', 'Could not save'); }
    finally { setBusy(false); }
  };

  const signOutEveryone = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/auth/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'signOutEveryone' }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.token) { onAlert('error', d.error || 'Could not sign everyone out'); return; }
      take(d);
      setConfirmAll(false);
      setDone({ kind: 'signedOut', team: d.teamSignedOut ?? 0 });
      onSaved?.();
      onAlert('success', 'Everyone is signed out. You are still signed in here.');
    } catch { onAlert('error', 'Could not sign everyone out'); }
    finally { setBusy(false); }
  };

  const copyText = async (text: string, then: () => void) => {
    try { await navigator.clipboard.writeText(text); then(); } catch { onAlert('error', 'Could not copy: select the text instead'); }
  };

  const loginLink = typeof window !== 'undefined' ? `${window.location.origin}/login` : 'https://shiptrack.store/login';
  const teamCount = owner?.teamCount ?? 0;
  const problemNow = problem();

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="owner-login-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '32rem' }}>
        <div className="modal-header">
          <div>
            <h3 className="modal-title" id="owner-login-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldCheck size={18} style={{ color: 'var(--primary)' }} /> Login &amp; security
            </h3>
            <p className="modal-subtitle">You are the only Super Admin. Keep this login to yourself.</p>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>

        {done ? (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8125rem', color: 'var(--success)', background: 'var(--success-light)', borderRadius: 10, padding: '0.625rem 0.75rem' }}>
              <Check size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                {done.kind === 'changed'
                  ? `Your new login is saved. Every device that used the old one is signed out${done.team ? `, and ${done.team} team member${done.team === 1 ? '' : 's'} too` : ''}.`
                  : `Everyone is signed out: ${done.team ? `${done.team} team member${done.team === 1 ? '' : 's'} and ` : ''}every other device using your login.`}
                {' '}You are still signed in here.
              </span>
            </div>
            {done.kind === 'changed' && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '0.875rem 1rem', background: 'var(--bg-subtle)', fontSize: '0.875rem', lineHeight: 1.9, marginTop: '0.75rem' }}>
                <div><span style={{ color: 'var(--fg-muted)', display: 'inline-block', width: 84 }}>Login link</span><b>{loginLink}</b></div>
                <div><span style={{ color: 'var(--fg-muted)', display: 'inline-block', width: 84 }}>Username</span><b style={{ fontFamily: 'monospace' }}>{done.username}</b></div>
                <div><span style={{ color: 'var(--fg-muted)', display: 'inline-block', width: 84 }}>Password</span><span style={{ color: 'var(--fg-muted)' }}>{done.pwChanged ? 'the new one you set' : 'same as before'}</span></div>
              </div>
            )}
            <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', marginTop: '0.75rem' }}>
              {done.kind === 'changed'
                ? 'If your browser saved the old login, remove it there (Chrome: Settings > Passwords) so it does not fill the old one again. Give the staff their own logins with "Add member" in Team.'
                : 'The team signs in again with their own passwords. Anyone who was using your login needs your password, which only you have.'}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
              <button type="button" className="btn btn-primary" onClick={onClose}><Check size={14} /> Done</button>
            </div>
          </>
        ) : (
          <>
            {/* Where the login stands */}
            {owner && (owner.savedInPanel ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8125rem', color: 'var(--success)', background: 'var(--success-light)', borderRadius: 10, padding: '0.625rem 0.75rem' }}>
                <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span><b>@{owner.username}</b>{owner.changedAt ? ` · changed ${since(owner.changedAt)}` : ''}. Only this login opens the Super Admin.</span>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8125rem', color: '#92400e', background: '#fff7e6', border: '1px solid #fde68a', borderRadius: 10, padding: '0.625rem 0.75rem' }}>
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span><b>@{owner.username}</b> is still the first login from the server settings, and the staff know it. Change it below: everyone using it is signed out at once.</span>
              </div>
            ))}

            {/* Change username / password */}
            <div style={sectionTitle}>Change username / password</div>
            <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
              <label style={label}>Current password
                <PasswordInput value={current} onChange={setCurrent} show={showCur} onToggle={() => setShowCur(!showCur)} autoComplete="current-password" />
              </label>
              <label style={label}>Username
                <input className="form-input" style={{ marginTop: 4 }} value={username} maxLength={32} autoComplete="username"
                  onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))} />
                <span style={{ display: 'block', fontWeight: 400, color: 'var(--fg-muted)', fontSize: '0.6875rem', marginTop: 3 }}>Small letters, numbers, dot, dash or underscore. Keep it as it is to change only the password.</span>
              </label>
              <label style={label}>
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  New password
                  <span style={{ display: 'inline-flex', gap: 12 }}>
                    {pw && showNew && (
                      <button type="button" style={linkBtn} onClick={() => copyText(pw, () => setCopied(true))}>
                        {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                      </button>
                    )}
                    <button type="button" style={linkBtn} onClick={() => { const p = strongPassword(); setPw(p); setPw2(p); setShowNew(true); setCopied(false); }}>
                      <Sparkles size={12} /> Suggest a strong one
                    </button>
                  </span>
                </span>
                <PasswordInput value={pw} onChange={(v) => { setPw(v); setCopied(false); }} show={showNew} onToggle={() => setShowNew(!showNew)}
                  placeholder="At least 8 characters. Empty = keep the current one" autoComplete="new-password" />
              </label>
              {pw && (
                <label style={label}>Type the new password again
                  <PasswordInput value={pw2} onChange={setPw2} show={showNew} onToggle={() => setShowNew(!showNew)} autoComplete="new-password" />
                  {pw2 && pw2 !== pw && <span style={{ display: 'block', color: 'var(--danger, #ef4444)', fontWeight: 500, fontSize: '0.6875rem', marginTop: 3 }}>Not the same as above</span>}
                </label>
              )}
              {teamCount > 0 && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.75rem', margin: '0.25rem 0 0.75rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={signOutTeam} onChange={(e) => setSignOutTeam(e.target.checked)} style={{ marginTop: 2 }} />
                  <span><b>Also sign out the team</b> ({teamCount} member{teamCount === 1 ? '' : 's'})<span style={{ display: 'block', color: 'var(--fg-muted)', fontSize: '0.6875rem' }}>They sign in again with their own password.</span></span>
                </label>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.75rem', color: '#92400e', background: '#fff7e6', border: '1px solid #fde68a', borderRadius: 8, padding: '0.5rem 0.625rem', marginBottom: '0.75rem' }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>Write the new password down before saving.</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="submit" className="btn btn-primary" disabled={busy || !!problemNow} title={problemNow || ''}><Check size={14} /> Save new login</button>
              </div>
            </form>

            {/* Sign out everyone */}
            <div style={sectionTitle}>Sign out everyone</div>
            {owner?.savedInPanel ? (
              <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '0.625rem 0.75rem' }}>
                <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', margin: 0 }}>
                  Signs out every phone and computer right away: {teamCount ? `all ${teamCount} team member${teamCount === 1 ? '' : 's'} and ` : ''}every other device using your login. You stay signed in here. Nobody&apos;s password changes.
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: '0.625rem' }}>
                  {confirmAll ? (
                    <>
                      <button type="button" className="btn btn-sm" style={muted} onClick={() => setConfirmAll(false)} disabled={busy}>Cancel</button>
                      <button type="button" className="btn btn-sm" onClick={signOutEveryone} disabled={busy} style={{ background: 'var(--danger, #ef4444)', color: '#fff' }}>
                        <LogOut size={13} /> Yes, sign out everyone
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-sm" style={{ ...muted, color: 'var(--danger, #ef4444)', borderColor: 'var(--danger, #ef4444)' }} onClick={() => setConfirmAll(true)} disabled={busy}>
                      <LogOut size={13} /> Sign out everyone
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', margin: 0 }}>
                Available once you change your login above. Changing it already signs out everyone using the old one.
              </p>
            )}

            {/* Forgot it */}
            <details style={{ marginTop: '1rem', fontSize: '0.75rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--fg-muted)' }}>Forgot your password?</summary>
              <p style={{ color: 'var(--fg-muted)', margin: '0.5rem 0' }}>
                On your Mac, open Terminal and run this. It shows a new password once (only on your screen) and signs out every device using your login. Sign in with it, then set your own here.
              </p>
              <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                <code style={{ flex: 1, minWidth: 0, fontSize: '0.6875rem', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.375rem 0.5rem', wordBreak: 'break-all' }}>{RESET_COMMAND}</code>
                <button type="button" className="btn btn-sm" style={muted} onClick={() => copyText(RESET_COMMAND, () => setResetCopied(true))}>
                  {resetCopied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                </button>
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
