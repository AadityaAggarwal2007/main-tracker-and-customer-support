'use client';

import { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';

// A new panel: the Super Admin types the panel name AND their own password (owner 2026-10-08: "sirf super
// admin hi new panel bana paye aur woh bhi password ke saath"). The server checks both; the password is
// never kept. onCreate answers null on success or the error text.
// "Start from" (owner 2026-10-08): the new panel gets the same AI setup as a panel already done (panel-copy.ts).
export default function NewPanelDialog({ onClose, onCreate, panels }: {
  onClose: () => void;
  onCreate: (name: string, password: string, startFrom: string) => Promise<string | null>;
  panels: { id: string; name: string }[];
}) {
  const [startFrom, setStartFrom] = useState(panels[0]?.id || '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    const err = await onCreate(name, password, startFrom);
    setBusy(false);
    if (err) setError(err); else onClose();
  };
  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onClose(); }}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} autoComplete="off">
        <div className="modal-header"><h3 className="modal-title">New panel</h3></div>
        <div className="space-y-4">
          <div className="form-group">
            <label className="form-label">Panel name</label>
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Store Name" />
          </div>
          {panels.length > 0 && (
            <div className="form-group">
              <label className="form-label">Start from</label>
              <select className="form-input" value={startFrom} onChange={(e) => setStartFrom(e.target.value)}>
                <option value="">Empty panel</option>
                {panels.map(p => <option key={p.id} value={p.id}>Same AI setup as {p.name}</option>)}
              </select>
            </div>
          )}
          <div className="form-group">
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ShieldCheck size={13} /> Your Super Admin password</label>
            <input className="form-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="Type it again to confirm" />
          </div>
          {error && <p role="alert" style={{ fontSize: '0.8125rem', color: 'var(--danger)', fontWeight: 600 }}>{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !password}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : null} Create panel
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
