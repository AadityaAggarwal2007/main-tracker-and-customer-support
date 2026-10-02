'use client';

import { RotateCw, Info, UserCheck, Undo2, Clock, PhoneCall, Truck } from 'lucide-react';
import { healthLevel } from '@/lib/chat/health-rules';
import { formatWaiting, waitingLevel } from '@/lib/chat/waiting';
import { AUTO_MARK_NAME } from '@/lib/chat/tracking-claim';
import { WAITING_STYLE, msSince, CASE_LABELS, timeAgo } from '../_lib/inbox';

// A visitor whose number is a customer's: not verified (the AI still asks for
// order ID + phone), but the team can place them.
export function PhoneMatchBadge({ orderId, compact = false }: { orderId?: string | null; compact?: boolean }) {
  return (
    <span title={`The number this person typed or saved is on order ${orderId || ''}. Not verified: the AI shares no order details until they give the order ID and the phone number.`} style={{
      fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
      background: '#dbeafe', color: '#1d4ed8', whiteSpace: 'nowrap',
    }}>
      <PhoneCall size={10} /> Phone match{orderId && !compact ? ` · ${orderId}` : ''}
    </span>
  );
}

export function WaitingChip({ since, big = false }: { since: string; big?: boolean }) {
  const ms = msSince(since);
  if (Number.isNaN(ms)) return null;
  const st = WAITING_STYLE[waitingLevel(ms)];
  return (
    <span title={`The customer has waited ${formatWaiting(ms)} for an answer (their last message is unanswered)`} style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0, whiteSpace: 'nowrap',
      fontSize: big ? '0.6875rem' : '0.625rem', padding: big ? '2px 8px' : '1px 6px', borderRadius: big ? 9999 : 4,
      fontWeight: 700, background: st.bg, color: st.fg,
    }}>
      <Clock size={big ? 11 : 10} /> Waiting {formatWaiting(ms)}
    </span>
  );
}

// A chat the system closed after 4 quiet days that the customer has since written
// in again (it opened by itself): sits near the top until a person closes it or
// takes it over, so it is seen and closed fast. The team's own Close is not tagged.
export function CameBackChip({ closedAt, big = false }: { closedAt?: string | null; big?: boolean }) {
  const when = closedAt ? new Date(closedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
  return (
    <span title={`Closed by AI${when ? ` on ${when}` : ''} after 4 quiet days. The customer has written again, so it opened itself. Close it or take it over.`} style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0, whiteSpace: 'nowrap',
      fontSize: big ? '0.6875rem' : '0.625rem', padding: big ? '2px 8px' : '1px 6px', borderRadius: big ? 9999 : 4,
      fontWeight: 700, background: '#dbeafe', color: '#1d4ed8',
    }}>
      <RotateCw size={big ? 11 : 10} /> Came back
    </span>
  );
}

export function CaseChip({ kind, by, at, status, role, big = false }: { kind: string; by?: string | null; at?: string | null; status?: string | null; role?: string | null; big?: boolean }) {
  const when = at ? new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '';
  const refund = kind === 'refund';
  // Chikki's own Ship again mark (owner 2026-10-02): a live mark came with the new-link promise; a chat
  // moved in the one-time move of 2 Oct (actor_role 'backfill') got no message, its customer hears of
  // the new link at their next question about it (the one reminder).
  const auto = by === AUTO_MARK_NAME;
  const moved = auto && role === 'backfill';
  // Chikki's own Refund mark (owner 2026-10-02): the customer was told their refund is being processed
  // and that a refund form will come in this chat; only the Super Admin sends it and closes the chat.
  const autoRefund = refund && auto;
  // Red (owner 2026-10-02, answer 8): a Ship again chat waiting for a person (the customer wrote again,
  // or it was already in Needs you). It stays in Ship again and also shows in Needs you until a person
  // replies, takes it over, closes it or removes the mark. Chikki's own Refund mark keeps a chat that
  // was already in Needs you there too: the same red.
  const red = (kind === 'reship' || autoRefund) && status === 'human_needed';
  const who = `${CASE_LABELS[kind] || kind}${by ? ` · marked by ${by}` : ''}${when ? ` · ${when}` : ''}.`;
  const movedNote = 'Moved here in the one-time move of 2 Oct: the move sent the customer no message.';
  const refundPromise = 'The customer was told: their refund is being processed and a refund form will come in this chat. Only the Super Admin sends it.';
  const title = red
    // A staff mark sends the customer nothing, so only Chikki's live mark carries a promise.
    ? `${who} ${autoRefund ? refundPromise : moved ? movedNote : auto ? 'The customer was promised a new tracking link.' : 'Customer wrote again.'} A person must reply now.`
    : `${who} ${autoRefund ? refundPromise : moved ? `${movedNote} Their next question about the link gets the 24-48 hour line.` : auto ? 'The customer was told: new tracking link here within 24-48 hours.' : 'Internal only: the customer is not told.'}`;
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0, whiteSpace: 'nowrap',
      fontSize: big ? '0.6875rem' : '0.625rem', padding: big ? '2px 8px' : '1px 6px', borderRadius: big ? 9999 : 4, fontWeight: 700,
      background: red ? '#fee2e2' : refund ? '#fef3c7' : '#e0e7ff', color: red ? '#b91c1c' : refund ? '#92400e' : '#3730a3',
    }}>
      {refund ? <Undo2 size={big ? 11 : 10} /> : <Truck size={big ? 11 : 10} />} {red ? `${CASE_LABELS[kind] || kind} · needs you` : CASE_LABELS[kind] || kind}
      {big && by ? <span style={{ fontWeight: 500 }}>· {by}{when ? `, ${when}` : ''}</span> : null}
    </span>
  );
}

// The customer's frustration on a list row: a small % pill from "Uneasy" up,
// coloured by level, with the reason on hover. Calm customers show nothing.
export function HealthBadge({ score, reason }: { score?: number | null; reason?: string | null }) {
  if (score == null || score < 25) return null;
  const lvl = healthLevel(score);
  return (
    <span title={`${lvl.label} · ${score}%${reason ? ` — ${reason}` : ''}`} style={{
      fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 700, flexShrink: 0,
      background: lvl.bg, color: lvl.fg,
    }}>
      {score}%
    </span>
  );
}

// The customer's frustration across the header: a bar, the level, and why.
export function HealthBar({ score, reason, updatedAt }: { score: number; reason?: string | null; updatedAt?: string | null }) {
  const lvl = healthLevel(score);
  return (
    <div title={reason || undefined} style={{
      flexBasis: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap',
      padding: '0.375rem 0.625rem', borderRadius: 8, background: lvl.bg, color: lvl.fg,
    }}>
      <span style={{ fontSize: '0.6875rem', fontWeight: 700, whiteSpace: 'nowrap' }}>Frustration</span>
      <span style={{ fontSize: '0.9375rem', fontWeight: 800, lineHeight: 1 }}>{score}%</span>
      <span style={{ fontSize: '0.75rem', fontWeight: 700, whiteSpace: 'nowrap' }}>{lvl.label}</span>
      <div aria-hidden style={{ flex: '0 0 96px', height: 6, borderRadius: 3, background: 'rgba(0,0,0,0.1)' }}>
        <div style={{ width: `${score}%`, height: '100%', borderRadius: 3, background: lvl.bar }} />
      </div>
      {reason && (
        <span style={{ flex: 1, minWidth: 0, fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {reason}
        </span>
      )}
      {updatedAt && (
        <span style={{ marginLeft: 'auto', fontSize: '0.625rem', opacity: 0.75, whiteSpace: 'nowrap' }}>
          updated {timeAgo(updatedAt)}
        </span>
      )}
    </div>
  );
}

// Green "Verified" tag for a customer who proved their order. A 'legacy' tag
// (chat-verified-legacy.sql) gets an amber "Old check" instead: that order was
// found by an older phone/email lookup in this chat. Since 2026-09-30 the AI
// treats it as verified in this chat too (the owner: never ask a verified
// customer again); the amber badge only tells staff how it was found.
export function VerifiedBadge({ orderId, via }: { orderId?: string | null; via?: string | null }) {
  if (via === 'legacy') {
    return (
      <span title="Found by an older phone/email lookup in this chat, not with order ID + phone. The AI still treats this chat as verified for this order." style={{
        fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
        background: '#fef3c7', color: '#b45309',
      }}>
        <Info size={10} /> Old check{orderId ? ` · ${orderId}` : ''}
      </span>
    );
  }
  return (
    <span title={orderId ? `Verified order ${orderId}` : 'Verified customer'} style={{
      fontSize: '0.625rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
      background: '#dcfce7', color: '#15803d',
    }}>
      <UserCheck size={10} /> Verified{orderId ? ` · ${orderId}` : ''}
    </span>
  );
}

// A centred line across the thread between one chat of the customer and the next.
export function ThreadDivider({ children }: { children: React.ReactNode }) {
  return (
    <div role="separator" style={{
      display: 'flex', alignItems: 'center', gap: '0.625rem', margin: '0.25rem 0',
      fontSize: '0.6875rem', fontWeight: 600, color: 'var(--fg-muted)',
    }}>
      <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      <span style={{ whiteSpace: 'nowrap' }}>{children}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  );
}
