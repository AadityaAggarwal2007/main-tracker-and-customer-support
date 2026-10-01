'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrainCircuit, ChevronDown, GraduationCap, Lightbulb, MessageCircle, NotebookPen, Settings2, ShieldCheck } from 'lucide-react';
import ChikkiBot from './ChikkiBot';
import ChikkiLogic, { type EffortData, type EffortSettings } from './ChikkiLogic';
import SavedAnswersCard from './SavedAnswersCard';
import TeamExamplesCard from './TeamExamplesCard';

// Chikki in Panel Settings (owner, 2026-10-01): the panel's AI in one card. It was "Saved Answers"
// plus "Brain" (notes, suggested lessons, team examples, locked rules); the data, the APIs and
// who may change what are the same as before (/api/panel-faq, /api/panel-brain/*). New here: the
// robot and the AI on / off switch at the top, compact one-line lists, and Rules = the whole
// rulebook (src/lib/chat/rulebook.ts) where an admin writes what should change
// (/api/panel-brain/rule-changes). Logic = how Chikki thinks and how hard (effort levels,
// ChikkiLogic.tsx). Settings = Cash on Delivery and the custom instructions,
// drawn by the admin page as before. Staff only: customers still meet "Karry".

interface Faq { id: string; question: string; answer: string; is_enabled: boolean }
interface Note {
  id: string; site_id: string | null; kind: 'rule' | 'fact' | 'lesson'; title: string; body: string;
  topics: string[]; always: boolean; audience: 'all' | 'verified' | 'visitor'; shown_count: number; last_shown_at: string | null;
  is_enabled: boolean; source: string;
}
interface Topic { key: string; label: string }
interface Suggestion { id: string; kind: Note['kind']; title: string; body: string; topics: string[]; why: string | null; conversation_id: string | null }
type RuleHow = 'told' | 'code' | 'auto' | 'setting' | 'later';
interface Rule { id: string; title: string; text: string; how: RuleHow; from: string }
interface RuleSection { key: string; title: string; rules: Rule[] }
interface RuleChange { id: string; rule_id: string; body: string; status: 'open' | 'done' | 'dropped'; created_by: string | null; created_at: string; closed_note: string | null }

type Tab = 'answers' | 'notes' | 'lessons' | 'team' | 'rules' | 'logic' | 'settings';

const KIND_LABEL: Record<string, string> = { rule: 'Rule', fact: 'Fact', lesson: 'Lesson' };
const AUDIENCE_LABEL: Record<string, string> = { all: 'Everyone', verified: 'Verified customers only', visitor: 'Visitors only' };
const SOURCE_LABEL: Record<string, string> = { seed: 'Starter', prompt: 'From your prompt', learned: 'Learned' };
const EMPTY = { kind: 'lesson' as Note['kind'], title: '', body: '', topics: [] as string[], always: false, common: false, audience: 'all' as Note['audience'] };
const HOW: Record<RuleHow, { label: string; color: string; bg: string; hint: string; legend: string }> = {
  told:    { label: 'Chikki is told',  color: '#3b4fd8', bg: '#eef1ff', hint: 'In the locked instructions Chikki reads on every message', legend: 'in its instructions on every message' },
  code:    { label: 'Locked in code',  color: '#047857', bg: '#e7f8f0', hint: 'Code checks or does it on every reply, whatever the AI writes', legend: 'checked on every reply, whatever the AI writes' },
  auto:    { label: 'Automatic',       color: '#6d28d9', bg: '#f3efff', hint: 'The system does it by itself', legend: 'the system does it by itself' },
  setting: { label: 'Your setting',    color: '#b45309', bg: '#fff6e5', hint: 'You set it in Panel Settings', legend: 'you set it in Settings' },
  later:   { label: 'Not built yet',   color: '#6b7280', bg: '#f1f2f4', hint: 'Decided, not built yet', legend: 'decided, not built' },
};
const TAB_KEY = 'chikki.tab';
const muted = { border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)' };
const listBox = { border: '1px solid var(--border)', borderRadius: 10, maxHeight: 480, overflowY: 'auto' as const, background: 'var(--card-bg)' };
const help = { fontSize: '0.6875rem', color: 'var(--fg-muted)', lineHeight: 1.6 };

export default function ChikkiCard({
  token, businessId, panelName, onAlert,
  faqs, faqBusy, faqRequest, faqDraft, setFaqDraft, onAddFaq,
  aiEnabled, aiBusy, onToggleAi, settings,
}: {
  token: string | null; businessId: string | null; panelName?: string; onAlert: (type: string, message: string) => void;
  faqs: Faq[]; faqBusy: boolean; faqRequest: (method: string, body?: unknown, qs?: string) => Promise<boolean>;
  faqDraft: { question: string; answer: string }; setFaqDraft: (d: { question: string; answer: string }) => void; onAddFaq: () => Promise<void>;
  aiEnabled: boolean; aiBusy: boolean; onToggleAi: () => void; settings?: ReactNode;
}) {
  const [tab, setTabState] = useState<Tab>('answers');
  const [notes, setNotes] = useState<Note[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [locked, setLocked] = useState<string[]>([]);
  const [rulebook, setRulebook] = useState<RuleSection[]>([]);
  const [changes, setChanges] = useState<RuleChange[]>([]);
  const [effortData, setEffortData] = useState<EffortData | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [canEditCommon, setCanEditCommon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [teamPending, setTeamPending] = useState(0);
  const [teamReviewed, setTeamReviewed] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [sugEdit, setSugEdit] = useState<Record<string, { title: string; body: string; topics: string[] }>>({});
  const [openSug, setOpenSug] = useState<string | null>(null);
  // Notes
  const [noteQ, setNoteQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ title: '', body: '', topics: [] as string[], always: false, kind: 'lesson' as Note['kind'], audience: 'all' as Note['audience'] });
  // Rules
  const [ruleQ, setRuleQ] = useState('');
  const [openRules, setOpenRules] = useState<Set<string>>(new Set());
  const [changeFor, setChangeFor] = useState<string | null>(null);
  const [changeText, setChangeText] = useState('');
  const [showExact, setShowExact] = useState(false);
  // Header line that changes every few seconds while the AI is on
  const [line, setLine] = useState(0);

  useEffect(() => {
    try { const t = localStorage.getItem(TAB_KEY) as Tab | null; if (t && ['answers', 'notes', 'lessons', 'team', 'rules', 'logic', 'settings'].includes(t)) setTabState(t); } catch { /* private window */ }
  }, []);
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* ignore */ } };
  useEffect(() => {
    if (!aiEnabled) return;
    const h = setInterval(() => setLine((n) => n + 1), 4500);
    return () => clearInterval(h);
  }, [aiEnabled]);

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
      setRulebook(d.rulebook || []); setChanges(d.ruleChanges || []); setEffortData(d.effort || null);
      setCanEdit(!!d.canEdit); setCanEditCommon(!!d.canEditCommon);
    } catch { /* keep what is on screen */ }
  }, [token, businessId]);

  // Team examples waiting (tab badge) and how many chats Chikki has read (header).
  const loadTeamCount = useCallback(async () => {
    if (!token || !businessId) return;
    try {
      const r = await fetch(`/api/panel-brain/examples?businessId=${businessId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const d = await r.json();
      setTeamPending((d.examples || []).filter((e: { status: string }) => e.status === 'pending').length);
      setTeamReviewed(d.reviewed || 0);
    } catch { /* keep what is on screen */ }
  }, [token, businessId]);

  useEffect(() => { load(); loadSuggestions(); loadTeamCount(); }, [load, loadSuggestions, loadTeamCount]);

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
      onAlert('success', action === 'approve' ? 'Chikki learned it' : 'Rejected');
      setOpenSug(null);
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

  const ruleChange = async (method: 'POST' | 'PATCH', body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch('/api/panel-brain/rule-changes', {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'Could not save'); return false; }
      await load();
      return true;
    } catch { onAlert('error', 'Could not save'); return false; }
    finally { setBusy(false); }
  };

  const saveEffort = async (settings: EffortSettings) => {
    setBusy(true);
    try {
      const r = await fetch('/api/panel-brain/effort', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ businessId, effort: settings }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onAlert('error', d.error || 'Could not save'); return false; }
      onAlert('success', 'Saved: Chikki uses these levels from the next reply');
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
      setDraft(EMPTY); setAdding(false); onAlert('success', 'Saved: Chikki uses it from the next message');
    }
  };

  const saveEdit = async (n: Note) => {
    if (!edit.title.trim() || !edit.body.trim()) { onAlert('error', 'Write a title and the note'); return; }
    if (!edit.always && !edit.topics.length) { onAlert('error', 'Pick at least one topic, or tick "Always show"'); return; }
    if (await call('PATCH', { businessId, id: n.id, ...edit })) { setEditing(null); onAlert('success', 'Saved'); }
  };

  const toggleAi = () => {
    if (aiEnabled && !confirm('Put Chikki to sleep? Every new chat and email will wait for your team until you turn it back on.')) return;
    onToggleAi();
  };

  const editable = (n: Note) => canEdit && (n.site_id !== null || canEditCommon);
  const chip = (text: string, on = false, key?: string) => (
    <span key={key || text} style={{ fontSize: '0.6875rem', padding: '0.0625rem 0.5rem', borderRadius: 999, border: '1px solid var(--border)', whiteSpace: 'nowrap',
      background: on ? 'var(--primary-light)' : 'transparent', color: on ? 'var(--primary)' : 'var(--fg-muted)' }}>{text}</span>
  );
  const caret = (open: boolean) => (
    <ChevronDown size={14} style={{ color: 'var(--fg-muted)', flexShrink: 0, transition: 'transform .15s', transform: open ? 'rotate(180deg)' : 'none' }} />
  );
  const rowBtn = (open: boolean) => ({
    width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '0.5rem 0.75rem', border: 'none', cursor: 'pointer',
    textAlign: 'left' as const, color: 'var(--fg)', background: open ? 'var(--primary-light)' : 'transparent',
  });
  const oneLine = { display: 'block', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' };

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

  // ── Notes: one line each, click to read or change ──
  const noteRow = (n: Note) => {
    const open = openNote === n.id;
    return (
      <div key={n.id} style={{ borderBottom: '1px solid var(--border)', opacity: n.is_enabled ? 1 : 0.55 }}>
        <button type="button" aria-expanded={open} onClick={() => { setOpenNote(open ? null : n.id); setEditing(null); }} style={rowBtn(open)}>
          {chip(KIND_LABEL[n.kind] || n.kind, true)}
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ ...oneLine, fontWeight: 600, fontSize: '0.8125rem' }}>{n.title}{n.is_enabled ? '' : ' (off)'}</span>
            {!open && <span style={{ ...oneLine, fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{n.body}</span>}
          </span>
          <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}
            title={n.last_shown_at ? `Last used ${new Date(n.last_shown_at).toLocaleString()}` : 'Not used yet'}>
            {n.shown_count > 0 ? `Used ${n.shown_count.toLocaleString()}×` : 'Not used yet'}
          </span>
          {caret(open)}
        </button>
        {open && (
          <div style={{ padding: '0.25rem 0.75rem 0.75rem 0.75rem' }}>
            {editing === n.id ? (
              <>
                <input className="form-input" style={{ fontWeight: 600, marginBottom: '0.375rem' }} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} maxLength={120} aria-label="Title" />
                <textarea className="form-input" rows={4} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} maxLength={900} aria-label="Note" />
                {topicPicker(edit.topics, (v) => setEdit({ ...edit, topics: v }), edit.always, (v) => setEdit({ ...edit, always: v }))}
                {audiencePicker(edit.audience, (v) => setEdit({ ...edit, audience: v }))}
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => saveEdit(n)}>Save</button>
                  <button className="btn btn-sm" style={muted} onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: '0.8125rem', whiteSpace: 'pre-wrap', lineHeight: 1.6, marginBottom: '0.5rem' }}>{n.body}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                  {n.always ? chip('Always') : n.topics.map((t) => chip(topicLabel(t), false, t))}
                  {n.audience !== 'all' && chip(AUDIENCE_LABEL[n.audience])}
                  {n.source !== 'owner' && chip(SOURCE_LABEL[n.source] || n.source)}
                </div>
                {editable(n) && (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-sm" disabled={busy} style={muted}
                      onClick={() => { setEditing(n.id); setEdit({ title: n.title, body: n.body, topics: n.topics, always: n.always, kind: n.kind, audience: n.audience || 'all' }); }}>Edit</button>
                    <button className="btn btn-sm" disabled={busy} style={muted} onClick={() => call('PATCH', { businessId, id: n.id, isEnabled: !n.is_enabled })}>{n.is_enabled ? 'Turn off' : 'Turn on'}</button>
                    <button className="btn btn-sm" disabled={busy} style={{ ...muted, color: 'var(--danger, #ef4444)' }}
                      onClick={() => { if (confirm('Delete this note?')) { call('DELETE', undefined, `?businessId=${businessId}&id=${n.id}`); setOpenNote(null); } }}>Delete</button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };
  const noteMatch = (x: Note) => { const q = noteQ.trim().toLowerCase(); return !q || `${x.title} ${x.body}`.toLowerCase().includes(q); };
  const noteGroup = (title: string, list: Note[]) => list.length > 0 && (
    <>
      <div style={{ position: 'sticky', top: 0, zIndex: 1, padding: '0.375rem 0.75rem', fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--fg-muted)', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
        {title} ({list.length})
      </div>
      {list.map(noteRow)}
    </>
  );

  // ── Rules ──
  const ruleCount = rulebook.reduce((n, s) => n + s.rules.length, 0);
  const openChanges = changes.filter((c) => c.status === 'open');
  const changesFor = (id: string) => changes.filter((c) => c.rule_id === id);
  const ruleQn = ruleQ.trim().toLowerCase();
  const shownSections = useMemo(() => rulebook
    .map((s) => ({ ...s, rules: s.rules.filter((r) => !ruleQn || `${r.id} ${r.title} ${r.text} ${s.title}`.toLowerCase().includes(ruleQn)) }))
    .filter((s) => s.rules.length > 0), [rulebook, ruleQn]);
  const allOpen = ruleCount > 0 && openRules.size >= ruleCount;
  const toggleRule = (id: string) => setOpenRules((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const changeList = (list: RuleChange[]) => list.map((c) => (
    <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.75rem', padding: '0.375rem 0.5rem', borderRadius: 8, marginTop: 6,
      background: c.status === 'open' ? '#fff8e8' : 'var(--bg-subtle)', border: `1px solid ${c.status === 'open' ? '#f6d58e' : 'var(--border)'}` }}>
      <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>
        <b>{c.status === 'open' ? 'Change asked' : c.status === 'done' ? 'Applied ✓' : 'Withdrawn'}:</b> {c.body}
        <span style={{ display: 'block', color: 'var(--fg-muted)', fontSize: '0.6875rem', marginTop: 2 }}>
          {c.created_by || 'admin'} · {new Date(c.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
          {c.closed_note ? ` · ${c.closed_note}` : c.status === 'open' ? ' · waiting: the rule stays as it is until this is applied and tested' : ''}
        </span>
      </span>
      {canEdit && c.status === 'open' && (
        <button className="btn btn-sm" disabled={busy} style={{ ...muted, padding: '0.125rem 0.5rem' }} onClick={() => ruleChange('PATCH', { id: c.id, action: 'withdraw' })}>Withdraw</button>
      )}
    </div>
  ));
  const changeForm = (ruleId: string, placeholder: string) => changeFor === ruleId ? (
    <div style={{ marginTop: 8 }}>
      <textarea className="form-input" rows={3} autoFocus maxLength={1000} placeholder={placeholder} value={changeText} onChange={(e) => setChangeText(e.target.value)} aria-label="What should change" />
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-primary" disabled={busy || changeText.trim().length < 3}
          onClick={async () => { if (await ruleChange('POST', { ruleId, body: changeText })) { setChangeFor(null); setChangeText(''); onAlert('success', 'Saved: it is applied after testing'); } }}>Save</button>
        <button className="btn btn-sm" style={muted} onClick={() => { setChangeFor(null); setChangeText(''); }}>Cancel</button>
        <span style={help}>Nothing changes for customers until it is applied and tested.</span>
      </div>
    </div>
  ) : canEdit ? (
    <button type="button" className="btn btn-sm" style={{ ...muted, marginTop: 8 }} onClick={() => { setChangeFor(ruleId); setChangeText(''); }}>✎ {ruleId === 'new' ? 'Ask for a new rule' : 'Change this rule'}</button>
  ) : null;
  const ruleRow = (r: Rule) => {
    const open = openRules.has(r.id);
    const h = HOW[r.how] || HOW.auto;
    const waiting = changesFor(r.id).some((c) => c.status === 'open');
    return (
      <div key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
        <button type="button" aria-expanded={open} onClick={() => toggleRule(r.id)} style={rowBtn(open)}>
          <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--fg-muted)', minWidth: 30, fontVariantNumeric: 'tabular-nums' }}>{r.id}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ ...oneLine, fontWeight: 600, fontSize: '0.8125rem' }}>{r.title}</span>
            {!open && <span style={{ ...oneLine, fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{r.text}</span>}
          </span>
          {waiting && <span title="You asked for a change" style={{ fontSize: '0.625rem', fontWeight: 700, color: '#b45309', background: '#fff6e5', borderRadius: 999, padding: '0.0625rem 0.4rem', whiteSpace: 'nowrap' }}>change asked</span>}
          <span title={h.hint} style={{ fontSize: '0.625rem', fontWeight: 600, color: h.color, background: h.bg, borderRadius: 999, padding: '0.125rem 0.5rem', whiteSpace: 'nowrap' }}>{h.label}</span>
          {caret(open)}
        </button>
        {open && (
          <div style={{ padding: '0 0.75rem 0.75rem 2.75rem' }}>
            <div style={{ fontSize: '0.8125rem', lineHeight: 1.6 }}>{r.text}</div>
            {r.from && <div style={{ ...help, marginTop: 4 }}>From: {r.from}</div>}
            {changeList(changesFor(r.id))}
            {changeForm(r.id, `What should rule ${r.id} say instead? Write it in your words, Hindi or English.`)}
          </div>
        )}
      </div>
    );
  };

  // ── Header numbers ──
  const answersOn = faqs.filter((f) => f.is_enabled).length;
  const notesUsed = notes.reduce((n, x) => n + (x.shown_count || 0), 0);
  const waitingTotal = suggestions.length + teamPending;
  const store = panelName ? panelName.charAt(0).toUpperCase() + panelName.slice(1) : '';
  const lines = [
    `Answering ${store ? `${store}'s` : 'your'} customers in chat and email`,
    waitingTotal > 0 ? `Learning from your team: ${waitingTotal} waiting for your OK` : 'Learning from your team every 3 hours',
    `Following ${ruleCount || 'your'} rules, ${notes.length} notes and ${answersOn} saved answers`,
    notesUsed > 0 ? `Has used your notes ${notesUsed.toLocaleString()} times` : 'Reads only the notes that fit each message',
    effortData?.settings?.critical === 'max' ? 'Thinks hardest for your most upset customers' : 'Thinks harder for upset customers',
  ];
  const stat = (n: number | string, label: string, hot = false) => (
    <span style={{ fontSize: '0.6875rem', padding: '0.125rem 0.5rem', borderRadius: 999, whiteSpace: 'nowrap',
      background: hot ? '#fff1e6' : 'rgba(255,255,255,0.75)', color: hot ? '#c2410c' : 'var(--fg-secondary)', border: `1px solid ${hot ? '#fed7aa' : 'var(--border)'}` }}>
      <b>{typeof n === 'number' ? n.toLocaleString() : n}</b> {label}
    </span>
  );

  const tabBtn = (key: Tab, icon: ReactNode, label: string, count?: number, hot = false) => {
    const on = tab === key;
    return (
      <button key={key} type="button" role="tab" aria-selected={on}
        onClick={(e) => { setTab(key); e.currentTarget.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0.4375rem 0.75rem', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
          borderRadius: 8, border: 'none', background: on ? 'var(--card-bg)' : 'transparent', color: on ? 'var(--primary)' : 'var(--fg-muted)',
          boxShadow: on ? 'var(--shadow-sm)' : 'none' }}>
        {icon}{label}
        {count !== undefined && count > 0 && (
          <span style={{ fontSize: '0.6875rem', padding: '0 6px', borderRadius: 999, lineHeight: '1.125rem',
            background: hot ? '#f97316' : on ? 'var(--primary-light)' : 'var(--muted)', color: hot ? '#fff' : on ? 'var(--primary)' : 'var(--fg-muted)' }}>{count}</span>
        )}
      </button>
    );
  };

  return (
    <div className="tf-card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* ── Chikki ── */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', padding: '1.125rem 1.5rem',
        background: aiEnabled ? 'linear-gradient(120deg, hsl(230 90% 97%), hsl(262 90% 97%) 55%, hsl(190 90% 97%))' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
        <ChikkiBot size={84} active={aiEnabled} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '1.375rem', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.2,
              background: 'linear-gradient(90deg, #3b4fd8, #8b5cf6)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>Chikki</span>
            <span style={{ fontSize: '0.625rem', fontWeight: 800, letterSpacing: '0.08em', color: '#fff', padding: '0.125rem 0.4375rem', borderRadius: 6, background: 'linear-gradient(90deg, #4f6bed, #8b5cf6)' }}>AI</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', fontWeight: 600, padding: '0.125rem 0.5rem', borderRadius: 999,
              color: aiEnabled ? 'var(--success)' : 'var(--fg-muted)', background: aiEnabled ? 'var(--success-light)' : 'var(--muted)' }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: aiEnabled ? 'var(--success)' : '#9ca3af', animation: aiEnabled ? 'pulseDot 1.6s ease-in-out infinite' : 'none' }} />
              {aiEnabled ? 'Active' : 'Sleeping'}
            </span>
          </div>
          <div key={aiEnabled ? line % lines.length : 'off'} style={{ fontSize: '0.8125rem', color: 'var(--fg-secondary)', margin: '0.25rem 0 0.5rem', animation: 'fadeIn .4s ease' }}>
            {aiEnabled ? lines[line % lines.length] : 'The AI is off: every new chat and email waits for your team.'}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {stat(answersOn, 'saved answers')}
            {stat(notes.length, 'notes')}
            {stat(ruleCount, 'rules')}
            {suggestions.length > 0 && stat(suggestions.length, 'lessons waiting', true)}
            {teamPending > 0 && stat(teamPending, 'team examples waiting', true)}
            {teamReviewed > 0 && stat(teamReviewed, 'team chats read')}
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: aiBusy ? 'wait' : 'pointer', padding: '0.5rem 0.75rem', borderRadius: 12,
          background: 'rgba(255,255,255,0.8)', border: '1px solid var(--border)' }}
          title="Refunds, cancellations and store policy are always held for a person either way.">
          <span style={{ textAlign: 'right' }}>
            <span style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600 }}>{aiEnabled ? 'Answers customers' : 'AI is off'}</span>
            <span style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>{aiEnabled ? 'automatically' : 'everything waits for a person'}</span>
          </span>
          <button type="button" role="switch" aria-checked={aiEnabled} aria-label="Chikki answers customers automatically" disabled={aiBusy} onClick={toggleAi}
            style={{ position: 'relative', width: 44, height: 24, borderRadius: 999, border: 'none', cursor: 'inherit', flexShrink: 0, transition: 'background .2s',
              background: aiEnabled ? 'linear-gradient(90deg, #4f6bed, #8b5cf6)' : '#cbd0da' }}>
            <span style={{ position: 'absolute', top: 3, left: aiEnabled ? 23 : 3, width: 18, height: 18, borderRadius: 999, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)', transition: 'left .2s' }} />
          </button>
        </label>
      </div>

      {/* ── Tabs ── */}
      <div role="tablist" aria-label="Chikki" style={{ display: 'flex', gap: 4, padding: 4, margin: '0.875rem 1.5rem 0', borderRadius: 10, background: 'var(--muted)', overflowX: 'auto' }}>
        {tabBtn('answers', <MessageCircle size={14} />, 'Saved answers', answersOn)}
        {tabBtn('notes', <NotebookPen size={14} />, 'Notes', notes.length)}
        {tabBtn('lessons', <Lightbulb size={14} />, 'Lessons', suggestions.length, true)}
        {tabBtn('team', <GraduationCap size={14} />, 'Team examples', teamPending, true)}
        {tabBtn('rules', <ShieldCheck size={14} />, 'Rules', ruleCount)}
        {tabBtn('logic', <BrainCircuit size={14} />, 'Logic')}
        {settings && tabBtn('settings', <Settings2 size={14} />, 'Settings')}
      </div>

      <div style={{ padding: '0.875rem 1.5rem 1.25rem' }}>
        {tab === 'answers' && (
          <SavedAnswersCard embedded faqs={faqs} busy={faqBusy} businessId={businessId} request={faqRequest}
            draft={faqDraft} setDraft={setFaqDraft} onAdd={onAddFaq} />
        )}

        {tab === 'notes' && (
          <>
            <div style={{ ...help, marginBottom: '0.5rem' }}>
              Things Chikki should know or ways to act. On every message it reads only the notes that fit what the customer wrote, plus the ones marked Always.
              {canEdit ? '' : ' Only an admin can change these.'}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.625rem', flexWrap: 'wrap' }}>
              <input className="form-input" style={{ flex: 1, minWidth: 180 }} type="search" placeholder="Search notes" value={noteQ} onChange={(e) => setNoteQ(e.target.value)} aria-label="Search notes" />
              {canEdit && !adding && <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>+ Add a note</button>}
            </div>
            {adding && canEdit && (
              <div style={{ border: '1px dashed var(--primary)', borderRadius: 10, padding: '0.75rem', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem', flexWrap: 'wrap' }}>
                  <select className="form-input" style={{ width: 'auto' }} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Note['kind'] })} aria-label="Kind">
                    <option value="lesson">Lesson (learned from a chat)</option>
                    <option value="rule">Rule (how to act)</option>
                    <option value="fact">Fact (true about the store)</option>
                  </select>
                  <input className="form-input" style={{ flex: 1, minWidth: 180 }} placeholder="Title, e.g. Delivery agent number" value={draft.title} maxLength={120} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Title" />
                </div>
                <textarea className="form-input" rows={3} placeholder="The note, in plain words: what Chikki should know or do" value={draft.body} maxLength={900} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label="Note" />
                {topicPicker(draft.topics, (v) => setDraft({ ...draft, topics: v }), draft.always, (v) => setDraft({ ...draft, always: v }))}
                {audiencePicker(draft.audience, (v) => setDraft({ ...draft, audience: v }))}
                {canEditCommon && (
                  <label style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 4, marginBottom: '0.375rem' }}>
                    <input type="checkbox" checked={draft.common} onChange={(e) => setDraft({ ...draft, common: e.target.checked })} /> For every panel (not only this one)
                  </label>
                )}
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={add}>+ Teach Chikki</button>
                  <button className="btn btn-sm" style={muted} onClick={() => setAdding(false)}>Close</button>
                </div>
              </div>
            )}
            <div style={listBox}>
              {noteGroup('For this panel', notes.filter((n) => n.site_id !== null && noteMatch(n)))}
              {noteGroup('For every panel', notes.filter((n) => n.site_id === null && noteMatch(n)))}
              {noteQ.trim() && !notes.some(noteMatch) && <div style={{ padding: '0.75rem', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>No note matches “{noteQ}”.</div>}
              {!noteQ.trim() && !notes.length && <div style={{ padding: '0.75rem', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>No notes yet.</div>}
            </div>
            <div style={{ ...help, marginTop: 4 }}>{notes.length} notes · click one to read or change it</div>
          </>
        )}

        {tab === 'lessons' && (
          <>
            <div style={{ ...help, marginBottom: '0.5rem' }}>
              Every few hours Chikki reads chats your team answered and drafts lessons. It does NOT use them until you approve.
              Change the wording first if you like; anything that goes against the rules is refused.
            </div>
            <div style={listBox}>
              {!suggestions.length && <div style={{ padding: '0.75rem', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Nothing waiting. New lessons appear here as your team answers chats.</div>}
              {suggestions.map((sg) => {
                const e = sugEdit[sg.id] || { title: sg.title, body: sg.body, topics: sg.topics };
                const open = openSug === sg.id;
                return (
                  <div key={sg.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <button type="button" aria-expanded={open} onClick={() => setOpenSug(open ? null : sg.id)} style={rowBtn(open)}>
                      <Lightbulb size={14} style={{ color: '#f59e0b', flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ ...oneLine, fontWeight: 600, fontSize: '0.8125rem' }}>{e.title}</span>
                        {!open && <span style={{ ...oneLine, fontSize: '0.75rem', color: 'var(--fg-muted)' }}>{e.body}</span>}
                      </span>
                      {e.topics.slice(0, 2).map((t) => chip(topicLabel(t), false, t))}
                      {caret(open)}
                    </button>
                    {open && (
                      <div style={{ padding: '0.25rem 0.75rem 0.75rem' }}>
                        <input className="form-input" style={{ fontWeight: 600, marginBottom: '0.375rem' }} value={e.title} disabled={!canEdit} maxLength={120} aria-label="Title"
                          onChange={(ev) => setSugEdit({ ...sugEdit, [sg.id]: { ...e, title: ev.target.value } })} />
                        <textarea className="form-input" rows={4} value={e.body} disabled={!canEdit} maxLength={900} aria-label="Lesson"
                          onChange={(ev) => setSugEdit({ ...sugEdit, [sg.id]: { ...e, body: ev.target.value } })} />
                        {topicPicker(e.topics, (v) => setSugEdit({ ...sugEdit, [sg.id]: { ...e, topics: v } }), false, () => {})}
                        {sg.why && <div style={{ ...help, marginBottom: '0.375rem' }}>Why: {sg.why}</div>}
                        {canEdit && (
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => decide(sg, 'approve')}>Approve: teach Chikki</button>
                            <button className="btn btn-sm" disabled={busy} style={muted} onClick={() => decide(sg, 'reject')}>Reject</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {tab === 'team' && (
          <TeamExamplesCard embedded token={token} businessId={businessId} canEdit={canEdit} onAlert={onAlert}
            onPending={(n) => setTeamPending(n)} />
        )}

        {tab === 'rules' && (
          <>
            <div style={{ ...help, marginBottom: '0.5rem' }}>
              Everything Chikki and the system follow today. These win over the custom instructions, saved answers, notes and team examples.
              {canEdit ? ' Open a rule and write what should change: it is applied after testing, and until then the rule stays as it is.' : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: '0.625rem' }}>
              {(Object.keys(HOW) as RuleHow[]).map((k) => (
                <span key={k} title={HOW[k].hint} style={{ fontSize: '0.6875rem', fontWeight: 600, color: HOW[k].color, background: HOW[k].bg, borderRadius: 999, padding: '0.125rem 0.5rem' }}>
                  {HOW[k].label}: {HOW[k].legend}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.625rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="form-input" style={{ flex: 1, minWidth: 180 }} type="search" placeholder="Search rules, e.g. refund, COD, 4.3" value={ruleQ} onChange={(e) => setRuleQ(e.target.value)} aria-label="Search rules" />
              <button type="button" className="btn btn-sm" style={muted}
                onClick={() => setOpenRules(allOpen ? new Set() : new Set(rulebook.flatMap((s) => s.rules.map((r) => r.id))))}>{allOpen ? 'Close all' : 'Open all'}</button>
            </div>
            {openChanges.length > 0 && (
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#b45309', marginBottom: '0.5rem' }}>
                {openChanges.length} change{openChanges.length === 1 ? '' : 's'} you asked for {openChanges.length === 1 ? 'is' : 'are'} waiting to be applied.
              </div>
            )}
            <div style={listBox}>
              {shownSections.map((s) => (
                <div key={s.key}>
                  <div style={{ position: 'sticky', top: 0, zIndex: 1, padding: '0.375rem 0.75rem', fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--fg-muted)', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                    {rulebook.findIndex((x) => x.key === s.key) + 1}. {s.title} ({s.rules.length})
                  </div>
                  {s.rules.map(ruleRow)}
                </div>
              ))}
              {ruleQn && !shownSections.length && <div style={{ padding: '0.75rem', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>No rule matches “{ruleQ}”.</div>}
              {!rulebook.length && <div style={{ padding: '0.75rem', fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Loading the rules…</div>}
            </div>

            <div style={{ marginTop: '0.75rem' }}>
              {changeList(changes.filter((c) => c.rule_id === 'new'))}
              {changeForm('new', 'Which new rule should Chikki follow? Write it in your words, Hindi or English.')}
            </div>

            <div style={{ marginTop: '0.75rem', border: '1px solid var(--border)', borderRadius: 10 }}>
              <button type="button" aria-expanded={showExact} onClick={() => setShowExact(!showExact)} style={{ ...rowBtn(false), borderRadius: 10 }}>
                <span style={{ flex: 1, fontSize: '0.8125rem', fontWeight: 600 }}>Exact words Chikki reads on every message</span>
                {caret(showExact)}
              </button>
              {showExact && (
                <div style={{ padding: '0 0.75rem 0.75rem', fontSize: '0.75rem', color: 'var(--fg-muted)', whiteSpace: 'pre-wrap', maxHeight: 360, overflowY: 'auto' }}>
                  {locked.join('\n\n')}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'logic' && <ChikkiLogic data={effortData} canEdit={canEdit} busy={busy} onSave={saveEffort} />}

        {tab === 'settings' && settings}
      </div>
    </div>
  );
}
