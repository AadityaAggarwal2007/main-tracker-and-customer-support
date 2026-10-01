'use client';

import { useCallback, useEffect, useState } from 'react';

// "How our team handles it" in Panel Settings (/api/panel-brain/examples, brain-examples.ts):
// real team replies to difficult customers after which the customer calmed down. The agent is
// shown 1-2 approved ones of the same situation as a guide to tone. Admins approve, edit, switch
// off, delete or write their own; everyone on the panel can read them.

interface Ex {
  id: string; situation: string; customer_said: string; team_replied: string; why: string | null;
  source: string; status: 'pending' | 'approved'; is_enabled: boolean; shown_count: number;
}
interface Situation { key: string; label: string }

const muted = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' };

export default function TeamExamplesCard({ token, businessId, canEdit, onAlert, onPending }: {
  token: string | null; businessId: string | null; canEdit: boolean; onAlert: (type: string, message: string) => void;
  onPending?: (n: number) => void;
}) {
  const [examples, setExamples] = useState<Ex[]>([]);
  const [situations, setSituations] = useState<Situation[]>([]);
  const [reviewed, setReviewed] = useState(0);
  const [filter, setFilter] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Record<string, { situation: string; customer_said: string; team_replied: string }>>({});
  const [draft, setDraft] = useState({ situation: 'refund_cancel', customer_said: '', team_replied: '' });
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!token || !businessId) { setExamples([]); return; }
    try {
      const r = await fetch(`/api/panel-brain/examples?businessId=${businessId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const d = await r.json();
      setExamples(d.examples || []); setSituations(d.situations || []); setReviewed(d.reviewed || 0);
      onPending?.((d.examples || []).filter((e: Ex) => e.status === 'pending').length);
    } catch { /* keep what is on screen */ }
  }, [token, businessId, onPending]);
  useEffect(() => { load(); }, [load]);

  const act = async (body: Record<string, unknown>, ok?: string) => {
    setBusy(true);
    try {
      const r = await fetch('/api/panel-brain/examples', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ businessId, ...body }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'Could not save'); return false; }
      if (ok) onAlert('success', ok);
      await load();
      return true;
    } catch { onAlert('error', 'Could not save'); return false; }
    finally { setBusy(false); }
  };

  const label = (k: string) => situations.find((s) => s.key === k)?.label || k;
  const pending = examples.filter((e) => e.status === 'pending');
  const approved = examples.filter((e) => e.status === 'approved');
  const shown = approved.filter((e) => !filter || e.situation === filter);
  const situationSelect = (value: string, set: (v: string) => void) => (
    <select className="form-input" style={{ width: 'auto', fontSize: '0.75rem', marginBottom: '0.375rem' }} value={value} disabled={!canEdit} onChange={(e) => set(e.target.value)} aria-label="Situation">
      {situations.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
    </select>
  );
  const box = { border: '1px solid var(--border)', borderRadius: 8, padding: '0.625rem 0.75rem' };
  const quote = (who: string, text: string, color: string) => (
    <div style={{ fontSize: '0.8125rem', marginBottom: 4 }}>
      <span style={{ fontWeight: 600, color }}>{who}: </span><span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
    </div>
  );

  return (
    <div className="form-group">
      <label className="form-label">🎓 How our team handles it ({approved.length})</label>
      <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
        Real replies from your team to difficult customers (refund, wrong tracking, late order, anger, fraud claims...)
        after which the customer calmed down. When a customer is in the same situation, the agent reads 1-2 of these
        and talks the same way. It copies the tone, never dates, amounts or promises. Learned from {reviewed} chats so far;
        new ones are read every few hours.
      </div>

      {pending.length > 0 && (
        <div style={{ ...box, borderColor: 'var(--primary)', marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--primary)', marginBottom: '0.25rem' }}>Waiting for your OK ({pending.length})</div>
          <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.375rem' }}>The agent does not use these until you approve. Fix the wording first if you like.</div>
          {pending.map((e) => {
            const v = edits[e.id] || { situation: e.situation, customer_said: e.customer_said, team_replied: e.team_replied };
            const set = (patch: Partial<typeof v>) => setEdits({ ...edits, [e.id]: { ...v, ...patch } });
            return (
              <div key={e.id} style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', marginTop: '0.5rem' }}>
                <div style={{ fontSize: '0.6875rem', marginBottom: 4, color: e.why && /calmly/.test(e.why) ? 'var(--success, #16a34a)' : '#b45309' }}>
                  {e.why && /calmly/.test(e.why) ? '✓ The customer replied calmly after this' : '? The customer did not write again after this: check that it really helped'}
                </div>
                {situationSelect(v.situation, (s) => set({ situation: s }))}
                <input className="form-input" style={{ marginBottom: '0.375rem' }} value={v.customer_said} disabled={!canEdit} maxLength={300} onChange={(ev) => set({ customer_said: ev.target.value })} aria-label="Customer said" />
                <textarea className="form-input" rows={3} value={v.team_replied} disabled={!canEdit} maxLength={900} onChange={(ev) => set({ team_replied: ev.target.value })} aria-label="Our team replied" />
                {canEdit && (
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem' }}>
                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act({ id: e.id, action: 'approve', ...v }, 'Approved: the agent will talk like this')}>Approve</button>
                    <button className="btn btn-sm" disabled={busy} style={muted} onClick={() => act({ id: e.id, action: 'reject' }, 'Rejected')}>Reject</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {approved.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: '0.5rem' }}>
          {[{ key: '', label: 'All' }, ...situations].map((s) => {
            const n = s.key ? approved.filter((e) => e.situation === s.key).length : approved.length;
            if (s.key && !n) return null;
            const on = filter === s.key;
            return (
              <button key={s.key || 'all'} type="button" onClick={() => setFilter(s.key)}
                style={{ fontSize: '0.75rem', padding: '0.125rem 0.625rem', borderRadius: 999, cursor: 'pointer', border: `1px solid ${on ? 'var(--primary)' : 'var(--border)'}`, background: on ? 'var(--primary-light)' : 'transparent', color: on ? 'var(--primary)' : 'var(--fg-muted)' }}>
                {s.label} ({n})
              </button>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
        {shown.map((e) => (
          <div key={e.id} style={{ ...box, opacity: e.is_enabled ? 1 : 0.5 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: '0.6875rem', padding: '0.0625rem 0.5rem', borderRadius: 999, background: 'var(--primary-light)', color: 'var(--primary)' }}>{label(e.situation)}</span>
              {e.source === 'owner' && <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>written by you</span>}
              {e.source === 'team_edit' && <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>from a team correction</span>}
              <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginLeft: 'auto' }}>{e.shown_count > 0 ? `Used ${e.shown_count}×` : 'Not used yet'}</span>
            </div>
            {quote('Customer', e.customer_said, 'var(--fg-muted)')}
            {quote('Our team', e.team_replied, 'var(--primary)')}
            {canEdit && (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem' }}>
                <button className="btn btn-sm" disabled={busy} style={muted} onClick={() => act({ id: e.id, action: 'toggle' })}>{e.is_enabled ? 'Turn off' : 'Turn on'}</button>
                <button className="btn btn-sm" disabled={busy} style={{ ...muted, color: 'var(--danger, #ef4444)' }} onClick={() => { if (confirm('Delete this example?')) act({ id: e.id, action: 'delete' }); }}>Delete</button>
              </div>
            )}
          </div>
        ))}
        {!approved.length && !pending.length && (
          <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Nothing yet. Examples appear here as your team handles difficult chats.</div>
        )}
      </div>

      {canEdit && (adding ? (
        <div style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: '0.75rem' }}>
          {situationSelect(draft.situation, (s) => setDraft({ ...draft, situation: s }))}
          <input className="form-input" style={{ marginBottom: '0.375rem' }} placeholder="What the customer says, e.g. Mujhe refund chahiye, order bahut late hai" value={draft.customer_said} maxLength={300} onChange={(e) => setDraft({ ...draft, customer_said: e.target.value })} />
          <textarea className="form-input" rows={3} placeholder="How our team answers: the tone and words you want. No dates, amounts or promises." value={draft.team_replied} maxLength={900} onChange={(e) => setDraft({ ...draft, team_replied: e.target.value })} />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem' }}>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={async () => { if (await act({ action: 'add', ...draft }, 'Added')) { setDraft({ ...draft, customer_said: '', team_replied: '' }); setAdding(false); } }}>Save example</button>
            <button className="btn btn-sm" style={muted} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn btn-sm" style={muted} onClick={() => setAdding(true)}>+ Write an example yourself</button>
      ))}
    </div>
  );
}
