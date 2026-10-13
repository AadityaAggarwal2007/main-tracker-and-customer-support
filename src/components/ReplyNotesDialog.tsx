'use client';

// Saved replies, "Notes" (owner 2026-10-13: "note press karta hi window open ho jaee aur staff waha sa copy karka fatafat
// logo ko bhej saka ... hello aur vastora team yeh sab prebuild"). One window for the Mail tab and Chat Support: the
// panel's notes by segment (Cancel, Refund, Ship again, ...), each shown already filled for THIS customer (name, order,
// tracking link) with "Hello <name>," and "Regards, <Brand> Team" around it; Use puts it in the reply box, Copy on the
// clipboard. Anyone who replies saves a note; the writer, the Manager or the Super Admin change it. Nothing is sent.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, CornerDownLeft, Loader2, NotebookPen, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { NOTE_BODY_MAX, NOTE_SEGMENTS, NOTE_STARTERS, NOTE_TITLE_MAX, fillNote, segmentLabel, type NoteSegment, type ReplyNote } from '@/lib/chat/reply-notes-rules';
import { getReplyWrap, setReplyWrap } from './replyWrap';

export interface NoteContext { name?: string | null; order?: string | null; tracking?: string | null }
type Form = { id: string | null; segment: NoteSegment; title: string; body: string };
const HOLES = ['{name}', '{order}', '{tracking}', '{brand}'];

export default function ReplyNotesDialog({ panelId, token, ctx, onUse, useBlocked, onClose }: {
  panelId: string | null; token: string; ctx: NoteContext;
  onUse?: (text: string) => void; useBlocked?: string; onClose: () => void;
}) {
  const [notes, setNotes] = useState<ReplyNote[]>([]);
  const [brand, setBrand] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [seg, setSeg] = useState<NoteSegment | 'all'>('all');
  const [q, setQ] = useState('');
  const [wrap, setWrap] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  useEffect(() => { setWrap(getReplyWrap()); }, []);
  const load = useCallback(async () => {
    if (!panelId) { setLoading(false); setError('Pick a panel first.'); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/reply-notes?panel=${encodeURIComponent(panelId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not read the notes'); return; }
      setNotes(data.notes || []); setBrand(data.brand || ''); setError('');
    } catch { setError('Could not read the notes'); } finally { setLoading(false); }
  }, [panelId, token]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { if (form) setForm(null); else onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, form, onClose]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of notes) c[n.segment] = (c[n.segment] || 0) + 1;
    return c;
  }, [notes]);
  const needle = q.trim().toLowerCase();
  const shown = notes.filter(n => (seg === 'all' || n.segment === seg) && (!needle || `${n.title} ${n.body}`.toLowerCase().includes(needle)));
  // A segment without a note of the panel shows the starters for it (safe texts the team can save as their own).
  const starters = !needle && !shown.length ? NOTE_STARTERS.filter(s => seg === 'all' || s.segment === seg) : [];
  const fill = (body: string) => fillNote(body, { ...ctx, brand }, wrap);

  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(c => (c === key ? '' : c)), 1500); }
    catch { setError('The browser did not allow copying: select the text and copy it.'); }
  };
  const save = async () => {
    if (!form || !panelId) return;
    setBusy(true);
    try {
      const res = await fetch('/api/reply-notes', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ panel: panelId, id: form.id || undefined, segment: form.segment, title: form.title, body: form.body }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not save'); return; }
      setForm(null); setError(''); setSeg(form.segment); await load();
    } catch { setError('Could not save'); } finally { setBusy(false); }
  };
  const remove = async (n: ReplyNote) => {
    if (!panelId || !window.confirm(`Delete the note "${n.title}"?`)) return;
    setBusy(true);
    try {
      const res = await fetch('/api/reply-notes', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ panel: panelId, id: n.id, remove: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not delete'); return; }
      await load();
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal rn-modal" role="dialog" aria-modal="true" aria-labelledby="rn-title" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title" id="rn-title"><NotebookPen size={16} /> Notes{brand ? ` · ${brand}` : ''}</div>
            <p className="modal-subtitle">Saved replies of this panel, filled in for this customer. Use or Copy, then Send.</p>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close" disabled={busy}><X size={16} /></button>
        </div>

        {form ? (
          <form className="rn-form" onSubmit={e => { e.preventDefault(); if (!busy) save(); }}>
            <label>Segment
              <select className="form-input" value={form.segment} onChange={e => setForm({ ...form, segment: e.target.value as NoteSegment })}>
                {NOTE_SEGMENTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            <label>Name of the note
              <input className="form-input" value={form.title} maxLength={NOTE_TITLE_MAX} autoFocus placeholder="e.g. Cancel before dispatch"
                onChange={e => setForm({ ...form, title: e.target.value })} />
            </label>
            <label>Reply (without Hello / Regards: they are added by themselves)
              <textarea className="form-input" rows={7} value={form.body} maxLength={NOTE_BODY_MAX}
                placeholder="Your order {order} has been cancelled. ..." onChange={e => setForm({ ...form, body: e.target.value })} />
            </label>
            <div className="rn-holes">
              <span className="meta">Fill in by itself:</span>
              {HOLES.map(h => (
                <button key={h} type="button" className="chip chip-muted" onClick={() => setForm({ ...form, body: `${form.body}${form.body && !form.body.endsWith(' ') ? ' ' : ''}${h}` })}>{h}</button>
              ))}
            </div>
            {form.body.trim() && <div className="rn-preview"><span className="meta">Preview</span><pre>{fill(form.body)}</pre></div>}
            {error && <p role="alert" className="rn-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => { setForm(null); setError(''); }} disabled={busy}>Back</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !form.title.trim() || !form.body.trim()}>
                {busy ? <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Check size={14} />} Save note
              </button>
            </div>
          </form>
        ) : (
          <div className="rn-body">
            <nav className="rn-segs" aria-label="Segments">
              <button type="button" className={`rn-seg ${seg === 'all' ? 'active' : ''}`} onClick={() => setSeg('all')}>All <span>{notes.length}</span></button>
              {NOTE_SEGMENTS.map(s => (
                <button key={s.key} type="button" className={`rn-seg ${seg === s.key ? 'active' : ''}`} onClick={() => setSeg(s.key)}>
                  {s.label} <span>{counts[s.key] || 0}</span>
                </button>
              ))}
            </nav>
            <div className="rn-main">
              <div className="rn-tools">
                <span className="rn-search"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search notes" aria-label="Search notes" /></span>
                <label className="rn-wrap"><input type="checkbox" checked={wrap} onChange={e => { setWrap(e.target.checked); setReplyWrap(e.target.checked); }} /> Hello / Regards</label>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => { setError(''); setForm({ id: null, segment: seg === 'all' ? 'other' : seg, title: '', body: '' }); }}>
                  <Plus size={14} /> New note
                </button>
              </div>
              {error && <p role="alert" className="rn-error">{error}</p>}
              {useBlocked && onUse && <p className="meta">{useBlocked}</p>}
              {loading ? <p className="meta"><Loader2 size={13} style={{ animation: 'spin 0.6s linear infinite' }} /> Loading…</p> : (
                <div className="rn-list">
                  {shown.map(n => {
                    const text = fill(n.body);
                    return (
                      <article key={n.id} className="rn-card">
                        <header>
                          <strong>{n.title}</strong>
                          {seg === 'all' && <span className="chip chip-muted">{segmentLabel(n.segment)}</span>}
                          <span className="meta">by {n.byName || 'team'}</span>
                        </header>
                        <pre>{text}</pre>
                        <footer>
                          {onUse && <button type="button" className="btn btn-primary btn-sm" disabled={!!useBlocked} onClick={() => { onUse(text); onClose(); }}><CornerDownLeft size={13} /> Use</button>}
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => copy(n.id, text)}>{copied === n.id ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}</button>
                          {n.canEdit && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setError(''); setForm({ id: n.id, segment: n.segment, title: n.title, body: n.body }); }}><Pencil size={13} /> Edit</button>}
                          {n.canEdit && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(n)} aria-label={`Delete ${n.title}`}><Trash2 size={13} /></button>}
                        </footer>
                      </article>
                    );
                  })}
                  {!shown.length && needle && <p className="meta">No note matches “{q}”.</p>}
                  {starters.length > 0 && <p className="meta">No notes here yet. Starters you can use or save as your own:</p>}
                  {starters.map((s, i) => {
                    const text = fill(s.body);
                    return (
                      <article key={`s${i}`} className="rn-card rn-starter">
                        <header><strong>{s.title}</strong><span className="chip chip-muted">Starter · {segmentLabel(s.segment)}</span></header>
                        <pre>{text}</pre>
                        <footer>
                          {onUse && <button type="button" className="btn btn-primary btn-sm" disabled={!!useBlocked} onClick={() => { onUse(text); onClose(); }}><CornerDownLeft size={13} /> Use</button>}
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => copy(`s${i}`, text)}>{copied === `s${i}` ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm({ id: null, segment: s.segment, title: s.title, body: s.body })}><Plus size={13} /> Save as our note</button>
                        </footer>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
