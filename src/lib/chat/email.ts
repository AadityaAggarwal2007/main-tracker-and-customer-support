import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { emailReplyHeld, heldKind, heldMovesToNeedsYou } from './email-draft';
import { emailDraftOnly } from './email-draft-mode';
import { simpleParser } from 'mailparser';
import { automatedMail } from './email-auto';
import { query, queryOne } from '@/lib/db';
import { getAIResponse } from './ai';
import { recordBrainUsage } from './brain-usage';
import { recordChikkiRun } from './chikki-runs';
import type { EffortUsage } from './effort';
import { updateConversationSubject } from './subject';
import { updateConversationHealth } from './health';
import { maskSensitive, sensitiveWarning } from './sensitive';
import { chatIsVerified } from './verified';
import { addressConflict } from './address-conflict';
import { recentVisitorMessages } from './chat-history';
import { dropReplyTimes, insertEmailNote, routineHandOverKind, routineLine, saysRefundTime, teamWillReplyLine, urgentKind } from './escalation';
import { afterHours } from '@/lib/office-hours';
import { loadHolidays } from './holidays';
import { friendlyMailError, mailErrorText, noteMailboxCheck } from './mailbox-status';
import { pollChargebackMailboxes } from '@/lib/chargeback/poll';
import { gmailHost } from './imap-pool';
import { autoVerifySenders } from './mail-auto-verify';
import { warmMailboxes } from './mail-cache';
import { gmailAuthPassed } from './mail-view';

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
export async function sendEmailReply({
  fromEmail, appPassword, toEmail, subject, htmlBody, textBody, replyToMessageId, references, attachments, fromName, cc,
}: {
  fromEmail: string; fromName?: string; cc?: string; appPassword: string; toEmail: string; subject: string;
  htmlBody: string; textBody: string; replyToMessageId?: string | null; references?: string | null;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
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
    from: `"${(fromName || 'Support').replace(/["\r\n]/g, '')}" <${fromEmail}>`,
    ...(cc ? { cc } : {}),
    to: toEmail,
    subject: replySubject,
    html: htmlBody,
    text: textBody,
    headers,
    attachments,
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
  // Gmail's IPv4 address (imap-pool.ts): a server whose IPv6 is broken otherwise waits for that try to fail every minute.
  const client = new ImapFlow({
    ...(await gmailHost()),
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
      // Signed in and read: the Settings card shows "checked just now" (mailbox-status.ts).
      noteMailboxCheck(account.id, { ok: true });
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
        // A bounce, an automatic mail or a no-reply sender (email-auto.ts): no chat, no reply. The Mail tab shows it.
        const autoKind = automatedMail({
          from: fromAddr, subject: parsed.subject || '',
          headers: (parsed.headerLines || []).map((h) => ({ key: h.key, value: String(h.line || '').replace(/^[^:]*:\s*/, '') })),
          contentType: (parsed.headers?.get('content-type') as { value?: string } | undefined)?.value ?? null,
        });
        if (autoKind) { console.log(`[email] ${autoKind} mail from ${fromAddr} on site "${account.site_name}": not a chat, no reply`); continue; }

        // A card number in the subject line is hidden too: the subject is stored and
        // becomes the reply's subject.
        const subject = maskSensitive(parsed.subject || '(no subject)').text;
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

        // Automatic verification of the sender (owner 2026-10-08, mail-auto-verify.ts): the address is on one of
        // this panel's orders and Gmail itself marked the mail dmarc=pass. Done before the chat is read below, so a
        // verified sender is treated as verified from this very mail. Never able to stop the mail being handled.
        try {
          const authLine = (parsed.headerLines || []).find(h => h.key === 'authentication-results')?.line ?? null;
          await autoVerifySenders(account.tracker_business_id, [{ email: fromAddr, authPass: gmailAuthPassed(authLine), subject, text: cleanText }]);
        } catch (e) { console.error('[email] auto verify:', (e as Error).message); }

        // A reply to a Closed thread reopens it, like a widget message does
        // (/api/widget/message). Before 2026-09-30 it was stored in the Closed
        // chat and nobody saw it, and the AI (which only answers ai_handling)
        // stayed silent. A thread closed by the auto-close keeps its
        // auto_closed_at, so the inbox shows it as "Came back".
        if (conversation.status === 'resolved') {
          const reopened = account.ai_enabled ? 'ai_handling' : 'human_needed';
          // A Refund / Ship again thread (chat-cases.sql) stays with the team: no AI.
          const back = await queryOne<{ status: string }>(
            `UPDATE conversations SET status = CASE WHEN case_kind IS NOT NULL THEN 'agent_handling' ELSE $2 END, updated_at = now()
              WHERE id = $1 AND status = 'resolved' RETURNING status`,
            [conversation.id, reopened]
          );
          conversation.status = back?.status || reopened;
        }

        // Card number, CVV, expiry, OTP, UPI PIN or a password in the email is
        // hidden before it is stored (master rules section 20). The original
        // stays in the mailbox itself, which we cannot change.
        const masked = maskSensitive(cleanText);
        if (masked.kinds.length) console.log(`[email] hid ${masked.kinds.join(', ')} in a mail on conv ${conversation.id}`);

        // A threat or a fraud claim (subject or body) is marked on the message
        // itself: the inbox ranks the chat first while no person has answered.
        const urgent = urgentKind(`${subject}\n${masked.text}`);

        // Store incoming email as visitor message
        await query(
          `INSERT INTO messages (id, conversation_id, sender, content, email_message_id, metadata, created_at)
           VALUES (gen_random_uuid()::text, $1, 'visitor', $2, $3, $4::jsonb, now())`,
          [
            conversation.id,
            masked.text,
            messageId,
            JSON.stringify({ source: 'email', subject, fromEmail: fromAddr, fromName, ...(masked.kinds.length ? { sensitive_hidden: masked.kinds } : {}), ...(urgent ? { urgent } : {}), ...(routineHandOverKind(masked.text) ? { routine: routineHandOverKind(masked.text) } : {}) }),
          ]
        );

        await query(
          `UPDATE conversations
              SET unread_count = unread_count + 1, last_message_at = now(), updated_at = now()
            WHERE id = $1`,
          [conversation.id]
        );

        handled++;

        // The chat's subject line for the inbox (./subject.ts). Not awaited,
        // never throws, so the poll and the reply below go on as before.
        void updateConversationSubject(conversation.id);
        // The customer's frustration score (./health.ts), the same way.
        void updateConversationHealth(conversation.id);

        // A threat (chargeback, police, court, legal action, bad reviews) goes to a
        // person at once and gets NO automatic reply (master rules section 15):
        // the team answers by email, and the chat is top of the inbox. A fraud or
        // fake-site claim (section 16) is answered by the AI with what it can prove
        // and then handed over, below.
        // Only a VERIFIED customer goes to Needs you (owner, 2026-09-30); an unverified
        // sender stays in Visitors and the AI answers (and asks for the order ID + phone).
        if (conversation.status === 'ai_handling' && urgent === 'threat' && await chatIsVerified(conversation.id)) {
          await query(
            `UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1 AND status = 'ai_handling'`,
            [conversation.id]
          );
          console.log(`[email] threat from ${fromAddr} on site "${account.site_name}": held for a person, no auto-reply`);
          continue;
        }

        // Two different addresses from a verified customer (master rules section 10): the
        // AI must not pick one, so the thread is held for a person (no auto-reply).
        if (conversation.status === 'ai_handling' && await chatIsVerified(conversation.id)) {
          try {
            const mine = await recentVisitorMessages(conversation.id);
            if (addressConflict(mine.slice(1), masked.text)) {
              await query(
                `UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1 AND status = 'ai_handling'`,
                [conversation.id]
              );
              console.log(`[email] two different addresses from ${fromAddr} on site "${account.site_name}": held for a person`);
              continue;
            }
          } catch (err) {
            console.error('[email] address check failed:', (err as Error).message);
          }
        }

        // ── AI auto-reply ──────────────────────────────────────────────
        // Routine questions (order status, tracking) are answered and sent.
        // Anything the AI escalates, and anything it could not answer at all,
        // is held back: the draft stays in the thread for an agent and the
        // customer hears nothing rather than being told something unverified.
        if (account.ai_enabled && conversation.status === 'ai_handling') {
          try {
            const brainUsage: { brain: { id: string; title: string }[]; effort?: EffortUsage } = { brain: [] };
            const aiStarted = Date.now();
            const aiResult = await getAIResponse(conversation.id, account.system_prompt, account.tracker_business_id, account.cod_available, 'email', account.site_id, brainUsage);
            if (brainUsage.effort) brainUsage.effort.ms = Date.now() - aiStarted;

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
            // The sender may have verified in this very email (order ID + phone): read again.
            const verifiedNow = await chatIsVerified(conversation.id);
            if (aiResult.allFailed && !verifiedNow) {
              // A visitor stays a visitor: nothing moves the thread to Needs you.
              console.warn(`[email] No model available for ${fromAddr} ("${account.site_name}"), not verified: left in Visitors`);
              continue;
            }
            if (aiResult.allFailed) {
              await query(
                `UPDATE conversations SET status = 'human_needed', last_message_at = now(), updated_at = now() WHERE id = $1`,
                [conversation.id]
              );
              console.warn(`[email] No model available — held ${fromAddr} for a human ("${account.site_name}")`);
              continue;
            }

            // Payment details in the email: the "please do not share these" line
            // goes in right after the greeting (added here, not left to the model).
            if (masked.kinds.length) aiResult.content = insertEmailNote(aiResult.content, sensitiveWarning(masked.text), 'top');

            // A fraud claim, a refund or cancellation request, or a payment problem
            // (master rules sections 11, 16, 17): the reply says a person has it and
            // when, the chat goes to Needs you, and the reply is SENT even if the AI
            // escalated (the customer must hear something). The line goes in before
            // the sign-off.
            const routine = routineHandOverKind(masked.text);
            const handOverNow = verifiedNow && (urgent === 'accusation' || !!routine);
            if (handOverNow) {
              // Night (19:30-10:00 IST, owner 2026-10-01): the line says the team replies
              // in the morning, after 10 AM, and an hour promise the AI wrote itself
              // ("within 24 hours") is taken out first so the email does not say both.
              // At night the refund line always goes in, as it carries the morning time.
              const after = afterHours(Date.now(), await loadHolidays());
              if (after) aiResult.content = dropReplyTimes(aiResult.content).text;
              const line = urgent === 'accusation' ? teamWillReplyLine(masked.text, after) : routineLine(routine!, masked.text, after);
              if (urgent === 'accusation' || routine !== 'refund' || !!after || !saysRefundTime(aiResult.content)) {
                aiResult.content = insertEmailNote(aiResult.content, line, 'bottom');
              }
              await query(
                `UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1 AND status = 'ai_handling'`,
                [conversation.id]
              );
            }

            // escalate_to_human has already moved the conversation to
            // human_needed; the reply is kept as an unsent draft, unless it is one
            // of the hand-overs above.
            // Draft mode (owner 2026-10-08, email-draft.ts): the team sends, Chikki only prepares; ON unless
            // the Super Admin switched it off for this panel. The hand-over lines above still go out.
            const draftOnly = await emailDraftOnly(account.site_id);
            const held = emailReplyHeld(Boolean(aiResult.escalated), handOverNow, draftOnly);

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
                JSON.stringify(held ? { emailed: false, withheld: heldKind(Boolean(aiResult.escalated)) } : { emailed: false, withheld: 'sending' }),
              ]
            );
            await recordBrainUsage(aiMsg?.id, brainUsage.brain);
            await recordChikkiRun(aiMsg?.id, conversation.id, account.site_id, brainUsage.effort);

            await query(
              `UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
              [conversation.id]
            );

            if (held) {
              // escalate_to_human sets this too, but it is set again here so a
              // model that reports an escalation the tool never persisted still
              // leaves a flagged thread rather than a silently dropped refund.
              if (heldMovesToNeedsYou(Boolean(aiResult.escalated), verifiedNow)) {
                await query(
                  `UPDATE conversations SET status = 'human_needed', updated_at = now() WHERE id = $1`,
                  [conversation.id]
                );
              }
              console.log(`[email] ${aiResult.escalated ? 'Escalated' : 'Draft for the team:'} ${fromAddr} for site "${account.site_name}" — reply held, not sent`);
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

    if (handled > 0) noteMailboxCheck(account.id, { ok: true, handled });
    await client.logout();
  } catch (err) {
    console.error(`[email] IMAP error for ${account.email}:`, (err as Error).message);
    noteMailboxCheck(account.id, { ok: false, error: friendlyMailError(mailErrorText(err)) });
    try { await client.logout(); } catch { /* already gone */ }
  } finally {
    // The "no new mail" path returns before the logout above; closing here makes sure no Gmail connection is
    // left open every minute (Gmail allows only about 15 at once, and the Mail tab needs one too).
    try { client.close(); } catch { /* already closed */ }
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

  // The panels' chargeback Gmails ride on this same minute (src/lib/chargeback/poll.ts); never able to stop the sweep.
  try { await pollChargebackMailboxes(); } catch (e) { console.error('[chargeback] sweep:', (e as Error).message); }

  // The Mail tab's copies (mail-cache.ts, owner 2026-10-09): each support Gmail's list is read again when it is a few
  // minutes old and its newest mails are read ahead, in the background, so the tab opens at once. Never awaited here:
  // the sweep's minute is not spent on it, and a failure there never touches the poll.
  void warmMailboxes(accounts.rows.map(a => ({
    id: a.id, email: a.email, appPassword: a.app_password, siteId: a.site_id, siteName: a.site_name,
    panelId: a.tracker_business_id == null ? null : String(a.tracker_business_id), panelName: a.site_name,
  })));

  return { accounts: accounts.rowCount ?? 0, handled };
}

// ── Send an agent reply from the inbox ────────────────────────────────────
export async function sendAgentEmailReply(
  conversationId: string,
  content: string,
  attachmentIds: string[] = []
): Promise<void> {
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

  // Files the agent attached in the inbox go out as real email attachments.
  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  if (attachmentIds.length > 0) {
    const files = await query<{ file_name: string; mime_type: string; data: Buffer }>(
      `SELECT file_name, mime_type, data
         FROM chat_attachments
        WHERE id = ANY($1::text[]) AND conversation_id = $2
        ORDER BY array_position($1::text[], id)`,
      [attachmentIds, conversationId]
    );
    attachments = files.rows.map(f => ({ filename: f.file_name, content: f.data, contentType: f.mime_type }));
  }

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
    attachments,
  });
}
