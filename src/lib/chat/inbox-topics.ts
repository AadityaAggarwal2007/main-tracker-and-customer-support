// ── Problem-type tabs in the staff inbox ───────────────────────
// Asked for by the owner on 2026-09-30: next to All / Visitors / Customers /
// Needs you..., tabs for what the customer is upset about (refund or
// cancellation, wrong tracking link, order delay...), so the team gets a short,
// clear queue per problem instead of one crowded list, and can see who will not
// let go and is heading for a chargeback.
//
// A chat belongs to a tab by its subject label (subject.ts, written by the AI
// after each customer message), so it moves tabs by itself when the customer's
// concern changes. A problem tab lists OPEN chats only; a Closed chat is found
// under Closed or by search. This file has no imports: the server (the list
// filter and the counts) and the inbox page share it.

export interface InboxTopic {
  key: string;
  label: string;
  hint: string;
  // Subject labels that belong to it. Old chats still carry the labels from
  // before Refund and Cancellation became one ("Refund", "Cancellation").
  labels: string[];
}

export const REFUND_CANCEL_LABEL = 'Refund / Cancellation';

// 'risk' and 'fraud' have no labels: 'risk' is every open chat whose frustration
// score is at or above HEALTH_PIN_MIN (health-rules.ts), 'fraud' every open chat
// of a customer who has called the store a fraud, scam or fake, or threatened a
// chargeback, police, court or bad reviews (health signals), whatever it is about.
// Problem tabs list KNOWN customers only (verified, or an OLD chat whose phone
// matched an order: no new chat gets that, a phone number alone makes nobody a
// customer): visitors stay under Visitors.
export const INBOX_TOPICS: InboxTopic[] = [
  { key: 'risk', label: 'At risk', hint: 'Open chats of frustrated customers: the ones who may charge back', labels: [] },
  { key: 'fraud', label: 'Fraud / Threat', hint: 'Open chats of customers who call the store a fraud or fake, or threaten a chargeback, police or bad reviews', labels: [] },
  { key: 'refund', label: REFUND_CANCEL_LABEL, hint: 'Open chats asking for a refund or a cancellation', labels: [REFUND_CANCEL_LABEL, 'Refund', 'Cancellation'] },
  { key: 'tracking', label: 'Wrong tracking link', hint: 'Open chats saying the tracking link is wrong or shows another order', labels: ['Wrong tracking link'] },
  { key: 'delay', label: 'Order delay', hint: 'Open chats about a late order or one that has not arrived', labels: ['Delivery delay', 'Not received'] },
  { key: 'address', label: 'Address change', hint: 'Open chats about changing or correcting the address', labels: ['Address change', 'Wrong address'] },
  { key: 'damaged', label: 'Damaged / Wrong item', hint: 'Open chats about a damaged, wrong or missing item', labels: ['Damaged item', 'Wrong item', 'Missing item'] },
  { key: 'exchange', label: 'Exchange / Return', hint: 'Open chats about a size or product exchange, or a return', labels: ['Size exchange', 'Product exchange', 'Return'] },
];

export function topicByKey(key: string | null | undefined): InboxTopic | null {
  return INBOX_TOPICS.find((t) => t.key === key) || null;
}

// The label as staff read it: Refund and Cancellation are one problem.
export function displaySubjectLabel(label: string): string {
  return label === 'Refund' || label === 'Cancellation' ? REFUND_CANCEL_LABEL : label;
}

// 'a', 'b' as an SQL list of literals. The labels are constants of this file,
// never what a caller typed.
export function sqlLabelList(labels: string[]): string {
  return `ARRAY[${labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(', ')}]::text[]`;
}
