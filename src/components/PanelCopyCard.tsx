'use client';

// ── Copy the AI setup from another panel (owner 2026-10-08), Super Admin only ───────────────────────
// "Jitna kaam Vastora par kiya utna hi dono par bhi": Chikki's own prompt, saved answers, Brain notes, the Cash on
// Delivery answer, the default courier and the effort levels, copied from a panel that is already set up. Preview
// first (nothing changes), then Copy. Nothing is deleted; what the panel already has is kept unless "replace" is
// ticked; the store name in the copied text becomes this panel's name. Server: src/lib/panel-copy*.ts.
import { useState } from 'react';
import { Copy, Eye, Loader2 } from 'lucide-react';

interface Res { applied: boolean; lines: string[]; nothingToDo: boolean; added: { answers: number; notes: number }; samples: { answers: string[]; notes: string[] } }
const PARTS: { key: string; label: string }[] = [
  { key: 'prompt', label: "Chikki's own prompt" }, { key: 'answers', label: 'Saved answers' }, { key: 'notes', label: 'Brain notes' },
  { key: 'cod', label: 'Cash on Delivery answer' }, { key: 'courier', label: 'Default courier' }, { key: 'effort', label: 'Effort levels' },
];

export default function PanelCopyCard({ token, businessId, panelName, others, onAlert }: {
  token: string; businessId: string; panelName: string; others: { id: string; name: string }[]; onAlert: (type: string, message: string) => void;
}) {
  const [source, setSource] = useState('');
  const [parts, setParts] = useState<Record<string, boolean>>({ prompt: true, answers: true, notes: true, cod: true, courier: true, effort: true });
  const [overwrite, setOverwrite] = useState(false);
  const [res, setRes] = useState<Res | null>(null);
  const [busy, setBusy] = useState('');
  const src = others.find(o => o.id === source);

  const call = async (dryRun: boolean) => {
    if (!source || busy) return;
    setBusy(dryRun ? 'preview' : 'copy');
    try {
      const r = await fetch('/api/panel-copy', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, target: businessId, parts, overwrite, dryRun }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not copy the setup.'); return; }
      setRes(j);
      if (!dryRun) onAlert('success', `Setup copied from ${src?.name || 'the other panel'}: ${j.added.answers} saved answers and ${j.added.notes} notes added.`);
    } catch { onAlert('error', 'Could not reach the server.'); }
    finally { setBusy(''); }
  };

  return (
    <div className="tf-card" style={{ padding: '1.5rem' }}>
      <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}><Copy size={16} /> Copy setup from another panel</h3>
      <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', marginBottom: 12 }}>
        Gives <b>{panelName}</b> the same AI setup as a panel that is already done. Nothing is deleted. Orders, chats, Gmail, WhatsApp number, logo and tracking domain are never touched.
      </p>
      <div className="form-group">
        <label className="form-label">Copy from</label>
        <select className="form-input" value={source} onChange={(e) => { setSource(e.target.value); setRes(null); }}>
          <option value="">Choose a panel…</option>
          {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', margin: '8px 0' }}>
        {PARTS.map(p => (
          <label key={p.key} style={{ fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={parts[p.key]} onChange={(e) => { setParts({ ...parts, [p.key]: e.target.checked }); setRes(null); }} /> {p.label}
          </label>
        ))}
      </div>
      <label style={{ fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <input type="checkbox" checked={overwrite} onChange={(e) => { setOverwrite(e.target.checked); setRes(null); }} />
        Replace what this panel already has (the old values are saved)
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-outline" onClick={() => call(true)} disabled={!source || !!busy}>
          {busy === 'preview' ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Eye size={14} />} Preview
        </button>
        <button className="btn btn-primary" onClick={() => call(false)} disabled={!source || !!busy || !res || res.applied || res.nothingToDo}>
          {busy === 'copy' ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Copy size={14} />} Copy now
        </button>
      </div>
      {res && (
        <div style={{ marginTop: 12, fontSize: '0.8125rem' }}>
          <b>{res.applied ? 'Done:' : 'This will happen:'}</b>
          <ul style={{ margin: '6px 0 0 18px', listStyle: 'disc' }}>{res.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          {res.samples.answers.length > 0 && <p style={{ marginTop: 6, color: 'var(--fg-muted)' }}>Saved answers, for example: {res.samples.answers.join(' · ')}</p>}
          {res.nothingToDo && <p style={{ marginTop: 6 }}>Nothing to copy: this panel already has everything.</p>}
        </div>
      )}
    </div>
  );
}
