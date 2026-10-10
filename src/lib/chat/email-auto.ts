// ── Mails no person wrote: never a chat, never a Chikki reply (review 10 Oct, E1) ──
// Chikki answered a Gmail "Message blocked" bounce of one of its own replies (a reply to a bounce goes back to the
// mail system and can loop). A bounce (mailer-daemon / postmaster, a delivery-failure subject, a delivery report),
// an automatic mail (Auto-Submitted, Precedence bulk / junk / list) or a no-reply sender is left out of Chat Support:
// the Mail tab still shows it in the real Gmail. Pure, no imports.

export type AutoKind = 'bounce' | 'auto' | 'no-reply';

const BOUNCE_FROM = /^(?:mailer-daemon|mail-daemon|postmaster)$/i;
const BOUNCE_SUBJECT = /^\s*(?:(?:re|fwd?):\s*)?(?:undeliverable|undelivered mail|delivery status notification|mail delivery (?:failed|failure|subsystem)|returned mail|message blocked|delivery failure|failure notice|message not delivered|could not be delivered)\b/i;
const NO_REPLY_FROM = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply)(?:[-_.+].*)?$/i;

export interface MailHeads { from: string; subject: string; headers: { key: string; value: string }[]; contentType?: string | null }

export function automatedMail(m: MailHeads): AutoKind | null {
  const local = String(m.from || '').split('@')[0] || '';
  const head = (k: string) => (m.headers.find((h) => h.key.toLowerCase() === k)?.value || '').toLowerCase();
  if (BOUNCE_FROM.test(local) || BOUNCE_SUBJECT.test(m.subject || '') || /multipart\/report/i.test(m.contentType || head('content-type'))) return 'bounce';
  const autoSubmitted = head('auto-submitted');
  if (autoSubmitted && autoSubmitted.trim() !== 'no') return 'auto';
  if (/^(?:bulk|junk|list|auto_reply)$/.test(head('precedence').trim()) || head('x-autoreply') || head('x-autorespond')) return 'auto';
  if (NO_REPLY_FROM.test(local)) return 'no-reply';
  return null;
}
