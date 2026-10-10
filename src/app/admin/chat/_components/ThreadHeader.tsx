'use client';

import { useState } from 'react';
import { Mail, MessageCircle, Phone, ChevronLeft, Undo2, Truck, ChevronDown, ArrowRightLeft, Lock, Hand, PackageCheck, ExternalLink, Smartphone } from 'lucide-react';
import { can, canRefunds, isSuperAdmin } from '@/lib/permissions';
import RefundFormControl, { type RefundThreadState } from '@/components/RefundFormControl';
import { displaySubjectLabel } from '@/lib/chat/inbox-topics';
import { AUTO_MARK_NAME } from '@/lib/chat/tracking-claim';
import type { AuthUser, Conversation, HotLock, OrderFacts, StaffAddress, StaffOrderItems, StaffBlock, TeamLogEntry } from '../_lib/types';
import { minutesText, logTime, teamLogLine, supportLabel, STATUS_LABELS, convName, nameFromOrder, nameNote, closedInfo, isVisitorChat, timeAgo } from '../_lib/inbox';
import { Chip, PhoneMatchBadge, VisitorChip, WaitingChip, CameBackChip, CaseChip, HealthChip, PromiseChip, ReshipChip, VerifiedBadge, statusTone, subjectTone } from './chips';
import { OrderLine, AddressLine, ItemsLine } from './OrderLine';
import { MoreMenu } from './MoreMenu';
import CustomerEmails from './CustomerEmails';

// The open chat's header (owner, 2026-10-03: compact, the same on a laptop and a phone).
//   Row 1  name · two chips (verified / phone match / visitor; who has it) · the actions
//   Row 2  the order in one line, the panel, the phone · Details (the address and Edit)
//   then   the Refund / Ship again mark with its form, why a button is off, the subject
//          with the urgency chips (Waiting, Came back, Critical 77%), the team-only line.
// On a phone the chips scroll sideways, the facts truncate to one line, and the actions are a
// bar under the header: Take over, Transfer, and ⋯ for the rest (MoreMenu).
export default function ThreadHeader({ activeAddress, activeItems, itemsEditable, setItemsEdit, setReshipEdit, activeConv, activeHealth, activeOrder, activePhoneMatch, activePromise, activeSubject, activeVerifiedOrder, activeVerifiedVia, activeWaiting, addressEditable, canCases, canReply, changeStatus, closeConversation, fetchThread, forText, holderAway, holderIsMe, hotLock, markCase, readOnlyText, setAddrEdit, setTeamLogOpen, setTransferEdit, showAlert, staff, takeLabel, teamLog, teamLogOpen, threadRefund, token, user, withText, insertDraft }: {
  activeAddress: StaffAddress | null;
  activeItems: StaffOrderItems | null;
  itemsEditable: boolean;
  setItemsEdit: React.Dispatch<React.SetStateAction<{ convId: string; busy: boolean; error: string } | null>>;
  setReshipEdit: React.Dispatch<React.SetStateAction<{ convId: string; busy: boolean; error: string } | null>>;
  activeConv: Conversation | null;
  activeHealth: { score: number; reason: string | null; updatedAt: string | null } | null;
  activeOrder: OrderFacts | null;
  activePhoneMatch: string | null;
  activeSubject: { label: string; summary: string; updatedAt: string | null } | null;
  activeVerifiedOrder: string | null;
  activeVerifiedVia: string | null;
  activeWaiting: string | null;
  // When Chikki said the team is back for this customer's case (closed-hours.ts), or null.
  activePromise: string | null;
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
  // Puts text into the reply box (the "Copy link" button, owner 2026-10-05); undefined = this login cannot reply here.
  insertDraft?: (text: string) => void;
}) {
  // The full address and Edit sit behind "Details": open on a laptop, closed on a phone. The
  // header only mounts in the browser once a thread has loaded, so the width is known here.
  const [detailsOpen, setDetailsOpen] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches);

  const closed = closedInfo(activeConv);
  // Who has it, or the status: "With Rahul" / "Needs you" / "With AI" / "Closed · support";
  // "· For Rahul" when it is theirs but not with them right now.
  const statusText = activeConv.status === 'agent_handling' ? withText
    : activeConv.status === 'ai_handling' ? 'With AI'
    : closed ? closed.short
    : STATUS_LABELS[activeConv.status];
  const statusTitle = [
    staff?.holder && holderAway ? `${staff.holder.name} has not been in ShipTrack for ${minutesText(staff.holder.away_min ?? 0)}` : null,
    closed ? closed.title : null,
    forText && activeConv.status === 'resolved' ? (staff?.holder?.key === 'owner' ? 'If the customer writes again, it goes to the open pool' : 'If the customer writes again, it goes to them') : null,
  ].filter(Boolean).join(' · ') || undefined;
  const cameBack = !!activeConv.auto_closed_at && activeConv.status !== 'resolved';
  const place = activeAddress ? [activeAddress.city, activeAddress.pincode].filter(Boolean).join(' ') : '';
  const subjectTitle = activeSubject
    ? `${activeSubject.summary ? `${activeSubject.label}: ${activeSubject.summary}` : activeSubject.label}${activeSubject.updatedAt ? ` · updated ${timeAgo(activeSubject.updatedAt)}` : ''}`
    : undefined;

  return (
    <div className="th">
      <button type="button" className="btn-icon chat-back" aria-label="Back to conversations" onClick={closeConversation}>
        <ChevronLeft size={20} />
      </button>

      {/* Row 1: who, with two chips: verified / phone match / visitor, and who has it */}
      <div className="th-id">
        {activeConv.source === 'email' ? <Mail className="row-icon" aria-label="Email" /> : activeConv.source === 'whatsapp' ? <Smartphone className="row-icon" aria-label="WhatsApp" /> : <MessageCircle className="row-icon" aria-label="Chat" />}
        <span className="th-name truncate" title={nameNote(activeConv)} style={{ fontStyle: nameFromOrder(activeConv) ? 'italic' : undefined }}>{convName(activeConv)}</span>
        {nameFromOrder(activeConv) && <span className="meta">(from order)</span>}
        <div className="th-chips">
          {activeVerifiedOrder ? <VerifiedBadge orderId={activeVerifiedOrder} via={activeVerifiedVia} />
            : activePhoneMatch ? <PhoneMatchBadge orderId={activePhoneMatch} /> : <VisitorChip />}
          <Chip tone={statusTone(activeConv.status)} title={statusTitle}>
            {statusText}{forText ? ` · ${forText}` : ''}
          </Chip>
        </div>
      </div>

      {canReply && (
        <div className="th-actions">
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
                    : `This chat becomes yours (${staff.holder.name} has it now)`}>
                  <Hand size={13} /> {takeLabel}
                </button>
              )}
              {staff.transfer_to.length > 0 && activeConv.status !== 'resolved' && (
                <button className="btn btn-outline btn-sm" onClick={() => setTransferEdit({ convId: activeConv.id, busy: false, error: '' })}
                  title="Give this chat to someone else, with a one-line note for the team"><ArrowRightLeft size={13} /> Transfer</button>
              )}
            </>
          ) : staff ? (
            <span className="meta" title={staff.holder ? `Ask ${staff.holder.owner ? 'Super Admin' : `${staff.holder.name} or Super Admin`} to transfer it to you` : undefined}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
              <Lock size={12} /> {readOnlyText}
            </span>
          ) : null}
          {/* The rest: inline on a laptop, behind ⋯ on a phone. */}
          <MoreMenu>
            {staff && (staff.can_act || staff.take) && (
              <>
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
            )}
            {/* Refund / Ship again: verified customers only; internal, the customer is told nothing.
                One group. Who may mark is the server's call (staff.can_mark_case: a senior or Super
                Admin; a junior only while every senior is away). Off: the reason on hover. */}
            {canCases && !isVisitorChat(activeConv) && (
              <div className="th-group">
                {activeConv.case_kind ? (
                  <button className="btn btn-outline btn-sm" title="Take it out of this list: the chat goes back to where it was" onClick={() => markCase(null)}>Remove</button>
                ) : (
                  <>
                    {staff?.mark_override && staff.mark_note && <Chip tone="warn">{staff.mark_note}</Chip>}
                    <button className="btn btn-outline btn-sm" disabled={!staff?.can_mark_case}
                      title={staff?.can_mark_case ? 'Mark this customer for a refund. Internal only: the customer is not told.' : (staff?.mark_note || undefined)}
                      onClick={() => markCase('refund')}><Undo2 size={13} /> Refund</button>
                    <button className="btn btn-outline btn-sm" disabled={!staff?.can_mark_case}
                      title={staff?.can_mark_case ? 'Mark this order to be shipped again. Internal only: the customer is not told.' : (staff?.mark_note || undefined)}
                      onClick={() => markCase('reship')}><Truck size={13} /> Ship again</button>
                  </>
                )}
              </div>
            )}
          </MoreMenu>
        </div>
      )}

      {/* Row 2: the order in one line, the panel and the phone; Details opens the address */}
      <div className="th-row th-facts meta">
        <span className="truncate">
          {activeOrder && <><OrderLine facts={activeOrder} place={place} onInsert={insertDraft} /> · </>}
          {activeConv.panel_name || activeConv.site_name}
          {activeConv.visitor_phone && (
            <> · <a href={`tel:${activeConv.visitor_phone}`}><Phone size={10} style={{ verticalAlign: '-1px' }} /> {activeConv.visitor_phone}</a></>
          )}
        </span>
        {(activeAddress || activeItems) && activeConv && (
          <button type="button" className="meta-btn" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(o => !o)}
            title="The delivery address and the items on this order">
            Details <ChevronDown />
          </button>
        )}
      </div>
      {(activeAddress || activeItems) && activeConv && detailsOpen && (
        <div className="th-details meta">
          {activeAddress && (
            <AddressLine address={activeAddress} editable={addressEditable}
              onEdit={() => setAddrEdit({ convId: activeConv.id, busy: false, error: '' })} />
          )}
          {activeItems && (
            <ItemsLine items={activeItems} editable={itemsEditable}
              onEdit={() => setItemsEdit({ convId: activeConv.id, busy: false, error: '' })} />
          )}
        </div>
      )}

      {/* A chargeback mail arrived for this customer's order (owner 2026-10-08): the same red warning for every login */}
      {activeConv?.chargeback_open && (
        <div className="th-row meta t-danger" style={{ flexBasis: '100%', minWidth: 0, fontWeight: 700 }}>
          <Chip tone="danger">Chargeback</Chip> A chargeback mail arrived for order {activeVerifiedOrder}. Stay calm, promise nothing, and do not advise the customer on chargebacks or complaints. The Super Admin handles it.
        </div>
      )}

      {/* The Gmail addresses verified for this order (owner 2026-10-08): only with Open Mail */}
      {activeConv && activeVerifiedOrder && activeVerifiedVia !== 'legacy' && can(user, 'mail.view') && (
        <CustomerEmails token={token} conversationId={activeConv.id} orderId={activeVerifiedOrder} />
      )}

      {/* Ship again's second state (owner 2026-10-03): was the new parcel sent? "To ship" until a reply
          carries the new tracking link / AWB or someone presses Mark reshipped; then Reshipped + AWB. */}
      {canReply && activeConv.case_kind === 'reship' && (
        <div className="th-row th-case meta">
          <ReshipChip c={activeConv} big />
          {activeConv.reship_link && (
            <a className="meta-btn" href={activeConv.reship_link} target="_blank" rel="noopener noreferrer" title="Open the new tracking link">
              <ExternalLink size={12} /> Open tracking
            </a>
          )}
          {!activeConv.reshipped_at && (
            <button type="button" className="btn btn-outline btn-sm" title="The new parcel was sent: note its tracking link or AWB here"
              onClick={() => setReshipEdit({ convId: activeConv.id, busy: false, error: '' })}><PackageCheck size={13} /> Mark reshipped</button>
          )}
        </div>
      )}

      {/* The Refund / Ship again mark: who, when, and (Super Admin, Refund) where the form stands */}
      {canReply && canCases && !isVisitorChat(activeConv) && activeConv.case_kind && (
        <div className="th-row th-case meta">
          <CaseChip kind={activeConv.case_kind} by={activeConv.case_marked_by} at={activeConv.case_marked_at} status={activeConv.status} role={activeConv.case_mark_role} big />
          {activeConv.case_kind === 'refund' && canRefunds(user) && threadRefund?.id === activeConv.id && threadRefund.state && (
            <RefundFormControl token={token} conversationId={activeConv.id} state={threadRefund.state} onChanged={() => fetchThread(activeConv.id, true)} onAlert={showAlert}
              label={supportLabel(activeConv.site_name || activeConv.panel_name)} />
          )}
        </div>
      )}

      {/* Why Refund / Ship again is off (the server's staff.mark_note), as a small line of its own on
          every screen size: a phone has no hover (owner answer A6, 2026-10-02). */}
      {canReply && canCases && !isVisitorChat(activeConv) && !activeConv.case_kind && staff && !staff.can_mark_case && staff.mark_note && (
        <div className="meta" style={{ flexBasis: '100%', minWidth: 0, wordBreak: 'break-word' }}>
          Refund / Ship again: {staff.mark_note}
        </div>
      )}

      {/* Why Close / Hand to AI are off on a hot chat (the server's hot_lock.lock_reason), the same
          kind of line, on every screen size: a phone has no hover (owner 2026-10-02). */}
      {canReply && staff?.can_act && activeConv.status !== 'resolved' && hotLock?.lock_reason && (
        <div className="meta" style={{ flexBasis: '100%', minWidth: 0, wordBreak: 'break-word' }}>
          <Lock size={10} style={{ verticalAlign: '-1px', marginRight: 3 }} />Close / Hand to AI: {hotLock.lock_reason}
        </div>
      )}

      {/* Chikki's own Refund mark (owner 2026-10-02): the customer was told a refund form will come
          in this chat; the Super Admin or the Manager sends it. Until a form link or a request exists. */}
      {canReply && canCases && canRefunds(user) && activeConv.case_kind === 'refund' && activeConv.case_marked_by === AUTO_MARK_NAME
        && threadRefund?.id === activeConv.id && threadRefund.state && !threadRefund.state.link && !threadRefund.state.request && (
        <div className="meta t-warn" style={{ flexBasis: '100%', minWidth: 0, wordBreak: 'break-word' }}>
          Chikki promised a refund form - press Send refund form
        </div>
      )}

      {/* The customer's current concern, with how urgent it is: Waiting, Came back, Critical 77% */}
      {(activeSubject || activeHealth || activeWaiting || activePromise || cameBack) && (
        <div className="th-row th-subject" title={subjectTitle}>
          {activeSubject && <Chip tone={subjectTone(activeSubject.label)}>{displaySubjectLabel(activeSubject.label)}</Chip>}
          <span className="summary truncate">{activeSubject?.summary || ''}</span>
          {activePromise && <PromiseChip dueAt={activePromise} />}
          {activeWaiting && <WaitingChip since={activeWaiting} />}
          {cameBack && <CameBackChip closedAt={activeConv.auto_closed_at} />}
          {activeHealth && <HealthChip score={activeHealth.score} reason={activeHealth.reason} updatedAt={activeHealth.updatedAt} />}
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
          <div className="th-team">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', minWidth: 0 }}>
              <Lock size={12} style={{ flexShrink: 0 }} />
              <span className="truncate" title={`Team only: ${line}`} style={{ flex: 1 }}>
                <b>Team only</b> · {line}
              </span>
              <button type="button" className="meta-btn" onClick={() => setTeamLogOpen(o => !o)} aria-expanded={teamLogOpen}>
                History <ChevronDown />
              </button>
            </div>
            {teamLogOpen && (
              <ol>
                {teamLog.map(e => (
                  <li key={e.id}>
                    <time>{logTime(e.created_at)}</time>
                    {teamLogLine(e, me)}{e.note ? ` · “${e.note}”` : ''}
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })()}
    </div>
  );
}
