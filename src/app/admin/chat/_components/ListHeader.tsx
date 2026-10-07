'use client';

import { Loader2, X, Search, UsersRound } from 'lucide-react';
import { isSuperAdmin } from '@/lib/permissions';
import { HEALTH_PIN_MIN } from '@/lib/chat/health-rules';
import type { InboxTopic } from '@/lib/chat/inbox-topics';
import { WAITING_OVERDUE_HOURS } from '@/lib/chat/waiting';
import { AUTO_MARK_NAME } from '@/lib/chat/tracking-claim';
import type { AuthUser, Business, Conversation, InboxTab } from '../_lib/types';
import { CASE_LABELS } from '../_lib/inbox';
import { Chip } from './chips';

export default function ListHeader({ activeKey, activePanelId, businesses, caseKey, caseSummary, conversations, listTotal, mineTab, myChats, release, releaseAll, searchActive, searchInput, setRelease, setSearchInput, setSearchQ, setUnreadOnly, tab, topicDef, unreadOnly, urgentCount, user }: {
  activePanelId: string;
  businesses: Business[];
  activeKey: string;
  caseKey: string;
  caseSummary: { marked_by: string; day: string; n: number }[];
  conversations: Conversation[];
  listTotal: number | null;
  mineTab: boolean;
  myChats: { open: number; waiting: number; held: number };
  release: 'ask' | 'busy' | null;
  releaseAll: () => Promise<void>;
  searchActive: boolean;
  searchInput: string;
  setRelease: React.Dispatch<React.SetStateAction<'ask' | 'busy' | null>>;
  setSearchInput: React.Dispatch<React.SetStateAction<string>>;
  setSearchQ: React.Dispatch<React.SetStateAction<string>>;
  setUnreadOnly: React.Dispatch<React.SetStateAction<boolean>>;
  tab: InboxTab;
  topicDef: InboxTopic | null;
  unreadOnly: boolean;
  urgentCount: number;
  user: AuthUser | null;
}) {
  return (
    <div className="chat-list-head">
      <div className="chat-list-title">
        <span className="truncate">{searchActive ? 'Search results' : topicDef ? topicDef.label : activeKey === 'open' ? 'Open case' : activeKey === 'closed' ? 'Closed case' : mineTab ? 'My chats' : 'Conversations'}</span>
        <span className="count">{listTotal ?? conversations.length}</span>
        {urgentCount > 0 && (
          <Chip tone="danger" title={`Frustrated customers (${HEALTH_PIN_MIN}%+) and customers waiting ${WAITING_OVERDUE_HOURS} hours or more for an answer, kept at the top until they are answered or Closed`}>
            {urgentCount} pending
          </Chip>
        )}
      </div>
      <div style={{ position: 'relative', marginTop: '0.5rem' }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-muted)', pointerEvents: 'none' }} />
        <input
          className="chat-search"
          type="search"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { setSearchInput(''); setSearchQ(''); } }}
          placeholder="Search name, phone, order…"
          aria-label="Search chats"
          maxLength={80}
          autoComplete="off"
        />
        {searchInput && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => { setSearchInput(''); setSearchQ(''); }}
            style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--fg-muted)', display: 'flex', padding: 4 }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {!searchActive && tab !== 'resolved' && !activeKey && (
        <div className="seg" role="group" aria-label="Show chats">
          {([false, true] as const).map((only) => (
            <button
              key={only ? 'unread' : 'all'}
              type="button"
              className="seg-btn"
              aria-pressed={unreadOnly === only}
              onClick={() => setUnreadOnly(only)}
              title={only ? 'Chats whose customer still waits for an answer. Chats the AI already answered are not here.' : undefined}
            >
              {only ? `Unread${unreadOnly ? ` (${listTotal ?? conversations.length})` : ''}` : 'All'}
            </button>
          ))}
        </div>
      )}
      {mineTab && !searchActive && (
        // My chats. The Super Admin's own replies make chats his (owner answer Q2), so the team
        // can only read them; "Give all N to the team" lets go of every one at once (owner answer 3).
        <div className="meta" style={{ marginTop: '0.5rem' }}>
          <div>Your chats in Needs you and With team{myChats.waiting > 0 ? ` · ${myChats.waiting} waiting` : ''}</div>
          {/* N = what the release frees (every open chat he holds, AI handling and Refund / Ship
              again too), not the customers counted above; shown while he has chats here (owner answer 3). */}
          {isSuperAdmin(user) && myChats.open > 0 && myChats.held > 0 && (release === null ? (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setRelease('ask')}
              title="Every open chat you hold goes back to the open pool: the next team member to reply or press Take over gets it"
              style={{ marginTop: '0.375rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <UsersRound size={13} /> Give all {myChats.held} to the team
            </button>
          ) : (
            <div role="group" aria-label="Give all your chats to the team" className="chat-note" style={{ marginTop: '0.375rem' }}>
              <div style={{ color: 'var(--fg)', marginBottom: '0.375rem' }}>
                Give every open chat you hold back to the team? Each one stays in its list with nobody holding it,
                and the next team member to reply or press Take over gets it. Customers are not told anything.
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={release === 'busy'} onClick={releaseAll}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {release === 'busy' ? <><Loader2 size={13} style={{ animation: 'spin 0.6s linear infinite' }} /> Giving them back…</> : 'Yes, give them to the team'}
                </button>
                <button type="button" className="btn btn-outline btn-sm" disabled={release === 'busy'} onClick={() => setRelease(null)}>Cancel</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {caseKey && !searchActive && (() => {
        // Who marked how many, per day (India time), last 14 days: for the owner's experts.
        const days = Array.from(new Set(caseSummary.map((r) => r.day)));
        const total = caseSummary.reduce((n, r) => n + r.n, 0);
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const fmt = (d: string) => d === today ? 'Today' : new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
        return (
          <div className="chat-note" style={{ maxHeight: 180, overflowY: 'auto' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              {CASE_LABELS[caseKey]} · last 14 days: {total}
            </div>
            {!days.length && <div className="meta">Nothing marked yet.</div>}
            {days.map((d) => (
              <div key={d} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '2px 0' }}>
                <span className="meta" style={{ minWidth: 52 }}>{fmt(d)}</span>
                {caseSummary.filter((r) => r.day === d).map((r) => (
                  <span key={r.marked_by} style={{ fontWeight: 600 }}>{r.marked_by} {r.n}</span>
                ))}
              </div>
            ))}
            <div className="meta" style={{ marginTop: 4, fontSize: '0.6875rem' }}>
              {caseKey === 'reship'
                // Owner 2026-10-02: Chikki marks Ship again by itself for a fake / invalid tracking claim.
                ? `Marked by your team: internal only, the customer is not told, the AI does not reply. Marked by ${AUTO_MARK_NAME}: the customer was promised a new tracking link within 24-48 hours, and Chikki only reminds them once (a chat moved in the one-time move of 2 Oct got no message: its customer's next question about the link gets that line). A red one also shows in Needs you.`
                // Owner 2026-10-02: Chikki marks Refund by itself for a threat after the delivery date.
                : `Marked by your team: internal only, customers are never told; these chats show only here and the AI does not reply in them. Marked by ${AUTO_MARK_NAME}: the customer was told their refund is being processed and that a refund form will come in this chat; only the Super Admin sends it (Send refund form) and closes the chat.`}
            </div>
          </div>
        );
      })()}
      {searchActive && (
        <div className="meta" style={{ marginTop: '0.375rem', fontSize: '0.6875rem' }}>
          In all chats{activePanelId ? ` of ${businesses.find(b => b.id === activePanelId)?.name || 'this panel'}` : ''}, including Closed ones and visitors.
        </div>
      )}
    </div>
  );
}
