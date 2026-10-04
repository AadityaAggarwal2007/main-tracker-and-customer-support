'use client';

import { RotateCw, Info, Check, Undo2, Clock, PhoneCall, Truck, User, CalendarClock } from 'lucide-react';
import { healthLevel } from '@/lib/chat/health-rules';
import { formatWaiting, waitingLevel, type WaitingLevel } from '@/lib/chat/waiting';
import { AUTO_MARK_NAME } from '@/lib/chat/tracking-claim';
import { msSince, CASE_LABELS, timeAgo, waitingText, SUBJECT_MONEY, SUBJECT_CHANGE, SUBJECT_PROBLEM } from '../_lib/inbox';

// ── The one chip of the inbox (globals.css .chip) ──────────────
// 11px, 600, 2px 8px, round, a tone from the page tokens. Every badge / tag / pill in
// the inbox is one of these (owner, 2026-10-03: "rows me bahut chips", "rang ek jaise nahi").
export type ChipTone = 'muted' | 'primary' | 'ok' | 'warn' | 'danger' | 'info';

export function Chip({ tone = 'muted', title, className, children }: { tone?: ChipTone; title?: string; className?: string; children: React.ReactNode }) {
  return <span className={`chip chip-${tone}${className ? ` ${className}` : ''}`} title={title}>{children}</span>;
}

// A chat's status as a tone: Needs you red, with a person blue, with the AI light blue, Closed grey.
export const statusTone = (status: string): ChipTone =>
  status === 'human_needed' ? 'danger' : status === 'agent_handling' ? 'primary' : status === 'ai_handling' ? 'info' : 'muted';

// A subject label by kind of concern, so the team can tell at a glance: money (amber),
// a change the customer asks for (blue), something that went wrong (red), anything else (grey).
export function subjectTone(label: string): ChipTone {
  if (SUBJECT_MONEY.includes(label)) return 'warn';
  if (SUBJECT_CHANGE.includes(label)) return 'info';
  if (SUBJECT_PROBLEM.includes(label)) return 'danger';
  return 'muted';
}

// The customer's frustration level as a tone: Calm green, Uneasy amber, Frustrated / Critical red.
export const healthTone = (score: number): ChipTone => {
  const k = healthLevel(score).key;
  return k === 'calm' ? 'ok' : k === 'uneasy' ? 'warn' : 'danger';
};

// "Waiting 40m": grey under an hour, amber up to 2 hours, red from then on.
const WAITING_TONE: Record<WaitingLevel, ChipTone> = { fresh: 'muted', soon: 'warn', overdue: 'danger' };

// A visitor whose number is a customer's: not verified (the AI still asks for
// order ID + phone), but the team can place them.
export function PhoneMatchBadge({ orderId, compact = false }: { orderId?: string | null; compact?: boolean }) {
  return (
    <Chip tone="info" title={`The number this person typed or saved is on order ${orderId || ''}. Not verified: the AI shares no order details until they give the order ID and the phone number.`}>
      <PhoneCall /> Phone match{orderId && !compact ? ` ${orderId}` : ''}
    </Chip>
  );
}

// A chat that has not proved an order (no verified order, no phone match).
export function VisitorChip() {
  return (
    <Chip tone="muted" title="Has not proved an order: no order ID + phone, and the number is on no order">
      <User /> Visitor
    </Chip>
  );
}

export function WaitingChip({ since }: { since: string }) {
  const ms = msSince(since);
  if (Number.isNaN(ms)) return null;
  return (
    <Chip tone={WAITING_TONE[waitingLevel(ms)]} title={`The customer has waited ${formatWaiting(ms)} for an answer (their last message is unanswered)`}>
      <Clock /> Waiting {waitingText(ms)}
    </Chip>
  );
}

// Chikki told this upset customer, while the office was closed (night, weekend, holiday), that the
// team sits down with their case first thing when it opens (closed-hours.ts, owner 2026-10-05).
// "Promised Mon 10 AM" until then, red "Promise due" once that time has come; gone as soon as a
// team member writes in the chat.
export function PromiseChip({ dueAt }: { dueAt: string }) {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return null;
  const when = new Date(due).toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const now = Date.now();
  const late = now >= due;
  return (
    <Chip tone={late ? 'danger' : 'warn'} title={`While the office was closed, Chikki told this customer the team will take up their case first thing ${when}. ${late ? 'That time has come: reply now.' : 'Reply by then.'} The chip goes once a team member writes.`}>
      <CalendarClock /> {late ? `Promise due · ${when}` : `Promised ${when}`}
    </Chip>
  );
}

// A chat the system closed after 4 quiet days that the customer has since written
// in again (it opened by itself): sits near the top until a person closes it or
// takes it over, so it is seen and closed fast. The team's own Close is not tagged.
export function CameBackChip({ closedAt }: { closedAt?: string | null }) {
  const when = closedAt ? new Date(closedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
  return (
    <Chip tone="info" title={`Closed by AI${when ? ` on ${when}` : ''} after 4 quiet days. The customer has written again, so it opened itself. Close it or take it over.`}>
      <RotateCw /> Came back
    </Chip>
  );
}

// The Refund / Ship again mark. `big` (the thread header) adds who marked it and when as
// plain text after the chip, so the chip itself stays short.
export function CaseChip({ kind, by, at, status, role, big = false }: { kind: string; by?: string | null; at?: string | null; status?: string | null; role?: string | null; big?: boolean }) {
  const when = at ? new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '';
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
    <>
      <Chip tone={red ? 'danger' : refund ? 'warn' : 'info'} title={title}>
        {refund ? <Undo2 /> : <Truck />} {red ? `${CASE_LABELS[kind] || kind} · needs you` : CASE_LABELS[kind] || kind}
      </Chip>
      {big && by ? <span style={{ fontWeight: 500 }}>· {by}{when ? `, ${when}` : ''}</span> : null}
    </>
  );
}

// The customer's frustration on a list row: a small % chip from "Uneasy" up,
// coloured by level, with the reason on hover. Calm customers show nothing.
export function HealthBadge({ score, reason }: { score?: number | null; reason?: string | null }) {
  if (score == null || score < 25) return null;
  const lvl = healthLevel(score);
  return (
    <Chip tone={healthTone(score)} title={`${lvl.label} · ${score}%${reason ? ` — ${reason}` : ''}`}>
      {score}%
    </Chip>
  );
}

// The customer's frustration in the thread header: "Critical 77%", the reason on hover.
export function HealthChip({ score, reason, updatedAt }: { score: number; reason?: string | null; updatedAt?: string | null }) {
  const lvl = healthLevel(score);
  return (
    <Chip tone={healthTone(score)} title={`${lvl.label} ${score}%${reason ? ` — ${reason}` : ''}${updatedAt ? ` · updated ${timeAgo(updatedAt)}` : ''}`}>
      {lvl.label} {score}%
    </Chip>
  );
}

// Green "✓ #5115" for a customer who proved their order. A 'legacy' tag
// (chat-verified-legacy.sql) gets an amber "Old check" instead: that order was
// found by an older phone/email lookup in this chat. Since 2026-09-30 the AI
// treats it as verified in this chat too (the owner: never ask a verified
// customer again); the amber badge only tells staff how it was found.
export function VerifiedBadge({ orderId, via }: { orderId?: string | null; via?: string | null }) {
  if (via === 'legacy') {
    return (
      <Chip tone="warn" title="Found by an older phone/email lookup in this chat, not with order ID + phone. The AI still treats this chat as verified for this order.">
        <Info /> Old check{orderId ? ` ${orderId}` : ''}
      </Chip>
    );
  }
  return (
    <Chip tone="ok" title={orderId ? `Verified order ${orderId}` : 'Verified customer'}>
      <Check /> {orderId || 'Verified'}
    </Chip>
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

// Ship again's second state (owner 2026-10-03, "humne kisko bhej diya kisko nahi"): until the team
// sends the new parcel the chat says "To ship"; a staff reply with the new tracking link / AWB, or the
// Mark reshipped button, turns it into "Reshipped · AWB … · by · when" (chat-reship-done.sql).
export function ReshipChip({ c, big = false }: { c: { reshipped_at?: string | null; reshipped_by?: string | null; reship_awb?: string | null; reship_link?: string | null }; big?: boolean }) {
  if (c.reshipped_at) {
    const when = new Date(c.reshipped_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    const detail = `${c.reship_awb ? ` · AWB ${c.reship_awb}` : ''}${c.reshipped_by ? ` · ${c.reshipped_by}` : ''} · ${when}`;
    return <Chip tone="ok" title={`New parcel sent${detail}`}>Reshipped{big ? detail : ''}</Chip>;
  }
  return (
    <Chip tone="warn" title="New parcel not sent yet: ship it again (fship), paste the new tracking link in the chat, or press Mark reshipped">
      {big ? 'New parcel not sent yet' : 'To ship'}
    </Chip>
  );
}
