// ── Chargeback history: everything we have on the order behind a chargeback, in one timeline (owner 2026-10-13) ──
// Owner: "chargeback jo bhi aya woh atleast order ki chat, gmail, whatsapp sa connect toh ho jaee takki tuh kuch read
// kar paee". history.ts gathers the order, the customer's website chats, their Gmail mails (the mail store), their
// WhatsApp chat and the automatic WhatsApp messages, and the chargeback mails; this file (pure, no imports) is the shape,
// the order of the timeline and the plain text the team copies to read it with Claude, with names, phones, emails,
// links and long numbers masked.

export type HistoryChannel = 'chat' | 'email' | 'whatsapp' | 'gmail' | 'wa_auto' | 'chargeback';
export type HistoryWho = 'customer' | 'team' | 'chikki' | 'system' | 'gateway';

export interface HistoryEntry {
  at: string;                 // ISO time
  channel: HistoryChannel;
  who: HistoryWho;
  text: string;               // at most TEXT_MAX characters
  subject?: string;           // a mail's subject
  status?: string;            // an automatic WhatsApp message's status (sent / delivered / read / failed / skipped)
  link?: string;              // where to open it in ShipTrack
}

export interface HistoryOrder {
  orderId: string; panelName: string; customerName: string; placedAt: string; total: number; payment: 'COD' | 'Prepaid';
  status: string; estimatedDelivery: string | null; deliveredAt: string | null; trackingLink: string | null;
  email: string; phone: string; cancelled: boolean;
}

export interface HistorySource { kind: 'chat' | 'email' | 'whatsapp'; id: string; status: string; messages: number; link: string }

// An order the chargeback could be about, when the mail named none of ours: same amount, or the email / phone in it.
export interface HistoryCandidate { orderId: string; customerName: string; placedAt: string; total: number; status: string; why: string }

export interface ChargebackHistory {
  alert: { id: string; gateway: string; receivedAt: string; subject: string; status: string } | null;
  panelName: string;
  order: HistoryOrder | null;
  matchedBy: 'order' | 'email' | 'phone' | 'amount' | 'typed' | null;
  candidates: HistoryCandidate[];
  sources: { chats: HistorySource[]; gmail: number; waAuto: number; chargebacks: number };
  timeline: HistoryEntry[];   // oldest first
  cut: boolean;               // more than TIMELINE_MAX entries: the oldest were left out
}

export const TEXT_MAX = 1500;
export const TIMELINE_MAX = 400;

// Oldest first; the newest TIMELINE_MAX kept.
export function sortTimeline(entries: HistoryEntry[]): { timeline: HistoryEntry[]; cut: boolean } {
  const all = entries
    .filter((e) => e.text.trim() || e.subject)
    .map((e) => ({ ...e, text: e.text.length > TEXT_MAX ? `${e.text.slice(0, TEXT_MAX)}…` : e.text }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { timeline: all.slice(-TIMELINE_MAX), cut: all.length > TIMELINE_MAX };
}

// A customer's mail in the email chat AND in the mail store is one mail: the chat copy is dropped when the store holds a
// mail from the customer within 10 minutes of it.
export function dropEmailChatCopies(entries: HistoryEntry[]): HistoryEntry[] {
  const gmailIn = entries.filter((e) => e.channel === 'gmail' && e.who === 'customer').map((e) => Date.parse(e.at));
  if (!gmailIn.length) return entries;
  return entries.filter((e) => !(e.channel === 'email' && e.who === 'customer' && gmailIn.some((t) => Math.abs(t - Date.parse(e.at)) < 10 * 60_000)));
}

// ── The text to read with Claude: no name, phone, email, link, order number or other long number ──
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function maskText(text: string, names: string[] = []): string {
  let s = String(text || '')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/(?<![\w])(?:ST|AWB)[A-Z0-9]{6,}\b/gi, '[tracking id]')
    .replace(/#\s?\d{2,}/g, '[order]')
    .replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, '[phone]')
    .replace(/(?<![\d₹])(?<!(?:rs|inr)\.?\s?)\d{5,}(?!\d)/gi, '[number]');   // an amount (₹ / Rs / INR) stays
  for (const n of names.flatMap((x) => String(x || '').split(/[^\p{L}]+/u)).filter((w) => w.length >= 3)) {
    s = s.replace(new RegExp(`(?<![\\p{L}])${esc(n)}(?![\\p{L}])`, 'giu'), '[name]');
  }
  return s;
}

const IST_MS = 330 * 60_000;
export function istStamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t + IST_MS).toISOString().slice(0, 16).replace('T', ' ');
}
const CHANNEL_NAME: Record<HistoryChannel, string> = {
  chat: 'website chat', email: 'email chat', whatsapp: 'WhatsApp', gmail: 'Gmail', wa_auto: 'WhatsApp (automatic)', chargeback: 'chargeback mail',
};
const WHO_NAME: Record<HistoryWho, string> = { customer: 'CUSTOMER', team: 'TEAM', chikki: 'CHIKKI (AI)', system: 'SYSTEM', gateway: 'GATEWAY' };
export const channelName = (c: HistoryChannel) => CHANNEL_NAME[c];
export const whoName = (w: HistoryWho) => WHO_NAME[w];

// One chargeback as plain text, masked, India time. `n` numbers it when several are copied together.
export function historyText(h: ChargebackHistory, n?: number): string {
  const names = h.order ? [h.order.customerName] : [];
  const m = (s: string) => maskText(s, names).replace(/\s*\n\s*/g, ' / ').trim();
  const out: string[] = [];
  out.push(`=== Chargeback${n ? ` ${n}` : ''}${h.alert ? `: ${h.alert.gateway}, ${istStamp(h.alert.receivedAt)} IST` : ''} · panel ${h.panelName} ===`);
  if (h.alert) out.push(`Mail subject: ${m(h.alert.subject)} (status: ${h.alert.status})`);
  if (h.order) {
    const o = h.order;
    out.push(`Order: placed ${istStamp(o.placedAt)} IST · ₹${Math.round(o.total)} · ${o.payment} · now "${o.status}"${o.cancelled ? ' · CANCELLED' : ''}` +
      `${o.estimatedDelivery ? ` · estimated ${o.estimatedDelivery}` : ''}${o.deliveredAt ? ` · delivered ${istStamp(o.deliveredAt)}` : ''}` +
      ` · matched by ${h.matchedBy ?? 'unknown'}`);
  } else {
    out.push(`Order: NOT FOUND (the mail names no order of ours)${h.candidates.length ? `; ${h.candidates.length} possible order(s): ${h.candidates.map((c) => `₹${Math.round(c.total)} placed ${istStamp(c.placedAt).slice(0, 10)} (${c.why})`).join('; ')}` : ''}`);
  }
  const chats = h.sources.chats.map((c) => `${c.kind} ${c.status} (${c.messages} msgs)`).join(', ');
  out.push(`Linked: ${chats || 'no chat'} · Gmail ${h.sources.gmail} mails · WhatsApp automatic ${h.sources.waAuto} · chargeback mails ${h.sources.chargebacks}`);
  if (!h.timeline.length) out.push('(the customer never wrote to us and we never wrote to them)');
  if (h.cut) out.push(`(only the newest ${TIMELINE_MAX} entries)`);
  for (const e of h.timeline) {
    const extra = [e.subject ? `subject "${m(e.subject)}"` : '', e.status ? `[${e.status}]` : ''].filter(Boolean).join(' ');
    out.push(`${istStamp(e.at)} · ${CHANNEL_NAME[e.channel]} · ${WHO_NAME[e.who]}${extra ? ` · ${extra}` : ''}: ${m(e.text)}`);
  }
  return out.join('\n');
}
