// Shapes the Mail tab reads from /api/mail/* (the server side: src/lib/chat/mail-inbox.ts).
import type { CasesMap } from '@/lib/chat/mail-filters';
export type { CasesMap, MailCase } from '@/lib/chat/mail-filters';
export interface Box { id: string; email: string; siteName: string; panelId: string | null; panelName: string; status: { ok: boolean; error: string | null; checkedAt: number } | null }
// convCount: in the Active / Closed cases lists (one row per customer), how many conversations the list holds of them (owner 2026-10-11)
// repliedAt: when we last wrote in the conversation after this mail (the store only; a reply closes the case, owner 2026-10-11 12:45)
export interface Item { uid: number; from: string; fromAddress: string; subject: string; date: string; unread: boolean; hasAttachment: boolean; answered: boolean; authPass?: boolean; snippet?: string; replied?: boolean; repliedAt?: string; threadCount?: number; convCount?: number }
export interface Att { index: number; filename: string; contentType: string; size: number; inline: boolean }
export interface Ver { orderId: string; byName: string; at: string; chatId: string | null }
export interface Full {
  uid: number; subject: string; date: string; from: string; fromAddress: string; to: string; cc: string; replyTo: string;
  cut?: boolean; text?: string; frame: string; remoteImages: boolean; imagesShown: boolean; attachments: Att[]; unread: boolean; answered: boolean;
}
// partial: only the quick first list (who / subject / date / flags) has arrived; the attachment icons and the automatic sender checks follow
// store: the server's database copy of this Gmail (mail-store.ts, owner 2026-10-11), with how far it got
// cases: the closed / reopened cases of this mailbox by lower-case address (mail-cases.ts, owner 2026-10-11 afternoon)
export interface ListEntry { items: Item[]; verified: Record<string, Ver[]>; cases: CasesMap; truncated: boolean; at: number; partial?: boolean; store?: { mails: number; bodies: number; syncedAt: string | null; error: string | null } | null }
// preview: the first words (from the server's copy); local: a reply just sent from ShipTrack, before Gmail's copy of it is in;
// sendState (the outbox, owner 2026-10-11): 'sending' until the worker handed it to Gmail, 'sent', or 'failed' with sendError
// and the outboxId "Try again" sends back
export interface ThreadItem {
  folder: 'inbox' | 'sent'; uid: number; from: string; to: string; subject: string; date: string; preview?: string; local?: boolean;
  sendState?: 'sending' | 'sent' | 'failed'; sendError?: string | null; outboxId?: string;
}
// The "Customer" card next to the open mail (/api/mail/customer, src/lib/chat/mail-customer.ts)
export interface CustomerOrder {
  orderId: string; chatId: string | null; byName: string; customerName: string | null; payment: 'cod' | 'prepaid' | null; total: number | null;
  facts: { order_id: string; placed_on: string | null; status: string; mode: string; delivered: boolean; eta: string | null; eta_estimated: boolean; late: { daysPast: number } | null; tracking_link: string | null; tracking_id: string | null } | null;
  items: { product_name: string; quantity: number; price: number | null }[];
  place: { city: string; state: string; pincode: string } | null;
  // The sender's email chat (owner 2026-10-13): Refund / Ship again is marked on it (mail-customer.ts).
  emailChat?: { id: string; status: string; verified: boolean; caseKind: 'refund' | 'reship' | null; caseBy: string | null } | null;
}
export interface Customer { email: string; ordersAllowed: boolean; verified: CustomerOrder[]; hints: { orderId: string; placedOn: string | null; status: string | null }[]; cases?: 'mark' | 'forward' | null }
