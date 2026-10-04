import type { StoredAttachment } from '@/lib/chat/attachment-rules';
import type { OrderAddress } from '@/lib/chat/order-address';

/* ═══════════ TYPES ═══════════ */
export interface AuthUser { username: string; displayName: string; role: string; businessIds: string[] | null; permissions?: string[] }
export interface Business { id: string; name: string; }

export interface Conversation {
  id: string;
  visitor_name: string | null;
  // The name staff read (src/lib/chat/display-name.ts): visitor_name when the chat has
  // a real one, else the customer name on its verified / phone-matched order.
  display_name?: string | null;
  // True when display_name is the customer name on the chat's order.
  name_from_order?: boolean;
  // When the system closed this chat after 4 quiet days (auto-close.ts), else null. On an
  // OPEN chat (returned) it means the customer wrote again after that: shown as "Came back".
  auto_closed_at?: string | null;
  returned?: boolean;
  // Who pressed Close (a team member's name) and when; null on chats closed before
  // chat-closed-by.sql. The system's own closes are marked by auto_closed_at.
  closed_by_name?: string | null;
  closed_at?: string | null;
  // Refund / Ship again (chat-cases.sql): the section this chat is in, who marked it and when.
  case_kind?: 'refund' | 'reship' | null;
  case_marked_by?: string | null;
  case_marked_at?: string | null;
  case_order_id?: string | null;
  // Who made the latest mark (chat_case_events.actor_role): 'system' = Chikki's live Ship again mark (the
  // customer was promised a new tracking link), 'backfill' = the one-time move of 2 Oct (no message sent).
  case_mark_role?: string | null;
  // Ship again: the new parcel was sent (chat-reship-done.sql, owner 2026-10-03): when, by whom, the AWB and link.
  reshipped_at?: string | null;
  reshipped_by?: string | null;
  reship_awb?: string | null;
  reship_link?: string | null;
  // Who holds the chat (chat-team.sql): a team member's key, 'owner' (the Super Admin) or null
  // (nobody). The list's `team` gives the names; on a grouped row it is the latest chat's holder.
  assigned_to?: string | null;
  assigned_at?: string | null;
  // Set on a chat merged into the customer's other one (an empty shell; the thread's answer only).
  merged_into?: string | null;
  visitor_phone: string | null;
  status: 'ai_handling' | 'agent_handling' | 'resolved' | 'human_needed';
  source: 'chat' | 'email';
  category: 'wrong_tracking' | 'refund' | 'cancellation' | 'others';
  unread_count: number;
  last_message_at: string | null;
  created_at: string;
  site_id: string;
  site_name: string;
  tracker_business_id: string | null;
  panel_name: string | null;
  last_message: string | null;
  // Set once the customer proved an order (the widget's form, or order ID +
  // phone in the chat). Unset = a visitor. verified_via 'legacy' = found by an
  // old phone/email lookup, shown as "Old check", not as Verified.
  verified_order_id?: string | null;
  verified_via?: string | null;
  // OLD chats only (chat-phone-match.sql): a visitor whose typed or saved number was on an
  // order in this panel. Retired 2026-09-30 evening: new chats never get it (a phone number
  // alone makes nobody a customer). Kept as it was, tagged "Phone match", not verification.
  phone_match_order_id?: string | null;
  // One verified customer's chats on a site share a customer_key (their
  // 10-digit phone). The list shows them as one row: thread_count chats in
  // all, group_unread unread across them, group_needs_human when any of them
  // waits for a person. The thread's answer carries their older chats in
  // `earlier`, oldest first.
  customer_key?: string | null;
  thread_count?: number;
  group_unread?: number;
  group_needs_human?: boolean;
  earlier?: EarlierChat[];
  // The customer's current concern, written by the AI after each message
  // (src/lib/chat/subject.ts): one of its SUBJECT_LABELS plus a one-line
  // summary (<= 90 chars). Null until the first subject is made.
  subject_label?: string | null;
  subject_summary?: string | null;
  subject_updated_at?: string | null;
  // Only in a search (?q=): why this chat matched, and the text around the
  // newest message that contains what was typed.
  hit_order?: boolean;
  hit_phone?: boolean;
  hit_name?: boolean;
  hit_text?: boolean;
  match_snippet?: string | null;
  // How upset the customer is, 0-100 (src/lib/chat/health.ts). health_pinned:
  // an open chat scoring HEALTH_PIN_MIN or more, listed first until it is Closed.
  health_score?: number | null;
  health_reason?: string | null;
  health_updated_at?: string | null;
  health_pinned?: boolean;
  // The customer has threatened a chargeback, police or court (health_threat),
  // or called the store a fraud (health_accuse): tags on the list row.
  health_threat?: boolean;
  health_accuse?: boolean;
  // How long the customer has waited for an answer (src/lib/chat/waiting.ts):
  // since when, and whether that is WAITING_OVERDUE_HOURS or more.
  waiting_since?: string | null;
  waiting_overdue?: boolean;
  // Threatened a chargeback / police / court or called the store a fraud, and no person has answered yet.
  urgent_waiting?: boolean;
  // Any of the row's chats (one customer's group) waits for an answer.
  group_waiting?: boolean;
  // Chikki told this customer, while the office was closed, that the team sits down with their case
  // first thing when it opens (closed-hours.ts): when that is (ISO), until a team member writes.
  promise_due_at?: string | null;
}

// One of the customer's older chats, shown read-only above the latest one.
export interface EarlierChat {
  conversation_id: string;
  created_at: string;
  status: string;
  messages: ChatMessage[];
}

// The customer's chat they wrote in after the open one (newer_chat in the
// thread's answer): named in a bar, not drawn in the thread.
export interface NewerChat {
  conversation_id: string;
  created_at: string;
  last_message_at: string | null;
  status: string;
}

export interface ChatMessage {
  id: string;
  sender: 'visitor' | 'ai' | 'agent' | 'system';   // 'system' = refund form messages (Vastora Support)
  content: string;
  metadata: {
    withheld?: string; emailed?: boolean; agent?: string; hidden?: boolean;
    attachments?: StoredAttachment[]; captionless?: boolean;
  } | null;
  created_at: string;
  edited_at?: string | null;
  edited_by?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  // The Chikki (Brain) notes the agent was shown for this reply (staff only).
  brain?: { id: string; title: string }[] | null;
  // A team reply's writer by name today (the thread's answer; staff only, the customer never
  // gets it). null when the server cannot tell yet: shown as "Team".
  author?: string | null;
  // The writer's key ('owner' or a member id) when the server knows it from the reply's event:
  // "You" still works after the owner renames this login.
  author_key?: string | null;
}

// What GET /api/chat/messages/:id returns for "View details".
export interface MessageRevision {
  action: 'edit' | 'delete';
  previous_content: string;
  new_content: string | null;
  actor: string;
  actor_role: string;
  created_at: string;
}
export interface MessageDetails {
  message: ChatMessage & { source: string };
  revisions: MessageRevision[];
  canChange: boolean;
}

// A file in the composer, from the moment it is picked until the reply is sent.
// It uploads straight away, so a failure shows on the file itself.
export interface PendingFile {
  key: string;
  file: File;
  name: string;
  size: number;
  previewUrl: string | null;
  status: 'uploading' | 'ready' | 'failed';
  progress: number;
  error?: string;
  id?: string;
}

/* ═══════════ CHAT TEAM (owner, 2026-10-01) ═══════════ */
// Who holds a chat, who may act on it, Take from X and Transfer (src/lib/chat/team-rules.ts).
// The server decides every right; the inbox only draws what it was told (`staff` in the thread's
// answer) and never guesses one of its own. A stale screen is safe anyway: the server refuses an
// action on someone else's chat with a 409 naming them, and the inbox then shows what is true.

// One person on the team (the list's answer: `team`): members who can reply, then the Super Admin
// (key 'owner'). away_min: not seen in ShipTrack for 30+ minutes during office hours (10:00-19:30),
// else null. seen_min: minutes since last seen (null: not seen since presence started).
export interface TeamMember { key: string; name: string; senior: boolean; owner: boolean; away_min: number | null; seen_min: number | null }
// Someone the open chat can be transferred to. key null = "Nobody (open pool)", Super Admin only.
export interface TransferTarget { key: string | null; name: string; senior: boolean; away_min: number | null }
// What this login may do on the open chat (the thread's answer: `staff`).
export interface StaffBlock {
  me: string | null;
  holder: { key: string; name: string; senior: boolean; owner: boolean; away_min: number | null } | null;
  can_act: boolean;      // reply, Take over, Close, Hand to AI, Transfer
  claims: boolean;       // a reply or Take over makes the chat this login's
  take: 'senior' | 'owner' | 'holder_away' | null;   // the "Take from X" button, and on what ground
  transfer_to: TransferTarget[];
  can_mark_case: boolean;
  mark_override: boolean;     // a junior may mark because every senior is away
  mark_note: string | null;   // why Refund / Ship again is off, or the override line
  office_open: boolean;
}
// Close / Hand to AI on the open chat (the thread's answer: `hot_lock`, owner 2026-10-02). On a HOT chat
// (an unanswered threat / fraud claim, At risk by the scorer's model, or Chikki's own Refund mark:
// team-rules.ts hotChat) only the Super Admin
// closes it or hands it to the AI; a member sees both off with lock_reason as a line of its own.
export interface HotLock {
  can_close: boolean;
  can_hand_to_ai: boolean;
  lock_reason: string | null;
}
// The open chat's team history (the thread's answer: `team_log`), newest first: claims, takes,
// transfers with their note, returning customers, merges. STAFF ONLY: the customer and the AI never
// see any of it. Names are as they are today.
export interface TeamLogEntry {
  id: string; created_at: string; kind: string;
  actor: string; actor_name: string | null; from_owner: string | null; to_owner: string | null;
  from_name: string | null; to_name: string | null; reason: string | null; note: string | null;
}

// The inbox tabs. All and Customers show verified customers only (plus the
// "Old check" legacy tags), Visitors the rest; the status tabs show everyone, whatever they have verified.
// A problem tab is 'topic:<key>' (src/lib/chat/inbox-topics.ts): the open chats
// about one problem, whatever their status.
// My chats (chat team, owner 2026-10-01): this login's own chats in Needs you and With team (?mine=1).
// With team keeps EVERY chat a person took over, so the Super Admin still sees them all in one place.
export type InboxTab = 'all' | 'visitors' | 'customers' | 'human_needed' | 'mine' | 'agent_handling' | 'ai_handling' | 'case:refund' | 'case:reship' | 'resolved' | `topic:${string}`;

// A chat tied to an order shows the customer name ON THE ORDER, never one the
// customer typed (display-name.ts). For a verified customer that is simply their
// name; for a phone match (not proof of who is typing) it is drawn in italics,
// with "from order" in the header, so it never reads as a proven name, on a
// phone too, where there is no hover.
export type NameSrc = { name_from_order?: boolean; phone_match_order_id?: string | null; verified_order_id?: string | null };

// The order line in the thread header: when the order was placed, where it is
// now in ShipTrack (the stage the customer's own tracking page shows) and the
// estimated delivery date. From GET /api/chat/conversations/[id] (order_facts),
// staff only.
export interface OrderFacts {
  order_id: string;
  source: 'verified' | 'phone_match';
  placed_on: string | null;
  status: string;
  mode: 'normal' | 'cancelled' | 'rto' | 'failed';
  delivered: boolean;
  eta: string | null;
  eta_estimated: boolean;
}

// The delivery address under the order line (owner, 2026-10-01: change it here instead of a
// Shopify CSV re-upload). From GET /api/chat/conversations/[id] (order_address, staff with
// orders.view); Edit only on a verified order for logins that may change orders
// (address_editable). ShipTrack's copy only: Shopify and the courier keep theirs.
export interface StaffAddress extends OrderAddress { order_id: string; edited_at: string | null; edited_by: string | null }
// The order's items (product / colour lines) the team may change from the chat (owner 2026-10-03;
// order-items-edit.sql). From GET /api/chat/conversations/[id] (order_items, items_editable).
export interface StaffOrderItem { id: string; product_name: string; quantity: number; price: number | null }
export interface StaffOrderItems { order_id: string; items: StaffOrderItem[]; edited_at: string | null; edited_by: string | null }
