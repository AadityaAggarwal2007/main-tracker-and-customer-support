'use client';

import { useCallback, useEffect, useState } from 'react';

// The Brain card in Panel Settings (src/app/api/panel-brain, src/lib/chat/brain.ts): the
// notes the support agent reads. Anyone on the panel can read them; only an admin can
// change them. The locked rules are shown for reference and cannot be edited here.

interface Note {
  id: string; site_id: string | null; kind: 'rule' | 'fact' | 'lesson'; title: string; body: string;
  topics: string[]; always: boolean; audience: 'all' | 'verified' | 'visitor'; shown_count: number; last_shown_at: string | null;
  is_enabled: boolean; source: string;
}
interface Topic { key: string; label: string }

interface Suggestion { id: string; kind: Note['kind']; title: string; body: string; topics: string[]; why: string | null; conversation_id: string | null }

const KIND_LABEL: Record<string, string> = { rule: 'Rule', fact: 'Fact', lesson: 'Lesson' };
const AUDIENCE_LABEL: Record<string, string> = { all: 'Everyone', verified: 'Verified customers only', visitor: 'Visitors only' };
const EMPTY = { kind: 'lesson' as Note['kind'], title: '', body: '', topics: [] as string[], always: false, common: false, audience: 'all' as Note['audience'] };

export default function BrainCard({ token, businessId, onAlert }: {
  token: string | null; businessId: string | null; onAlert: (type: string, message: string) => void;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [locked, setLocked] = useState<string[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [canEditCommon, setCanEditCommon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const [showLocked, setShowLocked] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ title: '', body: '', topics: [] as string[], always: false, kind: 'lesson' as Note['kind'], audience: 'all' as Note['audience'] });

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [sugEdit, setSugEdit] = useState<Record<string, { title: string; body: string; topics: string[] }>>({});

  const loadSuggestions = useCallback(async () => {
    if (!token || !businessId) { setSuggestions([]); return; }
    try {
      const r = await fetch(`/api/panel-brain/suggestions?businessId=${businessId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setSuggestions((await r.json()).suggestions || []);
    } catch { /* keep what is on screen */ }
  }, [token, businessId]);

  const load = useCallback(async () => {
    if (!token || !businessId) { setNotes([]); return; }
    try {
      const r = await fetch(`/api/panel-brain?businessId=${businessId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const d = await r.json();
      setNotes(d.notes || []); setTopics(d.topics || []); setLocked(d.locked || []);
      setCanEdit(!!d.canEdit); setCanEditCommon(!!d.canEditCommon);
    } catch { /* keep what is on screen */ }
  }, [token, businessId]);
  useEffect(() => { load(); loadSuggestions(); }, [load, loadSuggestions]);

  const decide = async (sg: Suggestion, action: 'approve' | 'reject') => {
    setBusy(true);
    try {
      const e = sugEdit[sg.id];
      const r = await fetch('/api/panel-brain/suggestions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ businessId, id: sg.id, action, ...(action === 'approve' && e ? e : {}) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'Could not save'); return; }
      onAlert('success', action === 'approve' ? 'Added to the Brain' : 'Rejected');
      await Promise.all([load(), loadSuggestions()]);
    } catch { onAlert('error', 'Could not save'); }
    finally { setBusy(false); }
  };

  const call = async (method: string, body?: unknown, qs = '') => {
    setBusy(true);
    try {
      const r = await fetch(`/api/panel-brain${qs}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'Could not save'); return false; }
      await load();
      return true;
    } catch { onAlert('error', 'Could not save'); return false; }
    finally { setBusy(false); }
  };

  const toggleTopic = (list: string[], key: string) => (list.includes(key) ? list.filter((t) => t !== key) : [...list, key]);
  const topicLabel = (k: string) => topics.find((t) => t.key === k)?.label || k;

  const add = async () => {
    if (!draft.title.trim() || !draft.body.trim()) { onAlert('error', 'Write a title and the note'); return; }
    if (!draft.always && !draft.topics.length) { onAlert('error', 'Pick at least one topic, or tick "Always show"'); return; }
    if (await call('POST', { businessId, scope: draft.common ? 'common' : 'panel', ...draft })) {
      setDraft(EMPTY); onAlert('success', 'Saved: the agent reads it from the next message');
    }
  };

  const saveEdit = async (n: Note) => {
    if (!edit.title.trim() || !edit.body.trim()) { onAlert('error', 'Write a title and the note'); return; }
    if (!edit.always && !edit.topics.length) { onAlert('error', 'Pick at least one topic, or tick "Always show"'); return; }
    if (await call('PATCH', { businessId, id: n.id, ...edit })) { setEditing(null); onAlert('success', 'Saved'); }
  };

  const editable = (n: Note) => canEdit && (n.site_id !== null || canEditCommon);
  const chip = (text: string, on = false) => (
    <span key={text} style={{ fontSize: '0.6875rem', padding: '0.0625rem 0.5rem', borderRadius: 999, border: '1px solid var(--border)', background: on ? 'var(--primary-light)' : 'transparent', color: on ? 'var(--primary)' : 'var(--fg-muted)' }}>{text}</span>
  );

  const topicPicker = (value: string[], set: (v: string[]) => void, always: boolean, setAlways: (v: boolean) => void) => (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '0.375rem 0' }}>
      {topics.map((t) => (
        <button key={t.key} type="button" disabled={always} onClick={() => set(toggleTopic(value, t.key))}
          style={{ fontSize: '0.75rem', padding: '0.125rem 0.625rem', borderRadius: 999, cursor: 'pointer', opacity: always ? 0.4 : 1,
            border: `1px solid ${value.includes(t.key) ? 'var(--primary)' : 'var(--border)'}`,
            background: value.includes(t.key) ? 'var(--primary-light)' : 'transparent', color: value.includes(t.key) ? 'var(--primary)' : 'var(--fg-muted)' }}>
          {t.label}
        </button>
      ))}
      <label style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} /> Always show
      </label>
    </div>
  );

  const audiencePicker = (value: Note['audience'], set: (v: Note['audience']) => void) => (
    <select className="form-input" style={{ width: 'auto', fontSize: '0.75rem', marginBottom: '0.375rem' }} value={value} onChange={(e) => set(e.target.value as Note['audience'])} aria-label="Who is this note for">
      {Object.entries(AUDIENCE_LABEL).map(([k, label]) => <option key={k} value={k}>For: {label}</option>)}
    </select>
  );

  const group = (title: string, list: Note[]) => list.length > 0 && (
    <div style={{ marginBottom: '0.75rem' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--fg-muted)', marginBottom: '0.375rem' }}>{title} ({list.length})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {list.map((n) => (
          <div key={n.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.625rem 0.75rem', opacity: n.is_enabled ? 1 : 0.5 }}>
            {editing === n.id ? (
              <>
                <input className="form-input" style={{ fontWeight: 600, marginBottom: '0.375rem' }} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} maxLength={120} />
                <textarea className="form-input" rows={3} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} maxLength={900} />
                {topicPicker(edit.topics, (v) => setEdit({ ...edit, topics: v }), edit.always, (v) => setEdit({ ...edit, always: v }))}
                {audiencePicker(edit.audience, (v) => setEdit({ ...edit, audience: v }))}
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => saveEdit(n)}>Save</button>
                  <button className="btn btn-sm" onClick={() => setEditing(null)} style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' }}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>{n.title}</span>
                  {chip(KIND_LABEL[n.kind] || n.kind, true)}
                  {n.always ? chip('Always') : n.topics.map((t) => chip(topicLabel(t)))}
                  {n.audience !== 'all' && chip(AUDIENCE_LABEL[n.audience])}
                  {n.source !== 'owner' && chip(n.source === 'seed' ? 'Starter' : n.source)}
                  <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginLeft: 'auto' }} title={n.last_shown_at ? `Last shown ${new Date(n.last_shown_at).toLocaleString()}` : 'Not shown yet'}>
                    {n.shown_count > 0 ? `Shown ${n.shown_count}×` : 'Not shown yet'}
                  </span>
                </div>
                <div style={{ fontSize: '0.8125rem', whiteSpace: 'pre-wrap' }}>{n.body}</div>
                {editable(n) && (
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem' }}>
                    <button className="btn btn-sm" disabled={busy} onClick={() => { setEditing(n.id); setEdit({ title: n.title, body: n.body, topics: n.topics, always: n.always, kind: n.kind, audience: n.audience || 'all' }); }}
                      style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' }}>Edit</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => call('PATCH', { businessId, id: n.id, isEnabled: !n.is_enabled })}
                      style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' }}>{n.is_enabled ? 'Turn off' : 'Turn on'}</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => { if (confirm('Delete this note?')) call('DELETE', undefined, `?businessId=${businessId}&id=${n.id}`); }}
                      style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger, #ef4444)' }}>Delete</button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="form-group">
      <label className="form-label">🧠 Brain ({notes.length})</label>
      <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
        What the agent has learned about your store and about real chats. On every message it reads only the
        notes that fit what the customer wrote (plus the ones marked Always). Edits apply to the very next
        message. {canEdit ? '' : 'Only an admin can change these.'}
      </div>

      {suggestions.length > 0 && (
        <div style={{ marginBottom: '0.75rem', border: '1px solid var(--primary)', borderRadius: 8, padding: '0.625rem 0.75rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--primary)', marginBottom: '0.25rem' }}>
            Suggested from real chats ({suggestions.length})
          </div>
          <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
            The system read chats your team answered and drafted these. The agent does NOT use them until you approve. Change the wording first if you like.
          </div>
          {suggestions.map((sg) => {
            const e = sugEdit[sg.id] || { title: sg.title, body: sg.body, topics: sg.topics };
            return (
              <div key={sg.id} style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', marginTop: '0.5rem' }}>
                <input className="form-input" style={{ fontWeight: 600, marginBottom: '0.375rem' }} value={e.title} disabled={!canEdit} maxLength={120}
                  onChange={(ev) => setSugEdit({ ...sugEdit, [sg.id]: { ...e, title: ev.target.value } })} />
                <textarea className="form-input" rows={3} value={e.body} disabled={!canEdit} maxLength={900}
                  onChange={(ev) => setSugEdit({ ...sugEdit, [sg.id]: { ...e, body: ev.target.value } })} />
                {topicPicker(e.topics, (v) => setSugEdit({ ...sugEdit, [sg.id]: { ...e, topics: v } }), false, () => {})}
                {sg.why && <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginBottom: '0.375rem' }}>Why: {sg.why}</div>}
                {canEdit && (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => decide(sg, 'approve')}>Approve: add to the Brain</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => decide(sg, 'reject')}
                      style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' }}>Reject</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {group('For this panel', notes.filter((n) => n.site_id !== null))}
      {group('For every panel', notes.filter((n) => n.site_id === null))}

      {canEdit && (
        <div style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: '0.75rem', marginBottom: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem' }}>
            <select className="form-input" style={{ width: 'auto' }} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Note['kind'] })}>
              <option value="lesson">Lesson (learned from a chat)</option>
              <option value="rule">Rule (how to act)</option>
              <option value="fact">Fact (true about the store)</option>
            </select>
            <input className="form-input" placeholder="Title, e.g. Delivery agent number" value={draft.title} maxLength={120} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </div>
          <textarea className="form-input" rows={3} placeholder="The note, in plain words: what the agent should know or do" value={draft.body} maxLength={900} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          {topicPicker(draft.topics, (v) => setDraft({ ...draft, topics: v }), draft.always, (v) => setDraft({ ...draft, always: v }))}
          {audiencePicker(draft.audience, (v) => setDraft({ ...draft, audience: v }))}
          {canEditCommon && (
            <label style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 4, marginBottom: '0.375rem' }}>
              <input type="checkbox" checked={draft.common} onChange={(e) => setDraft({ ...draft, common: e.target.checked })} /> For every panel (not only this one)
            </label>
          )}
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={add}>+ Add to the Brain</button>
        </div>
      )}

      <button type="button" onClick={() => setShowLocked(!showLocked)}
        style={{ border: 'none', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', fontSize: '0.75rem', padding: 0 }}>
        {showLocked ? 'Hide' : 'Show'} the locked rules ({locked.length}): they always win over a note and can only be changed in the code
      </button>
      {showLocked && (
        <div style={{ marginTop: '0.5rem', border: '1px solid var(--border)', borderRadius: 8, padding: '0.625rem 0.75rem', fontSize: '0.75rem', color: 'var(--fg-muted)', whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>
          {locked.join('\n\n')}
        </div>
      )}
    </div>
  );
}
