// The answer a customer gets when they write to the WhatsApp number (owner 2026-10-10, after a team member answered
// a test "Dear Customer, how can we help you today? Team Vastrika": "yeh shiptrack ka support ha, vastrika ya kissi
// ka nai, aur asa msg bhi nai bhejna; jisko jo help chaia mail pa jaoo, yaha milegi"). The number is ShipTrack's
// order-update number for every brand, not a brand's help line: help is given by email. So the first message of a
// customer gets ONE fixed reply (never the AI, never a brand signature): this number only sends order updates; for
// help, email the brand's support address. At most one such reply per chat in 24 hours, so a customer who writes
// five lines gets it once. The brand is named only when we know it from this number (an automated message the
// brand sent it, or an order of that brand with this phone); otherwise the customer is pointed to the email in the
// order message. Saved in the chat as Chikki's message (sender 'ai', `metadata.wa_auto_reply`), so the inbox does
// not show the customer as waiting for the team.

import { query, queryOne } from '@/lib/db';
import { sendWhatsAppText } from './whatsapp';
import { loadBrands } from './whatsapp-brands';

export const AUTO_REPLY_HOURS = 24;

const OPENING = 'Hi, this is ShipTrack, the WhatsApp number that sends your order updates. Messages sent here are not answered.';

export function autoReplyText(brand: { name: string; email: string } | null): string {
  if (brand && brand.email) {
    return `${OPENING} For any help with your ${brand.name} order, please email us at ${brand.email} and our team will help you there.`;
  }
  return `${OPENING} For any help with your order, please email the store you ordered from: its support email is in the order message we sent you.`;
}

// The brand of this chat, only when this number proves it (never just the default panel).
async function knownBrand(panelId: string, digits: string): Promise<{ name: string; email: string } | null> {
  let known = false;
  try {
    known = !!(await queryOne(
      `SELECT 1 FROM wa_auto_sends WHERE business_id = $1 AND to_number = $2 AND status IN ('sent', 'delivered', 'read') LIMIT 1`,
      [panelId, digits]
    ));
  } catch { /* the automation table is not installed */ }
  if (!known) {
    try {
      known = !!(await queryOne(
        `SELECT 1 FROM orders o WHERE o.business_id::text = $1 AND right(regexp_replace(o.customer_mobile, '\\D', '', 'g'), 10) = $2 LIMIT 1`,
        [panelId, digits.slice(-10)]
      ));
    } catch { /* no order lookup */ }
  }
  if (!known) return null;
  const b = (await loadBrands().catch(() => [])).find((x) => x.id === panelId);
  return b && b.email ? { name: b.name, email: b.email } : null;
}

export type AutoReplyOutcome = 'sent' | 'failed' | 'already' | 'no_chat';

export async function sendWaAutoReply(conversationId: string, digits: string, env: NodeJS.ProcessEnv = process.env): Promise<AutoReplyOutcome> {
  const conv = await queryOne<{ panel: string | null }>(
    `SELECT s.tracker_business_id::text AS panel FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = $1 AND c.source = 'whatsapp'`,
    [conversationId]
  );
  if (!conv) return 'no_chat';
  const text = autoReplyText(conv.panel ? await knownBrand(conv.panel, digits) : null);
  // Claim first (one reply per chat per 24 hours, even when two webhook calls arrive together), then send.
  const claimed = await queryOne<{ id: string }>(
    `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
     SELECT gen_random_uuid()::text, $1, 'ai', $2, '{"channel": "whatsapp", "wa_auto_reply": true}'::jsonb, now()
      WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = $1 AND m.metadata->>'wa_auto_reply' = 'true'
                          AND m.created_at > now() - make_interval(hours => $3::int))
     RETURNING id`,
    [conversationId, text, AUTO_REPLY_HOURS]
  );
  if (!claimed) return 'already';
  const r = await sendWhatsAppText(digits, text, env);
  const err = 'error' in r ? r.error : null;
  await query(
    `UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('wa_sent', $2::boolean, 'wa_id', $3::text, 'wa_error', $4::text)) WHERE id = $1`,
    [claimed.id, r.ok, 'id' in r ? r.id : null, err]
  ).catch((e) => console.error('[whatsapp] auto reply result:', (e as Error).message));
  if (err) console.error(`[whatsapp] auto reply not sent: ${err}`);
  return r.ok ? 'sent' : 'failed';
}
