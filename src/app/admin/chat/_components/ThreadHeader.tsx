'use client';

import { Mail, MessageCircle, Phone, ChevronLeft, Undo2, Truck, ChevronDown, ArrowRightLeft, Lock, Hand } from 'lucide-react';
import { isSuperAdmin } from '@/lib/permissions';
import RefundFormControl, { type RefundThreadState } from '@/components/RefundFormControl';
import { displaySubjectLabel } from '@/lib/chat/inbox-topics';
import { AUTO_MARK_NAME } from '@/lib/chat/tracking-claim';
import type { AuthUser, Conversation, HotLock, OrderFacts, StaffAddress, StaffBlock, TeamLogEntry } from '../_lib/types';
import { minutesText, logTime, teamLogLine, supportLabel, STATUS_LABELS, STATUS_STYLE, subjectStyle, convName, nameFromOrder, nameNote, closedInfo, isVisitorChat, timeAgo } from '../_lib/inbox';
import { PhoneMatchBadge, WaitingChip, CameBackChip, CaseChip, HealthBar, VerifiedBadge } from './chips';
import { OrderLine, AddressLine } from './OrderLine';

export default function ThreadHeader({ activeAddress, activeConv, activeHealth, activeOrder, activePhoneMatch, activeSubject, activeVerifiedOrder, activeVerifiedVia, activeWaiting, addressEditable, canCases, canReply, changeStatus, closeConversation, fetchThread, forText, holderAway, holderIsMe, hotLock, markCase, readOnlyText, setAddrEdit, setTeamLogOpen, setTransferEdit, showAlert, staff, takeLabel, teamLog, teamLogOpen, threadRefund, token, user, withText }: {
  activeAddress: StaffAddress | null;
  activeConv: Conversation | null;
  activeHealth: { score: number; reason: string | null; updatedAt: string | null } | null;
  activeOrder: OrderFacts | null;
  activePhoneMatch: string | null;
  activeSubject: { label: string; summary: string; updatedAt: string | null } | null;
  activeVerifiedOrder: string | null;
  activeVerifiedVia: string | null;
  activeWaiting: string | null;
  addressEditable: boolean;
  canCases: boolean;
  canReply: boolean;
  changeStatus: (status: string, take?: boolean) => Promise<void>;
  closeConversation: () => void;
  fetchThread: (id: string, quiet?: boolean) => Promise<void>;
  forText: string | null;
  holderAway: string;
  holderIsMe: boolean;
  hotLock: HotLock | null;
  markCase: (kind: 'refund' | 'reship' | null) => Promise<void>;
  readOnlyText: string;
  setAddrEdit: React.Dispatch<React.SetStateAction<{ convId: string; busy: boolean; error: string } | null>>;
  setTeamLogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTransferEdit: React.Dispatch<React.SetStateAction<{ convId: string; busy: boolean; error: string } | null>>;
  showAlert: (type: 'success' | 'error', message: string) => void;
  staff: StaffBlock | null;
  takeLabel: string;
  teamLog: TeamLogEntry[];
  teamLogOpen: boolean;
  threadRefund: { id: string; state: RefundThreadState | null } | null;
  token: string;
  user: AuthUser | null;
  withText: string;
}) {
  return (
                <div style={{ padding: '0.875rem 1.25rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <button type="button" className="btn-icon chat-back" aria-label="Back to conversations" onClick={closeConversation}>
                    <ChevronLeft size={20} />
                  </button>
                  {/* Counts as 7rem when the header decides what fits on its first line: on a phone a
                      wide actions group (the read-only label, Take / Transfer) then wraps to its own
                      line instead of squeezing the customer's name to a few pixels. */}
                  <div style={{ minWidth: 0, flex: '1 1 7rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span title={nameNote(activeConv)} style={{ fontWeight: 700, fontStyle: nameFromOrder(activeConv) ? 'italic' : undefined }}>{convName(activeConv)}</span>
                      {nameFromOrder(activeConv) && (
                        <span style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>(from order)</span>
                      )}
                      <span style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                        display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                        background: 'var(--primary-light)', color: 'var(--primary)',
                      }}>
                        {activeConv.source === 'email' ? <><Mail size={10} /> Email</> : <><MessageCircle size={10} /> Chat</>}
                      </span>
                      <span title={staff?.holder && holderAway ? `${staff.holder.name} has not been in ShipTrack for ${minutesText(staff.holder.away_min ?? 0)}` : undefined} style={{
                        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                        background: STATUS_STYLE[activeConv.status]?.bg, color: STATUS_STYLE[activeConv.status]?.fg,
                      }}>
                        {activeConv.status === 'agent_handling' ? withText : STATUS_LABELS[activeConv.status]}
                      </span>
                      {forText && (
                        <span title={activeConv.status === 'resolved' ? (staff?.holder?.key === 'owner' ? 'If the customer writes again, it goes to the open pool' : 'If the customer writes again, it goes to them') : undefined} style={{
                          fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                          background: holderIsMe ? 'var(--primary-light)' : 'var(--bg-subtle, rgba(0,0,0,0.05))', color: holderIsMe ? 'var(--primary)' : 'var(--fg-muted)',
                        }}>
                          {forText}
                        </span>
                      )}
                      {activeVerifiedOrder ? <VerifiedBadge orderId={activeVerifiedOrder} via={activeVerifiedVia} />
                        : activePhoneMatch ? <PhoneMatchBadge orderId={activePhoneMatch} /> : null}
                      {activeWaiting && <WaitingChip since={activeWaiting} big />}
                      {activeConv.auto_closed_at && activeConv.status !== 'resolved' && <CameBackChip closedAt={activeConv.auto_closed_at} big />}
                      {closedInfo(activeConv) && (
                        <span title={closedInfo(activeConv)!.title} style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)' }}>
                          {closedInfo(activeConv)!.long}
                        </span>
                      )}
                    </div>
                    {activeOrder && <OrderLine facts={activeOrder} />}
                    {activeAddress && activeConv && (
                      <AddressLine address={activeAddress} editable={addressEditable}
                        onEdit={() => setAddrEdit({ convId: activeConv.id, busy: false, error: '' })} />
                    )}
                    <div style={{ fontSize: '0.6875rem', color: 'var(--fg-muted)', marginTop: '0.125rem', display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                      <span>{activeConv.panel_name || activeConv.site_name}</span>
                      {activeConv.visitor_phone && (
                        <>
                          <span>·</span>
                          <a href={`tel:${activeConv.visitor_phone}`} style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <Phone size={10} /> {activeConv.visitor_phone}
                          </a>
                        </>
                      )}
                    </div>
                  </div>

                  {canReply && (
                    // May shrink (minWidth 0) so that, with Take from X and Transfer added, a narrow
                    // thread wraps the buttons onto a second row instead of pushing them off screen.
                    <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 1, minWidth: 0, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                      {/* Refund / Ship again: verified customers only; internal, the customer is told nothing */}
                      {canCases && !isVisitorChat(activeConv) && (activeConv.case_kind ? (
                        <>
                          <CaseChip kind={activeConv.case_kind} by={activeConv.case_marked_by} at={activeConv.case_marked_at} status={activeConv.status} role={activeConv.case_mark_role} big />
                          <button className="btn btn-outline btn-sm" title="Take it out of this list: the chat goes back to where it was" onClick={() => markCase(null)}>Remove</button>
                          {activeConv.case_kind === 'refund' && isSuperAdmin(user) && threadRefund?.id === activeConv.id && threadRefund.state && (
                            <RefundFormControl token={token} conversationId={activeConv.id} state={threadRefund.state} onChanged={() => fetchThread(activeConv.id, true)} onAlert={showAlert}
                              label={supportLabel(activeConv.site_name || activeConv.panel_name)} />
                          )}
                        </>
                      ) : (
                        <>
                          {/* Who may mark is the server's call (staff.can_mark_case: a senior or Super Admin;
                              a junior only while every senior is away). Off: the reason on hover. */}
                          {staff?.mark_override && staff.mark_note && (
                            <span style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px', borderRadius: 9999, background: '#fef3c7', color: '#b45309' }}>
                              {staff.mark_note}
                            </span>
                          )}
                          <button className="btn btn-outline btn-sm" disabled={!staff?.can_mark_case}
                            title={staff?.can_mark_case ? 'Mark this customer for a refund. Internal only: the customer is not told.' : (staff?.mark_note || undefined)}
                            onClick={() => markCase('refund')}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Undo2 size={13} /> Refund</button>
                          <button className="btn btn-outline btn-sm" disabled={!staff?.can_mark_case}
                            title={staff?.can_mark_case ? 'Mark this order to be shipped again. Internal only: the customer is not told.' : (staff?.mark_note || undefined)}
                            onClick={() => markCase('reship')}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Truck size={13} /> Ship again</button>
                        </>
                      ))}
                      {/* Take over, Take from X, Transfer, Hand to AI, Close: only what the server says this
                          login may do on this chat (staff). Someone else's chat: read only, with their name. */}
                      {staff && (staff.can_act || staff.take) ? (
                        <>
                          {activeConv.status !== 'agent_handling' && staff.can_act && (
                            <button className="btn btn-primary btn-sm" onClick={() => changeStatus('agent_handling')}
                              title={staff.claims ? 'This chat becomes yours' : undefined}>Take over</button>
                          )}
                          {staff.take && staff.holder && (
                            <button className={`btn btn-sm ${staff.can_act ? 'btn-outline' : 'btn-primary'}`} onClick={() => changeStatus('agent_handling', true)}
                              title={staff.take === 'holder_away'
                                ? `${staff.holder.name} has not been in ShipTrack for a while and the customer is waiting: this chat becomes yours`
                                : `This chat becomes yours (${staff.holder.name} has it now)`}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <Hand size={13} /> {takeLabel}
                            </button>
                          )}
                          {staff.transfer_to.length > 0 && activeConv.status !== 'resolved' && (
                            <button className="btn btn-outline btn-sm" onClick={() => setTransferEdit({ convId: activeConv.id, busy: false, error: '' })}
                              title="Give this chat to someone else, with a one-line note for the team"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ArrowRightLeft size={13} /> Transfer</button>
                          )}
                          {/* Hot chat (hot_lock, owner 2026-10-02): a member sees both off; why is the line below. */}
                          {activeConv.status === 'agent_handling' && !activeConv.case_kind && staff.can_act && (
                            <button className="btn btn-outline btn-sm" disabled={!!hotLock && !hotLock.can_hand_to_ai}
                              title={hotLock && !hotLock.can_hand_to_ai && hotLock.lock_reason ? hotLock.lock_reason : undefined}
                              onClick={() => changeStatus('ai_handling')}>Hand to AI</button>
                          )}
                          {activeConv.status !== 'resolved' && staff.can_act && (
                            <button className="btn btn-outline btn-sm" disabled={!!hotLock && !hotLock.can_close}
                              title={hotLock && !hotLock.can_close && hotLock.lock_reason ? hotLock.lock_reason : undefined}
                              onClick={() => changeStatus('resolved')}>Close</button>
                          )}
                        </>
                      ) : staff ? (
                        <span title={staff.holder ? `Ask ${staff.holder.owner ? 'Super Admin' : `${staff.holder.name} or Super Admin`} to transfer it to you` : undefined}
                          style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                          <Lock size={12} /> {readOnlyText}
                        </span>
                      ) : null}
                    </div>
                  )}

                  {/* Why Refund / Ship again is off (the server's staff.mark_note), as a small line of its own on
                      every screen size: a phone has no hover (owner answer A6, 2026-10-02). */}
                  {canReply && canCases && !isVisitorChat(activeConv) && !activeConv.case_kind && staff && !staff.can_mark_case && staff.mark_note && (
                    <div style={{ flexBasis: '100%', minWidth: 0, marginTop: '-0.5rem', fontSize: '0.6875rem', color: 'var(--fg-muted)', textAlign: 'right', wordBreak: 'break-word' }}>
                      Refund / Ship again: {staff.mark_note}
                    </div>
                  )}

                  {/* Why Close / Hand to AI are off on a hot chat (the server's hot_lock.lock_reason), the same
                      kind of line, on every screen size: a phone has no hover (owner 2026-10-02). */}
                  {canReply && staff?.can_act && activeConv.status !== 'resolved' && hotLock?.lock_reason && (
                    <div style={{ flexBasis: '100%', minWidth: 0, marginTop: '-0.5rem', fontSize: '0.6875rem', color: 'var(--fg-muted)', textAlign: 'right', wordBreak: 'break-word' }}>
                      <Lock size={10} style={{ verticalAlign: '-1px', marginRight: 3 }} />Close / Hand to AI: {hotLock.lock_reason}
                    </div>
                  )}

                  {/* Chikki's own Refund mark (owner 2026-10-02): the customer was told a refund form will come
                      in this chat, and only the Super Admin sends it. Until a form link or a request exists. */}
                  {canReply && canCases && isSuperAdmin(user) && activeConv.case_kind === 'refund' && activeConv.case_marked_by === AUTO_MARK_NAME
                    && threadRefund?.id === activeConv.id && threadRefund.state && !threadRefund.state.link && !threadRefund.state.request && (
                    <div style={{ flexBasis: '100%', minWidth: 0, marginTop: '-0.5rem', fontSize: '0.6875rem', fontWeight: 600, color: '#b45309', textAlign: 'right', wordBreak: 'break-word' }}>
                      Chikki promised a refund form - press Send refund form
                    </div>
                  )}

                  {/* Subject: the customer's current concern, on its own line across the header */}
                  {activeSubject && (
                    <div title={activeSubject.summary ? `${activeSubject.label}: ${activeSubject.summary}` : activeSubject.label} style={{
                      flexBasis: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.5rem',
                      padding: '0.375rem 0.625rem', borderRadius: 8,
                      background: 'var(--bg-subtle, rgba(0,0,0,0.04))', border: '1px solid var(--border)',
                    }}>
                      <span style={{
                        fontSize: '0.6875rem', padding: '2px 8px', borderRadius: 9999, fontWeight: 700,
                        flexShrink: 0, whiteSpace: 'nowrap',
                        background: subjectStyle(activeSubject.label).bg, color: subjectStyle(activeSubject.label).fg,
                      }}>
                        {displaySubjectLabel(activeSubject.label)}
                      </span>
                      {activeSubject.summary && (
                        <span style={{
                          flex: 1, minWidth: 0, fontSize: '0.8125rem', fontWeight: 500, color: 'var(--fg)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {activeSubject.summary}
                        </span>
                      )}
                      {activeSubject.updatedAt && (
                        <span style={{ marginLeft: 'auto', fontSize: '0.625rem', color: 'var(--fg-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                          updated {timeAgo(activeSubject.updatedAt)}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Team only: the last transfer (who to whom, when, the note) and the History of who held
                      the chat. STAFF ONLY and outside the message list, and it cannot be selected, so a
                      note never ends up pasted into a reply: the customer and the AI never see it. */}
                  {(() => {
                    const lastTransfer = teamLog.find(e => e.kind === 'transfer');
                    if (!lastTransfer) return null;
                    const me = staff?.me ?? null;
                    const side = (key: string | null, name: string | null) => (!key ? 'open pool' : me && key === me ? 'You' : name || 'a former member');
                    const line = `${side(lastTransfer.from_owner, lastTransfer.from_name)} → ${side(lastTransfer.to_owner, lastTransfer.to_name)} · ${logTime(lastTransfer.created_at)}${lastTransfer.note ? ` · ${lastTransfer.note}` : ''}`;
                    return (
                      <div style={{
                        flexBasis: '100%', minWidth: 0, fontSize: '0.75rem', padding: '0.375rem 0.625rem', borderRadius: 8,
                        background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', userSelect: 'none', WebkitUserSelect: 'none',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', minWidth: 0 }}>
                          <Lock size={12} style={{ flexShrink: 0 }} />
                          <span title={`Team only: ${line}`} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <b>Team only</b> · {line}
                          </span>
                          <button type="button" onClick={() => setTeamLogOpen(o => !o)} aria-expanded={teamLogOpen}
                            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 2, border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontWeight: 600, color: 'inherit' }}>
                            History <ChevronDown size={12} style={{ transition: 'transform .15s', transform: teamLogOpen ? 'rotate(180deg)' : 'none' }} />
                          </button>
                        </div>
                        {teamLogOpen && (
                          <ol style={{ listStyle: 'none', margin: '0.375rem 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {teamLog.map(e => (
                              <li key={e.id} style={{ wordBreak: 'break-word' }}>
                                <span style={{ fontVariantNumeric: 'tabular-nums', marginRight: '0.375rem', opacity: 0.8 }}>{logTime(e.created_at)}</span>
                                {teamLogLine(e, me)}{e.note ? ` · “${e.note}”` : ''}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    );
                  })()}

                  {/* How upset the customer is, right beside Take over / Close */}
                  {activeHealth && (
                    <HealthBar score={activeHealth.score} reason={activeHealth.reason} updatedAt={activeHealth.updatedAt} />
                  )}
                </div>
  );
}
