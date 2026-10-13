// ── "Send via Gmail too" for a chat reply (owner 2026-10-13: "send button ke saath send via gmail bhi, kuch imp update
// hogi toh hum mail pa bhi bhejdenge") ──
// Pure (no imports): what the mail looks like and how the address is shown. chat-mail.ts finds the address (the email
// on the chat's verified order, else one verified for that order in the Mail tab) and the panel's support Gmail, and
// sends; the reply route calls it only when the team member ticked the box on that one message.

// The address on staff screens: the first two letters and the domain ("ra***@gmail.com").
export function maskEmail(email: string): string {
  const e = String(email || '').trim().toLowerCase();
  const at = e.indexOf('@');
  if (at < 1) return '';
  return `${e.slice(0, Math.min(2, at))}***${e.slice(at)}`;
}

export const looksLikeEmail = (s: unknown) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(String(s ?? '').trim());

// A new mail (not a reply in a Gmail thread): "Update on your order #3123".
export function chatMailSubject(orderId: string): string {
  const o = String(orderId || '').trim();
  return o ? `Update on your order ${o.startsWith('#') ? o : `#${o}`}` : 'An update from our support team';
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The team's text as written, then the sign-off with the brand ("Regards, VASTRIKA Support"). Links stay clickable in
// the HTML part.
export function chatMailBodies(text: string, brand: string): { textBody: string; htmlBody: string } {
  const t = String(text || '').replace(/\r/g, '').trim();
  const who = `${String(brand || '').trim() || 'Our'} Support`;
  const textBody = `${t}\n\nRegards,\n${who}`;
  const linked = esc(t).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, '<br>');
  const htmlBody = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${linked}<br><br>Regards,<br>${esc(who)}</div>`;
  return { textBody, htmlBody };
}

// Why the box is not offered on a chat, in words for the screen (null = it is offered).
export type ChatMailWhyNot = 'not_chat' | 'not_verified' | 'no_email' | 'no_gmail';
export const CHAT_MAIL_WHY_NOT: Record<ChatMailWhyNot, string> = {
  not_chat: 'Only for a website chat',
  not_verified: 'Verify the customer first: the mail goes to the email on their order',
  no_email: 'The order has no email address, and none is verified for it in Mail',
  no_gmail: 'This panel has no support Gmail connected (Settings > Gmail accounts)',
};
