// ── "Send via Gmail too" (owner 2026-10-13; the words are in chat-mail-rules.ts) ──
// A team member ticks the box under the reply box on one message: after the chat reply is saved, the same text goes
// to the customer by mail from the panel's support Gmail, as a new mail "Update on your order #...".
//   - only a website chat whose customer is VERIFIED for an order (however: the form, Chikki's lookup, the team's
//     Verify, an old check); never a visitor;
//   - the address = the email on that order (inside the chat's own panel), else the newest address verified for that
//     order in the Mail tab (mail_verifications); never one the customer typed in the chat;
//   - the Gmail = the panel's support Gmail (site_emails), the chat's own site's first;
//   - through the mail outbox when it is installed (mail-outbox.sql: answered at once, sent in the background with
//     retries, Gmail keeps the copy in Sent so the Mail tab's sync sees it), else sent here with a 30 s cut.
// The chat reply itself never waits for or depends on the mail.
import { randomUUID } from 'crypto';
import nodemailer from 'nodemailer';
import { query, queryOne } from '@/lib/db';
import { enqueueReply, outboxInstalled, runOutbox } from './mail-outbox';
import { replyMailMessage } from './reply-mail';
import { chatMailBodies, chatMailSubject, looksLikeEmail, maskEmail, type ChatMailWhyNot } from './chat-mail-rules';

const missing = (e: unknown) => ['42P01', '42703'].includes((e as { code?: string })?.code || '');
const SEND_CAP_MS = 30_000;

export interface ChatMailTarget {
  conversationId: string; panelId: string; orderId: string; to: string; toMasked: string;
  boxId: string; boxEmail: string; boxPassword: string; brand: string;
}
export type ChatMailFind = { ok: true; target: ChatMailTarget } | { ok: false; why: ChatMailWhyNot };

export async function chatMailTarget(conversationId: string): Promise<ChatMailFind> {
  const c = await queryOne<{ source: string; site_id: string; panel: string | null; verified_order_id: string | null }>(
    `SELECT c.source, c.site_id, s.tracker_business_id::text AS panel, c.verified_order_id
       FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = $1`, [conversationId]);
  if (!c || c.source !== 'chat') return { ok: false, why: 'not_chat' };
  if (!c.verified_order_id || !c.panel) return { ok: false, why: 'not_verified' };
  const o = await queryOne<{ email: string | null }>(
    `SELECT lower(btrim(customer_email)) AS email FROM orders
      WHERE business_id::text = $1::text AND order_id = $2 ORDER BY created_at DESC LIMIT 1`, [c.panel, c.verified_order_id]);
  let to = o?.email && looksLikeEmail(o.email) ? o.email : '';
  if (!to) {
    try {
      const v = await queryOne<{ email: string }>(
        `SELECT lower(email) AS email FROM mail_verifications
          WHERE business_id = $1 AND order_id = $2 AND removed_at IS NULL ORDER BY verified_at DESC LIMIT 1`, [c.panel, c.verified_order_id]);
      if (v?.email && looksLikeEmail(v.email)) to = v.email;
    } catch (e) { if (!missing(e)) console.error('[chat-mail] verified address:', (e as Error).message); }
  }
  if (!to) return { ok: false, why: 'no_email' };
  const box = await queryOne<{ id: string; email: string; app_password: string; site_name: string }>(
    `SELECT se.id::text AS id, se.email, se.app_password, s.name AS site_name
       FROM site_emails se JOIN sites s ON s.id = se.site_id
      WHERE s.tracker_business_id::text = $1::text
      ORDER BY (se.site_id = $2) DESC, se.created_at ASC LIMIT 1`, [c.panel, c.site_id]);
  if (!box) return { ok: false, why: 'no_gmail' };
  if (box.email.toLowerCase() === to) return { ok: false, why: 'no_email' };
  return {
    ok: true,
    target: {
      conversationId, panelId: c.panel, orderId: c.verified_order_id, to, toMasked: maskEmail(to),
      boxId: box.id, boxEmail: box.email, boxPassword: box.app_password, brand: box.site_name,
    },
  };
}

export type ChatMailResult = { ok: true; queued: boolean; to: string } | { ok: false; error: string; to?: string };

// Sends (or queues) the chat reply's text as a mail. Never throws.
export async function sendChatAsMail(conversationId: string, text: string, by: string): Promise<ChatMailResult> {
  let found: ChatMailFind;
  try { found = await chatMailTarget(conversationId); }
  catch (e) { console.error('[chat-mail] target:', (e as Error).message); return { ok: false, error: 'Could not read the customer\'s email right now' }; }
  if (!('target' in found)) {
    const words: Record<ChatMailWhyNot, string> = {
      not_chat: 'Only a website chat can also be sent by Gmail', not_verified: 'The customer is not verified: no mail was sent',
      no_email: 'The order has no email address: no mail was sent', no_gmail: 'This panel has no support Gmail: no mail was sent',
    };
    return { ok: false, error: words[found.why] };
  }
  const t = found.target;
  const subject = chatMailSubject(t.orderId);
  const { textBody, htmlBody } = chatMailBodies(text, t.brand);
  const messageId = `<${randomUUID()}@${(t.boxEmail.split('@')[1] || 'shiptrack.store').toLowerCase()}>`;
  try {
    if (await outboxInstalled()) {
      await enqueueReply({
        boxId: t.boxId, replyUid: null, uidvalidity: null, to: t.to, subject, textBody, htmlBody, messageId,
        inReplyTo: null, references: null, files: [], createdBy: by,
      });
      void runOutbox().catch((e) => console.error('[chat-mail] outbox run:', (e as Error).message));
      console.log(`[chat-mail] conv=${conversationId} to=${t.toMasked} queued by ${by}`);
      return { ok: true, queued: true, to: t.toMasked };
    }
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false, auth: { user: t.boxEmail, pass: t.boxPassword },
      tls: { rejectUnauthorized: false }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 25_000,
    } as never);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.sendMail(replyMailMessage({
          fromEmail: t.boxEmail, fromName: `${t.brand} Support`, toEmail: t.to, subject, htmlBody, textBody, messageId, fresh: true,
        })),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('Gmail did not answer in time')), SEND_CAP_MS); }),
      ]);
    } finally { if (timer) clearTimeout(timer); try { transport.close(); } catch { /* gone */ } }
    console.log(`[chat-mail] conv=${conversationId} to=${t.toMasked} sent by ${by}`);
    return { ok: true, queued: false, to: t.toMasked };
  } catch (e) {
    console.error(`[chat-mail] conv=${conversationId} to=${t.toMasked} failed:`, (e as Error).message);
    return { ok: false, error: 'Gmail did not take the mail. The chat reply is saved; try the mail again from the Mail tab.', to: t.toMasked };
  }
}

// The thread's line under the reply box: where the mail would go, or why it cannot (staff only).
export async function chatMailOffer(conversationId: string): Promise<{ to: string } | { why: string } | null> {
  try {
    const f = await chatMailTarget(conversationId);
    if ('target' in f) return { to: f.target.toMasked };
    return f.why === 'not_chat' ? null : { why: f.why };
  } catch (e) {
    if (!missing(e)) console.error('[chat-mail] offer:', (e as Error).message);
    return null;
  }
}

// Kept on the chat message for "View details" (the widget's messages route strips `mail`, like `agent`).
export async function noteChatMail(messageId: string, r: ChatMailResult): Promise<void> {
  try {
    await query(
      `UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('mail', $2::jsonb) WHERE id = $1`,
      [messageId, JSON.stringify('queued' in r ? { to: r.to, state: r.queued ? 'queued' : 'sent' } : { to: r.to ?? null, state: 'failed', error: r.error })]);
  } catch (e) { console.error('[chat-mail] note:', (e as Error).message); }
}
