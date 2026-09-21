import { NextRequest } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { getAIResponse } from '@/lib/chat/ai';
import { conversationForSite, siteByKey, widgetJson, widgetPreflight } from '@/lib/chat/widget-api';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

interface StoredMessage {
  id: string; conversation_id: string; sender: string; content: string;
  metadata: Record<string, unknown> | null; created_at: string;
}

// POST /api/widget/message — visitor sends a message, AI answers inline
export async function POST(request: NextRequest) {
  try {
    const { conversationId, siteKey, content } = await request.json();
    if (!conversationId || !siteKey || !content) {
      return widgetJson({ error: 'conversationId, siteKey, content required' }, 400);
    }

    const site = await siteByKey(siteKey);
    if (!site) return widgetJson({ error: 'Invalid site key' }, 404);

    const conversation = await conversationForSite(conversationId, site.id);
    if (!conversation) return widgetJson({ error: 'Forbidden' }, 403);

    // Save visitor message
    const visitorMessage = await queryOne<StoredMessage>(
      `INSERT INTO messages (id, conversation_id, sender, content, created_at)
       VALUES (gen_random_uuid()::text, $1, 'visitor', $2, now())
       RETURNING id, conversation_id, sender, content, metadata, created_at`,
      [conversationId, content]
    );

    await query(
      `UPDATE conversations
          SET unread_count = unread_count + 1, last_message_at = now(), updated_at = now()
        WHERE id = $1`,
      [conversationId]
    );

    // AI response if in ai_handling mode
    let aiMessage: StoredMessage | null = null;
    if (conversation.status === 'ai_handling' && site.ai_enabled) {
      try {
        const aiResult = await getAIResponse(conversationId, site.system_prompt, site.tracker_business_id, site.cod_available);

        // Store the tool exchange as hidden messages so the next turn still
        // knows which order was looked up.
        if (aiResult.toolCallMeta) {
          const { tool_calls, tool_call_id, tool_result } = aiResult.toolCallMeta;
          await query(
            `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
             VALUES (gen_random_uuid()::text, $1, 'ai', '', $2::jsonb, now())`,
            [conversationId, JSON.stringify({ tool_calls, hidden: true })]
          );
          await query(
            `INSERT INTO messages (id, conversation_id, sender, content, metadata, created_at)
             VALUES (gen_random_uuid()::text, $1, 'tool_result', $2, $3::jsonb, now())`,
            [conversationId, tool_result, JSON.stringify({ tool_call_id, hidden: true })]
          );
        }

        // Save the visible AI response
        aiMessage = await queryOne<StoredMessage>(
          `INSERT INTO messages (id, conversation_id, sender, content, created_at)
           VALUES (gen_random_uuid()::text, $1, 'ai', $2, now())
           RETURNING id, conversation_id, sender, content, metadata, created_at`,
          [conversationId, aiResult.content]
        );

        await query(
          `UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
          [conversationId]
        );
      } catch (aiErr) {
        // Never leave the visitor with a spinning typing indicator and no reply.
        console.error('[widget] AI error:', (aiErr as Error).message);
        try {
          aiMessage = await queryOne<StoredMessage>(
            `INSERT INTO messages (id, conversation_id, sender, content, created_at)
             VALUES (gen_random_uuid()::text, $1, 'ai', $2, now())
             RETURNING id, conversation_id, sender, content, metadata, created_at`,
            [conversationId, 'Sorry, that took longer than expected on my end. Could you send that again?']
          );
        } catch (saveErr) {
          console.error('[widget] fallback save failed:', (saveErr as Error).message);
        }
      }
    }

    return widgetJson({ message: visitorMessage, aiResponse: aiMessage }, 201);
  } catch (err) {
    console.error('[widget] message error:', err);
    return widgetJson({ error: 'Could not send that message' }, 500);
  }
}
