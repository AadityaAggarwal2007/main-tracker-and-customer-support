// ── Saved replies, "Notes" (owner 2026-10-13: "ladka baar baar chat gpt pa jaka edit karta ha ... note ka option dede
// upper, uspa ladka click karka brand wise apna reply save kar sakta ha woh bhi segment wise ki cancel ka yeh msg reship
// ka yeh msg, note press karta hi window open ho jaee aur staff waha sa copy karka fatafat logo ko bhej saka ... hello
// aur vastora team yeh sab prebuild") ──
// Pure (no imports): the segments, the starter texts, the checks on a saved note and how a note becomes the text that
// goes into the reply box ("Hello <first name>," + the note + "Regards, <brand> Team", the {placeholders} filled).
// Notes are per panel (brand); the server side is reply-notes.ts. Nothing is ever sent by a note: it fills the reply box
// or the clipboard, the team member presses Send.

export const NOTE_SEGMENTS = [
  { key: 'cancel', label: 'Cancel order' },
  { key: 'refund', label: 'Refund' },
  { key: 'reship', label: 'Ship again' },
  { key: 'delay', label: 'Delay / where is my order' },
  { key: 'address', label: 'Address / phone change' },
  { key: 'exchange', label: 'Size / exchange' },
  { key: 'damaged', label: 'Damaged / wrong item' },
  { key: 'payment', label: 'COD / payment' },
  { key: 'verify', label: 'Ask to verify' },
  { key: 'other', label: 'Other' },
] as const;
export type NoteSegment = typeof NOTE_SEGMENTS[number]['key'];
export const isNoteSegment = (v: unknown): v is NoteSegment => NOTE_SEGMENTS.some(s => s.key === v);
export const segmentLabel = (k: string): string => NOTE_SEGMENTS.find(s => s.key === k)?.label || 'Other';

export const NOTE_TITLE_MAX = 80;
export const NOTE_BODY_MAX = 2000;
export const NOTES_PER_PANEL_MAX = 300;

export interface ReplyNote {
  id: string; panelId: string; segment: NoteSegment; title: string; body: string;
  by: string; byName: string; at: string; updatedAt: string; starter?: boolean; canEdit?: boolean;
}

// Starter texts (shown in a segment while the panel has no note of its own there). They follow the rules every reply
// follows: no delivery day or "today", no refund amount or time, no form link, nothing asked but the order ID + phone.
export const NOTE_STARTERS: { segment: NoteSegment; title: string; body: string }[] = [
  { segment: 'verify', title: 'Ask for order ID + phone', body: 'To check your order, please share your Order ID and the full phone number used on the order.' },
  { segment: 'delay', title: 'On its way + tracking link', body: 'Your order {order} is on its way. You can follow it here: {tracking}\nWe are in touch with our courier partner and will update you as soon as we have news.' },
  { segment: 'cancel', title: 'Cancel request received', body: 'We have received your request to cancel order {order}. Our team is checking it and will update you here shortly.' },
  { segment: 'refund', title: 'Refund request noted', body: 'We have noted your refund request for order {order}. Our team will share the next steps with you here.' },
  { segment: 'reship', title: 'We are sending it again', body: 'We are sorry for the trouble with order {order}. We are arranging to send it again, and we will share the new tracking details with you once it is dispatched.' },
  { segment: 'address', title: 'Change noted', body: 'We have noted the change for order {order}. Our team will update it and confirm with you here.' },
  { segment: 'exchange', title: 'Exchange request noted', body: 'We have noted your request for order {order}. Our team will check the options and update you here.' },
  { segment: 'damaged', title: 'Sorry, tell us what was wrong', body: 'We are sorry the item was not right. Please tell us what was wrong with it, and our team will help you.' },
  { segment: 'payment', title: 'Payment question noted', body: 'Thank you for your message about the payment for order {order}. Our team is checking it and will update you here.' },
];

const FORM_LINK = /(docs\.google\.com\/forms|forms\.gle\/)/i;

// A note as typed: the segment, a title (1-80) and a body (1-2000), no "<" (it is shown as text everywhere), no form link
// (team replies with one are refused anyway; the server also runs the refund-link check and cuts link junk).
export function cleanNote(raw: unknown): { segment: NoteSegment; title: string; body: string } | { error: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { segment?: unknown; title?: unknown; body?: unknown };
  if (!isNoteSegment(r.segment)) return { error: 'Pick a segment' };
  const title = String(r.title ?? '').replace(/\s+/g, ' ').trim();
  const body = String(r.body ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!title) return { error: 'Give the note a short name' };
  if (title.length > NOTE_TITLE_MAX) return { error: `Keep the name under ${NOTE_TITLE_MAX} characters` };
  if (!body) return { error: 'Write the reply' };
  if (body.length > NOTE_BODY_MAX) return { error: `Keep the reply under ${NOTE_BODY_MAX} characters` };
  if (/[<>]/.test(title + body)) return { error: 'Leave out < and >' };
  if (FORM_LINK.test(body)) return { error: 'Form links cannot be saved in a note' };
  return { segment: r.segment, title, body };
}

export const firstName = (name: string | null | undefined): string => {
  const w = String(name || '').replace(/[^\p{L}\s.'-]/gu, ' ').trim().split(/\s+/)[0] || '';
  return w.length >= 2 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '';
};

// "Hello <first name>," + the text + "Regards, <brand> Team" (owner 2026-10-13: "hello aur vastora team yeh sab
// prebuild ho"). Used by the notes, the suggested replies and Sudharo, so every reply the team sends looks the same.
// No name = "Hello,", no brand = "Support Team".
export function wrapReply(body: string, ctx: { name?: string | null; brand?: string | null }): string {
  const name = firstName(ctx.name);
  const brand = String(ctx.brand || '').trim() || 'Support';
  const text = String(body || '').trim();
  if (!text) return text;
  return `Hello${name ? ` ${name}` : ''},\n\n${text}\n\nRegards,\n${brand} Team`;
}

// The other way: a greeting at the start ("Hi Priya,", "Hello!", "Dear customer,") and a sign-off at the end ("Regards,
// Vastora Support", "Thanks,\nTeam Vastora") cut, so a draft is never greeted or signed twice. A sentence that only
// starts with "Thank you for ..." stays.
const GREETING = /^\s*(?:hi|hello|hey|dear|namaste|hii+)\b[^\n,!.?]{0,30}(?:[,!]+[ \t]*\n*|\n+)\s*/iu;
// A sign-off starts its own line and is not a sentence ("Thank you for your patience and support" is the message, kept;
// review 2026-10-14): "Regards,\nVastora Team", "Thanks, Team Vastora", "Best regards - Support".
const SIGN_OFF = /(?:^|\n|(?<=[.!?])[ \t]+)[ \t]*(?:(?:best|warm|kind|warmest|many)\s+)?(?:regards|thanks|thank you|sincerely)(?![ \t]+(?:for|to|so|again|very)\b)[ \t]*[,!.\-]?\s*(?:team[ \t]+[^\n.!?]{1,30}|[^\n.!?]{0,40}\b(?:team|support))[ \t.!]*$/iu;
const LONE_REGARDS = /\s*\b(?:(?:best|warm|kind)\s+)?regards[ \t]*[,!.]?\s*$/i;
export function unwrapReply(text: string): string {
  const start = String(text || '').trim();
  let t = start;
  const g = t.replace(GREETING, '');
  const cutStart = !!g.trim() && g !== t;
  if (g.trim()) t = g;
  for (const re of [SIGN_OFF, LONE_REGARDS]) {
    const s = t.replace(re, '');
    if (s.trim()) t = s;
  }
  t = t.trim();
  // After a cut greeting the text starts with a capital ("Hi Priya, your order" -> "Your order"); untouched otherwise.
  return cutStart && t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

// The panel's notes as one block for the drafting model (suggest-run.ts): the team's own words, so the suggestions
// sound like the team. At most `max` notes and `maxChars` characters.
export function notesForPrompt(notes: { segment: string; title: string; body: string }[], max = 15, maxChars = 3500): string {
  const out: string[] = [];
  let used = 0;
  for (const n of notes) {
    if (out.length >= max) break;
    const line = `- [${segmentLabel(n.segment)}] ${n.title}: ${n.body.replace(/\s*\n+\s*/g, ' / ')}`;
    if (used + line.length > maxChars) break;
    out.push(line);
    used += line.length;
  }
  return out.join('\n');
}

// A stored note (chat_settings value) read back; null = not a note or removed.
export function parseStoredNote(value: string): { segment: NoteSegment; title: string; body: string } | null {
  try {
    const v = JSON.parse(value) as { segment?: unknown; title?: unknown; body?: unknown; deleted?: unknown };
    if (!v || v.deleted || !isNoteSegment(v.segment) || typeof v.title !== 'string' || typeof v.body !== 'string') return null;
    return { segment: v.segment, title: v.title, body: v.body };
  } catch { return null; }
}

// The note filled for one customer: {name} {order} {brand} {tracking}; an unknown order reads "your order", an unknown
// tracking link drops its line; with `wrap` the "Hello <name>," line and the "Regards, <brand> Team" sign-off are added
// (any greeting / sign-off the note already has is replaced, never doubled).
export function fillNote(body: string, ctx: { name?: string | null; order?: string | null; brand?: string | null; tracking?: string | null }, wrap = true): string {
  const name = firstName(ctx.name);
  const order = String(ctx.order || '').trim();
  const brand = String(ctx.brand || '').trim() || 'Support';
  const ord = order ? (order.startsWith('#') ? order : `#${order}`) : '';
  let t = body;
  t = ord ? t.replace(/\{order\}/g, ord) : t.replace(/\b(the |your )?order \{order\}/gi, (m) => (/^[A-Z]/.test(m) ? 'Your order' : 'your order')).replace(/\{order\}/g, 'your order');
  t = ctx.tracking ? t.replace(/\{tracking\}/g, ctx.tracking) : t.split('\n').filter(l => !l.includes('{tracking}')).join('\n');
  t = t.replace(/\{name\}/g, name || 'there').replace(/\{brand\}/g, brand).trim();
  return wrap ? wrapReply(unwrapReply(t), { name: ctx.name, brand }) : t;
}
