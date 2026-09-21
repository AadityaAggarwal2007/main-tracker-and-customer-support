import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { query, queryOne } from '@/lib/db';
import { getAIResponse } from './ai';

// ── Email support ──────────────────────────────────────────────
// Ported from the chat-support app's email-service.js. The socket broadcasts
// are gone (the inbox polls now); everything else — thread matching, the
// withheld-draft rules, the high-water mark — is carried over as it was.

// ── HTML email template ────────────────────────────────────────────────────
export function buildEmailHtml(text: string, storeName: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Wrap bare URLs in real anchors. Mail clients auto-link plain text by
    // guessing where the URL ends, and a full stop written straight after a
    // tracking link was being swallowed into the href — which made the link
    // unopenable. The URL match deliberately stops before any trailing
    // punctuation, so the sentence keeps its full stop and the link still works.
    .replace(
      /(https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]])/g,
      '<a href="$1" style="color:#2563eb;word-break:break-all;">$1</a>'
    )
    .replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #f0f4f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 32px 16px; }
    .wrap { max-width: 580px; margin: 0 auto; }
    .header { background: #2563eb; border-radius: 12px 12px 0 0; padding: 20px 24px; display: flex; align-items: center; gap: 12px; }
    .header-icon { width: 36px; height: 36px; background: rgba(255,255,255,0.2); border-radius: 8px; display: flex; align-items: center; justify-content: center; }
    .header-icon svg { width: 20px; height: 20px; fill: white; }
    .header-title { color: white; font-size: 16px; font-weight: 600; }
    .header-sub { color: rgba(255,255,255,0.75); font-size: 12px; margin-top: 2px; }
    .body { background: white; padding: 28px 24px; }
    .message-wrap { background: #f0f4f8; border-radius: 12px; padding: 16px 18px; }
    .message-label { font-size: 11px; font-weight: 600; color: #2563eb; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .message-text { font-size: 15px; color: #1a1a2e; line-height: 1.65; }
    .footer { background: #f8fafc; border-radius: 0 0 12px 12px; padding: 16px 24px; border-top: 1px solid #e8edf2; }
    .footer-text { font-size: 12px; color: #94a3b8; line-height: 1.5; }
    .footer-reply { font-size: 12px; color: #2563eb; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="header-icon">
        <svg viewBox="0 0 24 24"><path d="M20 2H4C2.9 2 2 2.9 2 4v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
      </div>
      <div>
        <div class="header-title">${storeName} Support</div>
        <div class="header-sub">Customer support reply</div>
      </div>
    </div>
    <div class="body">
      <div class="message-wrap">
        <div class="message-label">Support Team</div>
        <div class="message-text">${escaped}</div>
      </div>
    </div>
    <div class="footer">
      <div class="footer-text">This message was sent by ${storeName} support.</div>
      <div class="footer-reply">Simply reply to this email to continue the conversation.</div>
    </div>
  </div>
</body>
</html>`;
}

// ── Strip quoted replies (everything after "On ... wrote:" or "--Original--") ──
function stripQuotedReply(text: string): string {
  if (!text) return '';
  const patterns = [
    /^On .+ wrote:[\s\S]*/m,
    /^-{3,}.*original.*-{3,}[\s\S]*/im,
    /^_{3,}[\s\S]*/m,
    /^>+\s.*/m,
  ];
  let result = text;
  for (const p of patterns) {
    const match = result.match(p);
    if (match) result = result.slice(0, match.index).trim();
  }
  return result.trim();
}

// ── Send via Gmail SMTP ────────────────────────────────────────────────────
async function sendEmailReply({
  fromEmail, appPassword, toEmail, subject, htmlBody, textBody, replyToMessageId, references,
}: {
  fromEmail: string; appPassword: string; toEmail: string; subject: string;
  htmlBody: string; textBody: string; replyToMessageId?: string | null; references?: string | null;
}): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: fromEmail, pass: appPassword },
    tls: { rejectUnauthorized: false },
  });

  const replySubject = subject && !subject.startsWith('Re:') ? `Re: ${subject}` : (subject || 'Re: Your enquiry');
  const headers: Record<string, string> = {};
  if (replyToMessageId) {
    headers['In-Reply-To'] = replyToMessageId;
    headers['References'] = references ? `${references} ${replyToMessageId}` : replyToMessageId;
  }

  await transporter.sendMail({
    from: `"Support" <${fromEmail}>`,
    to: toEmail,
    subject: replySubject,
    html: htmlBody,
    text: textBody,
    headers,
  });
}

interface MailboxRow {
  id: string; email: string; app_password: string; last_uid: number;
  site_id: string; site_name: string; ai_enabled: boolean;
  system_prompt: string | null; tracker_business_id: string | null;
  cod_available: boolean | null;
}

interface ConversationRow {
  id: string; status: string; email_thread_id: string | null;
}

// ── Poll a single email account via IMAP ──────────────────────────────────
export async function pollEmailAccount(account: MailboxRow): Promise<number> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: account.email, pass: account.app_password },
    logger: false,
  });

  let handled = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let maxUid = account.last_uid || 0;

    try {
      const searchFrom = maxUid + 1;
      const uids = await client.search({ uid: `${searchFrom}:*` });
      if (!uids || uids.length === 0) return 0;

      for await (const msg of client.fetch(uids, { uid: true, source: true })) {
        if (msg.uid <= account.last_uid) continue;
        maxUid = Math.max(maxUid, msg.uid);

        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch { continue; }

        const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
        const fromName = parsed.from?.value?.[0]?.name || fromAddr;

        // Skip emails sent by this account (avoid reply loops)
        if (fromAddr === account.email.toLowerCase()) continue;

        const subject = parsed.subject || '(no subject)';
        const messageId = parsed.messageId || '';
        const inReplyTo = parsed.inReplyTo || '';
        const references = Array.isArray(parsed.references)
          ? parsed.references.join(' ')
          : (parsed.references || '');
        const rawText = parsed.text || '';
        const cleanText = stripQuotedReply(rawText) || rawText.slice(0, 2000);

        // Find existing conversation via thread headers or prior messageId
        let conversation: ConversationRow | null = null;

        if (inReplyTo) {
          conversation = await queryOne<ConversationRow>(
            `SELECT c.id, c.status, c.email_thread_id
               FROM messages m
               JOIN conversations c ON c.id = m.conversation_id
              WHERE m.email_message_id = $1
              LIMIT 1`,
            [inReplyTo]
          );
        }

        if (!conversation && references) {
          const refIds = references.split(/\s+/).filter(Boolean).reverse();
          for (const ref of refIds) {
            conversation = await queryOne<ConversationRow>(
              `SELECT c.id, c.status, c.email_thread_id
                 FROM messages m
                 JOIN conversations c ON c.id = m.conversation_id
                WHERE m.email_message_id = $1
                LIMIT 1`,
              [ref]
            );
            if (conversation) break;
          }
        }

        if (!conversation) {
          conversation = await queryOne<ConversationRow>(
            `INSERT INTO conversations
               (id, site_id, visitor_id, visitor_name, status, source, email_thread_id,
                unread_count, last_message_at, created_at, updated_at)
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'email', $5, 0, now(), now(), now())
             RETURNING id, status, email_thread_id`,
            [
              account.site_id,
              `email:${fromAddr}`,
              fromName,
              account.ai_enabled ? 'ai_handling' : 'agent_handling',
              messageId,
            ]
          );
        }

        if (!conversation) continue;

        // Store incoming email as visitor message
        await query(
          `INSERT INTO messages (id, conversation_id, sender, content, email_message_id, metadata, created_at)
           VALUES (gen_random_uuid()::text, $1, 'visitor', $2, $3, $4::jsonb, now())`,
          [
            conversation.id,
            cleanText,
            messageId,
            JSON.stringify({ source: 'email', subject, fromEmail: fromAddr, fromName }),
          ]
        );

        await query(
          `UPDATE conversations
              SET unread_count = unread_count + 1, last_message_at = now(), updated_at = now()
            WHERE id = $1`,
          [conversation.id]
        );

        handled++;

        // ── AI auto-reply ──────────────────────────────────────────────
        // Routine questions (order status, tracking) are answered and sent.
        // Anything the AI escalates, and anything it could not answer at all,
        // is held back: the draft stays in the thread for an agent and the
        // customer hears nothing rather than being told something unverified.
        if (account.ai_enabled && conversation.status === 'ai_handling') {
          try {
            const aiResult = await getAIResponse(conversation.id, account.system_prompt, account.tracker_business_id, account.cod_available, 'email');

            // The same hidden tool context the widget path stores. Without it the
            // next email in this thread rebuilds the history with no record of
            // the order already looked up, so the AI asks for the phone number
            // again and the customer repeats themselves.
            if (aiResult.toolCallMeta) {
              const { tool_calls, tool_call_id, tool_result } = aiResult.toolCallMeta;
              await query(
                `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
                 VALUES (gen_random_uuid()::text, $1, 'ai', '', $2::jsonb, now())`,
                [conversation.id, JSON.stringify({ tool_calls, hidden: true })]
              );
              await query(
                `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
                 VALUES (gen_random_uuid()::text, $1, 'tool_result', $2, $3::jsonb, now())`,
                [conversation.id, tool_result, JSON.stringify({ tool_call_id, hidden: true })]
              );
            }

            // Every model was down, so there is no answer to send. The filler
            // getAIResponse returns ("could you send that again?") reads as
            // nonsense in an email the customer wrote once, so it is not sent
            // and not stored — the thread goes to a human instead.
            if (aiResult.allFailed) {
              await query(
                `UPDATE conversations SET status = 'human_needed', last_message_at = now(), updated_at = now() WHERE id = $1`,
                [conversation.id]
              );
              console.warn(`[email] No model available — held ${fromAddr} for a human ("${account.site_name}")`);
              continue;
            }

            // escalate_to_human has already moved the conversation to
            // human_needed; the reply is kept as an unsent draft.
            const held = Boolean(aiResult.escalated);

            // Stored as not-yet-emailed and flipped once SMTP confirms. A
            // message that claims it was sent when the send threw would leave
            // the thread looking answered while the customer got nothing.
            const aiMsg = await queryOne<{ id: string }>(
              `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
               VALUES (gen_random_uuid()::text, $1, 'ai', $2, $3::jsonb, now())
               RETURNING id`,
              [
                conversation.id,
                aiResult.content,
                JSON.stringify(held ? { emailed: false, withheld: 'escalated' } : { emailed: false, withheld: 'sending' }),
              ]
            );

            await query(
              `UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
              [conversation.id]
            );

            if (held) {
              // escalate_to_human sets this too, but it is set again here so a
              // model that reports an escalation the tool never persisted still
              // leaves a flagged thread rather than a silently dropped refund.
              await query(
                `UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1`,
                [conversation.id]
              );
              console.log(`[email] Escalated ${fromAddr} for site "${account.site_name}" — reply held, not sent`);
              continue;
            }

            // Send via SMTP
            try {
              const html = buildEmailHtml(aiResult.content, account.site_name);
              await sendEmailReply({
                fromEmail: account.email,
                appPassword: account.app_password,
                toEmail: fromAddr,
                subject,
                htmlBody: html,
                textBody: aiResult.content,
                replyToMessageId: messageId,
                references,
              });

              await query(
                `UPDATE messages SET metadata = $1::jsonb WHERE id = $2`,
                [JSON.stringify({ emailed: true }), aiMsg!.id]
              );
              console.log(`[email] Auto-replied to ${fromAddr} for site "${account.site_name}"`);
            } catch (sendErr) {
              // The answer exists but never left the building, so the thread
              // must not look answered. Hand it to a human with the draft intact.
              await query(
                `UPDATE messages SET metadata = $1::jsonb WHERE id = $2`,
                [JSON.stringify({ emailed: false, withheld: 'send_failed' }), aiMsg!.id]
              );
              await query(
                `UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1`,
                [conversation.id]
              );
              console.error(`[email] SMTP failed for ${fromAddr} ("${account.site_name}"):`, (sendErr as Error).message);
            }
          } catch (aiErr) {
            console.error('[email] AI error:', (aiErr as Error).message);
          }
        }
      }
    } finally {
      lock.release();
    }

    if (maxUid > (account.last_uid || 0)) {
      await query(`UPDATE site_emails SET last_uid = $1 WHERE id = $2`, [maxUid, account.id]);
    }

    await client.logout();
  } catch (err) {
    console.error(`[email] IMAP error for ${account.email}:`, (err as Error).message);
    try { await client.logout(); } catch { /* already gone */ }
  }

  return handled;
}

// ── One sweep across every connected mailbox ──────────────────────────────
// Called by the cron route once a minute. Sequential on purpose: each account
// opens and closes its own IMAP connection.
export async function pollAllMailboxes(): Promise<{ accounts: number; handled: number }> {
  const accounts = await query<MailboxRow>(
    `SELECT se.id, se.email, se.app_password, se.last_uid,
            s.id AS site_id, s.name AS site_name, s.ai_enabled,
            s.system_prompt, s.tracker_business_id, s.cod_available
       FROM site_emails se
       JOIN sites s ON s.id = se.site_id
      ORDER BY se.created_at ASC`
  );

  let handled = 0;
  for (const account of accounts.rows) {
    handled += await pollEmailAccount(account);
  }

  return { accounts: accounts.rowCount ?? 0, handled };
}

// ── Send an agent reply from the inbox ────────────────────────────────────
export async function sendAgentEmailReply(conversationId: string, content: string): Promise<void> {
  const conv = await queryOne<{
    visitor_id: string; source: string; email_thread_id: string | null;
    site_name: string; from_email: string | null; app_password: string | null;
    subject: string | null;
  }>(
    `SELECT c.visitor_id, c.source, c.email_thread_id,
            s.name AS site_name,
            se.email AS from_email, se.app_password,
            (SELECT m.metadata->>'subject'
               FROM messages m
              WHERE m.conversation_id = c.id AND m.metadata ? 'subject'
              ORDER BY m.created_at ASC LIMIT 1) AS subject
       FROM conversations c
       JOIN sites s ON s.id = c.site_id
       LEFT JOIN site_emails se ON se.site_id = s.id
      WHERE c.id = $1
      ORDER BY se.created_at ASC
      LIMIT 1`,
    [conversationId]
  );

  if (!conv || conv.source !== 'email') return;
  if (!conv.from_email || !conv.app_password) {
    console.warn('[email] No mailbox configured for site', conv.site_name);
    return;
  }

  const visitorEmail = conv.visitor_id.replace('email:', '');
  const subject = conv.subject || 'Your enquiry';

  const html = buildEmailHtml(content, conv.site_name);
  await sendEmailReply({
    fromEmail: conv.from_email,
    appPassword: conv.app_password,
    toEmail: visitorEmail,
    subject,
    htmlBody: html,
    textBody: content,
    replyToMessageId: conv.email_thread_id,
    references: conv.email_thread_id,
  });
}
