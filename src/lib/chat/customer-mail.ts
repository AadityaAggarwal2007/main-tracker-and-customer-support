// ── Chikki knows the chat and the Gmail are one customer (owner 2026-10-13: "chats aur mail connect ... ek saath
// dikhana nahi, Chikki aur Chat Support ko bass pata ho ki yeh chat aur Gmail ek hi admi hai, chahe kaise bhi verify
// kia ho"; answer: "Sirf pehchane", only that, never the mails' text) ──
// For a VERIFIED customer only. In a website chat: did they also write to our support Gmail (an email chat of the
// address on their order, or one verified for that order, in the same panel; last 60 days)? In an email: did they also
// write on the website chat (a chat verified for the same order)? Then ONE line goes into Chikki's prompt: it is the
// same person, do not make them verify or repeat it. Counts and the last date only; no mail text reaches the model.
// Never throws (a failure = no line).
import { queryOne } from '@/lib/db';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function istDay(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + 330 * 60_000).toISOString();
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
}

// Pure: the line itself (exported for the tests).
export function otherChannelNote(channel: 'chat' | 'email', n: number, lastIso: string | null): string {
  if (!(n > 0)) return '';
  const when = lastIso ? `, the last on ${istDay(lastIso)}` : '';
  return channel === 'chat'
    ? `\n\n(Note from the system, not the customer: this verified customer has also written to our support email (${n} ${n === 1 ? 'message' : 'messages'}${when}) from the email address on their order. It is the same person as in this chat. Do not ask them to verify again or to repeat by chat what they wrote by email; if they mention their email, you may say our team has received it.)`
    : `\n\n(Note from the system, not the customer: this verified customer has also written to us on the website chat (${n} ${n === 1 ? 'message' : 'messages'}${when}). It is the same person as in this email. Do not ask them to verify again.)`;
}

export async function otherChannelLine(conversationId: string, verifiedOrderId: string | null, panelId: string | null, channel: 'chat' | 'email'): Promise<string> {
  if (!verifiedOrderId || !panelId) return '';
  try {
    const r = channel === 'chat'
      ? await queryOne<{ n: number; last: string | null }>(
        `/* customer-mail */ SELECT count(*)::int AS n, max(m.created_at) AS last
           FROM conversations c JOIN sites s ON s.id = c.site_id JOIN messages m ON m.conversation_id = c.id
          WHERE s.tracker_business_id::text = $1::text AND c.source = 'email' AND c.id <> $3
            AND (c.verified_order_id = $2
                 OR lower(c.visitor_id) = 'email:' || (SELECT lower(btrim(o.customer_email)) FROM orders o
                                                        WHERE o.business_id::text = $1::text AND o.order_id = $2 ORDER BY o.created_at DESC LIMIT 1))
            AND m.sender = 'visitor' AND m.deleted_at IS NULL AND m.created_at > now() - interval '60 days'`,
        [panelId, verifiedOrderId, conversationId])
      : await queryOne<{ n: number; last: string | null }>(
        `/* customer-mail */ SELECT count(*)::int AS n, max(m.created_at) AS last
           FROM conversations c JOIN sites s ON s.id = c.site_id JOIN messages m ON m.conversation_id = c.id
          WHERE s.tracker_business_id::text = $1::text AND c.source = 'chat' AND c.id <> $3 AND c.verified_order_id = $2
            AND m.sender = 'visitor' AND m.deleted_at IS NULL AND m.created_at > now() - interval '60 days'`,
        [panelId, verifiedOrderId, conversationId]);
    return otherChannelNote(channel, Number(r?.n) || 0, r?.last ? new Date(r.last).toISOString() : null);
  } catch (e) {
    console.error('[AI] other channel line:', (e as Error)?.message);
    return '';
  }
}
