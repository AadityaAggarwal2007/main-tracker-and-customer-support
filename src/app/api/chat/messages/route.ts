import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne, withTransaction } from '@/lib/db';
import { sendAgentEmailReply } from '@/lib/chat/email';
import { sendWhatsAppText, sendWhatsAppTemplate, type WaSendResult } from '@/lib/chat/whatsapp';
import { stripMarkdownEmphasis } from '@/lib/chat/plain-text';
import { stripLinkJunk } from '@/lib/chat/reply-guards';
import { hasFormLink } from '@/lib/refund/link-mask';
import { can } from '@/lib/permissions';
import { canAct, claimsOnAct } from '@/lib/chat/team-rules';
import { reshipInReply } from '@/lib/chat/reship';
import { recordSent } from '@/lib/chat/suggest-run';
import {
  STARTING_MESSAGE, actionError, actionsReady, heldMessage, holderOf, lockChatGroup, logChatEvent, setActor, staffActor, takeFor,
} from '@/lib/chat/team-routing';
import {
  ATTACHMENT_ID_PATTERN, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES,
  TOO_MANY_MESSAGE, TOTAL_TOO_LARGE_MESSAGE, StoredAttachment, AttachmentKind, attachmentUrl,
} from '@/lib/chat/attachment-rules';

export const dynamic = 'force-dynamic';

// A reply the agent can fix and send again; anything else is a 500.
class ReplyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ── POST /api/chat/messages ────────────────────────────────────
// An agent replies. Chat replies are picked up by the widget's next poll;
// an email conversation additionally goes out over SMTP.
// Body: { conversationId, content, attachmentIds? } — attachmentIds are files
// already uploaded to /api/chat/attachments for this conversation. A reply
// needs text, files, or both.
//
// Chat team (owner, 2026-10-01; src/lib/chat/team-rules.ts): only the person who holds the chat,
// anyone on a chat nobody holds, and the Super Admin may reply. Someone else's chat is a 409 with
// their name and nothing is saved (the inbox keeps the draft). The first reply on a chat nobody
// holds makes it the replier's (the Super Admin's too, owner answer Q2), with the customer's other
// open chats nobody holds. The chat is locked for the whole reply, so two people answering the same
// free chat at once cannot both win: the second gets the 409.
export async function POST(request: NextRequest) {
  // Rights come from the team list: right after a restart, wait for it rather than guess.
  if (!(await actionsReady())) return NextResponse.json({ error: STARTING_MESSAGE }, { status: 503 });
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!can(user, 'chat.reply')) {
    return NextResponse.json({ error: 'You cannot reply' }, { status: 403 });
  }
  const actor = staffActor(user);
  if (!actor) return NextResponse.json({ error: STARTING_MESSAGE }, { status: 503 });

  try {
    // suggestionId + suggestionIndex (optional): the reply started from a suggested draft
    // (suggest-run.ts); recorded after the save, never a reason to refuse the reply.
    const { conversationId, content, attachmentIds, suggestionId, suggestionIndex, template } = await request.json();
    // A WhatsApp template (whatsapp-templates.ts): { name, language, params[] }. The content is the template's
    // text with the values filled in (what the chat record shows); Meta gets the template by name.
    const tpl = template && typeof template === 'object' && typeof template.name === 'string' && /^[a-z0-9_]{1,512}$/.test(template.name)
      ? { name: template.name as string, language: typeof template.language === 'string' && /^[a-z]{2}(_[A-Z]{2})?$/.test(template.language) ? template.language as string : 'en_US',
          params: Array.isArray(template.params) ? (template.params as unknown[]).slice(0, 20).map((v) => String(v ?? '').slice(0, 1024)) : [] }
      : null;
    // Pasted **bold** would reach the customer as literal asterisks. A link pasted from ChatGPT or an
    // ad (utm_source=chatgpt.com, fbclid ...) loses that tag (owner 2026-10-05: "team ki bas ki kuch
    // nahi hai"); the link itself, its AWB and the rest of the reply are exactly as typed.
    const text = stripLinkJunk(stripMarkdownEmphasis(content == null ? '' : String(content))).text;
    // No Google Form (any: owner answer Q7) and no refund-form link in a team reply, chat or email, for
    // every login (owner 2026-10-02): refund forms go out only through the Super Admin's Send button.
    if (hasFormLink(text)) return NextResponse.json({ error: "Refund forms go only through 'Send refund form' (Super Admin, Refund section). Remove the form link." }, { status: 403 });
    const hasText = text.trim() !== '';
    const fileIds: unknown[] = Array.isArray(attachmentIds) ? attachmentIds : [];

    if (!conversationId || (!hasText && fileIds.length === 0)) {
      return NextResponse.json({ error: 'conversationId and content required' }, { status: 400 });
    }
    if (fileIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return NextResponse.json({ error: TOO_MANY_MESSAGE }, { status: 400 });
    }
    if (fileIds.some(id => typeof id !== 'string' || !ATTACHMENT_ID_PATTERN.test(id))
        || new Set(fileIds).size !== fileIds.length) {
      return NextResponse.json({ error: 'Invalid attachment' }, { status: 400 });
    }
    const ids = fileIds as string[];

    const conversation = await queryOne<{
      id: string; source: string; tracker_business_id: string | null; site_id: string; customer_key: string | null; visitor_id: string;
    }>(
      `SELECT c.id, c.source, s.tracker_business_id, c.site_id, c.customer_key, c.visitor_id
         FROM conversations c
         JOIN sites s ON s.id = c.site_id
        WHERE c.id = $1`,
      [conversationId]
    );
    if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (user.businessIds && user.businessIds.length > 0) {
      const panel = conversation.tracker_business_id;
      if (!panel || !user.businessIds.includes(panel)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    }

    // The message, the files it carries and the chat's new status and holder are saved together, or
    // not at all. Every statement in here goes through `client` (a pool query would wait on our own
    // lock). The chat is locked first, before its files, the same order as mergeChats.
    const message = await withTransaction(async client => {
      const now = Date.now();
      const { chat, siblings } = await lockChatGroup(client, conversationId, conversation.site_id, conversation.customer_key);
      const panel = conversation.tracker_business_id;
      const h = holderOf(chat.assigned_to, panel, now);
      if (!canAct(actor, h)) {
        throw new ReplyError(409, heldMessage(h!, await takeFor(client, actor, h, chat.id)));
      }

      let files: StoredAttachment[] = [];
      if (ids.length > 0) {
        const found = await client.query<{
          id: string; file_name: string; mime_type: string; size_bytes: number; kind: AttachmentKind;
        }>(
          `SELECT id, file_name, mime_type, size_bytes, kind
             FROM chat_attachments
            WHERE id = ANY($1::text[]) AND conversation_id = $2 AND message_id IS NULL
            FOR UPDATE`,
          [ids, conversationId]
        );
        if (found.rows.length !== ids.length) {
          throw new ReplyError(400, 'One of the files is no longer available. Remove it and attach it again.');
        }
        const total = found.rows.reduce((n, r) => n + r.size_bytes, 0);
        if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new ReplyError(413, TOTAL_TOO_LARGE_MESSAGE);

        // In the order the agent attached them.
        files = ids.map(id => {
          const r = found.rows.find(row => row.id === id)!;
          return {
            id: r.id, url: attachmentUrl(r.id), name: r.file_name,
            mimeType: r.mime_type, size: r.size_bytes, kind: r.kind, status: 'sent' as const,
          };
        });
      }

      // A files-only reply still gets readable text: the conversation list, the
      // AI's history, email bodies and older widgets all show messages by their
      // text. `captionless` tells the inbox and the widget not to repeat it
      // under the files.
      const stored = hasText ? text : `📎 ${files.map(f => f.name).join(', ')}`;
      const metadata: Record<string, unknown> = { agent: user.username };
      if (files.length > 0) {
        metadata.attachments = files;
        if (!hasText) metadata.captionless = true;
      }

      const inserted = await client.query<{
        id: string; sender: string; content: string; metadata: unknown; created_at: string;
      }>(
        `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
         VALUES (gen_random_uuid()::text, $1, 'agent', $2, $3::jsonb, now())
         RETURNING id, sender, content, metadata, created_at`,
        [conversationId, stored, JSON.stringify(metadata)]
      );
      const row = inserted.rows[0];

      if (ids.length > 0) {
        await client.query(
          `UPDATE chat_attachments SET message_id = $1 WHERE id = ANY($2::text[])`,
          [row.id, ids]
        );
      }

      // A person answering means the AI stands down for this thread, and the
      // "came back after the auto-close" mark (chat-auto-close.sql) is done with.
      // The status change is logged as this person's (chat-team.sql trigger).
      await setActor(client, actor, 'reply');
      const claim = claimsOnAct(actor, h);
      await client.query(
        `UPDATE conversations
            SET status = 'agent_handling', last_message_at = now(), auto_closed_at = NULL, updated_at = now(),
                assigned_to = CASE WHEN $2::boolean THEN $3::text ELSE assigned_to END,
                assigned_at = CASE WHEN $2::boolean THEN now() ELSE assigned_at END
          WHERE id = $1`,
        [conversationId, claim, actor.key]
      );

      // A first reply on a free chat: it is now this person's, and so are the customer's other open
      // chats nobody holds (one person per customer).
      if (claim) {
        const group = siblings.filter((s) => holderOf(s.assigned_to, panel, now) === null).map((s) => s.id);
        if (group.length > 0) {
          await client.query(`UPDATE conversations SET assigned_to = $1, assigned_at = now() WHERE id = ANY($2::text[])`, [actor.key, group]);
        }
        await logChatEvent(client, actor, {
          conversationId: chat.id, siteId: chat.site_id, kind: 'claim', fromOwner: chat.assigned_to, toOwner: actor.key,
          fromStatus: chat.status, toStatus: 'agent_handling', reason: 'reply', meta: { group },
        });
      }
      await logChatEvent(client, actor, {
        conversationId: chat.id, siteId: chat.site_id, kind: 'reply', messageId: row.id, reason: 'reply',
        fromStatus: chat.status, toStatus: 'agent_handling', toOwner: claim ? actor.key : chat.assigned_to,
      });
      // Ship again (owner 2026-10-03): a reply that carries the new tracking link or AWB means the new
      // parcel was sent, so the chat is marked Reshipped by itself (reship.ts; chat-reship-done.sql).
      // Only the first such reply counts; the Mark reshipped button does the same by hand.
      if (chat.case_kind === 'reship' && hasText) {
        const ref = reshipInReply(text);
        if (ref) {
          const marked = await client.query(
            `UPDATE conversations
                SET reshipped_at = now(), reshipped_by = $2, reship_awb = $3, reship_link = $4, updated_at = now()
              WHERE id = $1 AND case_kind = 'reship' AND reshipped_at IS NULL`,
            [conversationId, actor.name, ref.awb, ref.link]
          ).catch(() => ({ rowCount: 0 }));   // before chat-reship-done.sql: nothing to mark
          if (marked.rowCount) {
            await logChatEvent(client, actor, {
              conversationId: chat.id, siteId: chat.site_id, kind: 'reshipped', messageId: row.id, reason: 'reply',
              fromStatus: chat.status, toStatus: 'agent_handling', meta: { awb: ref.awb, link: ref.link, auto: true },
            });
          }
        }
      }
      return row;
    });

    if (hasText && typeof suggestionId === 'string' && /^[0-9a-f-]{36}$/i.test(suggestionId)
        && Number.isInteger(suggestionIndex) && suggestionIndex >= 0 && suggestionIndex <= 9) {
      void recordSent(conversationId, suggestionId, suggestionIndex, message.id, text);
    }

    // The message is already saved, so a failing mail server must not lose the
    // agent's reply — it is reported instead.
    let emailed: boolean | null = null;
    if (conversation.source === 'email') {
      try {
        await sendAgentEmailReply(conversationId, message.content, ids);
        emailed = true;
      } catch (err) {
        emailed = false;
        console.error('[chat] agent email reply failed:', (err as Error).message);
      }
      // Kept on the message for "View details" in the inbox.
      await query(
        `UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('emailed', $2::boolean)
          WHERE id = $1`,
        [message.id, emailed]
      ).catch(err => console.error('[chat] could not record email status:', (err as Error).message));
    }

    // A WhatsApp chat (whatsapp-inbound.ts): the text goes to the customer's number through the Cloud API.
    // Files are not sent on WhatsApp yet (owner: first a test with one person). The message is saved
    // either way; Meta's answer (the wamid, or why it refused) is kept on it for "View details".
    let whatsapp: { ok: boolean; error: string | null } | null = null;
    if (conversation.source === 'whatsapp') {
      const to = conversation.visitor_id.replace(/^wa:/, '');
      const r: WaSendResult = tpl ? await sendWhatsAppTemplate(to, tpl.name, tpl.language, tpl.params)
        : hasText ? await sendWhatsAppText(to, message.content) : { ok: false, error: 'Files are not sent on WhatsApp yet; type a message', code: null };
      const waId = r.ok ? r.id : null, waError = 'error' in r ? r.error : null;
      whatsapp = { ok: r.ok, error: waError };
      await query(
        `UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('wa_sent', $2::boolean, 'wa_id', $3::text, 'wa_error', $4::text, 'wa_template', $5::text))
          WHERE id = $1`,
        [message.id, r.ok, waId, waError, tpl ? tpl.name : null]
      ).catch(err => console.error('[chat] could not record WhatsApp status:', (err as Error).message));
      if (waError) console.error('[whatsapp] reply not sent:', waError);
    }

    return NextResponse.json({ message, emailed, whatsapp });
  } catch (err) {
    if (err instanceof ReplyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // A merged shell, a lock that took over 5 s, a deadlock: nothing was saved, try again.
    const refused = actionError(err);
    if (refused) return refused;
    console.error('[chat] agent reply error:', err);
    return NextResponse.json({ error: 'Could not send that reply' }, { status: 500 });
  }
}
