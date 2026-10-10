'use client';

// ── Settings > All panels setup (owner 2026-10-10, step 7: "ek jagah badlo to sab panels par lage; naya panel bane to
// sab apne aap"), Super Admin only ──
// One Chikki setup for every panel: the prompt, the saved answers and the effort levels, with {brand} where each
// panel's own name goes. Made once from a panel that is set up (Preview, then Make), then each panel is switched to it.
// While a panel uses it, editing Chikki on that panel changes the common setup (every such panel). A new panel with no
// prompt of its own uses it by itself. Nothing is deleted: a panel's own setup comes back with Own.
// Server: /api/panel-setup, src/lib/chat/common-setup*.ts.
import { useCallback, useEffect, useState } from 'react';
import { Eye, Layers, Loader2, Sparkles } from 'lucide-react';

interface Panel { businessId: string; name: string; brand: string; mode: 'common' | 'own'; saved: string | null; ownPromptChars: number; ownAnswers: number }
interface Overview { common: { ready: boolean; from: string | null; at: string | null; by: string | null; promptChars: number; effort: boolean; answers: number }; panels: Panel[] }
interface Plan { source: { name: string }; prompt: { chars: number; hits: number; replaces: boolean }; answers: { add: number; skip: number; hits: number }; effort: boolean }

export default function CommonSetupCard({ token, onAlert }: { token: string; onAlert: (type: string, message: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [source, setSource] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState('');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/panel-setup', { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (r.ok) setData(j);
    } catch { /* keep */ }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const post = async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag);
    try {
      const r = await fetch('/api/panel-setup', { method: 'POST', headers, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', j.error || 'Could not save'); return null; }
      return j;
    } catch { onAlert('error', 'Could not reach the server.'); return null; }
    finally { setBusy(''); }
  };

  const preview = async () => { const j = await post({ action: 'make', businessId: source, dryRun: true }, 'preview'); if (j) setPlan(j.plan); };
  const make = async () => {
    const j = await post({ action: 'make', businessId: source }, 'make');
    if (j) { onAlert('success', `All panels setup made from ${j.plan.source.name}: ${j.plan.answers.add} saved answers added.`); setPlan(null); load(); }
  };
  const switchMode = async (p: Panel, mode: 'common' | 'own') => {
    if (mode === p.mode) return;
    const ask = mode === 'common'
      ? `${p.name}: Chikki will use the All panels setup from now on (its own prompt and answers stay saved). Continue?`
      : `${p.name}: Chikki goes back to this panel's own prompt and answers. Continue?`;
    if (!window.confirm(ask)) return;
    const j = await post({ action: 'mode', businessId: p.businessId, mode }, 'mode:' + p.businessId);
    if (j) { onAlert('success', `${p.name} now uses ${mode === 'common' ? 'the All panels setup' : 'its own setup'}.`); load(); }
  };

  const c = data?.common;
  return (
    <div className="tf-card" style={{ padding: '1.5rem' }}>
      <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}><Layers size={16} /> All panels setup</h3>
      <p style={{ fontSize: '0.8125rem', color: 'var(--fg-muted)', marginBottom: 12 }}>
        One Chikki for every panel: the prompt, the saved answers and the effort levels live in one place. Change them on any panel that uses
        it and every such panel changes. <b>{'{brand}'}</b> becomes each panel&apos;s own name. Cash on Delivery and the courier stay per panel.
        A new panel uses it by itself.
      </p>

      {!data ? <div className="meta"><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Loading…</div> : (
        <>
          <div className="cs-state">
            {c?.ready
              ? <>Made from <b>{c.from}</b>{c.at ? ` on ${new Date(c.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}` : ''} · prompt {c.promptChars.toLocaleString('en-IN')} characters · {c.answers} saved answers{c.effort ? ' · effort levels' : ''}</>
              : <>Not made yet. Make it from the panel whose Chikki is set up best (usually vastora).</>}
          </div>

          <div className="cs-make">
            <select className="form-input" value={source} onChange={(e) => { setSource(e.target.value); setPlan(null); }}>
              <option value="">{c?.ready ? 'Make again from…' : 'Make it from…'}</option>
              {data.panels.filter((p) => p.ownPromptChars > 0).map((p) => <option key={p.businessId} value={p.businessId}>{p.name}</option>)}
            </select>
            <button type="button" className="btn btn-outline btn-sm" disabled={!source || !!busy} onClick={preview}>
              {busy === 'preview' ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Eye size={14} />} Preview
            </button>
          </div>
          {plan && (
            <div className="cs-plan">
              <div>From <b>{plan.source.name}</b>:</div>
              <ul>
                <li>Prompt: {plan.prompt.chars.toLocaleString('en-IN')} characters, the name replaced by {'{brand}'} {plan.prompt.hits} times{plan.prompt.replaces ? ' (replaces the current All panels prompt; the old one is kept as a backup)' : ''}.</li>
                <li>Saved answers: {plan.answers.add} added{plan.answers.skip ? `, ${plan.answers.skip} already there` : ''}.</li>
                <li>Effort levels: {plan.effort ? 'copied' : 'the panel has none saved (defaults)'}.</li>
                <li>No panel changes until you switch it below.</li>
              </ul>
              <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={make}>
                {busy === 'make' ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Sparkles size={14} />} Make All panels setup
              </button>
            </div>
          )}

          <div className="cs-panels">
            {data.panels.map((p) => (
              <div key={p.businessId} className="cs-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{p.name}</b>
                  <div className="meta">Chikki says &ldquo;{p.brand || p.name}&rdquo; · own prompt {p.ownPromptChars ? `${p.ownPromptChars.toLocaleString('en-IN')} characters` : 'none'} · {p.ownAnswers} own answers{!p.saved && p.mode === 'common' ? ' · uses All panels by itself (no prompt of its own)' : ''}</div>
                </div>
                <div className="seg" role="group" aria-label={`Setup for ${p.name}`}>
                  <button type="button" className="seg-btn" aria-pressed={p.mode === 'common'} disabled={!c?.ready || !!busy} onClick={() => switchMode(p, 'common')}>All panels</button>
                  <button type="button" className="seg-btn" aria-pressed={p.mode === 'own'} disabled={!!busy} onClick={() => switchMode(p, 'own')}>Own</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
