import { canAct, takeKind, type Actor, type Holder, type TakeKind } from './team-rules';

// ── The team's Verify button in Chat Support (owner 2026-10-11 13:10) ──────────────────────────
// "Team ka Verify button": on EVERY website-widget and email chat a team member may type the Order ID
// and the customer's FULL phone number; when both match one order of the chat's own panel the chat
// becomes verified (verified_via 'team'). Until then staff could verify nobody from the inbox: only
// the widget's form, Chikki's lookup and the Mail tab's Verify a sender existed. Same proof as the
// widget form (SHIPTRACK_MASTER_RULES.md 8.1: order ID + full phone, both on the same order; a phone
// number alone never verifies), typed by a person instead of the customer. NOT for WhatsApp chats
// (they are being taken out of Chat Support). Pure rules, shared by the route, the thread's `staff`
// block (thread-staff.ts) and the unit tests; the database side is team-verify.ts.

// Wrong tries per login: 10 in 15 minutes, counted in lookup-limits.ts (shared, on globalThis).
export const VERIFY_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 };
export const verifyLimitKey = (actorKey: string) => `tv:${actorKey}`.slice(0, 200);

export const VERIFY_VIA = 'team';

// Who may: whoever may reply in the chat right now (team-rules canAct: the holder, anyone on a chat
// nobody holds, the Super Admin anywhere), on a live chat (not a merged shell) of the website widget or
// email. Someone else's chat is refused with their name, like a reply is (the take they may do first).
export function canTeamVerify(actor: Actor | null, h: Holder | null, conv: { source: string; merged_into: string | null }): boolean {
  return !!actor && !conv.merged_into && conv.source !== 'whatsapp' && canAct(actor, h);
}
export function verifyTake(actor: Actor, h: Holder | null): TakeKind | null { return takeKind(actor, h, false); }

export type VerifyInput = { orderId: string; phone: string } | { error: string };

// The 10 digits of a phone typed by the team, as orders.ts normalizePhone reads them (that file needs
// the database, this one is pure): non-digits dropped, leading zeros dropped, a +91 / 91 country code
// dropped. Anything that is not then exactly 10 digits is refused before any check (and never counted
// as a wrong try: a typo is not a guess).
export function cleanPhone(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let digits = String(raw).replace(/\D/g, '').replace(/^0+/, '');
  if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  return /^\d{10}$/.test(digits) ? digits : null;
}

// The order ID as typed, with or without "#" (verifyOrderByPhone accepts both, and the ST… tracking ID).
export function parseVerifyInput(raw: unknown): VerifyInput {
  const b = (raw && typeof raw === 'object' ? raw : {}) as { orderId?: unknown; phone?: unknown };
  // "# 1553" is "#1553" (orders.ts normalizeOrderId keeps a "#" prefix as typed).
  const orderId = typeof b.orderId === 'string' || typeof b.orderId === 'number' ? String(b.orderId).trim().replace(/^#\s+/, '#') : '';
  if (!orderId) return { error: 'Type the Order ID the customer gave.' };
  if (orderId.length > 40 || /[%_\s]/.test(orderId)) return { error: 'That does not look like an order ID. Type it as on the order, with or without #.' };
  const phone = cleanPhone(b.phone);
  if (!phone) return { error: 'Type the full 10-digit phone number on the order.' };
  return { orderId, phone };
}

// The customer's name as the widget form and Chikki's lookup clean it (a trailing "." cut).
export const cleanCustomerName = (name: unknown): string | null => {
  const s = String(name ?? '').replace(/\s*\.\s*$/, '').trim();
  return s || null;
};

// For the server log only: "#1553" -> "#**53". Never the phone.
export function maskOrder(orderId: string): string {
  const s = String(orderId || '');
  if (s.length <= 3) return '***';
  return s.slice(0, 1) + '*'.repeat(s.length - 3) + s.slice(-2);
}

export const VERIFY_TEXT = {
  noMatch: 'Order ID and phone number do not match any order of this panel. Check what the customer wrote.',
  limited: 'Too many wrong tries. Wait a few minutes and try again.',
  whatsapp: 'WhatsApp chats are not verified here.',
  merged: "This chat was merged into the customer's other chat. Open that one.",
  noPanel: 'This chat\'s site is not linked to a panel, so no order can be checked.',
  cannot: 'You cannot verify chats',
  notTeam: 'Only a verification the team made here can be removed.',
};
