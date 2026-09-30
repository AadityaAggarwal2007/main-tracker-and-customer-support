import { NextRequest } from 'next/server';
import { queryOne } from '@/lib/db';
import { normalizePhone, verifyOrderByPhone } from '@/lib/chat/orders';
import { clientIp, getOrCreateVisitorConversation, siteByKey, widgetJson, widgetPreflight } from '@/lib/chat/widget-api';
import { LIMITS, isLimited, release, reserve } from '@/lib/chat/lookup-limits';
import { mergeVisitorChatInto } from '@/lib/chat/merge-chats';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

// The guessing limits (per visitor, IP, order and phone) live in
// src/lib/chat/lookup-limits.ts, shared with the chat's own order lookup.

// POST /api/widget/verify — the widget's "Verify yourself and continue a chat"
// form. Order ID (or ST… tracking ID) + the customer's full phone number. On a
// match the visitor's chat is marked as verified for that order, so the AI
// never asks them for the order ID or phone digits, and staff see the chat
// under Customers. Nothing about the order is returned except its ID and the
// customer's first name, and the phone number is never sent to the AI.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const siteKey = typeof body?.siteKey === 'string' ? body.siteKey.trim() : '';
    const visitorId = typeof body?.visitorId === 'string' ? body.visitorId.trim() : '';
    const orderId = typeof body?.orderId === 'string' ? body.orderId.trim() : '';
    const phone = typeof body?.phone === 'string' || typeof body?.phone === 'number' ? String(body.phone).trim() : '';
    if (!siteKey || !visitorId || !orderId || !phone) {
      return widgetJson({ error: 'siteKey, visitorId, orderId, phone required' }, 400);
    }

    const site = await siteByKey(siteKey);
    if (!site) return widgetJson({ error: 'Invalid site key' }, 404);

    const keys: [string, { max: number; windowMs: number }][] = [
      [`v:${siteKey}:${visitorId}`.slice(0, 300), LIMITS.visitor],
      [`ip:${clientIp(request)}`.slice(0, 100), LIMITS.ip],
      [`o:${siteKey}:${orderId.toLowerCase().replace(/[#\s]/g, '')}`.slice(0, 200), LIMITS.order],
      [`p:${siteKey}:${normalizePhone(phone) || ''}`.slice(0, 200), LIMITS.phone],
    ];
    if (keys.some(([key, l]) => isLimited(key, l.max))) {
      return widgetJson({ verified: false, error: 'too_many_attempts' }, 429);
    }
    for (const [key, l] of keys) reserve(key, l.windowMs);

    // The same answer whether the order ID exists or not, so the form cannot
    // be used to find out which order numbers are real. A site with no panel
    // linked has no orders of its own, so nothing verifies there.
    const order = orderId.length <= 64
      ? await verifyOrderByPhone(orderId, phone, site.tracker_business_id)
      : null;
    if (!order) return widgetJson({ verified: false, error: 'not_found' });
    for (const [key] of keys) release(key);

    // The real order holder's name, cleaned the way ai.ts does after a lookup.
    const realName = String(order.customer_name || '').replace(/\s*\.\s*$/, '').trim();
    // verifyOrderByPhone matched the order's phone on exactly these 10 digits,
    // so this is also the order's customer_key (chat-customer-key.sql).
    const customerKey = normalizePhone(phone);

    // One chat per customer: carry on this customer's latest chat on this site
    // instead of opening another one, from whichever browser they verify.
    // Widget routes trust a stored conversation id, not visitor_id, so every
    // device that ever held that chat keeps reading it. It is therefore only
    // carried on when the device that holds it proved exactly what this one
    // just proved: the SAME order with the full phone ('form', or 'chat_phone': the
    // same proof typed in the chat since 2026-09-30). Never a chat proved with
    // the last 4 only ('chat', older chats) or a legacy tag, and never a chat
    // verified for another order (that device never proved this one, and the
    // AI would start serving this order there). Otherwise this visitor gets
    // its own chat with the same customer_key, and the inbox shows them as
    // one thread (/api/chat/conversations). This device now owns the carried
    // chat (visitor_id), a Closed one opens again for the AI, and any other
    // open chat this visitor has is left as it is.
    let conversation = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM conversations
        WHERE site_id = $1
          AND source = 'chat'
          AND customer_key = $2
          AND verified_via IN ('form', 'chat_phone')
          AND verified_order_id = $3
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      [site.id, customerKey, order.order_id]
    );
    if (conversation) {
      conversation = await queryOne<{ id: string; status: string }>(
        `UPDATE conversations
            SET visitor_id = $1,
                status = CASE WHEN status = 'resolved' THEN 'ai_handling' ELSE status END,
                verified_order_id = $2,
                verified_at = now(),
                verified_via = 'form',
                visitor_name = COALESCE($3, visitor_name),
                visitor_phone = $4,
                customer_key = $4,
                updated_at = now()
          WHERE id = $5
          RETURNING id, status`,
        [visitorId, order.order_id, realName || null, customerKey, conversation.id]
      );
    }
    const carriedOn = !!conversation;
    if (!conversation) {
      // This device's own chat: the open one, else its most recent Closed one (the
      // auto-close shuts a visitor's chat after 4 quiet hours, and a customer who
      // then verifies must get THAT chat back, not a second one). A Closed chat is
      // only reused while nobody else was verified in it: on a shared device a
      // chat verified for another customer is never opened to this one.
      let own = await queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM conversations
          WHERE site_id = $1 AND visitor_id = $2 AND source = 'chat'
            AND (status <> 'resolved'
                 OR verified_order_id IS NULL
                 OR customer_key = $3 OR verified_order_id = $4)
          ORDER BY (status <> 'resolved') DESC, created_at DESC
          LIMIT 1`,
        [site.id, visitorId, customerKey, order.order_id]
      );
      if (!own) own = await getOrCreateVisitorConversation(site.id, visitorId);
      conversation = await queryOne<{ id: string; status: string }>(
        `UPDATE conversations
            SET status = CASE WHEN status = 'resolved' THEN 'ai_handling' ELSE status END,
                verified_order_id = $1,
                verified_at = now(),
                verified_via = 'form',
                visitor_name = COALESCE($2, visitor_name),
                visitor_phone = $3,
                customer_key = CASE WHEN source = 'chat' THEN $3 ELSE customer_key END,
                updated_at = now()
          WHERE id = $4
          RETURNING id, status`,
        [order.order_id, realName || null, customerKey, own.id]
      ) || own;
    }
    // The customer got their earlier chat back: what this browser had typed as a
    // visitor before verifying goes into it, so it is one chat with one history.
    if (carriedOn) await mergeVisitorChatInto(conversation.id, site.id, visitorId);
    console.log(`[widget] verified conv ${conversation.id} via form${carriedOn ? ' (carried on the customer\'s chat)' : ''}`);

    return widgetJson({
      verified: true,
      conversationId: conversation.id,
      status: conversation.status,
      siteName: site.name,
      orderId: order.order_id,
      firstName: realName ? realName.split(/\s+/)[0] : null,
    });
  } catch (err) {
    console.error('[widget] verify error:', err);
    return widgetJson({ error: 'Could not verify right now' }, 500);
  }
}
