'use client';

import { Mail, MessageCircle, Phone, BadgeCheck } from 'lucide-react';
import { displaySubjectLabel } from '@/lib/chat/inbox-topics';
import type { Conversation, TeamMember } from '../_lib/types';
import { STATUS_LABELS, STATUS_STYLE, CATEGORY_LABELS, subjectStyle, convName, nameFromOrder, nameNote, closedInfo, isVisitorChat, timeAgo, matchedText } from '../_lib/inbox';
import { highlightText } from '../_lib/text';
import { WaitingChip, CameBackChip, CaseChip, HealthBadge } from './chips';

export default function ConversationRow({ c, meKey, rowUnread, rowWaiting, searchActive, searchTerm, showPanelName, team }: {
  c: Conversation;
  meKey: string | null;
  rowUnread: (c: Conversation) => number;
  rowWaiting: (c: Conversation) => boolean;
  searchActive: boolean;
  searchTerm: string;
  showPanelName: boolean;
  team: TeamMember[];
}) {
                    // One row, fewer badges (owner, 2026-10-01): who and when; what it is about and ONE
                    // status; the last message; and only when something needs attention, a short line
                    // of chips. Verified / phone match is a small icon (the Customers tab says it too).
                    const customer = !isVisitorChat(c);
                    const open = c.status !== 'resolved';
                    const upset = customer && open && c.health_score != null && c.health_score >= 50;
                    const elsewhere = !!c.group_needs_human && c.status !== 'human_needed';
                    // Who holds it (chat team): "You", their name, or "Team" when nobody does (a key no
                    // longer on the team counts as nobody, as on the server).
                    const holderKey = c.assigned_to || null;
                    const rowHolderIsMe = !!holderKey && holderKey === meKey;
                    const rowHolderName = rowHolderIsMe || !holderKey ? null : team.find(t => t.key === holderKey)?.name ?? null;
                    const pill = elsewhere
                      ? { text: STATUS_LABELS.human_needed, bg: STATUS_STYLE.human_needed.bg, fg: STATUS_STYLE.human_needed.fg, title: 'An older chat of this customer is waiting for a person' }
                      : c.status === 'agent_handling'
                        ? {
                          text: rowHolderIsMe ? 'You' : rowHolderName || 'Team', bg: STATUS_STYLE.agent_handling.bg, fg: STATUS_STYLE.agent_handling.fg,
                          title: rowHolderIsMe ? 'With you' : rowHolderName ? `With ${rowHolderName}` : 'With the team; nobody holds it yet (the next reply makes it theirs)',
                        }
                        : { text: closedInfo(c)?.short ?? STATUS_LABELS[c.status], bg: STATUS_STYLE[c.status]?.bg, fg: STATUS_STYLE[c.status]?.fg, title: undefined };
                    // Any other status: who it is for ("For you" / "For Rahul"); a Closed one goes back
                    // to them if the customer writes again.
                    const forChip = (rowHolderIsMe || rowHolderName) && (c.status !== 'agent_handling' || elsewhere)
                      ? (rowHolderIsMe ? 'For you' : `For ${rowHolderName}`) : null;
                    const about = c.subject_label ? displaySubjectLabel(c.subject_label) : (CATEGORY_LABELS[c.category] || '');
                    const aboutColor = c.subject_label ? subjectStyle(c.subject_label).fg : 'var(--fg-muted)';
                    const threat = customer && open && c.health_threat;
                    const accuse = customer && open && !c.health_threat && c.health_accuse;
                    const attention = !!c.case_kind || threat || accuse || upset || (customer && !!c.waiting_since) || !!c.returned;
                    return (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: 2 }}>
                          {c.source === 'email' ? <Mail size={12} style={{ color: 'var(--fg-muted)', flexShrink: 0 }} /> : <MessageCircle size={12} style={{ color: 'var(--fg-muted)', flexShrink: 0 }} />}
                          <span title={nameNote(c)} style={{ fontWeight: rowUnread(c) > 0 ? 700 : 600, fontSize: '0.8125rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: nameFromOrder(c) ? 'italic' : undefined }}>
                            {convName(c)}
                          </span>
                          {c.verified_order_id
                            ? <span title={`Verified${c.verified_via === 'legacy' ? ' (old check)' : ''}${c.verified_order_id ? ` · order ${c.verified_order_id}` : ''}`} style={{ display: 'inline-flex', flexShrink: 0 }}><BadgeCheck size={13} style={{ color: c.verified_via === 'legacy' ? '#d97706' : 'var(--success)' }} /></span>
                            : c.phone_match_order_id ? <span title={`Phone match · order ${c.phone_match_order_id} (not proof)`} style={{ display: 'inline-flex', flexShrink: 0 }}><Phone size={11} style={{ color: '#2563eb' }} /></span> : null}
                          <span style={{ marginLeft: 'auto', fontSize: '0.625rem', color: 'var(--fg-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                            {timeAgo(c.last_message_at)}{searchActive ? matchedText(c) : ''}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: 2, minWidth: 0 }}>
                          <span title={c.subject_summary || about} style={{ flex: 1, minWidth: 0, fontSize: '0.6875rem', fontWeight: 600, color: aboutColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {showPanelName ? `${c.panel_name || c.site_name} · ` : ''}{about}{(c.thread_count ?? 0) > 1 ? ` · ${c.thread_count} chats` : ''}
                          </span>
                          <span title={pill.title} style={{ fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0, background: pill.bg, color: pill.fg, maxWidth: '9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pill.text}</span>
                          {forChip && (
                            <span title={c.status === 'resolved' ? (holderKey === 'owner' ? 'If the customer writes again, it goes to the open pool' : `If the customer writes again, it goes to ${rowHolderIsMe ? 'you' : rowHolderName}`) : `${rowHolderIsMe ? 'You have' : `${rowHolderName} has`} this chat`} style={{
                              fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0, maxWidth: '8rem',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              background: rowHolderIsMe ? 'var(--primary-light)' : 'var(--bg-subtle, rgba(0,0,0,0.05))', color: rowHolderIsMe ? 'var(--primary)' : 'var(--fg-muted)',
                            }}>{forChip}</span>
                          )}
                          {rowUnread(c) > 0 && (
                            <span title={rowWaiting(c) ? `${rowUnread(c)} new message${rowUnread(c) === 1 ? '' : 's'}; the customer is waiting for an answer` : `${rowUnread(c)} new message${rowUnread(c) === 1 ? '' : 's'}, already answered`}
                              style={{ background: rowWaiting(c) ? 'var(--danger)' : 'var(--muted, #e5e7eb)', color: rowWaiting(c) ? '#fff' : 'var(--fg-muted)', borderRadius: 9999, fontSize: '0.625rem', padding: '1px 6px', fontWeight: 700, flexShrink: 0 }}>
                              {rowUnread(c)}
                            </span>
                          )}
                        </div>
                        {searchActive && c.match_snippet ? (
                          <div style={{
                            fontSize: '0.75rem', color: 'var(--fg-muted)', overflow: 'hidden', wordBreak: 'break-word',
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                          }}>
                            {highlightText(c.match_snippet.replace(/\s+/g, ' '), searchTerm, `r${c.id}`)}
                          </div>
                        ) : (
                          <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.last_message || '—'}
                          </div>
                        )}
                        {attention && (
                          <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.3125rem' }}>
                            {c.case_kind && <CaseChip kind={c.case_kind} by={c.case_marked_by} at={c.case_marked_at} status={c.status} role={c.case_mark_role} />}
                            {threat && (
                              <span title="This customer has threatened a chargeback, police, court or bad reviews" style={{ fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 700, background: '#fee2e2', color: '#b91c1c', whiteSpace: 'nowrap' }}>Threat</span>
                            )}
                            {accuse && (
                              <span title="This customer has called the store a fraud, scam or fake" style={{ fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 700, background: '#fee2e2', color: '#b91c1c', whiteSpace: 'nowrap' }}>Fraud claim</span>
                            )}
                            {upset && !threat && !accuse && <HealthBadge score={c.health_score} reason={c.health_reason} />}
                            {customer && c.waiting_since && <WaitingChip since={c.waiting_since} />}
                            {c.returned && <CameBackChip closedAt={c.auto_closed_at} />}
                          </div>
                        )}
                      </>
                    );
}
