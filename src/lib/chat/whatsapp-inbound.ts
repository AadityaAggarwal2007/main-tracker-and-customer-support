// A WhatsApp message arriving at our business number becomes a Chat Support chat (whatsapp.ts has the
// why). One chat per customer number per site (`visitor_id = 'wa:<digits>'`, source 'whatsapp'), the
// customer's profile name as the visitor name until an order proves who they are, every message
// stored as the customer's (`sender 'visitor'`) with its wamid in `metadata.wa_id` (Meta resends a
// message it got no 200 for: a wamid already stored is skipped). The chat is `agent_handling` (a
// Closed one reopens) and Chikki never answers on WhatsApp. Since 2026-10-11 (owner: the number is a
// no-reply identity, "saari WhatsApp chats Chat Support se nikaal do") such a chat is NOT in Chat
// Support at all (waiting-sql.ts CHAT_SUPPORT_SQL): it shows only in WhatsApp > Chats, where a reply
// goes back out on WhatsApp through the same messages route. Delivery reports (sent / delivered /
// read / failed) land on our own message's metadata (`wa_status`, `wa_error`).

import { noteAlertStatus } from './whatsapp-alert-queue';
import { isRateLimited } from './whatsapp-auto-rules';
import { pauseWhatsApp } from './whatsapp-pause';
import { query, queryOne } from '@/lib/db';
import { ensureSiteForPanel } from './site';
import { updateConversationSubject } from './subject';
import { updateConversationHealth } from './health';
import type { WaInbound, WaStatus } from './whatsapp';
import { noteAutoStatus } from './whatsapp-auto-status';
import { noteForeignStatus, noteTestStatus } from './whatsapp-foreign';

// The panel WhatsApp chats belong to: WHATSAPP_PANEL_ID, else the default panel. One number, one panel,
// until the owner wants a number per panel.
export async function waPanelId(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const wanted = (env.WHATSAPP_PANEL_ID || '').trim();
  const row = wanted
    ? await queryOne<{ id: string }>(`SELECT id::text AS id FROM businesses WHERE id::text = $1`, [wanted])
    : await queryOne<{ id: string }>(`SELECT id::text AS id FROM businesses ORDER BY is_default DESC, created_at ASC LIMIT 1`);
  return row?.id ?? null;
}

// Which brand a number belongs to (owner 2026-10-10: "ye bhi brand wise ... chat ka system"). One WhatsApp number
// serves every brand, so the chat of a customer who writes back goes to the panel of the brand they dealt with:
// (1) the panel whose automated message this number last received, (2) the panel of the number's latest order,
// (3) the default WhatsApp panel (WHATSAPP_PANEL_ID, else the default panel). Routing a chat to an inbox is not
// verification: the chat stays a plain visitor (a phone number alone never makes anyone a customer).
export async function waPanelFor(digits: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const a = await queryOne<{ business_id: string }>(
      `SELECT business_id FROM wa_auto_sends WHERE to_number = $1 AND status IN ('sent', 'delivered', 'read') ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
      [digits]
    );
    if (a?.business_id) {
      const ok = await queryOne<{ id: string }>(`SELECT id::text AS id FROM businesses WHERE id::text = $1`, [a.business_id]);
      if (ok) return ok.id;
    }
  } catch { /* the automation table is not installed: fall through */ }
  try {
    const o = await queryOne<{ business_id: string }>(
      `SELECT o.business_id::text AS business_id FROM orders o
        WHERE o.business_id IS NOT NULL AND right(regexp_replace(o.customer_mobile, '\\D', '', 'g'), 10) = $1
        ORDER BY o.created_at DESC LIMIT 1`,
      [digits.slice(-10)]
    );
    if (o?.business_id) return o.business_id;
  } catch { /* no order lookup: fall through */ }
  return waPanelId(env);
}

export type InboundOutcome = 'stored' | 'duplicate' | 'no_panel';

// The customer's WhatsApp chat on the WhatsApp panel's site: the latest one for that number, else a new one
// (With team). Also used when the TEAM starts the conversation with a template (whatsapp-templates.ts).
export async function waConversationFor(digits: string, name: string | null, env: NodeJS.ProcessEnv = process.env): Promise<{ id: string; status: string; panel: string } | null> {
  const panel = await waPanelFor(digits, env);
  if (!panel) return null;
  const site = await ensureSiteForPanel(panel, 'whatsapp');
  const visitorId = `wa:${digits}`;
  const found = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM conversations
      WHERE site_id = $1 AND source = 'whatsapp' AND visitor_id = $2 AND merged_into IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [site.id, visitorId]
  );
  if (found) return { ...found, panel };
  const made = await queryOne<{ id: string; status: string }>(
    `INSERT INTO conversations
       (id, site_id, visitor_id, visitor_name, visitor_phone, status, source, unread_count, last_message_at, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'agent_handling', 'whatsapp', 0, now(), now(), now())
     RETURNING id, status`,
    [site.id, visitorId, name, '+' + digits]
  );
  return made ? { ...made, panel } : null;
}

// The automation's own messages (WhatsApp > Automation) are not chats until the customer answers: then the thread
// gets what was sent to that number by this brand, as quiet system lines dated when they went (never counted as
// waiting, unread, search, the AI or the team score: the 'system' sender is left out of all of them).
export async function backfillAutomation(conversationId: string, panelId: string, digits: string): Promise<void> {
  try {
    await query(
      `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
       SELECT gen_random_uuid()::text, $1, 'system', w.body_text,
              jsonb_build_object('system', true, 'step', 'wa_auto', 'automation', true, 'channel', 'whatsapp',
                                 'wa_template', w.template, 'wa_id', w.wa_id, 'wa_status', w.status, 'auto_id', w.id::text),
              w.sent_at
         FROM wa_auto_sends w
        WHERE w.business_id = $2 AND w.to_number = $3 AND w.status IN ('sent', 'delivered', 'read')
          AND w.body_text IS NOT NULL AND w.sent_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = $1 AND m.metadata->>'auto_id' = w.id::text)`,
      [conversationId, panelId, digits]
    );
  } catch (e) {
    if ((e as { code?: string })?.code !== '42P01') console.error('[whatsapp] automation backfill:', (e as Error).message);
  }
}

export async function storeWaInbound(m: WaInbound, env: NodeJS.ProcessEnv = process.env): Promise<{ outcome: InboundOutcome; conversationId: string | null }> {
  const dup = await queryOne<{ id: string }>(`SELECT id FROM messages WHERE metadata->>'wa_id' = $1 LIMIT 1`, [m.id]);
  if (dup) return { outcome: 'duplicate', conversationId: null };

  const conv = await waConversationFor(m.from, m.name, env);
  if (!conv) return { outcome: 'no_panel', conversationId: null };
  await backfillAutomation(conv.id, conv.panel, m.from);

  await query(
    `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
     VALUES (gen_random_uuid()::text, $1, 'visitor', $2, $3::jsonb, to_timestamp($4::double precision / 1000))`,
    [conv.id, m.text || '[Message]', JSON.stringify({ wa_id: m.id, wa_type: m.type, channel: 'whatsapp' }), m.timestamp]
  );
  // A Closed chat reopens for the team; an AI-handled one (never on WhatsApp today) goes to the team too;
  // Needs you and With team stay. The holder is untouched (chat-team rules: only the customer wrote).
  await query(
    `UPDATE conversations
        SET unread_count = unread_count + 1, last_message_at = now(), updated_at = now(),
            status = CASE WHEN status IN ('human_needed', 'agent_handling') THEN status ELSE 'agent_handling' END,
            visitor_name = COALESCE(NULLIF(visitor_name, ''), $2)
      WHERE id = $1`,
    [conv.id, m.name]
  );
  void updateConversationSubject(conv.id);
  void updateConversationHealth(conv.id);
  return { outcome: 'stored', conversationId: conv.id };
}

export async function storeWaStatus(s: WaStatus): Promise<boolean> {
  const r = await query(
    `UPDATE messages
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('wa_status', $2::text, 'wa_error', $3::text))
      WHERE metadata->>'wa_id' = $1`,
    [s.id, s.status, s.error]
  );
  // the automation's own messages (WhatsApp > Automation) have no chat message: their row takes the report (a Meta-side
  // failure puts the row back in line and stops the order messages until Resume, owner 2026-10-15 night)
  const auto = await noteAutoStatus(s.id, s.status, s.error);
  // ShipTrack's own alerts (chargeback, AI credit, risk, stuck promises): a rate-limited one waits and goes again
  // (whatsapp-alert-queue.ts); a Meta-side failure stops the order messages too
  const alert = auto ? false : await noteAlertStatus(s.id, s.status, s.error).catch(() => false);
  // the test message (WhatsApp > Automation "Send ... as a test"): its record and the log follow the report (owner
  // 2026-10-15 night: a test said "sent" and never arrived); a failed one on Meta's side stops the order messages too
  const test = auto || alert ? false : await noteTestStatus(s).catch(() => false);
  // a 130429 for a team chat message or for a message nobody of ours sent (another app on the number): the timed pause
  // as before (owner 2026-10-15); it never shortens a stop
  if (s.status === 'failed' && !auto && !alert && !test && isRateLimited(null, s.error)) await pauseWhatsApp(String(s.error)).catch(() => undefined);
  const ours = (r.rowCount ?? 0) > 0 || auto || alert || test;
  // A report that matched nothing of ours is a message ANOTHER app sent from the number (owner 2026-10-15: "we need
  // evidence"): counted after a short re-check, never awaited here (whatsapp-foreign.ts)
  if (!ours) void noteForeignStatus(s);
  return ours;
}
