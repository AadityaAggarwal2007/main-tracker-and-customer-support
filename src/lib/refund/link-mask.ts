// ── Refund form links: masks and the "no form" guard (owner, 2026-10-02) ──
// Pure, no imports: the ONLY refund module that src/lib/chat/** may import (refund-isolation.js pins it).
//   - maskRefundLinks: a refund link (…/refund#<token>) becomes "[refund form link]" on every staff
//     screen, in the inbox list (REFUND_LINK_SQL, used in regexp_replace) and in search. The raw link
//     exists only in the 'system' message the customer opens. The token itself is what is matched, not
//     the URL's shape (review fix 2026-10-02): with or without a scheme, any case, and percent-encoded
//     the way a mail gateway rewrites a link (Outlook Safe Links: "%2Frefund%23<token>").
//   - hasFormLink: team replies and edits with a Google Form or a refund-form link are refused (403).
//     Owner answer Q7 (2026-10-02): EVERY Google Form link is blocked (docs.google.com/forms, the
//     Workspace form docs.google.com/a/<domain>/forms, forms.gle, the old goo.gl/forms).
//   - dropFormMentions: Chikki's replies never send or mention a refund / return form (the AI guard).
//   - refundFormsOpen: the kill switch REFUND_FORMS=off, the only REFUND_* variable read outside crypto.ts.
// src/lib/chat/sensitive.ts keeps its own copy of REFUND_LINK_RE (it has no imports); the isolation
// test checks the two are the same.

// Review fix 2026-10-02: is the refund form switched on? REFUND_FORMS=off is the owner's kill switch (the
// same test as crypto.ts refundFormsState, which also knows whether the key is usable; only crypto.ts reads
// the key). Chikki's threat-on-a-late-order path (src/lib/chat/case-auto.ts) never promises a refund form
// while it is off: the Super Admin could not send one (server.ts blocks Send).
export const refundFormsOpen = (): boolean =>
  (typeof process === 'undefined' ? '' : String(process.env.REFUND_FORMS || '')).trim().toLowerCase() !== 'off';

export const REFUND_LINK_RE = /[^\s]*?(?:\/|%2F)refund(?:#|%23)[A-Za-z0-9_-]{16,}/gi;
export const REFUND_LINK_SQL = '[^[:space:]]*(/|%2F)refund(#|%23)[A-Za-z0-9_-]{16,}';   // for regexp_replace(..., 'gi')
export const REFUND_LINK_MASK = '[refund form link]';

export function maskRefundLinks(text: string): string {
  if (!text || !/refund/i.test(text)) return text;
  return text.replace(REFUND_LINK_RE, REFUND_LINK_MASK);
}

export const FORM_LINK_RE = /(?:docs\.google\.com\/(?:a\/[^\/\s]+\/)?forms|forms\.gle\/|goo\.gl\/forms|(?:\/|%2F)refund(?:#|%23)[A-Za-z0-9_-]{16,})/i;
export const hasFormLink = (text: string) => FORM_LINK_RE.test(text || '');

export const FORM_WORDS_RE = /\b(?:refund|return|exchange)\b[^.!?\n]{0,40}\bforms?\b|\bforms?\b[^.!?\n]{0,40}\b(?:refund|return|exchange)\b|\bgoogle\s*forms?\b/i;

export const FORM_FALLBACK = {
  hinglish: 'Iske liye hamari team isi chat me aapse baat karegi.',
  en: 'Our team will help you with this here in this chat.',
};
// For a chat that is not verified (review fix 2026-10-02): FORM_FALLBACK promises the team, which a
// visitor is never told (rulebook 2.9; only a verified chat can be handed over), so ai.ts sends this ask
// instead, and adds it when the dropped sentence took the order ID + phone ask with it.
export const FORM_VERIFY_ASK = {
  hinglish: 'Kripya apna order ID (order confirmation message me hai) aur order wala phone number dono ek saath bhejiye; order verify hone ke baad hi isme madad ho payegi.',
  en: "Please share your order ID (it's in your order confirmation message) and the phone number on the order, both together; we can help with this once the order is verified.",
};

const SENTENCE_SPLIT = /(?<=[.!?।])\s+/;
const mentionsForm = (s: string) => FORM_LINK_RE.test(s) || FORM_WORDS_RE.test(s);

// AI reply guard: every sentence (per line, split after . ! ? ।) with a form link or a refund / return /
// exchange form mention is dropped. A line that had text and lost all of it is dropped; blank lines
// that were there stay (3+ newlines become 2). Nothing left: the fallback line in the chat's language,
// and emptied = true, so ai.ts never sends that team line on its own (a verified chat is handed to the
// team, a visitor gets FORM_VERIFY_ASK). Unchanged text is returned as it was, byte for byte.
export function dropFormMentions(reply: string, hinglish: boolean): { text: string; changed: boolean; emptied: boolean } {
  const input = reply || '';
  if (!mentionsForm(input)) return { text: input, changed: false, emptied: false };
  const lines: string[] = [];
  let dropped = 0;
  for (const line of input.split('\n')) {
    if (!line.trim() || !mentionsForm(line)) { lines.push(line); continue; }
    const parts = line.split(SENTENCE_SPLIT).filter((s) => s.trim());
    const kept = parts.filter((s) => !mentionsForm(s));
    dropped += parts.length - kept.length;
    if (kept.length) lines.push(kept.join(' '));
  }
  if (!dropped) return { text: input, changed: false, emptied: false };
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: text || (hinglish ? FORM_FALLBACK.hinglish : FORM_FALLBACK.en), changed: true, emptied: !text };
}
