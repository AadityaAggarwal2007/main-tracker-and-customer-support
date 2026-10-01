'use client';

import { useMemo, useState } from 'react';

// Saved Answers in Panel Settings: the same data and the same saving as before (the admin page
// keeps faqRequest / addFaq and /api/panel-faq); this is only the layout: search, a size meter,
// the add form on top, turned-off answers apart, a long list folded.

interface Faq { id: string; question: string; answer: string; is_enabled: boolean }

// Keep in step with FAQ_CHAR_BUDGET in src/lib/chat/ai.ts.
const BUDGET = 12000;
const FOLD = 12;

export default function SavedAnswersCard({ faqs, busy, businessId, request, draft, setDraft, onAdd }: {
  faqs: Faq[];
  busy: boolean;
  businessId: string | null;
  request: (method: string, body?: unknown, qs?: string) => Promise<boolean>;
  draft: { question: string; answer: string };
  setDraft: (d: { question: string; answer: string }) => void;
  onAdd: () => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showOff, setShowOff] = useState(false);

  const on = faqs.filter((f) => f.is_enabled);
  const off = faqs.filter((f) => !f.is_enabled);
  const used = on.reduce((n, f) => n + f.question.length + f.answer.length + 8, 0);
  const pct = Math.min(100, Math.round((used / BUDGET) * 100));
  const needle = q.trim().toLowerCase();
  const match = (f: Faq) => !needle || f.question.toLowerCase().includes(needle) || f.answer.toLowerCase().includes(needle);
  const list = useMemo(() => on.filter(match), [on, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = needle || showAll ? list : list.slice(0, FOLD);
  const muted = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' };

  const item = (f: Faq, n: number) => (
    <div key={f.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.625rem 0.75rem', opacity: f.is_enabled ? 1 : 0.55 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', minWidth: 18, paddingTop: 10 }}>{n}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            className="form-input"
            style={{ fontWeight: 600, marginBottom: '0.375rem' }}
            defaultValue={f.question}
            aria-label="Question"
            onBlur={(e) => { if (e.target.value.trim() !== f.question) request('PATCH', { businessId, id: f.id, question: e.target.value }); }}
          />
          <textarea
            className="form-input"
            rows={Math.min(6, Math.max(2, Math.ceil(f.answer.length / 90)))}
            defaultValue={f.answer}
            aria-label="Answer"
            onBlur={(e) => { if (e.target.value.trim() !== f.answer) request('PATCH', { businessId, id: f.id, answer: e.target.value }); }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem', alignItems: 'center' }}>
            <button className="btn btn-sm" disabled={busy} style={muted}
              onClick={() => request('PATCH', { businessId, id: f.id, isEnabled: !f.is_enabled })}>
              {f.is_enabled ? 'Turn off' : 'Turn on'}
            </button>
            <button className="btn btn-sm" disabled={busy} style={{ ...muted, color: 'var(--danger, #ef4444)' }}
              onClick={() => { if (confirm('Delete this saved answer?')) request('DELETE', undefined, `?businessId=${businessId}&id=${f.id}`); }}>
              Delete
            </button>
            <span style={{ marginLeft: 'auto', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>Changes save when you click outside the box</span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="form-group">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <label className="form-label" style={{ marginBottom: 0 }}>💬 Saved Answers</label>
        <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{on.length} on{off.length ? ` · ${off.length} off` : ''}</span>
      </div>
      <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', margin: '0.25rem 0 0.5rem' }}>
        A fixed reply for one question. The agent gives your wording, also when the customer asks it differently or in
        Hindi. Edits apply to the very next message.
      </div>

      {/* How much of the agent's space the answers take */}
      <div style={{ marginBottom: '0.625rem' }} title="Past this the agent still gets every answer that fits, the ones closest to the customer's question first">
        <div style={{ height: 6, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? '#f59e0b' : 'var(--primary)' }} />
        </div>
        <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: 3 }}>
          {used.toLocaleString()} of {BUDGET.toLocaleString()} characters
          {pct >= 100 ? ' · full: the agent now picks the answers closest to each question, none is lost' : ''}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.625rem', flexWrap: 'wrap' }}>
        <input className="form-input" style={{ flex: 1, minWidth: 180 }} type="search" placeholder="Search saved answers" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search saved answers" />
        {!adding && <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>+ Add saved answer</button>}
      </div>

      {adding && (
        <div style={{ border: '1px dashed var(--primary)', borderRadius: 8, padding: '0.75rem', marginBottom: '0.75rem' }}>
          <input className="form-input" style={{ marginBottom: '0.375rem' }}
            placeholder="Question — e.g. Jhumka box ke saath earrings aayenge?"
            value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} autoFocus />
          <textarea className="form-input" rows={3}
            placeholder="Answer — exactly what the agent should say"
            value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem' }}>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={async () => { await onAdd(); }}>Save answer</button>
            <button className="btn btn-sm" style={muted} onClick={() => setAdding(false)}>Close</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {visible.map((f) => item(f, on.indexOf(f) + 1))}
        {needle && !list.length && <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>No saved answer matches “{q}”.</div>}
        {!needle && !faqs.length && <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>No saved answers yet.</div>}
      </div>
      {!needle && list.length > FOLD && (
        <button type="button" onClick={() => setShowAll(!showAll)} style={{ ...muted, border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '0.75rem', marginTop: '0.5rem', padding: 0 }}>
          {showAll ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}

      {off.filter(match).length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <button type="button" onClick={() => setShowOff(!showOff)} style={{ border: 'none', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer', fontSize: '0.75rem', padding: 0 }}>
            {showOff ? '▾' : '▸'} Turned off ({off.filter(match).length}): the agent does not use these
          </button>
          {showOff && <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>{off.filter(match).map((f, i) => item(f, i + 1))}</div>}
        </div>
      )}
    </div>
  );
}
