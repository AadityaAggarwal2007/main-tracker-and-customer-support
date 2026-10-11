'use client';

import { Compass, BadgeCheck } from 'lucide-react';
import { displaySubjectLabel } from '@/lib/chat/inbox-topics';
import { AUTO_MARK_NAME } from '@/lib/chat/tracking-claim';
import { nextStep } from '@/lib/chat/next-step';
import type { Conversation, OrderFacts } from '../_lib/types';
import { msSince } from '../_lib/inbox';

// "What to do next" (owner 2026-10-08): one card under the thread header: what this customer needs
// and up to three steps. Staff only; the words live in src/lib/chat/next-step.ts.
export default function NextStep({ conv, order, subjectLabel, health, waitingSince, promiseDue, heldByName, heldByMe, canReply, canVerify, onVerify }: {
  conv: Conversation;
  order: OrderFacts | null;
  subjectLabel: string | null;
  health: number | null;
  waitingSince: string | null;
  promiseDue: boolean;
  heldByName: string | null;
  heldByMe: boolean;
  canReply: boolean;
  // "Team ka Verify button" (owner 2026-10-11): the server's staff.can_verify; the team types the
  // order ID + full phone for a website / email chat that is not verified yet.
  canVerify: boolean;
  onVerify: () => void;
}) {
  const known = !!conv.verified_order_id || !!conv.phone_match_order_id;
  const s = nextStep({
    status: conv.status,
    known,
    verified: !!conv.verified_order_id,
    subject: subjectLabel ? displaySubjectLabel(subjectLabel) : null,
    caseKind: conv.case_kind ?? null,
    caseByChikki: conv.case_marked_by === AUTO_MARK_NAME,
    reshipped: !!conv.reshipped_at,
    threat: !!conv.health_threat,
    accuse: !!conv.health_accuse,
    chargeback: !!conv.chargeback_open,
    health,
    waitingMs: waitingSince ? msSince(waitingSince) : null,
    returned: !!conv.returned,
    promiseDue,
    order: order ? { delivered: order.delivered, mode: order.mode } : null,
    heldBy: heldByName,
    heldByMe,
    canReply,
  });
  // Not verified yet (a visitor, or an old phone match): the team can verify it here when the customer
  // gave both. The server decides who may (never a WhatsApp chat); the button only opens the dialog.
  const verifyButton = canVerify && !conv.verified_order_id && conv.source !== 'whatsapp' && conv.status !== 'resolved';
  return (
    <div className={`next-step ns-${s.tone}`} role="note" aria-label="What to do next">
      <Compass size={16} className="ns-icon" />
      <div className="ns-body">
        <div className="ns-wants">{s.wants}</div>
        <ol className="ns-steps">
          {s.steps.map((x, k) => <li key={k}>{x}</li>)}
        </ol>
        {verifyButton && (
          <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 6 }} onClick={onVerify}
            title="The customer gave the order ID and the full phone number: type both here to verify this chat">
            <BadgeCheck size={13} /> Verify
          </button>
        )}
      </div>
    </div>
  );
}
