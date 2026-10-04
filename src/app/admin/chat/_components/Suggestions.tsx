'use client';

// Suggested replies (owner 2026-10-04): above the reply box, 3 drafts Chikki wrote for this
// team member's next reply (suggest-run.ts). A click puts one in the box; the team member sends
// it or edits it. Pure presentation: the page fetches and records.
import { Loader2, RotateCw, Sparkles } from 'lucide-react';
import type { SuggestLang } from '@/lib/chat/suggest';

export interface SuggestState {
  convId: string;
  lang: SuggestLang;
  loading: boolean;
  error: string;
  id: string | null;
  options: string[];
}

const LANGS: { key: SuggestLang; label: string; title: string }[] = [
  { key: 'auto', label: 'Auto', title: "The customer's language" },
  { key: 'en', label: 'EN', title: 'English' },
  { key: 'hi', label: 'Hinglish', title: 'Hinglish' },
];

export default function Suggestions({ state, replyOpen, onPick, onRefresh, onLang }: {
  state: SuggestState | null;
  replyOpen: boolean;
  onPick: (index: number) => void;
  onRefresh: () => void;
  onLang: (lang: SuggestLang) => void;
}) {
  if (!state) return null;
  return (
    <div className="chat-suggest" aria-label="Suggested replies">
      <div className="chat-suggest-head">
        <span className="chat-suggest-title"><Sparkles size={13} /> Suggested replies</span>
        <span className="chat-suggest-langs" role="group" aria-label="Language">
          {LANGS.map(l => (
            <button key={l.key} type="button" title={l.title} disabled={state.loading}
              className={`chip ${state.lang === l.key ? 'chip-primary' : 'chip-muted'}`}
              onClick={() => { if (state.lang !== l.key) onLang(l.key); }}>
              {l.label}
            </button>
          ))}
        </span>
        <button type="button" className="btn-icon" title="Draft again" aria-label="Draft again" disabled={state.loading}
          onClick={onRefresh} style={{ width: 24, height: 24 }}>
          {state.loading ? <Loader2 size={13} style={{ animation: 'spin 0.6s linear infinite' }} /> : <RotateCw size={13} />}
        </button>
      </div>
      {state.loading && state.options.length === 0 && (
        <p className="meta" style={{ margin: 0 }}>Chikki is drafting…</p>
      )}
      {!state.loading && state.error && (
        <p className="meta" style={{ margin: 0 }}>{state.error}</p>
      )}
      {state.options.length > 0 && (
        <div className="chat-suggest-list">
          {state.options.map((text, i) => (
            <button key={i} type="button" className="chat-suggest-option" title={replyOpen ? 'Put this in the reply box' : 'Take over to reply; the text still fills the box'}
              disabled={state.loading} onClick={() => onPick(i)}>
              <span className="chat-suggest-n">{i + 1}</span>
              <span>{text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
