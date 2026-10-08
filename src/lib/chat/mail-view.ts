// ── The Mail tab: pure helpers (owner 2026-10-08) ─────────────────────────────────────────────
// The Mail tab reads a panel's real Gmail inbox over IMAP, on demand, and stores nothing. This file holds
// the parts that need no network: the 30-day window, the order (unread first), the safe frame an HTML
// mail is shown in, and the reply text. No imports; staff screens only, never read by the AI or a widget route.

export const MAIL_DAYS = 30;
export const MAX_MAILS = 200;
export const MAX_REPLY_CHARS = 8000;

export interface MailListItem {
  uid: number;
  from: string;          // display name, else the address
  fromAddress: string;
  subject: string;
  date: string;          // ISO
  unread: boolean;
  hasAttachment: boolean;
  answered: boolean;
  // Gmail's own dmarc=pass: the sender's address is real (automatic verification needs it).
  authPass: boolean;
}

// The start of the window: IMAP SINCE works on whole days, so the day is what counts.
export function sinceDate(now: number, days = MAIL_DAYS): Date {
  return new Date(now - Math.max(1, days) * 24 * 60 * 60 * 1000);
}

// Unread first (newest first inside each group), then the read ones, newest first.
export function sortMails<T extends { unread: boolean; date: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A plain-text mail as HTML: escaped, links made clickable (stopping before closing punctuation), line breaks kept.
export function textToHtml(text: string): string {
  return escapeHtml(text || '')
    .replace(/(https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]])/g, '<a href="$1">$1</a>')
    .replace(/\r?\n/g, '<br>');
}

// What an HTML mail is wrapped in. It is shown in an iframe with sandbox="" (no scripts, no same origin),
// and this document adds its own Content-Security-Policy: no script, no frame, no form, no plugin, and no
// remote image or font unless the person pressed "Show images" (remote images tell the sender the mail was
// opened). <script>, <base>, <meta http-equiv> and event-handler attributes are also dropped here, as a
// second line behind the sandbox. Links open in a new tab.
export function frameHtml(html: string, allowImages = false): string {
  const body = (html || '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[\s\S]*$/gi, '')
    .replace(/<(base|meta|iframe|object|embed|form)\b[^>]*>/gi, '')
    .replace(/<\/(iframe|object|embed|form)\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  const img = allowImages ? "img-src data: https: http:;" : 'img-src data:;';
  const csp = `default-src 'none'; style-src 'unsafe-inline'; ${img} font-src data:;`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<base target="_blank"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>html,body{margin:0;padding:12px;background:#fff;color:#111;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;word-wrap:break-word}img{max-width:100%;height:auto}a{color:#5b21b6}table{max-width:100%}</style>'
    + `</head><body>${body}</body></html>`;
}

// True when the HTML points at a picture on the internet (so the screen can offer "Show images").
export function hasRemoteImages(html: string): boolean {
  return /<img\b[^>]*\ssrc\s*=\s*["']?https?:/i.test(html || '') || /url\(\s*["']?https?:/i.test(html || '');
}

export function replySubject(subject: string | null | undefined): string {
  const s = (subject || '').trim();
  if (!s) return 'Re: Your enquiry';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export function snippet(text: string, n = 140): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

// "Name <a@b.com>" style label for one address.
export function addressLabel(a: { name?: string | null; address?: string | null } | null | undefined): string {
  if (!a) return '';
  const name = (a.name || '').trim(), addr = (a.address || '').trim();
  return name && addr && name.toLowerCase() !== addr.toLowerCase() ? `${name} <${addr}>` : (addr || name);
}

export function cleanReply(text: unknown): { ok: true; text: string } | { ok: false; error: string } {
  const t = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
  if (!t) return { ok: false, error: 'Write the reply first.' };
  if (t.length > MAX_REPLY_CHARS) return { ok: false, error: `The reply is too long (most ${MAX_REPLY_CHARS} characters).` };
  return { ok: true, text: t };
}

// The mail id the screen and the routes pass around: a plain positive integer (an IMAP UID).
export function parseUid(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The first reply to a sender nobody has verified (owner 2026-10-08): the verification the chat also asks for,
// the ORDER ID and the FULL phone number on the order, written by the team member's own press of a button.
export const ASK_VERIFY_EN = 'Hello,\n\nTo help you with this, I first need to confirm your order. Please reply to this email with your Order ID and the full phone number on the order.\n\nThank you.';
export const ASK_VERIFY_HINGLISH = 'Namaste,\n\nAapki madad ke liye mujhe pehle aapka order confirm karna hai. Kripya is mail ke jawab mein apna Order ID aur order par likha poora phone number bhej dein.\n\nDhanyavaad.';

// ── Is the sender's address real? (owner 2026-10-08: automatic verification) ────────────────────
// Gmail writes its own "Authentication-Results: mx.google.com; ... dmarc=pass ..." at the TOP of every mail it
// receives; a header an attacker adds sits below it. Only that first line is read, only when it names
// mx.google.com, and only dmarc=pass counts (it ties the check to the From address; a bare dkim=pass or spf=pass
// can belong to the attacker's own domain).
export function gmailAuthPassed(firstAuthResults: string | null | undefined): boolean {
  const v = (firstAuthResults || '').replace(/^\s*authentication-results:\s*/i, '');
  return /^\s*mx\.google\.com\s*;/i.test(v) && /\bdmarc=pass\b/i.test(v);
}

// From a block of raw header lines (what IMAP returns for one named header): the first Authentication-Results,
// unfolded onto one line; null when there is none.
export function firstAuthResults(raw: string | Buffer | null | undefined): string | null {
  const text = (raw ? raw.toString('utf8') : '').replace(/\r?\n[ \t]+/g, ' ');
  const m = /^authentication-results:\s*(.*)$/im.exec(text);
  return m ? m[1].trim() : null;
}
