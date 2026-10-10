// ── "What to do next" strip on an open chat (owner 2026-10-08) ─────────────────────────────
// The team said the inbox has no flow: nothing tells them what this customer needs or what to do.
// This file turns facts the inbox already has (subject label, order stage, waiting time, the
// Refund / Ship again mark, a threat, who holds the chat) into ONE short card: what the customer
// wants and up to three steps. Pure, no imports, STAFF SCREEN ONLY: never read by the AI, never in
// a /api/widget/* answer. It teaches nothing new: every line restates a rule that is already in
// SHIPTRACK_MASTER_RULES.md / AGENTS.md (verify with order ID + full phone first; the refund form
// is sent by the Manager / Super Admin only; never promise an amount or a time; check with family /
// neighbours when a Delivered order did not reach them). Change a line here, nowhere else.

export type NextStepTone = 'danger' | 'warn' | 'primary' | 'ok' | 'muted';

export interface NextStepInput {
  status: 'ai_handling' | 'agent_handling' | 'resolved' | 'human_needed';
  // Order ID + full phone matched (or an old phone match): a known customer; false = a visitor.
  known: boolean;
  verified: boolean;
  // Subject label as staff read it (displaySubjectLabel), or null.
  subject: string | null;
  caseKind: 'refund' | 'reship' | null;
  // The case mark was Chikki's own (AUTO_MARK_NAME).
  caseByChikki: boolean;
  reshipped: boolean;
  threat: boolean;
  accuse: boolean;
  // A chargeback mail arrived for this customer's order (src/lib/chargeback).
  chargeback?: boolean;
  health: number | null;
  // How long the customer has waited for an answer, in ms (null = not waiting).
  waitingMs: number | null;
  returned: boolean;
  // Chikki told the customer, while the office was closed, that the team takes the case up in the morning.
  promiseDue: boolean;
  // The order in the header, when there is one (verified or phone match).
  order: { delivered: boolean; mode: 'normal' | 'cancelled' | 'rto' | 'failed' } | null;
  // Another team member holds the chat (their name), else null.
  heldBy: string | null;
  heldByMe: boolean;
  canReply: boolean;
}

export interface NextStep {
  tone: NextStepTone;
  // What the customer needs, in a few words ("Refund or cancellation").
  wants: string;
  // At most three short steps, most important first.
  steps: string[];
}

const OVERDUE_MS = 2 * 60 * 60 * 1000;

export function waitedText(ms: number): string {
  const min = Math.max(1, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)} days`;
}

// What the subject means for the team. Only rules the project already has.
function bySubject(subject: string, i: NextStepInput): { wants: string; steps: string[] } | null {
  switch (subject) {
    case 'Refund / Cancellation':
    case 'Refund':
    case 'Cancellation':
      return {
        wants: 'Refund or cancellation',
        steps: [
          'Check the order stage in the header.',
          'Send it to the Manager as Refund (Send to Manager): the Manager sends the refund form.',
          'Do not promise an amount or a time in the chat.',
        ],
      };
    case 'Wrong tracking link':
      return {
        wants: 'Says the tracking link is wrong',
        steps: [
          'Open the order in the header and compare it with what the customer says.',
          'If the order was dispatched and the link is really wrong, press Ship again.',
        ],
      };
    case 'Delivery delay':
    case 'Not received':
      return i.order?.delivered
        ? {
          wants: 'Order shows Delivered, customer did not get it',
          steps: ['Ask them to check with family, neighbours, security or reception.', 'If it is still missing, hand it to a senior.'],
        }
        : {
          wants: 'Late order, has not arrived',
          steps: ['Read the stage and date in the header; use Copy link to send the tracking page.', 'Never promise arrival today, tonight or tomorrow.'],
        };
    case 'Address change':
    case 'Wrong address':
      return i.verified
        ? {
          wants: 'Wants to change or fix the address',
          steps: ['Open Details in the header and press Edit on the address.', 'This changes ShipTrack’s copy only; tell the customer what you changed.'],
        }
        : { wants: 'Wants to change the address', steps: ['Verify first: order ID and the full phone number.', 'Then edit it from Details in the header.'] };
    case 'Damaged item':
    case 'Wrong item':
    case 'Missing item':
      return {
        wants: 'Item damaged, wrong or missing',
        steps: ['Ask which item and what exactly is wrong.', 'Then mark Refund or Ship again, whichever the case needs.'],
      };
    case 'Size exchange':
    case 'Product exchange':
    case 'Return':
      return {
        wants: 'Exchange or return',
        steps: ['Ask which item and what they want instead.', 'Do not promise a pickup or delivery date.'],
      };
    default:
      return null;
  }
}

export function nextStep(i: NextStepInput): NextStep {
  const steps: string[] = [];
  const add = (s: string) => { if (steps.length < 3 && !steps.includes(s)) steps.push(s); };
  const overdue = i.waitingMs != null && i.waitingMs >= OVERDUE_MS;
  const upset = (i.health ?? 0) >= 75;

  // A finished chat needs nothing.
  if (i.status === 'resolved') {
    return { tone: 'muted', wants: 'Chat is closed', steps: ['Nothing to do. It reopens by itself if the customer writes again.'] };
  }

  // A visitor has proved nothing: the one thing to do is the verification (master rules: order ID + full phone).
  if (!i.known) {
    const ai = i.status === 'ai_handling';
    return {
      tone: ai ? 'muted' : 'primary',
      wants: 'Not verified yet',
      steps: ai
        ? ['The AI is answering. Step in only if the customer is stuck.']
        : ['Ask for the Order ID and the full phone number.', 'Share nothing about any order until both match.'],
    };
  }

  // Whose move it is and what is overdue come first.
  if (i.heldBy && !i.heldByMe) add(`${i.heldBy} has this chat. Take over only if they are away.`);
  else if (i.status === 'human_needed' && !i.heldBy) add('The AI stopped here. Reply or press Take over to make it yours.');
  else if (i.status === 'ai_handling') add('The AI is answering. Press Take over to reply yourself.');
  if (i.promiseDue) add('Chikki promised the team would take this up after 10 AM: answer first.');
  else if (overdue && i.waitingMs != null) add(`Reply first: the customer has waited ${waitedText(i.waitingMs)}.`);
  else if (i.returned) add('The customer came back after the chat was closed: answer them first.');

  // A chargeback mail has arrived for this order (owner 2026-10-08): calm, honest, no promises, no advice about it.
  if (i.chargeback) {
    add('A chargeback mail arrived for this order. The Manager handles it with the gateway.');
    add('Stay calm and polite. Do not advise the customer on chargebacks or complaints, and promise nothing.');
    add('Answer from the order facts in the header.');
    return { tone: 'danger', wants: 'Chargeback on this order', steps };
  }

  // The Refund / Ship again marks have their own routine.
  if (i.caseKind === 'refund') {
    add(i.caseByChikki
      ? 'Chikki told the customer the refund is being processed and a form will come in this chat.'
      : 'Marked Refund: the Manager sends the refund form.');
    add('Do not promise an amount or a time; keep the customer updated here.');
    return { tone: upset || overdue ? 'danger' : 'warn', wants: 'Refund case', steps };
  }
  if (i.caseKind === 'reship') {
    if (i.reshipped) {
      add('The new parcel is sent. Share its tracking link if the customer asks.');
      return { tone: 'ok', wants: 'New parcel sent', steps };
    }
    add('Send the new parcel.');
    add('Paste its tracking link in your reply, or press Mark reshipped.');
    return { tone: upset || overdue ? 'danger' : 'warn', wants: 'New parcel not sent yet', steps };
  }

  // Threats and fraud claims: calm, honest, no promises.
  if (i.threat || i.accuse) {
    add('Stay calm and polite. Do not argue or advise on chargebacks or complaints.');
    add('Answer from the order facts in the header; promise nothing you cannot keep.');
    return { tone: 'danger', wants: i.threat ? 'Threatening a chargeback, police or court' : 'Calls the store a fraud', steps };
  }

  const s = i.subject ? bySubject(i.subject, i) : null;
  const tone: NextStepTone = upset || overdue ? 'danger' : (i.health ?? 0) >= 50 ? 'warn' : 'primary';
  if (s) {
    for (const x of s.steps) add(x);
    return { tone, wants: s.wants, steps };
  }
  add('Read the last message and answer in this chat.');
  return { tone, wants: i.subject || 'Customer message', steps };
}
