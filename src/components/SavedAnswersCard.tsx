'use client';

import { useMemo, useState } from 'react';

// Saved Answers in Panel Settings: the same data and the same saving as before (the admin page
// keeps faqRequest / addFaq and /api/panel-faq); this is only the layout: search, a size meter,
// the add form on top, turned-off answers apart, a long list folded. Since 2026-10-01 it is the
// first tab of Chikki (ChikkiCard, `embedded`: no heading of its own).

interface Faq { id: string; question: string; answer: string; is_enabled: boolean }

// Keep in step with FAQ_CHAR_BUDGET in src/lib/chat/ai.ts.
const BUDGET = 25000;

export default function SavedAnswersCard({ faqs, busy, businessId, request, draft, setDraft, onAdd, embedded = false }: {
  faqs: Faq[];
  busy: boolean;
  businessId: string | null;
  request: (method: string, body?: unknown, qs?: string) => Promise<boolean>;
  draft: { question: string; answer: string };
  setDraft: (d: { question: string; answer: string }) => void;
  onAdd: () => Promise<void>;
  embedded?: boolean;
}) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const on = faqs.filter((f) => f.is_enabled);
  const off = faqs.filter((f) => !f.is_enabled);
  const used = on.reduce((n, f) => n + f.question.length + f.answer.length + 8, 0);
  const pct = Math.min(100, Math.round((used / BUDGET) * 100));
  const needle = q.trim().toLowerCase();
  const match = (f: Faq) => !needle || f.question.toLowerCase().includes(needle) || f.answer.toLowerCase().includes(needle);
  const list = useMemo(() => [...on.filter(match), ...off.filter(match)], [faqs, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const muted = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' };

  // One line per answer; click it to open the editor (only one open at a time).
  const item = (f: Faq) => {
    const n = f.is_enabled ? on.indexOf(f) + 1 : null;
    const isOpen = open === f.id;
    return (
      <div key={f.id} style={{ borderBottom: '1px solid var(--border)', opacity: f.is_enabled ? 1 : 0.55, background: isOpen ? 'var(--primary-light)' : 'transparent' }}>
        <button type="button" onClick={() => setOpen(isOpen ? null : f.id)} aria-expanded={isOpen}
          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '0.5rem 0.75rem', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', color: 'var(--fg)' }}>
          <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', minWidth: 22 }}>{n ?? 'off'}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 600, fontSize: '0.8125rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.question}</span>
            {!isOpen && <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.answer}</span>}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{isOpen ? '▴' : '▾'}</span>
        </button>
        {isOpen && (
          <div style={{ padding: '0 0.75rem 0.75rem 2.6rem' }}>
            <input
              className="form-input"
              style={{ fontWeight: 600, marginBottom: '0.375rem' }}
              defaultValue={f.question}
              aria-label="Question"
              onBlur={(e) => { if (e.target.value.trim() !== f.question) request('PATCH', { businessId, id: f.id, question: e.target.value }); }}
            />
            <textarea
              className="form-input"
              rows={Math.min(8, Math.max(3, Math.ceil(f.answer.length / 80)))}
              defaultValue={f.answer}
              aria-label="Answer"
              autoFocus
              onBlur={(e) => { if (e.target.value.trim() !== f.answer) request('PATCH', { businessId, id: f.id, answer: e.target.value }); }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-sm" disabled={busy} style={muted}
                onClick={() => request('PATCH', { businessId, id: f.id, isEnabled: !f.is_enabled })}>
                {f.is_enabled ? 'Turn off' : 'Turn on'}
              </button>
              <button className="btn btn-sm" disabled={busy} style={{ ...muted, color: 'var(--danger, #ef4444)' }}
                onClick={() => { if (confirm('Delete this saved answer?')) { request('DELETE', undefined, `?businessId=${businessId}&id=${f.id}`); setOpen(null); } }}>
                Delete
              </button>
              <button className="btn btn-sm" style={muted} onClick={() => setOpen(null)}>Close</button>
              <span style={{ marginLeft: 'auto', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>Saves when you click outside the box</span>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={embedded ? undefined : 'form-group'}>
      {!embedded && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <label className="form-label" style={{ marginBottom: 0 }}>💬 Saved Answers</label>
          <span style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{on.length} on{off.length ? ` · ${off.length} off` : ''}</span>
        </div>
      )}
      <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', margin: embedded ? '0 0 0.5rem' : '0.25rem 0 0.5rem', lineHeight: 1.6 }}>
        A fixed reply for one question. {embedded ? 'Chikki' : 'The agent'} gives your wording, also when the customer asks it differently or in
        Hindi. Edits apply to the very next message.{embedded ? ` ${on.length} on${off.length ? `, ${off.length} off` : ''}.` : ''}
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

      {/* The list scrolls inside its own box, so the page stays short. */}
      <div style={{ border: '1px solid var(--border)', borderRadius: embedded ? 10 : 8, maxHeight: embedded ? 480 : 460, overflowY: 'auto' }}>
        {list.map(item)}
        {needle && !list.length && <div style={{ padding: '0.75rem', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>No saved answer matches “{q}”.</div>}
        {!needle && !faqs.length && <div style={{ padding: '0.75rem', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>No saved answers yet.</div>}
      </div>
      <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: 4 }}>
        {needle ? `${list.length} found` : `${faqs.length} answers`} · click one to see or edit it
      </div>
    </div>
  );
}
