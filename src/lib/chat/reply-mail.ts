// ── The nodemailer message of a reply (owner 2026-10-11, the mail outbox) ──
// Pure: the one place that says what a reply looks like on the wire (From "Name" <gmail>, the threading headers
// In-Reply-To / References, our own Message-ID), so Chat Support's own sending (email.ts sendEmailReply) and the Mail
// tab's outbox worker (mail-outbox.ts) build the same mail. No database, no network.
export interface ReplyMailInput {
  fromEmail: string; fromName?: string; cc?: string; toEmail: string; subject: string;
  htmlBody: string; textBody: string; replyToMessageId?: string | null; references?: string | null;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  messageId?: string;   // our own Message-ID (the Mail tab's store matches Gmail's Sent copy by it)
  // A new mail, not a reply (a chat reply also sent by Gmail, chat-mail.ts, owner 2026-10-13): the subject stays as it
  // is (no "Re:"). Only when it answers no mail (no replyToMessageId).
  fresh?: boolean;
}

export function replyMailMessage(x: ReplyMailInput) {
  // A reply to a mail with no subject keeps none ("Re:" alone): any other subject makes Gmail open a separate
  // conversation (owner 2026-10-14). "(no subject)" is the screens' label for an empty one, never a real subject.
  const subject = /^\(no subject\)$/i.test((x.subject || '').trim()) ? '' : (x.subject || '').trim();
  const replySubject = x.fresh && !x.replyToMessageId && subject ? subject
    : subject && !/^re:/i.test(subject) ? `Re: ${subject}`
    : subject || (x.replyToMessageId ? 'Re:' : 'Re: Your enquiry');
  const headers: Record<string, string> = {};
  if (x.replyToMessageId) {
    headers['In-Reply-To'] = x.replyToMessageId;
    headers['References'] = x.references ? `${x.references} ${x.replyToMessageId}` : x.replyToMessageId;
  }
  return {
    from: `"${(x.fromName || 'Support').replace(/["\r\n]/g, '')}" <${x.fromEmail}>`,
    ...(x.cc ? { cc: x.cc } : {}),
    to: x.toEmail,
    subject: replySubject,
    html: x.htmlBody,
    text: x.textBody,
    headers,
    attachments: x.attachments,
    ...(x.messageId ? { messageId: x.messageId } : {}),
  };
}
