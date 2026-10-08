'use client';

import { Mail, MessageCircle, Phone, BadgeCheck } from 'lucide-react';
import { displaySubjectLabel } from '@/lib/chat/inbox-topics';
import { waitingLevel } from '@/lib/chat/waiting';
import type { Conversation, TeamMember } from '../_lib/types';
import { STATUS_LABELS, CATEGORY_LABELS, convName, nameFromOrder, nameNote, closedInfo, isVisitorChat, timeAgo, matchedText, msSince } from '../_lib/inbox';
import { highlightText } from '../_lib/text';
import { Chip, WaitingChip, CameBackChip, CaseChip, HealthBadge, PromiseChip, ReshipChip, statusTone, type ChipTone } from './chips';

export default function ConversationRow({ simple, c, meKey, rowUnread, rowWaiting, searchActive, searchTerm, showPanelName, team }: {
  simple: boolean;
  c: Conversation;
  meKey: string | null;
  rowUnread: (c: Conversation) => number;
  rowWaiting: (c: Conversation) => boolean;
  searchActive: boolean;
  searchTerm: string;
  showPanelName: boolean;
  team: TeamMember[];
}) {
  // Three lines, the same height on every row (owner, 2026-10-03): who and when; what it is
  // about with ONE status chip and at most ONE priority chip; the last message. The thread
  // header shows everything else. Verified / phone match is a small icon by the name.
  const customer = !isVisitorChat(c);
  const open = c.status !== 'resolved';
  const upset = customer && open && c.health_score != null && c.health_score >= 50;
  const elsewhere = !!c.group_needs_human && c.status !== 'human_needed';
  // Who holds it (chat team): "You", their name, or "Team" when nobody does (a key no
  // longer on the team counts as nobody, as on the server).
  const holderKey = c.assigned_to || null;
  const rowHolderIsMe = !!holderKey && holderKey === meKey;
  const rowHolderName = rowHolderIsMe || !holderKey ? null : team.find(t => t.key === holderKey)?.name ?? null;
  // Whose it is when it is not with them right now ("For you" / "For Rahul"): a Closed one
  // goes back to them if the customer writes again.
  const forWhom = (rowHolderIsMe || rowHolderName) && (c.status !== 'agent_handling' || elsewhere)
    ? (rowHolderIsMe ? 'For you' : `For ${rowHolderName}`) : null;
  const forNote = forWhom
    ? (c.status === 'resolved'
      ? (holderKey === 'owner' ? 'If the customer writes again, it goes to the open pool' : `If the customer writes again, it goes to ${rowHolderIsMe ? 'you' : rowHolderName}`)
      : `${rowHolderIsMe ? 'You have' : `${rowHolderName} has`} this chat`)
    : null;
  const closed = closedInfo(c);
  // ONE status chip: "Needs you" (this chat, or an older one of this customer), "You" /
  // "Rahul" / "Team" when a person has it, "For Rahul" when it is theirs in another list,
  // "Closed · support" with who closed it, else the status.
  const status: { text: string; tone: ChipTone; title?: string } = elsewhere
    ? { text: STATUS_LABELS.human_needed, tone: 'danger', title: ['An older chat of this customer is waiting for a person', forNote].filter(Boolean).join(' · ') }
    : c.status === 'agent_handling'
      ? {
        text: rowHolderIsMe ? 'You' : rowHolderName || 'Team', tone: 'primary',
        title: rowHolderIsMe ? 'With you' : rowHolderName ? `With ${rowHolderName}` : 'With the team; nobody holds it yet (the next reply makes it theirs)',
      }
      : closed
        ? { text: closed.short, tone: 'muted', title: [closed.title, forNote].filter(Boolean).join(' ') }
        : { text: forWhom ?? STATUS_LABELS[c.status], tone: statusTone(c.status), title: forWhom ? `${STATUS_LABELS[c.status]} · ${forNote}` : undefined };
  const about = c.subject_label ? displaySubjectLabel(c.subject_label) : (CATEGORY_LABELS[c.category] || '');
  const threat = customer && open && c.health_threat;
  const accuse = customer && open && !c.health_threat && c.health_accuse;
  // ONE priority chip, the most urgent first: waiting 2 hours or more, frustration from
  // 50%, the Refund / Ship again mark, a threat or fraud claim, a chat that came back.
  const waitMs = customer && c.waiting_since ? msSince(c.waiting_since) : NaN;
  const overdue = !Number.isNaN(waitMs) && waitingLevel(waitMs) === 'overdue';
  // A Ship again chat shows whether the new parcel went (owner 2026-10-03) before anything else.
  // A promise Chikki made while the office was closed (owner 2026-10-05) is kept before anything else.
  const priority = customer && c.chargeback_open ? <Chip tone="danger" title="A chargeback mail arrived for this customer's order. The Super Admin sees it in Chargebacks.">Chargeback</Chip>
    : c.case_kind === 'reship' ? <ReshipChip c={c} />
    : customer && open && c.promise_due_at ? <PromiseChip dueAt={c.promise_due_at} />
    : overdue && c.waiting_since ? <WaitingChip since={c.waiting_since} />
    : upset ? <HealthBadge score={c.health_score} reason={c.health_reason} />
    : c.case_kind ? <CaseChip kind={c.case_kind} by={c.case_marked_by} at={c.case_marked_at} status={c.status} role={c.case_mark_role} />
    : threat ? <Chip tone="danger" title="This customer has threatened a chargeback, police, court or bad reviews">Threat</Chip>
    : accuse ? <Chip tone="danger" title="This customer has called the store a fraud, scam or fake">Fraud claim</Chip>
    : c.returned ? <CameBackChip closedAt={c.auto_closed_at} />
    : null;
  const unread = rowUnread(c);
  return (
    <>
      <div className="row-line">
        {c.source === 'email' ? <Mail className="row-icon" /> : <MessageCircle className="row-icon" />}
        <span className={`row-name truncate${unread > 0 ? ' unread' : ''}`} title={nameNote(c)} style={{ fontStyle: nameFromOrder(c) ? 'italic' : undefined }}>
          {convName(c)}
        </span>
        {c.verified_order_id
          ? <span title={`Verified${c.verified_via === 'legacy' ? ' (old check)' : ''}${c.verified_order_id ? ` · order ${c.verified_order_id}` : ''}`} className={c.verified_via === 'legacy' ? 't-warn' : 't-ok'} style={{ display: 'inline-flex', flexShrink: 0 }}><BadgeCheck size={13} /></span>
          : c.phone_match_order_id ? <span title={`Phone match · order ${c.phone_match_order_id} (not proof)`} className="t-primary" style={{ display: 'inline-flex', flexShrink: 0 }}><Phone size={11} /></span> : null}
        {unread > 0 && (
          <span className={`dot${rowWaiting(c) ? ' dot-danger' : ''}`}
            title={rowWaiting(c) ? `${unread} new message${unread === 1 ? '' : 's'}; the customer is waiting for an answer` : `${unread} new message${unread === 1 ? '' : 's'}, already answered`} />
        )}
        <span className="row-time">{timeAgo(c.last_message_at)}{searchActive ? matchedText(c) : ''}</span>
      </div>
      <div className="row-line">
        <span className="row-about truncate" title={c.subject_summary || about}>
          {showPanelName ? `${c.panel_name || c.site_name} · ` : ''}{about}{(c.thread_count ?? 0) > 1 ? ` · ${c.thread_count} chats` : ''}
        </span>
        <Chip tone={status.tone} title={status.title}>{status.text}</Chip>
        {priority}
      </div>
      {simple && !searchActive && c.subject_summary && (
        // The team's rows say in one line what the customer needs, so a chat is understood before it is opened.
        <div className="row-brief clamp">{c.subject_summary}</div>
      )}
      {searchActive && c.match_snippet ? (
        <div className="row-snippet clamp">
          {highlightText(c.match_snippet.replace(/\s+/g, ' '), searchTerm, `r${c.id}`)}
        </div>
      ) : (
        <div className="row-snippet">{c.last_message || '—'}</div>
      )}
    </>
  );
}
