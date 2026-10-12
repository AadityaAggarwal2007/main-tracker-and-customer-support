// ── Corrections: the pure rules (owner 2026-10-11) ────────────────────────────────────────────────
// "Customer address / pincode / phone / size / colour / product / pack / Buy 1 Get 1 change maangta hai, team
// bolti hai kal subah ho jayega, phir koi chat dobara nahi padhta": a team member presses Correction on a VERIFIED
// chat or mail, one row is made (order-corrections.sql), everyone with Open Chat Support sees it in Chat Support >
// Corrections, only the Super Admin and the Manager fix the order and mark it done. No imports: the routes, the
// screens, the Today board and the unit tests all read these. The database side is corrections.ts /
// corrections-read.ts. Nothing here is sent to a customer or read by the AI.

export const CORRECTION_KINDS = [
  { key: 'address', label: 'Address' },
  { key: 'pincode', label: 'Pincode' },
  { key: 'phone', label: 'Phone' },
  { key: 'size', label: 'Size' },
  { key: 'colour', label: 'Colour' },
  { key: 'product', label: 'Product' },
  { key: 'pack', label: 'Pack / quantity' },
  { key: 'bogo', label: 'Buy 1 Get 1' },
  { key: 'other', label: 'Other' },
] as const;
export type CorrectionKind = typeof CORRECTION_KINDS[number]['key'];
export const CORRECTION_KIND_KEYS: CorrectionKind[] = CORRECTION_KINDS.map((k) => k.key);
export const kindLabel = (k: string): string => CORRECTION_KINDS.find((x) => x.key === k)?.label ?? k;
// "Size, Colour" for a row's line; unknown keys (never stored) are shown as typed.
export const kindsText = (kinds: readonly string[] | null | undefined): string => (kinds || []).map(kindLabel).join(', ');

export type CorrectionStatus = 'pending' | 'done' | 'cancelled';
export const CORRECTION_STATUSES: CorrectionStatus[] = ['pending', 'done', 'cancelled'];
// What a Super Admin / Manager may do to a row, and the status it leaves: Mark done / Cancel on a pending row,
// Reopen on a done or cancelled one.
export type CorrectionAction = 'done' | 'cancel' | 'reopen';
export const ACTION_STATUS: Record<CorrectionAction, CorrectionStatus> = { done: 'done', cancel: 'cancelled', reopen: 'pending' };
export const ACTION_FROM: Record<CorrectionAction, CorrectionStatus[]> = { done: ['pending'], cancel: ['pending'], reopen: ['done', 'cancelled'] };
export const isCorrectionAction = (v: unknown): v is CorrectionAction => v === 'done' || v === 'cancel' || v === 'reopen';

export const NOTE_MAX = 500;
export const DONE_NOTE_MAX = 300;
// A pending correction older than this is overdue (red): the owner's "kal subah" is a day.
export const OVERDUE_MS = 24 * 60 * 60 * 1000;

export type CleanCorrection = { kinds: CorrectionKind[]; note: string } | { error: string };

// What the team typed: at least one known kind (deduplicated, in the list's order), a note of 1-500 characters with
// no "<" (it is drawn as text everywhere, but a pasted tag is never what a customer asked for). Errors in plain words.
export function cleanCorrection(input: unknown): CleanCorrection {
  const b = (input && typeof input === 'object' ? input : {}) as { kinds?: unknown; note?: unknown };
  const raw = Array.isArray(b.kinds) ? b.kinds : typeof b.kinds === 'string' ? [b.kinds] : [];
  const wanted = new Set(raw.map((k) => String(k).trim().toLowerCase()));
  const kinds = CORRECTION_KIND_KEYS.filter((k) => wanted.has(k));
  if (wanted.size !== kinds.length) return { error: 'One of the kinds is not known. Pick from the list.' };
  if (kinds.length === 0) return { error: 'Pick what the customer wants changed (address, size, colour ...).' };
  const note = typeof b.note === 'string' ? b.note.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim() : '';
  if (!note) return { error: 'Write what exactly to change (the new address, size, colour ...).' };
  if (note.length > NOTE_MAX) return { error: `Keep the note under ${NOTE_MAX} characters.` };
  if (/</.test(note)) return { error: 'The note cannot contain "<".' };
  return { kinds, note };
}

// The optional note on Mark done / Cancel: trimmed, at most 300 characters, "<" refused; empty = none.
export function cleanDoneNote(raw: unknown): { note: string | null } | { error: string } {
  if (raw == null) return { note: null };
  if (typeof raw !== 'string') return { error: 'The note must be text.' };
  const note = raw.replace(/\r\n?/g, '\n').trim();
  if (!note) return { note: null };
  if (note.length > DONE_NOTE_MAX) return { error: `Keep the note under ${DONE_NOTE_MAX} characters.` };
  if (/</.test(note)) return { error: 'The note cannot contain "<".' };
  return { note };
}

// How long a pending row has waited (ms; NaN for a bad time), and whether that is over a day.
export function pendingAge(createdAt: string | Date | null | undefined, now = Date.now()): number {
  const at = createdAt instanceof Date ? createdAt.getTime() : typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  return Number.isFinite(at) ? Math.max(0, now - at) : NaN;
}
export function isOverdue(row: { status: string; created_at: string | Date | null }, now = Date.now()): boolean {
  if (row.status !== 'pending') return false;
  const age = pendingAge(row.created_at, now);
  return Number.isFinite(age) && age >= OVERDUE_MS;
}
// "3 h", "2 d", "20 min" for a row's line.
export function ageText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

// One line for the thread's top and the Mail tab: "Correction pending · Size, Colour · by Rahul · 3 h".
export function correctionLine(row: { status: string; kinds: readonly string[]; created_by_name: string | null; created_at: string | Date | null; done_by_name?: string | null; done_at?: string | Date | null }, now = Date.now()): string {
  const by = row.created_by_name || 'team';
  if (row.status === 'pending') {
    const age = ageText(pendingAge(row.created_at, now));
    return `Correction pending · ${kindsText(row.kinds)} · by ${by}${age ? ` · ${age}` : ''}`;
  }
  const closer = row.done_by_name ? ` by ${row.done_by_name}` : '';
  return `Correction ${row.status === 'done' ? 'done' : 'cancelled'}${closer} · ${kindsText(row.kinds)} · asked by ${by}`;
}

// Active / Changed / Done (owner 2026-10-12: "kuch bhi changes ke baad ... replied aur active jaisa segment"): a pending
// correction becomes CHANGED by itself once the team edited the order's address or items in ShipTrack after it was
// written (corrections-read.ts CHANGED_SQL); it still waits for Mark done. Done = done + cancelled.
export type CorrectionSegment = 'active' | 'changed' | 'done';
export const CORRECTION_SEGMENTS: CorrectionSegment[] = ['active', 'changed', 'done'];
const timeOf = (v: string | Date | null | undefined): number => (v == null ? NaN : v instanceof Date ? v.getTime() : Date.parse(String(v)));
export function correctionSegment(row: { status: string; address_changed_at?: string | Date | null; items_changed_at?: string | Date | null }): CorrectionSegment {
  if (row.status !== 'pending') return 'done';
  return Number.isFinite(timeOf(row.address_changed_at)) || Number.isFinite(timeOf(row.items_changed_at)) ? 'changed' : 'active';
}
export type ChangedWhat = 'address' | 'items' | 'both';
export function changedWhat(addressAt: string | Date | null | undefined, itemsAt: string | Date | null | undefined): ChangedWhat | null {
  const a = Number.isFinite(timeOf(addressAt)), i = Number.isFinite(timeOf(itemsAt));
  return a && i ? 'both' : a ? 'address' : i ? 'items' : null;
}
// The newest of the two change times (ISO), or null.
export function changedAt(addressAt: string | Date | null | undefined, itemsAt: string | Date | null | undefined): string | null {
  const t = Math.max(...[timeOf(addressAt), timeOf(itemsAt)].filter(Number.isFinite));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
// "Changed · Address + items · by Sunny · 5 min ago": the line on a Changed row.
export function changedLine(row: { changed_what: ChangedWhat | null; changed_by_name?: string | null; changed_at: string | null }, now = Date.now()): string {
  const what = row.changed_what === 'both' ? 'Address + items' : row.changed_what === 'address' ? 'Address' : row.changed_what === 'items' ? 'Items' : 'Order';
  const age = row.changed_at ? ageText(Math.max(0, now - timeOf(row.changed_at))) : '';
  return `Changed · ${what}${row.changed_by_name ? ` · by ${row.changed_by_name}` : ''}${age ? ` · ${age} ago` : ''}`;
}

// The counts next to the Corrections section and on the Today board. pending = active + changed.
export interface CorrectionCounts { pending: number; overdue: number; done_today: number; active?: number; changed?: number }

// "Ask the customer to verify" (owner answer 2b): the line the team member puts in the reply box and still presses
// Send. The widget's own form is titled "Verify yourself and continue a chat" (public/widget.js), so the customer
// finds the words on their screen. Email chats use mail-view.ts ASK_VERIFY_EN / ASK_VERIFY_HINGLISH instead.
export const ASK_VERIFY_WIDGET_EN = "Please tap 'Verify yourself' at the top of this chat and enter your Order ID and the phone number on the order, so we can make this change for you.";
export const ASK_VERIFY_WIDGET_HI = "Kripya is chat ke upar 'Verify yourself' par tap karke apna Order ID aur order par likha phone number daalein, taaki hum aapke liye yeh change kar sakein.";

export const CORRECTION_TEXT = {
  verifyFirst: 'Verify this customer first: a correction is noted only on a verified order.',
  verifySenderFirst: 'Verify this sender first: a correction is noted only on a verified order.',
  pickOrder: 'This sender is verified for several orders. Say which order the correction is for.',
  wrongOrder: 'That order is not one this sender is verified for.',
  whatsapp: 'WhatsApp chats are not in Chat Support; no correction can be noted on one.',
  merged: "This chat was merged into the customer's other chat. Open that one.",
  cannot: 'You cannot note corrections',
  cannotClose: 'Only the Super Admin and the Manager mark a correction done, cancelled or reopened.',
  notInstalled: 'Corrections are not installed yet (order-corrections.sql).',
  noPanel: "This chat's site is not linked to a panel, so no order can be corrected.",
  notFound: 'That correction is not there.',
  badAction: 'Unknown action.',
  wrongState: 'That correction is not in a state this action applies to.',
};
