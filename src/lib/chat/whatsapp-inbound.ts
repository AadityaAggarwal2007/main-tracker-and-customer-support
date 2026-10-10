// A WhatsApp message arriving at our business number becomes a Chat Support chat (whatsapp.ts has the
// why). One chat per customer number per site (`visitor_id = 'wa:<digits>'`, source 'whatsapp'), the
// customer's profile name as the visitor name until an order proves who they are, every message
// stored as the customer's (`sender 'visitor'`) with its wamid in `metadata.wa_id` (Meta resends a
// message it got no 200 for: a wamid already stored is skipped). The chat goes to the team
// (`agent_handling`, a Closed one reopens): Chikki does not answer on WhatsApp yet, so the inbox
// shows it under With team > Open case with an unread count, and a reply from the inbox goes back
// out on WhatsApp (the messages route). Delivery reports (sent / delivered / read / failed) land on
// our own message's metadata (`wa_status`, `wa_error`), shown in the message's details.

import { query, queryOne } from '@/lib/db';
import { ensureSiteForPanel } from './site';
import { updateConversationSubject } from './subject';
import { updateConversationHealth } from './health';
import type { WaInbound, WaStatus } from './whatsapp';
import { noteAutoStatus } from './whatsapp-auto-status';

// The panel WhatsApp chats belong to: WHATSAPP_PANEL_ID, else the default panel. One number, one panel,
// until the owner wants a number per panel.
export async function waPanelId(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const wanted = (env.WHATSAPP_PANEL_ID || '').trim();
  const row = wanted
    ? await queryOne<{ id: string }>(`SELECT id::text AS id FROM businesses WHERE id::text = $1`, [wanted])
    : await queryOne<{ id: string }>(`SELECT id::text AS id FROM businesses ORDER BY is_default DESC, created_at ASC LIMIT 1`);
  return row?.id ?? null;
}

export type InboundOutcome = 'stored' | 'duplicate' | 'no_panel';

// The customer's WhatsApp chat on the WhatsApp panel's site: the latest one for that number, else a new one
// (With team). Also used when the TEAM starts the conversation with a template (whatsapp-templates.ts).
export async function waConversationFor(digits: string, name: string | null, env: NodeJS.ProcessEnv = process.env): Promise<{ id: string; status: string } | null> {
  const panel = await waPanelId(env);
  if (!panel) return null;
  const site = await ensureSiteForPanel(panel, 'whatsapp');
  const visitorId = `wa:${digits}`;
  const found = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM conversations
      WHERE site_id = $1 AND source = 'whatsapp' AND visitor_id = $2 AND merged_into IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [site.id, visitorId]
  );
  if (found) return found;
  return queryOne<{ id: string; status: string }>(
    `INSERT INTO conversations
       (id, site_id, visitor_id, visitor_name, visitor_phone, status, source, unread_count, last_message_at, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'agent_handling', 'whatsapp', 0, now(), now(), now())
     RETURNING id, status`,
    [site.id, visitorId, name, '+' + digits]
  );
}

export async function storeWaInbound(m: WaInbound, env: NodeJS.ProcessEnv = process.env): Promise<{ outcome: InboundOutcome; conversationId: string | null }> {
  const dup = await queryOne<{ id: string }>(`SELECT id FROM messages WHERE metadata->>'wa_id' = $1 LIMIT 1`, [m.id]);
  if (dup) return { outcome: 'duplicate', conversationId: null };

  const conv = await waConversationFor(m.from, m.name, env);
  if (!conv) return { outcome: 'no_panel', conversationId: null };

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
  // the automation's own messages (WhatsApp > Automation) have no chat message: their row takes the report
  const auto = await noteAutoStatus(s.id, s.status, s.error);
  return (r.rowCount ?? 0) > 0 || auto;
}
